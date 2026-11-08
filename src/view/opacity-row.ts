import { setIcon } from "obsidian";
import { t } from "../i18n";
import { OPACITY_DEFAULT, OPACITY_MAX, OPACITY_MIN, OPACITY_STEP, opacityFromPercent, opacityPercent } from "../model/opacity";

/**
 * The opacity slider (format v24, roadmap #358): one small row for the pen options (new strokes of the pen, the highlighter, the shapes and the
 * area highlighter) and for the selection bar (the ink, pictures and areas selected), so both look and behave the same. A reset button at the
 * left (it puts the opacity back to 100 %, and carries the long-press explanation), the slider, the value in percent.
 * Dragging only previews the value; it is applied when the finger lifts (`change`), so a drag is ONE change and ONE undo step.
 */

export interface OpacityRow {
	readonly el: HTMLElement;
	readonly slider: HTMLInputElement;
	/** Shows `value` (0.05 to 1; null: the selection differs, nothing is claimed) and whether it can be changed. */
	set(value: number | null, editable: boolean): void;
}

export interface OpacityHandlers {
	/** The finger lifted on a value (a fraction 0.05 to 1), or the reset button was pressed (1). */
	commit(value: number): void;
}

const PERCENT_MIN = Math.round(OPACITY_MIN * 100);
const PERCENT_MAX = Math.round(OPACITY_MAX * 100);
const PERCENT_STEP = Math.round(OPACITY_STEP * 100);

/** Builds the row inside `parent` and returns its handle. `cls` is added to the row (the surface's own styling hook). */
export function createOpacityRow(parent: HTMLElement, on: OpacityHandlers, cls = ""): OpacityRow {
	const el = parent.createDiv({ cls: `notebook-opacity-row${cls ? ` ${cls}` : ""}`, attr: { role: "group", "aria-label": t("opacity.title") } });
	const reset = el.createEl("button", { cls: "notebook-tool clickable-icon notebook-opacity-reset", attr: { type: "button", "aria-label": t("opacity.reset"), title: t("opacity.reset") } });
	reset.dataset.help = "help.opacity";
	setIcon(reset, "droplet");
	el.createSpan({ cls: "notebook-opacity-label", text: t("opacity.title") });
	const slider = el.createEl("input", {
		cls: "notebook-opacity-slider",
		attr: { type: "range", min: String(PERCENT_MIN), max: String(PERCENT_MAX), step: String(PERCENT_STEP), "aria-label": t("opacity.title") },
	});
	const value = el.createSpan({ cls: "notebook-opacity-value", attr: { "aria-hidden": "true" } });

	const show = (percent: number | null): void => {
		value.setText(percent === null ? "–" : `${percent}%`);
		slider.setAttribute("aria-valuetext", percent === null ? t("opacity.mixed") : t("opacity.value", { percent: String(percent) }));
	};
	slider.addEventListener("input", () => show(Math.round(Number(slider.value))));
	slider.addEventListener("change", () => on.commit(opacityFromPercent(Number(slider.value))));
	reset.addEventListener("click", (e) => {
		e.preventDefault();
		on.commit(OPACITY_DEFAULT);
	});

	return {
		el,
		slider,
		set(v, editable) {
			const percent = v === null ? null : opacityPercent(v);
			slider.value = String(percent ?? PERCENT_MAX);
			slider.disabled = !editable;
			reset.disabled = !editable;
			show(percent);
		},
	};
}
