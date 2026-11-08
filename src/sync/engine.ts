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
 */
import { conflictCopyPath } from "./conflict-name";
import { plan, type DeletionPolicy, type LargeRule, type PathFacts, type SyncAction } from "./planner";
import { AuthRequiredError, RemoteConflictError, TransientRemoteError, type CloudProvider, type RemoteChanges, type RemoteEntry } from "./provider-types";
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
	error?: string;
	retryAfterMs?: number;
}

export const MAX_EVENTS = 200;
const MAX_ROUNDS = 3;
const SAVE_EVERY = 25;

/** A stable text for the scope (a change lists the remote again and drops records now out of scope). */
export function scopeKey(scope: ScopeRules, fixed: FixedExclusions): string {
	return JSON.stringify([scope.mode, scope.folders, scope.include, scope.exclude, scope.types, fixed.configDir, fixed.backupFolder]);
}

/** A path from the provider as a vault path ("/"-separated, no leading slash), or null when unusable. */
export function remotePath(path: string): string | null {
	const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!p || p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
	return p;
}

const metaOf = (e: RemoteEntry): RemoteMeta => ({ id: e.id, rev: e.rev, size: e.size, mtime: e.mtime });

/**
 * Applies a listing to the remote index of `state` (only paths in scope are kept). Returns the paths listed twice with different
 * ids (two cloud files with one name, possible on Google Drive): they are skipped this run.
 */
export function applyChanges(state: SyncState, changes: RemoteChanges, keep: (path: string) => boolean): Set<string> {
	const duplicates = new Set<string>();
	if (changes.full) {
		for (const [path, rec] of [...state.paths]) if (rec.r) setRecord(state, path, { r: null });
	} else {
		for (const raw of changes.deletions) {
			const p = remotePath(raw);
			if (p) setRecord(state, p, { r: null });
		}
	}
	const seen = new Map<string, string>();
	for (const e of changes.upserts) {
		const p = remotePath(e.path);
		if (!p || !keep(p)) continue;
		const other = seen.get(p);
		if (other !== undefined && other !== e.id) duplicates.add(p);
		seen.set(p, e.id);
		setRecord(state, p, { r: metaOf(e) });
	}
	state.cursor = changes.cursor || null;
	return duplicates;
}

const isErr = (e: unknown, name: string): boolean => e instanceof Error && e.name === name;
const isAuth = (e: unknown) => e instanceof AuthRequiredError || isErr(e, "AuthRequiredError");
const isTransient = (e: unknown): e is TransientRemoteError => e instanceof TransientRemoteError || isErr(e, "TransientRemoteError");
const isRemoteConflict = (e: unknown) => e instanceof RemoteConflictError || isErr(e, "RemoteConflictError");
const isLocalChanged = (e: unknown) => e instanceof LocalChangedError || isErr(e, "LocalChangedError");
const isAbort = (e: unknown) => isErr(e, "AbortError");
const sameStat = (a: LocalStat | null, b: LocalStat | null) => (a === null || b === null ? a === b : a.size === b.size && a.mtime === b.mtime);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
	private sinceSave = 0;
	private local = new Map<string, LocalFile>();

	constructor(private readonly p: SyncPorts, private readonly o: SyncOptions) {
		this.attempts = Math.max(1, o.attempts ?? 3);
		this.result = {
			outcome: "ok", first: false, damaged: false, events: [], heldDeletes: [], askLarge: [], skippedLarge: [],
			counts: { up: 0, down: 0, delLocal: 0, delRemote: 0, conflicts: 0, skipped: 0, errors: 0 },
		};
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

	private async save(force = false): Promise<void> {
		if (!force && ++this.sinceSave < SAVE_EVERY) return;
		this.sinceSave = 0;
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
		const duplicates = applyChanges(this.state, changes, this.inScope);
		this.local = new Map(this.p.local.list().filter((f) => this.inScope(f.path)).map((f) => [f.path, f]));
		const paths = new Set<string>(this.local.keys());
		for (const [path, rec] of this.state.paths) if (rec.r || rec.b) paths.add(path);
		if (paths.size > MAX_PATHS) {
			this.result.outcome = "too-many";
			this.result.error = String(paths.size);
			return;
		}
		// Names that differ only by case are one file on some systems: never guessed, skipped with a note.
		const byLower = new Map<string, number>();
		for (const p of paths) byLower.set(p.toLowerCase(), (byLower.get(p.toLowerCase()) ?? 0) + 1);
		const facts: PathFacts[] = [];
		for (const path of [...paths].sort()) {
			this.checkAbort();
			if (duplicates.has(path)) {
				if (first) this.skip(path, "duplicate");
				continue;
			}
			if ((byLower.get(path.toLowerCase()) ?? 0) > 1) {
				if (first) this.skip(path, "case");
				continue;
			}
			facts.push(await this.factsOf(path));
		}
		const planned = plan(facts, {
			trusted: this.state.trusted, deletions: this.o.deletions, largeBytes: this.o.largeBytes, large: this.o.large, approvedLarge: this.o.approvedLarge,
			declinedLarge: this.o.declinedLarge, allowedDeletes: this.o.allowedDeletes,
		});
		if (first) {
			this.result.heldDeletes = planned.heldDeletes.map((a) => ({ path: a.path, side: a.kind === "delete-local" ? "local" : "remote" }));
			this.result.askLarge = planned.askLarge.map((a) => ({ path: a.path, size: sizeOf(a) }));
			this.result.skippedLarge = planned.skippedLarge.map((a) => ({ path: a.path, size: sizeOf(a) }));
			for (const a of planned.skippedLarge) this.skip(a.path, "large");
			if (planned.heldDeletes.length > 0 || planned.askLarge.length > 0) this.result.outcome = "confirm";
		}
		const total = planned.actions.length;
		let done = 0;
		const byPath = new Map(facts.map((f) => [f.path, f]));
		for (const a of planned.actions) {
			this.checkAbort();
			try {
				await this.act(a, byPath.get(a.path)!);
			} catch (e) {
				if (e instanceof Stop) throw e;
				if (isRemoteConflict(e)) this.replan = true;
				else if (isLocalChanged(e)) this.skip(a.path, "changed");
				else {
					this.result.counts.errors++;
					this.event("error", a.path, message(e));
					console.error(`[notebook] cloud sync: ${a.kind} ${a.path} failed`, e);
				}
			}
			this.p.progress?.(++done, total);
			await this.save();
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
		const entry = await this.remote(() => this.p.remote.upload(path, got.data, ifRev, this.p.signal));
		const meta = metaOf(entry);
		setRecord(this.state, path, { r: meta, b: { lm: got.stat.mtime, ls: got.stat.size, lh: got.hash, rr: meta.rev } });
		this.result.counts.up++;
		this.event("up", path);
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
		const taken = (p: string) => this.local.has(p) || this.state.paths.has(p);
		const copy = conflictCopyPath(path, new Date(this.p.now()), this.o.device, taken);
		const st = await this.p.local.write(copy, data, null);
		this.local.set(copy, { path: copy, ...st });
		this.result.counts.conflicts++;
		this.event("conflict", path, copy);
		// The cloud's version is accounted for: the base is that version, so the local file reads as changed and goes up (now, or on
		// the next run when it could not be read now).
		const theirs: BaseMeta = { lm: 0, ls: data.byteLength, lh: hash, rr: remote.rev };
		setRecord(this.state, path, { r: remote, b: theirs });
		try {
			const up = await this.remote(() => this.p.remote.upload(copy, data, null, this.p.signal));
			setRecord(this.state, copy, { r: metaOf(up), b: { lm: st.mtime, ls: st.size, lh: hash, rr: up.rev } });
		} catch (e) {
			if (e instanceof Stop) throw e;
			// The copy is a new local file: it goes up on a later run.
			console.error("[notebook] cloud sync: the conflicted copy could not be uploaded yet", copy, e);
		}
		if (!local) return;
		const up = await this.remote(() => this.p.remote.upload(path, local.data, remote.rev, this.p.signal));
		const meta = metaOf(up);
		setRecord(this.state, path, { r: meta, b: { lm: local.stat.mtime, ls: local.stat.size, lh: local.hash, rr: meta.rev } });
		this.result.counts.up++;
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
