/**
 * The Board view of the library (0.15, roadmap #161): one column per status, a card per notebook. Drawn from the data the
 * library view gives it (`BoardDeps`): it reads nothing and writes nothing itself.
 *
 * - Moving: drag a card onto a column (mouse, pen, touch: a long press lifts the card, the same press handling as the grid,
 *   drag.ts), or ⋯ › Move to… (also the card's context menu): the way that needs no dragging.
 * - Wide and medium: all the columns side by side, scrolling sideways when they do not fit; dragging near an edge scrolls.
 * - Phone: one column at a time under a strip of column tabs (each tab is a drop target too), so a card can be dragged
 *   to another column without scrolling.
 */
import { t } from "../i18n";
import { iconButton, pressable, setIconSafe, subjectVars } from "../ui/components/dom";
import { attachPress, DROP_ATTR, DROP_COLUMN_ATTR } from "./drag";
import { isMove, type BoardColumn, type BoardGroup } from "./board-logic";
import type { LibraryEntry } from "./index";

export interface BoardDeps {
	columns: readonly BoardColumn[];
	groups: ReadonlyArray<BoardGroup<LibraryEntry>>;
	phone: boolean;
	/** Phone: the id of the column shown. */
	active: string;
	setActive(id: string): void;
	label(col: BoardColumn): string;
	statusOf(entry: LibraryEntry): string | null;
	/** The line under a card's title (pages, last change). */
	meta(entry: LibraryEntry): string;
	onOpen(entry: LibraryEntry): void;
	/** The context menu (right click, long press without a drag) at a point. */
	onMenu(entry: LibraryEntry, x: number, y: number): void;
	/** The card's ⋯ button: the menu that moves it, anchored on the button. */
	onMoveMenu(entry: LibraryEntry, anchor: HTMLElement): void;
	/** A card was dropped on a column of a different status. */
	onMove(entry: LibraryEntry, columnId: string): void;
	/** A card was dropped on a folder of the sidebar: the notebook is moved there. */
	onDropFolder(entry: LibraryEntry, folder: string): void;
	onEditColumns?(): void;
}

/** Pixels from the edge of the board where a drag scrolls it. */
const EDGE_PX = 56;
const EDGE_STEP = 18;

export function renderBoard(el: HTMLElement, d: BoardDeps): void {
	const root = el.createDiv({ cls: "nb-board-root" });
	const bar = root.createDiv({ cls: "nb-board-bar" });
	bar.createDiv({ cls: "nb-board-hint", text: t(d.phone ? "board.hint.phone" : "board.hint") });
	if (d.onEditColumns) {
		const edit = iconButton(bar, "settings-2", t("board.editColumns"), () => d.onEditColumns?.(), "nb-board-edit");
		edit.dataset.key = "board:edit-columns";
	}
	const active = d.groups.some((g) => g.column.id === d.active) ? d.active : (d.groups[0]?.column.id ?? "");
	let scroller: HTMLElement | null = null;
	const autoScroll = (x: number) => {
		if (!scroller) return;
		const r = scroller.getBoundingClientRect();
		if (x < r.left + EDGE_PX) scroller.scrollLeft -= EDGE_STEP;
		else if (x > r.right - EDGE_PX) scroller.scrollLeft += EDGE_STEP;
	};

	if (d.phone) {
		const tabs = root.createDiv({ cls: "nb-board-tabs", attr: { role: "tablist", "aria-label": t("board.columns") } });
		for (const g of d.groups) {
			const tab = tabs.createEl("button", {
				cls: "nb-board-tab",
				attr: { type: "button", role: "tab", "aria-selected": String(g.column.id === active), [DROP_COLUMN_ATTR]: g.column.id, "data-key": `board:tab:${g.column.id}` },
			});
			subjectVars(tab, g.column.color);
			tab.toggleClass("is-active", g.column.id === active);
			tab.createSpan({ cls: "nb-board-dot", attr: { "aria-hidden": "true" } });
			tab.createSpan({ cls: "nb-board-tab-label", text: d.label(g.column) });
			tab.createSpan({ cls: "nb-board-count", text: String(g.entries.length) });
			tab.addEventListener("click", () => d.setActive(g.column.id));
		}
	}

	const board = root.createDiv({ cls: "nb-board", attr: { role: "group", "aria-label": t("board.columns") } });
	board.toggleClass("is-single", d.phone);
	scroller = board;
	for (const g of d.groups) {
		if (d.phone && g.column.id !== active) continue;
		column(board, g, d, autoScroll);
	}
}

function column(board: HTMLElement, g: BoardGroup<LibraryEntry>, d: BoardDeps, autoScroll: (x: number) => void): void {
	const col = board.createDiv({ cls: "nb-board-col", attr: { role: "group", "aria-label": d.label(g.column), [DROP_COLUMN_ATTR]: g.column.id, "data-key": `board:col:${g.column.id}` } });
	subjectVars(col, g.column.color);
	const head = col.createDiv({ cls: "nb-board-col-head" });
	head.createSpan({ cls: "nb-board-dot", attr: { "aria-hidden": "true" } });
	head.createEl("h3", { cls: "nb-board-col-title", text: d.label(g.column) });
	head.createSpan({ cls: "nb-board-count", text: String(g.entries.length), attr: { "aria-label": t("board.count", { count: String(g.entries.length) }) } });
	const body = col.createDiv({ cls: "nb-board-col-body", attr: { role: "list", "aria-label": d.label(g.column) } });
	if (g.entries.length === 0) body.createDiv({ cls: "nb-board-empty", text: t("board.empty") });
	for (const entry of g.entries) card(body, entry, g.column, d, autoScroll);
}

function card(body: HTMLElement, entry: LibraryEntry, column: BoardColumn, d: BoardDeps, autoScroll: (x: number) => void): void {
	const el = body.createDiv({ cls: "nb-board-card", attr: { role: "listitem" } });
	el.dataset.path = entry.path;
	const main = el.createDiv({ cls: "nb-board-card-main", attr: { "data-key": `bcard:${entry.path}` } });
	pressable(main, () => d.onOpen(entry), [entry.name, d.meta(entry), d.label(column)].filter(Boolean).join(", "));
	const swatch = main.createDiv({ cls: "nb-board-swatch", attr: { "aria-hidden": "true" } });
	swatch.setCssProps({ "--notebook-cover": entry.cover });
	const text = main.createDiv({ cls: "nb-board-card-text" });
	text.createDiv({ cls: "nb-board-card-title", text: entry.name, attr: { title: entry.name } });
	const meta = d.meta(entry);
	if (meta) text.createDiv({ cls: "nb-board-card-meta", text: meta });
	if (entry.tags.length > 0) text.createDiv({ cls: "nb-board-card-tags", text: entry.tags.slice(0, 3).map((x) => `#${x}`).join(" ") });

	const more = el.createEl("button", { cls: "nb-board-more nb-icon-btn", attr: { type: "button", "aria-label": t("board.moveTo.aria", { name: entry.name }), title: t("board.moveTo"), "data-key": `bmore:${entry.path}` } });
	setIconSafe(more, "more-vertical");
	more.addEventListener("click", (e) => {
		e.stopPropagation();
		d.onMoveMenu(entry, more);
	});

	attachPress({
		el: main,
		onMenu: (x, y) => d.onMenu(entry, x, y),
		startDrag: () => createDiv({ cls: "notebook-lib-ghost", text: entry.name }),
		canDrop: (target) => {
			const col = target.getAttribute(DROP_COLUMN_ATTR);
			if (col !== null) return isMove(d.columns, d.statusOf(entry), col);
			const folder = target.getAttribute(DROP_ATTR);
			return folder !== null && folder !== entry.folder;
		},
		onDrop: (target) => {
			const col = target.getAttribute(DROP_COLUMN_ATTR);
			if (col !== null) {
				d.onMove(entry, col);
				return;
			}
			const folder = target.getAttribute(DROP_ATTR);
			if (folder !== null) d.onDropFolder(entry, folder);
		},
		onDragMove: (x) => autoScroll(x),
	});
}
