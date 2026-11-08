import { t, type MessageKey } from "../i18n";
import { FILL_MODES, LINE_STYLES, type FillMode, type LineStyle } from "../ink/shape-restyle";

/**
 * The fill and the line style of a shape (format v22, roadmap #37): two small segmented controls (fill: none / solid / tint; line: solid / dashed /
 * dotted) and, once there is a fill, the colours to fill with. One builder for the shape tool's options and for the selection bar, so both look and
 * behave the same. Every button works; a control that does not apply to the shapes in play is not drawn.
 */

export interface ShapeStyleView {
	/** Show the fill controls (the shape tool, or a selection that has a closed shape). */
	showFill: boolean;
	/** Show the line controls. */
	showLine: boolean;
	/** The fill mode in force: null when the selected shapes differ. */
	fill: FillMode | null;
	/** The fill colour in force (`#rrggbb`, lower case); "line" when it follows the colour of the line; null when the shapes differ. */
	fillColor: string | null;
	line: LineStyle | null;
	/** The colours offered for the fill. */
	colours: readonly string[];
	editable: boolean;
}

export interface ShapeStyleHandlers {
	setFill(mode: FillMode): void;
	/** A colour (`#rrggbb`), or "line" for the colour of the line itself. */
	setFillColor(colour: string): void;
	setLine(style: LineStyle): void;
}

const FILL_LABEL: Record<FillMode, MessageKey> = { none: "shapeStyle.fill.none", solid: "shapeStyle.fill.solid", tint: "shapeStyle.fill.tint" };
const LINE_LABEL: Record<LineStyle, MessageKey> = { solid: "shapeStyle.line.solid", dashed: "shapeStyle.line.dashed", dotted: "shapeStyle.line.dotted" };

function segmented<T extends string>(
	parent: HTMLElement, label: MessageKey, values: readonly T[], names: Record<T, MessageKey>, current: T | null, editable: boolean, pick: (v: T) => void,
): HTMLElement {
	const group = parent.createDiv({ cls: "notebook-shape-group", attr: { role: "group", "aria-label": t(label) } });
	group.createSpan({ cls: "notebook-shape-label", text: t(label) });
	const seg = group.createDiv({ cls: "notebook-segmented notebook-shape-seg" });
	for (const v of values) {
		const b = seg.createEl("button", { cls: "notebook-tool clickable-icon notebook-text-tool", text: t(names[v]), attr: { type: "button", "aria-pressed": String(v === current) } });
		b.toggleClass("is-active", v === current);
		b.disabled = !editable;
		b.addEventListener("click", (e) => {
			e.preventDefault();
			pick(v);
		});
	}
	return group;
}

/** Draws the controls into `parent` (which the caller has emptied). */
export function renderShapeStyle(parent: HTMLElement, view: ShapeStyleView, on: ShapeStyleHandlers): void {
	if (view.showFill) {
		segmented(parent, "shapeStyle.fill", FILL_MODES, FILL_LABEL, view.fill, view.editable, (m) => on.setFill(m));
		if (view.fill !== "none") {
			const colours = parent.createDiv({ cls: "notebook-shape-group notebook-shape-colours", attr: { role: "group", "aria-label": t("shapeStyle.fill.color") } });
			const same = colours.createEl("button", { cls: "notebook-tool clickable-icon notebook-swatch is-line", attr: { type: "button", "aria-label": t("shapeStyle.fill.sameAsLine"), title: t("shapeStyle.fill.sameAsLine") } });
			same.toggleClass("is-active", view.fillColor === "line");
			same.disabled = !view.editable;
			same.createSpan({ cls: "notebook-swatch-dot" });
			same.addEventListener("click", (e) => {
				e.preventDefault();
				on.setFillColor("line");
			});
			for (const colour of view.colours) {
				const b = colours.createEl("button", { cls: "notebook-tool clickable-icon notebook-swatch", attr: { type: "button", "aria-label": `${t("shapeStyle.fill.color")} ${colour}` } });
				b.toggleClass("is-active", view.fillColor === colour.toLowerCase());
				b.disabled = !view.editable;
				b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": colour });
				b.addEventListener("click", (e) => {
					e.preventDefault();
					on.setFillColor(colour);
				});
			}
		}
	}
	if (view.showLine) segmented(parent, "shapeStyle.line", LINE_STYLES, LINE_LABEL, view.line, view.editable, (s) => on.setLine(s));
}
