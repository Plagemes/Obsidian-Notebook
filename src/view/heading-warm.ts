/**
 * 0.20 (#102): analyses the handwriting of the pages for headings in the background, so the outline, the notebook map and the
 * companion note find the work already done. Never on the writing path: a change only (re)starts a timer; the analysis runs in
 * small slices at idle moments, and not while the pen is on the screen (storage/idle.ts `whenIdle` waits for it).
 */
import type { OutlineBuilder } from "../model/outline-builder";
import type { Page } from "../model/types";
import { whenIdle } from "../storage/idle";

/** Quiet time after the last change before the analysis starts, ms. */
export const WARM_DELAY_MS = 3000;
/** Longest slice of analysis in one idle callback, ms. */
export const WARM_SLICE_MS = 8;

export class HeadingWarmer {
	private timer: number | null = null;
	private running = false;
	private disposed = false;

	constructor(
		private readonly builder: OutlineBuilder,
		private readonly pages: () => readonly Page[],
		private readonly enabled: () => boolean,
	) {}

	/** Something changed (or the notebook was opened): analyse what is stale a moment from now. Cheap: one timer. */
	touch(delayMs = WARM_DELAY_MS): void {
		if (this.disposed || !this.enabled()) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.run();
		}, delayMs);
	}

	private async run(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (!this.disposed && this.enabled()) {
				await whenIdle(0, 2000);
				if (this.disposed) break;
				if (this.builder.warm(this.pages(), WARM_SLICE_MS) === 0) break;
			}
		} catch (e) {
			console.error("[notebook] heading analysis", e);
		} finally {
			this.running = false;
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}
