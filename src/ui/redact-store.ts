// 0.26 redact (#285): the redaction boxes of a notebook, kept on THIS device only. Obsidian's per-device local storage, never the notebook
// file, never the vault, never synced or sent anywhere, and bounded (notebooks, pages and boxes have limits). The document format is untouched.
//
// Review fixes (P4): the store FAILS CLOSED.
// - What this session set is also held in memory (per app), and that copy wins: boxes drawn while the device cannot store them still
//   cover every export until Obsidian closes, and the caller is told that they were not stored (`saveRedactState` returns it).
// - Every save is read back; a save that does not read back the same is reported as not stored.
// - A stored value that cannot be read (corrupt, or storage that throws) reads as `unreadable`, never as "no boxes": exports refuse to
//   write until the boxes are set again (an entry that cannot be read is kept as it is by later saves of other notebooks).
// - A notebook whose switch is on is never forgotten to make room: only switched-off notebooks are, oldest first, and the caller is told
//   how many. When every remembered notebook is switched on, a new one is held in memory only (and the caller is told).
// - An id the store cannot use as a key (unusual characters, too long) is stored under a hash of it instead of not at all.
import { EMPTY_REDACT_STATE, isPageId, normaliseRedactions, type RedactState } from "../model/redact";
import type { LocalStore } from "./usage-store";

/** Local storage key of the per-notebook sets. */
export const REDACT_KEY = "notebook-redactions";
/** Notebooks remembered: past this, switched-off notebooks are forgotten (oldest first); switched-on ones never are. */
export const REDACT_MAX_NOTEBOOKS = 20;
/** Most entries read back from storage (bounds a corrupt or foreign value; the store never writes more than the limit plus one). */
const READ_CAP = 200;

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
}

export type RedactStore = Readonly<Record<string, Entry>>;

/** What reading the stored value gives: the valid entries, the keys whose entry cannot be read (with their raw value), and whether the whole value was unreadable. */
interface Parsed {
	store: Record<string, Entry>;
	bad: Map<string, unknown>;
	corrupt: boolean;
}

function parse(data: unknown): Parsed {
	const out: Parsed = { store: {}, bad: new Map(), corrupt: false };
	if (data === null || data === undefined) return out;
	if (typeof data !== "object" || Array.isArray(data)) return { ...out, corrupt: true };
	const rows: Array<readonly [string, Entry]> = [];
	for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
		if (!plainKey(id)) continue; // never written by this store: no notebook reads it
		if (typeof v !== "object" || v === null || Array.isArray(v)) {
			out.bad.set(id, v);
			continue;
		}
		const o = v as Record<string, unknown>;
		const boxes = normaliseRedactions(o.boxes);
		if (Object.keys(boxes).length === 0) {
			out.bad.set(id, v);
			continue;
		}
		const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
		rows.push([id, { on: o.on === true, at, boxes }]);
	}
	rows.sort((a, b) => b[1].at - a[1].at);
	out.store = Object.fromEntries(rows.slice(0, READ_CAP));
	return out;
}

/** Whatever was stored, as a valid store (entries that cannot be read are left out; nothing that is switched on is dropped). */
export function normaliseRedactStore(data: unknown): RedactStore {
	return parse(data).store;
}

/** What this session set, per app and notebook: it wins over storage (see the file comment). */
const sessions = new WeakMap<object, Map<string, RedactState>>();

function remembered(app: object): Map<string, RedactState> {
	let m = sessions.get(app);
	if (!m) {
		m = new Map();
		sessions.set(app, m);
	}
	return m;
}

const copyState = (s: RedactState): RedactState => ({ on: s.on, boxes: s.boxes });

/**
 * What is remembered for this notebook on this device: the boxes and whether exports apply them (nothing: no boxes, off). `unreadable`
 * when what was stored cannot be read: the caller must not export as if there were no boxes.
 */
export function loadRedactState(app: Pick<LocalStore, "loadLocalStorage">, notebookId: string | null | undefined): RedactState {
	if (!notebookId) return EMPTY_REDACT_STATE;
	const held = sessions.get(app)?.get(notebookId);
	if (held) return copyState(held);
	const key = redactKey(notebookId);
	let parsed: Parsed;
	try {
		parsed = parse(app.loadLocalStorage(REDACT_KEY));
	} catch {
		return { ...EMPTY_REDACT_STATE, unreadable: true };
	}
	if (parsed.corrupt || parsed.bad.has(key)) return { ...EMPTY_REDACT_STATE, unreadable: true };
	const e = parsed.store[key];
	return e ? { on: e.on, boxes: e.boxes } : EMPTY_REDACT_STATE;
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
	a === undefined || b === undefined ? a === b : a.on === b.on && JSON.stringify(a.boxes) === JSON.stringify(b.boxes);

/**
 * Remembers the state of a notebook (an empty set forgets it): in memory for this session at once, then on this device. Never throws; the
 * result says whether it was stored (the caller tells the reader when it was not).
 */
export function saveRedactState(app: LocalStore, notebookId: string | null | undefined, state: RedactState, now: number = Date.now()): RedactSaveResult {
	const failed: RedactSaveResult = { stored: false, full: false, evicted: 0 };
	if (!notebookId) return failed;
	const boxes = normaliseRedactions(state.boxes);
	remembered(app).set(notebookId, { on: state.on && Object.keys(boxes).length > 0, boxes });
	const key = redactKey(notebookId);
	try {
		const parsed = parse(app.loadLocalStorage(REDACT_KEY));
		const store: Record<string, Entry> = { ...parsed.store };
		const had = Object.prototype.hasOwnProperty.call(store, key);
		let mine: Entry | undefined;
		if (Object.keys(boxes).length === 0) delete store[key];
		else store[key] = mine = { on: state.on, at: now, boxes };
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
		app.saveLocalStorage(REDACT_KEY, out);
		if (full) return { stored: false, full: true, evicted };
		const back = parse(app.loadLocalStorage(REDACT_KEY));
		return { stored: !back.corrupt && sameEntry(back.store[key], mine), full: false, evicted };
	} catch (e) {
		console.error("[notebook] could not remember the redaction boxes", e);
		return failed;
	}
}
