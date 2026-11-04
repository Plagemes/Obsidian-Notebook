/**
 * 0.15 views: the library's Board (statuses) and Calendar (what was written on each day) in the browser harness
 * (doc=library&surface=library). `checkViews()` gives the host an in-memory board store and columns, switches the view from
 * the header's Views menu, and checks the Board (columns, cards, no sideways page scroll, 40 px targets, moving with the
 * ⋯ menu, dragging with mouse, pen and touch, a status written by another device, the columns editor) and the Calendar
 * (month grid on a tablet, week strip and agenda on a phone, a day's notebooks, opening a notebook at its page). It leaves
 * the screen as it found it. `viewsState()` sets the views up for review screenshots.
 */
import type { LibraryHarness } from "./library-check";
import { obsidianStyledButtons } from "./library-check";
import { t } from "../../src/i18n";
import { BoardStateStore } from "../../src/library/board-state-store";
import { DEFAULT_BOARD_COLUMNS, type BoardColumn } from "../../src/library/board-logic";
import { onBoardColumnsChanged, emitBoardColumnsChanged } from "../../src/library/board-events";
import { BoardColumnsModal } from "../../src/view/board-columns-modal";
import type { DeviceFileAdapter } from "../../src/storage/device-files";

type Result = { name: string; ok: boolean; detail: string };
type MenuApi = { titles: string[]; run: (title: string) => void };

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

const ROOT = "Notebooks";
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};
const app = () => document.querySelector<HTMLElement>(".nb-app")!;
const q = <T extends HTMLElement = HTMLElement>(sel: string) => app().querySelector<T>(sel);
const all = (sel: string) => Array.from(app().querySelectorAll<HTMLElement>(sel));
const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();

function visible(el: Element): el is HTMLElement {
	const h = el as HTMLElement;
	if (!h.offsetParent && getComputedStyle(h).position !== "fixed") return false;
	const r = h.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

async function menuOf(button: Element | null): Promise<MenuApi | null> {
	const w = window as unknown as { harnessMenu?: MenuApi };
	w.harnessMenu = undefined;
	click(button);
	await frames(1);
	return w.harnessMenu ?? null;
}

interface Setup {
	adapter: MemoryAdapter;
	store: BoardStateStore;
	columns: BoardColumn[];
}
let setup: Setup | null = null;
let unsubscribe: (() => void) | null = null;
let editor: BoardColumnsModal | null = null;

/** The board store and columns the real plugin's host provides, on an in-memory file. */
function install(h: LibraryHarness): Setup {
	if (setup) return setup;
	const adapter = new MemoryAdapter();
	const store = new BoardStateStore(adapter, () => ROOT, "0a1b2c3d");
	const s: Setup = { adapter, store, columns: DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c })) };
	h.host.board = store;
	h.host.boardColumns = () => s.columns;
	h.host.editBoardColumns = () => {
		h.calls.push("edit-columns");
		editor = new BoardColumnsModal({
			app: (h.view as unknown as { app: ConstructorParameters<typeof BoardColumnsModal>[0]["app"] }).app,
			get: () => s.columns,
			set: async (cols) => void (s.columns = cols.map((c) => ({ ...c }))),
		});
		editor.open();
	};
	unsubscribe = onBoardColumnsChanged(() => undefined);
	setup = s;
	return s;
}

async function chooseView(title: string): Promise<boolean> {
	const m = await menuOf(q(".nb-views-btn"));
	if (!m || !m.titles.includes(title)) return false;
	m.run(title);
	await frames(3);
	await wait(120);
	return true;
}

export async function viewsState(h: LibraryHarness, state: string): Promise<boolean> {
	install(h);
	if (state === "board") return chooseView(t("views.board"));
	if (state === "calendar") return chooseView(t("views.calendar"));
	if (state === "board-editor") {
		await chooseView(t("views.board"));
		click(q('[data-key="board:edit-columns"]'));
		await frames(3);
		await wait(300);
		return true;
	}
	if (state === "reset") {
		editor?.close();
		editor = null;
		await frames(2);
		return chooseView(t("views.cards"));
	}
	return false;
}

function pointer(type: string, init: PointerEventInit): PointerEvent {
	return new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...init });
}

/** A press on `from`, a move to the middle of `to` and a release, as `pointerType` makes them (touch holds first). */
async function dragTo(from: HTMLElement, to: HTMLElement, pointerType: "mouse" | "pen" | "touch", id: number): Promise<void> {
	const a = from.getBoundingClientRect();
	const b = to.getBoundingClientRect();
	const x0 = a.left + 24, y0 = a.top + a.height / 2;
	const x1 = b.left + b.width / 2, y1 = b.top + Math.min(b.height / 2, 60);
	from.dispatchEvent(pointer("pointerdown", { pointerId: id, pointerType, clientX: x0, clientY: y0, button: 0, buttons: 1 }));
	if (pointerType === "touch") await wait(520);
	document.dispatchEvent(pointer("pointermove", { pointerId: id, pointerType, clientX: x0 + 10, clientY: y0 + 2, buttons: 1 }));
	await frames(1);
	document.dispatchEvent(pointer("pointermove", { pointerId: id, pointerType, clientX: x1, clientY: y1, buttons: 1 }));
	await frames(1);
	document.dispatchEvent(pointer("pointerup", { pointerId: id, pointerType, clientX: x1, clientY: y1, buttons: 0 }));
	await frames(3);
	await wait(150);
}

const card = (title: string) => all(".nb-board-card").find((c) => c.querySelector(".nb-board-card-title")?.textContent === title);
const columnOf = (title: string) => card(title)?.closest<HTMLElement>("[data-drop-column]")?.getAttribute("data-drop-column") ?? null;
/** The element a card is dropped on to reach column `id`: the column, or on a phone its tab. */
const dropOn = (id: string) => q(app().classList.contains("is-phone") ? `.nb-board-tab[data-drop-column="${id}"]` : `.nb-board-col[data-drop-column="${id}"]`)!;

export async function checkViews(h: LibraryHarness, surface: string): Promise<Result[]> {
	const out: Result[] = [];
	if (surface !== "library") return out;
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `views ${window.innerWidth}px: ${name}`, ok, detail });
	const s = install(h);
	const phone = app().classList.contains("is-phone");
	const scroll = q(".nb-scroll")!;

	// ---------------------------------------------------------------- the Views menu
	const menu = await menuOf(q(".nb-views-btn"));
	add("the header has a Views menu with Cards, Board and Calendar", !!menu && [t("views.cards"), t("views.board"), t("views.calendar")].every((x) => menu.titles.includes(x)), menu?.titles.join(" | ") ?? "no menu");
	add("the Views button is a labelled 40 px target", (q(".nb-views-btn")?.getBoundingClientRect().height ?? 0) >= 40 && !!q(".nb-views-btn")?.getAttribute("aria-label"));

	// ---------------------------------------------------------------- Board
	add("the Board opens from the menu", await chooseView(t("views.board")));
	const cols = all(".nb-board-col");
	add(phone ? "a phone shows one column under four tabs" : "the Board has the four default columns", phone ? cols.length === 1 && all(".nb-board-tab").length === 4 : cols.length === 4, `${cols.length} columns`);
	add("the columns are named To do, In progress, Done, To print", all(phone ? ".nb-board-tab-label" : ".nb-board-col-title").map((x) => x.textContent).join("|") === [t("board.col.todo"), t("board.col.doing"), t("board.col.done"), t("board.col.print")].join("|"), all(".nb-board-col-title").map((x) => x.textContent).join("|"));
	const notebooks = 12;
	const total = all(phone ? ".nb-board-tab .nb-board-count" : ".nb-board-col-head .nb-board-count").reduce((n, c) => n + Number(c.textContent), 0);
	add("every notebook is in a column (the first one without a status)", total === notebooks && (phone || all(".nb-board-card").length === notebooks), `${total} counted, ${all(".nb-board-card").length} cards`);
	if (!phone) add("no status yet: all the notebooks are in To do", columnOf("Trasformata di Fourier") === "todo", String(columnOf("Trasformata di Fourier")));
	add("the page does not scroll sideways", scroll.scrollWidth <= scroll.clientWidth + 1, `${scroll.scrollWidth} / ${scroll.clientWidth}`);
	const more = all(".nb-board-more").filter(visible);
	add("every card has a labelled ⋯ target of at least 40 px", more.length > 0 && more.every((b) => b.getBoundingClientRect().width >= 40 && b.getBoundingClientRect().height >= 40 && !!b.getAttribute("aria-label")), `${more.length}`);
	add("no button falls back to Obsidian's default look", obsidianStyledButtons(app()).length === 0, obsidianStyledButtons(app()).slice(0, 3).map((x) => x.className).join());
	add("cards are focusable controls with a name", all(".nb-board-card-main").every((c) => c.getAttribute("role") === "button" && c.tabIndex === 0 && !!c.getAttribute("aria-label")));

	// Moving with the menu (no dragging needed).
	if (phone) click(q('.nb-board-tab[data-key="board:tab:todo"]'));
	await frames(2);
	const first = all(".nb-board-card").find(visible)!;
	const firstTitle = first.querySelector(".nb-board-card-title")?.textContent ?? "";
	const m1 = await menuOf(first.querySelector(".nb-board-more"));
	add("⋯ opens Move to… with the four columns, the current one checked", !!m1 && m1.titles.join("|") === [t("board.col.todo"), t("board.col.doing"), t("board.col.done"), t("board.col.print")].join("|"), m1?.titles.join("|") ?? "no menu");
	m1?.run(t("board.col.done"));
	await frames(3);
	await wait(200);
	const status = [...s.store.snapshot().values()].map((x) => x.status);
	add("the move is written to this device's board file", status.includes("done") && [...s.adapter.files.keys()].some((k) => k.endsWith("_meta/board-0a1b2c3d.json")), status.join());
	if (phone) click(q('.nb-board-tab[data-key="board:tab:done"]'));
	await frames(2);
	add("the card is now in Done", columnOf(firstTitle) === "done", String(columnOf(firstTitle)));

	// Dragging, with each kind of pointer.
	const kinds = ["mouse", "pen", "touch"] as const;
	const targets = ["doing", "print", "doing"] as const;
	for (let i = 0; i < kinds.length; i++) {
		if (phone) click(q('.nb-board-tab[data-key="board:tab:todo"]'));
		await frames(2);
		const c = all(".nb-board-card").find((x) => visible(x) && x.querySelector(".nb-board-card-title")?.textContent !== firstTitle);
		const title = c?.querySelector(".nb-board-card-title")?.textContent ?? "";
		const main = c?.querySelector<HTMLElement>(".nb-board-card-main");
		if (!c || !main) {
			add(`a ${kinds[i]} drag: a card to drag`, false);
			continue;
		}
		await dragTo(main, dropOn(targets[i]!), kinds[i]!, 10 + i);
		if (phone) click(q(`.nb-board-tab[data-key="board:tab:${targets[i]}"]`));
		await frames(2);
		add(`dragging a card with a ${kinds[i]} moves it to ${targets[i]}`, columnOf(title) === targets[i], `${title}: ${columnOf(title)}`);
	}
	add("the ghost of a drag does not stay on the screen", document.querySelectorAll(".notebook-lib-ghost").length === 0);

	// Another device moves a notebook: its file is read and merged (last writer wins).
	const mover = s.store.snapshot();
	const otherKey = [...mover.keys()][0]!;
	const stamp = (mover.get(otherKey)?.at ?? 0) + 10_000;
	s.adapter.files.set(`${ROOT}/_meta/board-0b000000.json`, `{"format":"obsidian-notebook-board","version":1,"device":"0b000000","items":[{"key":${JSON.stringify(otherKey)},"status":{"v":"print","at":${stamp}}}]}\n`);
	await s.store.load();
	await frames(3);
	await wait(200);
	add("a status written later by another device wins", s.store.snapshot().get(otherKey)?.status === "print", String(s.store.snapshot().get(otherKey)?.status));
	s.adapter.files.delete(`${ROOT}/_meta/board-0b000000.json`);
	add("the other device's file is never written by this one", ![...s.adapter.files.entries()].some(([k, v]) => k.endsWith("board-0a1b2c3d.json") && v.includes("0b000000")));

	// The columns editor: add, rename, recolour, remove.
	click(q('[data-key="board:edit-columns"]'));
	await frames(3);
	await wait(250);
	const modal = document.querySelector<HTMLElement>(".nb-board-editor");
	add("Edit columns opens the editor with a row per column", !!modal && modal.querySelectorAll(".nb-colrow").length === 4, String(modal?.querySelectorAll(".nb-colrow").length));
	if (modal) {
		const buttons = Array.from(modal.querySelectorAll<HTMLElement>(".nb-modal-btn"));
		click(buttons.find((b) => b.textContent === t("board.editor.add")));
		await frames(2);
		await wait(150);
		add("Add column adds a column that is saved at once", s.columns.length === 5 && modal.querySelectorAll(".nb-colrow").length === 5, String(s.columns.length));
		const name = modal.querySelector<HTMLInputElement>('.nb-colrow:last-child .nb-colrow-name');
		if (name) {
			name.value = "Review";
			name.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await frames(2);
		await wait(150);
		add("a column can be renamed", s.columns[4]?.name === "Review", s.columns.map((c) => c.name).join("|"));
		click(modal.querySelector<HTMLElement>('.nb-colrow:last-child .nb-colrow-swatch:not(.is-on)'));
		await frames(2);
		add("a column can be recoloured", /^#[0-9A-F]{6}$/.test(s.columns[4]?.color ?? ""), s.columns[4]?.color ?? "");
		await wait(150);
		emitBoardColumnsChanged();
		await frames(3);
		await wait(150);
		add("the Board shows the new column", phone ? all(".nb-board-tab").length === 5 : all(".nb-board-col").length === 5, String(all(".nb-board-col").length));
		click(modal.querySelector<HTMLElement>('.nb-colrow:last-child .nb-icon-btn[aria-label="' + t("board.editor.remove") + '"]'));
		await frames(2);
		await wait(150);
		add("Remove column takes it away and deletes no notebook", s.columns.length === 4 && s.columns.every((c) => c.id !== "") , String(s.columns.length));
		click(buttons.find((b) => b.textContent === t("board.editor.close")));
		await frames(2);
	}
	emitBoardColumnsChanged();
	await frames(3);

	// ---------------------------------------------------------------- Calendar
	add("the Calendar opens from the menu", await chooseView(t("views.calendar")));
	const reached = async (): Promise<HTMLElement | null> => {
		for (let i = 0; i < 6; i++) {
			const day = all(".nb-cal-cell.has-data").find(visible);
			if (day) return day;
			click(q('[data-key="cal:prev"]'));
			await frames(3);
		}
		return null;
	};
	add("the Calendar names the month (or the week on a phone)", (q(".nb-cal-title")?.textContent ?? "").length > 3, q(".nb-cal-title")?.textContent ?? "");
	if (phone) {
		add("a phone shows a week strip of seven days and an agenda", all(".nb-cal-strip .nb-cal-cell").length === 7 && !!q(".nb-cal-agenda"), `${all(".nb-cal-strip .nb-cal-cell").length}`);
	} else {
		const cells = all(".nb-cal-month .nb-cal-cell");
		add("a tablet shows a month grid of whole weeks", cells.length >= 28 && cells.length % 7 === 0, String(cells.length));
		add("the first column is the first day of the week (the weekday headers match)", all(".nb-cal-weekday").length === 7);
	}
	const today = q(".nb-cal-cell.is-today");
	add("today is marked", !!today, "");
	add("the page does not scroll sideways", scroll.scrollWidth <= scroll.clientWidth + 1, `${scroll.scrollWidth} / ${scroll.clientWidth}`);
	const dayCell = await reached();
	add("days with writing are marked with the colours of their notebooks", !!dayCell && dayCell.querySelectorAll(".nb-cal-dot").length > 0, "");
	add("every day is a labelled 40 px target", all(".nb-cal-cell").filter(visible).every((c) => c.getBoundingClientRect().height >= 40 && !!c.getAttribute("aria-label")));
	if (dayCell) {
		click(dayCell);
		await frames(3);
		await wait(150);
		const items = all(".nb-cal-item").filter(visible);
		add("tapping a day lists its notebooks", items.length > 0 && !!q(".nb-cal-day-title"), `${items.length}`);
		add("the day says how many notebooks and pages", /\d/.test(q(".nb-cal-day-sum")?.textContent ?? ""), q(".nb-cal-day-sum")?.textContent ?? "");
		const before = h.calls.length;
		const chip = all(".nb-cal-page").find(visible);
		click(chip ?? items[0]?.querySelector(".nb-cal-item-main"));
		await frames(3);
		await wait(250);
		const opened = h.calls.slice(before).find((c) => c.startsWith("open:"));
		add("a page chip (or the notebook) opens the notebook at that page", !!opened && (!chip || /#\d+$/.test(opened)), opened ?? h.calls.slice(before).join());
	}
	add("no button falls back to Obsidian's default look", obsidianStyledButtons(app()).length === 0, obsidianStyledButtons(app()).slice(0, 3).map((x) => x.className).join());
	click(q('[data-key="cal:today"]'));
	await frames(2);
	add("Today brings the calendar back to today", !!q(".nb-cal-cell.is-today.is-selected"), "");

	// Back to the cards.
	add("Cards brings the grid back", await chooseView(t("views.cards")) && all(".notebook-lib-card").length > 0, String(all(".notebook-lib-card").length));
	void unsubscribe;
	return out;
}
