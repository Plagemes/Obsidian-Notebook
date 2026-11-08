// 0.25 toolfade (#399): the pure state machine behind "Toolbar fades while writing". No DOM and no 'obsidian' import: tested in Node.
//
// A "run" starts with the first pen stroke written while the bars are shown and goes on while strokes follow each other less than
// `delayMs` apart. The bars fade once a stroke has been in progress `delayMs` into the run, stay faded through the run and `delayMs` after the last stroke ends, and
// come back at once on a touch outside the canvas, a pen hover over a bar or a press on a bar. A restore ends the run: the next stroke
// starts a new one. The view only toggles ONE class when `faded()` changes and sleeps until `nextChange()`: no per-frame work.

export type ToolFadeMode = "off" | "writing";

export const TOOL_FADE_MODES: readonly ToolFadeMode[] = ["off", "writing"];
export const DEFAULT_TOOL_FADE_MODE: ToolFadeMode = "off";
/** Seconds before the bars fade (and after the last stroke before they return). */
export const TOOL_FADE_SECONDS_MIN = 1;
export const TOOL_FADE_SECONDS_MAX = 6;
export const DEFAULT_TOOL_FADE_SECONDS = 2;

export function isToolFadeMode(v: unknown): v is ToolFadeMode {
	return v === "off" || v === "writing";
}

/** A stored delay made safe: a whole number of seconds inside the range, or the default. */
export function cleanFadeSeconds(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_TOOL_FADE_SECONDS;
	return Math.min(TOOL_FADE_SECONDS_MAX, Math.max(TOOL_FADE_SECONDS_MIN, Math.round(v)));
}

export interface ToolFadeConfig {
	mode: ToolFadeMode;
	/** Milliseconds. */
	delayMs: number;
}

/** What touches count for the restore rule. Only these ever restore: a palm on the canvas does not. */
export function restoresOnPointer(pointerType: string, overBar: boolean, overCanvas: boolean, buttons: number): boolean {
	if (pointerType === "pen") return overBar && buttons === 0; // a hover near the bar, not ink being written
	return overBar || !overCanvas; // a finger or mouse on a bar, or anywhere outside the canvas
}

/**
 * Whether the first touch on a faded bar must only restore it (the click is swallowed). Pen tip taps on a bar are real taps (the
 * pen hovered first and already restored it), so only a finger or mouse press that found the bar faded is swallowed.
 */
export function swallowsFirstTouch(setting: boolean, wasFaded: boolean, pointerType: string): boolean {
	return setting && wasFaded && pointerType !== "pen";
}

export class ToolFadeMachine {
	private writing = false;
	private runStart: number | null = null;
	private lastEnd: number | null = null;
	/** Set once a stroke has been in progress for `delayMs` into the run; cleared when the run ends or the bars are restored. */
	private latched = false;
	private blocked = false;
	private mode: ToolFadeMode;
	private delayMs: number;

	constructor(cfg: ToolFadeConfig) {
		this.mode = cfg.mode;
		this.delayMs = Math.max(0, cfg.delayMs);
	}

	configure(cfg: ToolFadeConfig): void {
		this.mode = cfg.mode;
		this.delayMs = Math.max(0, cfg.delayMs);
		if (this.mode === "off") this.reset();
	}

	private reset(): void {
		this.writing = false;
		this.runStart = null;
		this.lastEnd = null;
		this.latched = false;
	}

	private alive(now: number): boolean {
		return this.writing || (this.lastEnd !== null && now - this.lastEnd < this.delayMs);
	}

	/** Moves the latch forward to `now`: a run ended by silence is dropped, a stroke that has lasted long enough fades the bars. */
	private update(now: number): void {
		if (this.runStart === null) return;
		if (!this.alive(now)) {
			this.reset();
			return;
		}
		if (!this.latched && this.writing && now - this.runStart >= this.delayMs) this.latched = true;
	}

	/** A pen stroke began. */
	strokeStart(now: number): void {
		if (this.blocked) return;
		if (this.mode === "off") return;
		this.update(now);
		if (this.runStart === null) this.runStart = now;
		this.writing = true;
		this.update(now);
	}

	/** The pen stroke ended (committed or cancelled). */
	strokeEnd(now: number): void {
		if (!this.writing) return;
		this.update(now);
		this.writing = false;
		this.lastEnd = now;
	}

	/** Bring the bars back and end the run (a touch outside the canvas, a pen over a bar, a press on a bar). */
	restore(): void {
		this.reset();
	}

	/** A selection, lasso, dialog or any modal state: the bars never fade while it lasts, and a fade in progress ends. */
	setBlocked(blocked: boolean): void {
		if (blocked === this.blocked) return;
		this.blocked = blocked;
		if (blocked) this.reset();
	}

	faded(now: number): boolean {
		if (this.mode === "off" || this.blocked) return false;
		this.update(now);
		return this.latched;
	}

	/** Milliseconds until `faded` may change by itself, or null when nothing is pending (the next stroke event recomputes it). */
	nextChange(now: number): number | null {
		if (this.mode === "off" || this.blocked) return null;
		this.update(now);
		if (this.runStart === null) return null;
		if (this.writing) return this.latched ? null : Math.max(0, this.runStart + this.delayMs - now);
		return this.lastEnd === null ? null : Math.max(0, this.lastEnd + this.delayMs - now);
	}
}
