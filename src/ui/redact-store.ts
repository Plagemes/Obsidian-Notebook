// 0.26 redact (#285): the redaction boxes of a notebook, kept on THIS device only. Obsidian's per-device local storage, never the notebook
// file, never the vault, never synced or sent anywhere, and bounded (notebooks, pages and boxes have limits; the least recently changed
// notebooks are forgotten first). The document format is untouched. A corrupt value reads as no boxes and is replaced at the next save.
import { EMPTY_REDACT_STATE, isPageId, normaliseRedactions, type RedactState } from "../model/redact";
import type { LocalStore } from "./usage-store";

/** Local storage key of the per-notebook sets. */
export const REDACT_KEY = "notebook-redactions";
/** Notebooks remembered (the least recently changed are forgotten first). */
export const REDACT_MAX_NOTEBOOKS = 20;

const NOTEBOOK_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
/** A notebook id the store keeps (the same rule as a page id, which also refuses the names an object would treat specially). */
const NOTEBOOK_ID = { test: (id: string): boolean => NOTEBOOK_PATTERN.test(id) && isPageId(id) };

interface Entry {
	on: boolean;
	at: number;
	boxes: ReturnType<typeof normaliseRedactions>;
}

export type RedactStore = Readonly<Record<string, Entry>>;

/** Whatever was stored, as a valid and bounded store. */
export function normaliseRedactStore(data: unknown): RedactStore {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows: Array<readonly [string, Entry]> = [];
	for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
		if (!NOTEBOOK_ID.test(id) || typeof v !== "object" || v === null) continue;
		const o = v as Record<string, unknown>;
		const boxes = normaliseRedactions(o.boxes);
		if (Object.keys(boxes).length === 0) continue;
		const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
		rows.push([id, { on: o.on === true, at, boxes }]);
	}
	rows.sort((a, b) => b[1].at - a[1].at);
	return Object.fromEntries(rows.slice(0, REDACT_MAX_NOTEBOOKS));
}

function load(app: Pick<LocalStore, "loadLocalStorage">): RedactStore {
	try {
		return normaliseRedactStore(app.loadLocalStorage(REDACT_KEY));
	} catch {
		return {};
	}
}

/** What is remembered for this notebook on this device: the boxes and whether exports apply them (nothing: no boxes, off). */
export function loadRedactState(app: Pick<LocalStore, "loadLocalStorage">, notebookId: string | null | undefined): RedactState {
	if (!notebookId || !NOTEBOOK_ID.test(notebookId)) return EMPTY_REDACT_STATE;
	const e = load(app)[notebookId];
	return e ? { on: e.on, boxes: e.boxes } : EMPTY_REDACT_STATE;
}

/** Remembers the state of a notebook (an empty set forgets it). Never throws: a device that cannot store it simply does not remember. */
export function saveRedactState(app: LocalStore, notebookId: string | null | undefined, state: RedactState, now: number = Date.now()): void {
	if (!notebookId || !NOTEBOOK_ID.test(notebookId)) return;
	try {
		const store: Record<string, Entry> = { ...load(app) };
		const boxes = normaliseRedactions(state.boxes);
		if (Object.keys(boxes).length === 0) delete store[notebookId];
		else store[notebookId] = { on: state.on, at: now, boxes };
		app.saveLocalStorage(REDACT_KEY, normaliseRedactStore(store));
	} catch (e) {
		console.error("[notebook] could not remember the redaction boxes", e);
	}
}
