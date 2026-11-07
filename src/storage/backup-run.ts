/**
 * 0.21 (roadmap #127): one backup run, from "flush the open notebooks" to "old backups trimmed". Pure orchestration over a
 * `BackupPorts` object (no 'obsidian' import, tested in Node with an in-memory vault); the service (backup-service.ts) supplies
 * the real ports.
 *
 * The order is what keeps data safe:
 *  1. open notebooks are flushed through the views' own save path, then every file is read as it is on disk;
 *  2. the zip is built in memory, then checked (structure and every CRC) BEFORE anything is written;
 *  3. it is written under a temporary name, its size is checked, and only then renamed to the final name;
 *  4. only after the new backup is in place are old ones trimmed, and only those `planRetention` names.
 * A run that fails at any step leaves the older backups exactly as they were.
 *
 * It yields to the interface between files and every YIELD_BYTES bytes, so a large vault does not freeze the app.
 */
import { readZip, safeEntryName, verifyZipEntry, ZipError, ZipWriter } from "../model/zip";
import { NOTEBOOK_EXTENSIONS } from "./format";
import {
	backupFileName, isTempName, looksNotDownloaded, parseBackupName, planBackupFiles, planRetention, tempName,
	type BackupResult, type FolderChild, type VaultFileInfo,
} from "./backup-logic";

/** Work done between two yields to the interface. */
export const YIELD_BYTES = 8 * 1024 * 1024;
/** And at most this many files between two yields. */
export const YIELD_FILES = 25;
/** The marker in the zip comment: tells what wrote the archive. */
export const ZIP_COMMENT = "notebook-plugin-backup 1";

export interface BackupPorts {
	now(): number;
	/** Every file of the vault. */
	files(): VaultFileInfo[];
	/** The bytes of a vault file as they are on disk; throws when it cannot be read. */
	read(path: string): Promise<Uint8Array>;
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
}

function failed(ports: BackupPorts, error: string, extra: Partial<BackupResult> = {}): BackupResult {
	return { at: ports.now(), outcome: "failed", files: 0, bytes: 0, skipped: 0, trashed: 0, name: "", error: error.slice(0, 300), ...extra };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

	const plan = planBackupFiles(ports.files(), cfg.notebooksFolder, cfg.folder);
	if (plan.bytes > cfg.maxBytes) {
		return failed(ports, `too large: ${Math.ceil(plan.bytes / 1048576)} MB (limit ${Math.floor(cfg.maxBytes / 1048576)} MB)`);
	}
	if (plan.include.length === 0) return { ...failed(ports, ""), outcome: "ok" };

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
			const bytes = await ports.read(f.path);
			// A notebook a sync client has not finished downloading is not a copy worth keeping (and is not damage either).
			if (NOTEBOOK_EXTENSIONS.includes(f.path.slice(f.path.lastIndexOf(".") + 1).toLowerCase()) && looksNotDownloaded(bytes)) throw new Error("not downloaded yet");
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
	const trashed = await trim(cfg, ports, at);
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
async function trim(cfg: BackupConfig, ports: BackupPorts, now: number): Promise<number> {
	let trashed = 0;
	try {
		const plan = planRetention(ports.children(), cfg.keep, now);
		for (const old of plan.trash) {
			// Belt and braces: the name is checked again right before the call.
			if (!old.file || parseBackupName(old.name) === null || old.path !== `${cfg.folder}/${old.name}`) continue;
			try {
				await ports.trash(old.path);
				trashed++;
			} catch (e) {
				console.error(`[notebook] backup: could not trash the old backup "${old.path}"`, e);
			}
		}
		for (const temp of plan.staleTemps) {
			if (!temp.file || !isTempName(temp.name) || temp.path !== `${cfg.folder}/${temp.name}`) continue;
			await ports.trash(temp.path).catch((e) => console.error(`[notebook] backup: could not trash "${temp.path}"`, e));
		}
	} catch (e) {
		console.error("[notebook] backup: trimming the old backups failed", e);
	}
	return trashed;
}
