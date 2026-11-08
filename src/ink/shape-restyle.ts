import { UpdateItems, type PageItem } from "../model/groups";
import { Batch, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import type { Page, Point, ShapeDash, Stroke } from "../model/types";
import { isShapeTool } from "../model/types";
import { isClosedShape } from "./shape-style";

/**
 * Restyle the fill and the line of the selected shapes (format v22, roadmap #37), pure: ONE undo step through `UpdateItems`
 * (it finds the strokes by id, implements `remap`, and History refuses it on a locked page). Only strokes of the shape tool have a fill or a
 * line style, so freehand ink in the selection is left alone; only a CLOSED shape can be filled.
 */

export type FillMode = "none" | "solid" | "tint";
export type LineStyle = "solid" | ShapeDash;

export const FILL_MODES: readonly FillMode[] = ["none", "solid", "tint"];
export const LINE_STYLES: readonly LineStyle[] = ["solid", "dashed", "dotted"];

export interface ShapeStyleRequest {
	/** The fill: none, the solid colour, or a translucent tint. Left alone when absent (a colour alone keeps the mode). */
	fill?: FillMode;
	/** `#rrggbb`: the colour of the fill; "line": the colour of the line of each shape. Absent: the shape keeps its fill colour (the line colour when it has none yet). */
	fillColor?: string;
	line?: LineStyle;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** What can be changed in a selection. */
export interface ShapeAbilities {
	/** At least one selected stroke is a closed shape. */
	fill: boolean;
	/** At least one selected stroke is a shape (line, arrow or closed). */
	line: boolean;
}

export function shapeAbilities(strokes: readonly Stroke[]): ShapeAbilities {
	let fill = false;
	let line = false;
	for (const s of strokes) {
		if (!isShapeTool(s.tool)) continue;
		line = true;
		if (isClosedShape(s.points)) fill = true;
	}
	return { fill, line };
}

/** The mode a shape is in. */
export function fillModeOf(stroke: Pick<Stroke, "fill" | "fillTint">): FillMode {
	return stroke.fill === undefined ? "none" : stroke.fillTint === true ? "tint" : "solid";
}

export function lineStyleOf(stroke: Pick<Stroke, "dash">): LineStyle {
	return stroke.dash ?? "solid";
}

/** What the shapes of a selection share (for the buttons to show as active): null when they differ. */
export function commonShapeStyle(strokes: readonly Stroke[]): { fill: FillMode | null; fillColor: string | null; line: LineStyle | null } {
	const fills = new Set<FillMode>();
	const colours = new Set<string>();
	const lines = new Set<LineStyle>();
	for (const s of strokes) {
		if (!isShapeTool(s.tool)) continue;
		lines.add(lineStyleOf(s));
		if (!isClosedShape(s.points)) continue;
		fills.add(fillModeOf(s));
		if (s.fill !== undefined) colours.add(s.fill.toLowerCase());
	}
	return {
		fill: fills.size === 1 ? [...fills][0]! : null,
		fillColor: colours.size === 1 ? [...colours][0]! : null,
		line: lines.size === 1 ? [...lines][0]! : null,
	};
}

const endsMeet = (pts: readonly Point[]): boolean => pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1];

/** `pts` with the last point moved onto the first (its pressure kept): the outline closes exactly. */
function joinEnds(pts: readonly Point[]): Point[] {
	const first = pts[0]!;
	const out = pts.slice();
	out[out.length - 1] = [first[0], first[1], pts[pts.length - 1]![2]];
	return out;
}

/** A copy of `stroke` with the requested fill and line style (same id; the points too, except that a filled outline is closed exactly); `stroke` itself when nothing changes. */
export function styleShape(stroke: Stroke, req: ShapeStyleRequest): Stroke {
	if (!isShapeTool(stroke.tool)) return stroke;
	let { fill, fillTint, dash } = stroke;
	if (req.line !== undefined) dash = req.line === "solid" ? undefined : req.line;
	if ((req.fill !== undefined || req.fillColor !== undefined) && isClosedShape(stroke.points)) {
		const mode = req.fill ?? (stroke.fill === undefined ? "tint" : stroke.fillTint === true ? "tint" : "solid");
		const colour = req.fillColor === "line" ? stroke.color : req.fillColor !== undefined && HEX.test(req.fillColor) ? req.fillColor.toLowerCase() : stroke.fill ?? stroke.color;
		if (mode === "none") {
			fill = undefined;
			fillTint = undefined;
		} else {
			fill = colour;
			fillTint = mode === "tint" ? true : undefined;
		}
	}
	// A fill needs an outline that really closes: ends that are only within the tolerance are joined, so scaling the shape later keeps the fill visible.
	const points = fill !== undefined && isClosedShape(stroke.points) && !endsMeet(stroke.points) ? joinEnds(stroke.points) : stroke.points;
	if (fill === stroke.fill && fillTint === stroke.fillTint && dash === stroke.dash && points === stroke.points) return stroke;
	const { fill: _f, fillTint: _t, dash: _d, ...rest } = stroke;
	void _f;
	void _t;
	void _d;
	const next: Stroke = { ...rest, points };
	if (fill !== undefined) next.fill = fill;
	if (fillTint !== undefined) next.fillTint = fillTint;
	if (dash !== undefined) next.dash = dash;
	return freezeStroke(next);
}

export interface ShapeStylePlan {
	command: Command;
	/** The selection after the change: every stroke given, replaced by its restyled copy where it changed. */
	strokes: Stroke[];
}

/** The command that restyles the shapes among `strokes` of `page`; null when nothing would change. Strokes no longer on the page are skipped. */
export function planShapeStyle(page: Page, strokes: readonly Stroke[], req: ShapeStyleRequest): ShapeStylePlan | null {
	const onPage = new Set(page.strokes.map((s) => s.id));
	const next = new Map<string, Stroke>();
	const before = new Map<string, Stroke>();
	const after = strokes.map((s) => {
		if (!onPage.has(s.id)) return s;
		const styled = styleShape(s, req);
		if (styled !== s) {
			next.set(s.id, styled);
			before.set(s.id, s);
		}
		return styled;
	});
	if (next.size === 0) return null;
	// A pure function of the CURRENT item: the planned copy when the stroke is still the planned one (so the selection keeps pointing at the object
	// in the page), otherwise the item as it is now, restyled (a non-history upkeep replaced it since: its change is kept, never reverted).
	const change = (item: PageItem): PageItem => {
		const planned = next.get(item.id);
		if (!planned || "type" in item) return item;
		return item === before.get(item.id) ? planned : styleShape(item, req);
	};
	const command = new UpdateItems(page.id, new Set(next.keys()), change, "Shape style");
	return { command, strokes: after };
}

/** One undo step for several pages' plans. */
export function batchShapeStyle(commands: readonly Command[]): Command {
	return commands.length === 1 ? commands[0]! : new Batch("Shape style", [...commands]);
}
