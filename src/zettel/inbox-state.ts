/**
 * Processing flow (M15 Z4), state: which items of the Inbox have been dealt with. Pure: no 'obsidian'.
 *
 * Nothing about this is stored in a notebook (no format change) or in a card. It lives in small JSON files in the notebooks
 * folder's reserved `_meta` folder, **one file per device** (`inbox-<device>.json`): a device only ever writes its own
 * file, so two synced devices never write the same file and the sync service has nothing to conflict on. Reading merges
 * all the files: per key the entry with the latest `at` wins (a tie goes to the larger device id), which is what lets an
 * item be reopened by any device.
 */

import { EMPTY_FILE_MESSAGE } from "../storage/device-files";

export const INBOX_FORMAT = "obsidian-notebook-inbox";
export const INBOX_VERSION = 1;

export type InboxState = "open" | "discarded" | "card" | "linked";
export const INBOX_STATES: readonly InboxState[] = ["open", "discarded", "card", "linked"];

export interface InboxEntry {
	key: string;
	state: InboxState;
	/** When (ms since epoch) the decision was made. */
	at: number;
	/** Page-block items: how much content the block had then; more content later makes the item open again. */
	sig?: number;
	/** `card`: the card made; `linked`: the card it was linked to (its `zettel-id` and note path). */
	card?: string;
	path?: string;
}

export interface InboxFile {
	version: number;
	device: string;
	entries: InboxEntry[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type InboxParse =
	| { ok: true; data: InboxFile }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

export function emptyInbox(device: string): InboxFile {
	return { version: INBOX_VERSION, device, entries: [], unknown: [] };
}

/** `inbox-<device>.json` */
export function inboxFileName(device: string): string {
	return `inbox-${device}.json`;
}

/** The device id of a file name made by `inboxFileName`, or null. */
export function deviceOfFileName(name: string): string | null {
	const m = /^inbox-([0-9a-f]{8})\.json$/.exec(name);
	return m ? m[1]! : null;
}

export function newDeviceId(random: () => number = Math.random): string {
	let s = "";
	for (let i = 0; i < 8; i++) s += Math.floor(random() * 16).toString(16);
	return s;
}

export function validDeviceId(id: unknown): id is string {
	return typeof id === "string" && /^[0-9a-f]{8}$/.test(id);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readEntry(v: unknown): InboxEntry | null {
	if (!isObject(v)) return null;
	const { key, state, at, sig, card, path } = v;
	if (typeof key !== "string" || key === "") return null;
	if (typeof state !== "string" || !INBOX_STATES.includes(state as InboxState)) return null;
	if (typeof at !== "number" || !Number.isFinite(at)) return null;
	const entry: InboxEntry = { key, state: state as InboxState, at };
	if (typeof sig === "number" && Number.isFinite(sig)) entry.sig = sig;
	if (typeof card === "string" && card !== "") entry.card = card;
	if (typeof path === "string" && path !== "") entry.path = path;
	return entry;
}

/**
 * Reads a device file. A file that is not ours or comes from a newer version is reported, never "fixed". An existing empty
 * file is not "nothing dealt with": a sync app may not have finished downloading it, so it is reported too (a missing file
 * is the empty state; the store never asks this for one).
 */
export function parseInbox(text: string, device: string): InboxParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== INBOX_FORMAT) return { ok: false, reason: "format", message: "not an inbox file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > INBOX_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.entries)) return { ok: false, reason: "format", message: "entries is not a list" };
	const entries: InboxEntry[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.entries) {
		const e = readEntry(v);
		if (e) entries.push(e);
		else unknown.push(v);
	}
	return { ok: true, data: { version: INBOX_VERSION, device: validDeviceId(raw.device) ? raw.device : device, entries: dedupe(entries), unknown } };
}

/** One entry per key (the latest). */
function dedupe(entries: readonly InboxEntry[]): InboxEntry[] {
	const by = new Map<string, InboxEntry>();
	for (const e of entries) {
		const old = by.get(e.key);
		if (!old || e.at >= old.at) by.set(e.key, e);
	}
	return [...by.values()];
}

/** Stable text: entries sorted by key, one per line, so a file changes only where an entry changed. */
export function serializeInbox(data: InboxFile): string {
	const head = `{"format":${JSON.stringify(INBOX_FORMAT)},"version":${INBOX_VERSION},"device":${JSON.stringify(data.device)},"entries":[`;
	const lines = [...dedupe(data.entries)].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((e) => JSON.stringify(e));
	lines.push(...data.unknown.map((u) => JSON.stringify(u)));
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

export type InboxOp = { type: "set"; entry: InboxEntry } | { type: "remove"; key: string };

export function applyInboxOp(file: InboxFile, op: InboxOp): InboxFile {
	const rest = file.entries.filter((e) => e.key !== (op.type === "set" ? op.entry.key : op.key));
	return { ...file, entries: op.type === "set" ? [...rest, op.entry] : rest };
}

/** All device files together: per key the latest entry (ties: the larger device id). */
export function mergeInboxFiles(files: readonly InboxFile[]): Map<string, InboxEntry> {
	const best = new Map<string, { entry: InboxEntry; device: string }>();
	for (const f of files) {
		for (const entry of f.entries) {
			const old = best.get(entry.key);
			if (!old || entry.at > old.entry.at || (entry.at === old.entry.at && f.device > old.device)) best.set(entry.key, { entry, device: f.device });
		}
	}
	return new Map([...best].map(([k, v]) => [k, v.entry]));
}

export type ItemStatus =
	| { status: "open"; changed: boolean }
	| { status: "discarded" | "card" | "linked"; entry: InboxEntry };

/** Whether an item still has to be processed. A block with more content than when it was processed is open again. */
export function statusOf(item: { key: string; sig: number }, merged: ReadonlyMap<string, InboxEntry>): ItemStatus {
	const entry = merged.get(item.key);
	if (!entry || entry.state === "open") return { status: "open", changed: false };
	if (entry.sig !== undefined && item.sig > entry.sig) return { status: "open", changed: true };
	return { status: entry.state, entry };
}
