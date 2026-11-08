// The cover templates (0.22 covers): a few designed layouts that put the notebook's title on generated art. This file is the
// pure part (which templates exist, how a title is wrapped, which text colour reads on a background); the painting is
// ui/cover-compose.ts. No Obsidian, no DOM.

export const COVER_TEMPLATES = ["classic", "band", "frame", "minimal", "poster"] as const;
export type CoverTemplateId = (typeof COVER_TEMPLATES)[number];

export function isCoverTemplate(v: unknown): v is CoverTemplateId {
	return typeof v === "string" && (COVER_TEMPLATES as readonly string[]).includes(v);
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` as [r, g, b], or null when it is not one. */
export function parseHex(color: string): [number, number, number] | null {
	const m = HEX.exec(color.trim());
	if (!m) return null;
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG) of `#rrggbb`; 0 for anything else. */
export function luminance(color: string): number {
	const rgb = parseHex(color);
	if (!rgb) return 0;
	const [r, g, b] = rgb.map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Near-white or near-black, whichever reads better on `background`. */
export function readableOn(background: string): string {
	return luminance(background) > 0.42 ? "#16191f" : "#f7f8fb";
}

/** `color` moved towards black (`t` < 0) or white (`t` > 0) by |t| (0..1), as `#rrggbb`. */
export function shade(color: string, t: number): string {
	const rgb = parseHex(color);
	if (!rgb) return color;
	const k = Math.min(1, Math.abs(t));
	const target = t < 0 ? 0 : 255;
	const out = rgb.map((v) => Math.round(v + (target - v) * k));
	return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Breaks `text` into at most `maxLines` lines no wider than `maxWidth` according to `measure` (the width of a string). Words are
 * never split unless one alone is too wide (then it is cut by characters); what does not fit ends the last line with an ellipsis.
 */
export function wrapTitle(text: string, measure: (s: string) => number, maxWidth: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0 || maxLines < 1 || !(maxWidth > 0)) return [];
	const lines: string[] = [];
	let line = "";
	let i = 0;
	const push = (s: string) => void lines.push(s);
	while (i < words.length) {
		const word = words[i]!;
		const trial = line ? `${line} ${word}` : word;
		if (measure(trial) <= maxWidth) {
			line = trial;
			i++;
			continue;
		}
		if (line) {
			push(line);
			line = "";
			if (lines.length === maxLines) break;
			continue;
		}
		// One word alone is too wide: cut it by characters.
		let n = word.length;
		while (n > 1 && measure(word.slice(0, n)) > maxWidth) n--;
		push(word.slice(0, n));
		words[i] = word.slice(n);
		if (!words[i]) i++;
		if (lines.length === maxLines) break;
	}
	if (line && lines.length < maxLines) push(line);
	if (lines.length === 0) return [];
	const used = lines.join(" ").length;
	if (i < words.length || used < text.replace(/\s+/g, " ").trim().length - 1) {
		let last = lines[maxLines - 1] ?? lines[lines.length - 1]!;
		const at = Math.min(lines.length, maxLines) - 1;
		while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
		lines[at] = `${last.trimEnd()}…`;
		lines.length = at + 1;
	}
	return lines.slice(0, maxLines);
}
