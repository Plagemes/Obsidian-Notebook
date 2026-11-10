import { createId, quantizePoint } from "../model/document";
import { UpdateItems } from "../model/groups";
import { AddStroke, Batch, removeStrokes, type Command } from "../model/history";
import type { Page, Stroke } from "../model/types";
import { buildTable, inkToShift, type DetectedTable, type GridEdit, type InkBox, type TableGrid, type TableStyle } from "./table";

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

/**
 * "Edit table": the lines of `table` are replaced by those of `edit.grid` (fresh stroke ids, same group, same style), and for an insert the
 * ink of `ink` that `inkToShift` picks is moved by the cell size. `ink` is the ink the person sees on the page (never hidden or collapsed ink).
 * Null when the table's lines are no longer on the page.
 */
export function editTableCommand(
	page: Pick<Page, "id" | "strokes">, table: DetectedTable, edit: GridEdit, ink: readonly Stroke[], newId: () => string = createId,
): { cmd: Command; strokes: Stroke[] } | null {
	const removed = removeStrokes(page.id, page.strokes, table.strokes, "Edit table");
	if (!removed) return null;
	const group = table.strokes[0]?.group ?? newId();
	const strokes = buildTable(edit.grid, table.style, group, newId);
	const base = page.strokes.length - table.strokes.length;
	const commands: Command[] = [removed, ...strokes.map((s, i) => new AddStroke(page.id, s, base + i))];
	if (edit.shift) {
		const mine = new Set(table.strokes.map((s) => s.id));
		const ids = inkToShift(table.grid, edit.shift, ink.filter((s) => !mine.has(s.id)).map(inkBox));
		if (ids.length > 0) {
			const { axis, by } = edit.shift;
			commands.push(new UpdateItems(page.id, new Set(ids), (item) => {
				const s = item as Stroke;
				return { ...s, points: s.points.map((p) => (axis === "y" ? quantizePoint(p[0], p[1] + by, p[2]) : quantizePoint(p[0] + by, p[1], p[2]))) };
			}, "Edit table"));
		}
	}
	return { cmd: new Batch("Edit table", commands), strokes };
}
