/**
 * 0.13: a small per-device log of writing activity, for Home's greeting and statistics: which pages were edited on
 * which day, and in which minutes of the day something was written. Pure: no 'obsidian', no DOM.
 *
 * It is the second log next to the recent pages log (recent-log.ts), which keeps only the LAST edit of each page and so
 * cannot say how many pages were written on each of the last days. Same rules: kept in the device-local storage of
 * Obsidian (never in a notebook or a synced file, no format change), written only on real edits, anything unreadable
 * gives an empty log (it only costs the statistics).
 */

/** Days kept (older days are dropped). */
export const ACTIVITY_DAYS = 90;
/** Pages remembered per day (a day with more keeps the first ones; the count stops growing, it never fails). */
export const ACTIVITY_PAGES_PER_DAY = 300;

/** One page edited on one day. `key` is the shortened (notebook id, page id) pair: it only has to tell pages apart. */
export interface ActivityRecord {
	/** Local day `YYYY-MM-DD`. */
	day: string;
	key: string;
	/** Last known path of the notebook (follows renames). */
	path: string;
}

interface DayData {
	/** key → path */
	pages: Map<string, string>;
	/** Minutes of the day (0–1439) in which something was written. */
	minutes: Set<number>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of a time, `YYYY-MM-DD`. */
export function dayKeyOf(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The short key of a page (the notebook's and the page's id, 8 characters each). */
export function pageKey(nb: string, page: string): string {
	return `${nb.slice(0, 8)}:${page.slice(0, 8)}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ActivityLog {
	private readonly byDay = new Map<string, DayData>();

	constructor(private readonly keepDays = ACTIVITY_DAYS) {}

	private day(day: string): DayData {
		let d = this.byDay.get(day);
		if (!d) {
			d = { pages: new Map(), minutes: new Set() };
			this.byDay.set(day, d);
		}
		return d;
	}

	private prune(): void {
		if (this.byDay.size <= this.keepDays) return;
		const days = [...this.byDay.keys()].sort();
		for (const d of days.slice(0, days.length - this.keepDays)) this.byDay.delete(d);
	}

	/**
	 * Records that a page was edited at `at`. `minute: false` records the page only (history that came from the recent
	 * pages log has no minute to give). Returns whether anything new was recorded.
	 */
	touch(nb: string, path: string, page: string, at: number, minute = true): boolean {
		if (!nb || !page || !Number.isFinite(at)) return false;
		const day = dayKeyOf(at);
		const d = this.day(day);
		const key = pageKey(nb, page);
		let changed = false;
		if (d.pages.get(key) !== path) {
			if (d.pages.has(key) || d.pages.size < ACTIVITY_PAGES_PER_DAY) {
				d.pages.set(key, path);
				changed = true;
			}
		}
		if (minute) {
			const date = new Date(at);
			const m = date.getHours() * 60 + date.getMinutes();
			if (!d.minutes.has(m)) {
				d.minutes.add(m);
				changed = true;
			}
		}
		if (changed) this.prune();
		return changed;
	}

	/** Every page-day, oldest day first. */
	records(): ActivityRecord[] {
		const out: ActivityRecord[] = [];
		for (const day of [...this.byDay.keys()].sort()) {
			for (const [key, path] of this.byDay.get(day)!.pages) out.push({ day, key, path });
		}
		return out;
	}

	/** Minutes in which something was written, per day (only days that have any). */
	minutesByDay(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [day, d] of this.byDay) if (d.minutes.size > 0) out[day] = d.minutes.size;
		return out;
	}

	rename(oldPath: string, newPath: string): boolean {
		let changed = false;
		for (const d of this.byDay.values()) {
			for (const [key, path] of d.pages) {
				if (path === oldPath || path.startsWith(`${oldPath}/`)) {
					d.pages.set(key, newPath + path.slice(oldPath.length));
					changed = true;
				}
			}
		}
		return changed;
	}

	/**
	 * A deleted notebook keeps its days in the statistics (the writing happened), but its path is cleared so that it counts
	 * under no subject. Returns whether anything changed.
	 */
	forgetPath(path: string): boolean {
		let changed = false;
		for (const d of this.byDay.values()) {
			for (const [key, p] of d.pages) {
				if (p === path || p.startsWith(`${path}/`)) {
					d.pages.set(key, "");
					changed = true;
				}
			}
		}
		return changed;
	}

	toJSON(): { version: 1; paths: string[]; days: Record<string, { p: Array<[number, string]>; m: number[] }> } {
		const paths: string[] = [];
		const index = new Map<string, number>();
		const idx = (p: string) => {
			let i = index.get(p);
			if (i === undefined) {
				i = paths.length;
				paths.push(p);
				index.set(p, i);
			}
			return i;
		};
		const days: Record<string, { p: Array<[number, string]>; m: number[] }> = {};
		for (const day of [...this.byDay.keys()].sort()) {
			const d = this.byDay.get(day)!;
			days[day] = { p: [...d.pages].map(([key, path]): [number, string] => [idx(path), key]), m: [...d.minutes].sort((a, b) => a - b) };
		}
		return { version: 1, paths, days };
	}

	/** Anything unreadable gives an empty log. */
	static parse(raw: unknown, keepDays = ACTIVITY_DAYS): ActivityLog {
		const log = new ActivityLog(keepDays);
		try {
			const data = (typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw) as { paths?: unknown; days?: unknown } | null;
			if (typeof data !== "object" || data === null || !Array.isArray(data.paths) || typeof data.days !== "object" || data.days === null) return log;
			const paths = data.paths.map((p) => (typeof p === "string" ? p : ""));
			for (const [day, v] of Object.entries(data.days as Record<string, unknown>)) {
				if (!DAY_RE.test(day) || typeof v !== "object" || v === null) continue;
				const o = v as { p?: unknown; m?: unknown };
				const d = log.day(day);
				if (Array.isArray(o.p)) {
					for (const item of o.p.slice(0, ACTIVITY_PAGES_PER_DAY)) {
						if (!Array.isArray(item) || typeof item[1] !== "string" || !Number.isInteger(item[0])) continue;
						d.pages.set(item[1], paths[item[0] as number] ?? "");
					}
				}
				if (Array.isArray(o.m)) for (const m of o.m) if (Number.isInteger(m) && (m as number) >= 0 && (m as number) < 1440) d.minutes.add(m as number);
			}
			log.prune();
		} catch {
			return new ActivityLog(keepDays);
		}
		return log;
	}
}
