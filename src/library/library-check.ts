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
 * - It does not delete anything: `trashOrphans` hands the files to the caller's `trash` (the Obsidian trash), after the
 *   check has been run again, and only for files the user confirmed that are still orphans.
 *
 * An asset counts as used when its id appears in any notebook of the vault (read as text, so even a notebook that no
 * longer parses protects what it names), or, failing that, in anything that can still bring a notebook back: the plugin
 * trash (deleted notebooks and pages), version history and restore backups, templates, stamps and the `_meta` files.
 * Those are reported apart ("kept by backups and the trash") and never offered for removal.
 */
import { parse } from "../model/serialize";
import { downloadState, formatBytes, isAwaitingDownload, withoutNulTail } from "../storage/sync-state";

export { formatBytes };

/** Asset files younger than this are not judged: a notebook that uses them may be about to be saved or synced. */
export const ASSET_GRACE_MS = 60 * 60_000;
/** The asset id is 24 hex digits (pdf/hash.ts). */
const ASSET_FILE = /^([0-9a-f]{24})\.(?:pdf|png|jpe?g|webp|gif)$/;
/** Files that can name an asset outside the notebooks. */
const HOLDER_EXTENSIONS = new Set(["notebook", "json", "snapshot", "bak", "stamp"]);

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
	/** Not used by anything, but younger than ASSET_GRACE_MS: not judged yet. */
	recent: { count: number; bytes: number };
	/** Empty files: the sync client has not delivered them yet. */
	waiting: { count: number; bytes: number };
	/** Used by nothing readable, but some file that could use it is not downloaded: not judged. */
	unjudged: { count: number; bytes: number };
	/** Used by nothing: what the check offers to move to the trash. Empty unless `complete`. */
	orphans: AssetFile[];
	orphanBytes: number;
	/** Files that could hold a reference but were not downloaded or could not be read (notebooks, backups, trash). */
	unavailable: number;
	/** Every file that could use an asset was read: the orphans can be trusted. */
	complete: boolean;
	cancelled: boolean;
}

/** Scan results of files that did not change since (path, modification time and size): a second run reads only the new ones. */
export type ScanCacheEntry = { mtime: number; size: number; scan: NotebookScan };
export type ScanCache = Map<string, ScanCacheEntry>;

export interface RunOptions {
	cache?: ScanCache;
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
			if (HOLDER_EXTENSIONS.has(ext)) holderFiles.push(f);
		} else if (ext === "notebook") {
			notebookFiles.push(f);
		}
	}

	const report: LibraryCheckReport = {
		notebooks: notebookFiles.length,
		unreadable: [], futureVersion: [], notDownloaded: [],
		assets: sum(assets), inUse: { count: 0, bytes: 0 }, kept: { count: 0, bytes: 0 }, recent: { count: 0, bytes: 0 },
		waiting: { count: 0, bytes: 0 }, unjudged: { count: 0, bytes: 0 }, orphans: [], orphanBytes: 0,
		unavailable: 0, complete: false, cancelled: false,
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
			if (scan.status === "unreadable") report.unreadable.push({ path: f.path, detail: scan.detail ?? "", size: f.size });
			else if (scan.status === "future-version") report.futureVersion.push(f.path);
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
			if (text === null || isAwaitingDownload(text) || text.endsWith("\0")) report.unavailable++;
			else {
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

	const waiting = candidates.filter((a) => a.size === 0);
	const recent = candidates.filter((a) => a.size > 0 && config.now - a.mtime < ASSET_GRACE_MS);
	const judged = candidates.filter((a) => !waiting.includes(a) && !recent.includes(a));
	report.waiting = sum(waiting);
	report.recent = sum(recent);
	report.complete = report.unavailable === 0;
	if (report.complete) {
		report.orphans = judged.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
		report.orphanBytes = sum(judged).bytes;
	} else {
		report.unjudged = sum(judged);
	}
	return report;
}

// ------------------------------------------------------------------ moving to the trash

export interface Trasher {
	/** Moves a file to the trash (never deletes it for good). */
	trash(path: string): Promise<void>;
}

export interface TrashResult {
	/** The check could not be trusted this time (a file that could use an asset is not downloaded): nothing was moved. */
	incomplete: boolean;
	moved: AssetFile[];
	/** Confirmed, but no longer unused, changed, or gone: left alone. */
	skipped: string[];
	failed: Array<{ path: string; error: string }>;
}

/**
 * Moves the confirmed orphans to the trash. The check is run again first (cheap: unchanged notebooks come from the cache),
 * and a file is moved only if it is still an orphan, still the size that was listed, and still looks like an asset.
 */
export async function trashOrphans(
	source: CheckSource, config: CheckConfig, confirmed: readonly AssetFile[], trasher: Trasher, options: RunOptions = {},
): Promise<TrashResult> {
	const fresh = await runLibraryCheck(source, config, options);
	const result: TrashResult = { incomplete: false, moved: [], skipped: [], failed: [] };
	if (fresh.cancelled) {
		result.skipped = confirmed.map((c) => c.path);
		return result;
	}
	if (!fresh.complete) {
		result.incomplete = true;
		result.skipped = confirmed.map((c) => c.path);
		return result;
	}
	const still = new Map(fresh.orphans.map((o) => [o.path, o]));
	for (const file of confirmed) {
		const now = still.get(file.path);
		if (!now || now.size !== file.size || !isAssetFilePath(file.path, config.root)) {
			result.skipped.push(file.path);
			continue;
		}
		try {
			await trasher.trash(file.path);
			result.moved.push(now);
		} catch (e) {
			result.failed.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return result;
}
