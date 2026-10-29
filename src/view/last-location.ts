import type { Timers } from "../storage/session";

/**
 * Remembers where the reader is (notebook path and page) shortly after it changes, so reopening shows the same
 * page and the "Continue last notebook" command knows where to go. Changes are collapsed: a quick flip through
 * ten pages saves once. Only the place is stored (in the plugin settings and the workspace layout), never in
 * the notebook file.
 */
export class LocationKeeper {
	private timer: number | null = null;
	private pending: { path: string; page: number } | null = null;

	constructor(
		private readonly timers: Timers,
		private readonly save: (path: string, page: number) => void,
		private readonly delayMs = 1000,
	) {}

	/** The reader is on `page` (1-based) of the notebook at `path`. */
	note(path: string, page: number): void {
		if (!Number.isInteger(page) || page < 1) return;
		this.pending = { path, page };
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = this.timers.set(() => this.flush(), this.delayMs);
	}

	/** Saves a pending location now (view closing, app going to the background). */
	flush(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		const p = this.pending;
		this.pending = null;
		if (p) this.save(p.path, p.page);
	}

	/** Drops a pending location without saving it. */
	cancel(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		this.pending = null;
	}
}
