/**
 * The Board view's columns and how notebooks fall into them (0.15, roadmap #161). Pure: no 'obsidian', no DOM.
 *
 * The columns are a setting (`boardColumns`): an id (what the synced statuses store, see board-state.ts), a name and a
 * colour. A column with an empty name shows the translated default name of its built-in id (To do, In progress, Done, To
 * print), so the defaults follow the UI language until the user renames them. A notebook with no status, or with the status
 * of a column that was removed, is shown in the first column (nothing is lost: the status stays stored, and a column added
 * back with the same id takes its notebooks back).
 */
import type { MessageKey } from "../i18n/en";

export interface BoardColumn {
	/** Stable id the statuses are stored under. */
	id: string;
	/** The name the user gave; empty = the translated default of a built-in column. */
	name: string;
	/** `#rrggbb` */
	color: string;
}

export interface BoardSettings {
	boardColumns: BoardColumn[];
}

export const BUILTIN_COLUMN_IDS = ["todo", "doing", "done", "print"] as const;

/** Translation keys of the built-in columns' names. */
export const BUILTIN_COLUMN_NAME: Record<string, MessageKey> = {
	todo: "board.col.todo",
	doing: "board.col.doing",
	done: "board.col.done",
	print: "board.col.print",
};

export const DEFAULT_BOARD_COLUMNS: readonly BoardColumn[] = [
	{ id: "todo", name: "", color: "#6366F1" },
	{ id: "doing", name: "", color: "#F59E0B" },
	{ id: "done", name: "", color: "#22C55E" },
	{ id: "print", name: "", color: "#EC4899" },
];

export const DEFAULT_BOARD_SETTINGS: BoardSettings = { boardColumns: DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c })) };

/** Most columns a board can have (more would not fit a screen; the rest of the UI assumes a handful). */
export const BOARD_COLUMNS_MAX = 8;
export const COLUMN_NAME_MAX = 40;

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Colours offered to new columns, in turn (the subject palette's bases). */
const NEW_COLUMN_COLORS = ["#2F80F7", "#8B5CF6", "#16C2A3", "#F0565E", "#F59E0B", "#EC4899", "#6366F1", "#22C55E"];

/** Columns from saved data: wrong entries are dropped, ids made unique; nothing valid left gives the defaults. */
export function normaliseColumns(raw: unknown): BoardColumn[] {
	if (!Array.isArray(raw)) return DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c }));
	const out: BoardColumn[] = [];
	const seen = new Set<string>();
	for (const v of raw) {
		if (out.length >= BOARD_COLUMNS_MAX) break;
		if (typeof v !== "object" || v === null) continue;
		const o = v as Record<string, unknown>;
		if (typeof o.id !== "string" || !ID.test(o.id) || seen.has(o.id)) continue;
		seen.add(o.id);
		const name = typeof o.name === "string" ? o.name.trim().slice(0, COLUMN_NAME_MAX) : "";
		const color = typeof o.color === "string" && HEX.test(o.color) ? o.color.toUpperCase() : NEW_COLUMN_COLORS[out.length % NEW_COLUMN_COLORS.length]!;
		out.push({ id: o.id, name, color });
	}
	return out.length > 0 ? out : DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c }));
}

export function readBoardSettings(d: Record<string, unknown>): BoardSettings {
	return { boardColumns: normaliseColumns(d.boardColumns) };
}

/** The name a column shows: the user's, else the translated default of a built-in id, else "Column". */
export function columnLabel(col: BoardColumn, tr: (key: MessageKey) => string): string {
	if (col.name) return col.name;
	const key = BUILTIN_COLUMN_NAME[col.id];
	return key ? tr(key) : tr("board.col.new");
}

/** An id not used by `columns`, for a new column. */
export function newColumnId(columns: readonly BoardColumn[], rand: () => number = Math.random): string {
	const used = new Set(columns.map((c) => c.id));
	for (let i = 0; i < 50; i++) {
		const id = `c${Math.floor(rand() * 36 ** 5).toString(36).padStart(5, "0")}`;
		if (!used.has(id)) return id;
	}
	return `c${used.size + 1}x`;
}

/** The colour a new column starts with. */
export function nextColumnColor(columns: readonly BoardColumn[]): string {
	return NEW_COLUMN_COLORS[columns.length % NEW_COLUMN_COLORS.length]!;
}

/** The index of the column a status belongs to: the first column for none or for the status of a column that is gone. */
export function columnIndex(columns: readonly BoardColumn[], status: string | null): number {
	if (status === null) return 0;
	const i = columns.findIndex((c) => c.id === status);
	return i < 0 ? 0 : i;
}

export interface BoardGroup<E> {
	column: BoardColumn;
	entries: E[];
}

/** Puts `entries` (in the order given) into the columns by their status. */
export function groupByStatus<E>(entries: readonly E[], columns: readonly BoardColumn[], statusOf: (e: E) => string | null): Array<BoardGroup<E>> {
	const groups: Array<BoardGroup<E>> = columns.map((column) => ({ column, entries: [] }));
	if (groups.length === 0) return groups;
	for (const e of entries) groups[columnIndex(columns, statusOf(e))]!.entries.push(e);
	return groups;
}

/** Whether moving a notebook shown in `current` to column `target` would change anything. */
export function isMove(columns: readonly BoardColumn[], status: string | null, target: string): boolean {
	return columns[columnIndex(columns, status)]?.id !== target;
}
