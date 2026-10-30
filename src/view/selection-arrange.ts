import { Menu, type App } from "obsidian";
import { t } from "../i18n";
import { alignItems, alignPlacement, distributePlacement, type AlignMode, type DistributeAxis } from "../ink/align";
import { measureText } from "../ink/renderer";
import {
	applyPlacement, inkOwnership, itemsBounds, mirrorKeepsOrientation, mirrorPlacement, NO_OWNERSHIP, rotate90Matrix, sizeMatrix, uniformPlacement,
	type InkOwnership, type MirrorAxis, type Placement,
} from "../ink/selection-transform";
import { selectByStyle, selectSimilar, styleCatalog, type StyleChoice } from "../ink/select-similar";
import type { Command } from "../model/history";
import type { NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import { actionById } from "../ui/actions";
import { actionLabel } from "../ui/action-sheet";
import { ResizeModal, StyleModal } from "./arrange-modals";
import { showNotice } from "./notice";
import type { SelectionState } from "./selection-actions";

/** The part of the notebook view that arranging a selection needs. */
export interface ArrangeHost {
	app: App;
	doc(): NotebookDocument | null;
	editable(): boolean;
	selection(): SelectionState | null;
	/** Selects exactly these items of the page (switching to the lasso). */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	/** Runs the command as one undo step and refreshes everything that depends on the document. */
	execute(cmd: Command): void;
	/** The ink of the page the reader can see (hidden ink only while the solutions are shown): the same set the lasso picks from. */
	ink(page: Page): readonly Stroke[];
	/** Setting "Ink follows objects": ink written on a picture or a text box is arranged with it. */
	inkFollowsObjects(): boolean;
	/** Page in view. */
	currentPage(): number;
	/** Where the control of action `id` is on screen (client px), or null. */
	anchor(id: string): { x: number; y: number } | null;
	/** Runs an action of the registry (counted as a use). */
	run(id: string): void;
	/** Ends a text edit in progress before the document changes. */
	commitText(): void;
}

interface Current {
	sel: SelectionState;
	page: Page;
	strokes: Stroke[];
	elements: PageElement[];
}

/**
 * Wave 0.10 selection tools: align and distribute (38), rectangle mode is the view's, select by colour or tool (64), rotate by 90
 * degrees, mirror and exact size (65). The geometry is in ink/align.ts, ink/selection-transform.ts and ink/select-similar.ts
 * (pure, tested); this only finds the selection, asks for a number or a choice where needed, and runs one command per
 * operation, so each is one undo step. The selection stays on the transformed objects.
 */
export class SelectionArrange {
	constructor(private readonly host: ArrangeHost) {}

	// --- the selection ---

	/** The selection with only what is still on its page; null without an editable one. */
	private current(): Current | null {
		const sel = this.host.selection();
		const page = sel && this.host.doc()?.pages[sel.pageIndex];
		if (!sel || !page || !this.host.editable()) return null;
		const onPage = new Set(page.strokes);
		const onPageEls = new Set(page.elements ?? []);
		const strokes = sel.strokes.filter((s) => onPage.has(s));
		const elements = sel.elements.filter((e) => onPageEls.has(e));
		return strokes.length + elements.length > 0 ? { sel, page, strokes, elements } : null;
	}

	private ownership(page: Page, strokes: readonly Stroke[], elements: readonly PageElement[]): InkOwnership {
		return this.host.inkFollowsObjects() ? inkOwnership(page, strokes, elements, measureText) : NO_OWNERSHIP;
	}

	/** Runs a placement as one undo step and keeps the selection on the moved objects. Returns false when nothing changed. */
	private run(cur: Current, placement: Placement | null, label: string): boolean {
		if (!placement) return false;
		const plan = applyPlacement(cur.page, cur.strokes, cur.elements, placement, measureText, label);
		if (!plan) return false;
		this.host.commitText();
		this.host.execute(plan.command);
		this.host.select(cur.sel.pageIndex, plan.strokes, plan.elements);
		return true;
	}

	// --- align and distribute (38) ---

	align(mode: AlignMode): void {
		const cur = this.current();
		if (!cur) return;
		const items = alignItems(cur.strokes, cur.elements, this.ownership(cur.page, cur.strokes, cur.elements), measureText);
		if (items.length < 2) {
			showNotice(t("arrange.needTwo"));
			return;
		}
		if (!this.run(cur, alignPlacement(items, mode), "Align selection")) showNotice(t("arrange.nothing"));
	}

	distribute(axis: DistributeAxis): void {
		const cur = this.current();
		if (!cur) return;
		const items = alignItems(cur.strokes, cur.elements, this.ownership(cur.page, cur.strokes, cur.elements), measureText);
		if (items.length < 3) {
			showNotice(t("arrange.needThree"));
			return;
		}
		if (!this.run(cur, distributePlacement(items, axis), "Distribute selection")) showNotice(t("arrange.nothing"));
	}

	// --- rotate, mirror, size (65) ---

	rotate(clockwise: boolean): void {
		const cur = this.current();
		const bounds = cur && itemsBounds(cur.strokes, cur.elements, measureText);
		if (!cur || !bounds) return;
		const followers = this.ownership(cur.page, cur.strokes, cur.elements).followers;
		this.run(cur, uniformPlacement(cur.strokes, cur.elements, followers, rotate90Matrix(bounds, clockwise)), "Rotate selection");
	}

	mirror(axis: MirrorAxis): void {
		const cur = this.current();
		const bounds = cur && itemsBounds(cur.strokes, cur.elements, measureText);
		if (!cur || !bounds) return;
		const own = this.ownership(cur.page, cur.strokes, cur.elements);
		if (!this.run(cur, mirrorPlacement(cur.strokes, cur.elements, bounds, axis, own, measureText), "Mirror selection")) {
			showNotice(t("transform.nothing"));
			return;
		}
		if (cur.elements.some(mirrorKeepsOrientation)) showNotice(t("transform.mirrorNote"));
	}

	/** Opens the size panel with the current size of the selection. */
	resize(): void {
		const cur = this.current();
		const bounds = cur && itemsBounds(cur.strokes, cur.elements, measureText);
		if (!cur || !bounds) return;
		const current = { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
		new ResizeModal(this.host.app, current, (size) => this.applySize(cur.sel, size)).open();
	}

	private applySize(selection: SelectionState, size: { width: number; height: number }): void {
		// The panel was open while the page could change: take the selection again.
		const cur = this.current();
		if (!cur || cur.sel !== selection) return;
		const m = sizeMatrix(cur.strokes, cur.elements, size.width, size.height, measureText);
		if (!m) {
			showNotice(t("resize.invalid"));
			return;
		}
		const followers = this.ownership(cur.page, cur.strokes, cur.elements).followers;
		if (!this.run(cur, uniformPlacement(cur.strokes, cur.elements, followers, m), "Resize selection")) showNotice(t("transform.nothing"));
	}

	// --- select similar and select by colour or tool (64) ---

	/** The page the choice is made on: the selection's, else the page in view. */
	private pageForStyle(): { pageIndex: number; page: Page } | null {
		const doc = this.host.doc();
		const pageIndex = this.host.selection()?.pageIndex ?? this.host.currentPage();
		const page = doc?.pages[pageIndex];
		return page ? { pageIndex, page } : null;
	}

	private show(pageIndex: number, found: { strokes: Stroke[]; elements: PageElement[] }): void {
		const n = found.strokes.length + found.elements.length;
		if (n === 0) {
			showNotice(t("select.nothingSimilar"));
			return;
		}
		this.host.commitText();
		this.host.select(pageIndex, found.strokes, found.elements);
		showNotice(t("select.found", { n: String(n) }));
	}

	similar(by: "colour" | "tool"): void {
		const sel = this.host.selection();
		const at = this.pageForStyle();
		if (!sel || !at || !this.host.editable()) return;
		const onPage = new Set(at.page.strokes);
		const seed = { strokes: sel.strokes.filter((s) => onPage.has(s)), elements: sel.elements };
		if (seed.strokes.length === 0) return;
		this.show(at.pageIndex, selectSimilar(this.host.ink(at.page), at.page.elements ?? [], seed, by));
	}

	/** Opens the picker of the tools and colours used on the page. */
	pickStyle(): void {
		const at = this.pageForStyle();
		if (!at || !this.host.editable()) return;
		const ink = this.host.ink(at.page);
		const elements = at.page.elements ?? [];
		new StyleModal(this.host.app, styleCatalog(ink, elements), (choice: StyleChoice) => {
			const again = this.pageForStyle();
			if (!again || again.page !== at.page || !this.host.editable()) return;
			this.show(again.pageIndex, selectByStyle(this.host.ink(again.page), again.page.elements ?? [], choice));
		}).open();
	}

	// --- menus on the second row of the selection bar ---

	/** The little menus behind the bar's Select similar, Align and Transform buttons; each entry is an action of the registry. */
	menu(kind: "similar" | "align" | "transform"): void {
		const sel = this.host.selection();
		if (!sel || !this.host.editable()) return;
		const count = sel.strokes.length + sel.elements.length;
		const menu = new Menu();
		const add = (id: string, enabled = true): void => {
			const a = actionById(id);
			if (!a) return;
			menu.addItem((item) => item.setTitle(actionLabel(a)).setIcon(a.icon).setDisabled(!enabled).onClick(() => this.host.run(id)));
		};
		if (kind === "similar") {
			add("select-same-colour");
			add("select-same-tool");
			menu.addSeparator();
			menu.addItem((item) => item.setTitle(t("select.pick")).setIcon("palette").onClick(() => this.host.run("select-by-style")));
		} else if (kind === "align") {
			for (const mode of ["left", "centre", "right", "top", "middle", "bottom"]) add(`selection-align-${mode}`, count >= 2);
			menu.addSeparator();
			add("selection-distribute-h", count >= 3);
			add("selection-distribute-v", count >= 3);
		} else {
			add("selection-rotate-cw");
			add("selection-rotate-ccw");
			add("selection-mirror-h");
			add("selection-mirror-v");
			menu.addSeparator();
			add("selection-resize");
		}
		const at = this.host.anchor(kind === "similar" ? "selection-similar" : kind === "align" ? "selection-align-menu" : "selection-transform-menu");
		menu.showAtPosition(at ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 });
	}
}
