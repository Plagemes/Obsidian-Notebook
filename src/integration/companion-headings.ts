import { normalizePath, type App, type TFile } from "obsidian";
import { HeadingIndex, pageFingerprint } from "../model/heading-index";
import {
	COMPANION_HEADING_PIXELS, COMPANION_HEADING_WIDTH, headingPictureName, pickCompanionHeadings,
} from "../model/companion-headings";
import { choosePicturePath, NotebookLru, PICTURE_MARK, pictureCacheable, rewriteIfUnchanged, type PictureProbe } from "../model/companion-pictures";
import { markPictureBytes, pictureIntact, readPngText } from "../model/png-text";
import { embedWithWidth } from "../model/selection-task";
import type { NotebookDocument } from "../model/types";
import { tapesOf } from "../model/tape";
import { t } from "../i18n";
import { whenIdle } from "../storage/idle";
import { ensureFolder } from "../storage/vault-io";
import { siblingFolder } from "../view/export-markdown";
import { showNotice } from "../view/notice";
import { headingPngBytes } from "../view/outline-thumbs";
import { viewsOf } from "./open";
import { withEmbedMarker } from "./page-links";

/** Longest slice of heading analysis between two checks of the pen, ms. */
const ANALYSE_SLICE_MS = 8;

/** How many times a picture is planned again when its file changed between the check and the write. */
const MAX_PLAN_ATTEMPTS = 3;

/**
 * 0.20 (#102): the pictures of the handwritten headings of a notebook for its companion note. The headings come from the
 * per-page index (cached by the content of the page), each one is drawn on its own and saved in `<Notebook> (Headings)`
 * beside the notebook as `p3-h1.png`.
 *
 * Review fixes: the index is the open notebook's own (already warm) when it is open, otherwise one per notebook, a few kept;
 * stale pages are analysed in idle slices that look at the pen first. Every picture carries the ink it shows in a PNG text
 * chunk: a picture whose mark matches is left alone (no rewrite, so devices with other PNG encoders do not fight), one with
 * another mark is ours and is redrawn, and a file without a mark is the user's and is never written over (the picture takes the
 * next free name). Nothing is ever deleted here: a heading that disappears leaves its picture behind.
 */
export class CompanionHeadings {
	private readonly indexes = new NotebookLru<HeadingIndex>();
	/** Wanted path of a picture made or checked in this session -> where it is and the ink it shows. */
	private readonly made = new Map<string, { path: string; key: string }>();

	/** The "names ran out" notice was shown in this session. */
	private toldFull = false;

	constructor(private readonly app: App) {}

	/** The analysis to use for `file`: the open view's when there is one, else this service's own. */
	private indexFor(file: TFile): HeadingIndex {
		const open = viewsOf(this.app, file)[0];
		return open ? open.view.headingIndex() : this.indexes.get(file.path, () => new HeadingIndex());
	}

	/**
	 * The embeds of the headings of each page, to put in the note at `notePath`. Null when `abort()` says to stop (the pen is
	 * down again): nothing partial is returned, the caller tries again later.
	 */
	async embeds(file: TFile, notePath: string, doc: NotebookDocument, abort: () => boolean): Promise<Map<string, Array<string | null>> | null> {
		const index = this.indexFor(file);
		// Stale pages are analysed a few at a time; the pen is looked at before each slice.
		for (;;) {
			if (abort()) return null;
			if (index.warm(doc.pages, ANALYSE_SLICE_MS) === 0) break;
			await whenIdle(0, 2000);
		}
		const picks = pickCompanionHeadings(index.headings(doc.pages));
		const out = new Map<string, Array<string | null>>();
		if (picks.length === 0) return out;
		const folder = siblingFolder(file, "Headings");
		for (const pick of picks) {
			if (abort()) return null;
			// Between two pictures: let the app breathe.
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			const page = doc.pages[pick.index];
			if (!page || page.id !== pick.pageId) continue;
			const list = out.get(pick.pageId) ?? [];
			out.set(pick.pageId, list);
			list.push(await this.picture(file, notePath, folder, page, pick));
		}
		return out;
	}

	private async picture(file: TFile, notePath: string, folder: string, page: NotebookDocument["pages"][number], pick: ReturnType<typeof pickCompanionHeadings>[number]): Promise<string | null> {
		const { app } = this;
		try {
			const ids = new Set(pick.heading.strokeIds);
			const strokes = page.strokes.filter((s) => ids.has(s.id) && !s.hidden);
			if (strokes.length === 0) return null;
			const r = pick.heading.rect;
			// 0.29 (#10): the picture draws the study tapes over the heading too, so they are part of its key (nothing is added without one).
			const tapes = tapesOf(page).filter((tp) => tp.x < r.x + r.width && tp.x + tp.width > r.x && tp.y < r.y + r.height && tp.y + tp.height > r.y);
			const tapeKey = tapes.map((tp) => `|t${tp.x},${tp.y},${tp.width},${tp.height},${tp.color}`).join("");
			const key = `${pageFingerprint({ width: page.width, height: page.height, strokes })}|${r.x},${r.y},${r.width},${r.height}${tapeKey}`;
			const wanted = normalizePath(`${folder}/${headingPictureName(pick)}`);
			const known = this.made.get(wanted);
			let target = known && known.key === key ? app.vault.getFileByPath(known.path) : null;
			if (!target) {
				// Drawn only when something is to be written; the checksum of the written chunks goes in a second text chunk, so
				// a later run rewrites only a picture that still has them.
				let data: ArrayBuffer | null | undefined;
				const render = (): ArrayBuffer | null => {
					if (data !== undefined) return data;
					const bytes = headingPngBytes(page, strokes, r, COMPANION_HEADING_PIXELS);
					const marked = bytes ? markPictureBytes(bytes, PICTURE_MARK, key) : null;
					data = marked ? (marked.buffer.slice(marked.byteOffset, marked.byteOffset + marked.byteLength) as ArrayBuffer) : null;
					return data;
				};
				// A file that changed between the check and the write is the user's (or a sync's): the plan is made again, bounded.
				for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS && !target; attempt++) {
					const plan = await choosePicturePath(wanted, key, (path) => this.probe(path), known?.path ?? "");
					if (!plan) return null; // every name is taken by files that are not ours
					if (plan.action === "keep") {
						target = app.vault.getFileByPath(plan.path);
						break;
					}
					if (plan.action === "full") {
						// No free name left: the previous picture stays linked (it shows older ink) and the user is told once.
						this.tellFull();
						const previous = app.vault.getFileByPath(plan.path);
						// Not remembered under this ink (review W21 N6): the next run probes again, so a name the user frees is used.
						if (previous && pictureCacheable(plan)) this.made.set(wanted, { path: previous.path, key });
						return previous ? embedWithWidth(withEmbedMarker(app.fileManager.generateMarkdownLink(previous, notePath), true), COMPANION_HEADING_WIDTH) : null;
					}
					const bytes = render();
					if (!bytes) return null;
					if (plan.action === "rewrite") {
						const done = await rewriteIfUnchanged(app.vault, plan, bytes);
						if (done.changed) continue;
						target = done.file;
					} else {
						await ensureFolder(app, folder);
						target = await app.vault.createBinary(plan.path, bytes);
					}
				}
				if (!target) return null;
				this.made.set(wanted, { path: target.path, key });
			}
			return embedWithWidth(withEmbedMarker(app.fileManager.generateMarkdownLink(target, notePath), true), COMPANION_HEADING_WIDTH);
		} catch (e) {
			console.error(`[notebook] companion heading picture of ${file.path}`, e);
			return null;
		}
	}

	/** One notice per session when the names of a picture ran out (see `choosePicturePath`). */
	private tellFull(): void {
		if (this.toldFull) return;
		this.toldFull = true;
		showNotice(t("notice.companionPicturesFull"), 10000);
	}

	/** What is at `path`: nothing, or a file with the mark of the ink it shows (null when it has none: not ours) and its stamp. */
	private async probe(path: string): Promise<PictureProbe> {
		const found = this.app.vault.getFileByPath(path);
		if (!found) return { kind: "free" };
		// The stamp is taken before the read: a change during the read shows when the stamp is checked again before a write.
		const stamp = { mtime: found.stat.mtime, size: found.stat.size };
		const bytes = new Uint8Array(await this.app.vault.readBinary(found));
		return { kind: "file", mark: readPngText(bytes, PICTURE_MARK), intact: pictureIntact(bytes), stamp };
	}
}
