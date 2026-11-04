/**
 * Presentation mode (roadmap #87): the pure logic. Where "next" and "previous" go (pages, and the states of a drawing with
 * states when stepping through them is on), what a key, a tap or a swipe means, how a page is fitted to the screen and how
 * the laser pointer's trail fades. No 'obsidian' import, nothing here writes a document: a state is only ever the view's own
 * "shown" choice.
 */
import type { Page } from "../model/types";

/** A place in the presentation: a page and, for a page with states, the state shown (null: as drawn). */
export interface PresentPos {
	page: number;
	state: string | null;
}

export interface PresentSettings {
	/** "Next" steps through the states of a drawing before it turns the page. */
	presentSteps: boolean;
	/** The pen (and the mouse) is a laser pointer while presenting. */
	presentLaser: boolean;
}

export const DEFAULT_PRESENT_SETTINGS: PresentSettings = { presentSteps: true, presentLaser: true };

export function readPresentSettings(data: Record<string, unknown>): PresentSettings {
	const s = { ...DEFAULT_PRESENT_SETTINGS };
	if (typeof data.presentSteps === "boolean") s.presentSteps = data.presentSteps;
	if (typeof data.presentLaser === "boolean") s.presentLaser = data.presentLaser;
	return s;
}

type StatesOf = Pick<Page, "states">;

/** The states a page is stepped through, in order: "as drawn" (null), then each state. A page without states, or with stepping off, is one step. */
export function stepOrder(page: StatesOf | undefined, steps: boolean): Array<string | null> {
	const list = page?.states?.list ?? [];
	if (!steps || list.length === 0) return [null];
	return [null, ...list.map((s) => s.id)];
}

/** The place the presentation starts at on page `index` (clamped): the first step of that page. */
export function startPos(pages: readonly StatesOf[], index: number, steps: boolean): PresentPos {
	const page = Math.max(0, Math.min(pages.length - 1, Math.floor(Number.isFinite(index) ? index : 0)));
	return { page, state: stepOrder(pages[page], steps)[0] ?? null };
}

function stepIndex(order: ReadonlyArray<string | null>, state: string | null): number {
	const i = order.indexOf(state);
	return i < 0 ? 0 : i;
}

/** Where "next" goes: the next state of the page, else the first step of the next page; null at the very end. */
export function nextPos(pages: readonly StatesOf[], pos: PresentPos, steps: boolean): PresentPos | null {
	const order = stepOrder(pages[pos.page], steps);
	const i = stepIndex(order, pos.state);
	if (i < order.length - 1) return { page: pos.page, state: order[i + 1] ?? null };
	if (pos.page >= pages.length - 1) return null;
	return { page: pos.page + 1, state: stepOrder(pages[pos.page + 1], steps)[0] ?? null };
}

/** Where "previous" goes: the previous state of the page, else the last step of the previous page; null at the very start. */
export function prevPos(pages: readonly StatesOf[], pos: PresentPos, steps: boolean): PresentPos | null {
	const order = stepOrder(pages[pos.page], steps);
	const i = stepIndex(order, pos.state);
	if (i > 0) return { page: pos.page, state: order[i - 1] ?? null };
	if (pos.page <= 0) return null;
	const before = stepOrder(pages[pos.page - 1], steps);
	return { page: pos.page - 1, state: before[before.length - 1] ?? null };
}

/** What the counter shows: "3 / 12", and "3 / 12 · 2/4" while a drawing with states is stepped. */
export function counterText(pages: readonly StatesOf[], pos: PresentPos, steps: boolean): string {
	const order = stepOrder(pages[pos.page], steps);
	const base = `${pos.page + 1} / ${pages.length}`;
	return order.length > 1 ? `${base} · ${stepIndex(order, pos.state) + 1}/${order.length}` : base;
}

// --- input ---

export type PresentAction = "next" | "prev" | "first" | "last" | "exit" | "blank";

/** The few fields of a keyboard event the presentation reads. */
export interface PresentKey {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
}

/**
 * What a key does while presenting. Presenter remotes send arrows, PageUp / PageDown, or Enter and Period (blank screen is
 * "b" or "."). Anything with Ctrl, Alt or Meta is left to the app.
 */
export function presentKeyAction(e: PresentKey): PresentAction | null {
	if (e.ctrlKey || e.altKey || e.metaKey) return null;
	switch (e.key) {
		case "ArrowRight": case "ArrowDown": case "PageDown": case "Enter": return "next";
		case " ": case "Spacebar": return e.shiftKey ? "prev" : "next";
		case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": return "prev";
		case "Home": return "first";
		case "End": return "last";
		case "Escape": return "exit";
		case "b": case "B": case ".": return "blank";
		default: return null;
	}
}

/** Height of the top strip that only shows the controls (a tap there never turns the page). */
export const REVEAL_STRIP_PX = 56;
/** Fraction of the width, from the left, whose taps go back. */
export const BACK_ZONE = 1 / 3;

export type TapZone = "prev" | "next" | "reveal";

/** What a tap at (`x`, `y`) means on a screen `width` wide: the top strip reveals the controls, the left third goes back, the rest goes on. */
export function tapZone(x: number, y: number, width: number): TapZone {
	if (y < REVEAL_STRIP_PX) return "reveal";
	return x < width * BACK_ZONE ? "prev" : "next";
}

/** A tap moves less than this (px) and is over within this long (ms). */
export const TAP_SLOP_PX = 12;
export const TAP_MAX_MS = 450;
/** A swipe is mostly horizontal, at least this long (px) and not slower than this (ms). */
export const SWIPE_MIN_PX = 48;
export const SWIPE_MAX_MS = 900;

export type PresentGesture = "tap" | "swipe-next" | "swipe-prev" | null;

/** Tells a tap from a horizontal swipe (swipe left: next). Anything else (a slow drag, a vertical move) is nothing. */
export function classifyGesture(dx: number, dy: number, ms: number): PresentGesture {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	if (ax <= TAP_SLOP_PX && ay <= TAP_SLOP_PX) return ms <= TAP_MAX_MS ? "tap" : null;
	if (ms > SWIPE_MAX_MS || ax < SWIPE_MIN_PX || ax < ay * 1.5) return null;
	return dx < 0 ? "swipe-next" : "swipe-prev";
}

// --- geometry ---

/** Pages taller than this many times their width are shown by their top part (as in thumbnails). */
export const PRESENT_MAX_ASPECT = 1.5;

/** The page's box inside a screen, centred, as large as fits without cropping. */
export function fitPage(pageW: number, pageH: number, viewW: number, viewH: number): { x: number; y: number; width: number; height: number } {
	const aspect = pageW > 0 ? Math.min(pageH / pageW, PRESENT_MAX_ASPECT) : 1;
	const w = Math.max(1, Math.min(viewW, viewH / aspect));
	const h = w * aspect;
	return { x: (viewW - w) / 2, y: (viewH - h) / 2, width: w, height: h };
}

// --- the laser pointer ---

/** How long a trail point stays visible (ms). */
export const LASER_FADE_MS = 700;
const LASER_MAX_POINTS = 96;

export interface LaserPoint {
	x: number;
	y: number;
	t: number;
}

/** The fading trail of the laser pointer: points with their time, dropped once they are older than `fadeMs`. */
export class LaserTrail {
	private points: LaserPoint[] = [];

	constructor(private readonly fadeMs = LASER_FADE_MS) {}

	add(x: number, y: number, t: number): void {
		this.points.push({ x, y, t });
		if (this.points.length > LASER_MAX_POINTS) this.points.splice(0, this.points.length - LASER_MAX_POINTS);
	}

	/** Forgets the points that have faded out at time `now`; returns what is left. */
	alive(now: number): readonly LaserPoint[] {
		const from = now - this.fadeMs;
		let cut = 0;
		while (cut < this.points.length && (this.points[cut]?.t ?? 0) <= from) cut++;
		if (cut > 0) this.points.splice(0, cut);
		return this.points;
	}

	/** Opacity of a point made at `t`, 1 (new) down to 0. */
	alpha(t: number, now: number): number {
		return Math.max(0, Math.min(1, 1 - (now - t) / this.fadeMs));
	}

	get size(): number {
		return this.points.length;
	}

	clear(): void {
		this.points = [];
	}
}
