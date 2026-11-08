/**
 * 0.21 (roadmap #127): one backup run, from "flush the open notebooks" to "old backups trimmed". Pure orchestration over a
 * `BackupPorts` object (no 'obsidian' import, tested in Node with an in-memory vault); the service (backup-service.ts) supplies
 * the real ports.
 *
 * The order is what keeps data safe:
 *  1. open notebooks are flushed through the views' own save path, then every file is read as it is on disk;
 *  2. the zip is built in memory, then checked (structure and every CRC) BEFORE anything is written;
 *  3. it is written under a temporary name, its size is checked, and only then renamed to the final name;
 *  4. only after the new backup is in place are old ones trimmed: only `planRetention` names, never the one just written, and
 *     only files whose zip comment carries the plugin's marker.
 * A run that fails at any step leaves the older backups exactly as they were.
 *
 * It yields to the interface between files and every YIELD_BYTES bytes, so a large vault does not freeze the app.
 */
import { readZip, safeEntryName, verifyZipEntry, ZipError, ZipWriter } from "../model/zip";
import { NOTEBOOK_EXTENSIONS } from "./format";
import { isInTrash } from "./trash-paths";
import {
	backupFileName, backupFolderConflict, isTempName, looksNotDownloaded, parseBackupName, planBackupFiles, planRetention, tempName,
	type BackupResult, type FolderChild, type VaultFileInfo,
} from "./backup-logic";

/** Work done between two yields to the interface. */
export const YIELD_BYTES = 8 * 1024 * 1024;
/** And at most this many files between two yields. */
export const YIELD_FILES = 25;
/** The marker in the zip comment: tells what wrote the archive. */
export const ZIP_COMMENT = "notebook-plugin-backup 1";
const ZIP_COMMENT_KIND = "notebook-plugin-backup";
const END_SIGNATURE = 0x06054b50;

/**
 * Whether `bytes` is a zip whose end-of-central-directory record carries our comment marker (review W21 D4). Looks only at the
 * tail, and only at a record whose comment runs exactly to the end of the file, so a marker inside a stored entry does not count.
 */
export function hasBackupMarker(bytes: Uint8Array): boolean {
	const END_FIXED = 22;
	if (bytes.length < END_FIXED) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const first = Math.max(0, bytes.length - END_FIXED - 0xffff);
	for (let at = bytes.length - END_FIXED; at >= first; at--) {
		if (view.getUint32(at, true) !== END_SIGNATURE) continue;
		const len = view.getUint16(at + 20, true);
		if (at + END_FIXED + len !== bytes.length) continue;
		const comment = new TextDecoder().decode(bytes.subarray(at + END_FIXED, at + END_FIXED + len));
		return comment.startsWith(ZIP_COMMENT_KIND);
	}
	return false;
}

export interface BackupPorts {
	now(): number;
	/** Every file of the vault. */
	files(): VaultFileInfo[];
	/** The bytes of a vault file as they are on disk; throws when it cannot be read. */
	read(path: string): Promise<Uint8Array>;
	/** Size and modification time of a vault file now, or null when there is none. */
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
	/** The bytes of an old backup, to check it is ours before it is trashed; throws when it cannot be read (or is too big to). */
	readOld(path: string): Promise<Uint8Array>;
	/** Whether this device's record says the plugin wrote the file (for a leftover temporary file, which has no end record). */
	writtenByPlugin(path: string): boolean;
	/** Saves what the open notebooks hold unsaved. Never throws (a failure just means the file on disk is backed up as it is). */
	flush(): Promise<void>;
	/** Direct children of the backup folder (empty when it does not exist). */
	children(): FolderChild[];
	ensureFolder(): Promise<void>;
	/** Whether anything (file or folder) is at the path. */
	exists(path: string): boolean;
	/** Creates a new file; throws if the path is taken. */
	write(path: string, bytes: Uint8Array): Promise<void>;
	/** Size in bytes of the file at the path, or null when there is none. */
	sizeOf(path: string): Promise<number | null>;
	rename(from: string, to: string): Promise<void>;
	/** Moves a file to the trash (Obsidian's `trashFile`: the user's "Deleted files" setting decides what that means). */
	trash(path: string): Promise<void>;
	/** Gives the interface a turn. */
	breathe(): Promise<void>;
	progress?(done: number, total: number): void;
	cancelled?(): boolean;
}

export interface BackupConfig {
	notebooksFolder: string;
	folder: string;
	keep: number;
	/** Most bytes one backup may hold in memory. */
	maxBytes: number;
	/** The templates settings (as stored, "" for the default), so the backup folder is checked against them. */
	templatesFolder?: string;
	notebookTemplatesFolder?: string;
}

function failed(ports: BackupPorts, error: string, extra: Partial<BackupResult> = {}): BackupResult {
	return { at: ports.now(), outcome: "failed", files: 0, bytes: 0, skipped: 0, trashed: 0, name: "", error: error.slice(0, 300), ...extra };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isNotebook = (path: string): boolean => NOTEBOOK_EXTENSIONS.includes(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

/** A per-device `_meta` sidecar: rewritten in place, so it gets the same stability check as a notebook (review W21 N4). */
const isMetaSidecar = (path: string): boolean => /(?:^|\/)_meta\//u.test(path);

const CONFLICT_TEXT = {
	notebooks: "is the notebooks folder or overlaps it",
	templates: "overlaps a templates folder",
	"holds-notebooks": "holds notebooks",
} as const;

/**
 * Reads a file and makes sure it did not change while it was read (review W21 D5): a notebook is saved by the open views while
 * the backup runs, and a write can overlap the read. The file's size and modification time are compared before and after; if
 * they differ the file is read once more, and a file that is still changing throws (the caller skips it and the backup is
 * marked partial). Notebooks and the `_meta` sidecars (rewritten in place) are checked: assets are written once and never change in place.
 */
async function readStable(path: string, ports: BackupPorts): Promise<Uint8Array> {
	if (!isNotebook(path) && !isMetaSidecar(path)) return ports.read(path);
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = await ports.stat(path);
		const bytes = await ports.read(path);
		const after = await ports.stat(path);
		if (before !== null && after !== null && before.size === after.size && before.mtime === after.mtime && bytes.length === after.size) return bytes;
		if (before === null || after === null) throw new Error("the file disappeared while it was read");
	}
	throw new Error("the file changed while it was read");
}

/** Runs one backup. Never throws: the answer says what happened. */
export async function runBackup(cfg: BackupConfig, ports: BackupPorts): Promise<BackupResult> {
	try {
		return await run(cfg, ports);
	} catch (e) {
		return failed(ports, message(e));
	}
}

async function run(cfg: BackupConfig, ports: BackupPorts): Promise<BackupResult> {
	try {
		await ports.flush();
	} catch (e) {
		console.error("[notebook] backup: flushing the open notebooks failed; backing up the files as they are on disk", e);
	}

	const vaultFiles = ports.files();
	// A backup folder that overlaps the notebooks (or holds some) would hide them and leave them out of the zip: never "ok".
	const conflict = backupFolderConflict(cfg.folder, { notebooksFolder: cfg.notebooksFolder, templatesFolder: cfg.templatesFolder ?? "", notebookTemplatesFolder: cfg.notebookTemplatesFolder ?? "" }, vaultFiles.map((f) => f.path));
	if (conflict) return failed(ports, `the backup folder "${cfg.folder}" ${CONFLICT_TEXT[conflict]}; choose another folder in the settings`);
	const plan = planBackupFiles(vaultFiles, cfg.notebooksFolder, cfg.folder);
	if (plan.bytes > cfg.maxBytes) {
		return failed(ports, `too large for one backup on this device: ${Math.ceil(plan.bytes / 1048576)} MB (limit ${Math.floor(cfg.maxBytes / 1048576)} MB)`);
	}
	if (plan.include.length === 0 || !plan.include.some((f) => isNotebook(f.path))) {
		// Nothing to copy is fine for a vault without notebooks, but not when the vault has some that the plan left out.
		if (vaultFiles.some((f) => isNotebook(f.path) && !isInTrash(f.path) && !/(^|\/)_backup(\/|$)/.test(f.path))) return failed(ports, "no notebook file was selected for the backup");
		if (plan.include.length === 0) return { ...failed(ports, ""), outcome: "ok" };
	}

	// ---- 1. read everything as it is on disk
	const zip = new ZipWriter();
	let skipped = 0;
	let sinceYield = 0;
	let filesSinceYield = 0;
	for (let i = 0; i < plan.include.length; i++) {
		const f = plan.include[i]!;
		if (ports.cancelled?.()) return failed(ports, "cancelled");
		ports.progress?.(i, plan.include.length);
		if (safeEntryName(f.path) === null) {
			skipped++;
			continue;
		}
		try {
			const bytes = await readStable(f.path, ports);
			// A notebook a sync client has not finished downloading is not a copy worth keeping (and is not damage either).
			if (isNotebook(f.path) && looksNotDownloaded(bytes)) throw new Error("not downloaded yet");
			zip.add(f.path, bytes, f.mtime);
			sinceYield += bytes.length;
		} catch (e) {
			// A ZipError that is about the archive as a whole (too many files, too much data) ends the run; a file that cannot be read is skipped and counted.
			if (e instanceof ZipError && /too (many|much)/.test(e.message)) return failed(ports, e.message);
			console.error(`[notebook] backup: could not read "${f.path}"`, e);
			skipped++;
		}
		filesSinceYield++;
		if (sinceYield >= YIELD_BYTES || filesSinceYield >= YIELD_FILES) {
			sinceYield = 0;
			filesSinceYield = 0;
			await ports.breathe();
		}
	}
	if (zip.count === 0) return failed(ports, "no file could be read", { skipped });
	const files = zip.count;
	const bytes = zip.finish(`${ZIP_COMMENT}; files=${files}; skipped=${skipped}`);

	// ---- 2. check it before it is written
	const bad = await check(bytes, files, ports);
	if (bad) return failed(ports, bad, { skipped });
	if (ports.cancelled?.()) return failed(ports, "cancelled", { skipped });

	// ---- 3. write under a temporary name, check the size, rename
	const partial = skipped > 0;
	const dir = cfg.folder;
	// A stamp is taken when either kind of name (complete / partial), or a temporary file, already uses it.
	const taken = (t: number): boolean => [false, true].some((p) => {
		const n = backupFileName(t, p);
		return ports.exists(`${dir}/${n}`) || ports.exists(`${dir}/${tempName(n)}`);
	});
	let at = ports.now();
	for (let tries = 0; tries < 20 && taken(at); tries++) at += 1000;
	if (taken(at)) return failed(ports, "no free name for the backup", { skipped });
	const finalName = backupFileName(at, partial);
	const temp = tempName(finalName);
	await ports.ensureFolder();
	await ports.write(`${dir}/${temp}`, bytes);
	const written = await ports.sizeOf(`${dir}/${temp}`);
	if (written !== bytes.length) {
		// Our own temporary file, written a moment ago: safe to remove.
		await ports.trash(`${dir}/${temp}`).catch(() => undefined);
		return failed(ports, `the file written is ${written ?? "missing"} bytes, expected ${bytes.length}`, { skipped });
	}
	await ports.rename(`${dir}/${temp}`, `${dir}/${finalName}`);

	// ---- 4. only now trim the old ones
	const trashed = await trim(cfg, ports, at, finalName);
	return { at: ports.now(), outcome: partial ? "partial" : "ok", files, bytes: bytes.length, skipped, trashed, name: finalName, error: partial ? `${skipped} file(s) could not be read` : "" };
}

/** Structure and every CRC of the finished archive. Returns a problem text, or null when it is sound. */
async function check(bytes: Uint8Array, expected: number, ports: BackupPorts): Promise<string | null> {
	try {
		const listing = readZip(bytes);
		if (listing.entries.length !== expected) return `the archive lists ${listing.entries.length} files, expected ${expected}`;
		let since = 0;
		for (const entry of listing.entries) {
			if (!verifyZipEntry(bytes, entry)) return `checksum mismatch for "${entry.name}"`;
			since += entry.size;
			if (since >= YIELD_BYTES) {
				since = 0;
				await ports.breathe();
			}
		}
		return null;
	} catch (e) {
		return `the archive did not pass its check: ${message(e)}`;
	}
}

/** Trashes the old backups and the stale temporary files the retention names; returns how many backups were trashed. */
async function trim(cfg: BackupConfig, ports: BackupPorts, now: number, finalName: string): Promise<number> {
	let trashed = 0;
	try {
		const plan = planRetention(ports.children(), cfg.keep, now, "", finalName);
		for (const old of plan.trash) {
			// Belt and braces: the name is checked again right before the call, and so is the zip comment the plugin writes (review
			// W21 D4): a file the user copied here under a backup's name carries no marker and is left alone.
			if (!old.file || parseBackupName(old.name) === null || old.path !== `${cfg.folder}/${old.name}`) continue;
			try {
				// Review W21 N2: an old backup bigger than the device cap (it came from a bigger device) is never read, so never trashed.
				const size = await ports.sizeOf(old.path);
				if (size === null || size > cfg.maxBytes) continue;
				if (!hasBackupMarker(await ports.readOld(old.path))) continue;
				await ports.trash(old.path);
				trashed++;
			} catch (e) {
				console.error(`[notebook] backup: could not trash the old backup "${old.path}"`, e);
			}
		}
		for (const temp of plan.staleTemps) {
			// An interrupted write may have no end record to look at: a temporary file is removed only when it carries the marker or
			// this device's record says the plugin wrote it.
			if (!temp.file || !isTempName(temp.name) || temp.path !== `${cfg.folder}/${temp.name}`) continue;
			if (!ports.writtenByPlugin(temp.path)) {
				const size = await ports.sizeOf(temp.path).catch(() => null);
				if (size === null || size > cfg.maxBytes || !(await ports.readOld(temp.path).then(hasBackupMarker, () => false))) continue;
			}
			await ports.trash(temp.path).catch((e) => console.error(`[notebook] backup: could not trash "${temp.path}"`, e));
		}
	} catch (e) {
		console.error("[notebook] backup: trimming the old backups failed", e);
	}
	return trashed;
}
