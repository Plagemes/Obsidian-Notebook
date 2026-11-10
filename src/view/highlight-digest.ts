// 0.16 (#90) Highlights digest: the vault side. Finds the highlighted regions (model/highlight-digest.ts), draws a picture of
// each through the shared page renderer (so ink, the PDF page, pictures and the state a page is shown in all appear), reads
// the PDF text under it, and writes the note "<Notebook> — Highlights" next to the notebook. An existing note is updated
// through vault.process and only the part between the digest markers changes; pictures an earlier run made are written again
// under the same names, new ones go where Obsidian puts attachments (fileManager.getAvailablePathForAttachment).
import { Modal, Setting, TFile, normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { withEmbedMarker, stablePageSubpath } from "../integration/page-links";
import {
	alternativeDigestName, buildDigestSection, canRewritePicture, cropRect, digestImageName, digestSectionOf, highlightRegions, newDigestNote, replaceDigestSection, sectionImageLinks, stableDigestPictureName, wouldAppendToUserNote,
	type ColourFamily, type DigestItem, type HighlightRegion,
} from "../model/highlight-digest";
import { MARKDOWN_DPI, DEFAULT_MARKDOWN_DPI, isMarkdownDpi, type MarkdownDpi } from "../model/export-markdown";
import { backgroundRect } from "../model/margins";
import { viewOf } from "../model/pdf-view";
import type { Page } from "../model/types";
import { textUnderBands } from "../pdf/region-text";
import { redactionOf } from "../ink/redact";
import { boxesOnPage, type PageTextContent, type TextBox, type TextMeasure } from "../pdf/text-items";
import { backlinksOf } from "../storage/backlinks";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { sameBytes, type NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";

/** The name of the digest note, without the folder. */
export function digestNoteName(notebook: TFile): string {
	return `${sanitizeName(notebook.basename) || "Notebook"} — Highlights.md`;
}

/** Vault path of the digest note of `notebook`: next to it. */
export function digestNotePath(notebook: TFile): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${digestNoteName(notebook)}`);
}

export interface DigestRequest {
	group: "page" | "colour";
	dpi: MarkdownDpi;
}

export interface DigestHost {
	app: App;
	file: TFile;
	/** The pages as the view shows them (the live views of pages with states). */
	pages: readonly Page[];
	media: NotebookMedia | null;
	/** What the page renderer needs (hidden ink, box labels, header, equation numbers). */
	render: PageImageOptions;
	/** Typesets what the pages need before they are drawn (equations). */
	prepare?: (pages: readonly Page[]) => Promise<void>;
}

/** How many highlights and pages the digest would list now. */
export function digestCounts(pages: readonly Page[]): { regions: number; pages: number } {
	const regions = highlightRegions(pages);
	return { regions: regions.length, pages: new Set(regions.map((r) => r.pageIndex)).size };
}

/** Width of a text in a font, measured on a canvas: how wide the characters of a run are relative to each other. */
function makeMeasure(): TextMeasure {
	let ctx: CanvasRenderingContext2D | null | undefined;
	let current = "";
	return (text, font) => {
		if (ctx === undefined) ctx = createEl("canvas").getContext("2d");
		if (!ctx) return 0;
		const css = `100px ${font ? `${font}, ` : ""}sans-serif`;
		if (css !== current) {
			ctx.font = css;
			current = css;
		}
		return ctx.measureText(text).width;
	};
}

/**
 * Writes the digest; returns the path of the note or null (nothing to write, an unsafe note, a failure: the reason is shown).
 * Pages are drawn one at a time, so memory stays at one page.
 */
export async function runHighlightsDigest(host: DigestHost, request: DigestRequest): Promise<string | null> {
	const { app, file, pages } = host;
	const regions = highlightRegions(pages);
	let notePath = digestNotePath(file);
	let existing = app.vault.getAbstractFileByPath(notePath);
	if (existing && !(existing instanceof TFile)) {
		showNotice(t("digest.failed", { error: notePath }), 10000);
		return null;
	}
	if (regions.length === 0 && !existing) {
		showNotice(t("digest.none"), 6000);
		return null;
	}
	let before = "";
	if (existing instanceof TFile) {
		try {
			before = await app.vault.read(existing);
		} catch (e) {
			showNotice(t("digest.failed", { error: (e as Error).message }), 10000);
			return null;
		}
		if (replaceDigestSection(before, "x").outcome === "unsafe") {
			showNotice(t("digest.unsafe", { path: notePath }), 12000);
			return null;
		}
		// A note of the user's with this name and no digest markers: the section would be added to it with no backup. Ask first.
		if (wouldAppendToUserNote(before)) {
			// "Use a new note" is remembered: a "<Notebook> — Highlights N" an earlier run made is updated, never asked about again.
			const own = await findOwnDigestCopy(app, notePath);
			if (own) {
				notePath = own.file.path;
				existing = own.file;
				before = own.text;
			} else {
				const choice = await askAppendToNote(app, existing.name);
				if (choice === null) return null;
				if (choice === "new") {
					const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/") + 1) : "";
					const alt = alternativeDigestName(digestNoteName(file), (n) => app.vault.getAbstractFileByPath(normalizePath(`${dir}${n}`)) !== null);
					notePath = normalizePath(`${dir}${alt}`);
					existing = null;
					before = "";
				}
			}
		}
	}
	if (regions.length === 0 && !existing) {
		showNotice(t("digest.none"), 6000);
		return null;
	}
	const working = showNotice(t("digest.working", { done: "0", total: String(regions.length) }), 0);
	const renderer = new PageImageRenderer(host.media, host.render);
	try {
		const known = sectionImageLinks(digestSectionOf(before));
		const stem = sanitizeName(file.basename) || "Notebook";
		const byPage = new Map<number, HighlightRegion[]>();
		for (const r of regions) {
			const list = byPage.get(r.pageIndex);
			if (list) list.push(r);
			else byPage.set(r.pageIndex, [r]);
		}
		await host.prepare?.([...byPage.keys()].map((i) => pages[i]!));
		const texts = new Map<string, Promise<PageTextContent | null>>();
		const measure = makeMeasure();
		const items: DigestItem[] = [];
		let done = 0;
		let skipped = 0;
		for (const [pageIndex, list] of byPage) {
			const page = pages[pageIndex]!;
			const crops = list.map((r) => cropRect(r, page));
			const drawn = await renderer.renderRegions(page, request.dpi, crops);
			skipped += drawn.skipped;
			let boxes: TextBox[] | null = null;
			const bg = page.background;
			if (bg?.kind === "pdf" && host.media) {
				const key = `${bg.asset}#${bg.page}`;
				let content = texts.get(key);
				if (!content) {
					content = host.media.pdf.pageText(bg.asset, bg.page).catch((e: unknown) => {
						console.error("[notebook] digest: PDF text", key, e);
						return null;
					});
					texts.set(key, content);
				}
				const c = await content;
				boxes = c ? boxesOnPage(c, backgroundRect(page), viewOf(page.background)).filter((b) => b.str.length > 0) : null;
			}
			for (let k = 0; k < list.length; k++) {
				const region = list[k]!;
				const blob = drawn.blobs[k] ?? null;
				const image = blob ? await storePicture(app, notePath, digestImageName(stem, pageIndex + 1, k + 1), blob, known) : null;
				if (blob && !image) skipped++;
				// 0.26 review fix (P5): no PDF word a redaction box touches is quoted (the page is the redacted copy, which carries its boxes).
				items.push({ region, pageNumber: pageIndex + 1, image, text: boxes ? textUnderBands(boxes, region.bands, measure, redactionOf(page)) : "" });
				done++;
				working.setMessage(t("digest.working", { done: String(done), total: String(regions.length) }));
			}
		}
		const section = buildDigestSection({
			items, group: request.group,
			pageLink: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("digest.page", { n: String(n) })),
			pageHeading: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("digest.page", { n: String(n) })),
			colourName: (f: ColourFamily) => t(`digest.colour.${f}`),
			intro: t("digest.intro", {
				link: app.fileManager.generateMarkdownLink(file, notePath, undefined, file.basename), n: String(items.length), pages: String(byPage.size),
			}),
			none: t("digest.empty"),
		});
		if (existing instanceof TFile) {
			let unsafe = false;
			await app.vault.process(existing, (current) => {
				const r = replaceDigestSection(current, section);
				if (r.outcome === "unsafe") {
					unsafe = true;
					return current;
				}
				return r.text;
			});
			if (unsafe) {
				showNotice(t("digest.unsafe", { path: notePath }), 12000);
				return null;
			}
		} else {
			await app.vault.create(notePath, newDigestNote(file.basename + " — Highlights", section));
		}
		showNotice(t("digest.done", { path: notePath, n: String(items.length) }), 8000);
		if (skipped > 0) showNotice(t("digest.skipped", { n: String(skipped) }), 8000);
		return notePath;
	} catch (e) {
		console.error("[notebook] highlights digest", e);
		showNotice(t("digest.failed", { error: (e as Error).message }), 10000);
		return null;
	} finally {
		renderer.close();
		working.hide();
	}
}

/**
 * Saves one picture and returns the Markdown embed of it. A picture an earlier digest embedded (`known`: its name -> the link as
 * written in the old section) is written again in place only when the link, resolved from the digest note, is the file with this
 * picture's name in the folder where Obsidian keeps attachments of the note and no other note links to it; and not at all when
 * the bytes are the same (no sync churn). Any other picture goes to a new file under a name nobody uses, so another notebook's
 * or note's picture is never overwritten.
 */
export async function storePicture(app: App, notePath: string, name: string, blob: Blob, known: ReadonlyMap<string, string>): Promise<string | null> {
	try {
		const data = await blob.arrayBuffer();
		const wanted = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, notePath));
		let target: TFile | null = null;
		let link = known.get(name.toLowerCase());
		if (link === undefined) {
			// An earlier run may have written a suffixed copy ("X 1.png") because the plain name was held: find it by the stable name.
			const stable = stableDigestPictureName(name);
			for (const [key, value] of known) {
				if (stableDigestPictureName(key) === stable) {
					link = value;
					break;
				}
			}
		}
		if (link !== undefined) {
			const found = app.metadataCache.getFirstLinkpathDest(link, notePath);
			if (
				found instanceof TFile && found.extension === "png" &&
				canRewritePicture({
					foundPath: found.path, name, expectedDir: wanted.includes("/") ? wanted.slice(0, wanted.lastIndexOf("/")) : "", notePath,
					linkedFrom: backlinksOf(app, found.path),
				})
			) target = found;
		}
		if (target) {
			recordPluginWrite(app, [target.path]);
			if (!(await sameBytes(app, target, data))) await app.vault.modifyBinary(target, data);
		} else {
			recordPluginWrite(app, [wanted]); // before the write: the inbox must not offer this picture
			const slash = wanted.lastIndexOf("/");
			if (slash > 0) await ensureFolder(app, wanted.slice(0, slash));
			target = await app.vault.createBinary(wanted, data);
		}
		return withEmbedMarker(app.fileManager.generateMarkdownLink(target, notePath), true);
	} catch (e) {
		console.error("[notebook] digest picture", e);
		return null;
	}
}

/** How far past "Highlights 2" the search for a digest note of an earlier "Use a new note" goes. */
const MAX_OWN_COPIES = 50;

/**
 * An earlier "Use a new note" answer: the note `<Notebook> — Highlights N.md` (N = 2, 3...) next to `notePath` that already holds
 * the digest section (both markers, in order). The first such note wins; a copy with an unpaired marker or no section is not ours.
 */
export async function findOwnDigestCopy(app: App, notePath: string): Promise<{ file: TFile; text: string } | null> {
	const slash = notePath.lastIndexOf("/");
	const dir = slash < 0 ? "" : notePath.slice(0, slash + 1);
	const stem = notePath.slice(slash + 1).replace(/\.md$/iu, "");
	for (let n = 2; n < 2 + MAX_OWN_COPIES; n++) {
		const f = app.vault.getAbstractFileByPath(normalizePath(`${dir}${stem} ${n}.md`));
		if (!(f instanceof TFile)) continue;
		try {
			const text = await app.vault.read(f);
			if (digestSectionOf(text) !== "" && replaceDigestSection(text, "x").outcome === "replaced") return { file: f, text };
		} catch {
			/* unreadable: not ours to use */
		}
	}
	return null;
}

/** The three answers to "a note with this name already exists and has no digest section". */
type AppendChoice = "append" | "new";

class AppendToNoteModal extends Modal {
	private settled = false;

	constructor(app: App, private readonly noteName: string, private readonly done: (choice: AppendChoice | null) => void) {
		super(app);
	}

	private settle(choice: AppendChoice | null, close = true): void {
		if (this.settled) return;
		this.settled = true;
		this.done(choice);
		if (close) this.close();
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("digest.append.title"), icon: "file-plus", size: "narrow", cls: "notebook-digest-modal" });
		shellNote(shell.body, t("digest.append.body", { note: this.noteName }));
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.settle(null));
		shellButton(shell.foot, "secondary", t("digest.append.new"), () => this.settle("new"));
		shellButton(shell.foot, "primary", t("digest.append.add"), () => this.settle("append"));
	}

	onClose(): void {
		this.settle(null, false);
		this.contentEl.empty();
	}
}

function askAppendToNote(app: App, noteName: string): Promise<AppendChoice | null> {
	return new Promise((resolve) => new AppendToNoteModal(app, noteName, resolve).open());
}

export interface DigestDialogHost {
	app: App;
	file: TFile;
	pages: readonly Page[];
	group: "page" | "colour";
	run(request: DigestRequest): void;
}

let lastDpi: MarkdownDpi = DEFAULT_MARKDOWN_DPI;

/** The dialog: how to group, how sharp the pictures are, and what will be written where. */
export class HighlightsDigestModal extends Modal {
	private grouping: "page" | "colour";
	private quality: MarkdownDpi = lastDpi;

	constructor(private readonly host: DigestDialogHost) {
		super(host.app);
		this.grouping = host.group;
	}

	onOpen(): void {
		const counts = digestCounts(this.host.pages);
		const exists = this.host.app.vault.getAbstractFileByPath(digestNotePath(this.host.file)) instanceof TFile;
		const shell = modalShell(this, { title: t("digest.dialog.title"), icon: "highlighter", size: "medium", cls: "notebook-digest-modal" });
		shellNote(shell.body, t("digest.dialog.desc", { n: String(counts.regions), pages: String(counts.pages), note: digestNoteName(this.host.file) })).addClass("notebook-digest-note");
		new Setting(shell.body).setName(t("digest.dialog.group")).addDropdown((dd) => {
			dd.addOption("page", t("settings.digestGroup.page")).addOption("colour", t("settings.digestGroup.colour"));
			dd.setValue(this.grouping).onChange((v) => {
				if (v === "page" || v === "colour") this.grouping = v;
			});
		});
		new Setting(shell.body).setName(t("digest.dialog.resolution")).addDropdown((dd) => {
			for (const dpi of MARKDOWN_DPI) dd.addOption(String(dpi), t("export.markdown.dpi", { dpi: String(dpi) }));
			dd.setValue(String(this.quality)).onChange((v) => {
				const n = Number(v);
				if (isMarkdownDpi(n)) this.quality = n;
			});
		});
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", exists ? t("digest.dialog.update") : t("digest.dialog.make"), () => {
			lastDpi = this.quality;
			this.close();
			this.host.run({ group: this.grouping, dpi: this.quality });
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
