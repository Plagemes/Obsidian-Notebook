/**
 * A wet-ink canvas that exists only while it is used (0.22 review fix D4). The marker's wet canvas is a full-viewport bitmap
 * (about 16-20 MB on a 2560 x 1600 tablet): it is created when the first marker stroke starts, kept while marker strokes follow
 * each other, and released a few seconds after the last one has been shown by the static layer. The other pens never touch it, so
 * they pay nothing for it. Pure: the canvas and the timer are injected.
 */
export interface LazyWetOptions<T> {
	create(): T;
	dispose(item: T): void;
	/** True while the item still holds ink that must stay (a stroke in progress, or one waiting to be cleared). */
	busy(item: T): boolean;
	idleMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/** Idle time after the last marker stroke before the canvas is released, ms. */
export const WET_IDLE_MS = 4000;

export class LazyWet<T> {
	private item: T | null = null;
	private timer: unknown = null;

	constructor(private readonly o: LazyWetOptions<T>) {}

	/** The item, created now if it does not exist. Cancels a pending release. */
	acquire(): T {
		this.cancel();
		return (this.item ??= this.o.create());
	}

	/** The item if it exists (never creates it). */
	peek(): T | null {
		return this.item;
	}

	/** A stroke on it ended or was dropped: release it after the idle time unless it is used again meanwhile. */
	idle(): void {
		if (this.item === null) return;
		this.cancel();
		const set = this.o.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
		this.timer = set(() => {
			this.timer = null;
			const item = this.item;
			if (item === null) return;
			if (this.o.busy(item)) {
				this.idle();
				return;
			}
			this.item = null;
			this.o.dispose(item);
		}, this.o.idleMs ?? WET_IDLE_MS);
	}

	cancel(): void {
		if (this.timer === null) return;
		(this.o.clearTimer ?? ((h) => window.clearTimeout(h as number)))(this.timer);
		this.timer = null;
	}

	/** Releases it now (view closing). */
	destroy(): void {
		this.cancel();
		const item = this.item;
		this.item = null;
		if (item !== null) this.o.dispose(item);
	}
}
