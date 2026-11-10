import { createId, quantizePoint } from "../model/document";
import { UpdateItems } from "../model/groups";
import { AddStroke, Batch, removeStrokes, type Command } from "../model/history";
import type { Page, Stroke } from "../model/types";
import { movesUnderRedaction, type RedactGuard } from "./redact";
import { buildTable, inkToShift, tableBox, type DetectedTable, type GridEdit, type InkBox, type TableGrid, type TableStyle } from "./table";

/**
 * The undoable changes of a hand-drawn table (0.28, roadmap #41): the pure geometry is in table.ts, this turns it into History commands.
 * Each is ONE undo step (a Batch), refused as a whole on a locked page by History like any edit.
 */

/** A box of the points of a stroke (no pen padding: ink that touches a cell wall is still inside the table). */
export function inkBox(s: Stroke): InkBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of s.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { id: s.id, minX, minY, maxX, maxY, group: s.group, hidden: s.hidden };
}

/** "Insert table": the lines of `grid` added to the page as one group, in one step. */
export function insertTableCommand(page: Pick<Page, "id" | "strokes">, grid: TableGrid, style: TableStyle, newId: () => string = createId): { cmd: Command; strokes: Stroke[]; group: string } {
	const group = newId();
	const strokes = buildTable(grid, style, group, newId);
	const cmd = new Batch("Insert table", strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i)));
	return { cmd, strokes, group };
}

/** Why a table edit is not made (nothing is changed in any of these cases). */
export type TableEditRefusal =
	/** The lines of the table are no longer all on the page (a stale selection, a posed copy). */
	| "gone"
	/**
	 * A line of the table belongs to a part of a drawing with states: fresh line ids would drop it from the part. 0.29 (R3-2): or ink the
	 * insert would push does (the part's pivot would stay behind).
	 */
	| "states"
	/** The grown table, or the ink the insert pushes along, would end up outside the page. */
	| "edge"
	/** The ink the insert pushes along is, or would land, under a redaction box (or the boxes cannot be read). */
	| "redacted";

export type TableEditPlan = { ok: true; cmd: Command; strokes: Stroke[] } | { ok: false; reason: TableEditRefusal };

type EditPage = Pick<Page, "id" | "strokes"> & Partial<Pick<Page, "width" | "height" | "infinite" | "states">>;

/** Points this far beyond the page edge are still on it (rounding of the grid). */
const EDGE_TOL = 0.01;

const shiftStroke = (s: Stroke, axis: "x" | "y", by: number): Stroke => ({
	...s,
	points: s.points.map((p) => (axis === "y" ? quantizePoint(p[0], p[1] + by, p[2]) : quantizePoint(p[0] + by, p[1], p[2]))),
});

const insidePage = (page: EditPage, minX: number, minY: number, maxX: number, maxY: number): boolean => {
	if (page.width === undefined || page.height === undefined) return true;
	if (minX < -EDGE_TOL || minY < -EDGE_TOL || maxX > page.width + EDGE_TOL) return false;
	return page.infinite === true || maxY <= page.height + EDGE_TOL;
};

/**
 * "Edit table": the lines of `table` are replaced by those of `edit.grid` (fresh stroke ids, same group, same style), and for an insert the
 * ink of `ink` that `inkToShift` picks is moved by the cell size. `ink` is the ink the person sees on the page (never hidden or collapsed ink).
 * All or nothing: the plan is refused (and nothing is built) when a line of the table is not on the page, belongs to a drawing-state part,
 * when an insert would push the table or the ink in its cells beyond the page edge, or when the ink it pushes is, or would land, under a
 * redaction box (`guard`: the boxes of the page; unreadable boxes refuse any push).
 */
export function planTableEdit(
	page: EditPage, table: DetectedTable, edit: GridEdit, ink: readonly Stroke[], newId: () => string = createId, guard?: RedactGuard,
): TableEditPlan {
	// Every line must be the very object on the page: a partial removal would leave some old lines next to the whole new grid.
	if (table.strokes.length === 0 || table.strokes.some((s) => !page.strokes.includes(s))) return { ok: false, reason: "gone" };
	const inPart = new Set<string>();
	for (const part of page.states?.parts ?? []) for (const id of part.items) inPart.add(id);
	if (table.strokes.some((s) => inPart.has(s.id))) return { ok: false, reason: "states" };
	let pushed: Stroke[] = [];
	if (edit.shift) {
		const mine = new Set(table.strokes.map((s) => s.id));
		const ids = new Set(inkToShift(table.grid, edit.shift, ink.filter((s) => !mine.has(s.id)).map(inkBox)));
		pushed = ink.filter((s) => ids.has(s.id) && !mine.has(s.id));
		// 0.29 (review R3-2): ink of a drawing-state part would move while the part's pivot stays, so its poses would turn about the old point.
		if (pushed.some((s) => inPart.has(s.id))) return { ok: false, reason: "states" };
		const box = tableBox(edit.grid);
		if (!insidePage(page, box.minX, box.minY, box.maxX, box.maxY)) return { ok: false, reason: "edge" };
		const { axis, by } = edit.shift;
		const moved = pushed.map((s) => shiftStroke(s, axis, by));
		for (const s of moved) {
			const b = inkBox(s);
			if (!insidePage(page, b.minX, b.minY, b.maxX, b.maxY)) return { ok: false, reason: "edge" };
		}
		if (guard && movesUnderRedaction(guard, { strokes: pushed, elements: [] }, { strokes: moved, elements: [] })) return { ok: false, reason: "redacted" };
	}
	const removed = removeStrokes(page.id, page.strokes, table.strokes, "Edit table");
	if (!removed) return { ok: false, reason: "gone" };
	const group = table.strokes[0]?.group ?? newId();
	const strokes = buildTable(edit.grid, table.style, group, newId);
	const base = page.strokes.length - table.strokes.length;
	const commands: Command[] = [removed, ...strokes.map((s, i) => new AddStroke(page.id, s, base + i))];
	if (edit.shift && pushed.length > 0) {
		const { axis, by } = edit.shift;
		commands.push(new UpdateItems(page.id, new Set(pushed.map((s) => s.id)), (item) => shiftStroke(item as Stroke, axis, by), "Edit table"));
	}
	return { ok: true, cmd: new Batch("Edit table", commands), strokes };
}

/** `planTableEdit` as the command alone: null when the edit is refused for any reason. */
export function editTableCommand(
	page: EditPage, table: DetectedTable, edit: GridEdit, ink: readonly Stroke[], newId: () => string = createId, guard?: RedactGuard,
): { cmd: Command; strokes: Stroke[] } | null {
	const plan = planTableEdit(page, table, edit, ink, newId, guard);
	return plan.ok ? { cmd: plan.cmd, strokes: plan.strokes } : null;
}
