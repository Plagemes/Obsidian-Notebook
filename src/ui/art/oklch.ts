// OKLab / OKLCH colour maths for the procedural art (pure logic): perceptual ramps, tints and glow colours.
//
// The matrices are those of Björn Ottosson's "A perceptual color space for image processing" (2020), published under
// the MIT licence (https://bottosson.github.io/posts/oklab/). Only the published constants are used; the code is ours.
import type { Rgb } from "../../ink/colour";

/** Lightness 0..1, chroma 0..~0.4, hue in degrees 0..360. */
export interface Oklch {
	l: number;
	c: number;
	h: number;
}

const toLinear = (v: number): number => {
	const s = Math.min(1, Math.max(0, v / 255));
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const fromLinear = (v: number): number => {
	const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
	return s * 255;
};

/** sRGB (0..255 per channel) to OKLCH. Greys get hue 0 and a chroma of about 0. */
export function rgbToOklch(c: Rgb): Oklch {
	const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const C = Math.hypot(A, B);
	const h = C < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
	return { l: L, c: C, h };
}

/** Linear sRGB (unclamped) of an OKLCH colour. */
function linearOf(o: Oklch): [number, number, number] {
	const hr = (o.h * Math.PI) / 180;
	const A = o.c * Math.cos(hr), B = o.c * Math.sin(hr);
	const l = Math.pow(o.l + 0.3963377774 * A + 0.2158037573 * B, 3);
	const m = Math.pow(o.l - 0.1055613458 * A - 0.0638541728 * B, 3);
	const s = Math.pow(o.l - 0.0894841775 * A - 1.291485548 * B, 3);
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const EPS = 1e-4;
const inGamut = (v: [number, number, number]): boolean => v.every((x) => x >= -EPS && x <= 1 + EPS);

/**
 * OKLCH to sRGB (0..255, not rounded). A colour outside the sRGB gamut keeps its lightness and hue and loses chroma
 * (binary search), instead of clipping channels, which would shift its hue.
 */
export function oklchToRgb(o: Oklch): Rgb {
	const l = Math.min(1, Math.max(0, Number.isFinite(o.l) ? o.l : 0));
	let c = Math.max(0, Number.isFinite(o.c) ? o.c : 0);
	const h = Number.isFinite(o.h) ? o.h : 0;
	let lin = linearOf({ l, c, h });
	if (!inGamut(lin)) {
		let lo = 0, hi = c;
		for (let i = 0; i < 14; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(linearOf({ l, c: mid, h }))) lo = mid;
			else hi = mid;
		}
		c = lo;
		lin = linearOf({ l, c, h });
	}
	return { r: fromLinear(Math.min(1, Math.max(0, lin[0]))), g: fromLinear(Math.min(1, Math.max(0, lin[1]))), b: fromLinear(Math.min(1, Math.max(0, lin[2]))) };
}

/** Chroma below which a colour counts as grey (its hue is noise). */
const GREY = 0.012;

/** Shortest-arc interpolation of two hues in degrees. */
function mixHue(a: number, b: number, t: number): number {
	let d = ((b - a + 540) % 360) - 180;
	if (!Number.isFinite(d)) d = 0;
	return (a + d * t + 360) % 360;
}

/** Interpolates two colours in OKLCH (t = 0 → a, t = 1 → b): lightness and chroma linearly, hue along the shortest arc. */
export function mixOklch(a: Rgb, b: Rgb, t: number): Rgb {
	const x = rgbToOklch(a), y = rgbToOklch(b);
	// A grey end has no hue of its own: the mix keeps the other end's hue.
	const hx = x.c < GREY ? y.h : x.h, hy = y.c < GREY ? x.h : y.h;
	return oklchToRgb({ l: x.l + (y.l - x.l) * t, c: x.c + (y.c - x.c) * t, h: mixHue(hx, hy, t) });
}

/** Moves a colour in OKLCH: lightness by `dl` (absolute), chroma times `kc`, hue by `dh` degrees. */
export function shiftOklch(c: Rgb, dl: number, kc = 1, dh = 0): Rgb {
	const o = rgbToOklch(c);
	return oklchToRgb({ l: o.l + dl, c: o.c * kc, h: (o.h + dh + 360) % 360 });
}

/**
 * A ramp of `n` colours from dark to light with the hue of `base` (chroma follows a soft bell, so the ends are calmer
 * than the middle). The lightness runs from `from` to `to`.
 */
export function oklchRamp(base: Rgb, n: number, from = 0.28, to = 0.92): Rgb[] {
	const o = rgbToOklch(base);
	const out: Rgb[] = [];
	const count = Math.max(1, Math.floor(n));
	for (let i = 0; i < count; i++) {
		const t = count === 1 ? 0.5 : i / (count - 1);
		const bell = 0.55 + 0.45 * Math.sin(Math.PI * t);
		out.push(oklchToRgb({ l: from + (to - from) * t, c: Math.max(o.c, 0.04) * bell, h: o.h }));
	}
	return out;
}
