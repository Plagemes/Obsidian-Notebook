/**
 * Format v22: filled shapes and dashed or dotted lines (#37) — the optional `fill`, `fillTint` and `dash` of a shape stroke: the v21 -> v22
 * migration, lenient read and strict write, staged loading, repair, copies, merge, cutting a shape, and the restyle of a selection.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createStroke } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { planMerge } from "../src/model/merge";
import { duplicatePage, copyStroke } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { History } from "../src/model/history";
import { strokePieces } from "../src/model/groups";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type Point, type Stroke } from "../src/model/types";
import { rectPoints, linePoints } from "../src/ink/shapes";
import { batchShapeStyle, commonShapeStyle, planShapeStyle, shapeAbilities, styleShape } from "../src/ink/shape-restyle";
import { isClosedShape, newShapeStyle } from "../src/ink/shape-style";
import { delAt, getAt, parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-08T10:00:00.000Z";

function shape(id: string, extra: Partial<Stroke> = {}, points: Point[] = rectPoints([10, 10], [60, 40])): Stroke {
	return Object.freeze({ ...createStroke("#1e1e1e", 2, points, "shape"), id, ...extra });
}

function docWith(strokes: Stroke[]): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.strokes = strokes;
	return doc;
}

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function v21Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 21, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "shape", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("format v22: the fields", () => {
	it("writes and reads fill, fillTint and dash of a shape, in a fixed order after the nib position", () => {
		const doc = docWith([shape("a", { fill: "#2563eb", fillTint: true, dash: "dashed" }), shape("b", { fill: "#ff0000", dash: "dotted" }), shape("c")]);
		const checked = serializeChecked(doc, true);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.text).toContain('"render":1,"fill":"#2563eb","fillTint":true,"dash":"dashed","points"');
		const back = parsed(checked.text).doc.pages[0]!.strokes;
		expect(back[0]).toMatchObject({ fill: "#2563eb", fillTint: true, dash: "dashed" });
		expect(back[1]).toMatchObject({ fill: "#ff0000", dash: "dotted" });
		expect(back[1]!.fillTint).toBeUndefined();
		expect(back[2]!.fill).toBeUndefined();
		expect(serialize(parsed(checked.text).doc)).toBe(checked.text);
	});

	it("writes nothing for a plain shape, so an old document is byte-identical apart from the version", () => {
		const text = serialize(docWith([shape("a")]));
		expect(text).not.toMatch(/"fill"|"dash"|"fillTint"/);
	});

	it("refuses to write a malformed one (strict)", () => {
		for (const extra of [
			{ fill: "blue" }, { fill: "#12345" }, { dash: "dashdot" as never }, { fillTint: true as const },
			{ tool: "pen" as const, fill: "#112233" }, { tool: "highlighter" as const, dash: "dashed" as const },
		]) {
			const r = serializeChecked(docWith([shape("a", extra)]), true);
			expect(r.ok, JSON.stringify(extra)).toBe(false);
		}
	});

	it("reads leniently: a bad value is dropped and counted, the ink stays", () => {
		const raw = parseRaw(serialize(docWith([shape("a"), shape("b"), shape("c"), shape("d", { tool: "pen" })])));
		setAt(raw, ["pages", 0, "strokes", 0, "fill"], "blue");
		setAt(raw, ["pages", 0, "strokes", 1, "dash"], "wavy");
		setAt(raw, ["pages", 0, "strokes", 2, "fillTint"], true);
		setAt(raw, ["pages", 0, "strokes", 3, "fill"], "#112233");
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(4);
		for (const s of r.doc.pages[0]!.strokes) {
			expect(s.fill).toBeUndefined();
			expect(s.dash).toBeUndefined();
			expect(s.fillTint).toBeUndefined();
		}
		expect(r.doc.pages[0]!.strokes).toHaveLength(4);
	});
});

describe("format v22: migration from v21", () => {
	it("changes nothing but the version of a valid v21 document", () => {
		const raw = v21Raw();
		const migrated = MIGRATIONS[21]!(raw);
		expect(migrated).toEqual({ ...raw, version: 22 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("drops stray keys of a v21 file (a v21 reader never gave them a meaning)", () => {
		const raw = v21Raw();
		setAt(raw, ["pages", 0, "strokes", 0, "fill"], "#112233");
		setAt(raw, ["pages", 0, "strokes", 0, "dash"], "dashed");
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(21);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.fill).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.dash).toBeUndefined();
	});

	it("reads a v21 file and writes it as v22", () => {
		const r = parsed(JSON.stringify(v21Raw()));
		expect(r.migratedFrom).toBe(21);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(22);
	});

	it("opens a file of a newer format read-only", () => {
		const raw = parseRaw(serialize(docWith([shape("a", { dash: "dashed" })])));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});
});

describe("format v22: staged loading and repair", () => {
	it("stages a large v22 file with styled shapes and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[0]!.strokes.push(shape("zz1", { fill: "#2563eb", fillTint: true, dash: "dotted" }));
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
	});

	it("stages a large v21 file, ignoring stray stroke keys and keeping its views", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.views = [{ id: "v1", name: "V", page: doc.pages[0]!.id, x: 0, y: 0, width: 10, height: 10, zoom: 1 }];
		const raw = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, '"version": 21').replace('"tool":"pen"', '"fill":"#112233","tool":"pen"');
		expect(raw.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(raw, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(21);
			expect(r.doc.views).toHaveLength(1);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("repair keeps a valid style and drops an invalid one", () => {
		const raw = parseRaw(serialize(docWith([shape("a", { fill: "#2563eb", fillTint: true, dash: "dashed" }), shape("b", { fill: "#ff0000" })])));
		setAt(raw, ["pages", 0, "strokes", 1, "fill"], "red");
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const [a, b] = r.doc.pages[0]!.strokes;
		expect(a).toMatchObject({ fill: "#2563eb", fillTint: true, dash: "dashed" });
		expect(b!.fill).toBeUndefined();
		delAt(raw, ["pages", 0, "strokes", 0]);
	});
});

describe("format v22: copies, merge, cuts", () => {
	it("keeps the style when a stroke or a page is copied", () => {
		const s = shape("a", { fill: "#2563eb", fillTint: true, dash: "dashed" });
		expect(copyStroke(s, "b")).toMatchObject({ id: "b", fill: "#2563eb", fillTint: true, dash: "dashed" });
		const page = docWith([s]).pages[0]!;
		expect(duplicatePage(page).strokes[0]).toMatchObject({ fill: "#2563eb", fillTint: true, dash: "dashed" });
	});

	it("a piece of a cut shape keeps the line style but has no fill", () => {
		const s = shape("a", { fill: "#2563eb", fillTint: true, dash: "dotted" });
		const pieces = strokePieces(docWith([s]).pages[0]!, s, [[[10, 10, 0.5], [20, 10, 0.5]], [[30, 10, 0.5], [40, 10, 0.5]]]);
		expect(pieces).toHaveLength(2);
		for (const p of pieces) {
			expect(p.dash).toBe("dotted");
			expect(p.fill).toBeUndefined();
			expect(p.fillTint).toBeUndefined();
		}
	});

	it("merge treats a different fill or line style as different ink", () => {
		const main = docWith([shape("a")]);
		const copy = docWith([shape("b", { fill: "#2563eb" }), shape("c", { dash: "dashed" })]);
		copy.id = main.id;
		const plan = planMerge(main, copy);
		expect(plan.command).not.toBeNull();
	});
});

describe("format v22: the style of a new shape", () => {
	const closed = rectPoints([0, 0], [50, 30]);
	it("a closed shape gets the fill, an open one does not; solid line writes nothing", () => {
		expect(newShapeStyle(closed, "#112233", "tint", null, "dashed")).toEqual({ fill: "#112233", fillTint: true, dash: "dashed" });
		expect(newShapeStyle(closed, "#112233", "solid", "#FF0000", "solid")).toEqual({ fill: "#ff0000" });
		expect(newShapeStyle(linePoints([0, 0], [50, 30]), "#112233", "solid", null, "dotted")).toEqual({ dash: "dotted" });
		expect(newShapeStyle(closed, "#112233", "none", null, "solid")).toEqual({});
	});
});

describe("format v22: restyling a selection", () => {
	const open = linePoints([0, 100], [80, 100]);
	function setup() {
		const rect = shape("r");
		const line = shape("l", {}, open);
		const pen = Object.freeze({ ...createStroke("#000000", 2, [[0, 0, 0.5], [5, 5, 0.5]], "pen"), id: "p" });
		const doc = docWith([rect, line, pen]);
		return { doc, page: doc.pages[0]!, rect, line, pen };
	}

	it("tells what can be changed", () => {
		const { rect, line, pen } = setup();
		expect(shapeAbilities([pen])).toEqual({ fill: false, line: false });
		expect(shapeAbilities([line, pen])).toEqual({ fill: false, line: true });
		expect(shapeAbilities([rect, line])).toEqual({ fill: true, line: true });
	});

	it("fills a closed shape in the colour of its line by default, tinted when the mode is not named", () => {
		const { rect } = setup();
		expect(styleShape(rect, { fill: "solid", fillColor: "line" })).toMatchObject({ fill: "#1e1e1e" });
		expect(styleShape(rect, { fillColor: "#2563EB" })).toMatchObject({ fill: "#2563eb", fillTint: true });
		const solid = styleShape(rect, { fill: "solid", fillColor: "#2563eb" });
		expect(solid.fillTint).toBeUndefined();
		expect(styleShape(solid, { fill: "tint" })).toMatchObject({ fill: "#2563eb", fillTint: true });
		expect(styleShape(solid, { fill: "none" }).fill).toBeUndefined();
		expect(styleShape(solid, { fillColor: "#ff0000" })).toMatchObject({ fill: "#ff0000" });
	});

	it("never fills an open shape or touches freehand ink; any shape takes a line style", () => {
		const { line, pen } = setup();
		expect(styleShape(line, { fill: "solid" })).toBe(line);
		expect(styleShape(pen, { fill: "solid", line: "dashed" })).toBe(pen);
		expect(styleShape(line, { line: "dotted" })).toMatchObject({ dash: "dotted" });
		expect(styleShape(styleShape(line, { line: "dotted" }), { line: "solid" }).dash).toBeUndefined();
		expect(styleShape(line, { line: "solid" })).toBe(line);
	});

	it("is one undo step through the history, and the result writes back", () => {
		const { doc, page, rect, line, pen } = setup();
		const history = new History(() => doc, 500, checkContent);
		const plan = planShapeStyle(page, [rect, line, pen], { fill: "tint", line: "dashed" })!;
		expect(plan).not.toBeNull();
		expect(history.execute(batchShapeStyle([plan.command]))).toBe(true);
		expect(page.strokes[0]).toMatchObject({ id: "r", fill: "#1e1e1e", fillTint: true, dash: "dashed" });
		expect(page.strokes[1]).toMatchObject({ id: "l", dash: "dashed" });
		expect(page.strokes[1]!.fill).toBeUndefined();
		expect(page.strokes[2]).toBe(pen);
		expect(plan.strokes.map((s) => s.id)).toEqual(["r", "l", "p"]);
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(page.strokes[0]).toBe(rect);
		expect(page.strokes[1]).toBe(line);
		history.redo();
		expect(page.strokes[0]).toMatchObject({ fill: "#1e1e1e", dash: "dashed" });
	});

	it("redo after a non-history upkeep replaced the stroke keeps the upkeep's change (W3)", () => {
		const { doc, page, rect } = setup();
		const history = new History(() => doc, 500, checkContent);
		const plan = planShapeStyle(page, [rect], { fill: "solid", line: "dashed" })!;
		expect(history.execute(plan.command)).toBe(true);
		history.undo();
		expect(page.strokes[0]).toBe(rect);
		// An upkeep (slide relink, margin upkeep) swaps the object for one that differs, outside the history.
		const upkept = Object.freeze({ ...rect, color: "#ff0000" });
		page.strokes[0] = upkept;
		history.redo();
		expect(page.strokes[0]).toMatchObject({ id: "r", color: "#ff0000", fill: "#ff0000", dash: "dashed" });
	});

	it("redo on the untouched stroke puts the very object the plan handed out back (selection identity)", () => {
		const { doc, page, rect } = setup();
		const history = new History(() => doc, 500, checkContent);
		const plan = planShapeStyle(page, [rect], { line: "dotted" })!;
		history.execute(plan.command);
		expect(page.strokes[0]).toBe(plan.strokes[0]);
		history.undo();
		history.redo();
		expect(page.strokes[0]).toBe(plan.strokes[0]);
	});

	it("a filled outline whose ends are only close is closed exactly, so a later scale keeps the fill (W5)", () => {
		const ajar: Point[] = [[10, 10, 0.5], [60, 10, 0.5], [60, 40, 0.5], [10, 40, 0.5], [10.6, 10.4, 0.5]];
		const s = shape("a", {}, ajar);
		const filled = styleShape(s, { fill: "solid" });
		const pts = filled.points;
		expect([pts[pts.length - 1]![0], pts[pts.length - 1]![1]]).toEqual([10, 10]);
		expect(filled.fill).toBe("#1e1e1e");
		// scaled by 4 around the origin, the gap would have been 2.4 pt: not closed any more without the join
		const scaled = pts.map((p) => [p[0] * 4, p[1] * 4, p[2]] as Point);
		expect(isClosedShape(scaled)).toBe(true);
		expect(styleShape(s, { line: "dashed" }).points).toBe(s.points);
	});

	it("does nothing when nothing would change, and is refused on a locked page", () => {
		const { doc, page, rect } = setup();
		expect(planShapeStyle(page, [rect], { fill: "none", line: "solid" })).toBeNull();
		const history = new History(() => doc, 500, checkContent);
		page.locked = true;
		const plan = planShapeStyle(page, [rect], { line: "dashed" })!;
		expect(history.execute(plan.command)).toBe(false);
		expect(page.strokes[0]).toBe(rect);
	});

	it("shows what the shapes share", () => {
		const { rect, line } = setup();
		const dashed = styleShape(rect, { line: "dashed", fill: "tint", fillColor: "#2563eb" });
		expect(commonShapeStyle([dashed, dashed])).toEqual({ fill: "tint", fillColor: "#2563eb", line: "dashed" });
		expect(commonShapeStyle([dashed, rect])).toEqual({ fill: null, fillColor: "#2563eb", line: null });
		expect(commonShapeStyle([line]).line).toBe("solid");
	});
});
