/**
 * Format v9: equations (#110) and function graphs (#113); the v8 -> v9 migration; lenient read and strict write; and
 * every path that copies pages or elements (duplicate, page restore, page trash, move to notebook, clipboard,
 * templates, stamps, conflicted-copy merge, repair, margins) keeping the new data. Also the geometry, ink following
 * a graph, and the exports.
 */
import { describe, expect, it } from "vitest";
import { captureClip, instantiateClip } from "../src/ink/clipboard";
import { planStampPlacement, readStamp, serializeStamp } from "../src/ink/stamps";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { graphEditCommand, graphViewMatrix, inkOnGraph, panView, zoomView } from "../src/ink/graph-ink";
import { attachedInk } from "../src/ink/attach";
import { apply, scaleAbout, translate } from "../src/ink/transform";
import { planPageMove } from "../src/library/page-move";
import { createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { translateElement } from "../src/model/margins";
import {
	createEquation, createGraph, equationNumbers, isParamName, newGraphFunction, stableStringify,
} from "../src/model/math-elements";
import { elementContentKey, mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { planPageRestore } from "../src/model/page-restore";
import { makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { FULL_CHECK_LIMIT, parse, serialize, serializeChecked, StagedParse } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { documentFromTemplate, pageFromTemplate, templateDocument } from "../src/model/templates";
import {
	CURRENT_VERSION, FORMAT_ID,
	type EquationElement, type GraphElement, type NotebookDocument, type Page, type PageElement,
} from "../src/model/types";
import { line } from "./helpers";
import { buildNotebookMarkdown, equationMarkdown, pageTexts } from "../src/model/export-markdown";
import { elementBand } from "../src/model/layers";
import { pageInfo } from "../src/model/page-info";

const stamp = "2026-10-30T10:00:00.000Z";
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function roundTrip(doc: NotebookDocument): NotebookDocument {
	return parsed(serialize(doc)).doc;
}

const euler: EquationElement = {
	id: "eq1", type: "equation", x: 60, y: 80, width: 120, height: 24, latex: "e^{i\\pi} + 1 = 0", fontSize: 16, color: "#1e293b",
	numbered: true, outline: "M0 0L10 0L10 10ZM20 0L30 0L30 10L20 10Z",
};
const inlineEq: EquationElement = { id: "eq2", type: "equation", x: 300, y: 82, width: 40, height: 14, latex: "\\frac{a}{b}", fontSize: 12, color: "#dc2626", inline: true };
const plot: GraphElement = {
	id: "g1", type: "graph", x: 40, y: 200, width: 300, height: 200,
	view: { xMin: -5, xMax: 5, yMin: -3, yMax: 4 },
	functions: [
		{ id: "f1", kind: "cartesian", color: "#2563eb", expr: "a sin(x)", roots: true, extrema: true, tangent: 1, area: { from: 0, to: 3.14159 }, label: "wave" },
		{ id: "f2", kind: "parametric", color: "#16a34a", x: "cos(t)", y: "sin(t)", min: 0, max: 6.2832 },
		{ id: "f3", kind: "polar", color: "#9333ea", expr: "1 + cos(θ)" },
		{ id: "f4", kind: "implicit", color: "#ea580c", expr: "x^2 + y^2 = 4", width: 2 },
		{ id: "f5", kind: "piecewise", color: "#0891b2", pieces: [{ expr: "-x", when: "x < 0" }, { expr: "x^2" }], intersections: true, hidden: true },
	],
	params: [{ name: "a", value: 2, min: -5, max: 5, step: 0.1 }],
	grid: false, xStep: 1, yLabel: "y", xLabel: "x", degrees: true, table: { fn: "f1", from: 0, step: 0.5, rows: 5 },
};

/** Page p1 with every kind of v9 data, page p2 plain. */
function v9Doc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push({ ...line(100, 250, 140, 260), id: "s1" }, { ...line(400, 600, 500, 620), id: "s2" });
	p1.elements = [euler, inlineEq, plot];
	const p2 = createPage();
	p2.id = "p2";
	doc.pages.push(p2);
	return doc;
}

function v8Doc(): Raw {
	return {
		format: FORMAT_ID, version: 8, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			elements: [{ id: "m1", type: "marker", kind: "star", x: 1, y: 2 }],
			strokes: [{ id: "s1", tool: "pen", color: "#112233", width: 2, render: 1, points: [[10, 20, 0.5]] }],
		}],
	};
}

/** The v9 data of a page, ids left out (copies get new element ids). */
function v9Content(page: Page): unknown {
	return (page.elements ?? []).filter((e) => e.type === "equation" || e.type === "graph").map((e) => {
		const { id: _id, ...rest } = e;
		void _id;
		return JSON.parse(stableStringify(rest)) as unknown;
	});
}

describe("format v9", () => {
	it("has a v8 step (the current version is checked in model-v10.test.ts)", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(9);
		expect(MIGRATIONS[8]).toBeTypeOf("function");
	});

	it("migrates a v8 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v8Doc()));
		expect(r.migratedFrom).toBe(8);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.elements).toEqual([{ id: "m1", type: "marker", kind: "star", x: 1, y: 2 }]);
		expect(r.dropped).toBeUndefined();
	});

	it("rejects a pre-v9 file with an equation or a graph (no version of the plugin wrote it)", () => {
		for (const el of [euler, plot]) {
			for (const version of [8, 7, 4]) {
				const raw = v8Doc();
				raw.version = version;
				if (version < 8) raw.pages[0].elements = [];
				if (version < 5) delete raw.pages[0].strokes[0].render;
				raw.pages[0].elements.push(el);
				const r = parse(JSON.stringify(raw));
				expect(r.ok, `v${version} ${el.type}`).toBe(false);
				if (!r.ok) expect(r.reason).toBe("invalid");
			}
		}
	});

	it("serializes equations and graphs deterministically, one line each, optional fields only when present", () => {
		const text = serialize(v9Doc());
		const lines = text.split("\n");
		const eq = lines.find((l) => l.includes('"id":"eq1"'))!;
		expect(eq.startsWith('\t\t\t\t{"id":"eq1","type":"equation","x":60,"y":80,"width":120,"height":24,"latex":"e^{i\\\\pi} + 1 = 0","fontSize":16,"color":"#1e293b","numbered":true,"outline":')).toBe(true);
		expect(lines.find((l) => l.includes('"id":"eq2"'))).toBe('\t\t\t\t{"id":"eq2","type":"equation","x":300,"y":82,"width":40,"height":14,"latex":"\\\\frac{a}{b}","fontSize":12,"color":"#dc2626","inline":true},');
		const g = lines.find((l) => l.includes('"id":"g1"'))!;
		expect(g).toContain('"view":{"xMin":-5,"xMax":5,"yMin":-3,"yMax":4},"functions":[{"id":"f1","kind":"cartesian","color":"#2563eb","expr":"a sin(x)","roots":true');
		expect(g).toContain('"params":[{"name":"a","value":2,"min":-5,"max":5,"step":0.1}],"grid":false,"xStep":1,"xLabel":"x","yLabel":"y","degrees":true,"table":{"fn":"f1","from":0,"step":0.5,"rows":5}}');
		expect(g).not.toContain('"axes"');
		expect(serialize(parsed(text).doc)).toBe(text);
		expect(serializeChecked(v9Doc()).ok).toBe(true);
	});

	it("writes only the fields of a function's kind, and normalised labels, so the round trip is exact", () => {
		const doc = v9Doc();
		doc.pages[0]!.elements = [{ ...plot, xLabel: "  time \n (s) ", functions: [{ ...plot.functions[1]!, expr: "ignored", label: "   " }] }];
		const text = serialize(doc);
		expect(text).toContain('"xLabel":"time (s)"');
		expect(text).not.toContain("ignored");
		expect(text).not.toContain('"label"');
		// The table's function is gone: the table is left out on write (like details of a deleted bookmark).
		expect(text).not.toContain('"table"');
		expect(serialize(parsed(text).doc)).toBe(text);
	});

	it("keeps an expression that does not parse (it is not a format error)", () => {
		const doc = v9Doc();
		doc.pages[0]!.elements = [{ ...plot, functions: [{ id: "f1", kind: "cartesian", color: "#000000", expr: "sin(" }] }];
		const back = roundTrip(doc);
		expect((back.pages[0]!.elements![0] as GraphElement).functions[0]!.expr).toBe("sin(");
	});

	it("reads invalid details leniently: each is dropped and counted, the rest stays", () => {
		const raw = JSON.parse(serialize(v9Doc())) as Raw;
		const [eq1, eq2, g] = raw.pages[0].elements as Raw[];
		eq1!.outline = "M0 0L1 1"; // not closed
		eq1!.numbered = "yes";
		eq2!.inline = false;
		g!.functions[0].tangent = "one";
		g!.functions[0].area = { from: 2, to: 2 };
		g!.functions[2].kind = "spiral"; // a whole function
		g!.functions[3].width = 100;
		g!.params[0].step = -1;
		g!.grid = true;
		g!.table.rows = 0;
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(10);
		const [e1, e2, gr] = r.doc.pages[0]!.elements! as [EquationElement, EquationElement, GraphElement];
		expect(e1.outline).toBeUndefined();
		expect(e1.numbered).toBeUndefined();
		expect(e1.latex).toBe(euler.latex);
		expect(e2.inline).toBeUndefined();
		expect(gr.functions.map((f) => f.id)).toEqual(["f1", "f2", "f4", "f5"]);
		expect(gr.functions[0]!.tangent).toBeUndefined();
		expect(gr.functions[0]!.area).toBeUndefined();
		expect(gr.functions[0]!.roots).toBe(true);
		expect(gr.functions[2]!.width).toBeUndefined();
		expect(gr.params![0]).toEqual({ name: "a", value: 2, min: -5, max: 5 });
		expect(gr.grid).toBeUndefined();
		expect(gr.table).toBeUndefined();
		expect(serializeChecked(r.doc).ok).toBe(true);
	});

	it("drops (and counts) an equation or graph whose required data is invalid; a duplicate id still fails the file", () => {
		const raw = JSON.parse(serialize(v9Doc())) as Raw;
		raw.pages[0].elements[0].latex = "   ";
		raw.pages[0].elements[1].fontSize = 0;
		raw.pages[0].elements[2].view = { xMin: 1, xMax: 1, yMin: 0, yMax: 1 };
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(3);
		expect(r.doc.pages[0]!.elements).toBeUndefined();
		const dup = JSON.parse(serialize(v9Doc())) as Raw;
		dup.pages[0].elements[2].id = "eq1";
		expect(parse(JSON.stringify(dup)).ok).toBe(false);
		const dupStroke = JSON.parse(serialize(v9Doc())) as Raw;
		dupStroke.pages[0].elements[2].id = "s1";
		expect(parse(JSON.stringify(dupStroke)).ok).toBe(false);
	});

	it("drops duplicate function ids, reserved parameter names and extra functions", () => {
		const raw = JSON.parse(serialize(v9Doc())) as Raw;
		const g = raw.pages[0].elements[2];
		g.functions[1].id = "f1";
		g.params.push({ name: "sin", value: 1, min: 0, max: 2 }, { name: "x", value: 1, min: 0, max: 2 }, { name: "a", value: 1, min: 0, max: 2 });
		for (let i = 0; i < 12; i++) g.functions.push({ id: `extra${i}`, kind: "cartesian", color: "#000000", expr: "x" });
		const r = parsed(JSON.stringify(raw));
		const gr = r.doc.pages[0]!.elements![2] as GraphElement;
		expect(gr.functions.filter((f) => f.id === "f1")).toHaveLength(1);
		expect(gr.functions).toHaveLength(11);
		expect(gr.params!.map((p) => p.name)).toEqual(["a"]);
		expect(r.dropped).toBe(1 + 3 + 5);
		expect(isParamName("θ")).toBe(false);
		expect(isParamName("k2")).toBe(true);
		expect(isParamName("__proto__")).toBe(false);
	});

	it("never writes an invalid equation or graph (strict write)", () => {
		const bad: PageElement[] = [
			{ ...euler, outline: "M0 0Z" },
			{ ...euler, latex: "" },
			{ ...euler, fontSize: 1000 },
			{ ...euler, inline: false as never },
			{ ...plot, view: { xMin: 0, xMax: -1, yMin: 0, yMax: 1 } },
			{ ...plot, functions: [{ id: "f", kind: "cartesian", color: "red", expr: "x" }] },
			{ ...plot, functions: [{ id: "f", kind: "piecewise", color: "#000000", pieces: [] }] },
			{ ...plot, params: [{ name: "pi", value: 1, min: 0, max: 1 }] },
			{ ...plot, table: { fn: "f1", from: 0, step: 0, rows: 3 } },
			{ ...plot, axes: true as never },
			{ ...plot, functions: [...plot.functions, { ...plot.functions[0]! }] },
		];
		for (const el of bad) {
			const doc = v9Doc();
			doc.pages[0]!.elements = [el];
			expect(serializeChecked(doc).ok, JSON.stringify(el).slice(0, 80)).toBe(false);
		}
	});

	it("checks equations and graphs on the incremental save path too", () => {
		const doc = stressDocument(6000, 4);
		doc.pages[0]!.elements = [euler, plot];
		const ok = serializeChecked(doc);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.text.length).toBeGreaterThan(FULL_CHECK_LIMIT);
		doc.pages[0]!.elements = [{ ...plot, view: { ...plot.view, yMax: NaN } }];
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("a file of a later version is a future version (opens read-only)", () => {
		const r = parse(serialize(v9Doc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("staged loading drops and counts exactly what the full lenient parse does", () => {
		const raw = JSON.parse(serialize(v9Doc())) as Raw;
		raw.pages[0].elements[0].numbered = 1;
		raw.pages[0].elements[2].functions[0].roots = false;
		raw.pages[1].elements = [{ ...inlineEq, id: "eq9", inline: "no" }];
		const staged = StagedParse.create(raw, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		const full = parsed(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dropped).toBe(3);
			expect(r.dropped).toBe(full.dropped);
			expect(serialize(r.doc)).toBe(serialize(full.doc));
		}
	});

	it("elements are frozen with their nested graph data", () => {
		const doc = roundTrip(v9Doc());
		const g = doc.pages[0]!.elements![2] as GraphElement;
		expect(Object.isFrozen(g)).toBe(true);
		expect(Object.isFrozen(g.functions)).toBe(true);
		expect(Object.isFrozen(g.functions[0])).toBe(true);
		expect(Object.isFrozen(g.view)).toBe(true);
		expect(Object.isFrozen(g.params![0])).toBe(true);
	});
});

describe("paths that copy pages and elements keep the v9 data", () => {
	const p1 = () => roundTrip(v9Doc()).pages[0]!;

	it("duplicatePage (new ids, same equations and graphs)", () => {
		const page = p1();
		const copy = duplicatePage(page);
		expect(v9Content(copy)).toEqual(v9Content(page));
		expect(copy.elements!.every((e, i) => e.id !== page.elements![i]!.id)).toBe(true);
	});

	it("page restore, replace and insert", () => {
		const version = roundTrip(v9Doc());
		const current = roundTrip(v9Doc());
		current.pages[0]!.elements = [];
		for (const mode of ["replace", "insert"] as const) {
			const target = roundTrip(current);
			const plan = planPageRestore(target, version, 0, 0, mode)!;
			plan.command.apply(target);
			expect(v9Content(target.pages[plan.pageIndex]!)).toEqual(v9Content(version.pages[0]!));
			expect(serializeChecked(target).ok).toBe(true);
		}
	});

	it("page trash: the entry and its restore (ids kept, or new ids on a clash)", () => {
		const doc = roundTrip(v9Doc());
		const entry = makeEntry(doc, doc.pages[0]!, 0, Date.parse(stamp));
		const without = roundTrip(doc);
		without.pages.splice(0, 1);
		const plan = planPageTrashRestore(without, entry)!;
		plan.command.apply(without);
		expect(v9Content(without.pages[plan.pageIndex]!)).toEqual(v9Content(doc.pages[0]!));
		const clash = planPageTrashRestore(without, entry)!;
		clash.command.apply(without);
		expect(v9Content(without.pages[clash.pageIndex]!)).toEqual(v9Content(doc.pages[0]!));
		expect(serializeChecked(without).ok).toBe(true);
	});

	it("move to notebook", () => {
		const source = roundTrip(v9Doc());
		const target = createDocument(new Date(stamp));
		const plan = planPageMove(source, ["p1"], target);
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(v9Content(plan.pages[0]!)).toEqual(v9Content(source.pages[0]!));
	});

	it("clipboard: copy and paste keep every field, moved by the paste offset", () => {
		const page = p1();
		const clip = captureClip(page.strokes, page.elements!, {})!;
		const made = instantiateClip(clip, 10, 5);
		const eq = made.elements.find((e) => e.type === "equation" && e.latex === euler.latex) as EquationElement;
		expect(eq).toMatchObject({ x: 70, y: 85, width: 120, height: 24, numbered: true, outline: euler.outline, fontSize: 16 });
		const g = made.elements.find((e) => e.type === "graph") as GraphElement;
		expect(g).toMatchObject({ x: 50, y: 205, width: 300, height: 200, view: plot.view, degrees: true, table: plot.table });
		expect(g.functions).toEqual(plot.functions);
		expect(g.id).not.toBe(plot.id);
		const doc = v9Doc();
		doc.pages[1]!.elements = made.elements;
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("stamps: saving a selection with an equation and a graph as a stamp and placing it", () => {
		const page = p1();
		const clip = captureClip([], page.elements!, {})!;
		const text = serializeStamp(clip, new Date(stamp));
		expect(text.ok).toBe(true);
		if (!text.ok) return;
		const read = readStamp(text.text);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const doc = roundTrip(v9Doc());
		const placed = planStampPlacement(read.clip, doc, doc.pages[1]!, [300, 400])!;
		placed.command.apply(doc);
		expect(v9Content({ ...doc.pages[1]!, elements: doc.pages[1]!.elements!.map((e) => ({ ...e, x: 0, y: 0 })) }))
			.toEqual(v9Content({ ...page, elements: page.elements!.map((e) => ({ ...e, x: 0, y: 0 })) }));
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("templates: saving a page as a template and using it", () => {
		const doc = roundTrip(v9Doc());
		const template = roundTrip(templateDocument(doc, doc.pages[0]!));
		expect(v9Content(template.pages[0]!)).toEqual(v9Content(doc.pages[0]!));
		expect(v9Content(pageFromTemplate(template)!.page)).toEqual(v9Content(doc.pages[0]!));
		expect(v9Content(documentFromTemplate(template).pages[0]!)).toEqual(v9Content(doc.pages[0]!));
	});

	it("margins: a left margin moves equations and graphs with the page content", () => {
		const moved = translateElement(plot, 20) as GraphElement;
		expect(moved).toMatchObject({ x: 60, y: 200, view: plot.view, functions: plot.functions });
		expect((translateElement(euler, -10) as EquationElement).outline).toBe(euler.outline);
	});
});

describe("conflicted-copy merge with v9 data", () => {
	it("adds the copy's equations and graphs, is covered and idempotent", () => {
		const main = roundTrip(v9Doc());
		main.pages[0]!.elements = [];
		const other = roundTrip(v9Doc());
		const plan = planMerge(main, other);
		expect(plan.summary.elementsAdded).toBe(3);
		plan.command!.apply(main);
		const result = roundTrip(main);
		expect(v9Content(result.pages[0]!)).toEqual(v9Content(other.pages[0]!));
		expect(mergeCovers(result, other)).toBe(true);
		expect(mergeChangeCount(planMerge(result, other).summary)).toBe(0);
	});

	it("a graph edited only in nested data (an expression, a parameter) is content: both versions are kept", () => {
		const main = roundTrip(v9Doc());
		const other = roundTrip(v9Doc());
		const g = other.pages[0]!.elements![2] as GraphElement;
		other.pages[0]!.elements![2] = { ...g, functions: [{ ...g.functions[0]!, expr: "a cos(x)" }, ...g.functions.slice(1)] };
		expect(elementContentKey(other.pages[0]!.elements![2]!)).not.toBe(elementContentKey(main.pages[0]!.elements![2]!));
		const plan = planMerge(main, other);
		expect(plan.summary.elementsCopied).toBe(1);
		plan.command!.apply(main);
		expect(mergeCovers(roundTrip(main), other)).toBe(true);
		const p = roundTrip(v9Doc());
		const g2 = p.pages[0]!.elements![2] as GraphElement;
		p.pages[0]!.elements![2] = { ...g2, params: [{ ...g2.params![0]!, value: 3 }] };
		expect(elementContentKey(p.pages[0]!.elements![2]!)).not.toBe(elementContentKey(g2));
	});

	it("the same equation with a different cached outline is the same equation", () => {
		expect(elementContentKey({ ...euler, outline: "M0 0L1 0L1 1Z" })).toBe(elementContentKey(euler));
		expect(elementContentKey({ ...euler, latex: "x" })).not.toBe(elementContentKey(euler));
	});
});

describe("repair keeps the v9 data", () => {
	it("recovers equations and graphs after a damaged region", () => {
		const doc = roundTrip(v9Doc());
		const lines = serialize(doc).split("\n");
		const at = lines.findIndex((l) => l.startsWith("\t\t\t\t{") && l.includes('"points"'));
		lines[at] = lines[at]!.slice(0, 30);
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.damaged).toBe(true);
		expect(v9Content(r.doc.pages[0]!)).toEqual(v9Content(doc.pages[0]!));
	});

	it("keeps the valid parts of a damaged equation or graph", () => {
		const raw = JSON.parse(serialize(v9Doc())) as Raw;
		raw.pages[0].elements[0].outline = 7;
		raw.pages[0].elements[2].functions[1].color = "green";
		raw.pages[0].elements[2].params = "a";
		raw.pages[0].elements.push({ id: "g-bad", type: "graph", x: 1, y: 1, width: 10, height: 10, functions: [] });
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const els = r.doc.pages[0]!.elements!;
		const eq = els.find((e) => e.id === "eq1") as EquationElement;
		expect(eq).toMatchObject({ latex: euler.latex, numbered: true });
		expect(eq.outline).toBeUndefined();
		const g = els.find((e) => e.id === "g1") as GraphElement;
		expect(g.functions.map((f) => f.id)).toEqual(["f1", "f3", "f4", "f5"]);
		expect(g.params).toBeUndefined();
		expect(g.table).toEqual(plot.table);
		expect(els.some((e) => e.id === "g-bad")).toBe(false);
	});
});

describe("geometry and ink on graphs", () => {
	it("bounds, hits and transforms", () => {
		expect(elementBounds(plot)).toEqual({ minX: 40, minY: 200, maxX: 340, maxY: 400 });
		expect(elementBounds(euler)).toEqual({ minX: 60, minY: 80, maxX: 180, maxY: 104 });
		expect(hitElement([plot, euler], 100, 300, 0)).toBe(plot);
		expect(hitElement([plot, euler], 61, 81, 0)).toBe(euler);
		expect(transformElement(plot, translate(10, -5))).toMatchObject({ x: 50, y: 195, width: 300, height: 200, view: plot.view });
		const scaled = transformElement(euler, scaleAbout(2, 2, euler.x, euler.y)) as EquationElement;
		expect(scaled).toMatchObject({ x: 60, y: 80, width: 240, height: 48, fontSize: 32 });
		expect(scaled.outline).toBe("M0 0L20 0L20 20ZM40 0L60 0L60 20L40 20Z");
		const g2 = transformElement(plot, scaleAbout(2, 1, 40, 200)) as GraphElement;
		expect(g2).toMatchObject({ x: 40, width: 600, height: 200 });
	});

	it("ink written on a graph moves with the frame (attached ink) and keeps its graph coordinates when panning or zooming", () => {
		const page = createPage();
		page.elements = [plot];
		const on = { ...line(100, 250, 140, 260), id: "on" };
		const off = { ...line(400, 600, 500, 620), id: "off" };
		page.strokes = [on, off];
		expect(attachedInk(page.strokes, page.elements, [plot])).toEqual([on]);
		expect(inkOnGraph(page, plot)).toEqual([on]);
		// Zoom in 2× about the frame centre: graph point under (100, 250) is now twice as far from the centre.
		const zoomed: GraphElement = { ...plot, view: zoomView(plot, 2, 190, 300) };
		const m = graphViewMatrix(plot, zoomed);
		const [x, y] = apply(m, 100, 250);
		expect(x).toBeCloseTo(190 + (100 - 190) * 2, 6);
		expect(y).toBeCloseTo(300 + (250 - 300) * 2, 6);
		// Pan: the plane follows the drag.
		const panned: GraphElement = { ...plot, view: panView(plot, 30, -15) };
		const [px, py] = apply(graphViewMatrix(plot, panned), 100, 250);
		expect(px).toBeCloseTo(130, 6);
		expect(py).toBeCloseTo(235, 6);
		// One undo step: the graph and its ink.
		const doc = createDocument(new Date(stamp));
		doc.pages[0] = page;
		const history = new History(() => doc);
		const cmd = graphEditCommand(page, plot, zoomed, [on])!;
		history.execute(cmd);
		expect(page.elements[0]).toBe(zoomed);
		expect(page.strokes[0]!.points[0]![0]).toBeCloseTo(10, 1);
		expect(page.strokes[0]!.width).toBe(on.width);
		expect(page.strokes[1]).toBe(off);
		history.undo();
		expect(page.elements[0]).toBe(plot);
		expect(page.strokes[0]).toBe(on);
	});
});

describe("equation numbering", () => {
	it("numbers the numbered equations in reading order across pages", () => {
		const doc = v9Doc();
		const a = createEquation(300, 500, "a", 12, "#000000", { numbered: true, width: 20, height: 10 });
		const b = createEquation(10, 500, "b", 12, "#000000", { numbered: true, width: 20, height: 10 });
		const c = createEquation(10, 40, "c", 12, "#000000", { numbered: true, width: 20, height: 10 });
		doc.pages[0]!.elements!.push(a, b);
		doc.pages[1]!.elements = [c];
		const n = equationNumbers(doc.pages);
		expect([n.get("eq1"), n.get(b.id), n.get(a.id), n.get(c.id), n.get("eq2")]).toEqual([1, 2, 3, 4, undefined]);
	});
});

describe("exports draw equations and graphs as vectors", () => {
	it("SVG: a filled even-odd outline, the number, and a clipped graph", () => {
		const page = v9Doc().pages[0]!;
		const svg = pageToSvg(page, { paper: false });
		expect(svg).toContain('fill-rule="evenodd"');
		expect(svg).toContain(">(1)<");
		expect(svg).toContain('<clipPath id="nb-graph-1">');
		expect(svg).toContain('clip-path="url(#nb-graph-1)"');
		// The equation without an outline falls back to its source.
		expect(svg).toContain(">\\frac{a}{b}<");
		expect(svg).not.toContain("<image");
		expect(pageToSvg(page, { paper: false })).toBe(svg);
	});

	it("PDF: even-odd fill, clipping and the area transparency", () => {
		const page = v9Doc().pages[0]!;
		const pdf = new TextDecoder().decode(pagesToPdf([page], { paper: false }));
		expect(pdf).toContain(" f*");
		expect(pdf).toContain("re W n");
		expect(pdf).toContain("/GS2 << /Type /ExtGState /ca 0.18 >>");
		expect(pdf).toContain("(\\(1\\)) Tj");
		expect(pdf).not.toContain("/Image");
	});
});

describe("helpers", () => {
	it("creates graphs and functions with defaults that compile", () => {
		const g = createGraph(10, 20, 240, 160);
		expect(g.view).toEqual({ xMin: -6, xMax: 6, yMin: -4, yMax: 4 });
		expect(g.functions).toHaveLength(1);
		for (const kind of ["cartesian", "parametric", "polar", "implicit", "piecewise"] as const) {
			const f = newGraphFunction(g, kind);
			expect(f.id).toBe("f2");
			const doc = v9Doc();
			doc.pages[1]!.elements = [{ ...g, functions: [...g.functions, f] }];
			expect(serializeChecked(doc).ok, kind).toBe(true);
		}
	});
});

describe("wave 0.9 features with equations and graphs", () => {
	it("exports: equations and graphs are content, drawn with the ink layer and never with the background", () => {
		const page = v9Doc().pages[0]!;
		const dec = new TextDecoder();
		const bg = dec.decode(pagesToPdf([page], { layers: "background" }));
		expect(bg).not.toContain(" f*");
		expect(bg).not.toContain("re W n");
		const ink = dec.decode(pagesToPdf([page], { layers: "ink" }));
		expect(ink).toContain(" f*");
		expect(ink).toContain("re W n");
		expect(pageToSvg(page, { layers: "background" })).not.toContain("nb-graph-1");
		expect(pageToSvg(page, { layers: "ink" })).toContain("nb-graph-1");
	});

	it("Markdown export: equations as $$…$$ (numbered with \\tag, inline with $…$) in reading order with the text boxes", () => {
		expect(equationMarkdown(euler, 1)).toBe("$$\ne^{i\\pi} + 1 = 0 \\tag{1}\n$$");
		expect(equationMarkdown(inlineEq)).toBe("$\\frac{a}{b}$");
		expect(equationMarkdown({ ...inlineEq, latex: "a$b \\$c" })).toBe("$a\\$b \\$c$");
		const page = v9Doc().pages[0]!;
		page.elements = [...page.elements!, { id: "t1", type: "text", x: 10, y: 10, width: 100, text: "Euler", fontSize: 12, color: "#000000" }];
		expect(pageTexts(page)).toEqual(["Euler", "$$\ne^{i\\pi} + 1 = 0\n$$", "$\\frac{a}{b}$"]);
		const md = buildNotebookMarkdown({ title: "Maths", pages: v9Doc().pages, meta: undefined, images: ["p1.png", "p2.png"], pageLabel: (n) => `Page ${n}` });
		expect(md).toContain("![](p1.png)\n\n$$\ne^{i\\pi} + 1 = 0 \\tag{1}\n$$");
	});

	it("layer order keeps graphs and equations in their own bands, as the renderer stacks them", () => {
		const bands = [{ type: "image" }, plot, { type: "box" }, euler, { type: "text" }, { type: "marker" }].map((e) => elementBand(e as PageElement));
		expect(bands).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("page information counts equations and graphs", () => {
		const info = pageInfo(v9Doc(), 0)!;
		expect(info.elements).toMatchObject({ total: 3, equation: 2, graph: 1 });
	});
});
