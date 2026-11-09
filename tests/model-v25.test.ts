/**
 * Format v25: stroke taper (#351) — the optional `taperStart` and `taperEnd` (0.05 to 1) of a pen, fountain pen or brush stroke of render 2: the helpers,
 * the fields, the v24 -> v25 migration, lenient read and strict write, staged loading, repair, merge and copies, the engine geometry (the wet ink, the
 * committed stroke, short strokes and dots, the level of detail), the same shape in every render and export path, the pieces a cut leaves, joining, the
 * pens that keep it (favourites, pen sets, the eyedropper).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { planMerge, strokeContentKey } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { copyStroke } from "../src/model/pages";
import { compareStroke } from "../src/model/version-diff";
import { strokePieces } from "../src/model/groups";
import {
	canTaper, isTaper, newStrokeTaper, normaliseTaper, pieceTaper, strokeTaper, TAPER_MAX, TAPER_MIN, TAPER_SPAN, TAPER_TIP, taperFactor, taperFromPercent, taperLength, taperOf, taperPercent, withTaper,
} from "../src/model/taper";
import { CURRENT_VERSION, FORMAT_ID, RENDER_INK, TOOLS, type NotebookDocument, type Page, type Point, type Stroke } from "../src/model/types";
import { InkBuilder, inkPath, SvgPathSink, type PathSink } from "../src/ink/ink-geometry";
import { lodNodes, lodSvgPath } from "../src/ink/lod";
import { strokeSvgPath } from "../src/ink/stroke-shape";
import { joinStrokes } from "../src/ink/stroke-join";
import { cutStroke } from "../src/ink/redact";
import { drawPageRaster } from "../src/ink/page-raster";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { styleOfStroke } from "../src/ink/colour";
import { captureFavourite, favouritePatch, sameFavourite, validPen } from "../src/view/favourites";
import { pageSignature } from "../src/view/view-helpers";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { getAt, parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-09T10:00:00.000Z";

/** A straight horizontal line of `n` points `step` apart, at pressure 0.5. */
function row(n: number, step = 2): Point[] {
	return Array.from({ length: n }, (_, i): Point => [10 + i * step, 50, 0.5]);
}

function stroke(id: string, extra: Partial<Stroke> = {}): Stroke {
	return Object.freeze({ ...createStroke("#1e1e1e", 2, row(40), "pen", RENDER_INK), id, ...extra });
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

function v24Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 24, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 2, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

/** Radii of the nodes of the committed geometry of `points`. */
function radii(points: readonly Point[], width: number, tool: "pen" | "fountain" | "brush", taper?: { start: number; end: number }): { r: number[]; x: number[] } {
	const g = InkBuilder.fromPoints(points, width, tool, new InkBuilder(), undefined, taper);
	return { r: Array.from(g.nr.subarray(0, g.nodeCount)), x: Array.from(g.nx.subarray(0, g.nodeCount)) };
}

describe("taper: the helpers", () => {
	it("accepts 0.05 to 1 and normalises what it is asked to store", () => {
		expect(isTaper(TAPER_MIN)).toBe(true);
		expect(isTaper(TAPER_MAX)).toBe(true);
		for (const bad of [0, 0.049, 1.001, -1, Number.NaN, Infinity, "0.5", null, undefined]) expect(isTaper(bad), String(bad)).toBe(false);
		expect(normaliseTaper(0.5)).toBe(0.5);
		expect(normaliseTaper(0.123456)).toBe(0.12);
		expect(normaliseTaper(7)).toBe(1);
		expect(normaliseTaper(1)).toBe(1);
		// None, or less than the smallest taper, is nothing to store.
		expect(normaliseTaper(0)).toBeUndefined();
		expect(normaliseTaper(-3)).toBeUndefined();
		expect(normaliseTaper(0.04)).toBeUndefined();
		expect(normaliseTaper("x")).toBeUndefined();
		expect(normaliseTaper(Number.NaN)).toBeUndefined();
	});

	it("reads an end without one (or an invalid one) as none", () => {
		expect(taperOf(undefined)).toBe(0);
		expect(taperOf(0.4)).toBe(0.4);
		expect(taperOf(9)).toBe(0);
		expect(taperPercent(undefined)).toBe(0);
		expect(taperPercent(0.35)).toBe(35);
		expect(taperFromPercent(47.6)).toBe(0.48);
		expect(taperFromPercent(0)).toBe(0);
		expect(taperFromPercent(2)).toBe(0);
		expect(taperFromPercent(5)).toBe(0.05);
		expect(taperFromPercent(400)).toBe(1);
	});

	it("is a length in line widths, and the profile goes from a point to the full size", () => {
		expect(taperLength(1, 2)).toBe(TAPER_SPAN * 2);
		expect(taperLength(0.5, 4)).toBe(0.5 * TAPER_SPAN * 4);
		expect(taperFactor(0)).toBe(TAPER_TIP);
		expect(taperFactor(-1)).toBe(TAPER_TIP);
		expect(taperFactor(1)).toBe(1);
		expect(taperFactor(3)).toBe(1);
		expect(taperFactor(0.5)).toBeGreaterThan(taperFactor(0.25));
		expect(taperFactor(0.5)).toBeGreaterThan(0.5);
		expect(taperFactor(0.5)).toBeLessThan(1);
	});

	it("only the line pens of the wet-ink geometry can taper", () => {
		for (const tool of TOOLS) expect(canTaper(tool, RENDER_INK), tool).toBe(tool === "pen" || tool === "fountain" || tool === "brush");
		expect(canTaper("pen", 1)).toBe(false);
		expect(canTaper("pen")).toBe(true);
		expect(strokeTaper(stroke("a"))).toBeUndefined();
		expect(strokeTaper(stroke("a", { taperStart: 0.5 }))).toEqual({ start: 0.5, end: 0 });
		expect(strokeTaper(stroke("a", { taperEnd: 1 }))).toEqual({ start: 0, end: 1 });
		expect(strokeTaper(stroke("a", { tool: "marker", taperEnd: 1 }))).toBeUndefined();
		expect(strokeTaper(stroke("a", { render: 1, taperEnd: 1 }))).toBeUndefined();
		expect(strokeTaper(stroke("a", { taperEnd: 7 }))).toBeUndefined();
	});

	it("withTaper returns the same object when nothing changes and removes the keys at none", () => {
		const s = stroke("s", { taperStart: 0.5, taperEnd: 0.25 });
		expect(withTaper(s, 0.5, 0.25)).toBe(s);
		expect(withTaper(s, 0.6, 0.25)).toMatchObject({ taperStart: 0.6, taperEnd: 0.25 });
		const none = withTaper(s, 0, undefined);
		expect("taperStart" in none).toBe(false);
		expect("taperEnd" in none).toBe(false);
		const plain = stroke("p");
		expect(withTaper(plain, undefined, undefined)).toBe(plain);
		expect(withTaper(plain, 0, 0.01)).toBe(plain);
	});

	it("a new stroke of a line pen gets the keys of the ends that are set, nothing else does", () => {
		expect(newStrokeTaper("pen", 0.5, 0)).toEqual({ taperStart: 0.5 });
		expect(newStrokeTaper("brush", 0, 1)).toEqual({ taperEnd: 1 });
		expect(newStrokeTaper("fountain", 0.2, 0.3)).toEqual({ taperStart: 0.2, taperEnd: 0.3 });
		expect(newStrokeTaper("pen", 0, 0)).toEqual({});
		expect(newStrokeTaper("marker", 1, 1)).toEqual({});
		expect(newStrokeTaper("highlighter", 1, 1)).toEqual({});
		expect(newStrokeTaper("shape", 1, 1)).toEqual({});
	});
});

describe("format v25: the fields", () => {
	it("is a document of the current version", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(25);
		expect(parsed(serialize(docWith([]))).doc.version).toBe(CURRENT_VERSION);
	});

	it("writes the taper after the opacity and before the points, and reads it back byte for byte", () => {
		const doc = docWith([stroke("s1", { taperStart: 0.5, taperEnd: 1 }), stroke("s2", { opacity: 0.5, taperEnd: 0.05 }), stroke("s3", { tool: "brush", taperStart: 0.3 }), stroke("s4")]);
		const checked = serializeChecked(doc, true);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.text).toMatch(/"id":"s1","tool":"pen","color":"#1e1e1e","width":2,"render":2,"taperStart":0.5,"taperEnd":1,"points":/);
		expect(checked.text).toMatch(/"render":2,"opacity":0.5,"taperEnd":0.05,"points":/);
		expect(checked.text).toMatch(/"id":"s3","tool":"brush".*"taperStart":0.3,"points":/);
		// A stroke without one writes nothing: a notebook that never uses it is what v24 wrote.
		const s4 = checked.text.split("\n").find((l) => l.includes('"id":"s4"'))!;
		expect(s4).not.toContain("taper");
		const back = parsed(checked.text).doc.pages[0]!;
		expect(back.strokes.map((s) => [s.taperStart, s.taperEnd])).toEqual([[0.5, 1], [undefined, 0.05], [0.3, undefined], [undefined, undefined]]);
		expect(serialize(parsed(checked.text).doc)).toBe(checked.text);
	});

	it("a notebook without any taper is byte for byte what it was", () => {
		const plain = docWith([stroke("s1"), stroke("s2", { opacity: 0.4 })]);
		expect(serialize(plain)).not.toContain("taper");
	});

	it("the line pens can have one, and no other tool", () => {
		for (const tool of TOOLS) {
			const render = tool === "pen" || tool === "highlighter" || tool === "shape" ? RENDER_INK : RENDER_INK;
			const r = serializeChecked(docWith([stroke("s", { tool, render, taperStart: 0.25, taperEnd: 1 })]), true);
			expect(r.ok, tool).toBe(tool === "pen" || tool === "fountain" || tool === "brush");
		}
		// ... and not on the old geometry.
		expect(serializeChecked(docWith([stroke("s", { render: 1, taperEnd: 0.5 })]), true).ok).toBe(false);
	});

	it("refuses to write a malformed one (strict)", () => {
		for (const value of [0, 0.049, 1.01, -0.5, Number.NaN, Infinity, "0.5" as unknown as number]) {
			expect(serializeChecked(docWith([stroke("s", { taperStart: value })]), true).ok, `start ${String(value)}`).toBe(false);
			expect(serializeChecked(docWith([stroke("s", { taperEnd: value })]), true).ok, `end ${String(value)}`).toBe(false);
		}
	});

	it("checkContent (the History guard) refuses a step that would make the notebook unsavable", () => {
		expect(checkContent(docWith([stroke("s", { taperEnd: 0 })]))).toMatch(/taperEnd/);
		expect(checkContent(docWith([stroke("s", { tool: "marker", taperStart: 0.5 })]))).toMatch(/taperStart/);
		expect(checkContent(docWith([stroke("s", { taperStart: 0.5, taperEnd: 0.5 })]))).toBeNull();
	});

	it("reads leniently: a value outside the range, not a number, or on a stroke that cannot taper is dropped and counted, the stroke stays", () => {
		const raw = parseRaw(serialize(docWith([stroke("s1", { taperStart: 0.5, taperEnd: 0.5 }), stroke("s2", { taperStart: 0.5, taperEnd: 0.5 }), stroke("s3", { opacity: 0.5, taperEnd: 0.5 }), stroke("s4", { taperStart: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 0, "taperStart"], 7);
		setAt(raw, ["pages", 0, "strokes", 0, "taperEnd"], 0);
		setAt(raw, ["pages", 0, "strokes", 1, "taperStart"], "half");
		setAt(raw, ["pages", 0, "strokes", 2, "taperEnd"], null);
		setAt(raw, ["pages", 0, "strokes", 3, "tool"], "marker");
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(5);
		const page = r.doc.pages[0]!;
		expect(page.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
		expect(page.strokes.map((s) => [s.taperStart, s.taperEnd])).toEqual([[undefined, undefined], [undefined, 0.5], [undefined, undefined], [undefined, undefined]]);
		// Everything else of the stroke is kept.
		expect(page.strokes[2]!.opacity).toBe(0.5);
		expect(page.strokes[3]!.tool).toBe("marker");
		expect(page.strokes[0]!.points).toHaveLength(40);
	});

	it("a lenient read of a pen of the old geometry drops its taper", () => {
		const raw = parseRaw(serialize(docWith([stroke("s1", { taperEnd: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 0, "render"], 1);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(1);
		expect(r.doc.pages[0]!.strokes[0]!.taperEnd).toBeUndefined();
	});
});

describe("format v25: migration from v24", () => {
	it("changes nothing but the version of a valid v24 document", () => {
		const raw = v24Raw();
		const migrated = MIGRATIONS[24]!(raw);
		expect(migrated).toEqual({ ...raw, version: 25 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("drops a stray taper key of a v24 file (a v24 reader ignored it)", () => {
		const raw = v24Raw();
		const page = (raw.pages as Array<Record<string, unknown>>)[0]!;
		const first = (page.strokes as Array<Record<string, unknown>>)[0]!;
		first.taperStart = 0.5;
		first.taperEnd = 1;
		const migrated = MIGRATIONS[24]!(raw);
		const ms = ((migrated.pages as Array<Record<string, unknown>>)[0]!.strokes as Array<Record<string, unknown>>)[0]!;
		expect("taperStart" in ms).toBe(false);
		expect("taperEnd" in ms).toBe(false);
		// The input is not touched.
		expect(first.taperStart).toBe(0.5);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(24);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.taperStart).toBeUndefined();
	});

	it("reads a v24 file and writes it as v25", () => {
		const r = parsed(JSON.stringify(v24Raw()));
		expect(r.migratedFrom).toBe(24);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(CURRENT_VERSION);
	});

	it("reads files of every older version through the chain", () => {
		for (const version of [21, 22, 23]) {
			const raw = v24Raw();
			setAt(raw, ["version"], version);
			const r = parsed(JSON.stringify(raw));
			expect(r.migratedFrom, String(version)).toBe(version);
			expect(r.doc.version).toBe(CURRENT_VERSION);
		}
	});

	it("opens a file of a newer format read-only (it is not parsed, so it is never rewritten)", () => {
		const raw = parseRaw(serialize(docWith([stroke("s", { taperEnd: 0.5 })])));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("stages a large v25 file that uses a taper and a large v24 file, and writes them back", () => {
		const doc = stressDocument(6000, 3, 7);
		const plain = serialize(doc);
		const first = doc.pages[0]!.strokes[0]!;
		const second = doc.pages[1]!.strokes[1]!;
		doc.pages[0]!.strokes[0] = Object.freeze({ ...first, tool: "pen", render: RENDER_INK, taperStart: 0.4 });
		doc.pages[1]!.strokes[1] = Object.freeze({ ...second, tool: "pen", render: RENDER_INK, taperEnd: 0.8 });
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
		// The same text as a v24 file: the taper keys mean nothing there, so the pages are read without them.
		const old = text.replace(`"version": ${CURRENT_VERSION}`, '"version": 24');
		const stagedOld = parseStaged(old, 0);
		expect(stagedOld).toBeInstanceOf(StagedParse);
		const r24 = (stagedOld as StagedParse).finish();
		expect(r24.ok).toBe(true);
		if (r24.ok) {
			expect(r24.migratedFrom).toBe(24);
			expect(r24.dropped).toBeUndefined();
			const back = serialize(r24.doc);
			expect(back).not.toContain("taper");
			expect(back.length).toBeLessThan(text.length);
		}
		expect(plain).not.toContain("taper");
	});
});

describe("format v25: repair, merge and copies", () => {
	it("repair keeps a valid taper and drops an invalid one", () => {
		const raw = parseRaw(serialize(docWith([stroke("s1", { taperStart: 0.5, taperEnd: 0.25 }), stroke("s2", { taperStart: 0.5, taperEnd: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 1, "taperEnd"], 3);
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.strokes.map((s) => [s.taperStart, s.taperEnd])).toEqual([[0.5, 0.25], [0.5, undefined]]);
	});

	it("repair drops a taper of a tool that cannot have one", () => {
		const raw = parseRaw(serialize(docWith([stroke("s1", { taperEnd: 0.25 })])));
		setAt(raw, ["pages", 0, "strokes", 0, "tool"], "marker");
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.pages[0]!.strokes[0]!.taperEnd).toBeUndefined();
	});

	it("merge: a different taper is a different stroke, the same one is the same stroke", () => {
		expect(strokeContentKey(stroke("a", { taperEnd: 0.5 }))).toBe(strokeContentKey(stroke("b", { taperEnd: 0.5 })));
		expect(strokeContentKey(stroke("a", { taperEnd: 0.5 }))).not.toBe(strokeContentKey(stroke("a", { taperEnd: 0.6 })));
		expect(strokeContentKey(stroke("a", { taperEnd: 0.5 }))).not.toBe(strokeContentKey(stroke("a", { taperStart: 0.5 })));
		expect(strokeContentKey(stroke("a", { taperEnd: 0.5 }))).not.toBe(strokeContentKey(stroke("a")));
		const plan = planMerge(docWith([stroke("a")]), docWith([stroke("b", { taperEnd: 0.5 })]));
		expect(plan.command).not.toBeNull();
	});

	it("a copy of a stroke keeps its taper (duplicate, paste, move to another page, restore)", () => {
		expect(copyStroke(stroke("a", { taperStart: 0.4, taperEnd: 0.9 }), "b")).toMatchObject({ id: "b", taperStart: 0.4, taperEnd: 0.9 });
		const plain = copyStroke(stroke("a"), "b");
		expect("taperStart" in plain).toBe(false);
		expect("taperEnd" in plain).toBe(false);
	});

	it("the version diff sees a taper change", () => {
		expect(compareStroke(stroke("a"), stroke("a", { taperEnd: 0.5 }))).toBe("changed");
		expect(compareStroke(stroke("a", { taperStart: 0.5 }), stroke("a", { taperEnd: 0.5 }))).toBe("changed");
		expect(compareStroke(stroke("a", { taperEnd: 0.5 }), stroke("a", { taperEnd: 0.5 }))).toBe("same");
	});

	it("the thumbnail signature changes with the taper, and a page without one keeps its signature", () => {
		const make = (extra: Partial<Stroke>): Page => {
			const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
			p.strokes = [stroke("s", extra)];
			return p;
		};
		const base = pageSignature(make({}));
		expect(pageSignature(make({ taperEnd: 0.5 }))).not.toBe(base);
		expect(pageSignature(make({ taperStart: 0.5 }))).not.toBe(pageSignature(make({ taperEnd: 0.5 })));
		expect(base).not.toContain("t0");
	});
});

describe("taper: the geometry of the engine", () => {
	const pts = row(80, 2); // 158 pt long
	const plain = radii(pts, 2, "pen");

	it("an untapered stroke is exactly what it always was (also when the taper is 0 or absent)", () => {
		expect(radii(pts, 2, "pen", { start: 0, end: 0 })).toEqual(plain);
		expect(radii(pts, 2, "pen", undefined)).toEqual(plain);
	});

	it("a start taper grows from a tip to the full size along the stroke, and nothing past it changes", () => {
		const t = radii(pts, 2, "pen", { start: 0.5, end: 0 });
		const length = taperLength(0.5, 2);
		expect(t.r[0]!).toBeCloseTo(plain.r[0]! * TAPER_TIP, 5);
		for (let i = 1; i < t.r.length; i++) {
			const d = t.x[i]! - t.x[0]!;
			if (d >= length + 4) {
				expect(t.r[i]).toBeCloseTo(plain.r[i]!, 9);
				break;
			}
			// Along the taper the radius never shrinks and stays under the full one.
			expect(t.r[i]!).toBeGreaterThanOrEqual(t.r[i - 1]! - 1e-9);
			expect(t.r[i]!).toBeLessThanOrEqual(plain.r[i]! + 1e-9);
		}
		// The last node is untouched.
		expect(t.r[t.r.length - 1]).toBeCloseTo(plain.r[plain.r.length - 1]!, 9);
	});

	it("an end taper shrinks the last nodes to a tip and leaves the rest alone", () => {
		const t = radii(pts, 2, "pen", { start: 0, end: 0.5 });
		const n = t.r.length;
		expect(t.r[n - 1]!).toBeCloseTo(plain.r[n - 1]! * TAPER_TIP, 5);
		expect(t.r[0]).toBeCloseTo(plain.r[0]!, 9);
		expect(t.r[Math.floor(n / 2)]).toBeCloseTo(plain.r[Math.floor(n / 2)]!, 9);
		const length = taperLength(0.5, 2);
		const endX = t.x[n - 1]!;
		for (let i = n - 2; i >= 0; i--) {
			const d = endX - t.x[i]!;
			if (d >= length) {
				expect(t.r[i]).toBeCloseTo(plain.r[i]!, 9);
				break;
			}
			expect(t.r[i]!).toBeGreaterThanOrEqual(t.r[i + 1]! - 1e-9);
		}
	});

	it("a longer taper reaches further, and it is a length in widths (twice the width, twice the length)", () => {
		const reach = (taper: number, width: number): number => {
			const r = radii(pts, width, "pen", { start: taper, end: 0 });
			const p = radii(pts, width, "pen");
			let last = 0;
			for (let i = 0; i < r.r.length; i++) if (Math.abs(r.r[i]! - p.r[i]!) > 1e-6) last = r.x[i]! - r.x[0]!;
			return last;
		};
		expect(reach(1, 2)).toBeGreaterThan(reach(0.5, 2));
		expect(reach(0.5, 4)).toBeGreaterThan(reach(0.5, 2) * 1.8);
		expect(reach(0.5, 4)).toBeLessThan(reach(0.5, 2) * 2.2);
	});

	it("the pen, the fountain pen and the brush all taper", () => {
		for (const tool of ["pen", "fountain", "brush"] as const) {
			const base = radii(pts, 3, tool);
			const t = radii(pts, 3, tool, { start: 0.6, end: 0.6 });
			expect(t.r[0]!, tool).toBeLessThan(base.r[0]!);
			expect(t.r[t.r.length - 1]!, tool).toBeLessThan(base.r[base.r.length - 1]!);
			expect(t.r[Math.floor(t.r.length / 2)]!, tool).toBeCloseTo(base.r[Math.floor(base.r.length / 2)]!, 9);
		}
	});

	it("a short stroke shortens the taper to meet at the middle, a dot stays a dot", () => {
		const short = row(8, 2); // 14 pt: shorter than twice a 0.5 taper (12 pt each)
		const base = radii(short, 2, "pen");
		const t = radii(short, 2, "pen", { start: 0.5, end: 0.5 });
		expect(t.r.length).toBe(base.r.length);
		const mid = Math.floor(t.r.length / 2);
		expect(t.r[0]!).toBeLessThan(base.r[0]! * 0.1);
		expect(t.r[t.r.length - 1]!).toBeLessThan(base.r[base.r.length - 1]! * 0.1);
		// The middle is (nearly) the full size: the two halves each taper over half the stroke.
		expect(t.r[mid]!).toBeGreaterThan(base.r[mid]! * 0.8);
		const dot = radii([[10, 10, 0.5]], 2, "pen", { start: 1, end: 1 });
		expect(dot.r).toEqual(radii([[10, 10, 0.5]], 2, "pen").r);
		const two = radii([[10, 10, 0.5], [10.4, 10, 0.5]], 2, "pen", { start: 1, end: 1 });
		expect(two.r.every((r) => r > 0)).toBe(true);
	});

	it("the wet ink thins from the first sample: the radii built point by point are the committed ones before the pen lifts", () => {
		const taper = { start: 0.5, end: 0.5 };
		const live = new InkBuilder();
		live.reset("pen", 2, 45, taper);
		for (const p of pts) live.add(p[0], p[1], p[2]);
		const beforeLift = Array.from(live.nr.subarray(0, live.nodeCount));
		const finalStart = live.nodeCount;
		live.finish();
		expect(live.nodeCount).toBeGreaterThanOrEqual(finalStart);
		const committed = radii(pts, 2, "pen", taper);
		expect(live.nodeCount).toBe(committed.r.length);
		// The start (long done by the time the end is reached) is what the committed stroke has, node for node; the end is thinned by the lift only.
		const startNodes = Math.floor(beforeLift.length / 2);
		for (let i = 0; i < startNodes; i++) expect(beforeLift[i], `node ${i}`).toBeCloseTo(committed.r[i]!, 9);
		for (let i = 0; i < committed.r.length; i++) expect(live.nr[i], `node ${i}`).toBeCloseTo(committed.r[i]!, 9);
	});

	it("the same builder is reused for strokes with and without a taper", () => {
		const g = new InkBuilder();
		const a = InkBuilder.fromPoints(pts, 2, "pen", g, undefined, { start: 0.5, end: 0.5 });
		const tapered = Array.from(a.nr.subarray(0, a.nodeCount));
		const b = InkBuilder.fromPoints(pts, 2, "pen", g);
		expect(Array.from(b.nr.subarray(0, b.nodeCount))).toEqual(plain.r);
		const c = InkBuilder.fromPoints(pts, 2, "pen", g, undefined, { start: 0.5, end: 0.5 });
		expect(Array.from(c.nr.subarray(0, c.nodeCount))).toEqual(tapered);
	});

	it("a long stroke with many points tapers (the arrays grow)", () => {
		const long = row(900, 1);
		const t = radii(long, 2, "pen", { start: 1, end: 1 });
		const base = radii(long, 2, "pen");
		expect(t.r.length).toBe(base.r.length);
		expect(t.r[0]!).toBeLessThan(base.r[0]! * 0.1);
		expect(t.r[450]!).toBeCloseTo(base.r[450]!, 9);
	});
});

describe("taper: the same shape in every render and export path", () => {
	const tapered = stroke("t", { taperStart: 0.6, taperEnd: 0.6 });
	const plainStroke = stroke("p");

	it("the SVG path, the committed path and the stroke-shape path are one", () => {
		const sink = new SvgPathSink();
		inkPath(sink, tapered.points, tapered.width, tapered.tool, tapered.nib, strokeTaper(tapered));
		expect(strokeSvgPath(tapered)).toBe(sink.d);
		expect(strokeSvgPath(tapered)).not.toBe(strokeSvgPath(plainStroke));
		// A stroke that cannot taper ignores the fields.
		expect(strokeSvgPath({ ...tapered, tool: "marker" })).toBe(strokeSvgPath({ ...plainStroke, tool: "marker" }));
		expect(strokeSvgPath({ ...tapered, render: 1 })).toBe(strokeSvgPath({ ...plainStroke, render: 1 }));
	});

	const page = (strokes: Stroke[]): Page => {
		const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
		p.id = "p1";
		p.strokes = strokes;
		return p;
	};

	it("the SVG export draws the taper (and a page without one is unchanged)", () => {
		const svg = pageToSvg(page([tapered]));
		expect(svg).toContain(`d="${strokeSvgPath(tapered)}"`);
		expect(pageToSvg(page([tapered]))).not.toBe(pageToSvg(page([plainStroke])));
		expect(pageToSvg(page([plainStroke]))).toContain(`d="${strokeSvgPath(plainStroke)}"`);
	});

	it("the PDF export draws the taper, and ignores it on a stroke that cannot taper", () => {
		const text = (strokes: Stroke[]) => new TextDecoder("latin1").decode(pagesToPdf([page(strokes)], { images: () => [] }));
		expect(text([tapered])).not.toBe(text([plainStroke]));
		expect(text([{ ...tapered, tool: "marker" }])).toBe(text([{ ...plainStroke, tool: "marker" }]));
		expect(text([{ ...tapered, render: 1 }])).toBe(text([{ ...plainStroke, render: 1 }]));
		// The same stroke twice gives the same drawing (the shared builder carries nothing over).
		expect(text([tapered, plainStroke])).toBe(text([tapered, plainStroke]));
	});

	describe("the raster (PNG, area export, excerpts, hand-in)", () => {
		const paths: string[] = [];
		beforeEach(() => {
			paths.length = 0;
			vi.stubGlobal("Path2D", class { constructor(readonly d?: string) { if (d !== undefined) paths.push(d); } });
		});
		afterEach(() => vi.unstubAllGlobals());
		function ctx(): CanvasRenderingContext2D {
			const state: Record<string, unknown> = { fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
			return new Proxy(state, {
				get(t, k: string) {
					if (k in t) return t[k];
					return () => undefined;
				},
				set(t, k: string, v) {
					t[k] = v;
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		}

		it("fills the same outline as the SVG", () => {
			drawPageRaster(ctx(), page([tapered, plainStroke]), 1, { background: null, images: new Map() });
			expect(paths).toContain(strokeSvgPath(tapered));
			expect(paths).toContain(strokeSvgPath(plainStroke));
		});
	});

	it("the level of detail keeps the taper (the thumbnails and the zoomed-out page)", () => {
		const long = stroke("long", { points: row(120, 2), taperStart: 1, taperEnd: 1 });
		const nodes = lodNodes(long.points, long.width, long.tool, 2, undefined, strokeTaper(long))!;
		const plainNodes = lodNodes(long.points, long.width, long.tool, 2)!;
		expect(nodes).not.toBeNull();
		// First and last kept nodes are the tips.
		expect(nodes[2]!).toBeLessThan(plainNodes[2]! * 0.2);
		expect(nodes[nodes.length - 1]!).toBeLessThan(plainNodes[plainNodes.length - 1]! * 0.2);
		expect(lodSvgPath(long, long.width, 2)).not.toBe(lodSvgPath({ ...long, taperStart: undefined, taperEnd: undefined }, long.width, 2));
		expect(lodSvgPath(long, long.width, 0)).toBe(strokeSvgPath(long));
	});
});

describe("taper: cuts, joins and copies", () => {
	it("a piece of a cut stroke keeps the taper of an end only when it still reaches that end", () => {
		const s = stroke("s", { taperStart: 0.5, taperEnd: 0.7 });
		const pts = s.points;
		const runs = [pts.slice(0, 10), pts.slice(14, 25), pts.slice(30)];
		const pieces = strokePieces({ strokes: [s], elements: [] }, s, runs, (() => { let n = 0; return () => `n${++n}`; })());
		expect(pieces.map((p) => [p.taperStart, p.taperEnd])).toEqual([[0.5, undefined], [undefined, undefined], [undefined, 0.7]]);
		const whole = strokePieces({ strokes: [s], elements: [] }, s, [pts.slice()], () => "w");
		expect([whole[0]!.taperStart, whole[0]!.taperEnd]).toEqual([0.5, 0.7]);
		expect(pieceTaper(s, pts.slice(5, 10))).toEqual({});
	});

	it("a cut by a redaction box does the same", () => {
		const s = stroke("s", { taperStart: 0.5, taperEnd: 0.7 });
		const pieces = cutStroke(s, [{ page: "p1", x: 40, y: 0, width: 20, height: 100 } as never]);
		expect(pieces.length).toBe(2);
		expect([pieces[0]!.taperStart, pieces[0]!.taperEnd]).toEqual([0.5, undefined]);
		expect([pieces[1]!.taperStart, pieces[1]!.taperEnd]).toEqual([undefined, 0.7]);
	});

	it("joining broken strokes keeps the start of the first and the end of the last", () => {
		const a = stroke("a", { points: row(10, 2), taperStart: 0.4, taperEnd: 0.9 });
		const b = stroke("b", { points: row(10, 2).map((p): Point => [p[0] + 20, p[1], p[2]]), taperStart: 0.2, taperEnd: 0.6 });
		const joined = joinStrokes(a, [b]);
		expect([joined.taperStart, joined.taperEnd]).toEqual([0.4, 0.6]);
		const plainEnd = joinStrokes(a, [stroke("c", { points: b.points })]);
		expect([plainEnd.taperStart, plainEnd.taperEnd]).toEqual([0.4, undefined]);
		const single = joinStrokes(a, []);
		expect([single.taperStart, single.taperEnd]).toEqual([0.4, 0.9]);
	});
});

describe("taper: pens that keep it", () => {
	it("a favourite pen keeps the taper of a line pen, and no other pen", () => {
		const base = { penColor: "#112233", penWidth: 2, highlighterColor: "#facc15", highlighterWidth: 14 };
		const fav = captureFavourite({ ...base, tool: "pen", penKind: "pen", penTaperStart: 0.5, penTaperEnd: 0.25 });
		expect(fav).toMatchObject({ tool: "pen", taperStart: 0.5, taperEnd: 0.25 });
		expect(captureFavourite({ ...base, tool: "pen", penKind: "fountain", nibAngle: 100, penTaperEnd: 1 })).toMatchObject({ kind: "fountain", nib: 100, taperEnd: 1 });
		expect("taperStart" in captureFavourite({ ...base, tool: "pen", penKind: "brush", penTaperStart: 0 })).toBe(false);
		const marker = captureFavourite({ ...base, tool: "pen", penKind: "marker", penTaperStart: 0.5, penTaperEnd: 0.5 });
		expect("taperStart" in marker).toBe(false);
		const hl = captureFavourite({ ...base, tool: "highlighter", penTaperStart: 0.5 });
		expect("taperStart" in hl).toBe(false);
		expect(favouritePatch(fav)).toMatchObject({ penTaperStart: 0.5, penTaperEnd: 0.25 });
		expect(favouritePatch({ tool: "pen", color: "#112233", width: 2 })).toMatchObject({ penTaperStart: 0, penTaperEnd: 0 });
		expect(sameFavourite(fav, { ...fav })).toBe(true);
		expect(sameFavourite(fav, { ...fav, taperEnd: 0.5 })).toBe(false);
		expect(sameFavourite({ tool: "pen", color: "#112233", width: 2 }, fav)).toBe(false);
	});

	it("a saved pen is read leniently: a taper that does not fit or is on a pen that cannot have one is left out", () => {
		expect(validPen({ tool: "pen", color: "#112233", width: 2, taperStart: 0.5, taperEnd: 1 })).toMatchObject({ taperStart: 0.5, taperEnd: 1 });
		expect(validPen({ tool: "pen", color: "#112233", width: 2, kind: "brush", taperEnd: 0.3 })).toMatchObject({ kind: "brush", taperEnd: 0.3 });
		const odd = validPen({ tool: "pen", color: "#112233", width: 2, taperStart: 0, taperEnd: "long" })!;
		expect("taperStart" in odd).toBe(false);
		expect("taperEnd" in odd).toBe(false);
		expect("taperEnd" in validPen({ tool: "pen", color: "#112233", width: 2, kind: "marker", taperEnd: 0.5 })!).toBe(false);
		expect("taperEnd" in validPen({ tool: "highlighter", color: "#facc15", width: 14, taperEnd: 0.5 })!).toBe(false);
	});

	it("the style eyedropper takes the taper of the stroke, and none from a stroke that cannot have one", () => {
		expect(styleOfStroke({ tool: "pen", color: "#112233", width: 2, render: RENDER_INK, taperStart: 0.4, taperEnd: 0.8 })).toMatchObject({ penTaperStart: 0.4, penTaperEnd: 0.8 });
		expect(styleOfStroke({ tool: "brush", color: "#112233", width: 2, render: RENDER_INK, taperEnd: 0.8 })).toMatchObject({ penKind: "brush", penTaperStart: 0, penTaperEnd: 0.8 });
		expect(styleOfStroke({ tool: "pen", color: "#112233", width: 2 })).toMatchObject({ penTaperStart: 0, penTaperEnd: 0 });
		expect(styleOfStroke({ tool: "marker", color: "#112233", width: 6, taperEnd: 0.8 })).toMatchObject({ penKind: "marker", penTaperStart: 0, penTaperEnd: 0 });
		expect(styleOfStroke({ tool: "shape", color: "#112233", width: 6, taperEnd: 0.8 })).toMatchObject({ penKind: "pen", penTaperEnd: 0 });
	});

	it("every string of the taper controls exists in English and in Italian", () => {
		for (const key of ["taper.title", "taper.start", "taper.end", "taper.reset", "taper.off", "taper.value.start", "taper.value.end", "help.taper"] as const) {
			expect(en[key], key).toBeTruthy();
			expect(it_[key], key).toBeTruthy();
		}
	});
});
