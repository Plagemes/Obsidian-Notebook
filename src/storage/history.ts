/**
 * Version history: pure helpers (names, retention, timing). No Obsidian imports, so it is testable
 * in Node. The vault side lives in src/integration/history-service.ts.
 *
 * Layout: `<notebooks folder>/_backup/history/<document id>/<YYYYMMDD-HHmm>.snapshot`.
 * A snapshot holds the document text of the notebook exactly as `readNotebookText` returns it (for
 * `.notebook` files that is the file content byte for byte), so it is independent of the container.
 */
import { parse } from "../model/serialize";

export const SNAPSHOT_EXTENSION = "snapshot";
const HOUR_MS = 3_600_000;

export interface SnapshotName {
	/** File name including the extension. */
	name: string;
	/** Local time encoded in the name. */
	date: Date;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** `YYYYMMDD-HHmm` in local time. */
export function snapshotStamp(d: Date): string {
	return `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function snapshotFileName(d: Date): string {
	return `${snapshotStamp(d)}.${SNAPSHOT_EXTENSION}`;
}

/** The date in a snapshot file name, or null when the name is not one of ours. */
export function parseSnapshotName(name: string): Date | null {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.snapshot$/.exec(name);
	if (!m) return null;
	const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
	const d = new Date(year, month - 1, day, hour, minute);
	// Reject impossible dates (the Date constructor rolls them over).
	if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day || d.getHours() !== hour || d.getMinutes() !== minute) return null;
	return d;
}

/** Folder name for a document id: only characters that are safe in a vault path. */
export function safeDocId(id: string): string {
	const clean = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
	return clean || "unknown";
}

/** `<notebooks folder>/_backup/history` for a backup folder (`<notebooks folder>/_backup`). */
export function historyRoot(backupFolder: string): string {
	return `${backupFolder.replace(/\/+$/, "")}/history`;
}

export function snapshotFolder(backupFolder: string, docId: string): string {
	return `${historyRoot(backupFolder)}/${safeDocId(docId)}`;
}

/** Snapshot files in a listing, newest first; other files are ignored. */
export function sortSnapshots(names: readonly string[]): SnapshotName[] {
	const out: SnapshotName[] = [];
	for (const name of names) {
		const date = parseSnapshotName(name);
		if (date) out.push({ name, date });
	}
	return out.sort((a, b) => b.date.getTime() - a.date.getTime() || (a.name < b.name ? 1 : -1));
}

/** Names of the snapshots to delete so that only the newest `keep` remain. */
export function snapshotsToPrune(names: readonly string[], keep: number): string[] {
	const n = Math.max(1, Math.floor(keep));
	return sortSnapshots(names).slice(n).map((s) => s.name);
}

/** True when a new snapshot is due: snapshots are on and the latest one is at least `intervalHours` old. */
export function shouldSnapshot(latest: Date | null, now: Date, intervalHours: number): boolean {
	if (!(intervalHours > 0)) return false;
	if (!latest) return true;
	const age = now.getTime() - latest.getTime();
	// A snapshot dated in the future (clock change) does not block new ones forever.
	if (age < 0) return true;
	// Names have minute resolution: allow one minute of slack.
	return age + 60_000 >= intervalHours * HOUR_MS;
}

/**
 * Document id of a notebook text: from a successful parse, or, for a file that does not parse, from
 * the first `"id"` near the top (the serializer writes it right after the format and version).
 */
export function extractDocId(json: string): string | null {
	const parsed = parse(json);
	if (parsed.ok) return parsed.doc.id;
	const m = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(json.slice(0, 600));
	return m?.[1] ?? null;
}

/** Page count of a snapshot's text; null when it does not parse. */
export function snapshotPageCount(json: string): number | null {
	const parsed = parse(json);
	return parsed.ok ? parsed.doc.pages.length : null;
}

/** Human-readable size ("12 KB"). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "2026-10-29 14:05" in local time. */
export function formatSnapshotDate(d: Date): string {
	return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
