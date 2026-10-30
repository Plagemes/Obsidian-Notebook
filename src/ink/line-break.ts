// wave 0.10 (353): automatic line break. Pure geometry (no 'obsidian', no DOM): where the view should scroll to after the
// pen lifts near the right margin of the visible area, so the start of the next line is under the hand. View-only: nothing
// is stored and no stroke coordinate changes.
import type { PaperKind } from "../model/types";
import { AUTO_SCROLL_TARGET, easeOutCubic } from "./auto-scroll";
import type { Size, Viewport } from "./viewport";
import { PAGE_MARGIN } from "./viewport";

/** Paper that has lines to follow: the break only applies on these. */
export const LINE_BREAK_PAPERS: readonly PaperKind[] = ["ruled", "grid"];
/** The right part of the visible area (fraction of its width) in which a stroke end counts as "at the right margin". */
export const LINE_BREAK_BAND = 0.12;
/** Where the left edge of the page lands on screen: this far from the left edge of the view (CSS px), at least. */
export const LINE_BREAK_LEFT_INSET = PAGE_MARGIN + 8;
/** Wait this long after the pen lifted (ms): longer than a pause between two words, so a word that ends near the margin is not followed too early. */
export const LINE_BREAK_DELAY_MS = 450;
/** Duration of the animated scroll (ms). */
export const LINE_BREAK_MS = 280;
/** A move smaller than this (CSS px, both axes) is not worth doing. */
const MIN_MOVE_PX = 24;

export function lineBreakPaper(kind: PaperKind): boolean {
	return LINE_BREAK_PAPERS.includes(kind);
}

export interface LineBreakInput {
	/** Where the stroke ended, page coordinates (pt). */
	tipX: number;
	tipY: number;
	/** The page in view, document-space x / y of its box (pt), its size and paper. */
	box: { x: number; y: number; width: number; height: number };
	paper: { kind: PaperKind; spacing: number };
	viewport: Viewport;
	view: Size;
}

/**
 * The viewport that puts the start of the next ruled line (page x = 0, the next multiple of the line height below the
 * stroke's end) under the hand: at the left edge of the view, one line height below where the pen was lifted. When that
 * would leave the line too close to the bottom edge, it is also moved up like the auto-scroll does. Returns null when
 * there is nothing to do: not ruled or grid paper, the stroke did not end in the right band, the next line is off the
 * page (the next-page feature owns that) or the move is too small to notice (the whole page already fits).
 * The view clamps the result to its pan limits (page mode keeps to the page in view).
 */
export function lineBreakTarget(input: LineBreakInput): Viewport | null {
	const { tipX, tipY, box, paper, viewport: v, view } = input;
	if (!lineBreakPaper(paper.kind) || !(paper.spacing > 0) || !(view.width > 0) || !(view.height > 0)) return null;
	if (![tipX, tipY, v.scale, v.offsetX, v.offsetY].every(Number.isFinite) || !(v.scale > 0)) return null;
	const screenX = (box.x + tipX) * v.scale + v.offsetX;
	const screenY = (box.y + tipY) * v.scale + v.offsetY;
	if (screenX < view.width * (1 - (LINE_BREAK_BAND)) || screenX > view.width * 1.5) return null;
	if (screenY < 0 || screenY > view.height) return null;
	// The line the pen was on, and the next one (the writing baseline sits on a ruled line: the next line is the one below).
	const nextLine = (Math.floor(tipY / paper.spacing) + 1) * paper.spacing;
	if (nextLine + paper.spacing > box.height) return null;
	// A page that fits the width has nothing to scroll sideways.
	if (box.width * v.scale + 2 * PAGE_MARGIN <= view.width) return null;
	// Horizontal: the page's left edge goes to the inset, never past what is needed to show it.
	const offsetX = LINE_BREAK_LEFT_INSET - box.x * v.scale;
	// Vertical: the next line one line height below the pen, unless that is in the bottom band.
	const nextScreenY = (box.y + nextLine) * v.scale + v.offsetY;
	let offsetY = v.offsetY;
	if (nextScreenY > view.height * 0.82) offsetY -= nextScreenY - view.height * AUTO_SCROLL_TARGET;
	if (Math.abs(offsetX - v.offsetX) < MIN_MOVE_PX && Math.abs(offsetY - v.offsetY) < MIN_MOVE_PX) return null;
	return { scale: v.scale, offsetX, offsetY };
}

/** Timers and animation frames, injected so the controller is testable. */
export interface LineBreakClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(handle: number): void;
	requestFrame(fn: () => void): number;
	cancelFrame(handle: number): void;
}

export interface LineBreakHost {
	/** The setting is on and the notebook can be written to. */
	enabled(): boolean;
	/** The viewport on screen now. */
	viewport(): Viewport;
	/** Applies a viewport (the view clamps it). */
	setViewport(v: Viewport): void;
	/** A pen or finger contact is in progress: never move then. */
	busy(): boolean;
}

/** Waits after the pen lifts, then eases the viewport to the target. `cancel` when anything touches the screen. */
export class LineBreaker {
	private timer: number | null = null;
	private frame: number | null = null;

	constructor(
		private readonly host: LineBreakHost,
		private readonly clock: LineBreakClock,
		private readonly delayMs = LINE_BREAK_DELAY_MS,
		private readonly durationMs = LINE_BREAK_MS,
	) {}

	get pending(): boolean {
		return this.timer !== null || this.frame !== null;
	}

	/** A stroke ended; `target` is `lineBreakTarget` for it (null: do nothing). Returns whether a break was scheduled. */
	strokeEnded(target: Viewport | null): boolean {
		this.cancel();
		if (!target || !this.host.enabled()) return false;
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			this.start(target);
		}, this.delayMs);
		return true;
	}

	cancel(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		if (this.frame !== null) this.clock.cancelFrame(this.frame);
		this.timer = null;
		this.frame = null;
	}

	private start(target: Viewport): void {
		if (!this.host.enabled() || this.host.busy()) return;
		const from = this.host.viewport();
		const t0 = this.clock.now();
		const step = () => {
			this.frame = null;
			if (!this.host.enabled() || this.host.busy()) return;
			const k = this.durationMs <= 0 ? 1 : Math.min(1, (this.clock.now() - t0) / this.durationMs);
			const e = easeOutCubic(k);
			this.host.setViewport({
				scale: from.scale,
				offsetX: from.offsetX + (target.offsetX - from.offsetX) * e,
				offsetY: from.offsetY + (target.offsetY - from.offsetY) * e,
			});
			if (k < 1) this.frame = this.clock.requestFrame(step);
		};
		this.frame = this.clock.requestFrame(step);
	}
}
