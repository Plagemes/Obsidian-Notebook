import { setIcon } from "obsidian";
import { t } from "../i18n";
import { strokeSvgPath } from "../ink/stroke-shape";
import { RENDER_INK, type Point } from "../model/types";
import { TAPER_MAX, TAPER_MIN, TAPER_STEP, normaliseTaper, taperFromPercent, taperPercent } from "../model/taper";

/**
 * The taper rows (format v25, roadmap #351): how much the line of a pen thins towards the start and the end of a stroke. A header with a reset
 * button (it puts both ends back to no taper, and carries the long-press explanation), the name and a small picture of a stroke drawn with the
 * values by the very engine that draws the page; then one slider per end with its value in percent. Dragging only previews the value (and the
 * picture); it is applied when the finger lifts (`change`), so a drag is one change. The row belongs to the pen options, to the line pens.
 */

export interface TaperRow {
	readonly el: HTMLElement;
	readonly startSlider: HTMLInputElement;
	readonly endSlider: HTMLInputElement;
	/** Shows the values (0 = none) and whether they can be changed; `width` (pt) is the width of the pen, for the picture. */
	set(start: number, end: number, editable: boolean, width: number, tool: "pen" | "fountain" | "brush"): void;
}

export interface TaperHandlers {
	/** The finger lifted on a value of one end (a fraction, 0 for none), or the reset button was pressed (both 0). */
	commit(patch: { penTaperStart?: number; penTaperEnd?: number }): void;
}

const PERCENT_MIN = Math.round(TAPER_MIN * 100);
const PERCENT_MAX = Math.round(TAPER_MAX * 100);
const PERCENT_STEP = Math.round(TAPER_STEP * 100);

/** A gentle S curve of a few dozen points, 120 x 28 pt, drawn with pressure that swells and eases: the sample every picture of the taper shows. */
const SAMPLE: readonly Point[] = (() => {
	const out: Point[] = [];
	const n = 40;
	for (let i = 0; i <= n; i++) {
		const t0 = i / n;
		out.push([Math.round((6 + t0 * 108) * 100) / 100, Math.round((14 + Math.sin(t0 * Math.PI * 2) * 7) * 100) / 100, 0.6]);
	}
	return out;
})();

/** Width (pt) of the sample line: the pen's own, kept in a range the little picture can show. */
function sampleWidth(width: number): number {
	return Math.min(4.5, Math.max(1.6, width));
}

export function createTaperRow(parent: HTMLElement, on: TaperHandlers, cls = ""): TaperRow {
	const el = parent.createDiv({ cls: `notebook-taper-row${cls ? ` ${cls}` : ""}`, attr: { role: "group", "aria-label": t("taper.title") } });
	const head = el.createDiv({ cls: "notebook-taper-head" });
	const reset = head.createEl("button", { cls: "notebook-tool clickable-icon notebook-taper-reset", attr: { type: "button", "aria-label": t("taper.reset"), title: t("taper.reset") } });
	reset.dataset.help = "help.taper";
	setIcon(reset, "pen-tool");
	head.createSpan({ cls: "notebook-taper-label", text: t("taper.title") });
	const preview = head.createSpan({ cls: "notebook-taper-preview", attr: { "aria-hidden": "true" } });
	const svg = preview.createSvg("svg", { attr: { viewBox: "0 0 120 28", preserveAspectRatio: "xMidYMid meet", focusable: "false" } });
	const path = svg.createSvg("path", { attr: { d: "" } });

	const makeEnd = (cls2: string, label: string): { slider: HTMLInputElement; value: HTMLElement } => {
		const line = el.createDiv({ cls: `notebook-taper-end ${cls2}` });
		line.createSpan({ cls: "notebook-taper-end-label", text: label });
		const slider = line.createEl("input", {
			cls: "notebook-taper-slider",
			attr: { type: "range", min: "0", max: String(PERCENT_MAX), step: String(PERCENT_STEP), "aria-label": label },
		});
		const value = line.createSpan({ cls: "notebook-taper-value", attr: { "aria-hidden": "true" } });
		return { slider, value };
	};
	const start = makeEnd("is-start", t("taper.start"));
	const end = makeEnd("is-end", t("taper.end"));

	let width = 2;
	let tool: "pen" | "fountain" | "brush" = "pen";
	const percentOf = (slider: HTMLInputElement): number => {
		const p = Math.round(Number(slider.value));
		return p < PERCENT_MIN ? 0 : p;
	};
	const draw = (): void => {
		const s = taperFromPercent(percentOf(start.slider));
		const e = taperFromPercent(percentOf(end.slider));
		// The picture is the engine's own outline of the sample at the pen's width with the values shown now.
		path.setAttribute("d", strokeSvgPath({
			points: SAMPLE, width: sampleWidth(width), tool, render: RENDER_INK,
			...(s > 0 ? { taperStart: s } : {}), ...(e > 0 ? { taperEnd: e } : {}),
		}));
	};
	const show = (which: "start" | "end"): void => {
		const part = which === "start" ? start : end;
		const percent = percentOf(part.slider);
		part.value.setText(percent === 0 ? t("taper.off") : `${percent}%`);
		part.slider.setAttribute("aria-valuetext", percent === 0 ? t("taper.off") : t(which === "start" ? "taper.value.start" : "taper.value.end", { percent: String(percent) }));
		draw();
	};
	start.slider.addEventListener("input", () => show("start"));
	end.slider.addEventListener("input", () => show("end"));
	start.slider.addEventListener("change", () => on.commit({ penTaperStart: taperFromPercent(Number(start.slider.value)) }));
	end.slider.addEventListener("change", () => on.commit({ penTaperEnd: taperFromPercent(Number(end.slider.value)) }));
	reset.addEventListener("click", (e) => {
		e.preventDefault();
		on.commit({ penTaperStart: 0, penTaperEnd: 0 });
	});

	return {
		el,
		startSlider: start.slider,
		endSlider: end.slider,
		set(s, e, editable, w, kind) {
			width = w;
			tool = kind;
			start.slider.value = String(taperPercent(normaliseTaper(s)));
			end.slider.value = String(taperPercent(normaliseTaper(e)));
			start.slider.disabled = !editable;
			end.slider.disabled = !editable;
			reset.disabled = !editable;
			show("start");
			show("end");
		},
	};
}
