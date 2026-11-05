import { normalizePath, type App, type TFile } from "obsidian";
import { HeadingIndex, pageFingerprint } from "../model/heading-index";
import {
	COMPANION_HEADING_PIXELS, COMPANION_HEADING_WIDTH, headingPictureName, pickCompanionHeadings,
} from "../model/companion-headings";
import { embedWithWidth } from "../model/selection-task";
import type { NotebookDocument } from "../model/types";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { siblingFolder } from "../view/export-markdown";
import { headingPngBytes } from "../view/outline-thumbs";
import { withEmbedMarker } from "./page-links";

/**
 * 0.20 (#102): the pictures of the handwritten headings of a notebook for its companion note. The headings come from the
 * shared per-page index (cached by the content of the page), each one is drawn on its own and saved in `<Notebook> (Headings)`
 * beside the notebook as `p3-h1.png`. A picture is rewritten only when its bytes differ, and one already made in this session
 * for the same ink is not drawn again. Nothing is ever deleted here: a heading that disappears leaves its picture behind
 * (named by position, so the next heading takes the file over).
 */
export class CompanionHeadings {
	private readonly index = new HeadingIndex();
	/** Path of a picture made in this session -> the ink it shows (page content and box). */
	private readonly made = new Map<string, string>();

	constructor(private readonly app: App) {}

	/**
	 * The embeds of the headings of each page, to put in the note at `notePath`. Null when `abort()` says to stop (the pen is
	 * down again): nothing partial is returned, the caller tries again later.
	 */
	async embeds(file: TFile, notePath: string, doc: NotebookDocument, abort: () => boolean): Promise<Map<string, Array<string | null>> | null> {
		const picks = pickCompanionHeadings(this.index.headings(doc.pages));
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
			const key = `${pageFingerprint({ width: page.width, height: page.height, strokes })}|${r.x},${r.y},${r.width},${r.height}`;
			const path = normalizePath(`${folder}/${headingPictureName(pick)}`);
			let target = app.vault.getFileByPath(path);
			if (!target || this.made.get(path) !== key) {
				const bytes = headingPngBytes(page, strokes, r, COMPANION_HEADING_PIXELS);
				if (!bytes) return null;
				const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				if (target) {
					if (!sameBytes(new Uint8Array(await app.vault.readBinary(target)), bytes)) {
						recordPluginWrite(app, [path]);
						await app.vault.modifyBinary(target, data);
					}
				} else {
					recordPluginWrite(app, [path]); // before the write: the shared-files inbox must not offer this picture
					await ensureFolder(app, folder);
					target = await app.vault.createBinary(path, data);
				}
				this.made.set(path, key);
			}
			return embedWithWidth(withEmbedMarker(app.fileManager.generateMarkdownLink(target, notePath), true), COMPANION_HEADING_WIDTH);
		} catch (e) {
			console.error(`[notebook] companion heading picture of ${file.path}`, e);
			return null;
		}
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
