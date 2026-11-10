import { setIcon } from "obsidian";
import { t } from "../i18n";
import { elapsedSeconds, formatElapsed } from "../timetable/live-lecture";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";

/** Events that must not reach the page or the view's shortcuts (the bar never takes pen input). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

export interface LiveBarHost {
	/** The element the bar floats in (the notebook body). */
	parent(): HTMLElement;
	/** The setting is on, the notebook can be shown and a lecture is running. */
	enabled(): boolean;
	/** When the running lecture began (ms since epoch), or null. */
	startedAt(): number | null;
	/** "New page" (the existing add-page path, after the current page). */
	newPage(): void;
	/** "Important moment" at `seconds` into the lecture: a stamped bookmark on the current page. */
	mark(seconds: number): void;
	now?(): number;
}

/**
 * Roadmap #132 (0.28 livelecture): a compact floating bar while a lecture runs. It shows the elapsed time and two quick buttons,
 * "New page" and "Important moment". It can be folded to the timer alone, fades with the toolbar while writing (class on the
 * view root, styles.css) and never takes pen input. The timer is one 1 s interval that only runs while the bar is shown and
 * the app is visible; it rewrites the text only when the text changes. Nothing here writes: the buttons call the host.
 */
export class LiveBar {
	private el: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private toggleBtn: HTMLElement | null = null;
	private shown = "";
	private folded = false;
	private timer: number | null = null;
	private stopHelp: (() => void) | null = null;
	private readonly onVisible = (): void => {
		if (document.visibilityState === "visible") this.tick();
	};

	constructor(private readonly host: LiveBarHost) {}

	get visible(): boolean {
		return this.el !== null;
	}

	/** Shows, hides or refreshes the bar to match the setting and the lecture state. */
	sync(): void {
		const start = this.host.startedAt();
		if (!this.host.enabled() || start === null) {
			this.hide();
			return;
		}
		if (!this.el) this.build();
		this.tick();
	}

	destroy(): void {
		this.hide();
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	private seconds(): number {
		const start = this.host.startedAt();
		return start === null ? 0 : elapsedSeconds(start, this.now());
	}

	private tick(): void {
		const text = formatElapsed(this.seconds());
		if (text === this.shown) return;
		this.shown = text;
		this.timeEl?.setText(text);
	}

	private build(): void {
		const el = this.host.parent().createDiv({ cls: "notebook-live-bar nb-ui", attr: { role: "group", "aria-label": t("liveBar.label") } });
		for (const type of ISOLATED) el.addEventListener(type, (e) => e.stopPropagation());
		const clock = el.createDiv({ cls: "notebook-live-clock", attr: { role: "timer" } });
		clock.createSpan({ cls: "notebook-live-dot", attr: { "aria-hidden": "true" } });
		this.timeEl = clock.createSpan({ cls: "notebook-live-time" });
		const actions = el.createDiv({ cls: "notebook-live-actions" });
		this.button(actions, "file-plus", t("liveBar.newPage"), "help.liveNewPage", () => this.host.newPage());
		this.button(actions, "star", t("liveBar.mark"), "help.liveMark", () => this.host.mark(this.seconds()));
		this.toggleBtn = this.button(el, "chevron-left", t("liveBar.fold"), "help.liveFold", () => this.fold(!this.folded), "notebook-live-fold");
		this.stopHelp = attachLongPressHelp(el, (b) => (b.dataset.help ? resolveHelp(b) : null));
		this.el = el;
		this.shown = "";
		this.applyFold();
		this.timer = window.setInterval(() => this.tick(), 1000);
		document.addEventListener("visibilitychange", this.onVisible);
	}

	private button(parent: HTMLElement, icon: string, label: string, help: string, onClick: () => void, cls = ""): HTMLElement {
		const b = parent.createEl("button", { cls: `notebook-live-btn clickable-icon ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label, "data-help": help } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	private fold(on: boolean): void {
		this.folded = on;
		this.applyFold();
	}

	private applyFold(): void {
		this.el?.toggleClass("is-folded", this.folded);
		const b = this.toggleBtn;
		if (!b) return;
		const label = t(this.folded ? "liveBar.unfold" : "liveBar.fold");
		b.setAttribute("aria-label", label);
		b.setAttribute("title", label);
		b.setAttribute("aria-expanded", String(!this.folded));
		setIcon(b, this.folded ? "chevron-right" : "chevron-left");
	}

	private hide(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		document.removeEventListener("visibilitychange", this.onVisible);
		this.stopHelp?.();
		this.stopHelp = null;
		this.el?.remove();
		this.el = null;
		this.timeEl = null;
		this.toggleBtn = null;
		this.shown = "";
	}
}
