// 0.29 calculator (#182): what the advanced calculator remembers, per device. The tape (history), the display preferences and
// the variables per notebook live in Obsidian's per-device local storage, never in the notebook file, the vault or the sync:
// the document format is untouched. Everything read back is validated and bounded; a corrupt value is an empty store.
// Pure apart from the two LocalStore calls at the end (tested with a fake store).
import type { CalcAngle } from "../math/calc";
import { DEFAULT_FORMAT, normaliseFormat, type FormatOptions } from "../math/calc-format";
import type { SavedName } from "../math/calc-state";

export const CALC_STORE_KEY = "notebook-calculator";
/** Lines on the tape. */
export const MAX_TAPE = 100;
/** Notebooks whose variables are remembered (the least recently used are forgotten first). */
export const MAX_BOOKS = 30;
const MAX_TEXT = 400;
const MAX_LATEX = 1500;
const MAX_BOOK_BYTES = 60_000;
const BOOK_ID = /^[A-Za-z0-9_.-]{1,80}$/;

export interface TapeRow {
	/** What was typed. */
	expr: string;
	/** The answer as text. */
	text: string;
	/** `expr = answer` as LaTeX (for the formula element). */
	latex: string;
}

export interface BookVars {
	id: string;
	vars: Record<string, SavedName>;
}

export interface CalcStore {
	angle: CalcAngle;
	format: FormatOptions;
	/** Newest first. */
	tape: TapeRow[];
	/** Most recently used first. */
	books: BookVars[];
}

export const EMPTY_STORE: CalcStore = { angle: "deg", format: DEFAULT_FORMAT, tape: [], books: [] };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function tapeRow(raw: unknown): TapeRow | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const expr = str(o.expr, MAX_TEXT);
	const text = str(o.text, MAX_TEXT);
	if (expr === null || text === null) return null;
	return { expr, text, latex: str(o.latex, MAX_LATEX) ?? "" };
}

/** Whatever was stored, as a valid, bounded store. */
export function normaliseCalcStore(raw: unknown): CalcStore {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_STORE, tape: [], books: [] };
	const o = raw as Record<string, unknown>;
	const tape = (Array.isArray(o.tape) ? o.tape : []).map(tapeRow).filter((r): r is TapeRow => r !== null).slice(0, MAX_TAPE);
	const books: BookVars[] = [];
	for (const b of Array.isArray(o.books) ? o.books : []) {
		if (typeof b !== "object" || b === null) continue;
		const { id, vars } = b as Record<string, unknown>;
		if (typeof id !== "string" || !BOOK_ID.test(id) || books.some((x) => x.id === id)) continue;
		if (typeof vars !== "object" || vars === null || Array.isArray(vars)) continue;
		let size = 0;
		try {
			size = JSON.stringify(vars).length;
		} catch {
			continue;
		}
		if (size > MAX_BOOK_BYTES) continue;
		books.push({ id, vars: vars as Record<string, SavedName> });
		if (books.length >= MAX_BOOKS) break;
	}
	return { angle: o.angle === "rad" ? "rad" : "deg", format: normaliseFormat(o.format), tape, books };
}

/** The tape after one more line (a line equal to the newest one is not repeated). */
export function pushTape(tape: readonly TapeRow[], row: TapeRow): TapeRow[] {
	if (tape[0]?.expr === row.expr && tape[0].text === row.text) return [...tape];
	return [row, ...tape].slice(0, MAX_TAPE);
}

/** The answer of a tape row without its name ("a = 3.2" → "3.2"). */
export function answerOf(row: TapeRow): string {
	const m = /^[\p{L}_][\p{L}\p{N}_]*\s=\s(.+)$/u.exec(row.text);
	return m ? m[1]! : row.text;
}

/** The store with `vars` saved for notebook `id` (an empty set forgets the notebook). */
export function withBook(store: CalcStore, id: string | null, vars: Record<string, SavedName>): CalcStore {
	if (id === null || !BOOK_ID.test(id)) return store;
	const rest = store.books.filter((b) => b.id !== id);
	const books = Object.keys(vars).length > 0 ? [{ id, vars }, ...rest] : rest;
	return { ...store, books: books.slice(0, MAX_BOOKS) };
}

export function booksVars(store: CalcStore, id: string | null): Record<string, SavedName> | null {
	return id === null ? null : store.books.find((b) => b.id === id)?.vars ?? null;
}

// ------------------------------------------------------------------------------------------------------ local storage

/** The part of Obsidian's App that holds per-device values. */
export interface CalcLocalStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export function loadCalcStore(app: CalcLocalStore): CalcStore {
	try {
		return normaliseCalcStore(app.loadLocalStorage(CALC_STORE_KEY));
	} catch {
		return normaliseCalcStore(null);
	}
}

export function saveCalcStore(app: CalcLocalStore, store: CalcStore): void {
	try {
		app.saveLocalStorage(CALC_STORE_KEY, normaliseCalcStore(store));
	} catch (e) {
		console.error("[notebook] could not store the calculator history", e);
	}
}
