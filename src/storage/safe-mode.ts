/**
 * Safe mode for opening a notebook (roadmap M17 #346). No Obsidian imports, so it is testable in Node.
 *
 * A per-device "opening" marker is written for a notebook path right before its file is loaded and cleared once the
 * view has painted it and stayed alive for a moment (`SETTLE_MS`). If the app crashed or froze (and was killed) while
 * opening, the marker is still there at the next open: that open is a failure of the previous one, and it uses safe
 * mode. The markers live in the device's local storage (`app.saveLocalStorage`: per vault and per device, never
 * synced), so a crash on the phone never puts the tablet in safe mode.
 *
 * Safe mode (applied by the view): no low-latency ink, no page thumbnails, no companion note, no PDF text prefetch,
 * and progressive rendering (the ink first, PDF and image backgrounds only after the first paint; skipped entirely if
 * the previous safe open died while loading them). A notebook stays in safe mode until "Open normally" is chosen; a
 * normal open that settles resets the count. Two consecutive failures suggest a repair.
 *
 * Closing the view, or the app going to the background, before the open settled is not a failure (`abandoned`).
 */

/** How long after the first paint an open counts as successful. */
export const SETTLE_MS = 1000;
/** Entries kept at most (the oldest go first). */
export const MAX_ENTRIES = 200;
const STORE_VERSION = 1;

/** The device-local key-value slot the tracker keeps its state in. */
export interface LocalSlot {
	load(): unknown;
	save(data: unknown): void;
}

export type OpenStage = "load" | "media";

interface Entry {
	/** The open in progress (or the one that never finished). */
	pending: { at: number; safe: boolean; stage: OpenStage } | null;
	/** Consecutive opens that did not finish. */
	failures: number;
	/** The last unfinished safe open died while loading PDF and image backgrounds. */
	mediaFailed: boolean;
	/** "Open normally" was chosen: the next open is a normal one (once). */
	forceNormal: boolean;
	updatedAt: number;
}

export interface OpenDecision {
	/** Open in safe mode. */
	safe: boolean;
	/** Consecutive opens of this notebook that did not finish, including the last one. */
	failures: number;
	/** Two or more consecutive failures: offer a repair prominently. */
	suggestRepair: boolean;
	/** Safe mode without PDF and image backgrounds (they were being loaded when the last safe open died). */
	skipMedia: boolean;
	/** A normal open the user asked for although the last one failed. */
	forcedNormal: boolean;
}

function isEntry(v: unknown): v is Entry {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	const p = e.pending as Record<string, unknown> | null | undefined;
	const pendingOk = p === null || (typeof p === "object" && typeof p.at === "number" && typeof p.safe === "boolean" && (p.stage === "load" || p.stage === "media"));
	return pendingOk && typeof e.failures === "number" && Number.isFinite(e.failures) && typeof e.mediaFailed === "boolean"
		&& typeof e.forceNormal === "boolean" && typeof e.updatedAt === "number";
}

/** Reads the stored state; anything unreadable is dropped (worst case: one open that should have been safe is not). */
function readEntries(raw: unknown): Map<string, Entry> {
	const out = new Map<string, Entry>();
	if (typeof raw !== "object" || raw === null) return out;
	const o = raw as { v?: unknown; files?: unknown };
	if (o.v !== STORE_VERSION || typeof o.files !== "object" || o.files === null) return out;
	for (const [path, e] of Object.entries(o.files as Record<string, unknown>)) if (isEntry(e)) out.set(path, { ...e });
	return out;
}

/** Opening markers of all notebooks on this device. Every change is saved at once (local storage is synchronous). */
export class SafeModeTracker {
	private readonly entries: Map<string, Entry>;

	constructor(
		private readonly slot: LocalSlot,
		private readonly now: () => number = () => Date.now(),
	) {
		let raw: unknown = null;
		try {
			raw = slot.load();
		} catch (e) {
			console.error("[notebook] could not read the safe mode markers", e);
		}
		this.entries = readEntries(raw);
	}

	/** Call right before the notebook file is read. Decides normal or safe mode and sets the marker. */
	begin(path: string): OpenDecision {
		const e = this.entries.get(path) ?? { pending: null, failures: 0, mediaFailed: false, forceNormal: false, updatedAt: 0 };
		if (e.pending) {
			// The previous open never finished: the app crashed, froze or was killed while opening.
			e.failures = Math.min(99, e.failures + 1);
			e.mediaFailed = e.pending.safe && e.pending.stage === "media";
		}
		const forcedNormal = e.forceNormal && e.failures > 0;
		e.forceNormal = false;
		const safe = e.failures > 0 && !forcedNormal;
		e.pending = { at: this.now(), safe, stage: "load" };
		this.put(path, e);
		return { safe, failures: e.failures, suggestRepair: e.failures >= 2, skipMedia: safe && e.mediaFailed, forcedNormal };
	}

	/** Safe mode is about to load PDF and image backgrounds (progressive rendering). */
	stage(path: string, stage: OpenStage): void {
		const e = this.entries.get(path);
		if (!e?.pending) return;
		e.pending.stage = stage;
		this.put(path, e);
	}

	/** The open settled: painted and alive for SETTLE_MS. */
	succeeded(path: string): void {
		const e = this.entries.get(path);
		if (!e?.pending) return;
		const { safe, stage } = e.pending;
		e.pending = null;
		if (!safe) {
			// A normal open worked: the notebook is fine on this device.
			this.entries.delete(path);
			this.save();
			return;
		}
		// Safe opens keep the count: the notebook stays in safe mode until "Open normally" is chosen.
		if (stage === "media") e.mediaFailed = false;
		this.put(path, e);
	}

	/** The view closed (or the app went to the background) before the open settled: not a failure. */
	abandoned(path: string): void {
		const e = this.entries.get(path);
		if (!e?.pending) return;
		e.pending = null;
		if (e.failures > 0 || e.forceNormal) return this.put(path, e);
		this.entries.delete(path);
		this.save();
	}

	/** "Open normally": the next open of `path` is a normal one even though the last one failed. */
	requestNormal(path: string): void {
		const e = this.entries.get(path);
		if (!e) return;
		e.forceNormal = true;
		this.put(path, e);
	}

	/** Consecutive failures recorded for `path` (0 when it opened fine last time). */
	failures(path: string): number {
		return this.entries.get(path)?.failures ?? 0;
	}

	rename(oldPath: string, newPath: string): void {
		const e = this.entries.get(oldPath);
		if (!e) return;
		this.entries.delete(oldPath);
		this.put(newPath, e);
	}

	forget(path: string): void {
		if (this.entries.delete(path)) this.save();
	}

	private put(path: string, e: Entry): void {
		e.updatedAt = this.now();
		this.entries.delete(path);
		this.entries.set(path, e);
		while (this.entries.size > MAX_ENTRIES) {
			let oldest: string | null = null;
			let at = Infinity;
			for (const [p, v] of this.entries) if (v.updatedAt < at) [oldest, at] = [p, v.updatedAt];
			if (oldest === null) break;
			this.entries.delete(oldest);
		}
		this.save();
	}

	private save(): void {
		try {
			this.slot.save({ v: STORE_VERSION, files: Object.fromEntries(this.entries) });
		} catch (e) {
			console.error("[notebook] could not store the safe mode markers", e);
		}
	}
}

// Notebooks currently shown in safe mode in this app, so services outside the view (companion notes) can stay away.
const openInSafeMode = new Map<string, number>();

export function markSafeOpen(path: string): void {
	openInSafeMode.set(path, (openInSafeMode.get(path) ?? 0) + 1);
}

export function unmarkSafeOpen(path: string): void {
	const n = (openInSafeMode.get(path) ?? 0) - 1;
	if (n > 0) openInSafeMode.set(path, n);
	else openInSafeMode.delete(path);
}

/** True while a view shows `path` in safe mode. */
export function isOpenInSafeMode(path: string): boolean {
	return openInSafeMode.has(path);
}
