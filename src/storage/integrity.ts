/**
 * Integrity check with checksums (roadmap M17 #390, extends #27). No Obsidian imports, so it is testable in Node.
 *
 * Problem: a sync client (Google Drive, OneDrive, Syncthing, ...) can silently damage a notebook: truncate it, mangle
 * it, or put back an older version over a newer one. The session already refuses to write a file that does not parse;
 * this module notices the cases where the file still parses but is not what this device last wrote although nothing
 * explains the change, and checks every notebook on demand.
 *
 * Per-device ledger (`IntegrityLedger`): after every verified write the session reports the text, and the ledger keeps,
 * per vault path, the last few versions this device wrote: fingerprint of the whole text, fingerprint of the content
 * part (assets and pages, without the metadata and reading position lines), document id, `modifiedAt` and the time.
 * It lives in the device's local storage (never synced, so another device's writes can never look like ours).
 *
 * Verdict for the text found on disk (`assessDisk`), from the strongest evidence only, so that a normal edit synced
 * from another device is never flagged:
 * - `intact`: it is what this device wrote last;
 * - `unreadable`: it differs and does not parse (the view shows the broken page with Repair, as before);
 * - `rolled-back`: it is exactly an *older* version this device wrote (a sync client restored a stale copy). A normal
 *   edit on another device always has a new `modifiedAt` and new content, so it can never match an older version of
 *   ours. A restore from version history (a `before-restore` backup of this notebook made after our last write) explains it;
 * - `altered`: same document, same `modifiedAt` as our last write, but different content (assets or pages). Every
 *   content edit by this plugin sets a new `modifiedAt`; only metadata patches (tags, favourite, from the library) keep
 *   it, and those do not change the content part;
 * - `changed`: anything else (another device's edit, another notebook, a newer format, a clock running behind):
 *   never flagged;
 * - `unknown`: this device never wrote this file.
 * Nothing is ever restored automatically: the view offers the actions and the user chooses.
 */
import { parse, serialize, serializeChecked, type ParseFailure } from "../model/serialize";
import type { Asset, NotebookDocument } from "../model/types";
import { fingerprint } from "./journal";
import { backupDate, isBackupOf } from "./recovery";
import type { LocalSlot } from "./safe-mode";

/** Versions kept per notebook. */
export const RING_SIZE = 5;
/** Notebooks kept at most (the least recently written go first). */
export const MAX_LEDGER_FILES = 200;
const STORE_VERSION = 1;
/** Writes are saved to local storage at most this often. */
export const LEDGER_SAVE_DELAY_MS = 2000;

export interface WrittenRecord {
	/** Fingerprint of the whole document text. */
	fp: string;
	/** Fingerprint of the content part (from the "assets" line on). */
	body: string;
	id: string;
	modifiedAt: string;
	/** When this device wrote it (ms since epoch). */
	at: number;
}

const ASSETS_MARK = '\n\t"assets": ';

/** Fingerprint of the content part of a serialized notebook: assets and pages, not the metadata or reading position. */
export function bodyFingerprint(text: string): string {
	const i = text.indexOf(ASSETS_MARK);
	return fingerprint(i < 0 ? text : text.slice(i));
}

/** A top-level string field near the top of a serialized notebook (where the serializer writes it), or null. */
export function headerField(text: string, name: "id" | "modifiedAt"): string | null {
	const head = text.slice(0, 2000);
	const m = new RegExp(`\\n\\t"${name}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(head);
	return m?.[1] ?? null;
}

/** Ledger record of a text this device just wrote; null if it is not a serialized notebook. */
export function writtenRecord(text: string, at: number): WrittenRecord | null {
	const id = headerField(text, "id");
	const modifiedAt = headerField(text, "modifiedAt");
	if (id === null || modifiedAt === null) return null;
	return { fp: fingerprint(text), body: bodyFingerprint(text), id, modifiedAt, at };
}

function isRecord(v: unknown): v is WrittenRecord {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.fp === "string" && typeof r.body === "string" && typeof r.id === "string" && typeof r.modifiedAt === "string"
		&& typeof r.at === "number";
}

/** Per-device record of what this device last wrote to each notebook. */
export class IntegrityLedger {
	private readonly files = new Map<string, WrittenRecord[]>();
	private saveTimer: number | null = null;

	constructor(
		private readonly slot: LocalSlot,
		private readonly now: () => number = () => Date.now(),
		/** Schedules the throttled save; without it every change is saved at once. */
		private readonly defer: ((fn: () => void, ms: number) => number) | null = null,
	) {
		let raw: unknown = null;
		try {
			raw = slot.load();
		} catch (e) {
			console.error("[notebook] could not read the integrity ledger", e);
		}
		if (typeof raw === "object" && raw !== null && (raw as { v?: unknown }).v === STORE_VERSION) {
			const files = (raw as { files?: unknown }).files;
			if (typeof files === "object" && files !== null) {
				for (const [path, list] of Object.entries(files as Record<string, unknown>)) {
					if (!Array.isArray(list)) continue;
					const records = list.filter(isRecord).slice(0, RING_SIZE);
					if (records.length > 0) this.files.set(path, records);
				}
			}
		}
	}

	/** Newest first. */
	records(path: string): readonly WrittenRecord[] {
		return this.files.get(path) ?? [];
	}

	/** This device wrote `text` to `path` (and read it back). */
	recordWrite(path: string, text: string): void {
		const record = writtenRecord(text, this.now());
		if (record) this.push(path, record);
	}

	private push(path: string, record: WrittenRecord): void {
		const list = (this.files.get(path) ?? []).filter((r) => r.fp !== record.fp);
		list.unshift(record);
		this.files.delete(path);
		this.files.set(path, list.slice(0, RING_SIZE));
		while (this.files.size > MAX_LEDGER_FILES) {
			let oldest: string | null = null;
			let at = Infinity;
			for (const [p, l] of this.files) if ((l[0]?.at ?? 0) < at) [oldest, at] = [p, l[0]?.at ?? 0];
			if (oldest === null) break;
			this.files.delete(oldest);
		}
		this.scheduleSave();
	}

	/** "Keep this version": the parseable text now on disk becomes the reference, so it is not reported again. */
	accept(path: string, text: string): void {
		const parsed = parse(text);
		if (!parsed.ok) return;
		const doc = parsed.doc;
		this.push(path, { fp: fingerprint(text), body: bodyFingerprint(serialize(doc)), id: doc.id, modifiedAt: doc.modifiedAt, at: this.now() });
	}

	rename(oldPath: string, newPath: string): void {
		const list = this.files.get(oldPath);
		if (!list) return;
		this.files.delete(oldPath);
		this.files.set(newPath, list);
		this.scheduleSave();
	}

	forget(path: string): void {
		if (this.files.delete(path)) this.scheduleSave();
	}

	/** Saves now (plugin unload). */
	flush(): void {
		this.saveTimer = null;
		try {
			this.slot.save({ v: STORE_VERSION, files: Object.fromEntries(this.files) });
		} catch (e) {
			console.error("[notebook] could not store the integrity ledger", e);
		}
	}

	private scheduleSave(): void {
		if (!this.defer) return this.flush();
		if (this.saveTimer !== null) return;
		this.saveTimer = this.defer(() => this.flush(), LEDGER_SAVE_DELAY_MS);
	}
}

export type IntegrityVerdict =
	| { kind: "unknown" }
	| { kind: "intact" }
	| { kind: "changed" }
	| { kind: "unreadable"; lastWrite: WrittenRecord }
	| { kind: "rolled-back"; lastWrite: WrittenRecord; version: WrittenRecord }
	| { kind: "altered"; lastWrite: WrittenRecord };

/** The flagged verdicts: the ones the view reports. */
export function isSuspicious(v: IntegrityVerdict): v is Extract<IntegrityVerdict, { kind: "unreadable" | "rolled-back" | "altered" }> {
	return v.kind === "unreadable" || v.kind === "rolled-back" || v.kind === "altered";
}

/** The document text found on disk, and what parsing it gave. */
export interface DiskState {
	text: string;
	doc: NotebookDocument | null;
	failure: ParseFailure | null;
}

/** Compares two `modifiedAt` stamps: <0 when `a` is older. ISO strings compare as text; other formats by Date.parse. */
function compareStamps(a: string, b: string): number {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Verdict for the text on disk against what this device wrote (`records`, newest first). `explainedByRestore` is asked
 * only for a stale or altered version: true when a version-history restore of this notebook happened after our last write.
 */
export function assessDisk(records: readonly WrittenRecord[], disk: DiskState, explainedByRestore: (since: number) => boolean = () => false): IntegrityVerdict {
	const last = records[0];
	if (!last) return { kind: "unknown" };
	const fp = fingerprint(disk.text);
	if (fp === last.fp) return { kind: "intact" };
	const doc = disk.doc;
	if (!doc) {
		// Written by a newer version of the plugin (another device): not damage.
		if (disk.failure === "future-version") return { kind: "changed" };
		return { kind: "unreadable", lastWrite: last };
	}
	if (doc.id !== last.id) return { kind: "changed" };
	const older = records.slice(1).find((r) => r.fp === fp);
	if (older && compareStamps(doc.modifiedAt, last.modifiedAt) < 0) {
		return explainedByRestore(last.at) ? { kind: "changed" } : { kind: "rolled-back", lastWrite: last, version: older };
	}
	if (doc.modifiedAt === last.modifiedAt) {
		// Same edit stamp: only a metadata patch may differ. Compare the content part in our canonical form (re-serialized,
		// so a file written by another serializer version with the same content is not reported).
		if (bodyFingerprint(serialize(doc)) === last.body) return { kind: "changed" };
		return explainedByRestore(last.at) ? { kind: "changed" } : { kind: "altered", lastWrite: last };
	}
	return { kind: "changed" };
}

/** Restore-backup file names are `<basename> <YYYYMMDD-HHmmss> before-restore [n ]<hash>.bak` (VaultDocumentIO.backup). */
export function restoredSince(backupNames: readonly string[], basename: string, since: number): boolean {
	// Backup names have second resolution and local time; allow a minute of slack.
	for (const name of backupNames) {
		if (!isBackupOf(name, basename) || !/ before-restore (?:\d+ )?[0-9a-f]{8}\.bak$/.test(name)) continue;
		const d = backupDate(name);
		if (d && d.getTime() >= since - 60_000) return true;
	}
	return false;
}

// ------------------------------------------------------------------ check of all notebooks

export type IssueKind =
	/** The file does not parse. */
	| "unreadable"
	/** Written by a newer version: cannot be checked here. */
	| "future-version"
	/** It parses but does not pass the save check (validation and round trip). */
	| "invalid"
	| "rolled-back"
	| "altered"
	/** An asset listed by the notebook has no file in the vault. */
	| "missing-asset"
	/** An asset file has another size than the notebook recorded (often a truncated sync). */
	| "damaged-asset";

export interface IntegrityIssue {
	kind: IssueKind;
	/** Parse error, asset name, or the date of the version found. */
	detail?: string;
}

export interface NotebookCheck {
	docId: string | null;
	pages: number;
	issues: IntegrityIssue[];
}

export interface CheckOptions {
	records?: readonly WrittenRecord[];
	/** Size of the vault file of an asset, or null when there is none. */
	assetFile(asset: Asset): { size: number } | null;
	explainedByRestore?: (since: number) => boolean;
}

/** Full check of one notebook's document text: parse, validation, ledger verdict, asset files. */
export function checkNotebookText(text: string, options: CheckOptions): NotebookCheck {
	const parsed = parse(text);
	if (!parsed.ok) {
		const issues: IntegrityIssue[] = [{ kind: parsed.reason === "future-version" ? "future-version" : "unreadable", detail: parsed.message }];
		return { docId: headerField(text, "id"), pages: 0, issues };
	}
	const doc = parsed.doc;
	const issues: IntegrityIssue[] = [];
	const checked = serializeChecked(doc, true);
	if (!checked.ok) issues.push({ kind: "invalid", detail: checked.message });
	const verdict = assessDisk(options.records ?? [], { text, doc, failure: null }, options.explainedByRestore);
	if (verdict.kind === "rolled-back") issues.push({ kind: "rolled-back", detail: new Date(verdict.version.at).toISOString() });
	else if (verdict.kind === "altered") issues.push({ kind: "altered", detail: new Date(verdict.lastWrite.at).toISOString() });
	for (const asset of Object.values(doc.assets ?? {})) {
		const file = options.assetFile(asset);
		if (!file) issues.push({ kind: "missing-asset", detail: asset.name || asset.id });
		else if (asset.bytes > 0 && file.size !== asset.bytes) issues.push({ kind: "damaged-asset", detail: asset.name || asset.id });
	}
	return { docId: doc.id, pages: doc.pages.length, issues };
}
