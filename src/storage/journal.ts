/**
 * Instant save journal (roadmap M8 #31).
 *
 * Problem: saves are debounced (1.5 s, at most 10 s). If Android kills the app without a
 * `visibilitychange`, the last seconds of ink would be lost. The journal records the document a
 * few hundred milliseconds after every change, in a small file owned by the plugin.
 *
 * Design (chosen for the lowest risk, no knowledge of the command types needed):
 * - The journal stores the *serialized document text* as of one revision, not operations. The
 *   serialization is deterministic and has one stroke/element per line, so the journal entry is
 *   either the whole text ("full", for small documents) or a line diff against the notebook file
 *   as last read or written by the session ("delta", for large ones). A delta holds only the
 *   changed lines: appending a stroke to a 6 MB notebook journals a few hundred bytes.
 *   The view does not have to describe its edits: `DocumentSession.markChanged()` is the only hook.
 * - Each write replaces a whole journal entry. Two slot files per writer are written alternately, so
 *   a torn write of one slot always leaves the previous complete entry in the other.
 * - The journal is keyed by file identity, not by document id alone: `journalKey(docId, vault path)`.
 *   Copies of a notebook (explorer copy, sync conflict copy) share a document id but not a path, so
 *   they cannot read or delete each other's entries; every entry also records its path and
 *   `inspectJournal` ignores entries of another path. Each open session writes under its own owner
 *   id (file `<key>.<owner>.<slot>.journal`), so the same notebook open in two leaves never overwrites
 *   or deletes the other's pending entries; a session only deletes what it wrote itself (or what it
 *   recovered and has since saved). Entries of owners that are still live in this app are not
 *   offered to a session that opens the same file (`JournalStore.read`).
 * - Rename: the key contains the path, so after a rename the session writes its next entry under the
 *   new key and then deletes its files under the old one (DocumentSession.writeJournal). Until that
 *   next write (at most one journal delay after the next change) the entries sit under the old key. Entries carry a fingerprint (length + two 32 bit hashes)
 *   of the disk content they apply to (`base`) and of the text they produce (`result`); an entry
 *   whose reconstructed text does not match `result`, or does not parse as a notebook, is ignored.
 * - The files live in the plugin's config folder, written through `app.vault.adapter` (see
 *   `AdapterJournalStore` in vault-io.ts). Writes there do not raise vault events, are not
 *   synced and are not indexed, so they can be frequent. This is a plugin-owned technical file,
 *   not user content, which Obsidian allows for the config folder.
 * - Cost control: a write needs the full text (`serializeChecked`, mostly cached stroke lines)
 *   and a line diff. The diff trims the common prefix/suffix and runs Myers' algorithm on the
 *   rest (capped at DELTA_MAX_EDITS edits). If the diff is too large or not smaller than the text,
 *   the full text is written instead, throttled in proportion to its size (see `fullWriteGapMs`);
 *   above FULL_MAX_CHARS nothing is journaled and the regular save is the only protection.
 *
 * Recovery (`inspectJournal`, used by DocumentSession whenever a file becomes readable: the first
 * load and a later reload of a file that was broken or read-only): entries are examined newest first.
 * The first whose `result` equals the file is already merged (crash between save and cleanup); the
 * first whose `base` equals the fingerprint of the file just read is applied in memory and the
 * session marks itself dirty, so the normal save writes it. The journal stays until that save
 * succeeds. Whenever the newest entry is not the one chosen, a copy of it goes to the backup folder
 * first. If no entry fits (the file changed elsewhere, or the entry cannot be rebuilt) nothing is
 * applied: a copy goes to the backup folder first, and only then is the journal deleted.
 */
import { parse } from "../model/serialize";

/** Raw text of one journal slot file. */
export interface JournalSlotFile {
	/** The session that wrote it. */
	owner: string;
	slot: 0 | 1;
	text: string;
}

/** Key of the journal of one notebook file: its document id plus a hash of its vault path. File-name safe. */
export function journalKey(docId: string, path: string): string {
	return `${docId.replace(/[^A-Za-z0-9_-]/g, "_")}.${fingerprint(path)}`;
}

/** Storage of the journal files of all notebooks, injected so tests can use a fake. */
export interface JournalStore {
	/**
	 * The slot files under `key` that may be recovered: those of owners that are no longer live
	 * (a session that wrote and was not `release`d is still using its files). Unreadable ones are left out.
	 */
	read(key: string): Promise<JournalSlotFile[]>;
	write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void>;
	/** Deletes both slots of `owner` under `key`. */
	remove(key: string, owner: string): Promise<void>;
	/** The session `owner` is closed: its remaining files (if any) become recoverable by the next session. */
	release(owner: string): void;
}

/** Documents up to this size are journaled as a full snapshot (robust: no dependency on the base). */
export const FULL_BELOW_CHARS = 256_000;
/** Largest diff (in edited lines) searched for; bigger changes fall back to a full snapshot. */
export const DELTA_MAX_EDITS = 1000;
/** Above this size a full snapshot is not journaled (the regular save is the only protection). */
export const FULL_MAX_CHARS = 8_000_000;

/** Minimum time between two full-snapshot writes of a document of `chars` characters. */
export function fullWriteGapMs(chars: number): number {
	return Math.min(3000, Math.floor(chars / 4000));
}

/** Length plus two independent 32 bit hashes: identifies a text far more safely than one hash. */
export function fingerprint(text: string): string {
	let a = 0x811c9dc5;
	let b = 5381;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = (Math.imul(b, 33) + c) | 0;
	}
	return `${text.length.toString(36)}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

/** `[start line in the base, lines removed, lines inserted]` */
export type Hunk = [number, number, string[]];

export interface JournalEntry {
	format: "notebook-journal";
	v: 1;
	doc: string;
	/** Vault path of the notebook file when the entry was written (absent in entries of older builds). */
	path?: string;
	seq: number;
	savedAt: string;
	/** Fingerprint of the disk content this entry applies to. */
	base: string;
	/** Fingerprint of the document text it produces. */
	result: string;
	/** The whole document text ("full" entries). */
	full?: string;
	/** Line diff against the base ("delta" entries). */
	hunks?: Hunk[];
}

export function splitLines(text: string): string[] {
	return text.split("\n");
}

/** Applies `hunks` (sorted, non-overlapping) to `base`. Returns null if they do not fit. */
export function applyHunks(base: readonly string[], hunks: readonly Hunk[]): string[] | null {
	const out: string[] = [];
	let pos = 0;
	for (const [at, del, add] of hunks) {
		if (at < pos || del < 0 || at + del > base.length) return null;
		for (let i = pos; i < at; i++) out.push(base[i]!);
		for (const line of add) out.push(line);
		pos = at + del;
	}
	for (let i = pos; i < base.length; i++) out.push(base[i]!);
	return out;
}

/**
 * Line diff of `next` against `base`. Returns null if more than `maxEdits` lines differ.
 * Common prefix and suffix are trimmed first, so the usual change (a few strokes added or
 * removed) costs one pass over the text.
 */
export function diffLines(base: readonly string[], next: readonly string[], maxEdits = DELTA_MAX_EDITS): Hunk[] | null {
	let start = 0;
	const limit = Math.min(base.length, next.length);
	while (start < limit && base[start] === next[start]) start++;
	let endA = base.length;
	let endB = next.length;
	while (endA > start && endB > start && base[endA - 1] === next[endB - 1]) {
		endA--;
		endB--;
	}
	if (endA === start && endB === start) return [];
	if (endA === start) return [[start, 0, next.slice(start, endB)]];
	if (endB === start) return [[start, endA - start, []]];

	// Intern the differing middle so the comparison is on integers.
	const ids = new Map<string, number>();
	const intern = (s: string) => {
		let id = ids.get(s);
		if (id === undefined) {
			id = ids.size;
			ids.set(s, id);
		}
		return id;
	};
	const a = Int32Array.from({ length: endA - start }, (_, i) => intern(base[start + i]!));
	const b = Int32Array.from({ length: endB - start }, (_, i) => intern(next[start + i]!));
	const edits = myers(a, b, maxEdits);
	if (!edits) return null;

	const hunks: Hunk[] = [];
	let current: Hunk | null = null;
	for (const e of edits) {
		const x = start + e.x;
		if (!current || current[0] + current[1] !== x) {
			current = [x, 0, []];
			hunks.push(current);
		}
		if (e.insert) current[2].push(next[start + e.y]!);
		else current[1]++;
	}
	return hunks;
}

interface Edit {
	insert: boolean;
	/** Position in `a` where the edit applies. */
	x: number;
	/** Index in `b` of the inserted line (insertions only). */
	y: number;
}

/** Myers' O(ND) shortest edit script, in forward order. Null if it needs more than `maxD` edits. */
function myers(a: Int32Array, b: Int32Array, maxD: number): Edit[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, maxD);
	const off = max + 1;
	const v = new Int32Array(2 * max + 4);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= max && found < 0; d++) {
		trace.push(v.slice(off - d - 1, off + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	if (found < 0) return null;

	const edits: Edit[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d]!;
		const at = (k: number) => prev[k + d + 1]!;
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
		}
		if (x === prevX) edits.push({ insert: true, x: prevX, y: prevY });
		else edits.push({ insert: false, x: prevX, y: prevY });
		x = prevX;
		y = prevY;
	}
	return edits.reverse();
}

/** Builds the journal entry for `next`, given the disk content `base`. Null if it is too big to journal. */
export function buildEntry(
	docId: string,
	seq: number,
	savedAt: string,
	base: string,
	baseLines: readonly string[],
	next: string,
	path?: string,
): { entry: JournalEntry; text: string; full: boolean } | null {
	const head = {
		format: "notebook-journal" as const, v: 1 as const, doc: docId, ...(path !== undefined ? { path } : {}),
		seq, savedAt, base: fingerprint(base), result: fingerprint(next),
	};
	const full = (): { entry: JournalEntry; text: string; full: true } | null => {
		if (next.length > FULL_MAX_CHARS) return null;
		const entry: JournalEntry = { ...head, full: next };
		return { entry, text: JSON.stringify(entry), full: true };
	};
	if (next.length <= FULL_BELOW_CHARS) return full();
	const nextLines = splitLines(next);
	const hunks = diffLines(baseLines, nextLines);
	if (hunks) {
		// Self-check: the delta must rebuild exactly the text we mean to protect.
		const rebuilt = applyHunks(baseLines, hunks);
		if (rebuilt && rebuilt.join("\n") === next) {
			const entry: JournalEntry = { ...head, hunks };
			const text = JSON.stringify(entry);
			if (text.length < next.length / 2) return { entry, text, full: false };
		}
	}
	return full();
}

function isHunk(h: unknown): h is Hunk {
	return Array.isArray(h) && h.length === 3 && Number.isInteger(h[0]) && Number.isInteger(h[1]) && Array.isArray(h[2]) && (h[2] as unknown[]).every((l) => typeof l === "string");
}

/** Parses a slot file; null if it is not a well-formed journal entry. */
export function decodeEntry(text: string): JournalEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (e.format !== "notebook-journal" || e.v !== 1) return null;
	if (typeof e.doc !== "string" || typeof e.seq !== "number" || typeof e.savedAt !== "string") return null;
	if (typeof e.base !== "string" || typeof e.result !== "string") return null;
	if (e.path !== undefined && typeof e.path !== "string") return null;
	const hasFull = typeof e.full === "string";
	const hasHunks = Array.isArray(e.hunks) && e.hunks.every(isHunk);
	if (hasFull === hasHunks) return null;
	return raw as JournalEntry;
}

export type JournalRecovery =
	/** No journal for this notebook. */
	| { kind: "none" }
	/** The file already holds the chosen entry: delete the journal (after backing up `backupText`, a newer entry that did not fit). */
	| { kind: "merged"; backupText?: string }
	/** Apply `text` (a complete notebook text) in memory and save it; `backupText` is a newer entry that did not fit. */
	| { kind: "apply"; text: string; savedAt: string; backupText?: string }
	/** Not applicable (file changed elsewhere, or unreadable): back up `backupText`, then delete. */
	| { kind: "stale"; backupText: string };

export interface JournalInspection {
	recovery: JournalRecovery;
	/** Highest sequence number found; the next write must be higher. */
	maxSeq: number;
	/** Slot holding the newest valid entry, if any. */
	newestSlot: 0 | 1 | null;
}

/** Text to keep for an entry: a full entry is a complete notebook; a delta is only meaningful with its base, so keep it raw. */
function backupOf(entry: JournalEntry, file: JournalSlotFile): string {
	return entry.full !== undefined && parse(entry.full).ok ? entry.full : file.text;
}

/**
 * Decides what to do with the journal of a notebook whose file content is `diskText` (at vault path
 * `path`, when known). Never throws.
 */
export function inspectJournal(files: readonly JournalSlotFile[], docId: string, diskText: string, path?: string): JournalInspection {
	const entries: Array<{ entry: JournalEntry; file: JournalSlotFile }> = [];
	let undecodable: JournalSlotFile | null = null;
	for (const file of files) {
		const entry = decodeEntry(file.text);
		if (!entry) undecodable ??= file;
		else if (entry.doc === docId && (path === undefined || entry.path === undefined || entry.path === path)) entries.push({ entry, file });
	}
	entries.sort((x, y) => y.entry.seq - x.entry.seq);
	if (entries.length === 0) {
		// Slot files exist but none is usable: keep the newest raw text as a backup copy.
		const raw = undecodable && undecodable.text.trim().length > 0 ? undecodable : null;
		return { recovery: raw ? { kind: "stale", backupText: raw.text } : { kind: "none" }, maxSeq: 0, newestSlot: null };
	}
	const newest = entries[0]!;
	const maxSeq = newest.entry.seq;
	const newestSlot = newest.file.slot;
	const diskFp = fingerprint(diskText);

	// Newest first: an entry newer than the saved state must be applied, not skipped because an older one is merged.
	let baseLines: string[] | null = null;
	for (const candidate of entries) {
		const { entry } = candidate;
		// A newer entry that is not the chosen one is kept as a backup before the journal is deleted.
		const extra = candidate === newest ? {} : { backupText: backupOf(newest.entry, newest.file) };
		if (entry.result === diskFp) return { recovery: { kind: "merged", ...extra }, maxSeq, newestSlot };
		if (entry.base !== diskFp) continue;
		let text: string | null = null;
		if (entry.full !== undefined) {
			text = entry.full;
		} else if (entry.hunks) {
			baseLines ??= splitLines(diskText);
			text = applyHunks(baseLines, entry.hunks)?.join("\n") ?? null;
		}
		if (text === null || fingerprint(text) !== entry.result) continue;
		const check = parse(text);
		if (!check.ok || check.doc.id !== docId) continue;
		return { recovery: { kind: "apply", text, savedAt: entry.savedAt, ...extra }, maxSeq, newestSlot };
	}
	return { recovery: { kind: "stale", backupText: backupOf(newest.entry, newest.file) }, maxSeq, newestSlot };
}
