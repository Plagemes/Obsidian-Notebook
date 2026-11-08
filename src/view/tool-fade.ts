// 0.25 toolfade (#399): the DOM side of "Toolbar fades while writing" (state machine: ui/tool-fade.ts).
// ONE class (`is-tools-faded`) on the view root is toggled when the machine says so; styles.css turns it into an opacity transition.
// Nothing here runs per frame: stroke start/end events from the view, one timer to the next change, and a few listeners on the root.
import { restoresOnPointer, swallowsFirstTouch, ToolFadeMachine, type ToolFadeMode } from "../ui/tool-fade";

export const FADED_CLASS = "is-tools-faded";
/** The bars that fade: the toolbar, the contextual bar and the floating pills (styles.css lists the same ones). */
export const FADE_BAR_SELECTOR = [
	".notebook-toolbar", ".notebook-context-bar", ".notebook-slide-back", ".notebook-symbol-strip", ".notebook-welcome-back",
	".notebook-page-refs", ".notebook-lecture-header-offer",
].join(", ");
/** A swallowed first touch cannot swallow a click that comes later than this, ms. */
const SWALLOW_MS = 800;

export interface ToolFadeHost {
	/** The view root (`.notebook-view`). */
	root: HTMLElement;
	/** The page area the pen writes on: touches inside it do not bring the bars back. */
	stage: HTMLElement;
	settings(): { toolFade: ToolFadeMode; toolFadeSeconds: number; toolFadeFirstTouch: boolean };
	/** A selection, a lasso or a dialog is open: the bars never fade then. */
	blocked(): boolean;
}

export class ToolFade {
	private readonly machine: ToolFadeMachine;
	private shown = false;
	private timer = 0;
	private swallowUntil = 0;
	private readonly stops: Array<() => void> = [];

	constructor(private readonly host: ToolFadeHost) {
		const s = host.settings();
		this.machine = new ToolFadeMachine({ mode: s.toolFade, delayMs: s.toolFadeSeconds * 1000 });
		const root = host.root;
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
			root.addEventListener(type, fn, true);
			this.stops.push(() => root.removeEventListener(type, fn, true));
		};
		on("pointerdown", (e) => this.onDown(e));
		on("pointermove", (e) => this.onMove(e));
		on("click", (e) => this.onClick(e));
		on("focusin", (e) => {
			if (this.shown && this.barOf(e.target)) this.restore();
		});
	}

	settingsChanged(): void {
		const s = this.host.settings();
		this.machine.configure({ mode: s.toolFade, delayMs: s.toolFadeSeconds * 1000 });
		this.sync();
	}

	/** A pen ink stroke began. */
	strokeStart(): void {
		this.machine.setBlocked(this.host.blocked());
		this.machine.strokeStart(performance.now());
		this.sync();
	}

	/** A contact ended (any kind; the machine ignores it when no pen stroke was running). */
	strokeEnd(): void {
		this.machine.setBlocked(this.host.blocked());
		this.machine.strokeEnd(performance.now());
		this.sync();
	}

	destroy(): void {
		window.clearTimeout(this.timer);
		for (const stop of this.stops.splice(0)) stop();
		this.host.root.classList.remove(FADED_CLASS);
		this.shown = false;
	}

	isFaded(): boolean {
		return this.shown;
	}

	private restore(): void {
		this.machine.restore();
		this.sync();
	}

	/** Applies the machine's answer to the class and re-arms the one timer. */
	private sync(): void {
		window.clearTimeout(this.timer);
		const now = performance.now();
		this.machine.setBlocked(this.host.blocked());
		const faded = this.machine.faded(now);
		if (faded !== this.shown) {
			this.shown = faded;
			this.host.root.classList.toggle(FADED_CLASS, faded);
		}
		const next = this.machine.nextChange(now);
		if (next !== null) this.timer = window.setTimeout(() => this.sync(), next + 4);
	}

	private barOf(target: EventTarget | null): Element | null {
		return target instanceof Element ? target.closest(FADE_BAR_SELECTOR) : null;
	}

	private onDown(e: PointerEvent): void {
		if (!this.shown) {
			this.swallowUntil = 0; // a new gesture on a shown bar is never swallowed
			return;
		}
		const bar = this.barOf(e.target);
		const overCanvas = !bar && e.target instanceof Node && this.host.stage.contains(e.target);
		if (!restoresOnPointer(e.pointerType, !!bar, overCanvas, e.buttons)) return;
		// Pen ink on the canvas never reaches here; a pen tip on a bar is a real tap (the hover already restored the bars).
		if (bar && swallowsFirstTouch(this.host.settings().toolFadeFirstTouch, true, e.pointerType)) this.swallowUntil = performance.now() + SWALLOW_MS;
		this.restore();
	}

	private onMove(e: PointerEvent): void {
		if (!this.shown || e.pointerType !== "pen") return;
		if (restoresOnPointer("pen", !!this.barOf(e.target), false, e.buttons)) this.restore();
	}

	/** The click that follows the first touch on a faded bar only brought it back. */
	private onClick(e: MouseEvent): void {
		if (this.swallowUntil === 0) return;
		const live = performance.now() < this.swallowUntil;
		this.swallowUntil = 0;
		if (!live || !this.barOf(e.target)) return;
		e.preventDefault();
		e.stopImmediatePropagation();
	}
}
