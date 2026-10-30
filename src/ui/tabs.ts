// wave 0.10 (363): tabs of the open notebooks. Pure logic (no 'obsidian', no DOM): which tab is next, how tabs are
// named, and the two-finger sideways swipe on the toolbar strip. The DOM and the workspace calls are in view/notebook-tabs.ts.

/** An open notebook view, as the strip lists it. */
export interface TabEntry {
	/** Stable key of the leaf (the view assigns one per leaf). */
	id: string;
	/** Vault path of the notebook file. */
	path: string;
	/** Name shown by Obsidian for the tab. */
	title: string;
}

/** The index of the tab `step` places from `active` (1: next, -1: previous), or -1 when there is none. `wrap`: go round. */
export function neighbourTab(count: number, active: number, step: 1 | -1, wrap: boolean): number {
	if (!(count > 1) || active < 0 || active >= count) return -1;
	const to = active + step;
	if (to >= 0 && to < count) return to;
	return wrap ? (to + count) % count : -1;
}

/** Labels for the strip: the title, plus the folder when two notebooks have the same title. */
export function tabLabels(entries: readonly TabEntry[]): string[] {
	const seen = new Map<string, number>();
	for (const e of entries) seen.set(e.title, (seen.get(e.title) ?? 0) + 1);
	return entries.map((e) => {
		if ((seen.get(e.title) ?? 0) < 2) return e.title;
		const parts = e.path.split("/");
		const folder = parts.length > 1 ? parts[parts.length - 2] : "";
		return folder ? `${e.title} (${folder})` : e.title;
	});
}

/** A two-finger swipe has to travel this far sideways (CSS px) ... */
export const TAB_SWIPE_DISTANCE = 56;
/** ... mostly sideways (|dx| at least this times |dy|) ... */
export const TAB_SWIPE_RATIO = 2;
/** ... within this time (ms), with both fingers going the same way. */
export const TAB_SWIPE_MAX_MS = 900;

interface Finger {
	x0: number;
	y0: number;
	x: number;
	y: number;
}

/**
 * Recognises a horizontal two-finger swipe from pointer events of touch contacts. A third finger, a pen or a single
 * finger never counts. Fires once per gesture, as soon as the distance is reached (the strip is not a page: no drag
 * feedback is needed). `move` returns the direction (1: towards the next tab, i.e. the fingers moved left; -1: previous)
 * or 0.
 */
export class TabSwipe {
	private readonly fingers = new Map<number, Finger>();
	private t0 = 0;
	private started = false;
	private dead = false;
	private fired = false;

	down(id: number, x: number, y: number, t: number): void {
		if (this.fingers.size === 0) {
			this.t0 = t;
			this.started = false;
			this.dead = false;
			this.fired = false;
		}
		this.fingers.set(id, { x0: x, y0: y, x, y });
		if (this.fingers.size === 2) this.started = true;
		else if (this.fingers.size > 2) this.dead = true;
	}

	move(id: number, x: number, y: number, t: number): -1 | 0 | 1 {
		const f = this.fingers.get(id);
		if (!f) return 0;
		f.x = x;
		f.y = y;
		if (!this.started || this.dead || this.fired || this.fingers.size !== 2) return 0;
		if (t - this.t0 > TAB_SWIPE_MAX_MS) {
			this.dead = true;
			return 0;
		}
		const [a, b] = [...this.fingers.values()] as [Finger, Finger];
		const da = a.x - a.x0, db = b.x - b.x0;
		const dy = Math.max(Math.abs(a.y - a.y0), Math.abs(b.y - b.y0));
		if (Math.sign(da) !== Math.sign(db) && Math.min(Math.abs(da), Math.abs(db)) > 12) {
			this.dead = true; // a pinch or a rotation, not a swipe
			return 0;
		}
		const dx = Math.abs(da) < Math.abs(db) ? da : db; // the slower finger decides
		if (Math.abs(dx) < TAB_SWIPE_DISTANCE || Math.abs(dx) < TAB_SWIPE_RATIO * dy) return 0;
		this.fired = true;
		return dx < 0 ? 1 : -1;
	}

	up(id: number): void {
		this.fingers.delete(id);
		if (this.fingers.size === 0) this.reset();
	}

	reset(): void {
		this.fingers.clear();
		this.started = this.dead = this.fired = false;
	}
}
