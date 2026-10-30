// STUB (LIBHOME branch): placeholder of the ART agent's generative art, same contract (common brief). It draws simple
// deterministic line art so the library and Home render; the ART version replaces this file at merge.
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

function hash(text: string): number {
	let h = 2166136261;
	for (const ch of text) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function random(seed: string): () => number {
	let s = hash(seed) || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

/** Picks a style deterministically from a name (e.g. "Matematica" → a hash, not keyword AI). */
export function artStyleFor(name: string): ArtStyle {
	return STYLES[hash(name.toLowerCase()) % STYLES.length]!;
}

/** Draws the line art (transparent background) into the given 2D context, in CSS pixels w × h. */
export function drawArt(ctx: CanvasRenderingContext2D, w: number, h: number, spec: ArtSpec): void {
	const rnd = random(spec.seed);
	const style = spec.style ?? artStyleFor(spec.seed);
	const density = Math.max(0, Math.min(1, spec.density ?? 0.6));
	ctx.save();
	ctx.strokeStyle = spec.color;
	ctx.lineWidth = 1;
	const lines = 6 + Math.round(density * 14);
	if (style === "cells" || style === "orbits") {
		for (let i = 0; i < lines * 2; i++) {
			ctx.globalAlpha = 0.25 + rnd() * 0.5;
			ctx.beginPath();
			ctx.arc(rnd() * w, rnd() * h, 6 + rnd() * h * 0.22, 0, Math.PI * 2);
			ctx.stroke();
		}
	} else {
		for (let i = 0; i < lines; i++) {
			ctx.globalAlpha = 0.2 + (i / lines) * 0.6;
			ctx.beginPath();
			const amp = h * (0.08 + rnd() * 0.18);
			const freq = 1 + rnd() * 3;
			const phase = rnd() * Math.PI * 2;
			const y0 = (h * (i + 0.5)) / lines;
			for (let x = 0; x <= w; x += 4) {
				const y = y0 + Math.sin((x / w) * Math.PI * freq + phase) * amp;
				if (x === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
		}
	}
	ctx.restore();
}

const cache = new Map<string, string>();

function render(key: string, w: number, h: number, dpr: number, paint: (ctx: CanvasRenderingContext2D) => void): string {
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const canvas = activeDocument.createEl("canvas");
	canvas.width = Math.max(1, Math.round(w * dpr));
	canvas.height = Math.max(1, Math.round(h * dpr));
	const ctx = canvas.getContext("2d");
	let url = "";
	if (ctx) {
		ctx.scale(dpr, dpr);
		paint(ctx);
		url = canvas.toDataURL("image/png");
	}
	if (cache.size > 64) cache.delete(cache.keys().next().value!);
	cache.set(key, url);
	return url;
}

/** Cached PNG data URL of the art at the given size (device-pixel aware); cheap on repeat calls. */
export function artImage(spec: ArtSpec, w: number, h: number, dpr = 1): string {
	const key = `art|${spec.seed}|${spec.color}|${spec.style ?? ""}|${spec.density ?? ""}|${w}x${h}@${dpr}`;
	return render(key, w, h, dpr, (ctx) => drawArt(ctx, w, h, spec));
}

/** Inline SVG markup of the glossy folder icon in the given colour (DESIGN.md §2.6). */
export function folderIconSvg(color: string, size = 48): string {
	const id = `g${hash(color).toString(36)}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">`
		+ `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`
		+ `<path d="M4 12a4 4 0 0 1 4-4h11l4 4h17a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="${color}"/>`
		+ `<path d="M4 18a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="${color}"/>`
		+ `<path d="M4 18a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="url(#${id})"/>`
		+ `</svg>`;
}

/** Notebook cover (portrait): soft gradient + art, as a cached data URL. */
export function coverImage(spec: ArtSpec, w: number, h: number, dpr = 1): string {
	const key = `cover|${spec.seed}|${spec.color}|${spec.style ?? ""}|${spec.density ?? ""}|${w}x${h}@${dpr}`;
	return render(key, w, h, dpr, (ctx) => {
		const g = ctx.createLinearGradient(0, 0, w, h);
		g.addColorStop(0, spec.color);
		g.addColorStop(1, "#0a0e17");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);
		drawArt(ctx, w, h, spec);
	});
}
