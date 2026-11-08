// 0.26 redact (#285): the redaction boxes of a notebook, kept on THIS device only. Obsidian's per-device local storage, never the notebook
// file, never the vault, never synced or sent anywhere, and bounded (notebooks, pages and boxes have limits). The document format is untouched.
//
// Review fixes (P4, R3): the store FAILS CLOSED.
// - What this session set is also held in memory (per app), and that copy wins: boxes drawn while the device cannot store them still
//   cover every export until Obsidian closes, and the caller is told that they were not stored (`saveRedactState` returns it).
// - Every save is read back; a save that does not read back the same is reported as not stored.
// - A stored value this version cannot read (corrupt, of another shape such as a future version's, or missing although a sentinel says it
//   was written) is never read as "no boxes" and never overwritten silently: it is copied once to a separate, bounded key
//   (`REDACT_QUARANTINE_KEY`), and while that copy exists EVERY notebook reads as `unreadable` (its exports are refused) until the reader,
//   in the Redact dialog, saves that notebook's boxes again (an explicit save may then start a fresh store; a notebook saved with no boxes
//   is kept as an explicit "none") or resets the redaction storage (`resetRedactStorage`, after a confirmation).
// - One entry that cannot be read (also one whose set loses a page or a box when it is read: this store writes its sets already
//   normalised) makes that notebook unreadable, is kept as it is by later saves of other notebooks, and is copied aside before a save of
//   its own notebook replaces it (T5). Each distinct unreadable value gets its own bounded copy (at most `QUARANTINE_MAX_COPIES`); when
//   no copy can be made nothing is overwritten (T6).
// - A very first save whose value cannot be written (a full quota) takes back the sentinel, so other notebooks are not refused (T9).
// - A notebook whose switch is on is never forgotten to make room: only switched-off notebooks are, oldest first, and the caller is told
//   how many. When every remembered notebook is switched on, a new one is held in memory only (and the caller is told).
// - An id the store cannot use as a key (unusual characters, too long) is stored under a hash of it instead of not at all.
import { EMPTY_REDACT_STATE, isPageId, normaliseRedactions, type RedactState } from "../model/redact";
import type { LocalStore } from "./usage-store";

/** Local storage key of the per-notebook sets. */
export const REDACT_KEY = "notebook-redactions";
/** Review fix (R3): where a stored value that could not be read is kept (bounded), and whose presence keeps every notebook unreadable. */
export const REDACT_QUARANTINE_KEY = "notebook-redactions-unreadable";
/** Review fix (R3): set while the main value holds notebooks, so a value the platform drops as unreadable is noticed (not read as empty). */
export const REDACT_PRESENT_KEY = "notebook-redactions-present";
/** Notebooks remembered: past this, switched-off notebooks are forgotten (oldest first); switched-on ones never are. */
export const REDACT_MAX_NOTEBOOKS = 20;
/** Most entries read back from storage (bounds a corrupt or foreign value; the store never writes more than the limit plus one). */
const READ_CAP = 200;
/** Most characters of an unreadable value kept in the quarantine copy. */
export const QUARANTINE_MAX_CHARS = 128_000;

const NOTEBOOK_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
/** A notebook id the store can use as a key as it is (the same rule as a page id, which also refuses the names an object treats specially). */
const plainKey = (id: string): boolean => NOTEBOOK_PATTERN.test(id) && isPageId(id);

/** 53-bit string hash (cyrb53), as 14 hex digits. */
function hash53(s: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The key a notebook is stored under: its id, or `x-<hash>` for an id that cannot be a key as it is. */
export function redactKey(notebookId: string): string {
	return plainKey(notebookId) ? notebookId : `x-${hash53(notebookId)}`;
}

interface Entry {
	on: boolean;
	at: number;
	boxes: ReturnType<typeof normaliseRedactions>;
	/** Saved with no boxes while a quarantine copy exists: "none", on purpose (without it the notebook would read as unreadable). */
	cleared?: true;
}

export type RedactStore = Readonly<Record<string, Entry>>;

/** What reading the stored value gives: the valid entries, the keys whose entry cannot be read (with their raw value), and whether the whole value was unreadable. */
interface Parsed {
	store: Record<string, Entry>;
	bad: Map<string, unknown>;
	corrupt: boolean;
}

const ENTRY_FIELDS = ["on", "at", "boxes", "cleared"];

function parse(data: unknown, present = false): Parsed {
	const out: Parsed = { store: {}, bad: new Map(), corrupt: false };
	if (data === null || data === undefined) return { ...out, corrupt: present };
	if (typeof data !== "object" || Array.isArray(data)) return { ...out, corrupt: true };
	const rows: Array<readonly [string, Entry]> = [];
	for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
		// Review fix (R3): a key or a value this store never writes is another format (a future version, another tool): the whole value
		// is unreadable, never "no entry" for every notebook.
		if (!plainKey(id) || typeof v !== "object" || v === null || Array.isArray(v)) return { ...out, corrupt: true };
		const o = v as Record<string, unknown>;
		if (!ENTRY_FIELDS.some((f) => f in o)) return { ...out, corrupt: true };
		const boxes = normaliseRedactions(o.boxes);
		const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
		if (Object.keys(boxes).length === 0) {
			if (o.cleared === true && isEmptyBoxes(o.boxes)) rows.push([id, { on: false, at, boxes: {}, cleared: true }]);
			else out.bad.set(id, v);
			continue;
		}
		// Review fix (T5): this store writes its sets already normalised, so a set that loses a page or a box when it is read again was
		// written by something else (a newer version, another tool): that notebook is unreadable, never read with fewer boxes.
		if (!sameShape(o.boxes, boxes)) {
			out.bad.set(id, v);
			continue;
		}
		rows.push([id, { on: o.on === true, at, boxes }]);
	}
	// Review fix (T5): more notebooks than this store ever writes: another format, not a list to cut.
	if (rows.length + out.bad.size > READ_CAP) return { store: {}, bad: new Map(), corrupt: true };
	rows.sort((a, b) => b[1].at - a[1].at);
	out.store = Object.fromEntries(rows);
	return out;
}

const isEmptyBoxes = (raw: unknown): boolean => raw === undefined || (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0);

/** Whether the raw set has exactly the pages and the number of boxes of its normalised form. */
function sameShape(raw: unknown, boxes: ReturnType<typeof normaliseRedactions>): boolean {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
	const pages = Object.keys(raw);
	if (pages.length !== Object.keys(boxes).length) return false;
	return pages.every((p) => {
		const list = (raw as Record<string, unknown>)[p];
		return Array.isArray(list) && list.length === (boxes[p]?.length ?? -1);
	});
}

/** Whatever was stored, as a valid store (entries that cannot be read are left out; nothing that is switched on is dropped). */
export function normaliseRedactStore(data: unknown): RedactStore {
	return parse(data).store;
}

/** What this session set, per app and notebook: it wins over storage (see the file comment). */
const sessions = new WeakMap<object, Map<string, RedactState>>();
/** What notice is due per app: an unreadable value was found and copied aside ("damaged"), or there was nothing left to copy ("lost"). */
const found = new WeakMap<object, RedactStoreProblem>();
/** Apps whose reader has been told that the stored boxes could not be read (once per session). */
const told = new WeakSet<object>();

/** Review fix (T6): what the one notice of a session says. */
export type RedactStoreProblem = "damaged" | "lost";

function note(app: object, problem: RedactStoreProblem): void {
	if (found.get(app) !== "lost") found.set(app, problem);
}

function remembered(app: object): Map<string, RedactState> {
	let m = sessions.get(app);
	if (!m) {
		m = new Map();
		sessions.set(app, m);
	}
	return m;
}

const copyState = (s: RedactState): RedactState => ({ on: s.on, boxes: s.boxes });
const UNREADABLE: RedactState = { ...EMPTY_REDACT_STATE, unreadable: true };

/**
 * Review fix (T6): one copy kept aside. `store`: the whole value could not be read (every notebook without a fresh entry is then
 * unreadable); `entry`: the entry of one notebook (`id`), before it is replaced. `raw` is null when nothing was left to copy (a value the
 * platform dropped).
 */
interface QuarantineCopy {
	at: number;
	scope: "store" | "entry";
	id?: string;
	raw: string | null;
	truncated?: true;
}

/** Most copies kept aside: one per distinct unreadable value; past it a value that would need its own copy is never overwritten. */
export const QUARANTINE_MAX_COPIES = 6;

function textOf(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	try {
		return typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw));
	} catch {
		return String(raw);
	}
}

/** The copies kept aside (a copy written by the first version of this fix, a single object, reads as one `store` copy). Throws when storage throws. */
function copiesOf(app: Pick<LocalStore, "loadLocalStorage">): QuarantineCopy[] {
	const q = app.loadLocalStorage(REDACT_QUARANTINE_KEY);
	if (q === null || q === undefined) return [];
	if (typeof q === "object" && !Array.isArray(q) && Array.isArray((q as { copies?: unknown }).copies)) {
		return ((q as { copies: unknown[] }).copies).filter((c): c is QuarantineCopy => typeof c === "object" && c !== null);
	}
	// Anything else under the key still means "something could not be read": every notebook stays refused.
	return [{ at: 0, scope: "store", raw: textOf(q) }];
}

/**
 * Keeps one unreadable value aside, bounded, unless the same value (same scope, notebook and text) is already kept. True when its copy is
 * there afterwards; false when it could not be written or the list is full (the caller then overwrites nothing).
 */
function quarantine(app: LocalStore, scope: "store" | "entry", raw: unknown, now: number, id?: string): boolean {
	try {
		const text = textOf(raw);
		const kept = text !== null && text.length > QUARANTINE_MAX_CHARS ? text.slice(0, QUARANTINE_MAX_CHARS) : text;
		const copies = copiesOf(app);
		const same = (c: QuarantineCopy): boolean => c.scope === scope && (c.id ?? null) === (id ?? null) && c.raw === kept;
		if (copies.some(same)) return true;
		if (copies.length >= QUARANTINE_MAX_COPIES) return false;
		const copy: QuarantineCopy = { at: now, scope, raw: kept, ...(id !== undefined ? { id } : {}), ...(kept !== text ? { truncated: true as const } : {}) };
		app.saveLocalStorage(REDACT_QUARANTINE_KEY, { copies: [...copies, copy] });
		return copiesOf(app).some(same);
	} catch (e) {
		console.error("[notebook] could not keep the unreadable redaction boxes", e);
		return false;
	}
}

interface Read {
	parsed: Parsed;
	raw: unknown;
	/** A `store` copy exists: every notebook without a fresh entry is unreadable. */
	quarantined: boolean;
}

function readStore(app: Pick<LocalStore, "loadLocalStorage">): Read {
	const raw = app.loadLocalStorage(REDACT_KEY);
	const present = app.loadLocalStorage(REDACT_PRESENT_KEY);
	return { parsed: parse(raw, present !== null && present !== undefined), raw, quarantined: copiesOf(app).some((c) => c.scope === "store") };
}

/**
 * What is remembered for this notebook on this device: the boxes and whether exports apply them (nothing: no boxes, off). `unreadable`
 * when what was stored cannot be read: the caller must not export as if there were no boxes. Reading an unreadable value keeps a copy
 * of it under the quarantine key when the store can write (the only write a read makes; the main value is left as it is).
 */
export function loadRedactState(app: Pick<LocalStore, "loadLocalStorage"> & Partial<Pick<LocalStore, "saveLocalStorage">>, notebookId: string | null | undefined): RedactState {
	if (!notebookId) return EMPTY_REDACT_STATE;
	const held = sessions.get(app)?.get(notebookId);
	if (held) return copyState(held);
	const key = redactKey(notebookId);
	let read: Read;
	try {
		read = readStore(app);
	} catch {
		note(app, "damaged");
		return UNREADABLE;
	}
	const canWrite = typeof app.saveLocalStorage === "function";
	if (read.parsed.corrupt) {
		note(app, read.raw === null || read.raw === undefined ? "lost" : "damaged");
		if (canWrite) quarantine(app as LocalStore, "store", read.raw, Date.now());
		return UNREADABLE;
	}
	if (read.parsed.bad.has(key)) {
		// Review fix (T5): an entry this version cannot read whole is kept aside and told, like a value that cannot be read at all.
		note(app, "damaged");
		if (canWrite) quarantine(app as LocalStore, "entry", read.parsed.bad.get(key), Date.now(), key);
		return UNREADABLE;
	}
	const e = read.parsed.store[key];
	if (e) return e.cleared ? EMPTY_REDACT_STATE : { on: e.on, boxes: e.boxes };
	if (read.quarantined) {
		note(app, "damaged");
		return UNREADABLE;
	}
	return EMPTY_REDACT_STATE;
}

/**
 * Review fixes (R3, T6): once per session after the stored boxes were found unreadable, what the one notice says: `damaged` (what could be
 * read was copied aside) or `lost` (nothing was left to copy). Null otherwise.
 */
export function takeRedactStoreNotice(app: object): RedactStoreProblem | null {
	const problem = found.get(app);
	if (!problem || told.has(app)) return null;
	told.add(app);
	return problem;
}

/** What a save did. `stored`: it is on this device and was read back the same (otherwise it is held for this session only). */
export interface RedactSaveResult {
	stored: boolean;
	/** Every remembered notebook is switched on, so this one could not be added (held for this session only). */
	full: boolean;
	/** Switched-off notebooks forgotten to make room. */
	evicted: number;
}

const sameEntry = (a: Entry | undefined, b: Entry | undefined): boolean =>
	a === undefined || b === undefined ? a === b : a.on === b.on && a.cleared === b.cleared && JSON.stringify(a.boxes) === JSON.stringify(b.boxes);

/**
 * Remembers the state of a notebook (an empty set forgets it, or keeps it as an explicit "none" while a quarantine copy exists): in memory
 * for this session at once, then on this device. Called only for what the reader does in the Redact and Export dialogs. A main value that
 * cannot be read is replaced only after its quarantine copy is confirmed; otherwise nothing is written. Never throws; the result says
 * whether it was stored (the caller tells the reader when it was not).
 */
export function saveRedactState(app: LocalStore, notebookId: string | null | undefined, state: RedactState, now: number = Date.now()): RedactSaveResult {
	const failed: RedactSaveResult = { stored: false, full: false, evicted: 0 };
	if (!notebookId) return failed;
	const boxes = normaliseRedactions(state.boxes);
	remembered(app).set(notebookId, { on: state.on && Object.keys(boxes).length > 0, boxes });
	const key = redactKey(notebookId);
	// Review fix (T9): whether this save wrote the sentinel for a store that had no value yet (undone when the value itself cannot be written).
	let sentinelOnly = false;
	try {
		const read = readStore(app);
		const parsed = read.parsed;
		let isQuarantined = read.quarantined;
		if (parsed.corrupt) {
			note(app, read.raw === null || read.raw === undefined ? "lost" : "damaged");
			if (!quarantine(app, "store", read.raw, now)) return failed;
			isQuarantined = true;
		}
		// Review fixes (T5, T6): the entry of this notebook that could not be read is kept aside before it is replaced.
		if (parsed.bad.has(key) && !quarantine(app, "entry", parsed.bad.get(key), now, key)) return failed;
		const store: Record<string, Entry> = { ...parsed.store };
		const had = Object.prototype.hasOwnProperty.call(store, key);
		let mine: Entry | undefined;
		if (Object.keys(boxes).length > 0) store[key] = mine = { on: state.on, at: now, boxes };
		else if (isQuarantined) store[key] = mine = { on: false, at: now, boxes: {}, cleared: true };
		else delete store[key];
		parsed.bad.delete(key);
		// Room: switched-off notebooks go first, oldest first; a switched-on one never goes.
		let evicted = 0;
		const count = (): number => Object.keys(store).length + parsed.bad.size;
		if (count() > REDACT_MAX_NOTEBOOKS) {
			const off = Object.entries(store).filter(([id, e]) => id !== key && !e.on).sort((a, b) => a[1].at - b[1].at);
			for (const [id] of off) {
				if (count() <= REDACT_MAX_NOTEBOOKS) break;
				delete store[id];
				evicted++;
			}
		}
		let full = false;
		if (count() > REDACT_MAX_NOTEBOOKS && !had && mine) {
			delete store[key];
			mine = undefined;
			full = true;
		}
		const out: Record<string, unknown> = { ...store };
		for (const [id, raw] of parsed.bad) out[id] = raw;
		const holds = Object.keys(out).length > 0;
		// The sentinel is set before a value that holds notebooks is written and cleared only after an empty one is, so a torn write never
		// leaves a missing value that reads as "no boxes".
		if (holds) {
			sentinelOnly = (read.raw === null || read.raw === undefined) && !parsed.corrupt;
			app.saveLocalStorage(REDACT_PRESENT_KEY, 1);
		}
		app.saveLocalStorage(REDACT_KEY, out);
		sentinelOnly = false;
		if (!holds) app.saveLocalStorage(REDACT_PRESENT_KEY, null);
		if (full) return { stored: false, full: true, evicted };
		const back = parse(app.loadLocalStorage(REDACT_KEY));
		return { stored: !back.corrupt && sameEntry(back.store[key], mine), full: false, evicted };
	} catch (e) {
		console.error("[notebook] could not remember the redaction boxes", e);
		// Review fix (T9): the very first value could not be written (a full quota): the sentinel would make every notebook read as a
		// damaged store. It goes again; this notebook's boxes are held for the session, and the caller says once that they were not saved.
		if (sentinelOnly) {
			try {
				app.saveLocalStorage(REDACT_PRESENT_KEY, null);
			} catch {
				// Then every notebook is refused (fail closed).
			}
		}
		return failed;
	}
}

/**
 * Review fix (R3): the reader's explicit "Reset redaction storage" (after a confirmation): the boxes of every notebook on this device,
 * the quarantine copy and what this session held are forgotten. Afterwards no notebook has boxes. True when storage reads back empty.
 */
export function resetRedactStorage(app: LocalStore): boolean {
	sessions.delete(app);
	found.delete(app);
	told.delete(app);
	try {
		app.saveLocalStorage(REDACT_KEY, null);
		app.saveLocalStorage(REDACT_PRESENT_KEY, null);
		app.saveLocalStorage(REDACT_QUARANTINE_KEY, null);
		const gone = (k: string): boolean => {
			const v = app.loadLocalStorage(k);
			return v === null || v === undefined;
		};
		return gone(REDACT_KEY) && gone(REDACT_PRESENT_KEY) && gone(REDACT_QUARANTINE_KEY);
	} catch (e) {
		console.error("[notebook] could not reset the redaction boxes", e);
		return false;
	}
}
