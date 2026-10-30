/**
 * v8 markers in the notebook view (#201, #202, #203, #209), structured boxes (#204), invisible ink (#100) and the
 * "End of lecture" panel (#223). Self-contained: the view forwards pointer gestures and owns nothing of this but a
 * `MarkerTools` instance. The UI is deliberately small (commands, one page-menu entry, dialogs), so the action
 * registry of the redesigned toolbar and radial menu can call `MarkerTools.arm()` and the toggles directly.
 */
import { Modal, Notice, Setting, SuggestModal, type App, type Menu, type Plugin } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { BoxLabel } from "../ink/marker-render";
import { defaultBoxLabel } from "../ink/marker-render";
import { AddElement, RemoveElement, ReplaceElement, type Command } from "../model/history";
import { SetMarkerDone } from "../model/marker-commands";
import {
	collectMarkers, createBox, createMarker, editBox, editMarker, groupMarkers, isRegion, isResolvable, lectureRange, markerAt,
	openCount, rectFrom, tapMarker, type MarkerEntry, type Rect,
} from "../model/markers";
import {
	BOX_KINDS, MARKER_KINDS, type BoxElement, type BoxKind, type MarkerElement, type MarkerKind, type NotebookDocument, type Page, type PageElement,
} from "../model/types";
import type { NotebookView } from "./notebook-view";

/** What the next tap or drag on a page places. */
export type PlaceKind = MarkerKind | "box";

/** What the view gives the marker tools. */
export interface MarkerHost {
	app: App;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Runs one undoable step and refreshes the view. */
	execute(cmd: Command): void;
	currentPageIndex(): number;
	/** Scrolls so that page `index` is in view with page y `y` near the top. */
	scrollTo(index: number, y: number): void;
	/** 1-based page of the reference PDF beside the notes, or null when none is open. */
	referenceSlide(): number | null;
	/** Shows (or clears) the rectangle being dragged on a page. */
	preview(pageIndex: number, rect: Rect | null): void;
	/** Redraws the pages (a view-only toggle changed). */
	repaint(): void;
	/** CSS px per pt. */
	scale(): number;
}

/** Contact moved further than this (CSS px): a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** Extra hit area around a badge, CSS px. */
const BADGE_TOLERANCE_PX = 6;

interface Gesture {
	mode: "place" | "tap";
	pageIndex: number;
	pageId: string;
	start: [number, number];
	end: [number, number];
	sx: number;
	sy: number;
	moved: boolean;
	target: MarkerElement | BoxElement | null;
}

export function markerKindName(kind: MarkerKind): string {
	return t(`markers.kind.${kind}` as MessageKey);
}

export function boxKindName(kind: BoxKind): string {
	return t(`markers.box.${kind}` as MessageKey);
}

/** Box labels in the reader's language (the companion note always uses the English callout types). */
export const translatedBoxLabel: BoxLabel = (box) => defaultBoxLabel(box, {
	definition: boxKindName("definition"), theorem: boxKindName("theorem"), example: boxKindName("example"),
	proof: boxKindName("proof"), remark: boxKindName("remark"),
});

/** Placement, taps on badges and the view-only toggles of one notebook view. */
export class MarkerTools {
	/** What the next tap or drag places (one-shot), or null. */
	armed: PlaceKind | null = null;
	/** Invisible-ink pen mode: new pen strokes are hidden; while it is on, hidden ink is shown to the writer. */
	invisibleInk = false;
	private solutionsAll = false;
	private readonly solutionsPages = new Set<string>();
	private gesture: Gesture | null = null;

	constructor(private readonly host: MarkerHost) {}

	/** Page of the gesture in progress, or null when no contact is ours. */
	get gesturePage(): number | null {
		return this.gesture?.pageIndex ?? null;
	}

	// --- view-only toggles (never saved) ---

	/** Whether the hidden ink of `page` is drawn (and can be erased or selected). */
	isRevealed(page: Page): boolean {
		return this.invisibleInk || this.solutionsAll || this.solutionsPages.has(page.id);
	}

	get solutionsShown(): boolean {
		return this.solutionsAll;
	}

	toggleInvisibleInk(): void {
		this.invisibleInk = !this.invisibleInk;
		new Notice(t(this.invisibleInk ? "markers.invisible.on" : "markers.invisible.off"));
		this.host.repaint();
	}

	toggleSolutions(): void {
		this.solutionsAll = !this.solutionsAll;
		if (!this.solutionsAll) this.solutionsPages.clear();
		new Notice(t(this.solutionsAll ? "markers.solutions.shown" : "markers.solutions.hidden"));
		this.host.repaint();
	}

	togglePageSolutions(): void {
		const page = this.host.doc()?.pages[this.host.currentPageIndex()];
		if (!page) return;
		const on = !this.solutionsPages.has(page.id);
		if (on) this.solutionsPages.add(page.id);
		else this.solutionsPages.delete(page.id);
		new Notice(t(on ? "markers.solutions.pageShown" : "markers.solutions.pageHidden"));
		this.host.repaint();
	}

	// --- placing ---

	/** The next tap (a point) or drag (a region) on a page places `kind`. A box needs a drag. */
	arm(kind: PlaceKind): void {
		if (!this.host.editable()) return;
		this.armed = kind;
		new Notice(t(kind === "box" ? "markers.hint.box" : "markers.hint.marker", { kind: kind === "box" ? "" : markerKindName(kind) }));
	}

	disarm(): void {
		this.armed = null;
	}

	/**
	 * Pen or finger down at `local` on page `pageIndex`. Returns true when the contact is ours: placing an armed
	 * marker or box, or a tap on a badge or box label (any tool but the lasso and the eraser, which select and erase).
	 */
	begin(pageIndex: number, page: Page, local: [number, number], screen: { x: number; y: number }, tool: string): boolean {
		this.gesture = null;
		if (this.armed) {
			this.gesture = { mode: "place", pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, moved: false, target: null };
			return true;
		}
		if (tool === "lasso" || tool === "eraser") return false;
		const tol = BADGE_TOLERANCE_PX / Math.max(0.05, this.host.scale());
		const hit = markerAt(page.elements ?? [], local[0], local[1], tol);
		if (!hit) return false;
		this.gesture = { mode: "tap", pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, moved: false, target: hit };
		return true;
	}

	/** The contact moved (CSS px relative to the stage, and the page point). Returns true while the gesture is ours. */
	move(local: [number, number] | null, screen: { x: number; y: number } | null): boolean {
		const g = this.gesture;
		if (!g) return false;
		if (screen && Math.hypot(screen.x - g.sx, screen.y - g.sy) > TAP_SLOP_PX) g.moved = true;
		if (local) g.end = local;
		if (g.mode === "place" && g.moved) this.host.preview(g.pageIndex, rectFrom(g.start, g.end));
		return true;
	}

	/** The contact ended. Returns true when it was ours. */
	end(cancelled: boolean): boolean {
		const g = this.gesture;
		if (!g) return false;
		this.gesture = null;
		this.host.preview(g.pageIndex, null);
		if (cancelled) return true;
		const doc = this.host.doc();
		const page = doc?.pages[g.pageIndex];
		// The document may have been reloaded meanwhile: never act on another page.
		if (!doc || !page || page.id !== g.pageId || !this.host.editable()) return true;
		if (g.mode === "place") this.place(page, g);
		else if (!g.moved && g.target && page.elements?.includes(g.target)) this.tap(page, g.target);
		return true;
	}

	private place(page: Page, g: Gesture): void {
		const kind = this.armed;
		this.armed = null;
		if (!kind) return;
		const rect = g.moved ? rectFrom(g.start, g.end) : null;
		const region = rect && isRegion(rect) ? rect : null;
		if (kind === "box") {
			if (!region) {
				new Notice(t("markers.hint.boxDrag"));
				this.armed = "box";
				return;
			}
			new BoxKindModal(this.host.app, (chosen) => this.add(page, createBox(chosen, region))).open();
			return;
		}
		const at = new Date().toISOString();
		const [x, y] = g.start;
		const slide = kind === "gap" ? this.slideFor(page) : null;
		if (kind === "homework") {
			// The task needs what to do and when: asked first, placed in one step.
			new MarkerEditModal(this.host.app, createMarker("homework", x, y, { region, at }), (edit) => {
				this.add(page, editMarker(createMarker("homework", x, y, { region, at }), edit));
			}).open();
			return;
		}
		this.add(page, createMarker(kind, x, y, { region, at, slide }));
	}

	/** The slide in view for a gap: the reference PDF beside the notes, else the page's own PDF page. */
	private slideFor(page: Page): number | null {
		return this.host.referenceSlide() ?? (page.background?.kind === "pdf" ? page.background.page : null);
	}

	private add(page: Page, el: PageElement): void {
		const doc = this.host.doc();
		if (!doc || !doc.pages.includes(page) || !this.host.editable()) return;
		this.host.execute(new AddElement(page.id, el, page.elements?.length ?? 0));
	}

	/** A tap on a badge: questions and gaps toggle resolved, importance markers cycle, homework and boxes open their dialog. */
	private tap(page: Page, target: MarkerElement | BoxElement): void {
		if (target.type === "box") {
			this.editBoxDialog(page, target);
			return;
		}
		const next = tapMarker(target);
		if (next) this.host.execute(new ReplaceElement(page.id, target, next));
		else this.editMarkerDialog(page, target);
	}

	// --- editing ---

	editMarkerDialog(page: Page, marker: MarkerElement, after?: () => void): void {
		new MarkerEditModal(this.host.app, marker, (edit) => {
			if (!page.elements?.includes(marker) || !this.host.editable()) return;
			this.host.execute(new ReplaceElement(page.id, marker, editMarker(marker, edit)));
			after?.();
		}, () => {
			if (!page.elements?.includes(marker) || !this.host.editable()) return;
			this.host.execute(new RemoveElement(page.id, marker));
			after?.();
		}).open();
	}

	editBoxDialog(page: Page, box: BoxElement, after?: () => void): void {
		new BoxEditModal(this.host.app, box, (kind, title) => {
			if (!page.elements?.includes(box) || !this.host.editable()) return;
			this.host.execute(new ReplaceElement(page.id, box, editBox(box, kind, title)));
			after?.();
		}, () => {
			if (!page.elements?.includes(box) || !this.host.editable()) return;
			this.host.execute(new RemoveElement(page.id, box));
			after?.();
		}).open();
	}

	/** Resolves or reopens a marker by id (the panel's checkboxes). */
	setDone(pageId: string, markerId: string, done: boolean): void {
		if (this.host.editable()) this.host.execute(new SetMarkerDone(pageId, markerId, done));
	}

	openPanel(): void {
		if (!this.host.doc()) return;
		new EndOfLectureModal(this.host.app, this, this.host).open();
	}

	/** One entry in the page menu: everything markers, boxes and invisible ink offer. */
	openChooser(): void {
		new MarkerActionModal(this.host.app, this).open();
	}
}

// ------------------------------------------------------------------ dialogs

function dateFieldValue(v: string | undefined): string {
	return v ?? "";
}

/** Text, due date (homework), resolved state; Delete when the marker exists. */
class MarkerEditModal extends Modal {
	private text: string;
	private due: string;
	private done: boolean;

	constructor(app: App, private readonly marker: MarkerElement, private readonly onSave: (edit: { text: string | null; due: string | null; done: boolean }) => void, private readonly onDelete?: () => void) {
		super(app);
		this.text = marker.text ?? "";
		this.due = dateFieldValue(marker.due);
		this.done = !!marker.done;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.setTitle(markerKindName(this.marker.kind));
		const save = () => {
			this.close();
			this.onSave({ text: this.text, due: this.marker.kind === "homework" ? this.due || null : (this.marker.due ?? null), done: this.done });
		};
		new Setting(this.contentEl).setName(t(this.marker.kind === "homework" ? "markers.edit.what" : "markers.edit.text")).addText((text) => {
			text.setValue(this.text).onChange((v) => (this.text = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					save();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		if (this.marker.kind === "homework") {
			new Setting(this.contentEl).setName(t("markers.edit.due")).addText((text) => {
				text.inputEl.type = "date";
				text.setValue(this.due).onChange((v) => (this.due = v));
			});
		}
		if (isResolvable(this.marker.kind)) {
			new Setting(this.contentEl).setName(t("markers.edit.done")).addToggle((tg) => tg.setValue(this.done).onChange((v) => (this.done = v)));
		}
		if (this.marker.at || this.marker.slide) {
			const parts: string[] = [];
			if (this.marker.at) parts.push(t("markers.panel.at", { time: formatTime(this.marker.at) }));
			if (this.marker.slide) parts.push(t("markers.panel.slide", { n: String(this.marker.slide) }));
			this.contentEl.createDiv({ cls: "setting-item-description notebook-marker-meta", text: parts.join(" · ") });
		}
		const buttons = new Setting(this.contentEl);
		if (this.onDelete) {
			buttons.addButton((b) => b.setButtonText(t("markers.edit.delete")).setWarning().onClick(() => {
				this.close();
				this.onDelete?.();
			}));
		}
		buttons.addButton((b) => b.setButtonText(t("markers.edit.save")).setCta().onClick(save));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class BoxEditModal extends Modal {
	private kind: BoxKind;
	private title: string;

	constructor(app: App, box: BoxElement, private readonly onSave: (kind: BoxKind, title: string | null) => void, private readonly onDelete: () => void) {
		super(app);
		this.kind = box.kind;
		this.title = box.title ?? "";
	}

	onOpen(): void {
		this.contentEl.empty();
		this.setTitle(t("markers.box.edit"));
		const save = () => {
			this.close();
			this.onSave(this.kind, this.title);
		};
		new Setting(this.contentEl).setName(t("markers.box.kind")).addDropdown((d) => {
			for (const k of BOX_KINDS) d.addOption(k, boxKindName(k));
			d.setValue(this.kind).onChange((v) => (this.kind = v as BoxKind));
		});
		new Setting(this.contentEl).setName(t("markers.box.title")).addText((text) => {
			text.setValue(this.title).onChange((v) => (this.title = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					save();
				}
			});
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("markers.edit.delete")).setWarning().onClick(() => {
				this.close();
				this.onDelete();
			}))
			.addButton((b) => b.setButtonText(t("markers.edit.save")).setCta().onClick(save));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Which kind of box was just drawn. */
class BoxKindModal extends SuggestModal<BoxKind> {
	constructor(app: App, private readonly chosen: (kind: BoxKind) => void) {
		super(app);
		this.setPlaceholder(t("markers.box.choose"));
	}

	getSuggestions(query: string): BoxKind[] {
		const q = query.trim().toLowerCase();
		return BOX_KINDS.filter((k) => boxKindName(k).toLowerCase().includes(q));
	}

	renderSuggestion(kind: BoxKind, el: HTMLElement): void {
		el.createSpan({ cls: `notebook-marker-swatch notebook-box-${kind}` });
		el.createSpan({ text: boxKindName(kind) });
	}

	onChooseSuggestion(kind: BoxKind): void {
		this.chosen(kind);
	}
}

interface MarkerAction {
	label: string;
	run: () => void;
}

/** The page-menu entry: place a marker or box, invisible ink, solutions, the panel. */
class MarkerActionModal extends SuggestModal<MarkerAction> {
	constructor(app: App, private readonly tools: MarkerTools) {
		super(app);
		this.setPlaceholder(t("markers.menu.placeholder"));
	}

	getSuggestions(query: string): MarkerAction[] {
		const tools = this.tools;
		const list: MarkerAction[] = [
			...MARKER_KINDS.map((k) => ({ label: t("markers.menu.place", { kind: markerKindName(k) }), run: () => tools.arm(k) })),
			{ label: t("markers.menu.box"), run: () => tools.arm("box") },
			{ label: t("markers.menu.panel"), run: () => tools.openPanel() },
			{ label: t(tools.invisibleInk ? "markers.menu.invisibleOff" : "markers.menu.invisibleOn"), run: () => tools.toggleInvisibleInk() },
			{ label: t(tools.solutionsShown ? "markers.menu.solutionsHide" : "markers.menu.solutionsShow"), run: () => tools.toggleSolutions() },
			{ label: t("markers.menu.pageSolutions"), run: () => tools.togglePageSolutions() },
		];
		const q = query.trim().toLowerCase();
		return list.filter((a) => a.label.toLowerCase().includes(q));
	}

	renderSuggestion(a: MarkerAction, el: HTMLElement): void {
		el.setText(a.label);
	}

	onChooseSuggestion(a: MarkerAction): void {
		a.run();
	}
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : iso;
}

const GLYPHS: Readonly<Record<MarkerKind, string>> = { gap: "…", question: "?", important: "!", critical: "!!", star: "★", homework: "✓" };

/**
 * "End of lecture" (#223): open questions, gaps, homework, importance markers and boxes of the current lecture (or the
 * whole notebook) at a glance. A row jumps to its place; the checkbox resolves a question, gap or homework.
 */
class EndOfLectureModal extends Modal {
	private wholeNotebook = false;

	constructor(app: App, private readonly tools: MarkerTools, private readonly host: MarkerHost) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-lecture-panel");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const doc = this.host.doc();
		this.contentEl.empty();
		if (!doc) return;
		const range = this.wholeNotebook ? { from: 0, to: doc.pages.length } : lectureRange(doc.pages, this.host.currentPageIndex());
		const entries = collectMarkers(doc, range);
		this.setTitle(t("markers.panel.title"));
		new Setting(this.contentEl)
			.setName(t("markers.panel.scope"))
			.setDesc(this.wholeNotebook ? t("markers.panel.scopeAll") : t("markers.panel.scopeLecture", { from: String(range.from + 1), to: String(range.to) }))
			.addToggle((tg) => tg.setValue(this.wholeNotebook).onChange((v) => {
				this.wholeNotebook = v;
				this.render();
			}));
		const open = openCount(entries);
		this.contentEl.createDiv({ cls: "notebook-marker-summary", text: entries.length === 0 ? t("markers.panel.empty") : t("markers.panel.open", { n: String(open) }) });
		const g = groupMarkers(entries);
		this.section("markers.panel.questions", g.questions);
		this.section("markers.panel.gaps", g.gaps);
		this.section("markers.panel.homework", g.homework);
		this.section("markers.panel.importance", g.importance);
		this.section("markers.panel.boxes", g.boxes);
	}

	private section(title: MessageKey, entries: readonly MarkerEntry[]): void {
		if (entries.length === 0) return;
		this.contentEl.createEl("h4", { cls: "notebook-marker-section", text: `${t(title)} (${entries.length})` });
		const list = this.contentEl.createDiv({ cls: "notebook-marker-list" });
		for (const e of entries) this.row(list, e);
	}

	private row(list: HTMLElement, entry: MarkerEntry): void {
		const el = entry.element;
		const row = list.createDiv({ cls: "notebook-marker-row" });
		const editable = this.host.editable();
		if (el.type === "marker" && isResolvable(el.kind)) {
			const box = row.createEl("input", { cls: "notebook-marker-check", attr: { type: "checkbox", "aria-label": t("markers.edit.done") } });
			box.checked = !!el.done;
			box.disabled = !editable;
			box.addEventListener("click", (ev) => ev.stopPropagation());
			box.addEventListener("change", () => {
				this.tools.setDone(entry.pageId, el.id, box.checked);
				this.render();
			});
		}
		const badge = row.createSpan({ cls: el.type === "box" ? `notebook-marker-swatch notebook-box-${el.kind}` : `notebook-marker-badge notebook-marker-${el.kind}` });
		if (el.type === "marker") badge.setText(GLYPHS[el.kind]);
		const main = row.createDiv({ cls: "notebook-marker-main" });
		const label = el.type === "box" ? translatedBoxLabel(el) : el.text ?? markerKindName(el.kind);
		main.createDiv({ cls: el.type === "marker" && el.done ? "notebook-marker-label is-done" : "notebook-marker-label", text: label });
		const meta: string[] = [t("markers.panel.page", { n: String(entry.pageIndex + 1) })];
		if (el.type === "marker") {
			if (el.due) meta.push(t("markers.panel.due", { date: el.due }));
			if (el.at) meta.push(t("markers.panel.at", { time: formatTime(el.at) }));
			if (el.slide) meta.push(t("markers.panel.slide", { n: String(el.slide) }));
		}
		main.createDiv({ cls: "notebook-marker-meta", text: meta.join(" · ") });
		main.addEventListener("click", () => {
			this.close();
			this.host.scrollTo(entry.pageIndex, Math.max(0, el.y - 40));
		});
		if (editable) {
			const edit = row.createEl("button", { cls: "notebook-marker-edit", text: t("markers.panel.edit"), attr: { type: "button" } });
			edit.addEventListener("click", () => {
				const page = this.host.doc()?.pages[entry.pageIndex];
				if (!page || page.id !== entry.pageId) return;
				const back = () => this.render();
				if (el.type === "box") this.tools.editBoxDialog(page, el, back);
				else this.tools.editMarkerDialog(page, el, back);
			});
		}
	}
}

// ------------------------------------------------------------------ commands and menu

type WithView = (checking: boolean, run: (view: NotebookView) => void) => boolean;

/** Commands (no default hotkeys): place each marker kind, draw a box, the panel, invisible ink, solutions. */
export function registerMarkerCommands(plugin: Plugin, withView: WithView): void {
	const add = (id: string, name: string, run: (tools: MarkerTools) => void) => plugin.addCommand({
		id, name, checkCallback: (checking) => withView(checking, (v) => {
			const tools = v.markerTools;
			if (tools) run(tools);
		}),
	});
	for (const kind of MARKER_KINDS) add(`marker-${kind}`, t("markers.menu.place", { kind: markerKindName(kind) }), (m) => m.arm(kind));
	add("marker-box", t("markers.menu.box"), (m) => m.arm("box"));
	add("end-of-lecture", t("markers.menu.panel"), (m) => m.openPanel());
	add("invisible-ink", t("markers.command.invisible"), (m) => m.toggleInvisibleInk());
	add("show-solutions", t("markers.command.solutions"), (m) => m.toggleSolutions());
	add("show-page-solutions", t("markers.menu.pageSolutions"), (m) => m.togglePageSolutions());
}

/** The one entry point in the page menu. */
export function addMarkerMenuItem(menu: Menu, tools: MarkerTools | null): void {
	if (!tools) return;
	menu.addItem((i) => i.setTitle(t("markers.menu.title")).setIcon("flag").onClick(() => tools.openChooser()));
}
