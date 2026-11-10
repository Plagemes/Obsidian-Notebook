import { Notice } from "obsidian";
import { t } from "../i18n";
import type { Renderer } from "../ink/renderer";
import { StrikeCache } from "../ink/strikethrough";
import type { Page } from "../model/types";

/**
 * 0.29 (#96): "Hide struck words" in the view. A word with a line through it is logically deleted: it stays in the notebook and,
 * with this switched off (the default), on the page, struck through. Switched on, the view leaves the struck words and their lines
 * out (the ink is never deleted; switch it off and it is all there, and so it is in the file, in undo and in every export unless
 * an export is asked to leave it out, see model/clean-export.ts).
 *
 * The struck state is derived from geometry (ink/strikethrough.ts): nothing is stored. This class only keeps the per-page result
 * fresh, off the drawing path: the renderer reads the cache (one Map lookup per visible page per redraw), and a page is
 * re-detected a moment after the document changed, in idle slices, never while the pen is writing. While the switch is off nothing
 * is computed at all.
 */
export interface StrikeHideHost {
	/** The pages the renderer draws. */
	pages(): readonly Page[];
	renderer(): Renderer | null;
	/** The setting. */
	enabled(): boolean;
	/** Switches the setting (saved by the host). */
	setEnabled(on: boolean): void;
	/** The pen is writing or the view is busy: detection waits. */
	busy(): boolean;
	/** The toggle changed: refresh the buttons that show it. */
	changed(): void;
}

/** Quiet time after a change before the pages are looked at again. */
export const STRIKE_DELAY_MS = 300;
/** One slice of work lasts about this long; the next slice follows on a new timer tick. */
export const STRIKE_SLICE_MS = 10;

export class StrikeHide {
	private readonly cache = new StrikeCache();
	private timer: number | null = null;
	private installed = false;

	private readonly lookup = (page: Page): ReadonlySet<string> | null => this.hiddenFor(page.id);

	constructor(private readonly host: StrikeHideHost) {}

	get on(): boolean {
		return this.host.enabled();
	}

	/** The struck-through ink of a page as last detected (null: none, or not looked at yet). A cache read: safe in the draw loop. */
	hiddenFor(pageId: string): ReadonlySet<string> | null {
		if (!this.installed) return null;
		const r = this.cache.peek(pageId);
		return r && r.ink.size > 0 ? r.ink : null;
	}

	/** The setting changed (or the view opened): installs or removes the filter. */
	sync(): void {
		const renderer = this.host.renderer();
		if (this.host.enabled()) {
			this.installed = true;
			renderer?.setStruckInk(this.lookup); // the same function every time: nothing is redrawn when it is already there
			this.schedule(0);
		} else if (this.installed) {
			this.installed = false;
			this.cancel();
			this.cache.clear();
			renderer?.setStruckInk(null);
		}
	}

	/** The document changed (a stroke was added, erased, moved, undone, or another document loaded). */
	docChanged(): void {
		if (this.installed) this.schedule(STRIKE_DELAY_MS);
	}

	toggle(): void {
		const next = !this.host.enabled();
		this.host.setEnabled(next);
		this.sync();
		this.host.changed();
		new Notice(t(next ? "strike.hidden" : "strike.shown"));
	}

	destroy(): void {
		this.cancel();
		this.cache.clear();
		this.installed = false;
		this.host.renderer()?.setStruckInk(null);
	}

	private cancel(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(delay: number): void {
		this.cancel();
		this.timer = window.setTimeout(() => this.slice(), delay);
	}

	/** Looks at stale pages for about one slice, then yields; repaints once if something it found differs from what was drawn. */
	private slice(): void {
		this.timer = null;
		if (!this.installed) return;
		if (this.host.busy()) {
			this.schedule(STRIKE_DELAY_MS);
			return;
		}
		const pages = this.host.pages();
		this.cache.retain(new Set(pages.map((p) => p.id)));
		const start = performance.now();
		let changed = false;
		let pending = false;
		for (const page of pages) {
			if (this.cache.fresh(page.id, page.strokes)) continue;
			if (performance.now() - start > STRIKE_SLICE_MS) {
				pending = true;
				break;
			}
			const before = this.cache.peek(page.id)?.ink;
			const after = this.cache.get(page.id, page.strokes).ink;
			if (!sameSet(before, after)) changed = true;
		}
		if (changed) this.host.renderer()?.invalidate();
		if (pending) this.schedule(0);
	}
}

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
	if (!a) return b.size === 0;
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}
