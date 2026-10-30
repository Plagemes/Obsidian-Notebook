// wave 0.9 (367): night mode. A dark page display that changes colours at render time only: the stored stroke and text
// colours are never touched, and exports and thumbnails do not use it. Pure, no 'obsidian' import.
//
// - Paper: dark. Paper lines: dark too (same hue, lightness mirrored around the paper).
// - Ink and text: a colour darker than mid-grey is mirrored to the light side (near-black becomes light grey), hue and
//   saturation are kept; then the colour is lightened until it reads on the dark paper (contrast at least 4.5:1).
// - Highlighter: kept lively (hue and saturation of the colour, lightness held in a band) and blended with "screen", since
//   "multiply" would vanish on a dark page.
// - PDF and picture backgrounds are covered with a dark veil: they are dimmed, not inverted.

export const NIGHT_PAPER = "#1b1d22";
/** Opacity of the dark veil over a PDF or picture background. */
export const NIGHT_BACKGROUND_VEIL = 0.72;
/** Opacity of the highlighter in night mode (blended with "screen"). */
export const NIGHT_HIGHLIGHTER_ALPHA = 0.45;
/** Contrast ratio the ink must reach against the night paper (WCAG AA for text). */
export const NIGHT_MIN_CONTRAST = 4.5;

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const byte = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

/** Reads `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and `rgba(r, g, b, a)`; null for anything else. */
export function parseColor(css: string): Rgba | null {
	const s = css.trim().toLowerCase();
	let m = /^#([0-9a-f]{3,4})$/.exec(s);
	if (m) {
		const h = m[1]!;
		const v = (i: number) => parseInt(h[i]! + h[i]!, 16);
		return { r: v(0), g: v(1), b: v(2), a: h.length === 4 ? v(3) / 255 : 1 };
	}
	m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
	if (m) {
		const h = m[1]!;
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
	}
	m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
	if (m) {
		let a = 1;
		if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		if (!Number.isFinite(a)) return null;
		return { r: byte(Number(m[1])), g: byte(Number(m[2])), b: byte(Number(m[3])), a: clamp01(a) };
	}
	return null;
}

/** `#rrggbb`, or `rgba(...)` when the colour is translucent. */
export function formatColor(c: Rgba): string {
	const hex = (n: number) => byte(n).toString(16).padStart(2, "0");
	return c.a < 1 ? `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(c.a * 1000) / 1000})` : `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

export interface Hsl {
	/** Degrees, 0-360. */
	h: number;
	s: number;
	l: number;
}

export function toHsl({ r, g, b }: Rgba): Hsl {
	const R = r / 255, G = g / 255, B = b / 255;
	const max = Math.max(R, G, B), min = Math.min(R, G, B);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l };
	const s = d / (1 - Math.abs(2 * l - 1));
	let h: number;
	if (max === R) h = ((G - B) / d) % 6;
	else if (max === G) h = (B - R) / d + 2;
	else h = (R - G) / d + 4;
	return { h: (h * 60 + 360) % 360, s: clamp01(s), l };
}

export function fromHsl({ h, s, l }: Hsl, a = 1): Rgba {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a };
}

/** WCAG relative luminance, 0-1. */
export function luminance({ r, g, b }: Rgba): number {
	const lin = (v: number) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours, 1-21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
	const la = luminance(a), lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const PAPER_RGB = parseColor(NIGHT_PAPER)!;
const PAPER_L = toHsl(PAPER_RGB).l;

/** The colour an ink or text colour is drawn with in night mode. Anything that is not a colour is returned unchanged. */
export function nightInk(color: string): string {
	const rgb = parseColor(color);
	if (!rgb) return color;
	const hsl = toHsl(rgb);
	let l = hsl.l < 0.5 ? 0.5 + (0.5 - hsl.l) * 0.9 : hsl.l;
	let out = fromHsl({ ...hsl, l }, rgb.a);
	while (contrastRatio(out, PAPER_RGB) < NIGHT_MIN_CONTRAST && l < 0.92) {
		l = Math.min(0.92, l + 0.02);
		out = fromHsl({ ...hsl, l }, rgb.a);
	}
	return formatColor(out);
}

/** The colour of a highlighter stroke in night mode: lively, neither dark nor washed out. */
export function nightHighlighter(color: string): string {
	const rgb = parseColor(color);
	if (!rgb) return color;
	const hsl = toHsl(rgb);
	const coloured = hsl.s > 0.1;
	return formatColor(fromHsl({ h: hsl.h, s: coloured ? Math.max(hsl.s, 0.6) : hsl.s, l: Math.min(0.62, Math.max(0.45, hsl.l)) }, 1));
}

/** A paper line or dot colour (light on white paper) as a dim line on the night paper. */
export function nightLine(color: string): string {
	const rgb = parseColor(color);
	if (!rgb) return color;
	const hsl = toHsl(rgb);
	return formatColor(fromHsl({ h: hsl.h, s: hsl.s * 0.6, l: Math.min(0.5, PAPER_L + (1 - hsl.l) * 0.8) }, rgb.a));
}

/** Memoised colour mappers for the renderer (a page has few distinct colours). */
export function memoColors(map: (color: string) => string): (color: string) => string {
	const cache = new Map<string, string>();
	return (color) => {
		let out = cache.get(color);
		if (out === undefined) {
			out = map(color);
			if (cache.size > 512) cache.clear();
			cache.set(color, out);
		}
		return out;
	};
}
