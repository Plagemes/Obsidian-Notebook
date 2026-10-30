import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { TrailPoint } from "../ink/gestures/geometry";
import { recognise, type GestureWorld, type Recognition } from "../ink/gestures/resolve";
import { GestureTrail, PreviewClock } from "../ink/gestures/session";
import type { PenGestureSettings } from "../ink/gestures/settings";
import type { SampleBuffer } from "../ink/pointer-controller";

const SVG_NS = "http://www.w3.org/2000/svg";
/** A stroke shorter than this (CSS px of path) that matches nothing is a tap, not a failed gesture. */
const NOTHING_TO_SAY_PX = 40;
const FLASH_MS = 900;

export interface PenGestureHost {
	/** The drawing area (the trail is drawn over it) and the container the mode badge goes in. */
	stage: HTMLElement;
	body: HTMLElement;
	settings(): PenGestureSettings;
	world(): GestureWorld;
	/** Carries out a recognised gesture; the trail is what the pen drew (CSS px relative to the stage). */
	run(r: Recognition, trail: readonly TrailPoint[]): void;
	openCheatSheet(): void;
	/** The mode was switched (for the toggle in the toolbar menu). */
	modeChanged(on: boolean): void;
}

/** The label of a recognised gesture, the text shown beside the nib. Pure given `t`. */
export function gestureLabel(r: Recognition): string | null {
	switch (r.type) {
		case "builtin":
			return r.id === "move" ? t("gesture.move", { n: String((r.target ?? 0) + 1) }) : t(`gesture.${r.id}`);
		case "custom":
			return r.gesture.name || t("gesture.customUnnamed");
		case "cancel":
			return t("gesture.cancelled");
		default:
			return null;
	}
}

/**
 * Gesture mode and the gesture in progress (roadmap 139). While a gesture is drawn nothing is written: the stroke is a
 * thin trail on an overlay, and the command it will run (if the shape is recognised) is named beside the nib before the pen
 * lifts. Lifting runs it; going back along the stroke to its start cancels. Gesture ink is never saved by this class.
 */
export class PenGestureLayer {
	/** Gesture mode: every pen stroke is a gesture until it is switched off. Not saved. */
	mode = false;
	private running = false;
	private readonly trail = new GestureTrail();
	private readonly clock = new PreviewClock();
	private current: Recognition = { type: "none" };
	private readonly svg: SVGSVGElement;
	private readonly line: SVGPolylineElement;
	private readonly label: HTMLElement;
	private readonly badge: HTMLElement;
	private frame: number | null = null;
	private flashTimer: number | null = null;

	constructor(private readonly host: PenGestureHost) {
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.setAttribute("class", "notebook-gesture-overlay notebook-hidden");
		this.svg.setAttribute("aria-hidden", "true");
		this.line = document.createElementNS(SVG_NS, "polyline");
		this.line.setAttribute("class", "notebook-gesture-trail");
		this.svg.appendChild(this.line);
		host.stage.appendChild(this.svg);
		this.label = host.stage.createDiv({ cls: "notebook-gesture-label notebook-hidden", attr: { role: "status" } });

		this.badge = host.body.createDiv({ cls: "notebook-gesture-badge notebook-hidden", attr: { role: "status" } });
		this.badge.createSpan({ cls: "notebook-gesture-badge-text", text: t("gesture.mode") });
		const help = this.badge.createEl("button", { cls: "notebook-gesture-badge-button clickable-icon", attr: { type: "button", "aria-label": t("gesture.cheatSheet") } });
		setIcon(help, "help-circle");
		help.addEventListener("click", (e) => {
			e.preventDefault();
			host.openCheatSheet();
		});
		const off = this.badge.createEl("button", { cls: "notebook-gesture-badge-button clickable-icon", attr: { type: "button", "aria-label": t("gesture.exit") } });
		setIcon(off, "x");
		off.addEventListener("click", (e) => {
			e.preventDefault();
			this.setMode(false);
		});
	}

	/** A gesture stroke is in progress. */
	get active(): boolean {
		return this.running;
	}

	setMode(on: boolean): void {
		if (this.mode === on) return;
		this.mode = on;
		this.badge.toggleClass("notebook-hidden", !on);
		this.host.stage.toggleClass("is-gesture-mode", on);
		this.host.modeChanged(on);
	}

	toggleMode(): void {
		this.setMode(!this.mode);
	}

	/** The pen touched down as a gesture. (x, y) are CSS px relative to the stage. */
	start(x: number, y: number, t0: number, pressure?: number): void {
		this.clearFlash();
		this.trail.reset();
		this.clock.reset();
		this.current = { type: "none" };
		this.running = true;
		this.trail.add(x, y, t0, pressure);
		this.label.addClass("notebook-hidden");
		this.svg.removeClass("notebook-hidden");
		this.schedule();
	}

	move(samples: SampleBuffer): void {
		if (!this.running) return;
		for (let i = 0; i < samples.count; i++) this.trail.add(samples.x[i]!, samples.y[i]!, samples.t[i]!, samples.p[i]);
		this.preview(performance.now(), false);
		this.schedule();
	}

	/** The pen lifted (or the contact was cancelled). Carries out the gesture that was recognised, if any. */
	end(cancelled: boolean): void {
		if (!this.running) return;
		this.running = false;
		const points = this.trail.points.slice();
		const r = cancelled ? ({ type: "none" } as Recognition) : this.recognise(points);
		this.hideTrail();
		if (r.type === "builtin" || r.type === "custom") {
			try {
				this.host.run(r, points);
			} catch (e) {
				console.error("[notebook] pen gesture failed", e);
			}
		} else if (!cancelled) {
			const long = this.trail.points.length > 1 && pathPx(points) >= NOTHING_TO_SAY_PX;
			if (r.type === "cancel") this.flash(t("gesture.cancelled"));
			else if (long) this.flash(t("gesture.none"));
		}
		this.trail.reset();
	}

	destroy(): void {
		this.clearFlash();
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.svg.remove();
		this.label.remove();
		this.badge.remove();
		this.host.stage.removeClass("is-gesture-mode");
	}

	private recognise(points: readonly TrailPoint[]): Recognition {
		const s = this.host.settings();
		return recognise(points, { world: this.host.world(), disabled: new Set(s.penGesturesOff), custom: s.penGesturesCustom });
	}

	private preview(now: number, force: boolean): void {
		if (!this.clock.due(now, this.trail.revision, force)) return;
		const next = this.recognise(this.trail.points);
		const changed = describe(next) !== describe(this.current);
		this.current = next;
		if (changed && (next.type === "builtin" || next.type === "custom")) vibrate();
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.paint();
		});
	}

	private paint(): void {
		if (!this.running) return;
		this.line.setAttribute("points", this.trail.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
		const text = gestureLabel(this.current);
		const tip = this.trail.tip;
		this.label.toggleClass("notebook-hidden", !text || !tip);
		this.label.toggleClass("is-cancel", this.current.type === "cancel");
		if (!text || !tip) return;
		this.label.setText(text);
		this.placeLabel(tip.x, tip.y);
	}

	/** Beside the nib, up and to the right of it, kept inside the stage. */
	private placeLabel(x: number, y: number): void {
		const w = this.host.stage.clientWidth, h = this.host.stage.clientHeight;
		const lw = this.label.offsetWidth || 120;
		const left = Math.max(4, Math.min(w - lw - 4, x + 22));
		const top = Math.max(4, Math.min(h - 40, y - 46));
		this.label.setCssProps({ "--notebook-gesture-x": `${left}px`, "--notebook-gesture-y": `${top}px` });
	}

	private hideTrail(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.svg.addClass("notebook-hidden");
		this.line.setAttribute("points", "");
		this.label.addClass("notebook-hidden");
	}

	/** A short message beside the last position of the pen (not recognised, cancelled). */
	private flash(text: string): void {
		const tip = this.trail.tip;
		this.clearFlash();
		this.label.setText(text);
		this.label.removeClass("notebook-hidden");
		this.label.toggleClass("is-cancel", true);
		if (tip) this.placeLabel(tip.x, tip.y);
		this.flashTimer = window.setTimeout(() => {
			this.flashTimer = null;
			this.label.addClass("notebook-hidden");
		}, FLASH_MS);
	}

	private clearFlash(): void {
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		this.flashTimer = null;
		this.label.addClass("notebook-hidden");
	}
}

function pathPx(points: readonly TrailPoint[]): number {
	let l = 0;
	for (let i = 1; i < points.length; i++) l += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
	return l;
}

function describe(r: Recognition): string {
	return r.type === "builtin" ? `b:${r.id}:${r.target ?? ""}` : r.type === "custom" ? `c:${r.gesture.id}` : r.type;
}

function vibrate(): void {
	try {
		navigator.vibrate?.(8);
	} catch {
		// No haptics here.
	}
}
