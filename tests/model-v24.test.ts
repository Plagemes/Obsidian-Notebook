/**
 * Format v24: the opacity of ink, pictures and areas (#358) — the optional `opacity` (0.05 to 1) of a stroke of any pen, of an image and of an area: the
 * fields, the v23 -> v24 migration, lenient read and strict write, staged loading, repair, merge and copy, setting it from a selection as one undo
 * step, favourite pens, the eyedropper, and the look in every render and export path (the product with the pen's own translucency).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { planMerge, strokeContentKey } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { History } from "../src/model/history";
import { copyStroke } from "../src/model/pages";
import { compareStroke } from "../src/model/version-diff";
import { createArea } from "../src/model/area";
import { isOpacity, normaliseOpacity, OPACITY_MAX, OPACITY_MIN, opacityFromPercent, opacityOf, opacityPercent, scaledAlpha, withOpacity } from "../src/model/opacity";
import { CURRENT_VERSION, FORMAT_ID, TOOLS, type AreaElement, type ImageElement, type NotebookDocument, type Page, type PageElement, type Stroke, type TextElement } from "../src/model/types";
import { commonOpacity, opacityAbility, planOpacity, takesOpacity } from "../src/ink/restyle";
import { drawArea } from "../src/ink/area-render";
import { drawElement } from "../src/ink/renderer";
import { drawPageRaster } from "../src/ink/page-raster";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf, type PdfPlacedImage } from "../src/ink/export-pdf";
import { fillAlpha } from "../src/ink/shape-style";
import { HIGHLIGHTER_ALPHA, inkAlpha, MARKER_ALPHA } from "../src/ink/stroke-shape";
import { styleOfStroke } from "../src/ink/colour";
import { captureFavourite, favouritePatch, sameFavourite, validPen } from "../src/view/favourites";
import { pageSignature } from "../src/view/view-helpers";
import { ACTIONS, baseContext, canOpacity, isEnabled } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { describeCommand, titleForLabel } from "../src/model/history-describe";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { getAt, parseRaw, setAt } from "./raw-json";
import { line } from "./helpers";

const stamp = "2026-11-08T10:00:00.000Z";
const hex = "fedcba9876543210".repeat(4);

function stroke(id: string, extra: Partial<Stroke> = {}): Stroke {
	return Object.freeze({ ...line(10, 10, 80, 12, 6, 2), id, ...extra });
}

function area(id: string, extra: Partial<AreaElement> = {}): AreaElement {
	return Object.freeze({ id, type: "area", x: 40, y: 100, width: 300, height: 24, color: "#facc15", ...extra });
}

function image(id: string, extra: Partial<ImageElement> = {}): ImageElement {
	return Object.freeze({ id, type: "image", asset: hex, x: 20, y: 200, width: 120, height: 80, rotation: 0, ...extra });
}

function docWith(elements: PageElement[], strokes: Stroke[] = []): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.assets = { [hex]: { id: hex, kind: "image", path: `Notebooks/_assets/${hex}.png`, name: "scan.png", bytes: 10 } };
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes = strokes;
	if (elements.length > 0) page.elements = elements;
	return doc;
}

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function v23Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 23, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("opacity: the helpers", () => {
	it("accepts 0.05 to 1 and clamps and rounds what it is asked to store", () => {
		expect(isOpacity(OPACITY_MIN)).toBe(true);
		expect(isOpacity(OPACITY_MAX)).toBe(true);
		for (const bad of [0, 0.049, 1.001, -1, Number.NaN, Infinity, "0.5", null, undefined]) expect(isOpacity(bad), String(bad)).toBe(false);
		expect(normaliseOpacity(0.5)).toBe(0.5);
		expect(normaliseOpacity(0.123456)).toBe(0.12);
		expect(normaliseOpacity(0)).toBe(OPACITY_MIN);
		expect(normaliseOpacity(-3)).toBe(OPACITY_MIN);
		// Full strength is nothing to store.
		expect(normaliseOpacity(1)).toBeUndefined();
		expect(normaliseOpacity(7)).toBeUndefined();
		expect(normaliseOpacity(0.999)).toBeUndefined();
		expect(normaliseOpacity("x")).toBeUndefined();
		expect(normaliseOpacity(Number.NaN)).toBeUndefined();
	});

	it("reads an item without one (or an invalid one) as full strength", () => {
		expect(opacityOf({})).toBe(1);
		expect(opacityOf({ opacity: 0.4 })).toBe(0.4);
		expect(opacityOf({ opacity: 9 })).toBe(1);
		expect(opacityPercent(undefined)).toBe(100);
		expect(opacityPercent(0.35)).toBe(35);
		expect(scaledAlpha(0.35, { opacity: 0.5 })).toBeCloseTo(0.175, 10);
		expect(opacityFromPercent(47.6)).toBe(0.48);
		expect(opacityFromPercent(0)).toBe(0.05);
		expect(opacityFromPercent(400)).toBe(1);
	});

	it("withOpacity returns the same object when nothing changes and removes the key at full strength", () => {
		const s = stroke("s", { opacity: 0.5 });
		expect(withOpacity(s, 0.5)).toBe(s);
		expect(withOpacity(s, 0.6)).toMatchObject({ opacity: 0.6 });
		expect("opacity" in withOpacity(s, 1)).toBe(false);
		const plain = stroke("p");
		expect(withOpacity(plain, undefined)).toBe(plain);
		expect(withOpacity(plain, 1)).toBe(plain);
	});
});

describe("format v24: the fields", () => {
	it("is a document of the current version", () => {
		expect(CURRENT_VERSION).toBe(24);
		expect(parsed(serialize(docWith([]))).doc.version).toBe(24);
	});

	it("writes opacity after the shape style and before the points, and reads it back byte for byte", () => {
		const doc = docWith(
			[area("a", { opacity: 0.3 }), image("i", { opacity: 0.45, rotation: 0.5 })],
			[stroke("s1", { opacity: 0.5 }), stroke("s2", { tool: "shape", fill: "#2563eb", fillTint: true, dash: "dashed", opacity: 0.6 }), stroke("s3")],
		);
		const checked = serializeChecked(doc, true);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.text).toMatch(/"id":"s1","tool":"pen","color":"#1e1e1e","width":2,"render":1,"opacity":0.5,"points":/);
		expect(checked.text).toMatch(/"dash":"dashed","opacity":0.6,"points":/);
		expect(checked.text).toContain('"color":"#facc15","opacity":0.3}');
		expect(checked.text).toContain('"rotation":0.5,"opacity":0.45}');
		// A stroke without one writes nothing: a notebook that never uses it is what v23 wrote.
		const s3 = checked.text.split("\n").find((l) => l.includes('"id":"s3"'))!;
		expect(s3).not.toContain("opacity");
		const back = parsed(checked.text).doc.pages[0]!;
		expect(back.strokes.map((s) => s.opacity)).toEqual([0.5, 0.6, undefined]);
		expect(back.elements!.map((e) => (e as { opacity?: number }).opacity)).toEqual([0.3, 0.45]);
		expect(serialize(parsed(checked.text).doc)).toBe(checked.text);
	});

	it("every pen can have one, and 1 is valid too", () => {
		for (const tool of TOOLS) {
			const render = tool === "pen" || tool === "highlighter" || tool === "shape" ? 1 : 2;
			const doc = docWith([], [stroke("s", { tool, render, opacity: 0.25 }), stroke("t", { tool, render, opacity: 1 })]);
			const r = serializeChecked(doc, true);
			expect(r.ok, tool).toBe(true);
			if (r.ok) expect(parsed(r.text).doc.pages[0]!.strokes.map((s) => s.opacity)).toEqual([0.25, 1]);
		}
	});

	it("refuses to write a malformed one (strict)", () => {
		for (const opacity of [0, 0.049, 1.01, -0.5, Number.NaN, Infinity, "0.5" as unknown as number]) {
			expect(serializeChecked(docWith([], [stroke("s", { opacity })]), true).ok, `stroke ${String(opacity)}`).toBe(false);
			expect(serializeChecked(docWith([area("a", { opacity })]), true).ok, `area ${String(opacity)}`).toBe(false);
			expect(serializeChecked(docWith([image("i", { opacity })]), true).ok, `image ${String(opacity)}`).toBe(false);
		}
	});

	it("checkContent (the History guard) refuses a step that would make the notebook unsavable", () => {
		const doc = docWith([], [stroke("s", { opacity: 0 })]);
		expect(checkContent(doc)).toMatch(/opacity/);
	});

	it("reads leniently: a number outside the range is clamped, anything else is dropped, each counted, the item stays", () => {
		const raw = parseRaw(serialize(docWith([area("a", { opacity: 0.5 }), image("i", { opacity: 0.5 })], [stroke("s1", { opacity: 0.5 }), stroke("s2", { opacity: 0.5 }), stroke("s3", { opacity: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 0, "opacity"], 7);
		setAt(raw, ["pages", 0, "strokes", 1, "opacity"], 0.001);
		setAt(raw, ["pages", 0, "strokes", 2, "opacity"], "half");
		setAt(raw, ["pages", 0, "elements", 0, "opacity"], null);
		setAt(raw, ["pages", 0, "elements", 1, "opacity"], -2);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(5);
		const page = r.doc.pages[0]!;
		expect(page.strokes.map((s) => s.opacity)).toEqual([undefined, OPACITY_MIN, undefined]); // 7 clamps to full strength = no key (Y3), counted
		expect(page.elements!.map((e) => e.id)).toEqual(["a", "i"]);
		expect((page.elements![0] as AreaElement).opacity).toBeUndefined();
		expect((page.elements![1] as ImageElement).opacity).toBe(OPACITY_MIN);
	});

	it("a value above 1 is read as full strength with no key, so a save never writes opacity 1 (counted as repaired)", () => {
		const raw = parseRaw(serialize(docWith([area("a", { opacity: 0.5 }), image("i", { opacity: 0.5 })], [stroke("s1", { opacity: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 0, "opacity"], 1.5);
		setAt(raw, ["pages", 0, "elements", 0, "opacity"], 1000);
		setAt(raw, ["pages", 0, "elements", 1, "opacity"], 1.0001);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(3);
		const text = serialize(r.doc);
		expect(text).not.toContain("opacity");
	});
});

describe("format v24: migration from v23", () => {
	it("changes nothing but the version of a valid v23 document", () => {
		const raw = v23Raw();
		const migrated = MIGRATIONS[23]!(raw);
		expect(migrated).toEqual({ ...raw, version: 24 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("drops a stray opacity key of a v23 file (a v23 reader ignored it), from strokes and elements alike", () => {
		const raw = v23Raw();
		const page = (raw.pages as Array<Record<string, unknown>>)[0]!;
		(page.strokes as Array<Record<string, unknown>>)[0]!.opacity = 0.5;
		page.elements = [{ id: "a", type: "area", x: 1, y: 2, width: 30, height: 20, color: "#facc15", opacity: 0.4 }];
		const migrated = MIGRATIONS[23]!(raw);
		const mp = (migrated.pages as Array<Record<string, unknown>>)[0]!;
		expect("opacity" in (mp.strokes as Array<Record<string, unknown>>)[0]!).toBe(false);
		expect("opacity" in (mp.elements as Array<Record<string, unknown>>)[0]!).toBe(false);
		// The input is not touched.
		expect((page.strokes as Array<Record<string, unknown>>)[0]!.opacity).toBe(0.5);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(23);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.opacity).toBeUndefined();
	});

	it("reads a v23 file and writes it as v24", () => {
		const r = parsed(JSON.stringify(v23Raw()));
		expect(r.migratedFrom).toBe(23);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(24);
	});

	it("reads files of every older version through the chain", () => {
		for (const version of [20, 21, 22]) {
			const raw = v23Raw();
			setAt(raw, ["version"], version);
			const r = parsed(JSON.stringify(raw));
			expect(r.migratedFrom, String(version)).toBe(version);
			expect(r.doc.version).toBe(24);
		}
	});

	it("opens a file of a newer format read-only (it is not parsed, so it is never rewritten)", () => {
		const raw = parseRaw(serialize(docWith([], [stroke("s", { opacity: 0.5 })])));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("stages a large v24 file that uses opacity and a large v23 file, and writes them back", () => {
		const doc = stressDocument(6000, 3, 7);
		const plain = serialize(doc);
		doc.pages[0]!.strokes[0] = Object.freeze({ ...doc.pages[0]!.strokes[0]!, opacity: 0.4 });
		doc.pages[1]!.strokes[1] = Object.freeze({ ...doc.pages[1]!.strokes[1]!, opacity: 0.8 });
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
		// The same text as a v23 file: the opacity keys mean nothing there, so the pages are read without them.
		const old = text.replace(`"version": ${CURRENT_VERSION}`, '"version": 23');
		const stagedOld = parseStaged(old, 0);
		expect(stagedOld).toBeInstanceOf(StagedParse);
		const r23 = (stagedOld as StagedParse).finish();
		expect(r23.ok).toBe(true);
		if (r23.ok) {
			expect(r23.migratedFrom).toBe(23);
			expect(r23.dropped).toBeUndefined();
			expect(serialize(r23.doc)).toBe(plain);
		}
	});
});

describe("format v24: repair, merge and copies", () => {
	it("repair keeps a valid opacity of a stroke, a picture and an area, and drops an invalid one", () => {
		const raw = parseRaw(serialize(docWith([area("a", { opacity: 0.3 }), image("i", { opacity: 0.45 })], [stroke("s1", { opacity: 0.5 }), stroke("s2", { opacity: 0.5 })])));
		setAt(raw, ["pages", 0, "strokes", 1, "opacity"], 3);
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages[0]!;
		expect(page.strokes.map((s) => s.opacity)).toEqual([0.5, undefined]);
		expect(page.elements!.map((e) => (e as { opacity?: number }).opacity)).toEqual([0.3, 0.45]);
	});

	it("merge: a different opacity is a different stroke, the same one is the same stroke", () => {
		expect(strokeContentKey(stroke("a", { opacity: 0.5 }))).toBe(strokeContentKey(stroke("b", { opacity: 0.5 })));
		expect(strokeContentKey(stroke("a", { opacity: 0.5 }))).not.toBe(strokeContentKey(stroke("a", { opacity: 0.6 })));
		expect(strokeContentKey(stroke("a", { opacity: 0.5 }))).not.toBe(strokeContentKey(stroke("a")));
		const main = docWith([], [stroke("a")]);
		const copy = docWith([], [stroke("b", { opacity: 0.5 })]);
		const plan = planMerge(main, copy);
		expect(plan.command).not.toBeNull();
	});

	it("a copy of a stroke keeps its opacity (duplicate, paste, move to another page, templates)", () => {
		expect(copyStroke(stroke("a", { opacity: 0.4 }), "b")).toMatchObject({ id: "b", opacity: 0.4 });
		expect("opacity" in copyStroke(stroke("a"), "b")).toBe(false);
	});

	it("the version diff sees an opacity change", () => {
		expect(compareStroke(stroke("a"), stroke("a", { opacity: 0.5 }))).toBe("changed");
		expect(compareStroke(stroke("a", { opacity: 0.5 }), stroke("a", { opacity: 0.5 }))).toBe("same");
	});

	it("the thumbnail signature changes with the opacity of a stroke, a picture and an area", () => {
		const sig = (p: Page) => pageSignature(p);
		const make = (s: Partial<Stroke>, e: Partial<ImageElement>, a: Partial<AreaElement>): Page => {
			const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
			p.strokes = [stroke("s", s)];
			p.elements = [image("i", e), area("a", a)];
			return p;
		};
		const base = sig(make({}, {}, {}));
		expect(sig(make({ opacity: 0.5 }, {}, {}))).not.toBe(base);
		expect(sig(make({}, { opacity: 0.5 }, {}))).not.toBe(base);
		expect(sig(make({}, {}, { opacity: 0.5 }))).not.toBe(base);
	});

	it("a new area takes the highlighter's opacity, stored only below full strength", () => {
		const page = { width: 600, height: 800 };
		expect(createArea([10, 10], [200, 40], page, "#facc15", 0.5)).toMatchObject({ opacity: 0.5 });
		expect("opacity" in createArea([10, 10], [200, 40], page, "#facc15", 1)!).toBe(false);
		expect("opacity" in createArea([10, 10], [200, 40], page, "#facc15")!).toBe(false);
	});
});

describe("opacity from a selection: one undo step", () => {
	const text: TextElement = Object.freeze({ id: "t", type: "text", x: 1, y: 1, width: 100, text: "hi", fontSize: 14, color: "#000000" });

	it("sets the opacity of ink, a picture and an area together, and undo brings every one back", () => {
		const s = stroke("s");
		const hl = stroke("h", { tool: "highlighter", opacity: 0.8 });
		const a = area("a");
		const i = image("i");
		const doc = docWith([a, i, text], [s, hl]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const plan = planOpacity(page, [s, hl], [a, i, text], 0.4)!;
		expect(plan).not.toBeNull();
		expect(history.execute(plan.command)).toBe(true);
		expect(page.strokes.map((x) => x.opacity)).toEqual([0.4, 0.4]);
		expect(page.elements!.map((e) => (e as { opacity?: number }).opacity)).toEqual([0.4, 0.4, undefined]);
		// The text box has none and is the very same object; the planned copies are the ones now on the page.
		expect(page.elements![2]).toBe(text);
		expect(plan.strokes[0]).toBe(page.strokes[0]);
		expect(plan.elements[1]).toBe(page.elements![1]);
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(page.strokes[0]).toBe(s);
		expect(page.strokes[1]).toBe(hl);
		expect(page.elements![0]).toBe(a);
		expect(page.elements![1]).toBe(i);
		history.redo();
		expect(page.strokes[0]!.opacity).toBe(0.4);
		history.undo();
		expect(page.strokes[0]).toBe(s);
	});

	it("100 % takes the key away, so the notebook is what v23 wrote", () => {
		const s = stroke("s", { opacity: 0.5 });
		const doc = docWith([], [s]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const plan = planOpacity(page, [s], [], 1)!;
		expect(history.execute(plan.command)).toBe(true);
		expect("opacity" in page.strokes[0]!).toBe(false);
		expect(serialize(doc)).not.toContain("opacity");
	});

	it("plans nothing when nothing would change, and leaves locked elements, text and items off the page alone", () => {
		const s = stroke("s", { opacity: 0.5 });
		const locked = area("l", { locked: true, lockAt: 5 });
		const doc = docWith([locked, text], [s]);
		const page = doc.pages[0]!;
		expect(planOpacity(page, [s], [], 0.5)).toBeNull();
		expect(planOpacity(page, [], [text], 0.5)).toBeNull();
		expect(planOpacity(page, [], [locked], 0.5)).toBeNull();
		expect(planOpacity(page, [stroke("elsewhere")], [], 0.5)).toBeNull();
		expect(takesOpacity(locked)).toBe(false);
		expect(takesOpacity(text)).toBe(false);
		expect(takesOpacity(area("x"))).toBe(true);
		expect(takesOpacity(image("x"))).toBe(true);
		expect(takesOpacity(stroke("x"))).toBe(true);
	});

	it("a locked page refuses it", () => {
		const s = stroke("s");
		const doc = docWith([], [s]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent, null, null, () => undefined, () => 1);
		page.locked = true;
		const plan = planOpacity(page, [s], [], 0.5)!;
		expect(history.execute(plan.command)).toBe(false);
		expect(page.strokes[0]).toBe(s);
	});

	it("knows what a selection can take and the value it shares", () => {
		expect(opacityAbility([], [text])).toBe(false);
		expect(opacityAbility([stroke("s")], [])).toBe(true);
		expect(opacityAbility([], [image("i")])).toBe(true);
		expect(opacityAbility([], [area("a", { locked: true })])).toBe(false);
		expect(commonOpacity([stroke("a"), stroke("b")], [])).toBe(1);
		expect(commonOpacity([stroke("a", { opacity: 0.5 }), stroke("b", { opacity: 0.5 })], [area("c", { opacity: 0.5 })])).toBe(0.5);
		expect(commonOpacity([stroke("a", { opacity: 0.5 }), stroke("b")], [])).toBeNull();
		expect(commonOpacity([], [text])).toBeNull();
	});

	it("has a title in the history panel, in both languages", () => {
		const title = titleForLabel("Opacity")!;
		expect(title).not.toBeNull();
		expect(en[title[0]].length).toBeGreaterThan(0);
		expect(it_[title[0]]?.length ?? 0).toBeGreaterThan(0);
		const s = stroke("s");
		const doc = docWith([], [s]);
		const plan = planOpacity(doc.pages[0]!, [s], [], 0.5)!;
		expect(describeCommand(plan.command).key).toBe(title[0]);
	});
});

describe("opacity: favourite pens, pen sets and the eyedropper", () => {
	it("a favourite keeps it like the width, and an invalid one is left out", () => {
		expect(validPen({ tool: "pen", color: "#112233", width: 2, opacity: 0.4 })).toMatchObject({ opacity: 0.4 });
		expect(validPen({ tool: "highlighter", color: "#facc15", width: 14, opacity: 0.5 })).toMatchObject({ opacity: 0.5 });
		for (const bad of [0, 0.01, 2, "x", null, 1]) expect("opacity" in validPen({ tool: "pen", color: "#112233", width: 2, opacity: bad })!, String(bad)).toBe(false);
		expect("opacity" in validPen({ tool: "pen", color: "#112233", width: 2 })!).toBe(false);
	});

	it("captures the pen in hand with its opacity and gives it back", () => {
		const state = { tool: "pen", penColor: "#112233", penWidth: 2, highlighterColor: "#facc15", highlighterWidth: 14, penOpacity: 0.4, highlighterOpacity: 0.7 };
		const pen = captureFavourite(state);
		expect(pen).toMatchObject({ tool: "pen", opacity: 0.4 });
		expect(captureFavourite({ ...state, tool: "highlighter" })).toMatchObject({ tool: "highlighter", opacity: 0.7 });
		expect("opacity" in captureFavourite({ ...state, penOpacity: 1 })).toBe(false);
		expect(favouritePatch(pen)).toMatchObject({ penOpacity: 0.4 });
		expect(favouritePatch(captureFavourite({ ...state, penOpacity: 1 }))).toMatchObject({ penOpacity: 1 });
		expect(favouritePatch({ tool: "highlighter", color: "#facc15", width: 14, opacity: 0.5 })).toMatchObject({ highlighterOpacity: 0.5 });
		expect(sameFavourite(pen, { ...pen, opacity: 0.5 })).toBe(false);
		expect(sameFavourite(pen, { ...pen })).toBe(true);
		expect(sameFavourite({ tool: "pen", color: "#112233", width: 2 }, { tool: "pen", color: "#112233", width: 2, opacity: 0.4 })).toBe(false);
	});

	it("the style eyedropper takes the opacity of the stroke", () => {
		expect(styleOfStroke({ tool: "pen", color: "#112233", width: 2, opacity: 0.4 })).toMatchObject({ penOpacity: 0.4 });
		expect(styleOfStroke({ tool: "pen", color: "#112233", width: 2 })).toMatchObject({ penOpacity: 1 });
		expect(styleOfStroke({ tool: "highlighter", color: "#facc15", width: 14, opacity: 0.5 })).toMatchObject({ highlighterOpacity: 0.5 });
		expect(styleOfStroke({ tool: "marker", color: "#112233", width: 6, opacity: 0.3, nib: 10 })).toMatchObject({ penKind: "marker", penOpacity: 0.3 });
	});
});

describe("opacity: the look is the product with the pen's own translucency", () => {
	it("one description for the alphas", () => {
		expect(inkAlpha("pen")).toBe(1);
		expect(inkAlpha("pen", 0.5)).toBe(0.5);
		expect(inkAlpha("highlighter")).toBe(HIGHLIGHTER_ALPHA);
		expect(inkAlpha("highlighter", 0.5)).toBeCloseTo(HIGHLIGHTER_ALPHA / 2, 10);
		expect(inkAlpha("marker", 0.4)).toBeCloseTo(MARKER_ALPHA * 0.4, 10);
		expect(inkAlpha("brush", 0.2)).toBe(0.2);
		expect(inkAlpha("shape", 1)).toBe(1);
		expect(fillAlpha({ fillTint: true })).toBe(0.25);
		expect(fillAlpha({ fillTint: true, opacity: 0.5 })).toBeCloseTo(0.125, 10);
		expect(fillAlpha({ opacity: 0.5 })).toBe(0.5);
		expect(fillAlpha({})).toBe(1);
	});

	const page = (strokes: Stroke[], elements: PageElement[]): Page => {
		const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
		p.id = "p1";
		p.strokes = strokes;
		p.elements = elements;
		return p;
	};

	it("the SVG writes the product, keeps the highlighter multiplied, and puts the opacity on a picture", () => {
		const svg = pageToSvg(
			page(
				[stroke("pen", { opacity: 0.5 }), stroke("hl", { tool: "highlighter", color: "#facc15", opacity: 0.5 }), stroke("mk", { tool: "marker", render: 2, color: "#dc2626", opacity: 0.5 }), stroke("plain"), stroke("hl2", { tool: "highlighter", color: "#4ade80" })],
				[area("a", { opacity: 0.5 }), area("b"), image("i", { opacity: 0.25 })],
			),
			{ images: () => [{ href: "data:image/jpeg;base64,AAAA", x: 20, y: 200, width: 120, height: 80, opacity: 0.25 }] },
		);
		expect(svg).toContain('fill="#1e1e1e" fill-opacity="0.5"/>');
		expect(svg).toContain(`fill="#facc15" fill-opacity="${HIGHLIGHTER_ALPHA / 2}" style="mix-blend-mode:multiply"`);
		expect(svg).toContain(`fill="#dc2626" fill-opacity="${Math.round(MARKER_ALPHA * 0.5 * 10000) / 10000}"`);
		// The same highlighter without an opacity is exactly what it was.
		expect(svg).toContain(`fill="#4ade80" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"`);
		// An area: half of the highlighter's look, then the plain one.
		expect(svg).toContain(`<rect x="40" y="100" width="300" height="24" fill="#facc15" fill-opacity="${HIGHLIGHTER_ALPHA / 2}" style="mix-blend-mode:multiply"/>`);
		expect(svg).toContain(`<rect x="40" y="100" width="300" height="24" fill="#facc15" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"/>`);
		expect(svg).toContain('preserveAspectRatio="none" opacity="0.25"/>');
		// A plain pen stroke has no opacity attribute at all.
		const plain = pageToSvg(page([stroke("plain")], []));
		expect(plain).not.toContain("fill-opacity");
	});

	it("the SVG scales the fill of a shape with the stroke's opacity", () => {
		const svg = pageToSvg(page([stroke("sh", { tool: "shape", render: 1, fill: "#2563eb", points: [[10, 10, 0.5], [90, 10, 0.5], [90, 60, 0.5], [10, 60, 0.5], [10, 10, 0.5]], opacity: 0.5 }), stroke("sh2", { tool: "shape", render: 1, fill: "#ff0000", fillTint: true, opacity: 0.4, points: [[10, 110, 0.5], [90, 110, 0.5], [90, 160, 0.5], [10, 160, 0.5], [10, 110, 0.5]] })], []));
		expect(svg).toContain('fill="#2563eb" fill-opacity="0.5"');
		expect(svg).toContain('fill="#ff0000" fill-opacity="0.1"');
	});

	it("the PDF gets one graphics state per opacity, multiplied for the highlighter, and the fixed ones stay for items without", () => {
		const bytes = new TextDecoder("latin1").decode(pagesToPdf([
			page(
				[stroke("pen", { opacity: 0.5 }), stroke("hl", { tool: "highlighter", opacity: 0.5 }), stroke("hl2", { tool: "highlighter" }), stroke("mk", { tool: "marker", render: 2, opacity: 0.5 }), stroke("pen2", { opacity: 0.5 })],
				[area("a", { opacity: 0.5 }), area("b")],
			),
		], { images: () => [] }));
		expect(bytes).toContain("/Type /ExtGState /ca 0.5 >>");
		expect(bytes).toContain(`/Type /ExtGState /ca ${HIGHLIGHTER_ALPHA / 2} /BM /Multiply >>`);
		expect(bytes).toContain(`/Type /ExtGState /ca ${Math.round(MARKER_ALPHA * 0.5 * 10000) / 10000} >>`);
		// The fixed highlighter state still serves the highlighter and the area that have no opacity.
		expect(bytes).toContain(`/GS1 << /Type /ExtGState /ca ${HIGHLIGHTER_ALPHA} /BM /Multiply >>`);
		expect(bytes).toContain("/GS1 gs");
		// The same translucency used twice on a page is one state.
		expect(bytes.match(/\/Type \/ExtGState \/ca 0\.5 >>/g)).toHaveLength(1);
	});

	it("the PDF paints a picture with an opacity under its own state", () => {
		const jpeg: PdfPlacedImage = { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), pixelWidth: 2, pixelHeight: 2, x: 20, y: 200, width: 120, height: 80, opacity: 0.4 };
		const plain: PdfPlacedImage = { ...jpeg, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0]), x: 200, opacity: undefined };
		const bytes = new TextDecoder("latin1").decode(pagesToPdf([page([], [])], { images: () => [jpeg, plain] }));
		expect(bytes).toMatch(/q \/GO1 gs 120 0 0 -80 20 280 cm \/Im\d+ Do Q/);
		expect(bytes).toMatch(/q 120 0 0 -80 200 280 cm \/Im\d+ Do Q/);
		expect(bytes).toContain("/Type /ExtGState /ca 0.4 >>");
	});

	describe("the raster (PNG, area export, excerpts, hand-in)", () => {
		interface Call { op: string; style: unknown; alpha: unknown; blend: unknown; args: unknown[] }
		const calls: Call[] = [];
		beforeEach(() => {
			calls.length = 0;
			vi.stubGlobal("Path2D", class { constructor(readonly d?: string) {} });
		});
		afterEach(() => vi.unstubAllGlobals());
		function ctx(): CanvasRenderingContext2D {
			const state: Record<string, unknown> = { fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
			const stack: Array<Record<string, unknown>> = [];
			return new Proxy(state, {
				get(t, k: string) {
					if (k in t) return t[k];
					// save() and restore() keep the state a real context keeps (drawElement relies on it for a picture's alpha).
					if (k === "save") return () => void stack.push({ ...t });
					if (k === "restore") return () => void Object.assign(t, stack.pop() ?? {});
					if (k === "measureText") return () => ({ width: 10 });
					if (k === "fillRect" || k === "fill" || k === "drawImage") return (...args: unknown[]) => calls.push({ op: k, style: t.fillStyle, alpha: t.globalAlpha, blend: t.globalCompositeOperation, args });
					return () => undefined;
				},
				set(t, k: string, v) {
					t[k] = v;
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		}

		it("paints ink with the product, keeping the blend of the highlighter", () => {
			const p = page(
				[stroke("pen", { opacity: 0.5, color: "#111111" }), stroke("hl", { tool: "highlighter", color: "#facc15", opacity: 0.5 }), stroke("hl2", { tool: "highlighter", color: "#4ade80" }), stroke("plain", { color: "#222222" })],
				[],
			);
			drawPageRaster(ctx(), p, 1, { background: null, images: new Map() });
			const by = (style: string) => calls.find((c) => c.op === "fill" && c.style === style);
			expect(by("#111111")).toMatchObject({ alpha: 0.5, blend: "source-over" });
			expect(by("#facc15")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA * 0.5, blend: "multiply" });
			expect(by("#4ade80")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply" });
			expect(by("#222222")).toMatchObject({ alpha: 1, blend: "source-over" });
		});

		it("paints an area with half of the highlighter's look, a picture under its own alpha", () => {
			drawPageRaster(ctx(), page([], [area("a", { opacity: 0.5 }), area("b", { color: "#4ade80" })]), 1, { background: null, images: new Map() });
			const rect = (style: string) => calls.find((c) => c.op === "fillRect" && c.style === style);
			expect(rect("#facc15")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA * 0.5, blend: "multiply" });
			expect(rect("#4ade80")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply" });
			calls.length = 0;
			const bitmap = {} as unknown as CanvasImageSource;
			drawPageRaster(ctx(), page([], [image("i", { opacity: 0.3 }), image("j")]), 1, { background: null, images: new Map([[hex, bitmap]]) });
			const drawn = calls.filter((c) => c.op === "drawImage");
			expect(drawn.map((c) => c.alpha)).toEqual([0.3, 1]);
		});

		it("drawArea and drawElement multiply the night and dimmed looks too, and leave the context as they found it", () => {
			const c = ctx();
			drawArea(c, area("a", { opacity: 0.5 }), { alpha: 0.45, blend: "screen" });
			expect(calls.pop()).toMatchObject({ alpha: 0.225, blend: "screen" });
			expect(c.globalAlpha).toBe(1);
			drawElement(c, image("i", { opacity: 0.5 }), {} as unknown as CanvasImageSource);
			expect(calls.pop()).toMatchObject({ op: "drawImage", alpha: 0.5 });
			expect(c.globalAlpha).toBe(1);
		});

		it("an item with no opacity is painted exactly as before (the golden look)", () => {
			drawPageRaster(ctx(), page([stroke("p", { color: "#333333" }), stroke("h", { tool: "highlighter", color: "#facc15" })], [area("a")]), 1, { background: null, images: new Map() });
			expect(calls.find((c) => c.style === "#333333")).toMatchObject({ alpha: 1 });
			expect(calls.find((c) => c.op === "fill" && c.style === "#facc15")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply" });
			expect(calls.find((c) => c.op === "fillRect" && c.style === "#facc15")).toMatchObject({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply" });
		});
	});
});

describe("opacity: the action, its ranking and its help", () => {
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;
	const withSelection = (selection: Partial<NonNullable<ReturnType<typeof baseContext>["selection"]>>) =>
		baseContext({ tool: "lasso", selection: { strokes: 0, elements: 0, images: 0, ...selection } });

	it("is offered when something can take an opacity, and not for a text-only selection with the eraser", () => {
		expect(canOpacity(baseContext())).toBe(true);
		expect(canOpacity(baseContext({ tool: "highlighter" }))).toBe(true);
		expect(canOpacity(baseContext({ tool: "eraser" }))).toBe(false);
		expect(canOpacity(withSelection({ strokes: 2, elements: 0 }))).toBe(true);
		expect(canOpacity(withSelection({ elements: 1, images: 1 }))).toBe(true);
		expect(canOpacity(withSelection({ elements: 1, areas: 1 }))).toBe(true);
		expect(canOpacity(withSelection({ elements: 1 }))).toBe(false);
		const action = find("opacity");
		expect(action.surfaces).toEqual(["sheet"]);
		expect(isEnabled(action, baseContext())).toBe(true);
		expect(isEnabled(action, baseContext({ editable: false }))).toBe(false);
	});

	it("ranks first for a selection of ink, pictures or areas and with the highlighter or a shape in hand, and only leans forward with the pen", () => {
		const action = find("opacity");
		const now = 1_800_000_000_000;
		expect(contextBoost(action, withSelection({ strokes: 3 }))).toBeGreaterThanOrEqual(28);
		expect(contextBoost(action, baseContext({ tool: "highlighter" }))).toBeGreaterThanOrEqual(20);
		expect(contextBoost(action, baseContext({ tool: "shape" }))).toBeGreaterThanOrEqual(20);
		expect(contextBoost(action, baseContext())).toBeLessThan(20);
		expect(contextBoost(action, baseContext({ tool: "eraser" }))).toBe(0);
		// With a selection the selection actions crowd the short section; the action is still ahead of every plain tool action in the sheet.
		expect(forThisPage(ACTIONS, withSelection({ elements: 1, images: 1 }), {}, now, new Set(), 200).map((a) => a.id)).toContain("opacity");
		expect(forThisPage(ACTIONS, baseContext({ tool: "highlighter" }), {}, now).map((a) => a.id)).toContain("opacity");
		expect(forThisPage(ACTIONS, baseContext(), {}, now).map((a) => a.id)).not.toContain("opacity");
	});

	it("has an explanation, a name and a command title in both languages", () => {
		const key = ACTION_HELP.opacity!;
		expect(key).toBe("help.opacity");
		for (const k of ["help.opacity", "opacity.title", "opacity.reset", "opacity.mixed", "opacity.value", "opacity.action", "command.opacity", "histpanel.t.opacity"] as const) {
			expect(en[k].length, k).toBeGreaterThan(0);
			expect(it_[k]?.length ?? 0, k).toBeGreaterThan(0);
		}
		expect(en["help.opacity"].length).toBeGreaterThan(40);
		expect(it_["help.opacity"]!.length).toBeGreaterThan(40);
		expect(en["opacity.value"]).toContain("{percent}");
		expect(it_["opacity.value"]).toContain("{percent}");
	});
});
