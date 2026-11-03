/**
 * 0.14: what this device has already seen of each notebook, for the "Changed on another device" section. Pure: no 'obsidian'.
 *
 * Kept in this device's local storage (`app.saveLocalStorage`: per vault and per device, never synced, so every device has its
 * own record and a sync service has nothing to conflict on). The file's modification time is the one of the device that wrote
 * it (Google Drive and OneDrive keep it), so "changed elsewhere" is: the file's time is later than the time this device last
 * saw, and this device did not write that change itself (see dynamic-sections.ts).
 *
 * `baseline` is the moment the record was first made: notebooks that were already there are not "changed" just because this
 * device never opened them. Notebooks are keyed like the library state (document id, else path). Unreadable data gives a fresh
 * record (it only costs the section).
 */
export const SEEN_STATE_VERSION = 1;
/** A record keeps at most this many notebooks (the oldest are dropped; a notebook without a record falls back to the baseline). */
export const SEEN_CAP = 2000;

export interface SeenState {
	version: number;
	/** ms since epoch when the record was made. */
	baseline: number;
	/** Notebook key to the file time (ms) this device has seen. */
	seen: Record<string, number>;
}

export function freshSeenState(now: number): SeenState {
	return { version: SEEN_STATE_VERSION, baseline: now, seen: {} };
}

export function parseSeenState(raw: unknown, now: number): SeenState {
	try {
		const data = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
		if (typeof data !== "object" || data === null) return freshSeenState(now);
		const o = data as Record<string, unknown>;
		if (o.version !== SEEN_STATE_VERSION || typeof o.baseline !== "number" || !Number.isFinite(o.baseline)) return freshSeenState(now);
		const seen: Record<string, number> = {};
		if (typeof o.seen === "object" && o.seen !== null && !Array.isArray(o.seen)) {
			for (const [k, v] of Object.entries(o.seen as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) seen[k] = v;
		}
		return { version: SEEN_STATE_VERSION, baseline: o.baseline, seen };
	} catch {
		return freshSeenState(now);
	}
}

/** The time this device has seen of a notebook. */
export function seenAt(state: SeenState, key: string): number {
	return state.seen[key] ?? state.baseline;
}

/** Records that the device has seen the file as of `mtime`; false when nothing changed. */
export function markSeen(state: SeenState, key: string, mtime: number): boolean {
	const before = state.seen[key];
	if (before !== undefined && before >= mtime) return false;
	state.seen[key] = mtime;
	const keys = Object.keys(state.seen);
	if (keys.length > SEEN_CAP) {
		for (const k of keys.sort((a, b) => state.seen[a]! - state.seen[b]!).slice(0, keys.length - SEEN_CAP)) delete state.seen[k];
	}
	return true;
}

/** Marks a group of notebooks as seen; returns whether anything changed. */
export function markAllSeen(state: SeenState, items: ReadonlyArray<{ key: string; mtime: number }>): boolean {
	let changed = false;
	for (const i of items) if (markSeen(state, i.key, i.mtime)) changed = true;
	return changed;
}
