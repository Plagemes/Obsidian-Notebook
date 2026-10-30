/**
 * Recently edited pages (roadmap 365): a small per-device log of (notebook id, page id, time), written only on real
 * edits. Never part of a notebook or of any synced file. Pure, no 'obsidian'.
 */
import type { Timers } from "../storage/session";

export const RECENT_CAP = 100;
/** Edits are collapsed: a page is logged this long after the last edit. */
export const RECENT_DEBOUNCE_MS = 3000;

export interface RecentItem {
	/** Notebook id (document id) and its last known path. */
	nb: string;
	path: string;
	/** Page id, and the 1-based page number when it was edited (a hint if the page moved). */
	page: string;
	num: number;
	/** ms since epoch of the last edit. */
	at: number;
}

function isItem(v: unknown): v is RecentItem {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.nb === "string" && typeof o.path === "string" && typeof o.page === "string" &&
		Number.isInteger(o.num) && (o.num as number) >= 1 && Number.isFinite(o.at);
}

export class RecentLog {
	private items: RecentItem[] = [];

	constructor(items: readonly RecentItem[] = [], private readonly cap = RECENT_CAP) {
		for (const i of items) if (isItem(i)) this.add(i);
	}

	/** Records an edit; the same (notebook, page) keeps one entry with the newest time. */
	add(item: RecentItem): void {
		this.items = this.items.filter((x) => !(x.nb === item.nb && x.page === item.page));
		this.items.push({ ...item });
		this.items.sort((a, b) => b.at - a.at);
		if (this.items.length > this.cap) this.items.length = this.cap;
	}

	/** Newest first. */
	list(): RecentItem[] {
		return this.items.map((i) => ({ ...i }));
	}

	rename(oldPath: string, newPath: string): boolean {
		let changed = false;
		for (const i of this.items) {
			if (i.path === oldPath || i.path.startsWith(`${oldPath}/`)) {
				i.path = newPath + i.path.slice(oldPath.length);
				changed = true;
			}
		}
		return changed;
	}

	removePath(path: string): boolean {
		const n = this.items.length;
		this.items = this.items.filter((i) => i.path !== path && !i.path.startsWith(`${path}/`));
		return this.items.length !== n;
	}

	toJSON(): { version: 1; items: RecentItem[] } {
		return { version: 1, items: this.list() };
	}

	/** Anything unreadable gives an empty log (it only costs the list). */
	static parse(raw: unknown, cap = RECENT_CAP): RecentLog {
		try {
			const data = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
			const items = (data as { items?: unknown } | null)?.items;
			return new RecentLog(Array.isArray(items) ? (items as RecentItem[]) : [], cap);
		} catch {
			return new RecentLog([], cap);
		}
	}
}

/** Collapses edits: `touch` on every change, the log is written once the writing pauses. */
export class RecentRecorder {
	private pending = new Map<string, RecentItem>();
	private timer: number | null = null;

	constructor(
		private readonly log: RecentLog,
		private readonly timers: Timers,
		private readonly persist: () => void,
		private readonly now: () => number = Date.now,
		private readonly delayMs = RECENT_DEBOUNCE_MS,
	) {}

	touch(nb: string, path: string, page: string, num: number): void {
		if (!nb || !page || !(num >= 1)) return;
		this.pending.set(`${nb}\u0000${page}`, { nb, path, page, num, at: this.now() });
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = this.timers.set(() => this.flush(), this.delayMs);
	}

	flush(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		if (this.pending.size === 0) return;
		for (const item of this.pending.values()) this.log.add(item);
		this.pending.clear();
		this.persist();
	}
}

/** Relative time as a value and unit for `Intl.RelativeTimeFormat` (negative = in the past). */
export function ago(now: number, at: number): { value: number; unit: "minute" | "hour" | "day" } {
	const min = Math.max(0, Math.round((now - at) / 60_000));
	if (min < 60) return { value: -min, unit: "minute" };
	if (min < 60 * 24) return { value: -Math.round(min / 60), unit: "hour" };
	return { value: -Math.round(min / (60 * 24)), unit: "day" };
}
