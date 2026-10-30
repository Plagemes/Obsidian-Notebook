// STUB (CREATE branch): the ART agent owns this file; its version replaces this one at merge. Same contract, simpler
// pictures: enough for the creation dialog to show a real, deterministic, cached cover and folder card.

export type ArtStyle = "contours" | "cells" | "waves" | "branches" | "flow" | "orbits" | "grid";
export interface ArtSpec {
	/** Stable seed (e.g. folder path or notebook id): same seed → same picture. */
	seed: string;
	/** Base colour, `#rrggbb` (a subject colour from DESIGN.md §2.3). */
	color: string;
	/** Visual family; default: artStyleFor(seed). */
	style?: ArtStyle;
	/** 0..1, default 0.6. */
	density?: number;
}

const STYLES: readonly ArtStyle[] = ["contours", "cells", "waves", "branches", "flow", "orbits", "grid"];

function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Small seeded generator (mulberry32). */
function rng(seed: string): () => number {
	let a = hash(seed);
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Picks a style deterministically from a name (e.g. "Matematica" → a hash, not keyword AI). */
export function artStyleFor(name: string): ArtStyle {
	return STYLES[hash(name) % STYLES.length]!;
}

/** Draws the line art (transparent background) into the given 2D context, in CSS pixels w × h. */
export function drawArt(ctx: CanvasRenderingContext2D, w: number, h: number, spec: ArtSpec): void {
	const r = rng(spec.seed);
	const style = spec.style ?? artStyleFor(spec.seed);
	const n = Math.round(6 + 14 * (spec.density ?? 0.6));
	ctx.save();
	ctx.strokeStyle = spec.color;
	ctx.lineWidth = Math.max(1, Math.min(w, h) / 160);
	ctx.globalAlpha = 0.7;
	ctx.beginPath();
	for (let i = 0; i < n; i++) {
		const y0 = (h * (i + 0.5)) / n;
		const amp = (h / n) * (0.4 + r());
		const f = 1 + r() * 3;
		switch (style) {
			case "cells":
			case "grid": {
				const x = r() * w, y = r() * h, s = (Math.min(w, h) / 6) * (0.5 + r());
				ctx.rect(x - s / 2, y - s / 2, s, s);
				break;
			}
			case "orbits":
			case "contours": {
				const cx = w * (0.55 + 0.3 * r()), cy = h * (0.3 + 0.4 * r());
				ctx.moveTo(cx + (i + 1) * (Math.min(w, h) / n / 1.3), cy);
				ctx.arc(cx, cy, (i + 1) * (Math.min(w, h) / n / 1.3), 0, Math.PI * 2);
				break;
			}
			case "branches": {
				const x = r() * w;
				ctx.moveTo(x, h);
				ctx.lineTo(x + (r() - 0.5) * w * 0.3, h * (0.2 + 0.6 * r()));
				break;
			}
			default: {
				ctx.moveTo(0, y0);
				for (let x = 0; x <= w; x += Math.max(4, w / 60)) ctx.lineTo(x, y0 + Math.sin((x / w) * Math.PI * 2 * f + i) * amp * 0.5);
			}
		}
	}
	ctx.stroke();
	ctx.restore();
}

const cache = new Map<string, string>();
const MAX_CACHE = 96;

function remember(key: string, make: () => string): string {
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const url = make();
	if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
	cache.set(key, url);
	return url;
}

function canvasUrl(w: number, h: number, dpr: number, paint: (ctx: CanvasRenderingContext2D) => void): string {
	const canvas = activeDocument.createEl("canvas");
	canvas.width = Math.max(1, Math.round(w * dpr));
	canvas.height = Math.max(1, Math.round(h * dpr));
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	ctx.scale(dpr, dpr);
	paint(ctx);
	return canvas.toDataURL("image/png");
}

const specKey = (spec: ArtSpec) => `${spec.seed}|${spec.color}|${spec.style ?? ""}|${spec.density ?? ""}`;

/** Cached PNG data URL of the art at the given size (device-pixel aware); cheap on repeat calls. */
export function artImage(spec: ArtSpec, w: number, h: number, dpr = window.devicePixelRatio || 1): string {
	return remember(`art|${specKey(spec)}|${w}x${h}@${dpr}`, () => canvasUrl(w, h, dpr, (ctx) => drawArt(ctx, w, h, spec)));
}

/** Inline SVG markup of the glossy folder icon in the given colour (DESIGN.md §2.6). */
export function folderIconSvg(color: string, size = 44): string {
	const id = `nbf${hash(color).toString(16)}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">`
		+ `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/>`
		+ `<stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>`
		+ `<path d="M4 12a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="${color}"/>`
		+ `<path d="M4 18a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="${color}"/>`
		+ `<path d="M4 18a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#${id})"/></svg>`;
}

/** Notebook cover (portrait): soft gradient + art, as a cached data URL. */
export function coverImage(spec: ArtSpec, w: number, h: number, dpr = window.devicePixelRatio || 1): string {
	return remember(`cover|${specKey(spec)}|${w}x${h}@${dpr}`, () => canvasUrl(w, h, dpr, (ctx) => {
		const g = ctx.createLinearGradient(0, 0, w, h);
		g.addColorStop(0, spec.color);
		g.addColorStop(1, "#0f1420");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);
		drawArt(ctx, w, h, { ...spec, color: "#ffffff" });
	}));
}
