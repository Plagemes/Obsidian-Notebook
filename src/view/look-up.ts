// 0.19 (#213) "Look up later": a circled word goes to a list. The selected region is drawn through the shared page renderer, saved
// as a picture where Obsidian puts attachments (remembered as written by the plugin) and one line
// `- [ ] ![[crop|150]] word — [[Notebook#p3&id=…|Notebook p. 3]] (date)` is appended to a Markdown note (made when missing) with
// vault.process; no other line of the note is ever rewritten. The sheet lists the entries of the open notebook, read from the note.
import { Modal, TFile, normalizePath, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { stablePageSubpath, pageTargetFromSubpath, resolvePageTarget, withEmbedMarker } from "../integration/page-links";
import {
	appendLookUpLine, buildLookUpLine, clampLookUpWidth, lookUpDate, lookUpNotePath, lookUpPictureName, openCount, parseLookUpNote, type LookUpEntry,
} from "../model/look-up";
import { DEFAULT_MARKDOWN_DPI } from "../model/export-markdown";
import { embedWithWidth, isSubmitKey, taskStamp, type TaskRect } from "../model/selection-task";
import type { Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";

export interface LookUpHost {
	app: App;
	file: TFile;
	settings: NotebookSettings;
	/** The page as the view shows it (the live view of a page with states). */
	page: Page;
	pageNumber: number;
	/** The region to draw, in page points. */
	crop: TaskRect;
	media: NotebookMedia | null;
	render: PageImageOptions;
	prepare?: (pages: readonly Page[]) => Promise<void>;
}

/** The note the entries go to, as a vault path. */
export function lookUpNoteOf(settings: NotebookSettings): string {
	return normalizePath(lookUpNotePath(settings.lookUpNote, settings.folder));
}

/** Draws the region once; null when it cannot be drawn. */
async function drawCrop(host: LookUpHost): Promise<Blob | null> {
	const renderer = new PageImageRenderer(host.media, host.render);
	try {
		await host.prepare?.([host.page]);
		const drawn = await renderer.renderRegions(host.page, DEFAULT_MARKDOWN_DPI, [host.crop]);
		return drawn.blobs[0] ?? null;
	} catch (e) {
		console.error("[notebook] look up crop", e);
		return null;
	} finally {
		renderer.close();
	}
}

/** Saves the crop where Obsidian keeps attachments of the note and returns its embed with a display width; null when it fails. */
async function storeCrop(app: App, notePath: string, name: string, blob: Blob, width: number): Promise<{ embed: string; file: TFile } | null> {
	try {
		const data = await blob.arrayBuffer();
		const path = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, notePath));
		recordPluginWrite(app, [path]); // before the write: the inbox must not offer this picture
		const slash = path.lastIndexOf("/");
		if (slash > 0) await ensureFolder(app, path.slice(0, slash));
		const target = await app.vault.createBinary(path, data);
		return { embed: embedWithWidth(withEmbedMarker(app.fileManager.generateMarkdownLink(target, notePath), true), width), file: target };
	} catch (e) {
		console.error("[notebook] look up picture", e);
		return null;
	}
}

/** The list note: the existing file, or a new empty one (made only here, on the first entry). Throws when the path is taken by a folder. */
async function ensureListNote(app: App, path: string): Promise<TFile> {
	const existing = app.vault.getFileByPath(path);
	if (existing) return existing;
	if (app.vault.getAbstractFileByPath(path)) throw new Error(path);
	recordPluginWrite(app, [path]);
	const slash = path.lastIndexOf("/");
	if (slash > 0) await ensureFolder(app, path.slice(0, slash));
	return app.vault.create(path, "");
}

async function discard(app: App, file: TFile | null): Promise<void> {
	if (!file) return;
	try {
		await app.fileManager.trashFile(file);
	} catch (e) {
		console.error("[notebook] look up picture could not be removed", e);
	}
}

/** Adds the entry; returns the note path or null (nothing written, the reason is shown). Never throws. */
export async function runLookUp(host: LookUpHost, word: string, now: Date = new Date()): Promise<string | null> {
	const { app, file } = host;
	let stored: TFile | null = null;
	try {
		const blob = await drawCrop(host);
		if (!blob) showNotice(t("lookup.noPicture"), 6000);
		const note = await ensureListNote(app, lookUpNoteOf(host.settings));
		const crop = blob ? await storeCrop(app, note.path, lookUpPictureName(sanitizeName(file.basename) || "Notebook", host.pageNumber, taskStamp(now)), blob, clampLookUpWidth(host.settings.lookUpWidth)) : null;
		stored = crop?.file ?? null;
		const pageLink = app.fileManager.generateMarkdownLink(file, note.path, stablePageSubpath(host.pageNumber, host.page.id), t("lookup.pageAlias", { notebook: file.basename, n: String(host.pageNumber) }));
		const line = buildLookUpLine({ image: crop?.embed ?? null, word, pageLink, date: lookUpDate(now) });
		let added = false;
		try {
			await app.vault.process(note, (current) => {
				const next = appendLookUpLine(current, line);
				added = next !== null;
				return next ?? current;
			});
		} catch (e) {
			await discard(app, stored);
			stored = null;
			throw e;
		}
		if (!added) await discard(app, stored);
		stored = null;
		showNotice(t(added ? "lookup.done" : "lookup.exists", { name: note.basename }), 5000);
		return note.path;
	} catch (e) {
		console.error("[notebook] look up later", e);
		await discard(app, stored);
		showNotice(t("lookup.failed", { error: e instanceof Error ? e.message : String(e) }), 9000);
		return null;
	}
}

/** The entries of the list note that point at `file` (empty when the note is missing or unreadable). Reads the note once. */
export async function readLookUps(app: App, file: TFile, settings: NotebookSettings): Promise<{ note: TFile | null; entries: LookUpEntry[] }> {
	const note = app.vault.getFileByPath(lookUpNoteOf(settings));
	if (!note) return { note: null, entries: [] };
	try {
		const text = await app.vault.cachedRead(note);
		// This notebook's entries across the whole note, then the cap (a list shared by all notebooks): resolving a link once per name.
		const known = new Map<string, boolean>();
		const pointsHere = (linkPath: string): boolean => {
			let yes = known.get(linkPath);
			if (yes === undefined) {
				yes = app.metadataCache.getFirstLinkpathDest(linkPath, note.path)?.path === file.path;
				known.set(linkPath, yes);
			}
			return yes;
		};
		return { note, entries: parseLookUpNote(text, (e) => pointsHere(e.linkPath)) };
	} catch (e) {
		console.error("[notebook] look up list", e);
		return { note, entries: [] };
	}
}

/** The small dialog: an optional word to type beside the picture. */
export class LookUpWordModal extends Modal {
	private word = "";

	constructor(app: App, private readonly pageNumber: number, private readonly run: (word: string) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("lookup.title"), icon: "book-search", size: "narrow", cls: "notebook-lookup-modal" });
		shellNote(shell.body, t("lookup.desc", { page: String(this.pageNumber) }));
		const field = shellField(shell.body, t("lookup.word"), "nb-lookup-word");
		const input = field.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-lookup-word", type: "text", maxlength: "120", autocomplete: "off", placeholder: t("lookup.word.placeholder") } });
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("lookup.add"), () => this.submit(), { icon: "plus" });
		input.addEventListener("input", () => {
			this.word = input.value;
		});
		input.addEventListener("keydown", (e) => {
			if (isSubmitKey(e)) this.submit();
		});
		window.setTimeout(() => input.focus(), 0);
	}

	private submit(): void {
		const word = this.word;
		this.close();
		this.run(word);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Most rows drawn in the sheet. */
const MAX_ROWS = 100;

export interface LookUpSheetHost {
	app: App;
	file: TFile;
	settings: NotebookSettings;
	pages(): ReadonlyArray<{ id: string }>;
	/** Scrolls the view to the page (0-based). */
	goTo(index: number): void;
}

/** The sheet: this notebook's entries (read-only), a count, a jump to the page for each, and a way to open the note itself. */
export class LookUpSheet extends Modal {
	constructor(private readonly host: LookUpSheetHost) {
		super(host.app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("lookup.sheet.title"), subtitle: this.host.file.basename, icon: "book-search", size: "medium", cls: "notebook-lookup-sheet" });
		const list = shell.body.createDiv({ cls: "nb-modal-list nb-lookup-list" });
		shellNote(list, t("lookup.sheet.loading"));
		const openNote = shellButton(shell.foot, "secondary", t("lookup.sheet.openNote"), () => {
			const note = this.host.app.vault.getFileByPath(lookUpNoteOf(this.host.settings));
			this.close();
			if (note) void this.host.app.workspace.getLeaf("tab").openFile(note);
		}, { icon: "file-text" });
		openNote.disabled = true;
		shellButton(shell.foot, "secondary", t("create.close"), () => this.close());
		void readLookUps(this.host.app, this.host.file, this.host.settings).then(({ note, entries }) => {
			if (!list.isConnected) return;
			list.empty();
			openNote.disabled = !note;
			this.fill(list, entries);
		});
	}

	private fill(list: HTMLElement, entries: readonly LookUpEntry[]): void {
		if (entries.length === 0) {
			shellNote(list, t("lookup.sheet.none"));
			return;
		}
		list.createDiv({ cls: "nb-modal-section-title", text: t("lookup.sheet.count", { open: String(openCount(entries)), total: String(entries.length) }) });
		for (const entry of entries.slice(0, MAX_ROWS)) this.row(list, entry);
		if (entries.length > MAX_ROWS) shellNote(list, t("lookup.sheet.more", { n: String(entries.length - MAX_ROWS) }));
	}

	private row(list: HTMLElement, entry: LookUpEntry): void {
		const { app } = this.host;
		const btn = list.createEl("button", { cls: `nb-lookup-row${entry.done ? " is-done" : ""}`, attr: { type: "button" } });
		const thumb = btn.createDiv({ cls: "nb-lookup-thumb" });
		const note = app.vault.getFileByPath(lookUpNoteOf(this.host.settings));
		const picture = entry.imagePath && note ? app.metadataCache.getFirstLinkpathDest(entry.imagePath, note.path) : null;
		if (picture) thumb.createEl("img", { attr: { src: app.vault.getResourcePath(picture), alt: "", loading: "lazy", draggable: "false" } });
		else setIcon(thumb, entry.done ? "check" : "book-search");
		const text = btn.createDiv({ cls: "nb-lookup-text" });
		text.createDiv({ cls: "nb-lookup-word", text: entry.word || t("lookup.sheet.noWord") });
		const meta = [entry.page !== null ? t("lookup.sheet.page", { n: String(entry.page) }) : "", entry.date, entry.done ? t("lookup.sheet.done") : ""].filter((s) => s !== "");
		text.createDiv({ cls: "nb-lookup-meta", text: meta.join(" · ") });
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			this.jump(entry);
		});
	}

	private jump(entry: LookUpEntry): void {
		const target = pageTargetFromSubpath(entry.subpath);
		if (!target) {
			showNotice(t("lookup.sheet.noPage"), 5000);
			return;
		}
		const found = resolvePageTarget(this.host.pages(), target);
		if (!("index" in found)) {
			showNotice(t("lookup.sheet.gone"), 6000);
			return;
		}
		this.close();
		this.host.goTo(found.index);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
