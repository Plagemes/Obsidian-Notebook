// wave 0.9 (376): finds and remembers where the content of each PDF page is (its non-white bounds), for the view-only
// "crop the white margins" toggle. Each page is rendered once at a very low resolution and read back; the result is cached
// for the session. Nothing is written to the notebook. The pure detection is in pdf/content-box.ts.
import { detectContentBox, type FractionBox } from "../pdf/content-box";
import type { Page } from "../model/types";
import type { NotebookMedia } from "./media";

/** Width of the low-resolution render the margins are measured on, px. */
export const DETECT_WIDTH_PX = 100;
/** Results are announced at most this often while pages are being measured, ms. */
const NOTIFY_MS = 300;

export interface ContentBoxesHost {
	media(): NotebookMedia | null;
	/** New results arrived (throttled). */
	changed(): void;
}

const keyOf = (asset: string, page: number): string => `${asset}|${page}`;

export class ContentBoxes {
	/** null: measured, nothing to crop (a blank page); absent: not measured yet. */
	private readonly boxes = new Map<string, FractionBox | null>();
	private readonly queue: Array<{ asset: string; page: number }> = [];
	private readonly queued = new Set<string>();
	private running = false;
	private stopped = false;
	private timer: number | null = null;

	constructor(private readonly host: ContentBoxesHost) {}

	/** The content box of a PDF page as fractions of its background, or null when unknown, blank or not a PDF page. */
	boxOf(page: Page): FractionBox | null {
		const bg = page.background;
		return bg?.kind === "pdf" ? this.boxes.get(keyOf(bg.asset, bg.page)) ?? null : null;
	}

	/** Whether every PDF page of `pages` has been measured. */
	complete(pages: readonly Page[]): boolean {
		return pages.every((p) => p.background?.kind !== "pdf" || this.boxes.has(keyOf(p.background.asset, p.background.page)));
	}

	/** Measures the PDF pages of `pages` that are not known yet, starting at index `first` and wrapping round. */
	ensure(pages: readonly Page[], first = 0): void {
		this.stopped = false;
		const n = pages.length;
		for (let k = 0; k < n; k++) {
			const bg = pages[(first + k) % n]?.background;
			if (bg?.kind !== "pdf") continue;
			const key = keyOf(bg.asset, bg.page);
			if (this.boxes.has(key) || this.queued.has(key)) continue;
			this.queued.add(key);
			this.queue.push({ asset: bg.asset, page: bg.page });
		}
		if (!this.running && this.queue.length > 0) void this.run();
	}

	/** Forgets the results (the document or its media changed) and stops measuring. */
	clear(): void {
		this.stop();
		this.boxes.clear();
	}

	stop(): void {
		this.stopped = true;
		this.queue.length = 0;
		this.queued.clear();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private async run(): Promise<void> {
		this.running = true;
		try {
			while (!this.stopped) {
				const job = this.queue.shift();
				if (!job) break;
				const key = keyOf(job.asset, job.page);
				this.queued.delete(key);
				let box: FractionBox | null = null;
				try {
					box = await this.measure(job.asset, job.page);
				} catch (e) {
					// Unreadable page: no crop for it; the rest goes on.
					console.error("[notebook] content box", e);
				}
				if (this.stopped) break;
				this.boxes.set(key, box);
				this.notify();
				// Let the view breathe between pages.
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
		} finally {
			this.running = false;
			if (!this.stopped && this.timer === null) this.host.changed();
		}
	}

	private async measure(asset: string, pageNumber: number): Promise<FractionBox | null> {
		const media = this.host.media();
		if (!media) return null;
		const sizes = await media.pdf.pageSizes(asset);
		const size = sizes[pageNumber - 1];
		if (!size || !(size.width > 0)) return null;
		const canvas = await media.pdf.render(asset, pageNumber, DETECT_WIDTH_PX / size.width);
		const ctx = canvas.getContext("2d");
		if (!ctx || canvas.width < 1 || canvas.height < 1) return null;
		const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		return detectContentBox({ data, width, height });
	}

	private notify(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (!this.stopped) this.host.changed();
		}, NOTIFY_MS);
	}
}
