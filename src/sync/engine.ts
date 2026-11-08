/**
 * 0.22 (roadmap #126): one cloud sync run. Pure orchestration over ports (no `obsidian` import): the vault side is a `LocalPort`
 * (src/sync/vault-adapter.ts in the plugin, a fake in the tests), the cloud side a `CloudProvider` (provider-types.ts).
 *
 * A run: read the device-local state -> list the remote changes (delta from the cursor, or everything) -> list the local files
 * in scope and hash the ones whose size or time moved -> plan (planner.ts) -> run the actions one by one -> save the state.
 * Rules that keep the user's files safe:
 *  - Nothing is ever deleted without a base, on a first sync or on a damaged state (planner); the mass-deletion guard stops and
 *    asks; a deletion needs the other side unchanged since the base; the local file goes to Obsidian's trash, the remote one to
 *    the cloud's trash, and only if its revision is still the one planned (`ifRev`).
 *  - Uploads are conditional (`ifRev`): a cloud file that changed meanwhile raises RemoteConflictError and the run plans again.
 *  - A local file is never overwritten if it changed since it was planned (`LocalPort.write` checks), and an open notebook is
 *    saved first and replaced only when nothing is left unsaved; otherwise both versions are kept.
 *  - Both sides changed: both are kept. The cloud's version is written next to the local file as a conflicted copy
 *    (conflict-name.ts), then the local one goes to the cloud. Identical contents are simply adopted.
 *  - Transient errors are retried (with the provider's retry-after), then the run stops and says so; a sign-in problem stops it.
 *  - Review W22: two cloud files with one path are both kept (the extra one becomes a conflicted copy, then goes to the cloud's
 *    trash); a revision the provider overwrote without being able to refuse it (Drive) is kept as a conflicted copy; names that
 *    cannot exist on every device are skipped with a note, never taken for a deletion (names.ts); a case-only rename on one
 *    side is followed; a cloud version whose content is the base's is not a conflict.
 */
import { withoutUrls } from "./auth/retry";
import { conflictCopyPath } from "./conflict-name";
import { foldKey, syncablePath } from "./names";
import { plan, type DeletionPolicy, type LargeRule, type PathFacts, type SyncAction } from "./planner";
import { AuthRequiredError, RemoteConflictError, TransientRemoteError, type CloudProvider, type RemoteChanges, type RemoteEntry, type UploadedEntry } from "./provider-types";
import { inScope, type FixedExclusions, type ScopeRules } from "./rules";
import { MAX_PATHS, readState, setRecord, writeState, type BaseMeta, type RemoteMeta, type SyncState } from "./state";

export interface LocalStat {
	size: number;
	mtime: number;
}

export interface LocalFile extends LocalStat {
	path: string;
}

/** The local file is not what the run planned on (it changed, appeared or went away meanwhile): the action is skipped. */
export class LocalChangedError extends Error {
	constructor(readonly path: string) {
		super(`Local file changed during sync: ${path}`);
		this.name = "LocalChangedError";
	}
}

/** The vault, as the engine sees it. */
export interface LocalPort {
	/** Every file of the vault (the engine applies the scope). */
	list(): LocalFile[];
	stat(path: string): Promise<LocalStat | null>;
	read(path: string): Promise<ArrayBuffer>;
	/**
	 * Creates (`expect` null: only if no file is there) or replaces (`expect`: only if the file still has that size and time) the
	 * file, creating folders as needed. Throws LocalChangedError otherwise. Returns the file's size and time after the write.
	 */
	write(path: string, data: ArrayBuffer, expect: LocalStat | null): Promise<LocalStat>;
	/** Moves the file to the trash, only if it still has that size and time (else LocalChangedError). */
	trash(path: string, expect: LocalStat): Promise<void>;
	/** Saves a notebook open at `path` (its view's flush). True when nothing is left unsaved (or it is not open). */
	settle(path: string): Promise<boolean>;
}

/** Where the state lives (a device-local file). `load` gives null when there is none. */
export interface StatePort {
	load(): Promise<unknown>;
	save(data: Record<string, unknown>): Promise<void>;
}

export interface SyncPorts {
	local: LocalPort;
	remote: CloudProvider;
	state: StatePort;
	/** Content hash, lower-case hex (SHA-256 in the plugin). */
	hash(data: ArrayBuffer): Promise<string>;
	now(): number;
	sleep(ms: number): Promise<void>;
	signal?: AbortSignal;
	progress?(done: number, total: number): void;
}

export interface SyncOptions {
	/** Remote id of the root folder (binds the state). */
	root: string | null;
	scope: ScopeRules;
	fixed: FixedExclusions;
	deletions: DeletionPolicy;
	largeBytes: number;
	large: LargeRule;
	approvedLarge: ReadonlySet<string>;
	/** Large files skipped for now at the user's choice. */
	declinedLarge?: ReadonlySet<string>;
	/** Deletions the user confirmed after the mass-deletion guard asked. */
	allowedDeletes?: ReadonlySet<string>;
	/** Device label for the names of conflicted copies. */
	device: string;
	/** Attempts per remote call on a transient error (default 3). */
	attempts?: number;
	/** The mass-deletion guard's absolute limit (default MASS_DELETE_MAX). */
	massDeleteMax?: number;
	/** Files above this many bytes are never transferred on this device (the mobile cap); 0 or undefined: no cap. */
	hardMaxBytes?: number;
}

export type SyncOutcome =
	/** Everything planned was done. */
	| "ok"
	/** Done, but some files were skipped or failed (see events). */
	| "partial"
	/** Deletions held back by the mass-deletion guard, or large files waiting: the user is asked. */
	| "confirm"
	/** Sign-in required. */
	| "auth"
	/** The cloud could not be reached (after retries). */
	| "offline"
	/** More files than the state can hold: narrow the scope. */
	| "too-many"
	| "cancelled"
	| "failed";

export type SyncEventKind = "up" | "down" | "del-local" | "del-remote" | "conflict" | "same" | "skip" | "error";

export interface SyncEvent {
	kind: SyncEventKind;
	path: string;
	/** For a conflict: the copy's path. For a skip or an error: why. */
	detail?: string;
}

export interface SyncCounts {
	up: number;
	down: number;
	delLocal: number;
	delRemote: number;
	conflicts: number;
	skipped: number;
	errors: number;
}

export interface SyncResult {
	outcome: SyncOutcome;
	/** The run started without a trusted state (first sync, or after damage). */
	first: boolean;
	/** The stored state could not be read in full. */
	damaged: boolean;
	counts: SyncCounts;
	/** What happened, at most MAX_EVENTS. */
	events: SyncEvent[];
	heldDeletes: { path: string; side: "local" | "remote" }[];
	askLarge: { path: string; size: number }[];
	skippedLarge: { path: string; size: number }[];
	/** Files above this device's size cap, skipped (review W22 S16). */
	tooLarge: { path: string; size: number }[];
	/** Deletions left for a later run (review W22 S7: runs at start-up and on leaving never delete). */
	deferredDeletes: number;
	/** Paths skipped because their name cannot exist on every device (review W22 S10). */
	unsyncable: string[];
	error?: string;
	retryAfterMs?: number;
}

export const MAX_EVENTS = 200;
const MAX_ROUNDS = 3;
/** The state is saved at most this often during a run (review W22 S11), and always at the end. */
export const SAVE_EVERY_MS = 10_000;

/** A result with nothing done yet. */
export function emptyResult(outcome: SyncOutcome = "ok"): SyncResult {
	return {
		outcome, first: false, damaged: false, events: [], heldDeletes: [], askLarge: [], skippedLarge: [], tooLarge: [], deferredDeletes: 0, unsyncable: [],
		counts: { up: 0, down: 0, delLocal: 0, delRemote: 0, conflicts: 0, skipped: 0, errors: 0 },
	};
}

/** A stable text for the scope (a change lists the remote again and drops records now out of scope). */
export function scopeKey(scope: ScopeRules, fixed: FixedExclusions): string {
	return JSON.stringify([scope.mode, scope.folders, scope.include, scope.exclude, scope.types, fixed.configDir, fixed.backupFolder]);
}

/**
 * A path from the provider as a vault path ("/"-separated, no leading slash), or null when unusable: empty segments, "." or "..",
 * and (review W22 S10) a backslash, which is part of a cloud name, never a folder separator.
 */
export function remotePath(path: string): string | null {
	const p = path.replace(/^\/+/, "");
	if (!p || p.includes("\\") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
	return p;
}

const metaOf = (e: RemoteEntry): RemoteMeta => ({ id: e.id, rev: e.rev, size: e.size, mtime: e.mtime });

export interface AppliedChanges {
	/** The cloud file each path follows (the one recorded in the state). */
	main: Map<string, RemoteEntry>;
	/** Review W22 S4: other cloud files listed at the same path (possible on Google Drive), to keep as conflicted copies. */
	twins: Map<string, RemoteEntry[]>;
	/** Cloud paths whose names cannot exist on every device (review W22 S10): skipped, with a note. */
	unsyncable: string[];
}

/**
 * Applies a listing to the remote index of `state` (only paths in scope are kept).
 *  - Two cloud files at one path: the newest (then the smallest id) is followed (every device picks the same), the others are
 *    returned as twins for the engine to keep as conflicted copies.
 *  - A cloud file renamed to a name that cannot exist here: its old path forgets its base, so the local file is never deleted
 *    for it (it goes up again under its old name), and the new name is reported as unsyncable.
 */
export function applyChanges(state: SyncState, changes: RemoteChanges, keep: (path: string) => boolean): AppliedChanges {
	const before = new Map<string, string>();
	for (const [path, rec] of state.paths) if (rec.r) before.set(rec.r.id, path);
	if (changes.full) {
		for (const [path, rec] of [...state.paths]) if (rec.r) setRecord(state, path, { r: null });
	} else {
		for (const raw of changes.deletions) {
			const p = remotePath(raw);
			if (p) setRecord(state, p, { r: null });
		}
	}
	const byPath = new Map<string, Map<string, RemoteEntry>>();
	const unsyncable: string[] = [];
	for (const e of changes.upserts) {
		const p = remotePath(e.path);
		if (!p || !syncablePath(p)) {
			const old = before.get(e.id);
			const rec = old === undefined ? undefined : state.paths.get(old);
			if (old !== undefined && (!rec?.r || rec.r.id === e.id)) setRecord(state, old, { r: null, b: null });
			if (keep(e.path.replace(/\\/g, "/"))) unsyncable.push(e.path);
			continue;
		}
		if (!keep(p)) continue;
		let ids = byPath.get(p);
		if (!ids) byPath.set(p, (ids = new Map<string, RemoteEntry>()));
		ids.set(e.id, e);
	}
	const main = new Map<string, RemoteEntry>();
	const twins = new Map<string, RemoteEntry[]>();
	for (const [p, ids] of byPath) {
		// Review round 2 (R2-4): the newest is followed (the device's current content stays, the older twin becomes the copy); ties
		// go to the smallest id. The same listing gives the same pick on every device.
		const list = [...ids.values()].sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const first = list[0]!;
		main.set(p, first);
		if (list.length > 1) twins.set(p, list.slice(1));
		setRecord(state, p, { r: metaOf(first) });
	}
	state.cursor = changes.cursor || null;
	return { main, twins, unsyncable };
}

const isErr = (e: unknown, name: string): boolean => e instanceof Error && e.name === name;
const isAuth = (e: unknown) => e instanceof AuthRequiredError || isErr(e, "AuthRequiredError");
const isTransient = (e: unknown): e is TransientRemoteError => e instanceof TransientRemoteError || isErr(e, "TransientRemoteError");
const isRemoteConflict = (e: unknown) => e instanceof RemoteConflictError || isErr(e, "RemoteConflictError");
const isLocalChanged = (e: unknown) => e instanceof LocalChangedError || isErr(e, "LocalChangedError");
const isAbort = (e: unknown) => isErr(e, "AbortError");
const sameStat = (a: LocalStat | null, b: LocalStat | null) => (a === null || b === null ? a === b : a.size === b.size && a.mtime === b.mtime);
const message = (e: unknown) => withoutUrls(e instanceof Error ? e.message : String(e));

class Stop extends Error {
	constructor(readonly outcome: SyncOutcome, readonly cause: unknown) {
		super(message(cause));
	}
}

class Run {
	readonly result: SyncResult;
	private state!: SyncState;
	private readonly attempts: number;
	private replan = false;
	private lastSave: number;
	private local = new Map<string, LocalFile>();

	constructor(private readonly p: SyncPorts, private readonly o: SyncOptions) {
		this.attempts = Math.max(1, o.attempts ?? 3);
		this.result = emptyResult();
		this.lastSave = p.now();
	}

	private event(kind: SyncEventKind, path: string, detail?: string): void {
		if (this.result.events.length < MAX_EVENTS) this.result.events.push(detail === undefined ? { kind, path } : { kind, path, detail });
	}

	private skip(path: string, why: string): void {
		this.result.counts.skipped++;
		this.event("skip", path, why);
	}

	private checkAbort(): void {
		if (this.p.signal?.aborted) throw new Stop("cancelled", new Error("cancelled"));
	}

	/** A remote call, retried on transient errors; auth and persistent transient errors stop the run. */
	private async remote<T>(fn: () => Promise<T>): Promise<T> {
		for (let i = 0; ; i++) {
			this.checkAbort();
			try {
				return await fn();
			} catch (e) {
				if (isAbort(e)) throw new Stop("cancelled", e);
				if (isAuth(e)) throw new Stop("auth", e);
				if (isTransient(e)) {
					if (i + 1 < this.attempts) {
						await this.p.sleep(Math.min(60_000, e.retryAfterMs ?? 1000 * 2 ** i));
						continue;
					}
					this.result.retryAfterMs = e.retryAfterMs;
					throw new Stop("offline", e);
				}
				throw e;
			}
		}
	}

	/** Saves the state at most every SAVE_EVERY_MS during a run (a full rewrite each time), and when `force`d at the end. */
	private async save(force = false): Promise<void> {
		const now = this.p.now();
		if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
		this.lastSave = now;
		await this.p.state.save(writeState(this.state));
	}

	private inScope = (path: string): boolean => inScope(path, this.o.scope, this.o.fixed);

	async run(): Promise<SyncResult> {
		const provider = this.p.remote.id;
		let loaded: unknown = null;
		try {
			loaded = await this.p.state.load();
		} catch (e) {
			console.error("[notebook] cloud sync: the sync state could not be read; starting over safely", e);
			this.result.damaged = true;
		}
		const read = readState(loaded, provider, this.o.root);
		this.state = read.state;
		this.result.damaged ||= read.damaged;
		this.result.first = !this.state.trusted;
		// A new scope: list everything again, and forget records of paths now out of scope (never deleting anything).
		const key = scopeKey(this.o.scope, this.o.fixed);
		if (this.state.scope !== key) {
			this.state.cursor = null;
			for (const path of [...this.state.paths.keys()]) if (!this.inScope(path)) this.state.paths.delete(path);
			this.state.scope = key;
		}
		try {
			for (let round = 0; round < MAX_ROUNDS; round++) {
				this.replan = false;
				await this.round(round === 0);
				if (!this.replan || this.result.outcome === "too-many") break;
			}
			if (this.result.outcome === "ok" || this.result.outcome === "partial" || this.result.outcome === "confirm") {
				this.state.trusted = true;
				if (this.result.outcome === "ok" && (this.result.counts.skipped > 0 || this.result.counts.errors > 0)) this.result.outcome = "partial";
			}
		} catch (e) {
			if (e instanceof Stop) {
				this.result.outcome = e.outcome;
				this.result.error = message(e.cause);
			} else {
				this.result.outcome = "failed";
				this.result.error = message(e);
				console.error("[notebook] cloud sync failed", e);
			}
		}
		try {
			await this.save(true);
		} catch (e) {
			console.error("[notebook] cloud sync: the sync state could not be saved", e);
			if (this.result.outcome === "ok" || this.result.outcome === "partial") {
				this.result.outcome = "failed";
				this.result.error = message(e);
			}
		}
		return this.result;
	}

	/** Lists, plans and runs once. */
	private async round(first: boolean): Promise<void> {
		const cursor = this.state.cursor ?? undefined;
		const changes = await this.remote(() => this.p.remote.changes(cursor, this.p.signal));
		const applied = applyChanges(this.state, changes, this.inScope);
		this.local = new Map(this.p.local.list().filter((f) => this.inScope(f.path)).map((f) => [f.path, f]));
		const paths = new Set<string>(this.local.keys());
		for (const [path, rec] of this.state.paths) if (rec.r || rec.b) paths.add(path);
		if (paths.size > MAX_PATHS) {
			this.result.outcome = "too-many";
			this.result.error = String(paths.size);
			return;
		}
		if (first) for (const raw of applied.unsyncable) this.unsyncable(raw);
		// Two cloud files with one path: the extra ones become conflicted copies first (nothing is hidden or lost).
		const blocked = new Set<string>();
		for (const [path, twins] of [...applied.twins].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			this.checkAbort();
			try {
				await this.resolveTwins(path, applied.main.get(path)!, twins);
			} catch (e) {
				if (e instanceof Stop) throw e;
				blocked.add(path);
				if (isRemoteConflict(e)) this.replan = true;
				else {
					console.error("[notebook] cloud sync: two cloud files with one name could not be kept apart", path, e);
					if (first) this.skip(path, "duplicate");
				}
			}
		}
		// Names that differ only by case (or by Unicode normalisation) are one file on some systems: never guessed. A case-only
		// rename on one side is followed (review W22 S9); anything else is skipped with a note.
		const groups = new Map<string, string[]>();
		for (const p of paths) {
			const k = foldKey(p);
			const g = groups.get(k);
			if (g) g.push(p);
			else groups.set(k, [p]);
		}
		const facts: PathFacts[] = [];
		const renames: { path: string; run: () => Promise<void> }[] = [];
		const seenGroups = new Set<string>();
		for (const path of [...paths].sort()) {
			this.checkAbort();
			if (blocked.has(path)) continue;
			if (!syncablePath(path)) {
				if (first) this.unsyncable(path);
				continue;
			}
			const key = foldKey(path);
			const group = groups.get(key)!;
			if (group.length > 1) {
				if (seenGroups.has(key)) continue;
				seenGroups.add(key);
				const rename = group.length === 2 ? await this.caseRename(group) : null;
				if (rename) renames.push(rename);
				else if (first) for (const p of group) this.skip(p, "case");
				continue;
			}
			facts.push(await this.factsOf(path));
		}
		const planned = plan(facts, {
			trusted: this.state.trusted, deletions: this.o.deletions, largeBytes: this.o.largeBytes, large: this.o.large, approvedLarge: this.o.approvedLarge,
			declinedLarge: this.o.declinedLarge, allowedDeletes: this.o.allowedDeletes, massDeleteMax: this.o.massDeleteMax, hardMaxBytes: this.o.hardMaxBytes,
		});
		// Review round 2 (R2-1): a kept file whose copy back cannot run now loses its base, so no later run reads it as deleted.
		for (const p of planned.unbase) if (this.state.paths.get(p)?.b) setRecord(this.state, p, { b: null });
		// Review round 2 (R2-9): a file renamed here (outside Obsidian) to a name the sync skips is not a deletion in the cloud.
		const renamedAway = await this.renamedToSkippedNames(planned.actions.concat(planned.heldDeletes), paths);
		if (renamedAway.size > 0) {
			planned.actions = planned.actions.filter((a) => !renamedAway.has(a.path));
			planned.heldDeletes = planned.heldDeletes.filter((a) => !renamedAway.has(a.path));
			if (first) for (const p of renamedAway) this.skip(p, "name");
		}
		if (first) {
			this.result.heldDeletes = planned.heldDeletes.map((a) => ({ path: a.path, side: a.kind === "delete-local" ? "local" : "remote" }));
			this.result.askLarge = planned.askLarge.map((a) => ({ path: a.path, size: sizeOf(a) }));
			this.result.skippedLarge = planned.skippedLarge.map((a) => ({ path: a.path, size: sizeOf(a) }));
			this.result.tooLarge = planned.tooLarge.map((a) => ({ path: a.path, size: sizeOf(a) }));
			this.result.deferredDeletes = planned.deferred.length;
			for (const a of planned.skippedLarge) this.skip(a.path, "large");
			for (const a of planned.tooLarge) this.skip(a.path, "too-large");
			if (planned.heldDeletes.length > 0 || planned.askLarge.length > 0) this.result.outcome = "confirm";
		}
		const byPath = new Map(facts.map((f) => [f.path, f]));
		const work = [...planned.actions.map((a) => ({ path: a.path, what: a.kind, run: () => this.act(a, byPath.get(a.path)!) })), ...renames.map((r) => ({ ...r, what: "rename" }))];
		const total = work.length;
		let done = 0;
		for (const w of work) {
			this.checkAbort();
			try {
				await w.run();
			} catch (e) {
				if (e instanceof Stop) throw e;
				if (isRemoteConflict(e)) this.replan = true;
				else if (isLocalChanged(e)) this.skip(w.path, "changed");
				else {
					this.result.counts.errors++;
					this.event("error", w.path, message(e));
					console.error(`[notebook] cloud sync: ${w.what} ${w.path} failed`, e);
				}
			}
			this.p.progress?.(++done, total);
			await this.save();
		}
	}

	/**
	 * Review round 2 (R2-9): the paths among `actions`' cloud deletions whose file is still here under a name the sync skips (a
	 * rename made outside Obsidian): same size and the same content hash as at the last sync.
	 */
	private async renamedToSkippedNames(actions: readonly SyncAction[], paths: ReadonlySet<string>): Promise<Set<string>> {
		const out = new Set<string>();
		const deletions = actions.filter((a) => a.kind === "delete-remote");
		if (deletions.length === 0) return out;
		const skipped = [...paths].filter((p) => !syncablePath(p)).map((p) => this.local.get(p)).filter((f): f is LocalFile => !!f);
		if (skipped.length === 0) return out;
		const hashes = new Map<string, string | null>();
		const hashOf = async (path: string): Promise<string | null> => {
			if (!hashes.has(path)) {
				try {
					hashes.set(path, await this.p.hash(await this.p.local.read(path)));
				} catch {
					hashes.set(path, null);
				}
			}
			return hashes.get(path) ?? null;
		};
		for (const a of deletions) {
			const base = this.state.paths.get(a.path)?.b;
			if (!base) continue;
			for (const f of skipped) {
				if (f.size !== base.ls) continue;
				if ((await hashOf(f.path)) === base.lh) {
					out.add(a.path);
					break;
				}
			}
		}
		return out;
	}

	/** A path skipped because its name cannot exist on every device: noted once per run, never deleted on either side. */
	private unsyncable(path: string): void {
		if (this.result.unsyncable.includes(path)) return;
		this.result.unsyncable.push(path);
		this.skip(path, "name");
	}

	/**
	 * Review W22 S9: two paths that differ only by case, one synced (with a base) and gone on one side, the other new on that same
	 * side: a rename made on that side. Followed like one (the old name goes to the trash, the new one is copied), only on a
	 * trusted state and when deletions may run now; both sides must be otherwise unchanged. Null: not a rename, skip both.
	 */
	private async caseRename(group: string[]): Promise<{ path: string; run: () => Promise<void> } | null> {
		if (!this.state.trusted || (this.o.deletions !== "guard" && this.o.deletions !== "allow")) return null;
		const withBase = group.filter((p) => !!this.state.paths.get(p)?.b);
		if (withBase.length !== 1) return null;
		const oldPath = withBase[0]!;
		const newPath = group.find((p) => p !== oldPath)!;
		const a = await this.factsOf(oldPath);
		const b = await this.factsOf(newPath);
		if (!a.local && a.remote && !a.remote.changed && b.local && !b.remote) {
			// Renamed here: the cloud's old name goes to its trash, then the new name goes up.
			const remote = { id: a.remote.id, rev: a.remote.rev, size: a.remote.size, mtime: a.remote.mtime };
			return { path: newPath, run: async () => {
				await this.deleteRemote(oldPath, remote);
				await this.upload(newPath, null, b);
			} };
		}
		if (!a.remote && a.local && !a.local.changed && b.remote && !b.local) {
			// Renamed in the cloud: the old local name goes to Obsidian's trash, then the new name comes down.
			const remote = { id: b.remote.id, rev: b.remote.rev, size: b.remote.size, mtime: b.remote.mtime };
			return { path: newPath, run: async () => {
				await this.deleteLocal(oldPath, a);
				if (this.local.has(oldPath)) return; // not moved (unsaved, or changed): nothing is written over it
				await this.download(newPath, remote, b);
			} };
		}
		return null;
	}

	/**
	 * Review W22 S4: the extra cloud files listed at `path` (Drive allows two files with one name). Each is kept: a copy with the
	 * same content as the followed one is just moved to the cloud's trash; any other is written next to the file as a conflicted
	 * copy (and uploaded under that name), then moved to the cloud's trash. Every device follows the same file (newest, then
	 * smallest id). A twin above this device's size cap is left alone in the cloud (review round 2 R2-7).
	 */
	private async resolveTwins(path: string, main: RemoteEntry, twins: RemoteEntry[]): Promise<void> {
		const cap = this.o.hardMaxBytes ?? 0;
		for (const t of twins) {
			const same = !!t.hash && !!main.hash && t.hashAlg === main.hashAlg && t.hash === main.hash && t.size === main.size;
			if (!same && cap > 0 && t.size > cap) {
				this.skip(path, "too-large");
				continue;
			}
			if (!same) {
				const data = await this.remote(() => this.p.remote.download(t.id, this.p.signal));
				const hash = await this.p.hash(data);
				const copy = await this.writeCopy(path, data);
				await this.uploadCopy(copy, data, hash);
			} else this.event("same", path, "duplicate");
			await this.remote(() => this.p.remote.remove(t.id, t.rev, this.p.signal));
		}
	}

	/** The facts of one path; a local file whose size or time moved is hashed to tell a real change from a touch. */
	private async factsOf(path: string): Promise<PathFacts> {
		const rec = this.state.paths.get(path);
		const base = rec?.b ?? null;
		const lf = this.local.get(path) ?? null;
		let local: PathFacts["local"] = null;
		if (lf) {
			let changed = true;
			if (base) {
				if (lf.size === base.ls && lf.mtime === base.lm) changed = false;
				else if (lf.size === base.ls) {
					try {
						const h = await this.p.hash(await this.p.local.read(path));
						if (h === base.lh) {
							changed = false;
							setRecord(this.state, path, { b: { ...base, lm: lf.mtime } });
						}
					} catch (e) {
						console.error("[notebook] cloud sync: could not read", path, e);
					}
				}
			}
			local = { size: lf.size, mtime: lf.mtime, changed };
		}
		const r = rec?.r ?? null;
		return {
			path,
			local,
			remote: r ? { ...r, changed: base ? r.rev !== base.rr : true } : null,
			baseRev: base ? base.rr : null,
		};
	}

	private async act(a: SyncAction, f: PathFacts): Promise<void> {
		switch (a.kind) {
			case "upload": return this.upload(a.path, a.ifRev, f);
			case "download": return this.download(a.path, a.remote, f);
			case "conflict": return this.conflict(a.path, a.remote, f);
			case "delete-remote": return this.deleteRemote(a.path, a.remote);
			case "delete-local": return this.deleteLocal(a.path, f);
			case "forget":
				setRecord(this.state, a.path, { r: null, b: null });
				return;
		}
	}

	/** Reads a stable local file: saved first if it is an open notebook, and unchanged while it was read. */
	private async readStable(path: string): Promise<{ data: ArrayBuffer; stat: LocalStat; hash: string } | null> {
		if (!(await this.p.local.settle(path))) {
			this.skip(path, "unsaved");
			return null;
		}
		const before = await this.p.local.stat(path);
		if (!before) throw new LocalChangedError(path);
		const data = await this.p.local.read(path);
		const after = await this.p.local.stat(path);
		if (!sameStat(before, after)) throw new LocalChangedError(path);
		return { data, stat: before, hash: await this.p.hash(data) };
	}

	private async upload(path: string, ifRev: string | null, f: PathFacts): Promise<void> {
		const got = await this.readStable(path);
		if (!got) return;
		const base = this.state.paths.get(path)?.b;
		if (base && f.remote && !f.remote.changed && got.hash === base.lh) {
			// Touched but the same content: nothing to send.
			setRecord(this.state, path, { b: { ...base, lm: got.stat.mtime, ls: got.stat.size } });
			return;
		}
		const entry = await this.remote(() => this.p.remote.upload(path, got.data, ifRev, this.p.signal, { maxBytes: this.o.hardMaxBytes ?? 0 }));
		const meta = metaOf(entry);
		setRecord(this.state, path, { r: meta, b: { lm: got.stat.mtime, ls: got.stat.size, lh: got.hash, rr: meta.rev } });
		this.result.counts.up++;
		this.event("up", path);
		await this.keepDisplaced(path, entry);
	}

	/**
	 * Review W22 S3: revisions another device wrote just before our upload replaced them (the provider could not refuse the write:
	 * Google Drive). Each is kept as a conflicted copy, here and in the cloud.
	 */
	private async keepDisplaced(path: string, entry: UploadedEntry): Promise<void> {
		if (entry.displacedUnknown) {
			// Review round 2 (R2-3): our write is in the cloud, but whether it replaced another device's version is unknown: said, so
			// the user can look at the file's version history in the cloud.
			this.result.counts.errors++;
			this.event("error", path, "uploaded, but a version written at the same moment by another device could not be checked: see the file's version history in the cloud");
		}
		for (const d of entry.displaced ?? []) {
			if (!d.data) {
				// Review round 2 (R2-7): above this device's size cap; it stays in the cloud's version history.
				this.result.counts.errors++;
				this.event("error", path, `the replaced cloud version ${d.rev} is too large to keep on this device: it is in the file's version history in the cloud`);
				continue;
			}
			const data = d.data;
			try {
				const copy = await this.writeCopy(path, data);
				await this.uploadCopy(copy, data, await this.p.hash(data));
			} catch (e) {
				if (e instanceof Stop) throw e;
				this.result.counts.errors++;
				this.event("error", path, `the replaced cloud version ${d.rev} could not be kept: ${message(e)}`);
				console.error("[notebook] cloud sync: a replaced cloud version could not be kept", path, e);
			}
		}
	}

	private async download(path: string, remote: RemoteMeta, f: PathFacts): Promise<void> {
		const expect: LocalStat | null = f.local ? { size: f.local.size, mtime: f.local.mtime } : null;
		if (expect && !(await this.p.local.settle(path))) {
			// An open notebook with unsaved changes is never replaced: the cloud's version is kept beside it.
			await this.keepBoth(path, remote, null);
			return;
		}
		if (!sameStat(await this.p.local.stat(path), expect)) throw new LocalChangedError(path);
		const data = await this.remote(() => this.p.remote.download(remote.id, this.p.signal));
		const hash = await this.p.hash(data);
		const st = await this.p.local.write(path, data, expect);
		setRecord(this.state, path, { r: remote, b: { lm: st.mtime, ls: st.size, lh: hash, rr: remote.rev } });
		this.result.counts.down++;
		this.event("down", path);
	}

	private async conflict(path: string, remote: RemoteMeta, f: PathFacts): Promise<void> {
		if (!f.local) return this.download(path, remote, f);
		const got = await this.readStable(path);
		if (!got) {
			// Unsaved changes in an open notebook: keep the cloud's version beside it; the local one goes up next time.
			await this.keepBoth(path, remote, null);
			return;
		}
		await this.keepBoth(path, remote, got);
	}

	/**
	 * Both versions are kept: the cloud's is written as a conflicted copy next to the file (and uploaded under that name), then the
	 * local one (when `local` is given) replaces the cloud's under the original name. Identical contents are just adopted.
	 */
	private async keepBoth(path: string, remote: RemoteMeta, local: { data: ArrayBuffer; stat: LocalStat; hash: string } | null): Promise<void> {
		const data = await this.remote(() => this.p.remote.download(remote.id, this.p.signal));
		const hash = await this.p.hash(data);
		if (local && local.hash === hash) {
			setRecord(this.state, path, { r: remote, b: { lm: local.stat.mtime, ls: local.stat.size, lh: hash, rr: remote.rev } });
			this.event("same", path);
			return;
		}
		const base = this.state.paths.get(path)?.b;
		if (base && base.lh === hash) {
			// Review W22 S6: a new cloud revision with the base's content (metadata only, or a provider that re-tagged the file): only
			// this side changed, so it goes up on that revision; no conflicted copy.
			if (!local) {
				setRecord(this.state, path, { r: remote, b: { ...base, rr: remote.rev } });
				return;
			}
			const up = await this.remote(() => this.p.remote.upload(path, local.data, remote.rev, this.p.signal, { maxBytes: this.o.hardMaxBytes ?? 0 }));
			const meta = metaOf(up);
			setRecord(this.state, path, { r: meta, b: { lm: local.stat.mtime, ls: local.stat.size, lh: local.hash, rr: meta.rev } });
			this.result.counts.up++;
			this.event("up", path);
			await this.keepDisplaced(path, up);
			return;
		}
		const copy = await this.writeCopy(path, data);
		// The cloud's version is accounted for: the base is that version, so the local file reads as changed and goes up (now, or on
		// the next run when it could not be read now).
		const theirs: BaseMeta = { lm: 0, ls: data.byteLength, lh: hash, rr: remote.rev };
		setRecord(this.state, path, { r: remote, b: theirs });
		await this.uploadCopy(copy, data, hash);
		if (!local) return;
		const up = await this.remote(() => this.p.remote.upload(path, local.data, remote.rev, this.p.signal, { maxBytes: this.o.hardMaxBytes ?? 0 }));
		const meta = metaOf(up);
		setRecord(this.state, path, { r: meta, b: { lm: local.stat.mtime, ls: local.stat.size, lh: local.hash, rr: meta.rev } });
		this.result.counts.up++;
		await this.keepDisplaced(path, up);
	}

	/** Writes `data` as a new conflicted copy of `path` next to it (a free name) and counts it. Returns the copy's path. */
	private async writeCopy(path: string, data: ArrayBuffer): Promise<string> {
		const taken = (p: string) => this.local.has(p) || this.state.paths.has(p);
		const copy = conflictCopyPath(path, new Date(this.p.now()), this.o.device, taken);
		const st = await this.p.local.write(copy, data, null);
		this.local.set(copy, { path: copy, ...st });
		this.result.counts.conflicts++;
		this.event("conflict", path, copy);
		return copy;
	}

	/**
	 * Uploads a conflicted copy and records it. Review W22 S8: a copy outside the scope (exact include rules) stays a local file
	 * only: never uploaded nor recorded, so no later run plans to delete it in the cloud.
	 */
	private async uploadCopy(copy: string, data: ArrayBuffer, hash: string): Promise<void> {
		if (!this.inScope(copy)) return;
		const st = this.local.get(copy);
		if (!st) return;
		try {
			const up = await this.remote(() => this.p.remote.upload(copy, data, null, this.p.signal));
			setRecord(this.state, copy, { r: metaOf(up), b: { lm: st.mtime, ls: st.size, lh: hash, rr: up.rev } });
		} catch (e) {
			if (e instanceof Stop) throw e;
			// The copy is a new local file: it goes up on a later run.
			console.error("[notebook] cloud sync: the conflicted copy could not be uploaded yet", copy, e);
		}
	}

	private async deleteRemote(path: string, remote: RemoteMeta): Promise<void> {
		// The file came back locally meanwhile: not deleted.
		if ((await this.p.local.stat(path)) !== null) throw new LocalChangedError(path);
		await this.remote(() => this.p.remote.remove(remote.id, remote.rev, this.p.signal));
		setRecord(this.state, path, { r: null, b: null });
		this.result.counts.delRemote++;
		this.event("del-remote", path);
	}

	private async deleteLocal(path: string, f: PathFacts): Promise<void> {
		if (!f.local) return;
		const expect = { size: f.local.size, mtime: f.local.mtime };
		if (!(await this.p.local.settle(path))) {
			this.skip(path, "unsaved");
			return;
		}
		if (!sameStat(await this.p.local.stat(path), expect)) throw new LocalChangedError(path);
		await this.p.local.trash(path, expect);
		this.local.delete(path);
		setRecord(this.state, path, { r: null, b: null });
		this.result.counts.delLocal++;
		this.event("del-local", path);
	}
}

function sizeOf(a: SyncAction): number {
	switch (a.kind) {
		case "upload": return a.size;
		case "download": return a.remote.size;
		case "conflict": return a.size;
		default: return 0;
	}
}

/** Runs one sync. Never throws: every failure is in the result. */
export async function runSync(ports: SyncPorts, options: SyncOptions): Promise<SyncResult> {
	return new Run(ports, options).run();
}
