/**
 * Study tape (0.29, #10): the fixes of the independent review (T1–T9). The erasers never change what a hidden tape covers (tested against
 * all the hidden tapes together), the selection takes covered ink with the rest, and the small fixes (hit order, hand-in, redaction slivers,
 * repair of an older-labelled file).
 */
import { describe, expect, it } from "vitest";
import viewSrc from "../src/view/notebook-view.ts?raw";
import { createDocument, createStroke } from "../src/model/document";
import { freezeStroke, serialize } from "../src/model/serialize";
import { History } from "../src/model/history";
import { repairNotebookText } from "../src/model/repair";
import { isBlankForHandIn } from "../src/model/hand-in";
import { expandToGroups } from "../src/model/groups";
import { tapesOf } from "../src/model/tape";
import type { NotebookDocument, Page, Point, Stroke, TapeElement, TextElement } from "../src/model/types";
import { boxTouchesTapes, elementTouchesTapes, strokeTouchesTapes } from "../src/ink/tape-guard";
import { cutOutsidePolygon, eraseAreaCommand } from "../src/ink/erase-area";
import { scribbleEraseSteps } from "../src/ink/scribble";
import { hitElement } from "../src/ink/elements";
import { strokesInLasso } from "../src/ink/lasso";
import { redactPage } from "../src/ink/redact";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { line } from "./helpers";
import { parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-10T10:00:00.000Z";

function tape(id: string, extra: Partial<TapeElement> = {}): TapeElement {
	return Object.freeze({ id, type: "tape", x: 100, y: 100, width: 100, height: 40, color: "#8fd3bf", ...extra });
}

function withId(s: Stroke, id: string): Stroke {
	return freezeStroke({ ...s, id });
}

function docWith(elements: Page["elements"], strokes: Stroke[] = []): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes = strokes;
	if (elements && elements.length > 0) page.elements = elements;
	return doc;
}

/** A square lasso around (x0, y0)–(x1, y1). */
const square = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe("T1: what a hidden tape covers, tested against all the hidden tapes together", () => {
	const a = tape("a");
	const b = tape("b", { x: 200 }); // right next to a: together they cover 100..300 × 100..140

	it("a stroke covered only by two tapes together, one partly covered and one crossing a corner are under tape; ink beside is not", () => {
		const across = line(110, 120, 290, 120);
		expect(strokeTouchesTapes(across, [a, b])).toBe(true);
		expect(strokeTouchesTapes(across, [a])).toBe(true);
		expect(strokeTouchesTapes(line(150, 120, 400, 120), [a, b])).toBe(true);
		// A two-point line whose ends are both outside, crossing the tape.
		const cross = freezeStroke(createStroke("#000000", 2, [[50, 120, 0.5], [350, 120, 0.5]]));
		expect(strokeTouchesTapes(cross, [a])).toBe(true);
		expect(strokeTouchesTapes(line(110, 200, 290, 200), [a, b])).toBe(false);
		expect(strokeTouchesTapes(line(10, 10, 90, 90), [a, b])).toBe(false);
		// A diagonal whose box overlaps the tape but whose line passes beside its corner.
		expect(strokeTouchesTapes(line(40, 140, 140, 40), [a])).toBe(false);
		expect(strokeTouchesTapes(line(110, 120, 290, 120), [])).toBe(false);
	});

	it("a filled shape counts by its box (the fill covers the inside), a dot by its reach", () => {
		const ring = freezeStroke({ ...createStroke("#000000", 2, [[60, 60, 0.5], [340, 60, 0.5], [340, 180, 0.5], [60, 180, 0.5], [60, 60, 0.5]]), tool: "shape", fill: "#ff0000" });
		expect(strokeTouchesTapes(ring, [a])).toBe(true);
		const { fill: _fill, ...open } = ring;
		void _fill;
		expect(strokeTouchesTapes(open, [a])).toBe(false);
		const dot = freezeStroke(createStroke("#000000", 4, [[99, 99, 0.5]]));
		expect(strokeTouchesTapes(dot, [a])).toBe(true);
	});

	it("an element counts when any part of it is under a tape; a tape itself never does", () => {
		const text: TextElement = { id: "t", type: "text", x: 250, y: 110, width: 200, text: "answer", fontSize: 14, color: "#000000" };
		expect(elementTouchesTapes(text, [a, b])).toBe(true);
		expect(elementTouchesTapes({ ...text, x: 320 }, [a, b])).toBe(false);
		expect(elementTouchesTapes(b, [a, b])).toBe(false);
		expect(boxTouchesTapes({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, [a])).toBe(false); // touching the corner only
	});

	it("the area eraser with 'removes text and images' leaves every stroke and element under the tapes whole, and erases the rest", () => {
		const covered = withId(line(110, 120, 290, 120), "covered"); // under a and b together
		const partly = withId(line(150, 130, 400, 130), "partly");
		const free = withId(line(110, 300, 290, 300), "free");
		const text: TextElement = { id: "t", type: "text", x: 210, y: 105, width: 60, text: "42", fontSize: 14, color: "#000000" };
		const other: TextElement = { id: "o", type: "text", x: 120, y: 280, width: 60, text: "q", fontSize: 14, color: "#000000" };
		const doc = docWith([a, b, text, other], [covered, partly, free]);
		const page = doc.pages[0]!;
		const tapes = [a, b];
		const poly = square(0, 0, 500, 500);
		const cmd = eraseAreaCommand(page, poly, {
			filter: { kind: "all", color: "#000000" }, includeElements: true,
			skip: (s) => strokeTouchesTapes(s, tapes), skipElement: (el) => elementTouchesTapes(el, tapes),
		});
		expect(cmd).not.toBeNull();
		const history = new History(() => doc);
		expect(history.execute(cmd!)).toBe(true);
		expect(page.strokes.map((s) => s.id)).toEqual(["covered", "partly"]);
		expect(page.strokes[1]!.points).toEqual(partly.points); // not cut: the hidden part stays
		expect((page.elements ?? []).map((e) => e.id).sort()).toEqual(["t"]); // the tapes themselves are visible: they go with the setting on
		// Without the guard the same gesture would have cut the covered strokes (what the review found).
		expect(cutOutsidePolygon(covered, poly)).toEqual([]);
	});

	it("the scribble eraser spares ink a hidden tape reaches over", () => {
		const zig: Point[] = [];
		const vertices: Array<[number, number]> = [];
		for (let i = 0; i <= 7; i++) vertices.push([150 + (i % 2 === 0 ? -40 : 40), 120 + (i - 3.5) * 4]);
		for (let i = 1; i < vertices.length; i++) {
			const [ax, ay] = vertices[i - 1]!;
			const [bx, by] = vertices[i]!;
			const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
			for (let k = i === 1 ? 0 : 1; k <= n; k++) zig.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
		}
		const under = withId(line(150, 108, 152, 132), "under");
		const scribble = freezeStroke({ ...createStroke("#111111", 2, zig), id: "scr" });
		const page = docWith([a], [under]).pages[0]!;
		expect(scribbleEraseSteps(page, scribble, 500)).not.toBeNull();
		expect(scribbleEraseSteps(page, scribble, 500, undefined, {}, false, null, (s) => strokeTouchesTapes(s, [a]))).toBeNull();
	});
});

describe("T2: the selection takes covered ink with the rest", () => {
	it("a lasso around a tape and its answer selects the answer, and a group with the tape brings it along", () => {
		const t = tape("t", { group: "g" });
		const answer = freezeStroke({ ...line(110, 120, 190, 120), id: "ans", group: "g" });
		const question = withId(line(110, 60, 190, 60), "q");
		const page = docWith([t], [question, answer]).pages[0]!;
		// The view passes all the ink in view (no tape filter): the covered answer is in the lasso.
		expect(strokesInLasso(page.strokes, square(90, 40, 210, 160)).map((s) => s.id)).toEqual(["q", "ans"]);
		// Picking the tape picks its group, the covered answer included.
		const sel = expandToGroups(page, { strokes: [], elements: [t] }, page.strokes);
		expect(sel.strokes.map((s) => s.id)).toEqual(["ans"]);
	});

	it("in the view only the erasers and the pen-start offers leave covered ink out; the selection paths use all the ink in view", () => {
		const src = viewSrc;
		const body = src.slice(src.indexOf("private inkInView(page: Page"), src.indexOf("private hidingTapesOf("));
		expect(body.length).toBeGreaterThan(0);
		expect(body).not.toMatch(/hidingTapes|strokeTouchesTapes|coveredByTape/);
		const uses = src.match(/this\.inkOutsideTapes\(/g) ?? [];
		expect(uses.length).toBe(3); // eraser, checkbox label offer, eyedropper
		expect(src).toContain("strokesInLasso(this.inkInView(page), lasso.points)");
		expect(src).toContain("expandToGroups(page, { strokes, elements }, this.inkInView(page, true))"); // `true`: strikedelete S4 completes groups with struck members
		expect(src).toContain("ink: (page) => this.inkInView(page)");
		expect(src).toContain("selectableItems(page, sel, this.inkInView(page, true))");
	});
});

describe("T3: tapes are a visual study aid, not redaction (said in both languages)", () => {
	it("the help of the mode and the export note say what a tape does not do, and the eraser says why it kept ink", () => {
		const note = "Study tapes only cover content visually; text under them can still be found in exported files. Use Redact to remove content from exports.";
		expect(en["tape.export.note"]).toBe(note);
		expect(en["tape.help.draw"]).toContain(note);
		expect(it_["tape.export.note"]).toContain("Oscura");
		expect(it_["tape.help.draw"]).toContain(it_["tape.export.note"]);
		expect(en["tape.erase.kept"].length).toBeGreaterThan(10);
		expect(it_["tape.erase.kept"]?.length ?? 0).toBeGreaterThan(10);
	});
});

describe("T4, T7, T8, T9: the small fixes", () => {
	it("T9: a tap picks a hidden tape first, but what is under a revealed tape before the tape", () => {
		const t = tape("t");
		const text: TextElement = { id: "x", type: "text", x: 110, y: 105, width: 60, text: "42", fontSize: 14, color: "#000000" };
		expect(hitElement([text, t], 120, 115, 0)).toBe(t);
		expect(hitElement([t, text], 120, 115, 0, undefined, false, () => false)).toBe(t);
		expect(hitElement([text, t], 120, 115, 0, undefined, false, (id) => id === "t")).toBe(text);
		expect(hitElement([text, t], 190, 135, 0, undefined, false, (id) => id === "t")).toBe(t); // nothing else there
	});

	it("T7: a page that holds only tapes is blank for the hand-in", () => {
		expect(isBlankForHandIn(docWith([tape("a")]).pages[0]!)).toBe(true);
		expect(isBlankForHandIn(docWith([tape("a")], [line(10, 10, 50, 10)]).pages[0]!)).toBe(false);
		const text: TextElement = { id: "x", type: "text", x: 10, y: 10, width: 60, text: "42", fontSize: 14, color: "#000000" };
		expect(isBlankForHandIn(docWith([tape("a"), text]).pages[0]!)).toBe(false);
	});

	it("T4: redaction keeps a tape sliver thinner than 0.5 pt, and still drops an area sliver", () => {
		const t = tape("t", { x: 100, y: 100, width: 100, height: 40 });
		const area = { id: "ar", type: "area" as const, x: 100, y: 300, width: 100, height: 40, color: "#ffee00" };
		const page = docWith([t, area]).pages[0]!;
		const out = redactPage(page, [{ x: 100.3, y: 90, width: 120, height: 60 }, { x: 100.3, y: 290, width: 120, height: 60 }]);
		const pieces = tapesOf(out);
		expect(pieces).toHaveLength(1);
		expect(pieces[0]!.width).toBeCloseTo(0.3);
		expect(pieces[0]!.x).toBe(100);
		expect((out.elements ?? []).filter((e) => e.type === "area")).toHaveLength(0);
	});

	it("T8: repairing a file labelled v26 that holds a tape drops the tape only: the page, its ink and its other elements stay", () => {
		const text: TextElement = { id: "x", type: "text", x: 10, y: 10, width: 60, text: "42", fontSize: 14, color: "#000000" };
		const doc = docWith([tape("a"), text], [withId(line(10, 10, 50, 10), "s1"), withId(line(10, 30, 50, 30), "s2")]);
		const raw = parseRaw(serialize(doc));
		setAt(raw, ["version"], 26);
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages[0]!;
		expect(page.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect((page.elements ?? []).map((e) => e.id)).toEqual(["x"]);
		expect(r.summary.elements.lost).toBeGreaterThanOrEqual(1);
		expect(r.summary.pages.lost).toBe(0);
	});
});
