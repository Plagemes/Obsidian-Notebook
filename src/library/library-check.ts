/**
 * Library check (roadmap 27): finds notebooks that cannot be read and asset files no notebook uses, and reports the space
 * they take. Pure: no 'obsidian', the vault is reached through a `CheckSource`, so it is testable in Node.
 *
 * What it never does:
 * - It never touches a notebook. Unreadable notebooks are only listed.
 * - It never judges a file that is not there yet. A notebook that is empty, only NUL bytes, cut off, or that cannot be read
 *   right now is "not downloaded yet" (the same detection as the notebook view, storage/sync-state.ts), never "unreadable";
 *   an asset file with no content is "waiting", never an orphan. And while any file that could hold a reference is not
 *   downloaded, **no asset is called an orphan at all** (the report says why): the missing file may be the one that uses it.
 * - It only ever considers files directly inside `<notebooks folder>/_assets/` named like an asset (`<24 hex>.<ext>`).
 * - It does not delete anything: `moveOrphans` hands the files to the caller's `Mover`, which puts them in the recoverable
 *   folder `<notebooks folder>/_trash/assets/` (a move inside the vault, so a sync service sees a move and not a delete),
 *   after the check has been run again, and only for files the user confirmed that are still orphans.
 * - **A file is offered only when it has been unused for a day on this device.** The modification time of a file is the one
 *   of the device it came from (Google Drive and OneDrive keep it), so it says nothing about when this device first saw the
 *   file: a picture can arrive before the notebook that uses it. Each device therefore keeps its own record of when it first
 *   saw an asset unused (`library-check-seen.ts`, a per-device sidecar in `_meta`); an asset is offered only if an earlier
 *   check, at least ASSET_GRACE_MS before, also found it unused and nothing has used it since.
 * - **Open notebooks count.** What the open views hold in memory (the document, the undo and redo history, media not yet in
 *   the document) and what the instant-save journal holds is asked from `RunOptions.live` before judging and again right
 *   before moving. If that cannot be inspected, the report is incomplete and nothing is offered.
 * - **Nothing is offered unless the whole answer is trusted**: a notebook that is unreadable or not downloaded, a backup that
 *   is cut off or does not parse, an open view or journal that cannot be inspected: `complete` is false and no orphan is listed.
 *
 * An asset counts as used when its id appears in any notebook of the vault (read as text, so even a notebook that no
 * longer parses protects what it names), or, failing that, in anything that can still bring a notebook back: the plugin
 * trash (deleted notebooks and pages), version history and restore backups, templates, stamps and the `_meta` files.
 * Those are reported apart ("kept by backups and the trash") and never offered for removal.
 */
import { parse } from "../model/serialize";
import { downloadState, formatBytes, isAwaitingDownload, withoutNulTail } from "../storage/sync-state";
import { FOLDER_META_PREFIX } from "./folder-meta";
import { SEEN_PREFIX } from "./library-check-seen";
import { LIBRARY_STATE_PREFIX } from "./library-state";

export { formatBytes };

/** An asset is offered only if this device saw it unused in an earlier check at least this long ago (see the header). */
export const ASSET_GRACE_MS = 24 * 3_600_000;
/** Asset files modified more recently than this are not judged either (a quick guard on top of the record above). */
export const ASSET_MTIME_GRACE_MS = 60 * 60_000;
/** The asset id is 24 hex digits (pdf/hash.ts). */
const ASSET_FILE = /^([0-9a-f]{24})\.(?:pdf|png|jpe?g|webp|gif)$/;
/** Files that can name an asset outside the notebooks. */
const HOLDER_EXTENSIONS = new Set(["notebook", "json", "snapshot", "bak", "stamp"]);
/**
 * Device sidecars of `_meta` that are not holders: the folder metadata (`folders-<device>.json`) and the library state
 * (`library-<device>.json`) never name an asset, and this check's own record (`library-check-<device>.json`) names assets
 * but is no reference; nor are the copies kept of them when unreadable (`<prefix>.unreadable-<hash>.json`). Left out, an
 * unsynced or empty one no longer makes the check incomplete. Every other file of the kept folders stays a holder.
 */
const NOT_HOLDERS: readonly string[] = [FOLDER_META_PREFIX, LIBRARY_STATE_PREFIX, SEEN_PREFIX];
const SIDECAR_NAME = /^([a-z-]+?)(?:-[0-9a-f]{8}|\.unreadable-[0-9a-f]{8})\.json$/;

/** Whether `path` is one of the `_meta` device sidecars that cannot name an asset (see NOT_HOLDERS). */
export function isNonHolderSidecar(path: string, root: string): boolean {
	const meta = root ? `${root}/_meta` : "_meta";
	if (!underFolder(path, meta)) return false;
	const m = SIDECAR_NAME.exec(path.slice(meta.length + 1));
	return m !== null && NOT_HOLDERS.includes(m[1]!);
}

/** Where the check moves unused asset files: inside the plugin trash folder, so nothing leaves the vault. */
export function assetTrashDir(root: string): string {
	return root ? `${root}/_trash/assets` : "_trash/assets";
}

export interface VaultFileInfo {
	path: string;
	size: number;
	/** Modification time (ms since epoch). */
	mtime: number;
}

export interface CheckSource {
	/** Every file of the vault (stat only). */
	files(): VaultFileInfo[];
	/** Text of a file; throws when it cannot be read right now. */
	read(path: string): Promise<string>;
}

export interface CheckConfig {
	/** Notebooks folder ("" = the vault root), as vault paths without a trailing slash. */
	root: string;
	/** The backup folder (version history and restore copies). */
	backup: string;
	now: number;
}

/** `<root>/_assets` */
export function assetsDir(root: string): string {
	return root ? `${root}/_assets` : "_assets";
}

function underFolder(path: string, folder: string): boolean {
	return path.startsWith(`${folder}/`);
}

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Folders that keep copies and records that can bring a notebook (and so its assets) back. */
export function keptFolders(config: Pick<CheckConfig, "root" | "backup">): string[] {
	const r = config.root;
	const at = (name: string) => (r ? `${r}/${name}` : name);
	return [at("_trash"), config.backup, at("_templates"), at("_stamps"), at("_meta")];
}

/** Whether `path` is a file the check may ever offer to move: directly in the assets folder and named like an asset. */
export function isAssetFilePath(path: string, root: string): boolean {
	const dir = assetsDir(root);
	if (!underFolder(path, dir)) return false;
	const name = path.slice(dir.length + 1);
	return !name.includes("/") && ASSET_FILE.test(name);
}

// ------------------------------------------------------------------ one notebook

export type NotebookStatus = "ok" | "unreadable" | "not-downloaded" | "future-version";

export interface NotebookScan {
	status: NotebookStatus;
	/** Why it does not read (parse error). */
	detail?: string;
	/** Every run of 24 or more hex digits in the text, as 24-digit windows: the asset ids it could name. */
	tokens: Set<string>;
}

const HEX_RUN = /[0-9a-f]{24,}/g;
const MAX_RUN = 128;

/** The 24-digit windows of every hex run of the text (an asset id is 24 hex digits). */
export function hexTokens(text: string): Set<string> {
	const out = new Set<string>();
	HEX_RUN.lastIndex = 0;
	for (let m = HEX_RUN.exec(text); m; m = HEX_RUN.exec(text)) {
		const run = m[0].length > MAX_RUN ? m[0].slice(0, MAX_RUN) : m[0];
		for (let i = 0; i + 24 <= run.length; i++) out.add(run.slice(i, i + 24));
	}
	return out;
}

/**
 * Reads one notebook's text. A text that does not parse but is still arriving from the sync client (empty, NUL bytes, cut
 * off, or changed a moment ago) is `not-downloaded`; one from a newer version is `future-version`; anything else that
 * does not parse is `unreadable`. The tokens are always collected, so even those protect the assets they name.
 */
export function scanNotebookText(text: string, changedAgoMs: number | null): NotebookScan {
	const tokens = hexTokens(text);
	if (isAwaitingDownload(text)) return { status: "not-downloaded", tokens };
	const parsed = parse(withoutNulTail(text));
	if (parsed.ok) return { status: "ok", tokens };
	if (parsed.reason === "future-version") return { status: "future-version", detail: parsed.message, tokens };
	if (downloadState(text, { jsonError: parsed.reason === "json", changedAgoMs }) !== null) return { status: "not-downloaded", tokens };
	return { status: "unreadable", detail: parsed.message, tokens };
}

// ------------------------------------------------------------------ the whole library

export interface AssetFile {
	path: string;
	id: string;
	size: number;
	/** Modification time (ms since epoch). */
	mtime: number;
}

export interface UnreadableNotebook {
	path: string;
	detail: string;
	size: number;
}

export interface LibraryCheckReport {
	/** Notebooks looked at. */
	notebooks: number;
	unreadable: UnreadableNotebook[];
	/** Written by a newer version of the plugin: not damaged, not checked here. */
	futureVersion: string[];
	/** Not downloaded yet, or cannot be read right now: not judged, never reported as damaged. */
	notDownloaded: string[];
	/** Files in the assets folder that look like assets. */
	assets: { count: number; bytes: number };
	/** Used by a notebook. */
	inUse: { count: number; bytes: number };
	/** Used only by backups, the trash, templates or stamps: kept. */
	kept: { count: number; bytes: number };
	/** Look unused but are not offered yet: modified in the last hour, or not seen unused by an earlier check at least ASSET_GRACE_MS ago. */
	recent: { count: number; bytes: number };
	/** Empty files: the sync client has not delivered them yet. */
	waiting: { count: number; bytes: number };
	/** Used by nothing readable, but some file that could use it is not downloaded: not judged. */
	unjudged: { count: number; bytes: number };
	/** Used by nothing for a day: what the check offers to move to the recoverable folder. Empty unless `complete`. */
	orphans: AssetFile[];
	orphanBytes: number;
	/** Files that could hold a reference but were not downloaded, not complete or could not be read (notebooks, backups, trash). */
	unavailable: number;
	/** An open notebook or the instant-save journal could not be inspected (or no inspection was given). */
	openIncomplete: boolean;
	/** Every file that could use an asset was read and the open notebooks were inspected: the orphans can be trusted. */
	complete: boolean;
	cancelled: boolean;
}

/** Scan results of files that did not change since (path, modification time and size): a second run reads only the new ones. */
export type ScanCacheEntry = { mtime: number; size: number; scan: NotebookScan };
export type ScanCache = Map<string, ScanCacheEntry>;

/** Asset ids held by things the vault listing cannot show: open notebooks (memory) and the instant-save journal. */
export interface LiveReferences {
	ids: Iterable<string>;
	/** Something could not be inspected: the answer cannot be trusted and nothing is offered. */
	incomplete: boolean;
}

/** This device's record of when it first saw each asset unused (`library-check-seen.ts`). */
export interface SeenStore {
	/** Asset id → time first seen unused; null when the record cannot be read (nothing is then offered). */
	load(): Promise<Map<string, number> | null>;
	save(seen: ReadonlyMap<string, number>): Promise<void>;
}

export interface RunOptions {
	cache?: ScanCache;
	/** What open notebooks and the journal hold. Without it the answer is incomplete: nothing is offered. */
	live?: () => Promise<LiveReferences>;
	/** The record of first sightings. Without it (or when it cannot be read) nothing is offered. */
	seen?: SeenStore;
	/** Called after each file read. */
	progress?(done: number, total: number): void;
	cancelled?(): boolean;
	/** Awaited every few files so the interface stays alive. */
	breathe?(): Promise<void>;
}

const BREATHE_EVERY = 4;

function sum(files: readonly { size: number }[]): { count: number; bytes: number } {
	return { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

export async function runLibraryCheck(source: CheckSource, config: CheckConfig, options: RunOptions = {}): Promise<LibraryCheckReport> {
	const cache: ScanCache = options.cache ?? new Map<string, ScanCacheEntry>();
	const all = source.files();
	const dir = assetsDir(config.root);
	const kept = keptFolders(config);
	const assets: AssetFile[] = [];
	const notebookFiles: VaultFileInfo[] = [];
	const holderFiles: VaultFileInfo[] = [];
	for (const f of all) {
		const ext = extensionOf(f.path);
		if (underFolder(f.path, dir)) {
			const m = ASSET_FILE.exec(f.path.slice(dir.length + 1));
			if (m) assets.push({ path: f.path, id: m[1]!, size: f.size, mtime: f.mtime });
		} else if (kept.some((k) => underFolder(f.path, k))) {
			if (HOLDER_EXTENSIONS.has(ext) && !isNonHolderSidecar(f.path, config.root)) holderFiles.push(f);
		} else if (ext === "notebook") {
			notebookFiles.push(f);
		}
	}

	const report: LibraryCheckReport = {
		notebooks: notebookFiles.length,
		unreadable: [], futureVersion: [], notDownloaded: [],
		assets: sum(assets), inUse: { count: 0, bytes: 0 }, kept: { count: 0, bytes: 0 }, recent: { count: 0, bytes: 0 },
		waiting: { count: 0, bytes: 0 }, unjudged: { count: 0, bytes: 0 }, orphans: [], orphanBytes: 0,
		unavailable: 0, openIncomplete: false, complete: false, cancelled: false,
	};

	const total = notebookFiles.length;
	let done = 0;
	const referenced = new Set<string>();
	const stop = () => options.cancelled?.() === true;
	const step = async () => {
		done++;
		options.progress?.(done, total);
		if (done % BREATHE_EVERY === 0) await options.breathe?.();
	};

	for (const f of notebookFiles) {
		if (stop()) {
			report.cancelled = true;
			return report;
		}
		const cached = cache.get(f.path);
		let scan: NotebookScan | null = null;
		if (cached && cached.mtime === f.mtime && cached.size === f.size) scan = cached.scan;
		else if (f.size === 0) scan = { status: "not-downloaded", tokens: new Set() };
		else {
			try {
				const text = await source.read(f.path);
				scan = scanNotebookText(text, config.now - f.mtime);
				// A file that is still arriving is read again next time.
				if (scan.status !== "not-downloaded") cache.set(f.path, { mtime: f.mtime, size: f.size, scan });
			} catch {
				scan = null;
			}
		}
		if (!scan) {
			// Cannot be read right now (an online-only file, a lock): not damaged, not judged.
			report.notDownloaded.push(f.path);
			report.unavailable++;
		} else if (scan.status === "not-downloaded") {
			report.notDownloaded.push(f.path);
			report.unavailable++;
		} else {
			if (scan.status === "unreadable") {
				// Listed, and what it names is protected, but the answer is not trusted: the damaged part may name more.
				report.unreadable.push({ path: f.path, detail: scan.detail ?? "", size: f.size });
				report.unavailable++;
			} else if (scan.status === "future-version") report.futureVersion.push(f.path);
			for (const tok of scan.tokens) referenced.add(tok);
		}
		await step();
	}

	// Candidates: assets no notebook names.
	const inUse = assets.filter((a) => referenced.has(a.id));
	report.inUse = sum(inUse);
	let candidates = assets.filter((a) => !referenced.has(a.id));

	// Only now (and only if something is left) read what else can bring a notebook back.
	const held = new Set<string>();
	if (candidates.length > 0 && holderFiles.length > 0) {
		const ids = new Set(candidates.map((a) => a.id));
		let hdone = 0;
		for (const f of holderFiles) {
			if (ids.size === 0) break;
			if (stop()) {
				report.cancelled = true;
				return report;
			}
			let text: string | null = null;
			if (f.size > 0) {
				try {
					text = await source.read(f.path);
				} catch {
					text = null;
				}
			}
			// Everything that holds references is JSON. A text that is empty, ends in NUL bytes or does not parse (a copy only
			// partly downloaded, cut off) may be missing the very part that names an asset: unsure, nothing is offered.
			if (text === null || !isCompleteJson(text)) report.unavailable++;
			if (text !== null) {
				for (const tok of hexTokens(text)) {
					if (ids.has(tok)) {
						held.add(tok);
						ids.delete(tok);
					}
				}
			}
			hdone++;
			if (hdone % BREATHE_EVERY === 0) await options.breathe?.();
		}
		report.kept = sum(candidates.filter((a) => held.has(a.id)));
		candidates = candidates.filter((a) => !held.has(a.id));
	}

	// What open notebooks and the instant-save journal hold counts as used (asked last, so it is as fresh as it can be).
	let liveIds = new Set<string>();
	try {
		const live = options.live ? await options.live() : null;
		if (live) liveIds = new Set(live.ids);
		report.openIncomplete = live === null || live.incomplete;
	} catch {
		report.openIncomplete = true;
	}
	if (liveIds.size > 0) {
		const usedLive = candidates.filter((a) => liveIds.has(a.id));
		report.inUse = sum([...inUse, ...usedLive]);
		candidates = candidates.filter((a) => !liveIds.has(a.id));
	}

	let seen: Map<string, number> | null = null;
	if (options.seen) {
		try {
			seen = await options.seen.load();
		} catch {
			seen = null;
		}
	}

	const waiting = candidates.filter((a) => a.size === 0);
	const fresh = candidates.filter((a) => a.size > 0 && config.now - a.mtime < ASSET_MTIME_GRACE_MS);
	const judged = candidates.filter((a) => !waiting.includes(a) && !fresh.includes(a));
	// Offered only when an earlier check on this device, at least a day ago, also found it unused.
	const aged = judged.filter((a) => {
		const first = seen?.get(a.id);
		return first !== undefined && config.now - first >= ASSET_GRACE_MS;
	});
	report.waiting = sum(waiting);
	report.complete = report.unavailable === 0 && !report.openIncomplete;
	if (report.complete) {
		report.recent = sum(candidates.filter((a) => a.size > 0 && !aged.includes(a)));
		report.orphans = aged.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
		report.orphanBytes = sum(aged).bytes;
		// Remember what this complete check found unused (and forget what is used again), so a later check can tell how long.
		if (seen && options.seen) {
			const next = new Map<string, number>();
			for (const a of candidates) if (a.size > 0) next.set(a.id, seen.get(a.id) ?? config.now);
			if (!sameSeen(seen, next)) {
				try {
					await options.seen.save(next);
				} catch {
					/* the record is only a convenience: without it nothing is offered next time either */
				}
			}
		}
	} else {
		report.recent = sum(fresh);
		report.unjudged = sum(judged);
	}
	return report;
}

/** Whether a text is a whole JSON value (not empty, no NUL tail, not cut off). */
function isCompleteJson(text: string): boolean {
	if (isAwaitingDownload(text) || text.endsWith("\0")) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function sameSeen(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) if (b.get(k) !== v) return false;
	return true;
}

// ------------------------------------------------------------------ moving to the recoverable folder

export interface Mover {
	/** Moves a file inside the vault (a rename; the destination folder is created if needed). Never deletes anything. */
	move(from: string, to: string): Promise<void>;
}

export interface MoveResult {
	/** The check could not be trusted this time (an unavailable file, an open notebook or journal that cannot be inspected): nothing was moved. */
	incomplete: boolean;
	moved: AssetFile[];
	/** Confirmed, but no longer unused, changed, or gone: left alone. */
	skipped: string[];
	failed: Array<{ path: string; error: string }>;
	/** Where the moved files are now. */
	folder: string;
}

/** The path a file gets in the recoverable folder: its own name, or `<id>-<n>.<ext>` when that name is taken. */
export function assetTrashPath(root: string, file: Pick<AssetFile, "path">, taken: ReadonlySet<string>): string {
	const dir = assetTrashDir(root);
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	let to = `${dir}/${name}`;
	const dot = name.lastIndexOf(".");
	for (let n = 2; taken.has(to); n++) to = `${dir}/${name.slice(0, dot)}-${n}${name.slice(dot)}`;
	return to;
}

/**
 * Moves the confirmed orphans to `<notebooks folder>/_trash/assets/`. The check is run again first (cheap: unchanged
 * notebooks come from the cache), the open notebooks and the journal are asked once more right before the first move, and a
 * file is moved only if it is still an orphan, still the size that was listed, and still looks like an asset. The move is a
 * rename inside the vault: nothing is deleted, and putting a file back is a move back into `_assets/`.
 */
export async function moveOrphans(
	source: CheckSource, config: CheckConfig, confirmed: readonly AssetFile[], mover: Mover, options: RunOptions = {},
): Promise<MoveResult> {
	const folder = assetTrashDir(config.root);
	const result: MoveResult = { incomplete: false, moved: [], skipped: [], failed: [], folder };
	const fresh = await runLibraryCheck(source, config, options);
	const skipAll = () => {
		result.skipped = confirmed.map((c) => c.path);
		return result;
	};
	if (fresh.cancelled) return skipAll();
	if (!fresh.complete) {
		result.incomplete = true;
		return skipAll();
	}
	// Right before moving: what the open notebooks and the journal hold now.
	let liveIds = new Set<string>();
	try {
		const live = options.live ? await options.live() : null;
		if (!live || live.incomplete) {
			result.incomplete = true;
			return skipAll();
		}
		liveIds = new Set(live.ids);
	} catch {
		result.incomplete = true;
		return skipAll();
	}
	const taken = new Set(source.files().map((f) => f.path));
	const still = new Map(fresh.orphans.map((o) => [o.path, o]));
	for (const file of confirmed) {
		const now = still.get(file.path);
		if (!now || now.size !== file.size || liveIds.has(now.id) || !isAssetFilePath(file.path, config.root)) {
			result.skipped.push(file.path);
			continue;
		}
		const to = assetTrashPath(config.root, file, taken);
		try {
			await mover.move(file.path, to);
			taken.add(to);
			result.moved.push(now);
		} catch (e) {
			result.failed.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return result;
}
