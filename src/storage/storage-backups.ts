/**
 * Old backups and conflicted copies, for the Storage manager (roadmap #128). Pure: no 'obsidian'.
 *
 * What it recognises, and what it will and will not offer to move to the trash:
 *
 * - `<backup folder>/<name> <YYYYMMDD-HHmmss> <reason> [n ]<hash>.bak` (VaultDocumentIO.backup). Offered when older than the
 *   threshold, EXCEPT the newest ordinary backup of each notebook (a notebook is never left without its latest good copy: a
 *   newer recovery copy does not stand in for it), any backup of a notebook that is not in the vault any more or that cannot
 *   be read now (`readable: false`: the backups may be the only copy there is), and any backup whose own document id is not
 *   the notebook's (a new notebook reusing a deleted one's name does not inherit its backups: the caller checks the id from
 *   the file, `ownedBy`). Backups made to keep something that could not be saved or read (`unreadable`, `future-version`,
 *   `unsaved`, `journal`, `conflict`, `integrity`) are offered too, but marked `recovery` so the dialog does not tick them.
 *   What is offered goes through Obsidian's `trashFile`, so the user's "Deleted files" setting decides whether it is
 *   recoverable (it may be a permanent delete): the confirmation says so.
 * - `<backup folder>/history/<document id>/<YYYYMMDD-HHmm>.snapshot` (version history). Offered when older than the threshold
 *   and beyond the newest `keep` snapshots of that notebook; those of a document no notebook has are kept.
 * - A conflicted copy of a notebook (`Notes (1).notebook`, `Notes-DESKTOP-AB12.notebook`…, see storage/conflicts.ts) is
 *   offered only when it holds exactly what its main notebook holds (nothing to merge). One that differs, or whose id is not
 *   the main notebook's, is reported apart and never offered: merging is the user's choice.
 */
import { backupDate } from "./recovery";
import { conflictBaseOf, mayBeManualCopy, sameNotebookText } from "./conflicts";
import { parseSnapshotName, safeDocId } from "./history";

export const DAY_MS = 86_400_000;
/** Backups and snapshots younger than this are never offered. */
export const OLD_BACKUP_DAYS = 90;
/** The newest snapshots of a notebook that are never offered, whatever their age. */
export const SNAPSHOTS_KEPT_MIN = 3;

/** Backup reasons for copies that keep something which could not be saved or read: offered, but not ticked. */
export const RECOVERY_REASONS: readonly string[] = ["unreadable", "future-version", "unsaved", "journal", "conflict", "integrity"];

const BAK = /^(.+) (\d{8}-\d{6}) ([a-z-]+) (?:\d+ )?[0-9a-f]{8}\.bak$/;

export interface BackupName {
	/** The notebook's file name without extension. */
	base: string;
	reason: string;
	/** When the copy was made (from its name, local time), epoch ms. */
	at: number;
}

/** The parts of a `.bak` file name, or null when it is not one of ours. */
export function parseBackupName(name: string): BackupName | null {
	const m = BAK.exec(name);
	const date = backupDate(name);
	if (!m || !date) return null;
	// An impossible date (month 13…) is rolled over by the Date constructor: it is not one of our names.
	const stamp = m[2]!;
	const p2 = (n: number) => String(n).padStart(2, "0");
	const again = `${String(date.getFullYear()).padStart(4, "0")}${p2(date.getMonth() + 1)}${p2(date.getDate())}-${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
	if (again !== stamp) return null;
	return { base: m[1]!, reason: m[3]!, at: date.getTime() };
}

export interface FileInfo {
	path: string;
	size: number;
	mtime: number;
}

export type OldBackupKind = "backup" | "snapshot";

export interface OldBackup {
	kind: OldBackupKind;
	path: string;
	size: number;
	/** When the copy was made, epoch ms. */
	at: number;
	/** The notebook it belongs to (vault path). */
	notebook: string;
	/** Why the copy was made (`.bak` only). */
	reason?: string;
	/** A copy made to keep something that could not be saved or read: offered, never ticked by default. */
	recovery: boolean;
}

/** What the notebooks of the vault are, for matching their backups. */
export interface NotebookRef {
	path: string;
	/** File name without extension. */
	base: string;
	docId: string | null;
	/** Named like a conflicted copy of another notebook: it shares that notebook's document id, and does not own its backups. */
	copy?: boolean;
	/** False when the notebook cannot be read now (unreadable, not downloaded, a newer version): its backups are never offered. */
	readable?: boolean;
}

const baseName = (path: string): string => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
};

export function notebookRef(path: string, docId: string | null, copy = false, readable = true): NotebookRef {
	const ref: NotebookRef = { path, base: baseName(path), docId };
	if (copy) ref.copy = true;
	if (!readable) ref.readable = false;
	return ref;
}

export interface BackupPlan {
	/** Offered, oldest first. */
	old: OldBackup[];
	/** Backups and snapshots of every notebook: bytes by notebook path (for the per-notebook sizes). */
	bytesByNotebook: Map<string, number>;
	/** Backup and snapshot files by notebook path. */
	countByNotebook: Map<string, number>;
	/** Backups and snapshots that belong to no notebook of the vault (or to an ambiguous name): bytes. */
	unattributedBytes: number;
	/** Count of backup and snapshot files seen. */
	files: number;
}

/**
 * Sorts the backup folder's files: which notebook each belongs to, how many bytes each notebook has in backups, and which
 * are old enough to offer. `files` are the files of the vault (any; only those under `backupFolder` are looked at).
 */
export function planBackups(
	files: readonly FileInfo[], backupFolder: string, notebooks: readonly NotebookRef[], now: number,
	options: { days?: number; keepSnapshots?: number } = {},
): BackupPlan {
	const days = options.days ?? OLD_BACKUP_DAYS;
	const keep = Math.max(SNAPSHOTS_KEPT_MIN, Math.floor(options.keepSnapshots ?? 0));
	const cutoff = now - days * DAY_MS;
	const folder = backupFolder.replace(/\/+$/, "");
	const histories = `${folder}/history/`;

	// A base name is a notebook only when exactly one notebook has it: two "Notes" in different folders cannot be told apart.
	// A copy made by sync carries its notebook's document id: the notebook it copies owns the history, not the copy (unless the
	// copy is all there is).
	const byBase = new Map<string, NotebookRef[]>();
	for (const n of notebooks) byBase.set(n.base, [...(byBase.get(n.base) ?? []), n]);
	const byDoc = new Map<string, NotebookRef[]>();
	for (const n of notebooks) if (n.docId && !n.copy) byDoc.set(safeDocId(n.docId), [...(byDoc.get(safeDocId(n.docId)) ?? []), n]);
	for (const n of notebooks) if (n.docId && n.copy && !byDoc.has(safeDocId(n.docId))) byDoc.set(safeDocId(n.docId), [n]);

	const plan: BackupPlan = { old: [], bytesByNotebook: new Map(), countByNotebook: new Map(), unattributedBytes: 0, files: 0 };
	const add = (path: string, bytes: number) => {
		plan.bytesByNotebook.set(path, (plan.bytesByNotebook.get(path) ?? 0) + bytes);
		plan.countByNotebook.set(path, (plan.countByNotebook.get(path) ?? 0) + 1);
	};

	const baks = new Map<string, Array<{ file: FileInfo; name: BackupName }>>();
	const snaps = new Map<string, Array<{ file: FileInfo; at: number }>>();
	for (const f of files) {
		if (!f.path.startsWith(`${folder}/`)) continue;
		const rest = f.path.slice(folder.length + 1);
		if (rest.startsWith("history/")) {
			const parts = f.path.slice(histories.length).split("/");
			const at = parts.length === 2 ? parseSnapshotName(parts[1]!)?.getTime() : undefined;
			if (at === undefined) continue;
			plan.files++;
			const owners = byDoc.get(parts[0]!) ?? [];
			if (owners.length !== 1) {
				plan.unattributedBytes += f.size;
				continue;
			}
			add(owners[0]!.path, f.size);
			snaps.set(owners[0]!.path, [...(snaps.get(owners[0]!.path) ?? []), { file: f, at }]);
		} else if (!rest.includes("/")) {
			const name = parseBackupName(rest);
			if (!name) continue;
			plan.files++;
			const owners = byBase.get(name.base) ?? [];
			if (owners.length !== 1) {
				plan.unattributedBytes += f.size;
				continue;
			}
			add(owners[0]!.path, f.size);
			baks.set(owners[0]!.path, [...(baks.get(owners[0]!.path) ?? []), { file: f, name }]);
		}
	}

	const unreadable = new Set(notebooks.filter((n) => n.readable === false).map((n) => n.path));
	for (const [notebook, list] of baks) {
		if (unreadable.has(notebook)) continue;
		// The newest ordinary backup stays; a newer recovery copy (unreadable, unsaved…) does not replace it. When every copy is a
		// recovery copy, the newest of them stays.
		const ordinary = list.filter((b) => !RECOVERY_REASONS.includes(b.name.reason));
		const newest = (ordinary.length > 0 ? ordinary : list).reduce((a, b) => (b.name.at > a.name.at ? b : a));
		for (const { file, name } of list) {
			if (file === newest.file || name.at >= cutoff) continue;
			plan.old.push({ kind: "backup", path: file.path, size: file.size, at: name.at, notebook, reason: name.reason, recovery: RECOVERY_REASONS.includes(name.reason) });
		}
	}
	for (const [notebook, list] of snaps) {
		if (unreadable.has(notebook)) continue;
		const ordered = [...list].sort((a, b) => b.at - a.at || (a.file.path < b.file.path ? 1 : -1));
		for (const { file, at } of ordered.slice(keep)) {
			if (at >= cutoff) continue;
			plan.old.push({ kind: "snapshot", path: file.path, size: file.size, at, notebook, recovery: false });
		}
	}
	plan.old.sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : 1));
	return plan;
}

// ------------------------------------------------------------------ conflicted copies

export interface ConflictCopy {
	path: string;
	size: number;
	/** The notebook it is a copy of. */
	main: string;
	/** Holds exactly what the main notebook holds: nothing would be lost by moving it to the trash. */
	identical: boolean;
	/** Named like a copy the user may have made on purpose (`Notes (1)`). */
	maybeManual: boolean;
}

/** A conflict candidate: a notebook named like a copy of a sibling that exists in the same folder. */
export interface ConflictCandidate {
	path: string;
	main: string;
	size: number;
	maybeManual: boolean;
}

/**
 * Notebooks whose name looks like a conflicted copy of a notebook in the same folder (a name is only a hint: the caller
 * compares the two before anything is offered). `notebooks` are the paths of the vault's notebook files.
 */
export function conflictCandidates(notebooks: ReadonlyArray<{ path: string; size: number }>): ConflictCandidate[] {
	const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
	const byDir = new Map<string, Map<string, string>>();
	for (const n of notebooks) {
		const dir = dirOf(n.path);
		const stems = byDir.get(dir) ?? new Map<string, string>();
		stems.set(baseName(n.path), n.path);
		byDir.set(dir, stems);
	}
	const out: ConflictCandidate[] = [];
	for (const n of notebooks) {
		const stems = byDir.get(dirOf(n.path))!;
		const stem = baseName(n.path);
		const base = conflictBaseOf(stem, new Set(stems.keys()));
		if (base === null) continue;
		out.push({ path: n.path, main: stems.get(base)!, size: n.size, maybeManual: mayBeManualCopy(stem, base) });
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Judges one candidate from the texts of both files. Identical only when both parse to the same document
 * (`sameNotebookText`) and the ids agree; a text that does not parse is never identical.
 */
export function judgeConflict(candidate: ConflictCandidate, copyText: string, mainText: string, ids: { copy: string | null; main: string | null }): ConflictCopy {
	const identical = ids.copy !== null && ids.copy === ids.main && sameNotebookText(copyText, mainText);
	return { path: candidate.path, size: candidate.size, main: candidate.main, identical, maybeManual: candidate.maybeManual };
}
