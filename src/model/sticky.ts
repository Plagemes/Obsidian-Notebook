import { createId } from "./document";
import type { BBox } from "../ink/hit-test";
import type { Page, PageElement, StickyElement, Stroke } from "./types";

/**
 * Sticky notes (0.17, roadmap #20, format v15). Pure data and geometry: no 'obsidian', no DOM. A note is a page element
 * (`StickyElement`); the ink written on it is ordinary page ink that the note owns geometrically (ink/attach.ts), so it moves
 * and scales with the note, is erased, selected, exported and undone like any other ink. See docs/architecture.md, *Sticky
 * notes, format v15*.
 */

/** Side of a new note (pt): a square a little smaller than a hand. */
export const STICKY_DEFAULT_SIZE = 150;
/** A note is never smaller or larger than this (pt, each side). */
export const STICKY_MIN_SIZE = 48;
export const STICKY_MAX_SIZE = 900;
/** Side of the icon a collapsed note is drawn as (pt), at the note's top-left corner. */
export const STICKY_ICON = 28;
export const STICKY_DEFAULT_FONT = 14;
export const STICKY_MIN_FONT = 5;
export const STICKY_MAX_FONT = 72;
/** Longest typed text (characters); one note is a note, not a document. */
export const STICKY_TEXT_MAX = 2000;
/** Most stroke ids a collapsed note remembers (a note covers one place of a page). */
export const STICKY_INK_MAX = 20000;
/** Padding between the edge of the note and its typed text (pt, before the font scale). */
export const STICKY_PADDING = 8;
/** The default colour: "Amber" of the subject palette (src/ui/palette.ts), the classic yellow note. */
export const STICKY_DEFAULT_COLOR = "#F59E0B";

/** Typed text as stored: line breaks normalised, no trailing blank space, at most STICKY_TEXT_MAX characters. */
export function cleanStickyText(text: string): string {
	const normal = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
	return Array.from(normal).slice(0, STICKY_TEXT_MAX).join("");
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A new, empty note whose centre is (`cx`, `cy`), kept inside a page of `page` size when it fits. */
export function createSticky(
	cx: number, cy: number, page: { width: number; height: number }, color: string = STICKY_DEFAULT_COLOR, size = STICKY_DEFAULT_SIZE,
): StickyElement {
	const side = Math.min(size, Math.max(STICKY_MIN_SIZE, Math.min(page.width, page.height)));
	const x = Math.min(Math.max(0, page.width - side), Math.max(0, cx - side / 2));
	const y = Math.min(Math.max(0, page.height - side), Math.max(0, cy - side / 2));
	return { id: createId(), type: "sticky", x: round2(x), y: round2(y), width: side, height: side, color, fontSize: STICKY_DEFAULT_FONT };
}

/** The whole box of the note (the place its ink is written on), collapsed or not. */
export function stickyFrame(el: StickyElement): BBox {
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

/** What is drawn and can be hit: the box, or the icon of a collapsed note. */
export function stickyBounds(el: StickyElement): BBox {
	return el.collapsed ? { minX: el.x, minY: el.y, maxX: el.x + STICKY_ICON, maxY: el.y + STICKY_ICON } : stickyFrame(el);
}

/** `#rrggbb` with `part` (0–1) of white mixed in: the paper of a note, lighter than its base colour. */
export function mixWithWhite(color: string, part: number): string {
	const m = /^#([0-9a-fA-F]{6})$/.exec(color);
	if (!m) return "#fff3b0";
	const n = parseInt(m[1]!, 16);
	const mix = (c: number) => Math.round(c + (255 - c) * part);
	const h = (c: number) => mix(c).toString(16).padStart(2, "0");
	return `#${h((n >> 16) & 255)}${h((n >> 8) & 255)}${h(n & 255)}`;
}

/** `top` laid over `under` with opacity `alpha` (both `#rrggbb`): the solid colour that looks the same, for outputs without transparency. */
export function blend(top: string, under: string, alpha: number): string {
	const a = /^#([0-9a-fA-F]{6})$/.exec(top);
	const b = /^#([0-9a-fA-F]{6})$/.exec(under);
	if (!a || !b) return under;
	const x = parseInt(a[1]!, 16);
	const y = parseInt(b[1]!, 16);
	const h = (s: number) => Math.round(((x >> s) & 255) * alpha + ((y >> s) & 255) * (1 - alpha)).toString(16).padStart(2, "0");
	return `#${h(16)}${h(8)}${h(0)}`;
}

/** `#rrggbb` darkened by `part` (0–1): the edge and the folded corner of a note. */
export function darken(color: string, part: number): string {
	const m = /^#([0-9a-fA-F]{6})$/.exec(color);
	if (!m) return "#c9a227";
	const n = parseInt(m[1]!, 16);
	const h = (c: number) => Math.round(c * (1 - part)).toString(16).padStart(2, "0");
	return `#${h((n >> 16) & 255)}${h((n >> 8) & 255)}${h(n & 255)}`;
}

/** Paper, edge and text colours of a note. A light, saturated paper in the day; a deeper one at night (the text stays dark/light to match). */
export function stickyColours(color: string, night = false): { paper: string; edge: string; text: string; fold: string } {
	if (night) {
		const paper = mixWithWhite(darken(color, 0.55), 0.08);
		return { paper, edge: darken(color, 0.7), text: "#f4f4f5", fold: darken(color, 0.7) };
	}
	return { paper: mixWithWhite(color, 0.72), edge: darken(color, 0.18), text: "#1f2430", fold: mixWithWhite(color, 0.42) };
}

/** Whether `el` is a note. */
export function isSticky(el: PageElement): el is StickyElement {
	return el.type === "sticky";
}

/** Notes of a page, in array order. */
export function stickiesOf(page: Page): StickyElement[] {
	return (page.elements ?? []).filter(isSticky);
}

/** The ids of the strokes that notes of the page keep hidden (collapsed notes' `ink`), or null when there are none. */
export function hiddenStickyInk(elements: readonly PageElement[] | undefined): Set<string> | null {
	let out: Set<string> | null = null;
	for (const el of elements ?? []) {
		if (el.type !== "sticky" || !el.collapsed || !el.ink) continue;
		out ??= new Set();
		for (const id of el.ink) out.add(id);
	}
	return out;
}

/** The ink ids of `el` that are strokes of the page (ids of strokes that are gone are ignored). */
export function liveInk(el: StickyElement, strokes: readonly Stroke[]): string[] {
	if (!el.ink || el.ink.length === 0) return [];
	const alive = new Set(strokes.map((s) => s.id));
	return el.ink.filter((id) => alive.has(id));
}

/** A copy of the note with its typed text (cleaned; empty removes it), colour or size changed. */
export function editedSticky(el: StickyElement, change: { text?: string; color?: string; fontSize?: number }): StickyElement {
	const out: StickyElement = { ...el };
	if (change.text !== undefined) {
		const text = cleanStickyText(change.text);
		if (text === "") delete out.text;
		else out.text = text;
	}
	if (change.color !== undefined) out.color = change.color;
	if (change.fontSize !== undefined) out.fontSize = Math.min(STICKY_MAX_FONT, Math.max(STICKY_MIN_FONT, round2(change.fontSize)));
	return out;
}

/** A collapsed note whose hidden-stroke ids went through `map` (strokes copied under new ids); ids without an entry are dropped. */
export function remapStickyInk(el: StickyElement, map: ReadonlyMap<string, string>): StickyElement {
	if (!el.ink) return el;
	const ink = [...new Set(el.ink.map((id) => map.get(id)).filter((id): id is string => id !== undefined))];
	const out: StickyElement = { ...el };
	if (ink.length > 0) out.ink = ink;
	else delete out.ink;
	return out;
}

/** The note collapsed over `ink` (the ids of the strokes written on it), or expanded again (its ink shown, the list cleared). */
export function toggledSticky(el: StickyElement, ink: readonly string[]): StickyElement {
	const out: StickyElement = { ...el };
	if (el.collapsed) {
		delete out.collapsed;
		delete out.ink;
		return out;
	}
	out.collapsed = true;
	if (ink.length > 0) out.ink = ink.slice(0, STICKY_INK_MAX);
	return out;
}
