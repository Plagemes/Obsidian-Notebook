/**
 * 0.22 (roadmap #126): what one sync run does, decided from the facts of each path. Pure: no I/O, no `obsidian` import.
 *
 * Each path has a local side (absent / unchanged / changed since the base) and a remote side (the same), and maybe a base
 * (both sides at the last sync). The matrix:
 *
 * | base | local \ remote | absent              | unchanged             | changed   |
 * |------|----------------|---------------------|-----------------------|-----------|
 * | yes  | absent         | forget              | delete remote (1)     | download  |
 * | yes  | unchanged      | delete local (1)    | nothing               | download  |
 * | yes  | changed        | upload, create-only | upload if rev = base  | conflict  |
 * | no   | absent         | -                   | download              |           |
 * | no   | present        | upload, create-only | conflict (2)          |           |
 *
 * (1) Only on a trusted state, and only when the other side is unchanged since the base. On an untrusted state (first sync,
 *     damaged state) a deletion becomes a restore: the file is copied back to the side that lost it. Never more than the
 *     mass-deletion guard allows without a confirmation.
 * (2) Without a base both versions are compared by content first: the same bytes are simply adopted (first sync = union).
 *
 * A remote "change" is a new revision; a local change is a new size or time whose content hash differs (the engine hashes).
 */
import type { RemoteMeta } from "./state";

export interface LocalFacts {
	size: number;
	mtime: number;
	/** Differs from the base (true when there is no base). */
	changed: boolean;
}

export interface RemoteFacts extends RemoteMeta {
	/** Differs from the base (true when there is no base). */
	changed: boolean;
}

export interface PathFacts {
	path: string;
	local: LocalFacts | null;
	remote: RemoteFacts | null;
	/** Remote revision of the base, or null when the path has no base. */
	baseRev: string | null;
}

export type SyncAction =
	| { kind: "upload"; path: string; ifRev: string | null; size: number }
	| { kind: "download"; path: string; remote: RemoteMeta }
	| { kind: "delete-local"; path: string }
	| { kind: "delete-remote"; path: string; remote: RemoteMeta }
	/** Both sides hold a version not known to be the same: compared, then kept both when they differ. */
	| { kind: "conflict"; path: string; remote: RemoteMeta; size: number }
	| { kind: "forget"; path: string };

/**
 * What happens to deletions this run: guarded (stop and ask above the limits), allowed (confirmed), restored instead, or
 * deferred (review W22 S7: the runs at start-up and on leaving never delete; the next periodic or manual run does).
 */
export type DeletionPolicy = "guard" | "allow" | "restore" | "defer";
export type LargeRule = "ask" | "skip";

export interface PlanOptions {
	trusted: boolean;
	deletions: DeletionPolicy;
	/** Files larger than this (bytes) follow `large`; 0: no limit. */
	largeBytes: number;
	large: LargeRule;
	/** Large files the user agreed to transfer (paths). */
	approvedLarge: ReadonlySet<string>;
	/** Large files the user chose to skip for now (not asked again). */
	declinedLarge?: ReadonlySet<string>;
	/** Deletions the user confirmed (paths): never held back by the guard, and not counted by it. */
	allowedDeletes?: ReadonlySet<string>;
	/** The guard's absolute limit (default MASS_DELETE_MAX; automatic runs use MASS_DELETE_AUTO_MAX). */
	massDeleteMax?: number;
	/** Review W22 S16: files larger than this (bytes) are never transferred on this device, even when approved; 0: no cap. */
	hardMaxBytes?: number;
}

export interface Plan {
	/** To run now, in this order. */
	actions: SyncAction[];
	/** Deletions held back by the mass-deletion guard (the user is asked). */
	heldDeletes: SyncAction[];
	/** Large files waiting for the user's approval. */
	askLarge: SyncAction[];
	/** Large files skipped by the rule. */
	skippedLarge: SyncAction[];
	/** Files above the device's hard cap (`hardMaxBytes`): skipped, whatever the user approved. */
	tooLarge: SyncAction[];
	/** Deletions left for a later run (`deletions: "defer"`). */
	deferred: SyncAction[];
	/** Paths that have a base (the files tracked), for the guard's percentage. */
	tracked: number;
}

/** The mass-deletion guard: more than this many deletions in one run... */
export const MASS_DELETE_MAX = 20;
/** ...or, for an automatic run (review W22 S7), more than this many. */
export const MASS_DELETE_AUTO_MAX = 10;
/** ...or at least MASS_DELETE_MIN deletions that are more than this share of the tracked files, stop and ask. */
export const MASS_DELETE_SHARE = 0.3;
export const MASS_DELETE_MIN = 3;

export function massDeletion(deletions: number, tracked: number, max = MASS_DELETE_MAX): boolean {
	if (deletions > max) return true;
	return deletions >= MASS_DELETE_MIN && deletions > tracked * MASS_DELETE_SHARE;
}

const ORDER: Record<SyncAction["kind"], number> = { conflict: 0, download: 1, upload: 2, "delete-remote": 3, "delete-local": 4, forget: 5 };

/** The action for one path (null: nothing to do). */
export function decide(f: PathFacts, trusted: boolean): SyncAction | null {
	const { path, local, remote } = f;
	const hasBase = f.baseRev !== null;
	if (!hasBase) {
		if (local && remote) return { kind: "conflict", path, remote: strip(remote), size: Math.max(local.size, remote.size) };
		if (local) return { kind: "upload", path, ifRev: null, size: local.size };
		if (remote) return { kind: "download", path, remote: strip(remote) };
		return null;
	}
	if (!local && !remote) return { kind: "forget", path };
	if (!local) {
		// remote present
		if (remote!.changed) return { kind: "download", path, remote: strip(remote!) };
		return trusted ? { kind: "delete-remote", path, remote: strip(remote!) } : { kind: "download", path, remote: strip(remote!) };
	}
	if (!remote) {
		if (local.changed || !trusted) return { kind: "upload", path, ifRev: null, size: local.size };
		return { kind: "delete-local", path };
	}
	if (local.changed && remote.changed) return { kind: "conflict", path, remote: strip(remote), size: Math.max(local.size, remote.size) };
	if (local.changed) return { kind: "upload", path, ifRev: remote.rev, size: local.size };
	if (remote.changed) return { kind: "download", path, remote: strip(remote) };
	return null;
}

function strip(r: RemoteFacts): RemoteMeta {
	return { id: r.id, rev: r.rev, size: r.size, mtime: r.mtime };
}

/** The size an action transfers (for the large-file rule); 0 for deletions. */
export function transferSize(a: SyncAction): number {
	switch (a.kind) {
		case "upload": return a.size;
		case "download": return a.remote.size;
		case "conflict": return a.size;
		default: return 0;
	}
}

/** Turns a deletion into the restore of the file on the side that lost it. */
export function restoreOf(a: SyncAction, facts: ReadonlyMap<string, PathFacts>): SyncAction {
	if (a.kind === "delete-remote") return { kind: "download", path: a.path, remote: a.remote };
	if (a.kind === "delete-local") return { kind: "upload", path: a.path, ifRev: null, size: facts.get(a.path)?.local?.size ?? 0 };
	return a;
}

export function plan(facts: readonly PathFacts[], o: PlanOptions): Plan {
	const byPath = new Map(facts.map((f) => [f.path, f]));
	const tracked = facts.filter((f) => f.baseRev !== null).length;
	let actions: SyncAction[] = [];
	for (const f of facts) {
		const a = decide(f, o.trusted);
		if (a) actions.push(a);
	}
	const isDelete = (a: SyncAction) => a.kind === "delete-local" || a.kind === "delete-remote";
	let heldDeletes: SyncAction[] = [];
	let deferred: SyncAction[] = [];
	const allowed = o.allowedDeletes ?? new Set<string>();
	const unconfirmed = (a: SyncAction) => isDelete(a) && !allowed.has(a.path);
	const deletes = actions.filter(unconfirmed);
	if (deletes.length > 0) {
		if (o.deletions === "restore") actions = actions.map((a) => (unconfirmed(a) ? restoreOf(a, byPath) : a));
		else if (o.deletions === "defer") {
			deferred = deletes;
			actions = actions.filter((a) => !unconfirmed(a));
		} else if (o.deletions === "guard" && massDeletion(deletes.length, tracked, o.massDeleteMax)) {
			heldDeletes = deletes;
			actions = actions.filter((a) => !unconfirmed(a));
		}
	}
	const askLarge: SyncAction[] = [];
	const skippedLarge: SyncAction[] = [];
	const tooLarge: SyncAction[] = [];
	const cap = o.hardMaxBytes ?? 0;
	if (cap > 0) {
		actions = actions.filter((a) => {
			if (transferSize(a) <= cap) return true;
			tooLarge.push(a);
			return false;
		});
	}
	if (o.largeBytes > 0) {
		actions = actions.filter((a) => {
			if (transferSize(a) <= o.largeBytes || o.approvedLarge.has(a.path)) return true;
			(o.large === "skip" || o.declinedLarge?.has(a.path) ? skippedLarge : askLarge).push(a);
			return false;
		});
	}
	actions.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { actions, heldDeletes, askLarge, skippedLarge, tooLarge, deferred, tracked };
}
