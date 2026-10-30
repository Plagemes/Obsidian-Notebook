/**
 * Write failures of a notebook file (roadmap M17 #347: storage full). No Obsidian imports, so it is testable in Node.
 *
 * What it does for DocumentSession:
 * - `classifyWriteError` tells a full device ("no-space") from a read-only or permission problem and from other errors,
 *   so the view can show a clear, persistent warning instead of a generic "save failed";
 * - `WriteHealth` counts consecutive failures and gives the retry delay (exponential backoff, capped), and says when the
 *   next write must first be preceded by a space probe;
 * - `assessAfterFailure` decides, from the file read back after a failed write, whether the write did not happen
 *   (`unchanged`), happened after all (`written`), or left a partial file (`torn`): a torn file is repaired by writing
 *   the previous content back, never kept silently.
 *
 * The in-memory document is never dropped by any of this: the session stays dirty until a write is verified.
 */

export type WriteFailureKind =
	/** The device (or the storage behind the vault) has no free space left. */
	| "no-space"
	/** The file system or the file is read-only. */
	| "read-only"
	/** The app may not write there (permission denied). */
	| "permission"
	/** The write returned but the file does not hold what was written (partial or mangled write). */
	| "torn"
	| "other";

/** The file read back after a write does not hold what was written. */
export class TornWriteError extends Error {
	constructor(message = "the file on disk does not hold what was written") {
		super(message);
		this.name = "TornWriteError";
	}
}

const NO_SPACE_RE = /ENOSPC|no space|not enough (free )?(space|storage)|insufficient (storage|space)|disk (is )?full|storage (is )?full|device (is )?full|out of (disk )?space|quota|SQLITE_FULL|EDQUOT|file too large|EFBIG/i;
const READ_ONLY_RE = /EROFS|read-only file system|read only file system|file is read-only|readonly/i;
const PERMISSION_RE = /EACCES|EPERM|permission denied|operation not permitted|access (is )?denied|not allowed/i;

/** Text of an error, including Node's `code` and a DOMException's `name` (QuotaExceededError). */
function errorText(e: unknown): string {
	if (e === null || e === undefined) return "";
	if (typeof e === "string") return e;
	if (typeof e !== "object") return String(e as number | boolean);
	const o = e as { message?: unknown; code?: unknown; name?: unknown };
	return [o.name, o.code, o.message].filter((v) => typeof v === "string" || typeof v === "number").join(" ");
}

/** What kind of write failure `e` is. Unknown errors are "other": never guessed to be a full disk. */
export function classifyWriteError(e: unknown): WriteFailureKind {
	if (e instanceof TornWriteError) return "torn";
	const text = errorText(e);
	if (NO_SPACE_RE.test(text)) return "no-space";
	if (READ_ONLY_RE.test(text)) return "read-only";
	if (PERMISSION_RE.test(text)) return "permission";
	return "other";
}

/** Retry delay after `failures` consecutive failures (1 = the first): base, 2×base, 4×base, ... capped at `maxMs`. */
export function backoffDelay(failures: number, baseMs: number, maxMs: number): number {
	const n = Math.max(1, Math.floor(failures));
	const base = Math.max(1, baseMs);
	// 2^30 is far above any cap; avoids Infinity for absurd counts.
	return Math.min(Math.max(base, maxMs), base * 2 ** Math.min(n - 1, 30));
}

/** Free space needed before a write is tried again after a "no-space" or torn failure: the growth plus a margin. */
export const PROBE_MARGIN_CHARS = 64 * 1024;

/** Characters a space probe writes before replacing `current` (on disk) with `next`. */
export function probeSize(current: string, next: string): number {
	return Math.max(0, next.length - current.length) + PROBE_MARGIN_CHARS;
}

/**
 * Checks that the storage has room for `chars` more characters by writing that much to a scratch file outside the vault
 * (the plugin's folder), reading it back and deleting it. Throws if any step fails. Implemented in vault-io.ts.
 */
export interface SpaceProbe {
	probe(chars: number): Promise<void>;
}

/** Outcome of a failed write, from the file read back afterwards. */
export type AfterFailure = "unchanged" | "written" | "torn";

/** `before`: the file before the write; `attempted`: what was written; `after`: the file read back. */
export function assessAfterFailure(before: string, attempted: string, after: string): AfterFailure {
	if (after === attempted) return "written";
	if (after === before) return "unchanged";
	return "torn";
}

/** Snapshot of the write health, for the view's warning. */
export interface WriteHealthState {
	/** At least one write in a row failed and no write has succeeded since. */
	failing: boolean;
	kind: WriteFailureKind | null;
	/** Consecutive failures. */
	failures: number;
	/** When the first failure of this streak happened (ms since epoch), or null. */
	since: number | null;
	/** When the next automatic attempt is due (ms since epoch), or null. */
	nextRetryAt: number | null;
	lastError: string | null;
	/** A partial write of ours could not be undone: the file on disk is damaged until the next successful save. */
	diskDamaged: boolean;
}

/** Consecutive write failures of one session. */
export class WriteHealth {
	private failures = 0;
	private kind: WriteFailureKind | null = null;
	private since: number | null = null;
	private nextRetryAt: number | null = null;
	private lastError: string | null = null;
	private damaged = false;

	constructor(
		private readonly baseMs: number,
		private readonly maxMs: number,
	) {}

	get failing(): boolean {
		return this.failures > 0;
	}

	/** The next write must first check that there is room (a full disk, or a partial write, was seen). */
	get needsProbe(): boolean {
		return this.failing && (this.kind === "no-space" || this.kind === "torn" || this.damaged);
	}

	get diskDamaged(): boolean {
		return this.damaged;
	}

	set diskDamaged(v: boolean) {
		this.damaged = v;
	}

	/** Timed (not explicit) saves wait until this time while failing. */
	retryDue(nowMs: number): boolean {
		return this.nextRetryAt === null || nowMs >= this.nextRetryAt;
	}

	/** Records a failure. Returns the delay before the next automatic attempt and whether this changed the warning. */
	recordFailure(e: unknown, nowMs: number): { delayMs: number; changed: boolean } {
		const raw = classifyWriteError(e);
		// An unspecific error during a streak keeps the known cause (usually a full disk).
		const kind = raw === "other" && this.kind !== null ? this.kind : raw;
		const changed = this.failures === 0 || kind !== this.kind;
		this.failures++;
		this.kind = kind;
		this.since ??= nowMs;
		this.lastError = e instanceof Error ? e.message : errorText(e) || "unknown error";
		const delayMs = backoffDelay(this.failures, this.baseMs, this.maxMs);
		this.nextRetryAt = nowMs + delayMs;
		return { delayMs, changed };
	}

	/** A write succeeded (and was verified). Returns true when this ends a streak of failures. */
	recordSuccess(): boolean {
		const was = this.failures > 0 || this.damaged;
		this.failures = 0;
		this.kind = null;
		this.since = null;
		this.nextRetryAt = null;
		this.lastError = null;
		this.damaged = false;
		return was;
	}

	state(): WriteHealthState {
		return {
			failing: this.failing,
			kind: this.kind,
			failures: this.failures,
			since: this.since,
			nextRetryAt: this.nextRetryAt,
			lastError: this.lastError,
			diskDamaged: this.damaged,
		};
	}
}
