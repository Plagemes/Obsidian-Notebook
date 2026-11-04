/**
 * The Storage manager's scan (roadmap #128): how much space each notebook takes, and what could be cleaned up. Pure: no
 * 'obsidian', the vault is reached through a `StorageSource`, so everything here is tested in Node.
 *
 * It reads, hashes and measures. It never writes, moves or deletes anything: the actions live in storage-actions.ts and each
 * asks for confirmation first.
 *
 * - **Unused files are the library check's answer, not a second opinion.** `runLibraryCheck` (library-check.ts) already
 *   reads every notebook of the vault as text (even one that no longer parses), the backups and version history, the plugin
 *   trash (deleted notebooks AND deleted pages), templates, stamps and the `_meta` files, the open notebooks and the
 *   instant-save journal, and offers an asset only when the answer is complete and the file was seen unused a day ago. This
 *   scan calls it and adds nothing to its verdict: `check.orphans` is the only list of unused files.
 * - **Cheap and cancellable.** Notebooks are read through the check (unchanged ones come from the cache by modification time
 *   and size); images are hashed only when another image has the same size; the other phases read nothing. Every phase
 *   awaits `breathe` every few files, reports progress and stops at once when `cancelled()` says so.
 * - **Sizes.** A notebook's size is its file, the assets only it uses, its equal share of the assets several notebooks use, its
 *   backups and version history and its journal, so the rows add up to the library's total and the same picture is never
 *   charged twice (`sharedAssetBytes` keeps the full size of what it shares, for the detail line).
 */
import { formatBytes } from "../storage/sync-state";
import { quickDocId } from "../storage/history";
import { sha256Hex } from "../pdf/hash";
import {
	assetsDir, isAssetFilePath, keptFolders, runLibraryCheck,
	type AssetFile, type CheckConfig, type CheckSource, type LibraryCheckReport, type NotebookStatus, type RunOptions, type ScanCache,
} from "./library-check";
import {
	conflictCandidates, judgeConflict, notebookRef, planBackups, OLD_BACKUP_DAYS,
	type ConflictCopy, type NotebookRef, type OldBackup,
} from "../storage/storage-backups";

export { formatBytes };

/** Image assets of this size and above are listed as heavy candidates (the dialog filters by its own threshold). */
export const HEAVY_LIST_MIN = 256 * 1024;
/** At most this many heavy candidates are listed. */
export const HEAVY_LIST_MAX = 200;
/** The default size from which an image counts as heavy. */
export const HEAVY_DEFAULT = 2 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const EXTENSION_RANK = ["png", "jpg", "jpeg", "webp", "gif"];

export interface StorageSource extends CheckSource {
	/** The bytes of a file (to hash an image); throws when it cannot be read right now. */
	readBinary(path: string): Promise<ArrayBuffer>;
}

/** A journal file in the plugin's config folder (not a vault file): name and size. */
export interface JournalFile {
	name: string;
	size: number;
}

/** What is remembered between two scans of the same session. */
export interface StorageCache {
	scans: ScanCache;
	docIds: Map<string, { mtime: number; size: number; docId: string | null }>;
	hashes: Map<string, { mtime: number; size: number; hash: string }>;
}

export function newStorageCache(): StorageCache {
	return { scans: new Map(), docIds: new Map(), hashes: new Map() };
}

export type StoragePhase = "notebooks" | "images" | "conflicts";

export interface StorageScanOptions extends Omit<RunOptions, "cache" | "progress"> {
	cache: StorageCache;
	/** Hash of a file's bytes (hex). Default: SHA-256. */
	hash?: (data: ArrayBuffer) => Promise<string>;
	/** The journal files (config folder). Without it journals are not counted. */
	journals?: () => Promise<JournalFile[]>;
	/** Days after which backups are offered; default 90. */
	days?: number;
	/** The version-history snapshots to keep per notebook (the setting). */
	keepSnapshots?: number;
	progress?(phase: StoragePhase, done: number, total: number): void;
}

export interface NotebookStorage {
	path: string;
	name: string;
	docId: string | null;
	/** What the check could say about the file. `unknown`: not read (cancelled, or it could not be read). */
	status: NotebookStatus | "unknown";
	fileBytes: number;
	/** Assets only this notebook uses. */
	ownAssetBytes: number;
	/** Assets this notebook and others use, in full (informational: the total charges its share). */
	sharedAssetBytes: number;
	/** The share of those assets charged to this notebook: each is split equally between the notebooks that use it. */
	sharedShareBytes: number;
	/** Number of asset files it names. */
	assetCount: number;
	backupBytes: number;
	backupCount: number;
	journalBytes: number;
	/** file + own assets + its share of shared assets + backups + journal: the rows add up to the total. */
	totalBytes: number;
}

export interface Bucket {
	count: number;
	bytes: number;
}

export interface StorageTotals {
	notebooks: Bucket;
	assets: Bucket;
	backups: Bucket;
	trash: Bucket;
	journal: Bucket;
	/** `_meta`, stamps, templates. */
	other: Bucket;
	bytes: number;
}

export interface DuplicateExtra {
	file: AssetFile;
	/**
	 * `same-id`: the same picture stored a second time under another extension (the id is the same, so every notebook still
	 * finds the one that stays: the extra file can go). `other-id`: a copy under another id; the notebooks that name it
	 * (`users`) are pointed at the one that stays, and the copy is left to the unused files once nothing names it.
	 */
	kind: "same-id" | "other-id";
	/** Notebooks (readable, so editable) that name this id. */
	users: string[];
	/** Notebooks that name this id but cannot be edited now (unreadable, not downloaded, a newer version). */
	blocked: string[];
}

export interface DuplicateGroup {
	hash: string;
	/** Size of each copy, bytes. */
	size: number;
	/** The file that stays. */
	keep: AssetFile;
	extras: DuplicateExtra[];
	/** Bytes the extras take. */
	extraBytes: number;
}

export interface HeavyImage {
	file: AssetFile;
	/** Readable notebooks that name it. */
	users: string[];
	blocked: string[];
}

export interface StorageReport {
	/** The library check: unreadable notebooks, unused files (`orphans`), what is kept and why. */
	check: LibraryCheckReport;
	notebooks: NotebookStorage[];
	totals: StorageTotals;
	duplicates: DuplicateGroup[];
	heavy: HeavyImage[];
	oldBackups: OldBackup[];
	/** Conflicted copies identical to their main notebook: nothing would be lost by moving them to the trash. */
	conflictsIdentical: ConflictCopy[];
	/** Conflicted copies that differ: only listed; merging is the user's choice. */
	conflictsDiffering: ConflictCopy[];
	cancelled: boolean;
	/** Images or conflict candidates that could not be read right now (not judged). */
	unreadable: number;
}

const bucket = (files: readonly { size: number }[]): Bucket => ({ count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
const isNotebookPath = (path: string) => path.toLowerCase().endsWith(".notebook");
const under = (path: string, folder: string) => path.startsWith(`${folder.replace(/\/+$/, "")}/`);
const stemOf = (path: string) => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
};
const journalDocKey = (docId: string) => docId.replace(/[^A-Za-z0-9_-]/g, "_");

function emptyReport(check: LibraryCheckReport, cancelled: boolean): StorageReport {
	const none = { count: 0, bytes: 0 };
	return {
		check, notebooks: [], totals: { notebooks: none, assets: none, backups: none, trash: none, journal: none, other: none, bytes: 0 },
		duplicates: [], heavy: [], oldBackups: [], conflictsIdentical: [], conflictsDiffering: [], cancelled, unreadable: 0,
	};
}

export async function scanStorage(source: StorageSource, config: CheckConfig, options: StorageScanOptions): Promise<StorageReport> {
	const cache = options.cache;
	const hash = options.hash ?? sha256Hex;
	const all = source.files();
	const byPath = new Map(all.map((f) => [f.path, f]));
	const stop = () => options.cancelled?.() === true;
	const breathe = async () => options.breathe?.();

	// Notebook ids are noted as the check reads each notebook (the check keeps tokens, not text), by modification time and size.
	const noting: CheckSource = {
		files: () => all,
		read: async (path) => {
			const text = await source.read(path);
			const f = byPath.get(path);
			if (f && isNotebookPath(path)) cache.docIds.set(path, { mtime: f.mtime, size: f.size, docId: quickDocId(text) });
			return text;
		},
	};
	const check = await runLibraryCheck(noting, config, {
		cache: cache.scans,
		progress: (done, total) => options.progress?.("notebooks", done, total),
		live: options.live?.bind(options),
		seen: options.seen,
		cancelled: options.cancelled?.bind(options),
		breathe: options.breathe?.bind(options),
	});
	if (check.cancelled || stop()) return emptyReport(check, true);

	// ---------------------------------------------------------- what is where
	const kept = keptFolders(config);
	const dir = assetsDir(config.root);
	const notebookFiles = all.filter((f) => isNotebookPath(f.path) && !under(f.path, dir) && !kept.some((k) => under(f.path, k)));
	const assetFiles: AssetFile[] = [];
	for (const f of all) {
		if (!isAssetFilePath(f.path, config.root)) continue;
		assetFiles.push({ path: f.path, id: f.path.slice(dir.length + 1, dir.length + 25), size: f.size, mtime: f.mtime });
	}

	// ---------------------------------------------------------- notebooks and who names which asset
	const refs: NotebookRef[] = [];
	const copies = new Set(conflictCandidates(notebookFiles).map((c) => c.path));
	const rows = new Map<string, NotebookStorage>();
	const namedBy = new Map<string, string[]>();
	const statusOf = new Map<string, NotebookStatus | "unknown">();
	for (const f of notebookFiles) {
		const scan = cache.scans.get(f.path);
		const fresh = scan && scan.mtime === f.mtime && scan.size === f.size ? scan.scan : null;
		const noted = cache.docIds.get(f.path);
		const docId = noted && noted.mtime === f.mtime && noted.size === f.size ? noted.docId : null;
		refs.push(notebookRef(f.path, docId, copies.has(f.path), fresh !== null && fresh.status === "ok"));
		statusOf.set(f.path, fresh ? fresh.status : "unknown");
		if (fresh) for (const tok of fresh.tokens) namedBy.set(tok, [...(namedBy.get(tok) ?? []), f.path]);
		rows.set(f.path, {
			path: f.path, name: stemOf(f.path), docId, status: fresh ? fresh.status : "unknown", fileBytes: f.size,
			ownAssetBytes: 0, sharedAssetBytes: 0, sharedShareBytes: 0, assetCount: 0, backupBytes: 0, backupCount: 0, journalBytes: 0, totalBytes: 0,
		});
	}
	const bytesById = new Map<string, number>();
	for (const a of assetFiles) bytesById.set(a.id, (bytesById.get(a.id) ?? 0) + a.size);
	for (const [id, bytes] of bytesById) {
		const users = [...new Set(namedBy.get(id) ?? [])].filter((p) => rows.has(p));
		for (const p of users) {
			const row = rows.get(p)!;
			row.assetCount++;
			if (users.length === 1) row.ownAssetBytes += bytes;
			else {
				row.sharedAssetBytes += bytes;
				row.sharedShareBytes += bytes / users.length;
			}
		}
	}

	// ---------------------------------------------------------- backups, version history
	const ownerOf = async (b: { path: string; notebook: string }): Promise<"mine" | "foreign"> => {
		const ownerId = rows.get(b.notebook)?.docId ?? null;
		let ownId: string | null = null;
		try {
			ownId = quickDocId(await source.read(b.path));
		} catch {
			ownId = null;
		}
		await breathe();
		return ownerId !== null && ownId !== null && ownId !== ownerId ? "foreign" : "mine";
	};
	// The newest ordinary backup is spared among the backups this notebook owns: where the one chosen turns out to be another
	// notebook's, the plan is made again without it.
	const foreign = new Set<string>();
	const checked = new Set<string>();
	let plan = planBackups(all, config.backup, refs, config.now, { days: options.days ?? OLD_BACKUP_DAYS, keepSnapshots: options.keepSnapshots, foreign });
	for (;;) {
		let again = false;
		for (const [notebook, path] of plan.spared) {
			if (checked.has(path)) continue;
			if (stop()) return emptyReport(check, true);
			checked.add(path);
			if ((await ownerOf({ path, notebook })) === "foreign") {
				foreign.add(path);
				again = true;
			}
		}
		if (!again) break;
		plan = planBackups(all, config.backup, refs, config.now, { days: options.days ?? OLD_BACKUP_DAYS, keepSnapshots: options.keepSnapshots, foreign });
	}
	// A backup is named by its notebook's file name, but a new notebook can reuse the name of a deleted one: where the backup's own
	// document id can be read and is another notebook's, it is not offered. (Only what would be offered is read.)
	const owned: OldBackup[] = [];
	for (const b of plan.old) {
		if (stop()) return emptyReport(check, true);
		if (b.kind === "backup" && !checked.has(b.path) && (await ownerOf(b)) === "foreign") continue;
		owned.push(b);
	}
	plan.old = owned;
	for (const [path, bytes] of plan.bytesByNotebook) {
		const row = rows.get(path);
		if (row) {
			row.backupBytes += bytes;
			row.backupCount += plan.countByNotebook.get(path) ?? 0;
		}
	}

	// ---------------------------------------------------------- journals
	let journalFiles: JournalFile[] = [];
	if (options.journals) {
		try {
			journalFiles = await options.journals();
		} catch {
			journalFiles = [];
		}
	}
	const byDoc = new Map<string, NotebookRef[]>();
	for (const r of refs) if (r.docId) byDoc.set(journalDocKey(r.docId), [...(byDoc.get(journalDocKey(r.docId)) ?? []), r]);
	for (const j of journalFiles) {
		const owners = byDoc.get(j.name.split(".")[0] ?? "") ?? [];
		if (owners.length === 1) rows.get(owners[0]!.path)!.journalBytes += j.size;
	}
	for (const row of rows.values()) {
		row.sharedShareBytes = Math.round(row.sharedShareBytes);
		row.totalBytes = row.fileBytes + row.ownAssetBytes + row.sharedShareBytes + row.backupBytes + row.journalBytes;
	}

	// ---------------------------------------------------------- totals
	const totals = {
		notebooks: bucket(notebookFiles),
		assets: bucket(all.filter((f) => under(f.path, dir))),
		backups: bucket(all.filter((f) => under(f.path, config.backup))),
		trash: bucket(all.filter((f) => under(f.path, kept[0]!))),
		journal: bucket(journalFiles),
		other: bucket(all.filter((f) => [kept[2]!, kept[3]!, kept[4]!].some((k) => under(f.path, k)))),
		bytes: 0,
	};
	totals.bytes = totals.notebooks.bytes + totals.assets.bytes + totals.backups.bytes + totals.trash.bytes + totals.journal.bytes + totals.other.bytes;

	const report: StorageReport = {
		check, notebooks: [...rows.values()], totals, duplicates: [], heavy: [], oldBackups: plan.old,
		conflictsIdentical: [], conflictsDiffering: [], cancelled: false, unreadable: 0,
	};

	// ---------------------------------------------------------- heavy images (no reading: the sizes are in the listing)
	const usable = (id: string) => {
		const all = [...new Set(namedBy.get(id) ?? [])].filter((p) => rows.has(p));
		return { users: all.filter((p) => statusOf.get(p) === "ok"), blocked: all.filter((p) => statusOf.get(p) !== "ok") };
	};
	const images = assetFiles.filter((a) => IMAGE_EXT.test(a.path) && a.size > 0);
	report.heavy = images
		.filter((a) => a.size >= HEAVY_LIST_MIN)
		.map((file) => ({ file, ...usable(file.id) }))
		.filter((h) => h.users.length > 0)
		.sort((a, b) => b.file.size - a.file.size || (a.file.path < b.file.path ? -1 : 1))
		.slice(0, HEAVY_LIST_MAX);

	// ---------------------------------------------------------- duplicates: hash only images that share a size
	const bySize = new Map<number, AssetFile[]>();
	for (const a of images) bySize.set(a.size, [...(bySize.get(a.size) ?? []), a]);
	const toHash = [...bySize.values()].filter((g) => g.length > 1).flat();
	const hashed = new Map<string, AssetFile[]>();
	let done = 0;
	for (const a of toHash) {
		if (stop()) return { ...report, cancelled: true };
		const cached = cache.hashes.get(a.path);
		let h: string | null = cached && cached.mtime === a.mtime && cached.size === a.size ? cached.hash : null;
		if (h === null) {
			try {
				h = await hash(await source.readBinary(a.path));
				cache.hashes.set(a.path, { mtime: a.mtime, size: a.size, hash: h });
			} catch {
				report.unreadable++;
			}
		}
		if (h !== null) hashed.set(h, [...(hashed.get(h) ?? []), a]);
		options.progress?.("images", ++done, toHash.length);
		if (done % 4 === 0) await breathe();
	}
	for (const [h, members] of hashed) {
		if (members.length < 2) continue;
		const group = duplicateGroup(h, members, usable);
		if (group) report.duplicates.push(group);
	}
	report.duplicates.sort((a, b) => b.extraBytes - a.extraBytes || (a.keep.path < b.keep.path ? -1 : 1));

	// ---------------------------------------------------------- conflicted copies: compare with the main notebook
	const candidates = conflictCandidates(notebookFiles);
	let cdone = 0;
	for (const c of candidates) {
		if (stop()) return { ...report, cancelled: true };
		try {
			const [copyText, mainText] = [await source.read(c.path), await source.read(c.main)];
			const id = (path: string, text: string) => {
				const noted = cache.docIds.get(path);
				const f = byPath.get(path);
				return noted && f && noted.mtime === f.mtime && noted.size === f.size ? noted.docId : quickDocId(text);
			};
			const judged = judgeConflict(c, copyText, mainText, { copy: id(c.path, copyText), main: id(c.main, mainText) });
			(judged.identical ? report.conflictsIdentical : report.conflictsDiffering).push(judged);
		} catch {
			report.unreadable++;
		}
		options.progress?.("conflicts", ++cdone, candidates.length);
		await breathe();
	}
	return report;
}

/** The group of identical images that remain after leaving out copies nothing could use. Null when nothing is left to do. */
function duplicateGroup(hash: string, members: readonly AssetFile[], usable: (id: string) => { users: string[]; blocked: string[] }): DuplicateGroup | null {
	// The file that stays: one named by its own content (its id is the start of the hash), else the first by path. Of several
	// extensions of one id, the commonest wins (png, jpg, jpeg, webp, gif), so the choice does not depend on file names.
	const rank = (p: string) => Math.max(0, EXTENSION_RANK.indexOf(p.slice(p.lastIndexOf(".") + 1).toLowerCase()));
	const sorted = [...members].sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : 1));
	const keep = sorted.find((m) => hash.startsWith(m.id)) ?? sorted[0]!;
	const extras: DuplicateExtra[] = [];
	for (const file of sorted) {
		if (file === keep) continue;
		const { users, blocked } = usable(file.id);
		if (file.id === keep.id) extras.push({ file, kind: "same-id", users, blocked });
		else if (users.length > 0) extras.push({ file, kind: "other-id", users, blocked });
	}
	if (extras.length === 0) return null;
	return { hash, size: keep.size, keep, extras, extraBytes: extras.reduce((n, e) => n + e.file.size, 0) };
}

// ------------------------------------------------------------------ ordering

export type NotebookSort = "size" | "name" | "assets" | "backups";

/** The notebooks in the order asked for (largest first, except by name). Stable on the path. */
export function sortNotebooks(rows: readonly NotebookStorage[], by: NotebookSort, locale?: string): NotebookStorage[] {
	const key = (r: NotebookStorage): number => (by === "assets" ? r.ownAssetBytes + r.sharedShareBytes : by === "backups" ? r.backupBytes : r.totalBytes);
	const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
	return [...rows].sort((a, b) => (by === "name" ? collator.compare(a.name, b.name) : key(b) - key(a)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Stacked-bar parts of the totals: the categories that take space, largest first. */
export function totalsParts(totals: StorageTotals): Array<{ id: "notebooks" | "assets" | "backups" | "trash" | "journal" | "other"; bytes: number; share: number }> {
	const ids = ["notebooks", "assets", "backups", "trash", "journal", "other"] as const;
	const total = Math.max(1, totals.bytes);
	return ids.map((id) => ({ id, bytes: totals[id].bytes, share: totals[id].bytes / total })).filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}
