/**
 * 0.21 (roadmap #127): scheduled backups of the notebooks to a zip in a vault folder. Pure logic, no 'obsidian' import (tested
 * in Node): the settings, the file names, when a backup is due, which files go in, which old backups may be trashed.
 *
 * DATA SAFETY, in one place:
 *  - A backup is a COPY. Nothing here changes a notebook, an asset or a sidecar.
 *  - The only files this feature ever trashes are old backups that carry its own strict name (`planRetention`): direct children
 *    of the backup folder named `Notebook backup YYYYMMDD-HHmmss[ partial].zip`. Anything else in that folder (the user's
 *    own files, other zips, subfolders, a name that merely looks similar) is never listed for removal.
 *  - The newest COMPLETE backup is never trashed to make room, even when newer partial ones fill the quota.
 *  - "External folder" means a folder of the vault: the plugin has no Node or Electron access (it runs on Android). The user
 *    can point the folder at one that their own sync tool copies elsewhere.
 */
import { NOTEBOOK_EXTENSIONS } from "./format";
import { isInTrash, isWithin, notebookTemplatesFolderPath, templatesFolderPath } from "./trash-paths";
import { isReservedPath } from "../library/folders";
import { cleanFolder } from "./pdf-copy-logic";

export const BACKUP_SCHEDULES = ["off", "daily", "weekly"] as const;
export type BackupSchedule = (typeof BACKUP_SCHEDULES)[number];

export interface BackupSettings {
	/** How often a backup is made while Obsidian is open. Off by default. */
	zipBackupSchedule: BackupSchedule;
	/** Vault folder the zip files go to. */
	zipBackupFolder: string;
	/** How many backups are kept (the older ones are trashed). */
	zipBackupKeep: number;
}

export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 30;
export const DEFAULT_BACKUP_FOLDER = "Notebook backups";
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { zipBackupSchedule: "off", zipBackupFolder: DEFAULT_BACKUP_FOLDER, zipBackupKeep: 5 };

export function isBackupSchedule(v: unknown): v is BackupSchedule {
	return typeof v === "string" && (BACKUP_SCHEDULES as readonly string[]).includes(v);
}

export function readBackupSettings(data: Record<string, unknown>): BackupSettings {
	const s: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS };
	if (isBackupSchedule(data.zipBackupSchedule)) s.zipBackupSchedule = data.zipBackupSchedule;
	if (typeof data.zipBackupFolder === "string") s.zipBackupFolder = backupFolderOf(data.zipBackupFolder);
	const keep = data.zipBackupKeep;
	if (typeof keep === "number" && Number.isFinite(keep)) s.zipBackupKeep = Math.min(BACKUP_KEEP_MAX, Math.max(BACKUP_KEEP_MIN, Math.round(keep)));
	return s;
}

/** The backup folder as stored: cleaned, and never empty (an empty setting would mean the vault root). */
export function backupFolderOf(setting: string): string {
	return cleanFolder(setting.replace(/\\/g, "/")) || DEFAULT_BACKUP_FOLDER;
}

/** The folders a backup folder must not overlap (review W21 D2). */
export interface BackupLayout {
	notebooksFolder: string;
	templatesFolder: string;
	notebookTemplatesFolder: string;
}

export type BackupFolderConflict = "notebooks" | "templates" | "holds-notebooks";

const overlaps = (a: string, b: string) => a !== "" && b !== "" && (isWithin(a, b) || isWithin(b, a));
const NOT_BACKUP_COPY = (path: string) => !/(^|\/)_backup(\/|$)/.test(path);
const isNotebookFile = (path: string) => NOTEBOOK_EXTENSIONS.includes(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) && !isInTrash(path) && NOT_BACKUP_COPY(path);

/**
 * Why `backupFolder` cannot be the backup folder, or null when it can. A backup folder is hidden from the library, the API, the
 * update links and the companion service, and its files are left out of every backup. So it must not be the notebooks folder,
 * contain it, or lie inside it (that covers `_assets`, `_trash`, `_meta`), must not overlap a templates folder, and must not hold
 * a notebook file (`filePaths`: paths of the vault's files; only notebook files count). With the notebooks folder at the vault
 * root only the reserved subfolders and the notebook files are checked.
 */
export function backupFolderConflict(backupFolder: string, layout: BackupLayout, filePaths: readonly string[] = []): BackupFolderConflict | null {
	const b = cleanFolder(backupFolder.replace(/\\/g, "/"));
	if (b === "") return "notebooks";
	const root = cleanFolder(layout.notebooksFolder.replace(/\\/g, "/"));
	if (overlaps(b, root) || (root === "" && isReservedPath(b, ""))) return "notebooks";
	if (overlaps(b, templatesFolderPath(layout.templatesFolder, root)) || overlaps(b, notebookTemplatesFolderPath(layout.notebookTemplatesFolder, layout.templatesFolder, root))) return "templates";
	if (filePaths.some((p) => isNotebookFile(p) && isWithin(p, b))) return "holds-notebooks";
	return null;
}

// ------------------------------------------------------------------------------------------------------------- names

export const BACKUP_NAME_PREFIX = "Notebook backup ";
const BACKUP_NAME = /^Notebook backup (\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})( partial)?\.zip$/;
const TEMP_SUFFIX = ".tmp";
/** A temporary file older than this is the leftover of a run that was interrupted. */
export const STALE_TEMP_MS = 3 * 3_600_000;

const p2 = (n: number) => String(n).padStart(2, "0");

/** `Notebook backup 20261105-101500.zip` (local time); `partial` marks a backup made while some files could not be read. */
export function backupFileName(at: number, partial = false): string {
	const d = new Date(at);
	return `${BACKUP_NAME_PREFIX}${String(d.getFullYear()).padStart(4, "0")}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${partial ? " partial" : ""}.zip`;
}

export interface ParsedBackup {
	/** When the backup was made (from its name, local time), epoch ms. */
	at: number;
	partial: boolean;
}

/** The parts of a backup file name, or null when the name is not exactly one of ours (an impossible date counts as not ours). */
export function parseBackupName(name: string): ParsedBackup | null {
	const m = BACKUP_NAME.exec(name);
	if (!m) return null;
	const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
	const date = new Date(y, mo - 1, d, h, mi, s);
	// new Date rolls an impossible date over (month 13, 31 February): that is not a name we wrote.
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) return null;
	return { at: date.getTime(), partial: m[7] !== undefined };
}

/** The name a backup is written under before it is renamed to its final name. */
export function tempName(finalName: string): string {
	return finalName + TEMP_SUFFIX;
}

/** Whether `name` is the temporary name of one of our backups (left behind when a run was interrupted). */
export function isTempName(name: string): boolean {
	return name.endsWith(TEMP_SUFFIX) && parseBackupName(name.slice(0, -TEMP_SUFFIX.length)) !== null;
}

// -------------------------------------------------------------------------------------------------------------- due

export const DAY_MS = 86_400_000;
export const INTERVAL_MS: Readonly<Record<Exclude<BackupSchedule, "off">, number>> = { daily: DAY_MS, weekly: 7 * DAY_MS };
/** After a failed run the next try waits this long (the schedule is not hammered by a full disk). */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** Never two runs closer than this, whatever else says (a clock that jumped, a synced setting). */
export const MIN_GAP_MS = 5 * 60_000;

export type BackupOutcome = "ok" | "partial" | "failed";

/** What a run left behind, shown in the settings. */
export interface BackupResult {
	/** When the run ended, epoch ms. */
	at: number;
	outcome: BackupOutcome;
	/** Files in the zip. */
	files: number;
	/** Size of the zip file, bytes. */
	bytes: number;
	/** Files that could not be read or named and are not in the zip. */
	skipped: number;
	/** Old backups moved to the trash by the retention. */
	trashed: number;
	/** File name of the zip (empty when none was written). */
	name: string;
	/** Why it failed (short, empty when it did not). */
	error: string;
}

/** What is remembered on this device between runs. */
export interface BackupMemory {
	/** End time of the last run that wrote a backup (ok or partial). */
	lastOkAt: number | null;
	/** End time of the last run of any outcome. */
	lastAttemptAt: number | null;
	last: BackupResult | null;
}

export const EMPTY_MEMORY: BackupMemory = { lastOkAt: null, lastAttemptAt: null, last: null };
export const BACKUP_MEMORY_KEY = "notebook-zip-backup-last";

const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Whatever was stored, as a valid memory: anything unreadable gives the empty one (a first run), never an exception. */
export function normaliseMemory(data: unknown): BackupMemory {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ...EMPTY_MEMORY };
	const d = data as Record<string, unknown>;
	let last: BackupResult | null = null;
	const r = d.last;
	if (typeof r === "object" && r !== null) {
		const o = r as Record<string, unknown>;
		const at = time(o.at);
		if (at !== null && (o.outcome === "ok" || o.outcome === "partial" || o.outcome === "failed")) {
			last = { at, outcome: o.outcome, files: count(o.files), bytes: count(o.bytes), skipped: count(o.skipped), trashed: count(o.trashed), name: text(o.name, 200), error: text(o.error, 300) };
		}
	}
	return { lastOkAt: time(d.lastOkAt), lastAttemptAt: time(d.lastAttemptAt), last };
}

/** The memory after a run ended. */
export function remember(memory: BackupMemory, result: BackupResult): BackupMemory {
	return { lastOkAt: result.outcome === "failed" ? memory.lastOkAt : result.at, lastAttemptAt: result.at, last: result };
}

/** The time of the newest backup in `names` (file names of the backup folder), or null. Includes backups other devices made. */
export function newestBackupAt(names: readonly string[]): number | null {
	let newest: number | null = null;
	for (const n of names) {
		const p = parseBackupName(n);
		if (p && (newest === null || p.at > newest)) newest = p.at;
	}
	return newest;
}

/**
 * Whether a scheduled backup should run now. The reference time is the newest of what this device remembers and the newest
 * backup found in the folder (so a backup another device made, and a sync brought here, counts: two devices do not both back
 * up the same day). A time in the future (a clock that was wrong) is ignored, not trusted, so it never blocks backups for years.
 * After a failure the next try waits RETRY_AFTER_FAILURE_MS.
 */
export function isDue(schedule: BackupSchedule, memory: BackupMemory, newestInFolder: number | null, now: number): boolean {
	if (schedule === "off") return false;
	const sane = (t: number | null): number | null => (t !== null && t <= now + 60_000 ? t : null);
	const attempt = sane(memory.lastAttemptAt);
	if (attempt !== null && now - attempt < MIN_GAP_MS) return false;
	if (attempt !== null && memory.last?.outcome === "failed" && now - attempt < RETRY_AFTER_FAILURE_MS) return false;
	const times = [sane(memory.lastOkAt), sane(newestInFolder)].filter((t): t is number => t !== null);
	if (times.length === 0) return true;
	return now - Math.max(...times) >= INTERVAL_MS[schedule];
}

/** When the next scheduled backup is due, epoch ms (null when off). For the settings text. */
export function nextDueAt(schedule: BackupSchedule, memory: BackupMemory, newestInFolder: number | null): number | null {
	if (schedule === "off") return null;
	const times = [memory.lastOkAt, newestInFolder].filter((t): t is number => t !== null);
	return times.length === 0 ? 0 : Math.max(...times) + INTERVAL_MS[schedule];
}

// ------------------------------------------------------------------------------------------------------------ files

export interface VaultFileInfo {
	path: string;
	size: number;
	mtime: number;
}

export interface BackupPlan {
	include: VaultFileInfo[];
	/** Sum of the sizes of `include`. */
	bytes: number;
}

/**
 * Whether a notebook file's bytes are what a sync client leaves before the content has arrived: nothing, only whitespace or NUL
 * bytes (same rule as storage/sync-state.ts `isAwaitingDownload`), or a NUL tail (space reserved after the content).
 */
export function looksNotDownloaded(bytes: Uint8Array): boolean {
	if (bytes.length === 0 || bytes[bytes.length - 1] === 0) return true;
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		if (b !== 0 && b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false;
	}
	return true;
}

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, "");
const within = (path: string, folder: string) => folder === "" || path === folder || path.startsWith(`${folder}/`);

/**
 * Which files of the vault go in a backup: every notebook file (wherever it is, except the plugin trash and the `_backup`
 * copies), and everything inside the notebooks folder's `_assets` (pictures and PDFs) and `_meta` (per-device sidecars). The
 * backup folder itself is never included, wherever it is, so a backup never contains the older ones.
 */
export function planBackupFiles(files: readonly VaultFileInfo[], notebooksFolder: string, backupFolder: string): BackupPlan {
	const root = trimSlashes(notebooksFolder);
	const own = trimSlashes(backupFolder);
	const dot = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const under = (path: string, dir: string) => within(path, root === "" ? dir : `${root}/${dir}`);
	const include: VaultFileInfo[] = [];
	let bytes = 0;
	for (const f of files) {
		if (own !== "" && within(f.path, own)) continue;
		if (isInTrash(f.path)) continue;
		const notebook = NOTEBOOK_EXTENSIONS.includes(dot(f.path)) && !under(f.path, "_backup");
		const asset = under(f.path, "_assets");
		const meta = under(f.path, "_meta");
		if (!notebook && !asset && !meta) continue;
		include.push(f);
		bytes += f.size;
	}
	include.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { include, bytes };
}

// --------------------------------------------------------------------------------------------------------- retention

export interface FolderChild {
	name: string;
	path: string;
	/** A plain file (not a folder). */
	file: boolean;
}

export interface RetentionPlan {
	/** Old backups to move to the trash: ours by name, direct children of the folder, files. */
	trash: FolderChild[];
	/** Temporary files of interrupted runs (our strict temp names) to move to the trash as well. */
	staleTemps: FolderChild[];
	/** Backups kept. */
	kept: FolderChild[];
}

/**
 * What the retention may remove from the backup folder after a run. `children` are the direct children of the folder.
 * Only a plain file named exactly like a backup of ours can be listed. The newest `keep` backups stay, and so does the newest
 * complete one (a partial backup never pushes the last complete one out). `justWritten` (a file name) is always kept: names dated
 * more than a day after `now` rank as the oldest. A temporary file is listed only when its own timestamp
 * is older than STALE_TEMP_MS (another device's run may be writing one right now) and it is not `currentTemp`.
 */
export function planRetention(children: readonly FolderChild[], keep: number, now: number, currentTemp = "", justWritten = ""): RetentionPlan {
	// A name dated more than a day ahead came from a wrong clock (or a time zone far ahead): it counts as the oldest, so it can
	// neither push out nor stand in for the backup that was just written (review W21 D1).
	const rank = (at: number) => (at > now + DAY_MS ? Number.NEGATIVE_INFINITY : at);
	const ours = children
		.filter((c) => c.file && parseBackupName(c.name) !== null)
		.map((c) => ({ child: c, at: parseBackupName(c.name)!.at, partial: parseBackupName(c.name)!.partial }))
		.sort((a, b) => {
			const ra = rank(a.at);
			const rb = rank(b.at);
			if (ra !== rb) return ra > rb ? -1 : 1;
			return b.at - a.at || (a.child.name < b.child.name ? 1 : -1);
		});
	const quota = Number.isFinite(keep) ? Math.max(BACKUP_KEEP_MIN, Math.floor(keep)) : BACKUP_KEEP_MIN;
	// The backup this run just wrote always stays and counts toward the quota; the rest of the quota goes to the newest others.
	const fresh = justWritten === "" ? undefined : ours.find((o) => o.child.name === justWritten);
	const keepSet = new Set<string>();
	if (fresh) keepSet.add(fresh.child.path);
	for (const o of ours) {
		if (keepSet.size >= quota) break;
		keepSet.add(o.child.path);
	}
	const newestComplete = ours.find((o) => !o.partial);
	if (newestComplete) keepSet.add(newestComplete.child.path);
	return {
		trash: ours.filter((o) => !keepSet.has(o.child.path)).map((o) => o.child),
		staleTemps: children.filter((c) => {
			if (!c.file || !isTempName(c.name) || c.name === currentTemp) return false;
			const at = parseBackupName(c.name.slice(0, -TEMP_SUFFIX.length))!.at;
			return now - at > STALE_TEMP_MS;
		}),
		kept: ours.filter((o) => keepSet.has(o.child.path)).map((o) => o.child),
	};
}
