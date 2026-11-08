/**
 * 0.22 (roadmap #126): what the settings show about the cloud sync on this device: the last run and an activity log of the last
 * 50 entries. Kept in Obsidian's per-device local storage (bounded; corrupt data reads as empty), never in the vault. Pure helpers.
 */
import type { SyncCounts, SyncEventKind, SyncOutcome } from "./engine";

export const SYNC_MEMORY_KEY = "notebook-cloud-sync-memory";
export const MAX_LOG = 50;

export type LogKind = SyncEventKind | "run" | "info";

export interface LogEntry {
	at: number;
	kind: LogKind;
	/** A vault path, or for "run"/"info" a short message key's argument. */
	path: string;
	detail?: string;
}

export interface LastRun {
	at: number;
	outcome: SyncOutcome;
	counts: SyncCounts;
	error?: string;
}

export interface SyncMemory {
	last: LastRun | null;
	/** Newest first. */
	log: LogEntry[];
}

const KINDS = new Set<LogKind>(["up", "down", "del-local", "del-remote", "conflict", "same", "skip", "error", "run", "info"]);
const OUTCOMES = new Set<SyncOutcome>(["ok", "partial", "confirm", "auth", "offline", "too-many", "cancelled", "failed"]);
const COUNT_KEYS = ["up", "down", "delLocal", "delRemote", "conflicts", "skipped", "errors"] as const;

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function readCounts(v: unknown): SyncCounts | null {
	if (typeof v !== "object" || v === null) return null;
	const d = v as Record<string, unknown>;
	const out = {} as SyncCounts;
	for (const k of COUNT_KEYS) {
		if (!num(d[k])) return null;
		out[k] = d[k] as number;
	}
	return out;
}

export function normaliseSyncMemory(raw: unknown): SyncMemory {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { last: null, log: [] };
	const d = raw as Record<string, unknown>;
	let last: LastRun | null = null;
	if (typeof d.last === "object" && d.last !== null) {
		const l = d.last as Record<string, unknown>;
		const counts = readCounts(l.counts);
		if (num(l.at) && OUTCOMES.has(l.outcome as SyncOutcome) && counts) {
			last = { at: l.at as number, outcome: l.outcome as SyncOutcome, counts };
			if (typeof l.error === "string") last.error = l.error.slice(0, 300);
		}
	}
	const log: LogEntry[] = [];
	if (Array.isArray(d.log)) {
		for (const e of d.log as unknown[]) {
			if (log.length >= MAX_LOG) break;
			if (typeof e !== "object" || e === null) continue;
			const x = e as Record<string, unknown>;
			if (!num(x.at) || !KINDS.has(x.kind as LogKind) || typeof x.path !== "string") continue;
			const entry: LogEntry = { at: x.at as number, kind: x.kind as LogKind, path: x.path.slice(0, 400) };
			if (typeof x.detail === "string") entry.detail = x.detail.slice(0, 400);
			log.push(entry);
		}
	}
	return { last, log };
}

/** The memory after a run: the result as the last run, its events (newest first) and a "run" line in front of the log. */
export function rememberRun(memory: SyncMemory, last: LastRun, events: readonly { kind: SyncEventKind; path: string; detail?: string }[]): SyncMemory {
	const fresh: LogEntry[] = [{ at: last.at, kind: "run", path: last.outcome, ...(last.error ? { detail: last.error.slice(0, 400) } : {}) }];
	for (const e of [...events].reverse()) fresh.push({ at: last.at, kind: e.kind, path: e.path, ...(e.detail ? { detail: e.detail } : {}) });
	return { last, log: [...fresh, ...memory.log].slice(0, MAX_LOG) };
}

/** The memory with one informative line in front (sign-in, disconnect...). */
export function rememberInfo(memory: SyncMemory, at: number, what: string): SyncMemory {
	return { last: memory.last, log: [{ at, kind: "info" as const, path: what }, ...memory.log].slice(0, MAX_LOG) };
}
