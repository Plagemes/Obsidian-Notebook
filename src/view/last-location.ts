import type { SavedPosition } from "../ink/view-position";
import type { Timers } from "../storage/session";

/**
 * Remembers where the reader is (notebook path, page, zoom and scroll position) shortly after it changes, so reopening shows the same
 * page and the "Continue last notebook" command knows where to go. Changes are collapsed: a quick flip through
 * ten pages or a long scroll saves once. Only the place is stored (in the plugin settings and the workspace layout),
 * never in the notebook file.
 */
export class LocationKeeper {
	private timer: number | null = null;
	private pending: { path: string; page: number; pos: SavedPosition | null } | null = null;

	constructor(
		private readonly timers: Timers,
		private readonly save: (path: string, page: number, pos: SavedPosition | null) => void,
		private readonly delayMs = 1000,
	) {}

	/** The reader is on `page` (1-based) of the notebook at `path`, looking at `pos`. */
	note(path: string, page: number, pos: SavedPosition | null = null): void {
		if (!Number.isInteger(page) || page < 1) return;
		this.pending = { path, page, pos };
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = this.timers.set(() => this.flush(), this.delayMs);
	}

	/** Saves a pending location now (view closing, app going to the background). */
	flush(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		const p = this.pending;
		this.pending = null;
		if (p) this.save(p.path, p.page, p.pos);
	}

	/** Drops a pending location without saving it. */
	cancel(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		this.pending = null;
	}
}
