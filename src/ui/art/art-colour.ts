// Colour helpers for the procedural art (pure logic).
import { hexToRgb, normaliseHex, rgbToHex, type Rgb } from "../../ink/colour";

const FALLBACK: Rgb = { r: 0x6d, g: 0x8b, b: 0xff };

/** The colour of a spec as RGB; an invalid value falls back to the accent blue. */
export function rgbOf(hex: string): Rgb {
	return hexToRgb(hex) ?? FALLBACK;
}

/** `#rrggbb` normalised (lower case), or the fallback accent. */
export function hexOf(hex: string): string {
	return normaliseHex(hex) ?? rgbToHex(FALLBACK);
}

/** Linear mix of two colours, t = 0 → a, t = 1 → b. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Towards white by t. */
export function lighten(c: Rgb, t: number): Rgb {
	return mix(c, WHITE, t);
}

/** Towards black by t. */
export function darken(c: Rgb, t: number): Rgb {
	return mix(c, BLACK, t);
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
