import { Modal, Notice, SuggestModal, setIcon, type App, type EventRef, type TFile } from "obsidian";
import { t } from "../i18n";
import { penLinkCandidate, type PenLinkCandidate } from "../ink/bracket-detect";
import type { BBox } from "../ink/hit-test";
import {
	completeLink, hitLink, inkLinkElement, linkTrigger, linktextOf, newNotePath, rankHeadings, rankNotes, setLinkResolver, soleLink,
	parseLinks, type LinkTrigger, type NoteEntry, type TextLink,
} from "../ink/link-text";
import { measureText } from "../ink/renderer";
import { candidatePaths } from "../integration/links";
import { AddElement, type Command } from "../model/history";
import { createId } from "../model/document";
import type { NotebookDocument, PageElement } from "../model/types";
import { isNotebookFile, NOTEBOOK_EXTENSIONS } from "../storage/format";
import type { TextEditor } from "./text-editor";

/**
 * Links written with the pen (O8), view side. The rules are in ink/link-text.ts and ink/bracket-detect.ts (pure); this
 * connects them to Obsidian: resolving and opening notes, the note chooser, the `[[` suggester in the text editor, the
 * chip offered after `[[` is written by hand, and opening a link with a tap.
 *
 * Nothing here is stored except ordinary text elements, so the file format is unchanged.
 */

export interface PenLinksHost {
	app: App;
	/** Vault path of the notebook: links resolve relative to it, as in a note next to it. */
	sourcePath(): string;
	stage(): HTMLElement;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Runs the command as one undo step and refreshes what depends on the document. */
	execute(cmd: Command): void;
	/** Redraws the page (a note appeared or went away: links are drawn dimmed when unresolved). */
	invalidate(): void;
	/** Page-local point to stage pixels; null when the page is not laid out. */
	toStage(pageIndex: number, x: number, y: number): [number, number] | null;
	/** The page and page-local point under a client position, with the zoom (px per pt). */
	pageAt(clientX: number, clientY: number): { pageIndex: number; local: [number, number]; scale: number } | null;
	/** A finger tap would pan, not draw (so a tap on a link can open it). */
	fingerNavigates(e: PointerEvent): boolean;
	/** The active tool name. */
	tool(): string;
	/** Colour for the labels of new links. */
	labelColor(): string;
	register(ref: EventRef): void;
}

/** Events a floating control must not leak to the page below: they would start strokes or pans. */
const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown"] as const;

/** A finger that moves farther than this (CSS px) or stays longer (ms) is not tapping. */
const TAP_SLOP = 10;
const TAP_MS = 450;
const CHIP_MS = 10_000;
const REFRESH_MS = 300;

// ------------------------------------------------------------------- notes

type Choice =
	| { kind: "note"; file: TFile; linktext: string }
	| { kind: "heading"; file: TFile; linktext: string; heading: string }
	| { kind: "raw"; linktext: string };

/** The notes of the vault that a link can point to, and the choices for what has been typed. */
class NoteIndex {
	private files: TFile[] = [];
	private entries: NoteEntry[] = [];
	private builtAt = 0;

	constructor(private readonly app: App, private readonly source: () => string) {}

	private refresh(): void {
		const now = Date.now();
		if (now - this.builtAt < 5000 && this.entries.length > 0) return;
		this.builtAt = now;
		this.files = this.app.vault.getFiles().filter((f) => f.extension === "md" || isNotebookFile(f));
		this.entries = this.files.map((f) => ({ path: f.path, basename: f.basename, mtime: f.stat.mtime }));
	}

	resolve(target: string): TFile | null {
		const { metadataCache } = this.app;
		const source = this.source();
		const direct = metadataCache.getFirstLinkpathDest(target, source);
		if (direct) return direct;
		for (const candidate of candidatePaths(target, NOTEBOOK_EXTENSIONS).slice(1)) {
			const file = metadataCache.getFirstLinkpathDest(candidate, source);
			if (file) return file;
		}
		return null;
	}

	linktextFor(file: TFile): string {
		return this.app.metadataCache.fileToLinktext(file, this.source(), true);
	}

	/** Notes (or the headings of one note, after `#`) for what has been typed; a last choice links to the typed name as is. */
	choices(query: string, limit = 30): Choice[] {
		this.refresh();
		const hash = query.indexOf("#");
		if (hash >= 0) {
			const name = query.slice(0, hash).trim();
			const file = this.resolve(name);
			const typed = query.trim();
			if (!file) return typed ? [{ kind: "raw", linktext: typed }] : [];
			const headings = (this.app.metadataCache.getFileCache(file)?.headings ?? []).map((h) => h.heading);
			const base = this.linktextFor(file);
			const out: Choice[] = rankHeadings(query.slice(hash + 1), headings, limit).map((heading) => ({ kind: "heading", file, heading, linktext: `${base}#${heading}` }));
			return out;
		}
		const files = new Map(this.files.map((f) => [f.path, f]));
		const out: Choice[] = rankNotes(query, this.entries, limit).flatMap((e): Choice[] => {
			const file = files.get(e.path);
			return file ? [{ kind: "note", file, linktext: this.linktextFor(file) }] : [];
		});
		const typed = query.trim();
		if (typed && !out.some((c) => c.kind === "note" && c.file.basename.toLowerCase() === typed.toLowerCase())) out.push({ kind: "raw", linktext: typed });
		return out;
	}
}

function renderChoice(choice: Choice, el: HTMLElement): void {
	el.addClass("notebook-link-choice");
	if (choice.kind === "raw") {
		el.createDiv({ text: t("penlinks.linkTo", { name: choice.linktext }), cls: "notebook-link-choice-title" });
		el.createDiv({ text: t("penlinks.newNote"), cls: "notebook-link-choice-path" });
	} else if (choice.kind === "heading") {
		el.createDiv({ text: `# ${choice.heading}`, cls: "notebook-link-choice-title" });
		el.createDiv({ text: choice.file.path, cls: "notebook-link-choice-path" });
	} else {
		el.createDiv({ text: choice.file.basename, cls: "notebook-link-choice-title" });
		if (choice.file.parent && choice.file.parent.path !== "/") el.createDiv({ text: choice.file.parent.path, cls: "notebook-link-choice-path" });
	}
}

/** The chooser opened by "Link…" and by the chip: search the vault's notes, or type a name that does not exist yet. */
class NoteChooser extends SuggestModal<Choice> {
	constructor(app: App, private readonly index: NoteIndex, private readonly onChoose: (linktext: string) => void) {
		super(app);
		this.setPlaceholder(t("penlinks.search"));
		this.emptyStateText = t("penlinks.none");
	}

	getSuggestions(query: string): Choice[] {
		return this.index.choices(query);
	}

	renderSuggestion(choice: Choice, el: HTMLElement): void {
		renderChoice(choice, el);
	}

	onChooseSuggestion(choice: Choice): void {
		this.onChoose(choice.linktext);
	}
}

/** Offered when a link points to a note that does not exist. */
class UnresolvedLinkModal extends Modal {
	constructor(app: App, private readonly link: TextLink, private readonly create: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("penlinks.unresolved.title"));
		this.contentEl.createEl("p", { text: t("penlinks.unresolved.text", { name: this.link.target }) });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const make = row.createEl("button", { text: t("penlinks.createNote"), cls: "mod-cta", attr: { type: "button" } });
		make.addEventListener("click", () => {
			this.close();
			void this.create();
		});
		row.createEl("button", { text: t("penlinks.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------------- the text editor's [[ suggester

/** Suggestions under the text editor while a `[[` is open (Obsidian-style: arrows and Enter/Tab choose, Escape closes). */
class TextLinkSuggest {
	private readonly popup: HTMLElement;
	private choices: Choice[] = [];
	private active = 0;
	private trigger: LinkTrigger | null = null;
	private readonly off: Array<() => void> = [];

	constructor(private readonly area: HTMLTextAreaElement, private readonly index: NoteIndex, parent: HTMLElement) {
		this.popup = parent.createDiv({ cls: "notebook-link-suggest notebook-hidden", attr: { role: "listbox", "aria-label": t("penlinks.suggest") } });
		// Choosing with a pointer must not take the focus from the text field: that would close the editor.
		for (const type of ISOLATED) this.popup.addEventListener(type, (e) => {
			e.stopPropagation();
			if (type === "pointerdown" || type === "mousedown") e.preventDefault();
		});
		this.listen("input", () => this.update());
		this.listen("click", () => this.update());
		this.listen("keyup", (e) => {
			if (["ArrowLeft", "ArrowRight", "Home", "End"].includes((e as KeyboardEvent).key)) this.update();
		});
		this.listen("blur", () => this.hide());
		// Before the editor's own handler, so Escape closes the list first and Enter chooses instead of adding a line.
		this.listen("keydown", (e) => this.onKey(e as KeyboardEvent), true);
	}

	private listen(type: string, fn: (e: Event) => void, capture = false): void {
		this.area.addEventListener(type, fn, capture);
		this.off.push(() => this.area.removeEventListener(type, fn, capture));
	}

	get isOpen(): boolean {
		return !this.popup.hasClass("notebook-hidden");
	}

	hide(): void {
		this.trigger = null;
		this.choices = [];
		this.popup.addClass("notebook-hidden");
		this.popup.empty();
	}

	destroy(): void {
		for (const o of this.off) o();
		this.off.length = 0;
		this.popup.remove();
	}

	private update(): void {
		const trigger = linkTrigger(this.area.value, this.area.selectionStart ?? 0);
		const choices = trigger ? this.index.choices(trigger.query, 8) : [];
		if (!trigger || choices.length === 0) {
			this.hide();
			return;
		}
		this.trigger = trigger;
		this.choices = choices;
		this.active = Math.min(this.active, choices.length - 1);
		this.render();
		this.place();
	}

	private render(): void {
		this.popup.empty();
		this.choices.forEach((choice, i) => {
			const item = this.popup.createDiv({ cls: "notebook-link-suggest-item suggestion-item", attr: { role: "option" } });
			item.toggleClass("is-selected", i === this.active);
			renderChoice(choice, item);
			item.addEventListener("click", (e) => {
				e.preventDefault();
				this.pick(i);
			});
		});
		this.popup.removeClass("notebook-hidden");
	}

	/** Just under the text box, or above it when there is no room below. */
	private place(): void {
		const stage = this.popup.parentElement;
		if (!stage) return;
		const s = stage.getBoundingClientRect();
		const a = this.area.getBoundingClientRect();
		const below = a.bottom - s.top + 4;
		const height = this.popup.offsetHeight;
		const top = below + height > s.height ? Math.max(0, a.top - s.top - height - 4) : below;
		this.popup.setCssProps({
			"--notebook-suggest-x": `${Math.max(0, Math.min(a.left - s.left, s.width - 240))}px`,
			"--notebook-suggest-y": `${top}px`,
		});
	}

	private onKey(e: KeyboardEvent): void {
		if (!this.isOpen) return;
		const n = this.choices.length;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
			this.render();
		} else if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.pick(this.active);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.hide();
		}
	}

	private pick(i: number): void {
		const choice = this.choices[i];
		const trigger = this.trigger;
		if (!choice || !trigger) return;
		const done = completeLink(this.area.value, trigger, this.area.selectionStart ?? this.area.value.length, choice.linktext);
		this.area.value = done.text;
		this.area.setSelectionRange(done.cursor, done.cursor);
		this.hide();
		// The editor sizes itself on `input`.
		this.area.dispatchEvent(new Event("input"));
		this.area.focus({ preventScroll: true });
	}
}

// ------------------------------------------------------------------- the feature

export class PenLinks {
	private readonly index: NoteIndex;
	private readonly known = new Map<string, boolean>();
	private suggest: TextLinkSuggest | null = null;
	private chip: HTMLButtonElement | null = null;
	private chipTimer: number | null = null;
	private refreshTimer: number | null = null;
	private candidate: { pageIndex: number; value: PenLinkCandidate } | null = null;
	/** First bracket of candidates already linked or dismissed: not offered again. */
	private readonly declined = new Set<string>();
	private readonly off: Array<() => void> = [];
	private tap: { id: number; x: number; y: number; t: number } | null = null;
	private readonly resolver = (target: string): boolean => {
		let ok = this.known.get(target);
		if (ok === undefined) {
			ok = this.index.resolve(target) !== null;
			this.known.set(target, ok);
		}
		return ok;
	};

	constructor(private readonly host: PenLinksHost) {
		this.index = new NoteIndex(host.app, () => host.sourcePath());
		// Links to notes that do not exist are drawn dimmed: redraw when the vault's notes change.
		const changed = () => this.scheduleRefresh();
		host.register(host.app.metadataCache.on("resolved", changed));
		host.register(host.app.vault.on("create", changed));
		host.register(host.app.vault.on("delete", changed));
		host.register(host.app.vault.on("rename", changed));
		setLinkResolver(this.resolver);
		const stage = host.stage();
		this.listen(stage, "pointerdown", (e) => this.onDown(e as PointerEvent), true);
		this.listen(stage, "pointerup", (e) => this.onUp(e as PointerEvent));
		this.listen(stage, "pointercancel", () => (this.tap = null));
	}

	private listen(el: HTMLElement, type: string, fn: (e: Event) => void, capture = false): void {
		el.addEventListener(type, fn, capture);
		this.off.push(() => el.removeEventListener(type, fn, capture));
	}

	destroy(): void {
		for (const o of this.off) o();
		this.off.length = 0;
		this.hideChip();
		this.suggest?.destroy();
		this.suggest = null;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
		setLinkResolver(null);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.known.clear();
			this.host.invalidate();
		}, REFRESH_MS);
	}

	/** Another document was loaded: forget what belonged to the previous one. */
	reset(): void {
		this.hideChip();
		this.declined.clear();
		this.known.clear();
	}

	// --- opening links ---

	/** Opens the note a link points to in a new tab; a note that does not exist is offered for creation. */
	open(link: TextLink): void {
		const file = this.index.resolve(link.target);
		if (!file) {
			new UnresolvedLinkModal(this.host.app, link, () => this.createNote(link)).open();
			return;
		}
		void this.host.app.workspace.openLinkText(linktextOf(link), this.host.sourcePath(), "tab");
	}

	private async createNote(link: TextLink): Promise<void> {
		const { app } = this.host;
		try {
			const source = this.host.sourcePath();
			const parent = app.fileManager.getNewFileParent(source);
			const dest = newNotePath(link.target, parent.path);
			if (!dest) {
				new Notice(t("penlinks.badName", { name: link.target }), 6000);
				return;
			}
			if (dest.folder && !app.vault.getFolderByPath(dest.folder)) await app.vault.createFolder(dest.folder);
			if (!app.vault.getFileByPath(dest.path)) await app.vault.create(dest.path, "");
			this.known.clear();
			this.host.invalidate();
			await app.workspace.openLinkText(dest.path, source, "tab");
		} catch (e) {
			console.error("[notebook] create note", e);
			new Notice(t("penlinks.createFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}

	/** The first link in the text boxes among `elements`, for "Open link" on a selection. */
	linkIn(elements: readonly PageElement[]): TextLink | null {
		for (const el of elements) {
			if (el.type !== "text") continue;
			const sole = soleLink(el.text);
			const link = sole ?? parseLinks(el.text)[0];
			if (link) return link;
		}
		return null;
	}

	private onDown(e: PointerEvent): void {
		if (this.tap) this.tap = null;
		if (e.pointerType === "mouse") {
			// Ctrl/Cmd+click opens a link, as in Obsidian; the click must not also leave a dot of ink.
			if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || this.host.tool() === "text") return;
			const hit = this.linkAt(e.clientX, e.clientY);
			if (!hit) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			this.open(hit);
			return;
		}
		if (e.pointerType !== "touch" || !e.isPrimary || this.host.tool() === "text" || !this.host.fingerNavigates(e)) return;
		this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
	}

	private onUp(e: PointerEvent): void {
		const tap = this.tap;
		this.tap = null;
		if (!tap || tap.id !== e.pointerId || e.timeStamp - tap.t > TAP_MS) return;
		if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;
		const link = this.linkAt(e.clientX, e.clientY);
		if (link) this.open(link);
	}

	private linkAt(clientX: number, clientY: number): TextLink | null {
		const at = this.host.pageAt(clientX, clientY);
		const page = at && this.host.doc()?.pages[at.pageIndex];
		if (!at || !page) return null;
		return hitLink(page.elements ?? [], at.local[0], at.local[1], 8 / at.scale, measureText)?.link ?? null;
	}

	// --- text editor ---

	/** `[[` in the text editor opens the note suggester. */
	bindEditor(editor: TextEditor): void {
		this.suggest?.destroy();
		this.suggest = new TextLinkSuggest(editor.element, this.index, this.host.stage());
	}

	// --- linking ink ---

	/** Chooses a note and attaches it, as a link label, to the ink inside `region` of the page. */
	linkRegion(pageIndex: number, region: BBox): void {
		const doc = this.host.doc();
		const page = doc?.pages[pageIndex];
		if (!doc || !page || !this.host.editable()) return;
		const chooser = new NoteChooser(this.host.app, this.index, (linktext) => {
			// Only while the same document and page are still there, and nothing is being drawn.
			if (this.host.doc() !== doc || !doc.pages.includes(page) || !this.host.editable()) return;
			const el = inkLinkElement(createId(), region, linktext, page, this.host.labelColor(), measureText);
			this.host.execute(new AddElement(page.id, el, page.elements?.length ?? 0));
			this.known.clear();
			this.host.invalidate();
		});
		chooser.open();
	}

	// --- the chip after a handwritten [[ ---

	/** The pen went down: the offer goes away (writing on is how the name gets written). */
	strokeStarted(): void {
		this.hideChip();
	}

	/** Strokes were added to the page: offers to link them when they end in a handwritten `[[`. */
	strokesAdded(pageIndex: number): void {
		const page = this.host.doc()?.pages[pageIndex];
		if (!page || !this.host.editable()) return;
		const value = penLinkCandidate(page.strokes);
		if (!value || this.declined.has(value.brackets[0])) {
			this.hideChip();
			return;
		}
		this.candidate = { pageIndex, value };
		this.showChip();
	}

	/** The view moved or zoomed: the chip would point at the wrong place. */
	viewChanged(): void {
		if (this.chip) this.hideChip();
	}

	private showChip(): void {
		const c = this.candidate;
		if (!c) return;
		const at = this.host.toStage(c.pageIndex, c.value.bounds.maxX, c.value.bounds.maxY);
		if (!at) return;
		if (!this.chip) {
			const chip = this.host.stage().createEl("button", { cls: "notebook-pen-link-chip", attr: { type: "button", "aria-label": t("penlinks.chip") } });
			setIcon(chip.createSpan({ cls: "notebook-pen-link-chip-icon" }), "link");
			chip.createSpan({ text: t("penlinks.chip") });
			for (const type of ISOLATED) chip.addEventListener(type, (e) => e.stopPropagation());
			chip.addEventListener("click", (e) => {
				e.preventDefault();
				this.acceptChip();
			});
			this.chip = chip;
		}
		this.chip.setCssProps({ "--notebook-chip-x": `${Math.round(at[0])}px`, "--notebook-chip-y": `${Math.round(at[1]) + 8}px` });
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = window.setTimeout(() => this.hideChip(), CHIP_MS);
	}

	private acceptChip(): void {
		const c = this.candidate;
		this.hideChip();
		if (!c) return;
		this.declined.add(c.value.brackets[0]);
		this.linkRegion(c.pageIndex, c.value.bounds);
	}

	hideChip(): void {
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = null;
		this.chip?.remove();
		this.chip = null;
		this.candidate = null;
	}
}
