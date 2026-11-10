import { Notice, type App } from "obsidian";
import { t } from "../i18n";
import { captureClip, clipAssetIds, duplicateOffset, instantiateClip, MIN_PASTE_SCALE, pasteCommand, pasteOffset, pasteScale, type ClipContent } from "../ink/clipboard";
import { whiteToTransparent } from "../ink/image-alpha";
import { measureText } from "../ink/renderer";
import { withoutPinnedInk, withPinnedInk } from "../ink/attach";
import { captureCrossPageClip, type PagePart } from "../ink/cross-page";
import { planCleanup, type CleanupPlan } from "../ink/hook-clean";
import { planJoin, type JoinPlan } from "../ink/stroke-join";
import { planBaseline, type BaselinePlan } from "../ink/baseline";
import { analyseTidy, planTidy, type TidyOptions, type TidyPlan } from "../ink/tidy";
import { loadTidyOptions, TidyModal, type TidySummary } from "./tidy-modal";
import { planSmooth, SMOOTH_LABEL, STRAIGHTEN_LABEL, type SmoothMode, type SmoothPlan } from "../ink/smooth";
import { selectableItems } from "../model/groups";
import type { PageBox } from "../ink/layout";
import { commonOpacity, commonStyle, opacityAbility, planOpacity, planRestyle, restyleAbilities, type StyleGroup } from "../ink/restyle";
import { createOpacityRow, type OpacityRow } from "./opacity-row";
import { batchShapeStyle, commonShapeStyle, planShapeStyle, shapeAbilities, type ShapeStyleRequest } from "../ink/shape-restyle";
import { renderShapeStyle } from "./shape-style-row";
import { AddAsset, AddElement, AddPage, Batch, ReplaceElement, type Command } from "../model/history";
import type { Asset, ImageElement, NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import { decodePhoto, PhotoDecodeError, photoSize } from "../scan/decode";
import { isHeic } from "../scan/image-bytes";
import { internalClip, readSystemClipboard, systemClipFromEvent, writeSystemText, type InternalClip, type SystemClip, type SystemImage } from "./clipboard";
import { resolveAssetFile, storeAsset, type NotebookMedia } from "./media";
import { PasteModal } from "./paste-modal";
import { bytesMatchAssetId, planSharedAsset, readSharedEntry, sharedAssetPath, type SharedClipItem } from "../ink/shared-clip";
import { SharedClipBlockedError, SharedClipRefusedError, type SharedClipStore } from "../storage/shared-clip-store";
import { SharedClipModal } from "./shared-clip-modal";
import {
	clipMarker, decidePaste, MAX_PASTED_TEXT, normalizePastedText, pastedImageElement, pastedImageName, pastedTextElement,
} from "./paste-logic";
import { createPage } from "../model/document";
import { planMoveToPage, type MoveMode } from "../model/selection-move";
import { PagePickerModal } from "./page-picker-modal";
import { showNotice } from "./notice";
import { selectionKindOf } from "../ui/selection-kind";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from "./toolbar";

export interface SelectionState {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
	/** wave 0.10 (359): the items of the other pages when the lasso crossed a page boundary. */
	others?: PagePart[];
}

/** Every selected stroke and element, whatever page it is on. */
function allItems(sel: SelectionState): { strokes: Stroke[]; elements: PageElement[] } {
	const others = sel.others ?? [];
	return {
		strokes: [...sel.strokes, ...others.flatMap((o) => o.strokes)],
		elements: [...sel.elements, ...others.flatMap((o) => o.elements)],
	};
}

/** The part of the notebook view the selection actions need. */
export interface SelectionHost {
	app: App;
	folder(): string;
	media(): NotebookMedia | null;
	doc(): NotebookDocument | null;
	editable(): boolean;
	selection(): SelectionState | null;
	/** 0.15 (241): the selection belongs to the states' part editor: its handles set the part's pose, so no colour or width rows. */
	ownedByStates?(sel: SelectionState): boolean;
	/** Selects exactly these items of the page (switching to the lasso) so they can be moved right away. */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[], others?: PagePart[]): void;
	/** wave 0.10 (359): the page boxes, to put the items of several pages in one frame. */
	boxes(): readonly PageBox[];
	/** wave 0.10 (362): the clipboard files shared between devices through the vault. */
	sharedClips(): SharedClipStore;
	/** Runs the command as one undo step and refreshes everything that depends on the document; false when it was refused (nothing changed). */
	execute(cmd: Command): boolean;
	deleteSelection(): void;
	/** 0.29 (#10, review R3): whether the selection holds what a hidden study tape covers (then deleteSelection asks first). */
	selectionCovered?(): boolean;
	/** Page in view and the centre of the view in that page's coordinates. */
	pasteTarget(): { pageIndex: number; page: Page; x: number; y: number } | null;
	textStyle(): { fontSize: number; color: string };
	/** 0.16 (78): data URL of a page thumbnail for the page picker. */
	thumbnail(page: Page): string;
	/** 0.16 (78): scrolls to the page (the toast after moving a selection). */
	goToPage(index: number): void;
	/** 0.16 (78): drops the selection (its items left the page). */
	clearSelection(): void;
	/** True while the same document is still open and editable (everything here is asynchronous). */
	stillHere(doc: NotebookDocument): boolean;
}

/** Longest side of the copy made when white is turned transparent: enough for a page, light on a phone's memory. */
const MAX_TRANSPARENT_SIDE = 2048;

export class SelectionActions {
	readonly el: HTMLElement;
	private readonly styleRows: HTMLElement;
	/** 0.26 (#358): the opacity slider of the current selection (null when the selection has nothing that takes one). */
	private opacity: OpacityRow | null = null;
	private busy = false;

	/** `parent`: the contextual bar's extra slot (ui redesign); copy, cut, paste… are actions of the registry there. */
	constructor(parent: HTMLElement, private readonly host: SelectionHost) {
		this.el = parent.createDiv({ cls: "notebook-selection-styles notebook-hidden", attr: { role: "group", "aria-label": t("selection.bar") } });
		this.styleRows = this.el;
	}

	destroy(): void {
		this.el.remove();
	}

	// --- restyle rows ---

	/** Rebuilds the restyle rows (colour, width) for the current selection; hidden without one. */
	update(): void {
		const sel = this.host.selection();
		this.styleRows.empty();
		this.opacity = null;
		if (!sel || this.host.ownedByStates?.(sel)) {
			this.el.toggleClass("notebook-hidden", true);
			delete this.el.dataset.kind;
			return;
		}
		const all = allItems(sel);
		// 0.14 (402): the rows follow the content: ink has colour and width (a highlighter its own row), text has colour only,
		// a picture or another object has none (and then the strip is not shown at all).
		const texts = all.elements.filter((e) => e.type === "text").length;
		const images = all.elements.filter((e) => e.type === "image").length;
		const kind = selectionKindOf({ strokes: all.strokes.length, images, texts, others: all.elements.length - images - texts });
		if (kind) this.el.dataset.kind = kind;
		const ability = restyleAbilities(all.strokes, all.elements);
		if (ability.inkColor || ability.inkWidth) this.styleRow(sel, "ink", ability.inkColor, ability.inkWidth);
		if (ability.highlighterColor) this.styleRow(sel, "highlighter", true, ability.highlighterWidth);
		// 0.24 (#37): the fill and the line style of the shapes in the selection.
		this.shapeRow(all.strokes);
		// 0.26 (#358): the opacity of the ink, pictures and area highlighters in the selection.
		this.opacityRow(all.strokes, all.elements);
		this.el.toggleClass("notebook-hidden", !this.host.editable() || this.styleRows.childElementCount === 0);
	}

	private styleRow(sel: SelectionState, group: StyleGroup, colour: boolean, width: boolean): void {
		const row = this.styleRows.createDiv({ cls: "notebook-toolbar-group" });
		const all = allItems(sel);
		const common = commonStyle(all.strokes, all.elements, group);
		const highlighter = group === "highlighter";
		if (colour) {
			for (const color of highlighter ? HIGHLIGHTER_COLORS : PEN_COLORS) {
				const b = this.rawButton(row, `${t("selection.color")} ${color}`, () => this.restyle({ group, color }));
				b.addClass("notebook-swatch");
				b.toggleClass("is-active", common.color === color);
				b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": color });
			}
		}
		if (width) {
			(highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).forEach((w, i) => {
				const b = this.rawButton(row, `${t("selection.width")} ${i + 1}`, () => this.restyle({ group, width: w }));
				b.addClass("notebook-width");
				b.toggleClass("is-active", common.width === w);
				b.createSpan({ cls: `notebook-width-dot notebook-width-${highlighter ? "h" : "p"}${i}` });
			});
		}
	}

	/** 0.24 (#37): fill (closed shapes) and line style (every shape) of the shapes in the selection; nothing for a selection without a shape. */
	private shapeRow(strokes: readonly Stroke[]): void {
		const ability = shapeAbilities(strokes);
		if (!ability.fill && !ability.line) return;
		const common = commonShapeStyle(strokes);
		const row = this.styleRows.createDiv({ cls: "notebook-toolbar-group notebook-shape-style", attr: { role: "group", "aria-label": t("shapeStyle.title") } });
		renderShapeStyle(row, {
			showFill: ability.fill,
			showLine: ability.line,
			fill: common.fill,
			fillColor: common.fillColor,
			line: common.line,
			colours: PEN_COLORS,
			editable: this.host.editable(),
		}, {
			setFill: (fill) => this.restyleShape({ fill }),
			setFillColor: (fillColor) => this.restyleShape({ fillColor }),
			setLine: (line) => this.restyleShape({ line }),
		});
	}

	/** 0.26 (#358): the opacity slider; nothing for a selection without ink, picture or area. A mixed selection shows no value until the slider is moved. */
	private opacityRow(strokes: readonly Stroke[], elements: readonly PageElement[]): void {
		if (!opacityAbility(strokes, elements)) return;
		const row = createOpacityRow(this.styleRows, { commit: (value) => this.applyOpacity(value) }, "notebook-sel-opacity");
		row.set(commonOpacity(strokes, elements), this.host.editable());
		this.opacity = row;
	}

	/** The "Opacity" action: puts the focus on the selection's slider. False when the selection has none. */
	revealOpacity(): boolean {
		if (!this.opacity || this.el.hasClass("notebook-hidden")) return false;
		this.opacity.slider.focus();
		return true;
	}

	/**
	 * Sets the opacity of the selected ink, pictures and area highlighters as ONE undo step (every page of a selection that crossed pages), keeping the
	 * selection. Groups come whole; a locked element and the elements that take no opacity are left alone; a locked page refuses the step in the history.
	 */
	private applyOpacity(opacity: number): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans = parts.flatMap((part) => {
			const page = doc.pages[part.pageIndex];
			if (!page) return [];
			// The items as they are on the page now, found by id (an undo or redo since the selection was made replaced the objects).
			const strokeById = new Map(page.strokes.map((s) => [s.id, s]));
			const elementById = new Map((page.elements ?? []).map((e) => [e.id, e]));
			const picked = selectableItems(page, {
				strokes: part.strokes.flatMap((s) => strokeById.get(s.id) ?? []),
				elements: part.elements.flatMap((e) => elementById.get(e.id) ?? []),
			});
			const plan = planOpacity(page, picked.strokes, picked.elements, opacity);
			return plan ? [{ part, plan }] : [];
		});
		if (plans.length === 0) return;
		const command = plans.length === 1 ? plans[0]!.plan.command : new Batch("Opacity", plans.map((p) => p.plan.command));
		if (!this.host.execute(command)) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			const strokes = new Map(found.plan.strokes.map((s) => [s.id, s]));
			const elements = new Map(found.plan.elements.map((e) => [e.id, e]));
			return { pageIndex: part.pageIndex, strokes: part.strokes.map((s) => strokes.get(s.id) ?? s), elements: part.elements.map((e) => elements.get(e.id) ?? e) };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
	}

	/** Applies a shape style to the selected shapes as ONE undo step (every page of a selection that crossed pages), keeping the selection. */
	private restyleShape(req: ShapeStyleRequest): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans = parts.flatMap((part) => {
			const page = doc.pages[part.pageIndex];
			if (!page) return [];
			// Groups come whole and the ink a collapsed note keeps hidden is not offered here: the selection is already made of selectable items.
			const picked = selectableItems(page, { strokes: part.strokes.filter((s) => page.strokes.includes(s)), elements: [] });
			const plan = planShapeStyle(page, picked.strokes, req);
			return plan ? [{ part, plan }] : [];
		});
		if (plans.length === 0) return;
		if (!this.host.execute(batchShapeStyle(plans.map((p) => p.plan.command)))) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			const changed = new Map(found.plan.strokes.map((s) => [s.id, s]));
			return { pageIndex: part.pageIndex, strokes: part.strokes.map((s) => changed.get(s.id) ?? s), elements: part.elements };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
	}

	private rawButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": label, type: "button" } });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	// --- restyle ---

	private restyle(req: { group: StyleGroup; color?: string; width?: number }): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !page || !this.host.editable()) return;
		if (sel.others?.length) {
			// wave 0.10 (359): every page's items are restyled in their own page; one undo step.
			const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...sel.others];
			const plans = parts.flatMap((part) => {
				const target = doc.pages[part.pageIndex];
				const one = target ? planRestyle(target, part.strokes, part.elements, req) : null;
				return one ? [{ part, plan: one }] : [];
			});
			if (plans.length === 0) return;
			if (!this.host.execute(new Batch("Restyle selection", plans.map((p) => p.plan.command)))) return;
			const next = (part: PagePart): PagePart => {
				const found = plans.find((p) => p.part === part);
				return found ? { pageIndex: part.pageIndex, strokes: found.plan.strokes, elements: found.plan.elements } : part;
			};
			const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
			this.host.select(first.pageIndex, first.strokes, first.elements, rest);
			return;
		}
		const plan = planRestyle(page, sel.strokes, sel.elements, req);
		if (!plan) return;
		if (!this.host.execute(plan.command)) return;
		this.host.select(sel.pageIndex, plan.strokes, plan.elements);
	}

	// --- clean up (0.23, #314) ---

	/**
	 * Trims the hooks at the ends of the selected strokes and removes the stray dots touching them, as ONE undo step. Groups come
	 * whole (`selectableItems`); the ink a collapsed note keeps hidden is never touched (`planCleanup`); a locked page refuses
	 * the step in the history, which says so. The selection stays on the cleaned strokes.
	 */
	cleanUp(): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans: Array<{ part: PagePart; plan: CleanupPlan }> = [];
		for (const part of parts) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const onPage = new Set(page.strokes);
			const elements = part.elements.filter((e) => page.elements?.includes(e));
			const picked = selectableItems(page, { strokes: part.strokes.filter((s) => onPage.has(s)), elements });
			const plan = planCleanup(page, picked.strokes);
			if (plan) plans.push({ part, plan });
		}
		if (plans.length === 0) {
			showNotice(t("cleanup.nothing"));
			return;
		}
		const cmd = plans.length === 1 ? plans[0]!.plan.command : new Batch("Clean up strokes", plans.map((p) => p.plan.command));
		if (!this.host.execute(cmd)) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			const strokes = part.strokes.flatMap((s) => (found.plan.changes.has(s) ? (found.plan.changes.get(s) ?? []) : [s]));
			return { pageIndex: part.pageIndex, strokes, elements: part.elements };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		if (first.strokes.length + first.elements.length + rest.reduce((n, p) => n + p.strokes.length + p.elements.length, 0) === 0) this.host.clearSelection();
		else this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
		const hooks = plans.reduce((n, p) => n + p.plan.trimmed, 0);
		const dots = plans.reduce((n, p) => n + p.plan.removed, 0);
		showNotice(t("cleanup.done", { hooks: String(hooks), dots: String(dots) }));
	}

	// --- join broken strokes (0.24, #313) ---

	/**
	 * Joins the strokes of the selection that a tiny pen dropout split in two (neighbours in the page order, same style, the end of one
	 * meeting the start of the next along the same direction) into one stroke each, as ONE undo step. Groups come whole
	 * (`selectableItems`); the ink a collapsed note keeps hidden is never touched (`planJoin`); a locked page refuses the step in the
	 * history, which says so. The selection stays on the joined strokes. Always the person's choice: nothing is joined while writing.
	 */
	joinBroken(): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans: Array<{ part: PagePart; plan: JoinPlan }> = [];
		for (const part of parts) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const onPage = new Set(page.strokes);
			const elements = part.elements.filter((e) => page.elements?.includes(e));
			const picked = selectableItems(page, { strokes: part.strokes.filter((s) => onPage.has(s)), elements });
			const plan = planJoin(page, picked.strokes);
			if (plan) plans.push({ part, plan });
		}
		if (plans.length === 0) {
			showNotice(t("joinstrokes.nothing"));
			return;
		}
		const cmd = plans.length === 1 ? plans[0]!.plan.command : new Batch("Join broken strokes", plans.map((p) => p.plan.command));
		if (!this.host.execute(cmd)) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			const strokes = part.strokes.flatMap((s) => (found.plan.changes.has(s) ? (found.plan.changes.get(s) ?? []) : [s]));
			return { pageIndex: part.pageIndex, strokes, elements: part.elements };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
		const joints = plans.reduce((n, p) => n + p.plan.joints, 0);
		showNotice(t("joinstrokes.done", { n: String(joints) }));
	}

	// --- align to baseline (0.25, #93) ---

	/**
	 * Moves the crooked handwritten words of the selection straight up or down onto a common baseline per line (on ruled paper, onto the
	 * ruled line), as ONE undo step; the strokes only translate (`planBaseline`). Groups come whole (`selectableItems`), a group that
	 * holds a locked element or is not wholly selected stays where it is, the ink a collapsed note keeps hidden is never touched, and a
	 * locked page refuses the step in the history, which says so. The page times are not touched: the ink is moved, not written now.
	 * The selection stays on the moved strokes.
	 */
	alignBaseline(): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans: Array<{ part: PagePart; plan: BaselinePlan }> = [];
		for (const part of parts) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const onPage = new Set(page.strokes);
			const elements = part.elements.filter((e) => page.elements?.includes(e));
			const picked = selectableItems(page, { strokes: part.strokes.filter((s) => onPage.has(s)), elements });
			const plan = planBaseline(page, picked.strokes);
			if (plan) plans.push({ part, plan });
		}
		if (plans.length === 0) {
			showNotice(t("baseline.nothing"));
			return;
		}
		const cmd = plans.length === 1 ? plans[0]!.plan.command : new Batch("Align to baseline", plans.map((p) => p.plan.command));
		if (!this.host.execute(cmd)) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			return { pageIndex: part.pageIndex, strokes: part.strokes.map((s) => found.plan.changes.get(s) ?? s), elements: part.elements };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
		const words = plans.reduce((n, p) => n + p.plan.words, 0);
		showNotice(t(plans.some((p) => p.plan.ruled) ? "baseline.doneRuled" : "baseline.done", { n: String(words) }));
	}

	// --- tidy up (0.26, #238) ---

	/**
	 * "Tidy up": a sheet with the three steps (words onto a baseline, line starts onto a margin, oversized gaps closed) and what each
	 * would change, then ONE undo step (`planTidy`, rigid moves only). Works on the selection, or on the page `pageIndex` (the page in
	 * view when nothing is selected) as a whole. Locked elements, groups that are not whole, hidden ink and everything that is not
	 * handwriting stay where they are; a locked page refuses the step. The selection stays on the moved strokes.
	 */
	tidy(pageIndex?: number): void {
		const doc = this.host.doc();
		if (!doc || !this.host.editable()) return;
		const sel = this.host.selection();
		const selected = sel && pageIndex === undefined ? [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])] : [];
		const wholePage = selected.every((p) => p.strokes.length + p.elements.length === 0);
		const index = pageIndex ?? this.host.pasteTarget()?.pageIndex ?? 0;
		const parts: PagePart[] = wholePage ? [{ pageIndex: index, strokes: [...(doc.pages[index]?.strokes ?? [])], elements: [...(doc.pages[index]?.elements ?? [])] }] : selected;
		const requests = (): Array<{ part: PagePart; page: Page; strokes: Stroke[]; elements: PageElement[] }> => parts.flatMap((part) => {
			const page = doc.pages[part.pageIndex];
			if (!page) return [];
			const onPage = new Set(page.strokes);
			return [{ part, page, strokes: part.strokes.filter((s) => onPage.has(s)), elements: part.elements.filter((e) => page.elements?.includes(e)) }];
		});
		const preview = (options: TidyOptions): TidySummary => {
			const sums: TidySummary = { words: 0, aligned: 0, tightened: 0, saved: 0, locked: true };
			for (const r of requests()) {
				const a = analyseTidy(r.page, { strokes: r.strokes, elements: r.elements }, options);
				sums.words += a.words;
				sums.aligned += a.aligned;
				sums.tightened += a.tightened;
				sums.saved = Math.max(sums.saved, a.saved);
				if (!a.locked) sums.locked = false;
			}
			return sums;
		};
		const count = requests().reduce((n, r) => n + r.strokes.length, 0);
		new TidyModal(this.host.app, {
			kind: wholePage ? "page" : "selection", strokes: count, options: loadTidyOptions(this.host.app), preview,
			onApply: (options) => this.runTidy(doc, requests(), options, !wholePage),
		}).open();
	}

	private runTidy(doc: NotebookDocument, requests: Array<{ part: PagePart; page: Page; strokes: Stroke[]; elements: PageElement[] }>, options: TidyOptions, reselect: boolean): void {
		if (!this.host.stillHere(doc)) return;
		const plans: Array<{ part: PagePart; plan: TidyPlan }> = [];
		for (const r of requests) {
			const plan = planTidy(r.page, { strokes: r.strokes, elements: r.elements }, options);
			if (plan) plans.push({ part: r.part, plan });
		}
		if (plans.length === 0) {
			showNotice(t("tidy.none"));
			return;
		}
		const cmd = plans.length === 1 ? plans[0]!.plan.command : new Batch("Tidy up page", plans.map((p) => p.plan.command));
		if (!this.host.execute(cmd)) return;
		if (reselect) {
			const next = (part: PagePart): PagePart => {
				const found = plans.find((p) => p.part === part);
				return found ? { pageIndex: part.pageIndex, strokes: part.strokes.map((s) => found.plan.changes.get(s) ?? s), elements: part.elements } : part;
			};
			const [first, ...rest] = requests.map((r) => next(r.part)) as [PagePart, ...PagePart[]];
			this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
		}
		const sum = (pick: (a: TidyPlan["analysis"]) => number): number => plans.reduce((n, p) => n + pick(p.plan.analysis), 0);
		showNotice(t("tidy.done", { words: String(sum((a) => a.words)), lines: String(sum((a) => a.aligned)), gaps: String(sum((a) => a.tightened)) }));
	}

	// --- smooth / straighten handwriting (0.26, #66) ---

	/**
	 * Smooths the jitter out of the handwriting of the selection, or straightens its almost-straight lines, as ONE undo step; the strokes only
	 * change their points (`planSmooth`: ends, point count and pressure stay). Groups come whole (`selectableItems`, and only a wholly selected
	 * group without a locked element is touched), the ink a collapsed note keeps hidden is never touched, and a locked page refuses the step in
	 * the history, which says so. The page times are not touched. The selection stays on the reshaped strokes.
	 */
	reshape(mode: SmoothMode): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable()) return;
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const plans: Array<{ part: PagePart; plan: SmoothPlan }> = [];
		for (const part of parts) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const onPage = new Set(page.strokes);
			const elements = part.elements.filter((e) => page.elements?.includes(e));
			const picked = selectableItems(page, { strokes: part.strokes.filter((s) => onPage.has(s)), elements });
			const plan = planSmooth(page, picked.strokes, picked.elements, mode);
			if (plan) plans.push({ part, plan });
		}
		const base = mode === "smooth" ? "smooth" : "straighten";
		if (plans.length === 0) {
			showNotice(t(`${base}.nothing`));
			return;
		}
		const label = mode === "smooth" ? SMOOTH_LABEL : STRAIGHTEN_LABEL;
		const cmd = plans.length === 1 ? plans[0]!.plan.command : new Batch(label, plans.map((p) => p.plan.command));
		if (!this.host.execute(cmd)) return;
		const next = (part: PagePart): PagePart => {
			const found = plans.find((p) => p.part === part);
			if (!found) return part;
			return { pageIndex: part.pageIndex, strokes: part.strokes.map((s) => found.plan.changes.get(s) ?? s), elements: part.elements };
		};
		const [first, ...rest] = parts.map(next) as [PagePart, ...PagePart[]];
		this.host.select(first.pageIndex, first.strokes, first.elements, rest.length > 0 ? rest : undefined);
		showNotice(t(`${base}.done`, { n: String(plans.reduce((n, p) => n + p.plan.count, 0)) }));
	}

	// --- copy, cut, duplicate ---

	private capture(): { clip: ClipContent; pageIndex: number } | null {
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !page) return null;
		if (sel.others?.length) {
			const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...sel.others];
			const crossClip = captureCrossPageClip(this.host.boxes(), doc.pages, parts, sel.pageIndex, doc.assets, measureText);
			return crossClip ? { clip: crossClip, pageIndex: sel.pageIndex } : null;
		}
		const strokes = sel.strokes.filter((s) => page.strokes.includes(s));
		const elements = sel.elements.filter((e) => page.elements?.includes(e));
		// 0.17: a collapsed sticky note takes the ink it keeps hidden with it.
		const clip = captureClip(withPinnedInk(page.strokes, strokes, elements), elements, doc.assets, measureText);
		return clip ? { clip, pageIndex: sel.pageIndex } : null;
	}

	/** Copies the selection to the plugin clipboard and returns the text to put on the system clipboard (null: nothing selected). */
	copySync(): string | null {
		const got = this.capture();
		if (!got) return null;
		const images = got.clip.elements.filter((e) => e.type === "image").length;
		const marker = clipMarker(got.clip.strokes.length, images, got.clip.elements.length - images);
		const stored = internalClip.set(got.clip, marker);
		void this.keepImageBytes(stored.content, stored.bytes);
		return marker;
	}

	/** Reads the image files of a fresh clip, so it can be pasted into another notebook even if the source file moves. */
	private async keepImageBytes(content: ClipContent, into: Map<string, ArrayBuffer>): Promise<void> {
		const media = this.host.media();
		if (!media) return;
		for (const id of clipAssetIds(content)) {
			try {
				into.set(id, await media.readAsset(id));
			} catch (e) {
				console.error("[notebook] copy image", e);
			}
		}
	}

	async copy(): Promise<void> {
		const marker = this.copySync();
		if (marker === null) return;
		await writeSystemText(marker);
		new Notice(t("selection.copied"));
	}

	async cut(): Promise<void> {
		const marker = this.copySync();
		if (marker === null || !this.host.editable()) return;
		// 0.29 (#10, review R3): with covered content the delete waits for the answer to its question: the copy is made, "cut" is not said.
		const asks = this.host.selectionCovered?.() ?? false;
		this.host.deleteSelection();
		await writeSystemText(marker);
		if (!asks) new Notice(t("selection.cutDone"));
	}

	/** wave 0.10 (359): duplicates a selection across pages, each page's items next to the originals on their own page. */
	private duplicateAcross(sel: SelectionState, doc: NotebookDocument): void {
		const parts: PagePart[] = [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
		const commands: Command[] = [];
		const made: PagePart[] = [];
		for (const part of parts) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const elements = part.elements.filter((e) => page.elements?.includes(e));
			const clip = captureClip(
				withPinnedInk(page.strokes, part.strokes.filter((s) => page.strokes.includes(s)), elements), elements, doc.assets, measureText,
			);
			if (!clip) continue;
			const [dx, dy] = duplicateOffset(clip.bounds, page);
			const copy = instantiateClip(clip, dx, dy, undefined, measureText);
			commands.push(pasteCommand(page, copy.strokes, copy.elements, [], "Duplicate selection"));
			made.push({ pageIndex: part.pageIndex, strokes: withoutPinnedInk(copy.strokes, copy.elements), elements: copy.elements });
		}
		const [first, ...rest] = made;
		if (!first) return;
		if (!this.host.execute(new Batch("Duplicate selection", commands))) return;
		this.host.select(first.pageIndex, first.strokes, first.elements, rest);
	}

	duplicate(): void {
		const sel = this.host.selection();
		const whole = this.host.doc();
		if (sel?.others?.length && whole && this.host.editable()) {
			this.duplicateAcross(sel, whole);
			return;
		}
		const got = this.capture();
		const doc = this.host.doc();
		const page = doc?.pages[got?.pageIndex ?? -1];
		if (!got || !doc || !page || !this.host.editable()) return;
		const [dx, dy] = duplicateOffset(got.clip.bounds, page);
		const made = instantiateClip(got.clip, dx, dy, undefined, measureText);
		if (!this.host.execute(pasteCommand(page, made.strokes, made.elements, [], "Duplicate selection"))) return;
		this.host.select(got.pageIndex, withoutPinnedInk(made.strokes, made.elements), made.elements);
	}

	// --- 0.16 (78): move or copy the selection to another page ---

	/** Opens the page picker; the chosen page receives the selection (one undo step, a new page included). */
	moveToPage(mode: MoveMode = "move"): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc || !this.host.editable() || this.host.ownedByStates?.(sel)) return;
		if (sel.others?.length) {
			showNotice(t("movePage.crossPage"));
			return;
		}
		new PagePickerModal(this.host.app, {
			pages: () => doc.pages, from: sel.pageIndex, mode, thumbnail: (page) => this.host.thumbnail(page),
			choose: (target, exact) => this.performMove(doc, sel, mode, target, exact),
		}).open();
	}

	private performMove(doc: NotebookDocument, sel: SelectionState, mode: MoveMode, target: number | "new", exact: boolean): void {
		if (!this.host.stillHere(doc) || this.host.selection() !== sel) return;
		const fresh = target === "new" ? createPage({ width: doc.pages[sel.pageIndex]?.width ?? 595, height: doc.pages[sel.pageIndex]?.height ?? 842 }, { ...(doc.pages[sel.pageIndex]?.paper ?? { kind: "grid" as const, spacing: 20 }) }) : null;
		const to = fresh ? sel.pageIndex + 1 : (target as number);
		// A new page is planned against a copy of the page list with it in place, so one Batch adds it and moves the items.
		const shadow: NotebookDocument = fresh ? { ...doc, pages: [...doc.pages.slice(0, to), fresh, ...doc.pages.slice(to)] } : doc;
		const plan = planMoveToPage({ doc: shadow, from: sel.pageIndex, to, strokes: sel.strokes, elements: sel.elements, mode, exact, measure: measureText });
		if ("refused" in plan) {
			showNotice(t(plan.refused === "bound-ink" ? "movePage.boundInk" : "movePage.nothing"));
			return;
		}
		const command = fresh ? new Batch(plan.command.label, [new AddPage(fresh, to), plan.command]) : plan.command;
		this.host.clearSelection();
		if (!this.host.execute(command)) return;
		const key = mode === "move" ? "movePage.moved" : "movePage.copied";
		const message = t(key, { n: String(plan.count), page: String(to + 1) }) + (plan.leftParts > 0 ? ` ${t("movePage.leftParts")}` : "");
		const fragment = createFragment((f) => {
			f.createDiv({ text: message });
			const button = f.createEl("button", { text: t("movePage.goTo"), cls: "mod-cta", attr: { type: "button" } });
			button.addEventListener("click", (e) => {
				e.preventDefault();
				this.host.goToPage(to);
			});
		});
		showNotice(fragment, 8000);
	}

	// --- wave 0.10 (362): the clipboard shared with the other devices ---

	/** "Copy to other devices": writes the selection (strokes, elements and picture records) to this device's clipboard file. */
	async copyToDevices(): Promise<void> {
		const got = this.capture();
		if (!got) return;
		try {
			await this.host.sharedClips().publish(got.clip);
			new Notice(t("clipshare.copied"));
		} catch (e) {
			console.error("[notebook] copy to other devices", e);
			if (e instanceof SharedClipBlockedError) new Notice(t("clipshare.blocked", { error: e.message }), 10000);
			else if (e instanceof SharedClipRefusedError) new Notice(e.reason === "too-large" ? t("clipshare.tooLarge") : t("clipshare.failed", { error: e.message }), 8000);
			else new Notice(t("clipshare.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}

	/** "Paste from another device": lists the recent clipboards of the other devices' files and pastes the one chosen. */
	async pasteFromDevices(): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		let found;
		try {
			found = await this.host.sharedClips().listOthers();
		} catch (e) {
			console.error("[notebook] list shared clipboards", e);
			new Notice(t("clipshare.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
			return;
		}
		if (found.items.length === 0) {
			new Notice(found.unreadable.length > 0 ? t("clipshare.unreadable", { n: String(found.unreadable.length) }) : t("clipshare.none"), 8000);
			return;
		}
		new SharedClipModal(this.host.app, found.items, found.unreadable.length, (item) => void this.pasteShared(item)).open();
	}

	private async pasteShared(item: SharedClipItem): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const read = readSharedEntry(item.entry);
		if (!read.ok) {
			new Notice(t("clipshare.pasteFailed", { error: read.message }), 8000);
			return;
		}
		this.busy = true;
		try {
			// Pasted like a copy made here, but it never replaces this device's own plugin clipboard.
			await this.pasteInternal({ content: read.clip, bytes: new Map(), pastes: 0 }, true);
		} catch (e) {
			console.error("[notebook] paste from another device", e);
			new Notice(t("clipshare.pasteFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.busy = false;
		}
	}

	// --- paste ---

	/** Paste button: the newest of the plugin clipboard and the system clipboard; the paste box when the system one cannot be read. */
	async paste(): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sys = await readSystemClipboard();
		await this.pasteClip(sys, true);
	}

	/** Ctrl/Cmd+V (or the system's paste menu): the event carries the clipboard. */
	async pasteFromEvent(e: ClipboardEvent): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sys = await systemClipFromEvent(e);
		await this.pasteClip(sys, false);
	}

	private async pasteClip(sys: SystemClip, mayAskBox: boolean): Promise<void> {
		const decision = decidePaste(sys.state, internalClip.get()?.marker ?? null);
		this.busy = true;
		try {
			switch (decision) {
				case "internal":
					await this.pasteInternal();
					break;
				case "image":
					if (sys.image) await this.pasteImage(sys.image);
					break;
				case "text":
					this.pasteText(sys.state.text);
					break;
				case "unreadable":
					if (mayAskBox) this.openPasteBox();
					else new Notice(t("selection.nothingToPaste"));
					break;
				case "empty":
					new Notice(t("selection.nothingToPaste"));
					break;
			}
		} catch (e) {
			console.error("[notebook] paste", e);
			const heic = e instanceof PhotoDecodeError && e.reason === "heic";
			new Notice(heic ? t("scan.heic") : t("selection.pasteFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.busy = false;
		}
	}

	private openPasteBox(): void {
		new PasteModal(this.host.app, (clip) => void this.pasteClip(clip, false)).open();
	}

	/**
	 * Pastes the plugin clipboard on the page in view; images are stored again in this vault's assets folder when needed.
	 * `shared`: the clip comes from another device's file, so its picture records are not trusted (see `readSharedAsset`).
	 */
	private async pasteInternal(source?: Pick<InternalClip, "content" | "bytes" | "pastes">, shared = false): Promise<void> {
		const clip = source ?? internalClip.get();
		const target = this.host.pasteTarget();
		const doc = this.host.doc();
		const media = this.host.media();
		if (!clip || !target || !doc || !media) return;
		const newAssets: Asset[] = [];
		const pending: string[] = [];
		const assetMap = new Map<string, string>();
		const missing = new Set<string>();
		/** Pictures of a shared clip whose file is not (completely) here yet. */
		const unsynced = new Set<string>();
		try {
			for (const id of clipAssetIds(clip.content)) {
				const known = doc.assets?.[id];
				if (known && resolveAssetFile(this.host.app, known, this.host.folder())) continue;
				const record = clip.content.assets.find((a) => a.id === id);
				let bytes: ArrayBuffer | null = clip.bytes.get(id) ?? null;
				if (!bytes && record) {
					if (shared) {
						const got = await this.readSharedAsset(record);
						if (got.ok) bytes = got.bytes;
						else if (got.reason === "waiting" || got.reason === "missing") unsynced.add(id);
					} else {
						bytes = await this.readFromSource(record);
					}
				}
				if (!bytes || !record) {
					missing.add(id);
					continue;
				}
				const stored = await storeAsset(this.host.app, this.host.folder(), bytes, record.name, "image");
				// A shared picture is content-addressed: anything stored under another id is not the picture that was copied.
				if (shared && stored.id !== id) {
					missing.add(id);
					unsynced.add(id);
					continue;
				}
				media.addPending(stored);
				pending.push(stored.id);
				if (stored.id !== id) assetMap.set(id, stored.id);
				if (!doc.assets?.[stored.id] && !newAssets.some((a) => a.id === stored.id)) newAssets.push(stored);
			}
			if (!this.host.stillHere(doc) || !doc.pages.includes(target.page)) return;
			const content: ClipContent = missing.size === 0
				? clip.content
				: { ...clip.content, elements: clip.content.elements.flatMap((e): PageElement[] => {
					if (e.type === "image") return missing.has(e.asset) ? [] : [e];
					// v10: an excerpt whose snapshot is gone keeps its anchor (it draws live or as a placeholder).
					if (e.type === "excerpt" && e.asset !== undefined && missing.has(e.asset)) {
						const { asset: _a, ...rest } = e;
						void _a;
						return [rest];
					}
					return [e];
				}) };
			const gone = (): string => (unsynced.size > 0 ? t("clipshare.notSynced") : t("selection.assetMissing"));
			if (content.strokes.length === 0 && content.elements.length === 0) {
				new Notice(gone(), 8000);
				return;
			}
			// A clip bigger than the page (a cross-page copy, a shared clip) would land mostly outside it: invisible,
			// impossible to select and left out of the exports. It is scaled down to fit, or refused when that would be a speck.
			const scale = pasteScale(content.bounds, target.page);
			if (scale < MIN_PASTE_SCALE) {
				new Notice(t("selection.pasteTooBig"), 8000);
				return;
			}
			const [dx, dy] = pasteOffset(content.bounds, target.page, [target.x, target.y], clip.pastes % 8, scale);
			clip.pastes++;
			const made = instantiateClip(content, dx, dy, assetMap, measureText, scale);
			if (!this.host.execute(pasteCommand(target.page, made.strokes, made.elements, newAssets))) return;
			this.host.select(target.pageIndex, withoutPinnedInk(made.strokes, made.elements), made.elements);
			if (scale < 1) new Notice(t("selection.pasteScaled", { percent: String(Math.round(scale * 100)) }), 8000);
			if (missing.size > 0) new Notice(gone(), 8000);
		} finally {
			for (const id of pending) media.removePending(id);
		}
	}

	/**
	 * The bytes of a picture named by a record of another device's clipboard file. Only the shape `_assets/<id>.<ext>`
	 * is accepted (the file read is that name in this vault's assets folder, not the path as written), of a bounded size
	 * and complete (as big as the record says), and its content must hash to the id: a placeholder or a partly
	 * downloaded file would otherwise be stored under another id and the picture bound to it forever.
	 */
	private async readSharedAsset(record: Asset): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; reason: "invalid" | "missing" | "waiting" | "too-large" }> {
		const folder = this.host.folder();
		const path = sharedAssetPath(record, folder);
		if (path === null) return { ok: false, reason: "invalid" };
		const file = this.host.app.vault.getFileByPath(path);
		const plan = planSharedAsset(record, folder, file ? file.stat.size : null);
		if (!plan.ok || !file) return plan.ok ? { ok: false, reason: "missing" } : plan;
		let bytes: ArrayBuffer;
		try {
			bytes = await this.host.app.vault.readBinary(file);
		} catch {
			return { ok: false, reason: "missing" };
		}
		if (!(await bytesMatchAssetId(bytes, record.id))) return { ok: false, reason: "waiting" };
		return { ok: true, bytes };
	}

	private async readFromSource(record: Asset | undefined): Promise<ArrayBuffer | null> {
		if (!record) return null;
		const file = resolveAssetFile(this.host.app, record, this.host.folder());
		if (!file) return null;
		try {
			return await this.host.app.vault.readBinary(file);
		} catch {
			return null;
		}
	}

	/** A pasted picture becomes an image element in the middle of the view, like Insert image, and is selected. */
	private async pasteImage(image: SystemImage): Promise<void> {
		const target = this.host.pasteTarget();
		const doc = this.host.doc();
		const media = this.host.media();
		if (!target || !doc || !media) return;
		// Same checks as Insert image: HEIF/HEIC cannot be shown by the WebView, so it is refused before anything is stored.
		if (isHeic(image.bytes)) throw new PhotoDecodeError("heic");
		const dims = await photoSize(image.bytes, "", image.mime);
		const asset = await storeAsset(this.host.app, this.host.folder(), image.bytes, pastedImageName(image.mime), "image");
		media.addPending(asset);
		try {
			if (!this.host.stillHere(doc) || !doc.pages.includes(target.page)) return;
			const element = pastedImageElement(asset.id, dims, target.page, target.x, target.y);
			const index = target.page.elements?.length ?? 0;
			if (!this.host.execute(new Batch("Paste image", [new AddAsset(asset), new AddElement(target.page.id, element, index)]))) return;
			this.host.select(target.pageIndex, [], [element]);
		} finally {
			media.removePending(asset.id);
		}
	}

	/** Pasted plain text becomes a text box. */
	private pasteText(raw: string): void {
		const target = this.host.pasteTarget();
		if (!target) return;
		const { text, truncated } = normalizePastedText(raw);
		if (text === "") {
			new Notice(t("selection.nothingToPaste"));
			return;
		}
		const style = this.host.textStyle();
		const el = pastedTextElement(text, target.page, target.x, target.y, style.fontSize, style.color);
		if (!this.host.execute(new AddElement(target.page.id, el, target.page.elements?.length ?? 0))) return;
		this.host.select(target.pageIndex, [], [el]);
		if (truncated) new Notice(t("selection.textTruncated", { n: String(MAX_PASTED_TEXT) }), 8000);
	}

	// --- white to transparent ---

	/** Stores a copy of each selected image with its white made transparent (a new asset) and points the element at it; one undo step. */
	async makeWhiteTransparent(): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sel = this.host.selection();
		const doc = this.host.doc();
		const media = this.host.media();
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !media || !page) return;
		const images = sel.elements.filter((e): e is ImageElement => e.type === "image" && !!page.elements?.includes(e));
		if (images.length === 0) return;
		this.busy = true;
		const pending: string[] = [];
		try {
			const made = new Map<string, Asset | null>();
			for (const el of images) {
				if (made.has(el.asset)) continue;
				const copy = await this.transparentCopy(el.asset, media);
				made.set(el.asset, copy);
				if (copy) {
					media.addPending(copy);
					pending.push(copy.id);
				}
			}
			if (!this.host.stillHere(doc) || !doc.pages.includes(page)) return;
			const commands: Command[] = [];
			const added = new Set<string>();
			const replaced = new Map<PageElement, PageElement>();
			for (const el of images) {
				const copy = made.get(el.asset);
				if (!copy || !page.elements?.includes(el)) continue;
				if (!added.has(copy.id) && !doc.assets?.[copy.id]) {
					added.add(copy.id);
					commands.push(new AddAsset(copy));
				}
				const next: ImageElement = { ...el, asset: copy.id };
				replaced.set(el, next);
				commands.push(new ReplaceElement(page.id, el, next));
			}
			if (replaced.size === 0) {
				new Notice(t("selection.transparentNone"));
				return;
			}
			if (!this.host.execute(new Batch("Make white transparent", commands))) return;
			this.host.select(sel.pageIndex, sel.strokes, sel.elements.map((e) => replaced.get(e) ?? e));
		} catch (e) {
			console.error("[notebook] white to transparent", e);
			const heic = e instanceof PhotoDecodeError && e.reason === "heic";
			new Notice(heic ? t("scan.heic") : t("selection.transparentFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			for (const id of pending) media.removePending(id);
			this.busy = false;
		}
	}

	/** New asset with the white of `assetId` removed; null when the picture has no white to remove. */
	private async transparentCopy(assetId: string, media: NotebookMedia): Promise<Asset | null> {
		const source = media.asset(assetId);
		const bytes = await media.readAsset(assetId);
		const photo = await decodePhoto(bytes, source?.name ?? "", MAX_TRANSPARENT_SIDE);
		try {
			const { canvas, ctx } = photo;
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
			if (whiteToTransparent(data.data) === 0) return null;
			ctx.putImageData(data, 0, 0);
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw new Error("could not encode PNG");
			const stem = (source?.name ?? "image").replace(/\.[A-Za-z0-9]+$/, "");
			return await storeAsset(this.host.app, this.host.folder(), await blob.arrayBuffer(), `${stem}-transparent.png`, "image");
		} finally {
			photo.canvas.width = 0;
			photo.canvas.height = 0;
		}
	}
}
