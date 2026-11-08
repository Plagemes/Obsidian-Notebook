// 0.22 (#101) Digest by colour: the vault side. Collects the ink of each meaning of the legend (model/colour-meaning.ts) in the
// note "<Notebook> — Colours.md" next to the notebook, one section per meaning, a picture of each place (drawn through the
// shared page renderer, like the highlights digest) and the PDF text under it. Only the part between the markers is rewritten
// (vault.process); a note of the user's that has no markers is added to only after a confirmation.
import { Modal, Setting, TFile, normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { stablePageSubpath } from "../integration/page-links";
import { MARKDOWN_DPI, DEFAULT_MARKDOWN_DPI, isMarkdownDpi, type MarkdownDpi } from "../model/export-markdown";
import { cropRect } from "../model/highlight-digest";
import { escapeSearchText } from "../model/companion-search";
import {
	buildMeaningSection, meaningImageName, meaningRegions, replaceMeaningSection, replaceMeaningSectionChecked, MEANING_START, MEANING_END,
	type Meaning, type MeaningItem, type MeaningRegion,
} from "../model/colour-meaning";
import { backgroundRect } from "../model/margins";
import type { Page } from "../model/types";
import { textUnderBands } from "../pdf/region-text";
import { redactionOf } from "../ink/redact";
import { boxesOnPage, type PageTextContent, type TextBox, type TextMeasure } from "../pdf/text-items";
import { recordPluginWrite } from "../storage/plugin-written";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { sectionImageLinks } from "../model/highlight-digest";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";
import { storePicture } from "./highlight-digest";

/** The name of the digest note, without the folder. */
export function meaningNoteName(notebook: TFile): string {
	return `${sanitizeName(notebook.basename) || "Notebook"} — Colours.md`;
}

/** Vault path of the digest note of `notebook`: next to it. */
export function meaningNotePath(notebook: TFile): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${meaningNoteName(notebook)}`);
}

export interface MeaningDigestHost {
	app: App;
	file: TFile;
	/** The pages as the view shows them (the live views of pages with states). */
	pages: readonly Page[];
	legend: readonly Meaning[];
	tolerance: number;
	media: NotebookMedia | null;
	render: PageImageOptions;
	prepare?: (pages: readonly Page[]) => Promise<void>;
}

export interface MeaningDigestRequest {
	dpi: MarkdownDpi;
}

/** How many places and pages the digest would list now. */
export function meaningDigestCounts(pages: readonly Page[], legend: readonly Meaning[], tolerance: number): { regions: number; pages: number } {
	const regions = meaningRegions(pages, legend, tolerance);
	return { regions: regions.length, pages: new Set(regions.map((r) => r.pageIndex)).size };
}

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

/** Writes the digest; returns the path of the note or null (nothing to write, an unsafe note, a failure: the reason is shown). */
export async function runMeaningDigest(host: MeaningDigestHost, request: MeaningDigestRequest): Promise<string | null> {
	const { app, file, pages } = host;
	const regions = meaningRegions(pages, host.legend, host.tolerance);
	const notePath = meaningNotePath(file);
	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing && !(existing instanceof TFile)) {
		showNotice(t("meaning.digest.failed", { error: notePath }), 10000);
		return null;
	}
	if (regions.length === 0 && !existing) {
		showNotice(t("meaning.digest.none"), 6000);
		return null;
	}
	let before = "";
	// Review fix (D8): the answer to "add the section to this note?" counts only for what was asked; the write checks again.
	let appendConfirmed = false;
	if (existing instanceof TFile) {
		try {
			before = await app.vault.read(existing);
		} catch (e) {
			showNotice(t("meaning.digest.failed", { error: (e as Error).message }), 10000);
			return null;
		}
		const verdict = replaceMeaningSection(before, "x").outcome;
		if (verdict === "unsafe") {
			showNotice(t("meaning.digest.unsafe", { path: notePath }), 12000);
			return null;
		}
		// A note of the user's with this name and no markers: the section would be added to it with no backup. Ask first.
		if (verdict === "appended") {
			if (!(await askAppend(app, existing.name))) return null;
			appendConfirmed = true;
		}
	}
	const working = showNotice(t("meaning.digest.working", { done: "0", total: String(regions.length) }), 0);
	const renderer = new PageImageRenderer(host.media, host.render);
	try {
		const known = sectionImageLinks(sectionOf(before));
		const stem = sanitizeName(file.basename) || "Notebook";
		const byPage = new Map<number, MeaningRegion[]>();
		for (const r of regions) {
			const list = byPage.get(r.pageIndex);
			if (list) list.push(r);
			else byPage.set(r.pageIndex, [r]);
		}
		await host.prepare?.([...byPage.keys()].map((i) => pages[i]!));
		const texts = new Map<string, Promise<PageTextContent | null>>();
		const measure = makeMeasure();
		const items: MeaningItem[] = [];
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
						console.error("[notebook] meaning digest: PDF text", key, e);
						return null;
					});
					texts.set(key, content);
				}
				const c = await content;
				boxes = c ? boxesOnPage(c, backgroundRect(page)).filter((b) => b.str.length > 0) : null;
			}
			for (let k = 0; k < list.length; k++) {
				const region = list[k]!;
				const blob = drawn.blobs[k] ?? null;
				const image = blob ? await storePicture(app, notePath, meaningImageName(stem, pageIndex + 1, k + 1), blob, known) : null;
				if (blob && !image) skipped++;
				// 0.26 review fix (P6): no PDF word a redaction box touches is quoted (the page is the redacted copy, which carries its boxes).
			const raw = boxes ? textUnderBands(boxes, region.bands, measure, redactionOf(page)) : "";
				items.push({ region, pageNumber: pageIndex + 1, image, text: raw ? escapeSearchText(raw) : "" });
				done++;
				working.setMessage(t("meaning.digest.working", { done: String(done), total: String(regions.length) }));
			}
		}
		const section = buildMeaningSection({
			legend: host.legend, items,
			pageLink: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("meaning.digest.page", { n: String(n) })),
			intro: t("meaning.digest.intro", { link: app.fileManager.generateMarkdownLink(file, notePath, undefined, file.basename), n: String(items.length), pages: String(byPage.size) }),
			none: t("meaning.digest.empty"),
			emptyMeaning: t("meaning.digest.emptyMeaning"),
			escape: escapeSearchText,
		});
		recordPluginWrite(app, [notePath]);
		if (existing instanceof TFile) {
			// The note is read again inside the write: if its markers vanished meanwhile, the section is not appended without asking.
			for (let attempt = 0; attempt < 2; attempt++) {
				let outcome = "";
				await app.vault.process(existing, (current) => {
					const r = replaceMeaningSectionChecked(current, section, appendConfirmed);
					outcome = r.outcome;
					return r.outcome === "unsafe" || r.outcome === "ask" ? current : r.text;
				});
				if (outcome === "unsafe") {
					showNotice(t("meaning.digest.unsafe", { path: notePath }), 12000);
					return null;
				}
				if (outcome !== "ask") break;
				if (!(await askAppend(app, existing.name))) return null;
				appendConfirmed = true;
			}
		} else {
			await app.vault.create(notePath, `# ${file.basename} — ${t("meaning.digest.title")}\n\n${section}\n`);
		}
		showNotice(t("meaning.digest.done", { path: notePath, n: String(items.length) }), 8000);
		if (skipped > 0) showNotice(t("digest.skipped", { n: String(skipped) }), 8000);
		return notePath;
	} catch (e) {
		console.error("[notebook] digest by colour", e);
		showNotice(t("meaning.digest.failed", { error: (e as Error).message }), 10000);
		return null;
	} finally {
		renderer.close();
		working.hide();
	}
}

/** The part of a note between the markers (markers included), or "" when it has none. */
function sectionOf(text: string): string {
	const start = text.indexOf(MEANING_START);
	if (start < 0) return "";
	const end = text.indexOf(MEANING_END, start + MEANING_START.length);
	return end < 0 ? "" : text.slice(start, end + MEANING_END.length);
}

class AppendModal extends Modal {
	private settled = false;

	constructor(app: App, private readonly noteName: string, private readonly done: (yes: boolean) => void) {
		super(app);
	}

	private settle(yes: boolean, close = true): void {
		if (this.settled) return;
		this.settled = true;
		this.done(yes);
		if (close) this.close();
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("meaning.digest.append.title"), icon: "file-plus", size: "narrow", cls: "nb-meaning-append" });
		shellNote(shell.body, t("meaning.digest.append.body", { note: this.noteName }));
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.settle(false));
		shellButton(shell.foot, "primary", t("digest.append.add"), () => this.settle(true));
	}

	onClose(): void {
		this.settle(false, false);
		this.contentEl.empty();
	}
}

function askAppend(app: App, noteName: string): Promise<boolean> {
	return new Promise((resolve) => new AppendModal(app, noteName, resolve).open());
}

export interface MeaningDigestDialogHost {
	app: App;
	file: TFile;
	pages: readonly Page[];
	legend: readonly Meaning[];
	tolerance: number;
	run(request: MeaningDigestRequest): void;
}

let lastDpi: MarkdownDpi = DEFAULT_MARKDOWN_DPI;

/** The dialog: picture quality, and what will be written where. */
export class MeaningDigestModal extends Modal {
	private quality: MarkdownDpi = lastDpi;

	constructor(private readonly host: MeaningDigestDialogHost) {
		super(host.app);
	}

	onOpen(): void {
		const counts = meaningDigestCounts(this.host.pages, this.host.legend, this.host.tolerance);
		const exists = this.host.app.vault.getAbstractFileByPath(meaningNotePath(this.host.file)) instanceof TFile;
		const shell = modalShell(this, { title: t("meaning.digest.title"), icon: "tags", size: "medium", cls: "nb-meaning-digest" });
		shellNote(shell.body, t("meaning.digest.desc", { n: String(counts.regions), pages: String(counts.pages), note: meaningNoteName(this.host.file) })).addClass("nb-meaning-digest-note");
		new Setting(shell.body).setName(t("digest.dialog.resolution")).addDropdown((dd) => {
			for (const dpi of MARKDOWN_DPI) dd.addOption(String(dpi), t("export.markdown.dpi", { dpi: String(dpi) }));
			dd.setValue(String(this.quality)).onChange((v) => {
				const n = Number(v);
				if (isMarkdownDpi(n)) this.quality = n;
			});
		});
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", exists ? t("meaning.digest.update") : t("meaning.digest.make"), () => {
			lastDpi = this.quality;
			this.close();
			this.host.run({ dpi: this.quality });
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
