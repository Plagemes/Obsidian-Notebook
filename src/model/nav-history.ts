/**
 * Back/forward history of visited pages (roadmap 18). Pure logic, no 'obsidian': the stack lives for one session, in
 * memory only (nothing is stored in a notebook or in the settings), and spans notebooks.
 *
 * Only deliberate jumps are recorded (a link, the page panel, "Go to page number", a search result, the fast scrollbar,
 * opening another notebook), never plain scrolling or turning pages one by one. Leaving a place records the place the
 * reader actually left, so Back returns to where they were and not to where they had jumped to.
 */

/** A page of a notebook. The id survives reordering; the number is only the fallback. */
export interface NavPlace {
	/** Vault path of the notebook. */
	path: string;
	/** Id of the page. */
	pageId: string;
	/** 1-based number of the page when it was visited. */
	page: number;
}

/** At most this many places are kept; the oldest are dropped. */
export const NAV_HISTORY_CAP = 50;

export function samePlace(a: NavPlace, b: NavPlace): boolean {
	return a.path === b.path && a.pageId === b.pageId;
}

export class NavHistory {
	private entries: NavPlace[] = [];
	/** The entry the reader is on (-1: empty). Entries after it are the forward stack. */
	private at = -1;

	constructor(readonly cap: number = NAV_HISTORY_CAP) {}

	get length(): number {
		return this.entries.length;
	}

	get canBack(): boolean {
		return this.at > 0;
	}

	get canForward(): boolean {
		return this.at >= 0 && this.at < this.entries.length - 1;
	}

	/** The places in order, oldest first, and the position of the current one (for tests and diagnostics). */
	snapshot(): { places: NavPlace[]; at: number } {
		return { places: this.entries.map((e) => ({ ...e })), at: this.at };
	}

	/**
	 * A jump from `from` (where the reader is now; null when unknown, e.g. coming from the library) to `to`. Forward
	 * history is discarded, as in a browser. A jump to the page already in view records nothing.
	 */
	jump(from: NavPlace | null, to: NavPlace): void {
		if (from && samePlace(from, to)) return;
		if (this.at >= 0 && this.at < this.entries.length - 1) this.entries.length = this.at + 1;
		if (from) this.leave(from);
		const last = this.entries[this.at];
		if (last && samePlace(last, to)) {
			this.entries[this.at] = { ...to };
		} else {
			this.entries.push({ ...to });
			this.at = this.entries.length - 1;
		}
		this.trim();
	}

	/** Records where the reader actually is: the current entry shows `place` from now on. */
	visit(place: NavPlace): void {
		this.leave(place);
	}

	/** The neighbour in direction `dir` (-1 back, 1 forward) without moving, or null. */
	peek(dir: -1 | 1): NavPlace | null {
		const e = this.entries[this.at + dir];
		return this.at >= 0 && e ? { ...e } : null;
	}

	/** Moves one entry in direction `dir`. False when there is none. */
	move(dir: -1 | 1): boolean {
		if (this.peek(dir) === null) return false;
		this.at += dir;
		return true;
	}

	/**
	 * The place to go back to, or null. `here` is where the reader is now: it replaces the current entry, so Forward
	 * returns to it.
	 */
	back(here: NavPlace | null): NavPlace | null {
		return this.step(-1, here);
	}

	/** The place to go forward to, or null (see `back`). */
	forward(here: NavPlace | null): NavPlace | null {
		return this.step(1, here);
	}

	private step(dir: -1 | 1, here: NavPlace | null): NavPlace | null {
		if (!(dir < 0 ? this.canBack : this.canForward)) return null;
		if (here) this.leave(here);
		// Leaving may have merged the current entry into its neighbour: nothing may be left to go to.
		const target = this.peek(dir);
		if (!target) return null;
		this.at += dir;
		return target;
	}

	/** Removes a place that cannot be shown any more (notebook deleted, page deleted), keeping the reader's position. */
	drop(place: NavPlace): void {
		const keep: NavPlace[] = [];
		let at = this.at;
		this.entries.forEach((e, i) => {
			if (samePlace(e, place)) {
				if (i <= this.at) at--;
			} else keep.push(e);
		});
		this.entries = keep;
		this.at = keep.length === 0 ? -1 : Math.max(0, Math.min(keep.length - 1, at));
		this.merge();
	}

	/** A notebook was renamed or moved. */
	rename(oldPath: string, newPath: string): void {
		for (const e of this.entries) if (e.path === oldPath) e.path = newPath;
		this.merge();
	}

	/** A notebook was deleted: its places go. */
	removeNotebook(path: string): void {
		const gone = this.entries.filter((e) => e.path === path);
		for (const g of gone) this.drop(g);
	}

	clear(): void {
		this.entries = [];
		this.at = -1;
	}

	/** The current entry now shows `place`, which is where the reader actually is. */
	private leave(place: NavPlace): void {
		if (this.at < 0) {
			this.entries = [{ ...place }];
			this.at = 0;
			return;
		}
		this.entries[this.at] = { ...place };
		this.merge();
	}

	/** Neighbours that are the same place collapse into one. */
	private merge(): void {
		for (let i = this.entries.length - 1; i > 0; i--) {
			if (!samePlace(this.entries[i]!, this.entries[i - 1]!)) continue;
			this.entries.splice(i, 1);
			if (this.at >= i) this.at--;
		}
		if (this.entries.length === 0) this.at = -1;
	}

	private trim(): void {
		const extra = this.entries.length - this.cap;
		if (extra <= 0) return;
		this.entries.splice(0, extra);
		this.at = Math.max(0, this.at - extra);
	}
}
