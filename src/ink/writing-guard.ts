/**
 * Do not disturb while writing (wave 0.8, 374). Knows whether the pen is on the screen, or was a moment ago, so that
 * the plugin's own notices and non-urgent background work can wait for a pause. Pure: no 'obsidian', no DOM; the pointer
 * events are fed in by view/writing-quiet.ts.
 *
 * Writing = a pen is down, or one was lifted less than `quietMs` ago (the next stroke of the same word usually follows
 * within that time). Work waits with `whenQuiet`; it runs once, in order, at the first moment that is not writing.
 * A pen that is "down" for `stuckMs` without an up event is assumed lost (pointercancel swallowed, window blurred), so
 * the queue can never wait for ever.
 */

/** Pen off the screen this long = a pause. */
export const QUIET_AFTER_MS = 1500;
/** A pen down this long without any event is assumed lost. */
export const STUCK_PEN_MS = 15_000;

export interface Scheduler {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
	set: (fn, ms) => window.setTimeout(fn, ms),
	clear: (handle) => window.clearTimeout(handle as number),
};

export class WritingGuard {
	private readonly down = new Map<number, number>();
	private lastUp = Number.NEGATIVE_INFINITY;
	private readonly queue: Array<{ key: string | null; run: () => void }> = [];
	private timer: unknown = null;

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly scheduler: Scheduler = defaultScheduler,
		private readonly quietMs = QUIET_AFTER_MS,
		private readonly stuckMs = STUCK_PEN_MS,
	) {}

	penDown(pointerId: number): void {
		this.down.set(pointerId, this.now());
	}

	penUp(pointerId: number): void {
		if (this.down.delete(pointerId)) this.lastUp = this.now();
	}

	/** Forgets every pen that is down (window lost focus, tab hidden): the pause starts now. */
	penLost(): void {
		if (this.down.size === 0) return;
		this.down.clear();
		this.lastUp = this.now();
		this.arm();
	}

	/** True while a pen is on the screen and for `quietMs` after the last one was lifted. */
	writing(): boolean {
		const now = this.now();
		for (const [id, since] of this.down) {
			if (now - since > this.stuckMs) {
				this.down.delete(id);
				this.lastUp = now;
			}
		}
		return this.down.size > 0 || now - this.lastUp < this.quietMs;
	}

	/**
	 * Runs `task` now when not writing, otherwise at the first pause. With a `key`, a task still waiting under the same
	 * key is replaced by this one (a notice repeated while writing is shown once).
	 */
	whenQuiet(task: () => void, key: string | null = null): void {
		if (this.queue.length === 0 && !this.writing()) {
			task();
			return;
		}
		if (key !== null) {
			const waiting = this.queue.findIndex((q) => q.key === key);
			if (waiting >= 0) this.queue.splice(waiting, 1);
		}
		this.queue.push({ key, run: task });
		this.arm();
	}

	/** Resolves at the first pause (at once when not writing). */
	idle(): Promise<void> {
		return new Promise((resolve) => this.whenQuiet(resolve));
	}

	/** Number of tasks waiting for a pause. */
	get waiting(): number {
		return this.queue.length;
	}

	/** Drops everything that waits and every timer (plugin unload). Nothing queued runs afterwards. */
	reset(): void {
		this.queue.length = 0;
		this.down.clear();
		this.lastUp = Number.NEGATIVE_INFINITY;
		if (this.timer !== null) this.scheduler.clear(this.timer);
		this.timer = null;
	}

	private arm(): void {
		if (this.timer !== null || this.queue.length === 0) return;
		const since = this.now() - this.lastUp;
		const wait = this.down.size > 0 ? this.quietMs : Math.max(50, this.quietMs - since);
		this.timer = this.scheduler.set(() => {
			this.timer = null;
			this.flush();
		}, wait);
	}

	private flush(): void {
		if (this.writing()) {
			this.arm();
			return;
		}
		const tasks = this.queue.splice(0, this.queue.length);
		for (const task of tasks) {
			try {
				task.run();
			} catch (e) {
				console.error("[notebook] task that waited for a pause failed", e);
			}
		}
	}
}

/** The one guard of the plugin: views, notices and background jobs all ask this. */
export const writing = new WritingGuard();
