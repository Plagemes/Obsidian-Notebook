/**
 * 0.22 (roadmap #126): what the cloud sync remembers on this device, per path. Pure: no `obsidian` import.
 *
 * Two facts per path:
 *  - `r`, the remote index: the file as the cloud last described it (id, revision, size, time). It follows every listing and
 *    every delta, whether or not the change was applied here, so a change that was skipped (a large file, an error) is still
 *    different from the base next time and is retried.
 *  - `b`, the base: what both sides held at the last sync of this path (local time, size and content hash; remote revision).
 *    A side "changed" when it differs from the base. Without a base nothing is ever deleted (first sync = union).
 *
 * The state is device-local (a file per device in the plugin's folder, never in the synced vault) and bound to one provider
 * and one remote root: another provider or root starts from an empty state. It is read leniently: anything unreadable gives an
 * empty or partial state flagged `trusted: false`, and an untrusted state never deletes anything (a deletion becomes a restore)
 * and lists the remote from scratch.
 */
import type { ProviderId } from "./provider-types";

export const STATE_VERSION = 1;
/** Most paths the state holds; a larger scope is refused with a clear message (narrow the scope). */
export const MAX_PATHS = 50_000;

export interface RemoteMeta {
	id: string;
	rev: string;
	size: number;
	mtime: number;
}

export interface BaseMeta {
	/** Local modification time at the last sync. */
	lm: number;
	/** Local size at the last sync. */
	ls: number;
	/** Content hash (hex) at the last sync. */
	lh: string;
	/** Remote revision at the last sync. */
	rr: string;
}

export interface PathRecord {
	r?: RemoteMeta;
	b?: BaseMeta;
}

export interface SyncState {
	provider: ProviderId;
	root: string | null;
	/** Delta cursor of the remote listing (null: list everything next time). */
	cursor: string | null;
	/** False until a run completed on this state; also false after damage. Deletions are only propagated when true. */
	trusted: boolean;
	/** Fingerprint of the scope the records were made under; another scope lists the remote again (see `scopeKey`). */
	scope: string | null;
	paths: Map<string, PathRecord>;
	/** Fields of a newer version, kept on rewrite. */
	extra?: Record<string, unknown>;
}

const KNOWN = new Set(["v", "provider", "root", "cursor", "trusted", "scope", "paths"]);

export function emptyState(provider: ProviderId, root: string | null): SyncState {
	return { provider, root, cursor: null, trusted: false, scope: null, paths: new Map() };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function readRemote(v: unknown): RemoteMeta | null {
	if (!Array.isArray(v) || v.length !== 4) return null;
	const [id, rev, size, mtime] = v as unknown[];
	return isStr(id) && id !== "" && isStr(rev) && isNum(size) && isNum(mtime) ? { id, rev, size, mtime } : null;
}

function readBase(v: unknown): BaseMeta | null {
	if (!Array.isArray(v) || v.length !== 4) return null;
	const [lm, ls, lh, rr] = v as unknown[];
	return isNum(lm) && isNum(ls) && isStr(lh) && /^[0-9a-f]{8,128}$/.test(lh) && isStr(rr) ? { lm, ls, lh, rr } : null;
}

export interface ReadState {
	state: SyncState;
	/** Something stored was unreadable or dropped (the state is untrusted: full listing, no deletions). */
	damaged: boolean;
}

/**
 * The stored state for `provider` / `root`. Missing: empty (a first sync). Another provider or root: empty. Unreadable, or any
 * entry dropped: what could be read, untrusted, without a cursor.
 */
export function readState(raw: unknown, provider: ProviderId, root: string | null): ReadState {
	if (raw === null || raw === undefined) return { state: emptyState(provider, root), damaged: false };
	if (typeof raw !== "object" || Array.isArray(raw)) return { state: emptyState(provider, root), damaged: true };
	const d = raw as Record<string, unknown>;
	if (d.v !== STATE_VERSION || typeof d.paths !== "object" || d.paths === null || Array.isArray(d.paths)) return { state: emptyState(provider, root), damaged: true };
	if (d.provider !== provider || (d.root ?? null) !== root) return { state: emptyState(provider, root), damaged: false };
	const state = emptyState(provider, root);
	const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !KNOWN.has(k)));
	if (Object.keys(extra).length > 0) state.extra = extra;
	let damaged = false;
	for (const [path, value] of Object.entries(d.paths as Record<string, unknown>)) {
		if (state.paths.size >= MAX_PATHS) {
			damaged = true;
			break;
		}
		if (!path || path.length > 1024 || typeof value !== "object" || value === null) {
			damaged = true;
			continue;
		}
		const v = value as Record<string, unknown>;
		const r = v.r === undefined ? undefined : readRemote(v.r);
		const b = v.b === undefined ? undefined : readBase(v.b);
		if (r === null || b === null || (r === undefined && b === undefined)) {
			damaged = true;
			continue;
		}
		const rec: PathRecord = {};
		if (r) rec.r = r;
		if (b) rec.b = b;
		state.paths.set(path, rec);
	}
	state.cursor = !damaged && isStr(d.cursor) && d.cursor !== "" ? d.cursor : null;
	state.trusted = !damaged && d.trusted === true;
	state.scope = isStr(d.scope) ? d.scope : null;
	return { state, damaged };
}

/** The state as stored (compact JSON-able object). */
export function writeState(state: SyncState): Record<string, unknown> {
	const paths: Record<string, unknown> = {};
	for (const [path, rec] of state.paths) {
		const out: Record<string, unknown> = {};
		if (rec.r) out.r = [rec.r.id, rec.r.rev, rec.r.size, rec.r.mtime];
		if (rec.b) out.b = [rec.b.lm, rec.b.ls, rec.b.lh, rec.b.rr];
		if (out.r || out.b) paths[path] = out;
	}
	return { ...(state.extra ?? {}), v: STATE_VERSION, provider: state.provider, root: state.root, cursor: state.cursor, trusted: state.trusted, scope: state.scope, paths };
}

/** Sets or clears one side of a path's record, dropping records that hold nothing. */
export function setRecord(state: SyncState, path: string, patch: { r?: RemoteMeta | null; b?: BaseMeta | null }): void {
	const rec: PathRecord = { ...(state.paths.get(path) ?? {}) };
	if (patch.r === null) delete rec.r;
	else if (patch.r) rec.r = patch.r;
	if (patch.b === null) delete rec.b;
	else if (patch.b) rec.b = patch.b;
	if (rec.r || rec.b) state.paths.set(path, rec);
	else state.paths.delete(path);
}
