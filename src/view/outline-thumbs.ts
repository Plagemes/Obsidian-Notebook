/**
 * Pictures of the headings in the outline (0.13, roadmap #407): the ink of a heading line drawn on its own, on white,
 * at the size of the panel. Cached by the identity of the heading's strokes (strokes are immutable), so a page that did
 * not change draws nothing again; the cache is small and drops the oldest picture first.
 */
import { drawPageRaster } from "../ink/page-raster";
import type { OutlineItem } from "../model/outline-builder";
import type { Page, Stroke } from "../model/types";

/** Widest picture, CSS px (the page panel is about 150 px wide). */
export const HEADING_THUMB_WIDTH = 132;
const MAX_CACHED = 48;
const MAX_DPR = 2;

interface Entry {
	strokes: readonly Stroke[];
	rect: string;
	url: string;
}

export class HeadingThumbs {
	private readonly cache = new Map<string, Entry>();

	/** PNG data URL of the heading's ink, or null when it cannot be drawn (no canvas, no strokes left). */
	url(page: Page, item: OutlineItem): string | null {
		const h = item.heading;
		if (!h) return null;
		const ids = new Set(h.strokeIds);
		const strokes = page.strokes.filter((s) => ids.has(s.id) && !s.hidden);
		if (strokes.length === 0) return null;
		const rect = `${h.rect.x},${h.rect.y},${h.rect.width},${h.rect.height}`;
		const key = `${page.id}:${item.key}`;
		const have = this.cache.get(key);
		if (have && have.rect === rect && sameStrokes(have.strokes, strokes)) {
			// Most recently used last.
			this.cache.delete(key);
			this.cache.set(key, have);
			return have.url;
		}
		const url = this.draw(page, strokes, h.rect);
		if (url === null) return null;
		this.cache.delete(key);
		this.cache.set(key, { strokes, rect, url });
		while (this.cache.size > MAX_CACHED) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return url;
	}

	clear(): void {
		this.cache.clear();
	}

	private draw(page: Page, strokes: Stroke[], rect: { x: number; y: number; width: number; height: number }): string | null {
		let canvas: HTMLCanvasElement | null = null;
		try {
			const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
			const scale = (Math.min(rect.width, HEADING_THUMB_WIDTH) / rect.width) * dpr;
			canvas = createEl("canvas");
			canvas.width = Math.max(1, Math.round(rect.width * scale));
			canvas.height = Math.max(1, Math.round(rect.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			// Only the heading's ink, on a plain white sheet: no paper lines, no background, no other elements.
			const sheet: Page = { id: page.id, width: page.width, height: page.height, paper: { kind: "blank", spacing: page.paper.spacing }, strokes, elements: [] };
			drawPageRaster(ctx, sheet, scale, { background: null, images: new Map(), region: rect });
			return canvas.toDataURL("image/png");
		} catch (e) {
			console.error("[notebook] outline heading picture", e);
			return null;
		} finally {
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
		}
	}
}

function sameStrokes(a: readonly Stroke[], b: readonly Stroke[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
