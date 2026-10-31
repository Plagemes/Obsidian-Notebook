// Colour helpers for the procedural art (pure logic). Tints, ramps and glows are mixed in OKLCH (oklch.ts), not RGB.
import { hexToRgb, normaliseHex, rgbToHex, type Rgb } from "../../ink/colour";
import { mixOklch, oklchToRgb, rgbToOklch } from "./oklch";

const FALLBACK: Rgb = { r: 0x6d, g: 0x8b, b: 0xff };

/** The colour of a spec as RGB; an invalid value falls back to the accent blue. */
export function rgbOf(hex: string): Rgb {
	return hexToRgb(hex) ?? FALLBACK;
}

/** `#rrggbb` normalised (lower case), or the fallback accent. */
export function hexOf(hex: string): string {
	return normaliseHex(hex) ?? rgbToHex(FALLBACK);
}

/** Mix of two colours in sRGB, t = 0 → a, t = 1 → b (for flat blends). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Towards white by t, in OKLCH: lightness rises, chroma fades, the hue stays (an RGB mix would drift and wash out). */
export function lighten(c: Rgb, t: number): Rgb {
	return mixOklch(c, WHITE, t);
}

/** Towards black by t, in OKLCH: lightness falls but most of the chroma stays, so shades do not go muddy. */
export function darken(c: Rgb, t: number): Rgb {
	const o = rgbToOklch(c);
	const k = Math.min(1, Math.max(0, t));
	return oklchToRgb({ l: o.l * (1 - k), c: o.c * (1 - 0.35 * k), h: o.h });
}

/**
 * The colour of the glow around a line: the subject colour made brighter and a little more saturated, with its hue
 * nudged a few degrees (so the halo reads as light, not as a flat copy). On light surfaces it is deeper.
 */
export function glowColour(c: Rgb, surface: "dark" | "light"): Rgb {
	const o = rgbToOklch(c);
	if (surface === "light") return oklchToRgb({ l: Math.min(o.l, 0.62), c: Math.max(o.c, 0.06) * 1.05, h: (o.h + 6) % 360 });
	return oklchToRgb({ l: Math.max(o.l, 0.74), c: Math.max(o.c, 0.08) * 1.12, h: (o.h + 8) % 360 });
}

/** CSS `rgba()` with the channels rounded and alpha clamped (3 decimals). */
export function rgba(c: Rgb, alpha: number): string {
	const a = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
	return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}

/** `#rrggbb` of an RGB colour. */
export function hex(c: Rgb): string {
	return rgbToHex({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
}

/** Turns the hue of a colour by `deg` degrees in OKLCH (lightness and chroma stay). */
export function shiftHue(c: Rgb, deg: number): Rgb {
	const o = rgbToOklch(c);
	return oklchToRgb({ l: o.l, c: o.c, h: (((o.h + deg) % 360) + 360) % 360 });
}
