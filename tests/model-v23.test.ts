/**
 * Format v23: the area highlighter (#99) — the page element "area" (a translucent rectangle in a highlighter colour, under the ink): the fields, the
 * v22 -> v23 migration, lenient read and strict write, staged loading, repair, merge, geometry (hit, move, resize), erasing, recolouring, locks and
 * groups, page lock and page times, undo, and the order and look in every render and export path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { elementContentKey, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { AddElement, Batch, History, RemoveElement, ReplaceStroke, type Command } from "../src/model/history";
import { expandToGroups, groupRenamer, selectableItems } from "../src/model/groups";
import { elementBand } from "../src/model/layers";
import { AREA_MAX_SIDE, AREA_MIN_SIDE, areaRect, areasOf, createArea, withAreaColour } from "../src/model/area";
import { CURRENT_VERSION, ELEMENT_TYPES_V23, FORMAT_ID, type AreaElement, type NotebookDocument, type Page, type PageElement, type StickyElement, type TextElement } from "../src/model/types";
import { elementBounds, elementsInLasso, hitElement, transformElement } from "../src/ink/elements";
import { rotate90Matrix } from "../src/ink/selection-transform";
import { apply, multiply, rotateAbout, scaleAbout, translate } from "../src/ink/transform";
import { AreaEraseGesture, areaMatchesFilter, areasUnderEraser, eraserDistanceToArea } from "../src/ink/area-erase";
import { eraseAreaCommand } from "../src/ink/erase-area";
import { commonStyle, planRestyle, restyleAbilities } from "../src/ink/restyle";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { drawPageRaster } from "../src/ink/page-raster";
import { areaLook } from "../src/ink/area-render";
import { contentObstacles } from "../src/ink/export-tiles";
import { HIGHLIGHTER_ALPHA } from "../src/ink/stroke-shape";
import { pageSignature } from "../src/view/view-helpers";
import { delAt, getAt, parseRaw, setAt } from "./raw-json";
import { line } from "./helpers";
import { ACTIONS, baseContext, isChecked, isEnabled } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";

const stamp = "2026-11-08T10:00:00.000Z";

function area(id: string, extra: Partial<AreaElement> = {}): AreaElement {
	return Object.freeze({ id, type: "area", x: 40, y: 100, width: 300, height: 24, color: "#facc15", ...extra });
}

function docWith(elements: PageElement[], strokes = [] as ReturnType<typeof line>[]): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
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

function v22Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 22, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("format v23: the fields", () => {
	it("writes and reads an area in a fixed order and writes it back byte for byte", () => {
		const doc = docWith([area("a"), area("b", { x: 10.5, y: 20.25, width: 120, height: 14, color: "#4ade80", locked: true, lockAt: 1_700_000_000_000 })]);
		const checked = serializeChecked(doc, true);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.text).toContain('{"id":"a","type":"area","x":40,"y":100,"width":300,"height":24,"color":"#facc15"}');
		const back = parsed(checked.text).doc.pages[0]!.elements!;
		expect(back[0]).toMatchObject({ id: "a", type: "area", width: 300, height: 24, color: "#facc15" });
		expect(back[1]).toMatchObject({ id: "b", x: 10.5, y: 20.25, locked: true, lockAt: 1_700_000_000_000 });
		expect(serialize(parsed(checked.text).doc)).toBe(checked.text);
	});

	it("is a document of the current version", () => {
		expect(CURRENT_VERSION).toBe(23);
		expect(ELEMENT_TYPES_V23).toEqual(["area"]);
		expect(parsed(serialize(docWith([area("a")]))).doc.version).toBe(23);
	});

	it("refuses to write a malformed one (strict)", () => {
		for (const extra of [
			{ color: "yellow" }, { color: "#12345" }, { width: 1 }, { height: 0 }, { width: -5 }, { width: AREA_MAX_SIDE + 1 }, { x: Number.NaN }, { y: Infinity },
		]) {
			const r = serializeChecked(docWith([area("a", extra)]), true);
			expect(r.ok, JSON.stringify(extra)).toBe(false);
		}
	});

	it("reads leniently: an area with an invalid value is dropped and counted, the rest of the page stays", () => {
		const raw = parseRaw(serialize(docWith([area("a"), area("b"), area("c"), area("d")], [line(10, 10, 50, 10)])));
		setAt(raw, ["pages", 0, "elements", 0, "color"], "yellow");
		setAt(raw, ["pages", 0, "elements", 1, "width"], 1);
		delAt(raw, ["pages", 0, "elements", 2, "height"]);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(3);
		expect(r.doc.pages[0]!.elements!.map((e) => e.id)).toEqual(["d"]);
		expect(r.doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("reads strictly where it must: the ids of areas and strokes share one space", () => {
		const doc = docWith([area("a")], [line(10, 10, 50, 10)]);
		doc.pages[0]!.strokes[0] = { ...doc.pages[0]!.strokes[0]!, id: "a" };
		expect(serializeChecked(doc, true).ok).toBe(false);
	});
});

describe("format v23: migration from v22", () => {
	it("changes nothing but the version of a valid v22 document", () => {
		const raw = v22Raw();
		const migrated = MIGRATIONS[22]!(raw);
		expect(migrated).toEqual({ ...raw, version: 23 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("reads a v22 file and writes it as v23", () => {
		const r = parsed(JSON.stringify(v22Raw()));
		expect(r.migratedFrom).toBe(22);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(23);
	});

	it("opens a file of a newer format read-only (it is not parsed, so it is never rewritten)", () => {
		const raw = parseRaw(serialize(docWith([area("a")])));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("stages a large v23 file with areas and a large v22 file without, and writes them back", () => {
		const doc = stressDocument(6000, 3, 7);
		const plain = serialize(doc);
		doc.pages[0]!.elements = [area("zz1"), area("zz2", { color: "#f472b6" })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
		const old = plain.replace(`"version": ${CURRENT_VERSION}`, '"version": 22');
		const stagedOld = parseStaged(old, 1);
		expect(stagedOld).toBeInstanceOf(StagedParse);
		const r22 = (stagedOld as StagedParse).finish();
		expect(r22.ok).toBe(true);
		if (r22.ok) {
			expect(r22.migratedFrom).toBe(22);
			expect(serialize(r22.doc)).toBe(plain);
		}
	});
});

describe("format v23: an area in a file older than v23 is refused, in every version (review fix)", () => {
	// A v22 reader refused unknown element types, so such a file was not written by this plugin: refused like excerpts before v10, sticky notes
	// before v15 and checkboxes before v17. Nothing is lost: the file is not opened, so it is never rewritten.
	const withArea = (version: number) => {
		const raw = parseRaw(serialize(docWith([area("a")], [line(10, 10, 50, 10)])));
		setAt(raw, ["version"], version);
		return JSON.stringify(raw);
	};

	it.each([5, 9, 10, 14, 16, 17, 20, 21, 22])("v%i: the whole file is refused, with the reason", (version) => {
		const r = parse(withArea(version));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).not.toBe("future-version");
			expect(r.message).toMatch(/area/);
		}
	});

	it("v23 keeps its area, and an older file without areas still opens", () => {
		const r = parsed(withArea(CURRENT_VERSION));
		expect(r.doc.pages[0]!.elements!.map((e) => e.id)).toEqual(["a"]);
		const raw = parseRaw(serialize(docWith([], [line(10, 10, 50, 10)])));
		setAt(raw, ["version"], 22);
		expect(parsed(JSON.stringify(raw)).migratedFrom).toBe(22);
	});

	it("a large v22 file with an area is refused when its page is read, in the staged path too", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.elements = [area("zz1")];
		const text = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, '"version": 22');
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 0);
		const r = staged instanceof StagedParse ? staged.finish() : staged;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/area/);
	});
});

describe("format v23: repair and merge", () => {
	it("repair keeps a valid area and its flags, and drops an invalid one", () => {
		const raw = parseRaw(serialize(docWith([area("a", { locked: true, lockAt: 5 }), area("b")])));
		setAt(raw, ["pages", 0, "elements", 1, "color"], "red");
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const els = r.doc.pages[0]!.elements ?? [];
		expect(els.map((e) => e.id)).toEqual(["a"]);
		expect(els[0]).toMatchObject({ type: "area", locked: true, lockAt: 5 });
	});

	it("merge: the same area on both sides is one area, an area only the copy has is brought in", () => {
		const main = docWith([area("a")]);
		const copy = docWith([area("a2"), area("b", { y: 300 })]);
		const plan = planMerge(main, copy);
		expect(plan.command).not.toBeNull();
		plan.command!.apply(main);
		const els = areasOf(main.pages[0]!);
		expect(els).toHaveLength(2);
		expect(els.map((e) => e.y).sort((x, y) => x - y)).toEqual([100, 300]);
		expect(elementContentKey(area("x"))).toBe(elementContentKey(area("y")));
		expect(elementContentKey(area("x"))).not.toBe(elementContentKey(area("x", { color: "#4ade80" })));
		// A lock on one side only is state, not content.
		expect(elementContentKey(area("x", { locked: true, lockAt: 3 }))).toBe(elementContentKey(area("x")));
	});
});

describe("area highlighter: geometry", () => {
	const page = { width: 400, height: 600 };

	it("a drag from any corner to the opposite one is the same rectangle, kept on the page", () => {
		const r = areaRect([100, 50], [20.004, 80.9], page)!;
		expect(r).toEqual({ x: 20, y: 50, width: 80, height: 30.9 });
		expect(areaRect([20, 80.9], [100, 50], page)).toEqual(r);
		expect(areaRect([-50, -10], [900, 300], page)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
	});

	it("a drag too small to be a rectangle adds nothing", () => {
		expect(areaRect([10, 10], [10, 10], page)).toBeNull();
		expect(areaRect([10, 10], [10 + AREA_MIN_SIDE - 0.5, 200], page)).toBeNull();
		expect(createArea([10, 10], [11, 11], page, "#facc15")).toBeNull();
		expect(areaRect([Number.NaN, 1], [5, 100], page)).toBeNull();
		const made = createArea([10, 10], [110, 40], page, "#facc15")!;
		expect(made).toMatchObject({ type: "area", x: 10, y: 10, width: 100, height: 30, color: "#facc15" });
		expect(made.id.length).toBeGreaterThan(10);
	});

	it("has the bounds of its rectangle and is hit anywhere inside it (topmost first)", () => {
		const a = area("a");
		const b = area("b", { x: 100, y: 110, width: 50, height: 50 });
		expect(elementBounds(a)).toEqual({ minX: 40, minY: 100, maxX: 340, maxY: 124 });
		expect(hitElement([a, b], 300, 112, 0)).toBe(a);
		expect(hitElement([a, b], 120, 130, 0)).toBe(b);
		expect(hitElement([a, b], 120, 118, 0)).toBe(b);
		expect(hitElement([b, a], 120, 118, 0)).toBe(a);
		expect(hitElement([a, b], 20, 112, 0)).toBeNull();
		expect(hitElement([a, b], 36, 112, 6)).toBe(a);
	});

	it("moves, resizes each side on its own, and keeps its colour", () => {
		const a = area("a");
		const moved = transformElement(a, translate(10, -20)) as AreaElement;
		expect(moved).toMatchObject({ x: 50, y: 80, width: 300, height: 24, color: "#facc15", id: "a" });
		const stretched = transformElement(a, scaleAbout(2, 0.5, 40, 100)) as AreaElement;
		expect(stretched).toMatchObject({ x: 40, y: 100, width: 600, height: 12 });
		const tiny = transformElement(a, scaleAbout(0.001, 0.001, 40, 100)) as AreaElement;
		expect(tiny.width).toBe(AREA_MIN_SIDE);
		expect(tiny.height).toBe(AREA_MIN_SIDE);
		const huge = transformElement(a, scaleAbout(1e6, 1e6, 40, 100)) as AreaElement;
		expect(huge.width).toBe(AREA_MAX_SIDE);
	});

	it("any other turn keeps it an upright rectangle of the same size, its centre going where the turn takes it", () => {
		const a = area("a", { x: 100, y: 100, width: 60, height: 20 });
		const turned = transformElement(a, rotateAbout(Math.PI / 6, 0, 0)) as AreaElement;
		expect(turned.width).toBeCloseTo(60, 1);
		expect(turned.height).toBeCloseTo(20, 1);
		const c = apply(rotateAbout(Math.PI / 6, 0, 0), 130, 110);
		expect(turned.x + turned.width / 2).toBeCloseTo(c[0], 1);
		expect(turned.y + turned.height / 2).toBeCloseTo(c[1], 1);
		const scaledTurn = transformElement(a, multiply(scaleAbout(2, 2, 0, 0), rotateAbout(0.3, 0, 0))) as AreaElement;
		expect(scaledTurn.width).toBeCloseTo(120, 1);
	});

	it("turns a quarter turn with the selection (a rectangle stays a rectangle)", () => {
		const a = area("a", { x: 100, y: 100, width: 60, height: 20 });
		const turned = transformElement(a, rotate90Matrix(elementBounds(a), true)) as AreaElement;
		expect(turned.width).toBe(20);
		expect(turned.height).toBe(60);
		expect(turned.x + turned.width / 2).toBeCloseTo(130);
		expect(turned.y + turned.height / 2).toBeCloseTo(110);
	});

	it("is picked by a lasso around its centre, and a locked one never", () => {
		const a = area("a");
		const locked = area("l", { y: 300, locked: true, lockAt: 1 });
		const poly: Array<[number, number]> = [[0, 90], [400, 90], [400, 340], [0, 340]];
		expect(elementsInLasso([a, locked], poly).map((e) => e.id)).toEqual(["a"]);
		expect(elementsInLasso([a], [[0, 0], [100, 0], [100, 50], [0, 50]])).toEqual([]);
	});

	it("is a layer of its own between the sticky notes and the equations", () => {
		const sticky: StickyElement = { id: "s", type: "sticky", x: 0, y: 0, width: 50, height: 50, color: "#fde68a", fontSize: 12 };
		const text: TextElement = { id: "t", type: "text", x: 0, y: 0, width: 50, text: "x", fontSize: 12, color: "#000000" };
		expect(elementBand(area("a"))).toBeGreaterThan(elementBand(sticky));
		expect(elementBand(area("a"))).toBeLessThan(elementBand(text));
	});

	it("changes the thumbnail signature when its rectangle or colour changes", () => {
		const p = docWith([area("a")]).pages[0]!;
		const before = pageSignature(p);
		p.elements = [area("a", { color: "#4ade80" })];
		expect(pageSignature(p)).not.toBe(before);
		p.elements = [area("a", { width: 301 })];
		expect(pageSignature(p)).not.toBe(before);
	});
});

describe("area highlighter: erasing", () => {
	const filter = (kind: "all" | "highlighter" | "pen" | "color", color = "#000000") => ({ kind, color });

	it("the eraser finds the whole area as soon as its path touches it, near or crossing", () => {
		const a = area("a");
		expect(eraserDistanceToArea(a, 100, 112, 110, 112)).toBe(0);
		expect(eraserDistanceToArea(a, 100, 60, 100, 160)).toBe(0);
		expect(eraserDistanceToArea(a, 100, 90, 110, 90)).toBeCloseTo(10);
		expect(eraserDistanceToArea(a, 30, 90, 30, 90)).toBeCloseTo(Math.hypot(10, 10));
		expect(areasUnderEraser([a], 100, 90, 110, 90, 12, filter("all"))).toEqual([a]);
		expect(areasUnderEraser([a], 100, 90, 110, 90, 8, filter("all"))).toEqual([]);
		expect(areasUnderEraser([a], 100, 112, 100, 112, 3, filter("all"))).toEqual([a]);
	});

	it("follows the selective eraser: a highlighter of its colour, never a pen", () => {
		const a = area("a");
		expect(areaMatchesFilter("#facc15", filter("all"))).toBe(true);
		expect(areaMatchesFilter("#facc15", filter("highlighter"))).toBe(true);
		expect(areaMatchesFilter("#facc15", filter("pen"))).toBe(false);
		expect(areaMatchesFilter("#FACC15", filter("color", "#facc15"))).toBe(true);
		expect(areaMatchesFilter("#facc15", filter("color", "#4ade80"))).toBe(false);
		expect(areasUnderEraser([a], 100, 112, 100, 112, 3, filter("pen"))).toEqual([]);
	});

	it("leaves a locked area and a spared one alone", () => {
		const locked = area("l", { locked: true, lockAt: 1 });
		const spared = area("s", { y: 200 });
		expect(areasUnderEraser([locked, spared], 100, 112, 100, 212, 3, filter("all"), new Set(["s"]))).toEqual([]);
	});

	describe("a whole-stroke or segment eraser gesture over an area (review fix)", () => {
		const rubOut = (doc: NotebookDocument) => {
			const page = doc.pages[0]!;
			return new ReplaceStroke(page.id, page.strokes[0]!, [], 0);
		};
		const gesture = () => {
			const commands: Command[] = [];
			return { commands, g: new AreaEraseGesture(commands) };
		};
		const hit = (doc: NotebookDocument) => areasUnderEraser(doc.pages[0]!.elements ?? [], 100, 112, 110, 112, 3, filter("all"));
		const ids = (doc: NotebookDocument) => (doc.pages[0]!.elements ?? []).map((e) => e.id);

		it("erasing a letter written inside an area keeps the area", () => {
			const doc = docWith([area("a")], [line(60, 110, 120, 114)]);
			const { commands, g } = gesture();
			const ink = rubOut(doc);
			ink.apply(doc);
			commands.push(ink);
			g.inkErased(doc, filter("all"));
			expect(g.allowed(filter("all"))).toBe(false);
			expect(g.eraseAreas(doc, "p1", hit(doc), filter("all"))).toBe(false);
			expect(ids(doc)).toEqual(["a"]);
			expect(commands).toEqual([ink]);
		});

		it("scrubbing an empty area removes it, and the step undoes", () => {
			const doc = docWith([area("a"), area("b", { y: 400 })]);
			const { commands, g } = gesture();
			expect(g.eraseAreas(doc, "p1", hit(doc), filter("all"))).toBe(true);
			expect(ids(doc)).toEqual(["b"]);
			const history = new History(() => doc, 100, checkContent);
			history.record(new Batch("Erase", commands));
			history.undo();
			expect(ids(doc)).toEqual(["a", "b"]);
		});

		it("an area taken before the gesture reached ink comes back, in its place, and is not in the step", () => {
			const doc = docWith([area("a"), area("b", { y: 400 })], [line(60, 110, 120, 114)]);
			const { commands, g } = gesture();
			expect(g.eraseAreas(doc, "p1", hit(doc), filter("all"))).toBe(true);
			expect(ids(doc)).toEqual(["b"]);
			const ink = rubOut(doc);
			ink.apply(doc);
			commands.push(ink);
			expect(g.inkErased(doc, filter("all"))).toBe(true);
			expect(ids(doc)).toEqual(["a", "b"]);
			expect(commands).toEqual([ink]);
			expect(g.eraseAreas(doc, "p1", hit(doc), filter("all"))).toBe(false);
		});

		it("with the highlighter filter the area goes even when ink goes in the same gesture", () => {
			const doc = docWith([area("a")], [line(60, 110, 120, 114)]);
			const { commands, g } = gesture();
			const ink = rubOut(doc);
			ink.apply(doc);
			commands.push(ink);
			g.inkErased(doc, filter("highlighter"));
			expect(g.allowed(filter("highlighter"))).toBe(true);
			expect(g.eraseAreas(doc, "p1", hit(doc), filter("highlighter"))).toBe(true);
			expect(ids(doc)).toEqual([]);
			expect(commands).toHaveLength(2);
			// Ink that goes after the area does not bring it back under this filter.
			const other = docWith([area("a")]);
			const next = gesture();
			next.g.eraseAreas(other, "p1", other.pages[0]!.elements as AreaElement[], filter("highlighter"));
			expect(next.g.inkErased(other, filter("highlighter"))).toBe(false);
			expect(ids(other)).toEqual([]);
		});
	});

	it("the area eraser removes the areas whose centre is inside its outline, as one undo step", () => {
		const doc = docWith([area("a"), area("b", { y: 400 }), area("c", { y: 100, locked: true, lockAt: 1 })]);
		const page = doc.pages[0]!;
		const poly: Array<[number, number]> = [[0, 80], [400, 80], [400, 160], [0, 160]];
		const cmd = eraseAreaCommand(page, poly, { filter: filter("all"), includeElements: false })!;
		expect(cmd).not.toBeNull();
		const history = new History(() => doc, 100, checkContent);
		expect(history.execute(cmd)).toBe(true);
		expect(page.elements!.map((e) => e.id)).toEqual(["b", "c"]);
		history.undo();
		expect(page.elements!.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
		expect(eraseAreaCommand(page, poly, { filter: filter("pen"), includeElements: false })).toBeNull();
	});
});

describe("area highlighter: the history, the page lock and the page times", () => {
	it("adding an area is one undo step, and redo gives the very same area", () => {
		const doc = docWith([]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const a = createArea([10, 10], [200, 40], page, "#facc15")!;
		expect(history.execute(new AddElement(page.id, a, 0))).toBe(true);
		expect(areasOf(page)).toHaveLength(1);
		history.undo();
		expect(areasOf(page)).toHaveLength(0);
		history.redo();
		expect(areasOf(page)[0]).toMatchObject({ id: a.id, x: 10, y: 10 });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("remaps through an upkeep swap like every element command", () => {
		const doc = docWith([area("a")]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const cmd = new RemoveElement(page.id, page.elements![0]!);
		expect(history.execute(cmd)).toBe(true);
		const swapped = area("a", { color: "#4ade80" });
		cmd.remap((el) => (el.id === "a" ? swapped : el));
		history.undo();
		expect(page.elements![0]).toBe(swapped);
	});

	it("a locked page refuses it, and a stamped page records when it was written", () => {
		const doc = docWith([]);
		const page = doc.pages[0]!;
		const locked: string[] = [];
		const history = new History(() => doc, 100, checkContent, null, null, (ids) => void locked.push(...ids), () => 1_700_000_000_000);
		page.locked = true;
		expect(history.execute(new AddElement(page.id, area("a"), 0))).toBe(false);
		expect(areasOf(page)).toHaveLength(0);
		delete page.locked;
		expect(history.execute(new AddElement(page.id, area("a"), 0))).toBe(true);
		expect(page.startAt).toBe(1_700_000_000_000);
		expect(page.endAt).toBe(1_700_000_000_000);
	});

	it("a locked area is not offered to be edited, and a group comes whole", () => {
		const doc = docWith([area("a", { group: "g1" }), area("l", { y: 300, locked: true, lockAt: 1 })], [{ ...line(10, 10, 60, 10), group: "g1" }]);
		const page = doc.pages[0]!;
		const [a, l] = page.elements!;
		expect(selectableItems(page, { strokes: [], elements: [a!, l!] }).elements.map((e) => e.id)).toEqual(["a"]);
		const grouped = expandToGroups(page, { strokes: [page.strokes[0]!], elements: [] });
		expect(grouped.elements.map((e) => e.id)).toEqual(["a"]);
		const rename = groupRenamer(() => "fresh");
		expect(rename("g1")).toBe("fresh");
	});
});

describe("area highlighter: recolouring", () => {
	it("is recoloured with the highlighter colours, as one undo step, and the ink colours leave it alone", () => {
		const a = area("a");
		const ink = Object.freeze(createStroke("#1e1e1e", 2, [[1, 1, 0.5], [9, 9, 0.5]]));
		const doc = docWith([a], [ink]);
		const page = doc.pages[0]!;
		expect(restyleAbilities([], [a])).toEqual({ inkColor: false, inkWidth: false, highlighterColor: true, highlighterWidth: false });
		expect(commonStyle([], [a], "highlighter").color).toBe("#facc15");
		expect(commonStyle([], [a], "ink").color).toBeNull();
		expect(planRestyle(page, [], [a], { group: "ink", color: "#dc2626" })).toBeNull();
		const plan = planRestyle(page, [ink], [a], { group: "highlighter", color: "#4ADE80" })!;
		expect(plan).not.toBeNull();
		const history = new History(() => doc, 100, checkContent);
		expect(history.execute(plan.command)).toBe(true);
		expect(page.elements![0]).toMatchObject({ id: "a", color: "#4ade80", width: 300 });
		expect(plan.elements[0]).toBe(page.elements![0]);
		expect(page.strokes[0]).toBe(ink);
		history.undo();
		expect(page.elements![0]).toBe(a);
		expect(withAreaColour(a, "#f472b6")).toMatchObject({ color: "#f472b6", id: "a" });
	});
});

describe("area highlighter: the order and the look in every render and export path", () => {
	const page = (): Page => {
		const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
		p.id = "p1";
		p.strokes = [Object.freeze(line(20, 110, 380, 112, 12, 3))];
		const text: TextElement = { id: "t", type: "text", x: 40, y: 104, width: 200, text: "typed", fontSize: 14, color: "#000000" };
		p.elements = [text, area("a")];
		return p;
	};

	it("the SVG draws the area as a highlighter (same opacity, multiplied) under the typed text and the ink", () => {
		const svg = pageToSvg(page());
		const rect = svg.indexOf('<rect x="40" y="100" width="300" height="24" fill="#facc15"');
		expect(rect).toBeGreaterThan(0);
		expect(svg).toContain(`fill="#facc15" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"`);
		expect(svg.indexOf("<text", rect)).toBeGreaterThan(rect);
		expect(svg.lastIndexOf("<path", svg.length)).toBeGreaterThan(rect);
		expect(svg.indexOf('fill="#1e1e1e"')).toBeGreaterThan(rect);
	});

	it("the PDF draws the area with the highlighter's graphics state before the ink", () => {
		const bytes = new TextDecoder("latin1").decode(pagesToPdf([page()]));
		expect(bytes).toContain("/GS1 gs");
		expect(bytes).toContain(`/ca ${HIGHLIGHTER_ALPHA} /BM /Multiply`);
		const at = bytes.indexOf("40 100 300 24 re f");
		expect(at).toBeGreaterThan(0);
		expect(bytes.indexOf("/GS1 gs")).toBeLessThan(at);
		expect(bytes.indexOf("0.118 0.118 0.118 rg")).toBeGreaterThan(at);
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
			return new Proxy(state, {
				get(t, k: string) {
					if (k in t) return t[k];
					if (k === "measureText") return () => ({ width: 10 });
					if (k === "fillRect" || k === "fill") return (...args: unknown[]) => calls.push({ op: k, style: t.fillStyle, alpha: t.globalAlpha, blend: t.globalCompositeOperation, args });
					return () => undefined;
				},
				set(t, k: string, v) {
					t[k] = v;
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		}

		it("paints the rectangle with the highlighter's look, before the ink", () => {
			drawPageRaster(ctx(), page(), 1, { background: null, images: new Map() });
			const rect = calls.findIndex((c) => c.op === "fillRect" && c.style === "#facc15");
			expect(rect).toBeGreaterThanOrEqual(0);
			expect(calls[rect]).toMatchObject({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply", args: [40, 100, 300, 24] });
			const ink = calls.findIndex((c) => c.op === "fill" && c.style === "#1e1e1e");
			expect(ink).toBeGreaterThan(rect);
		});

		it("leaves it out of a background-only export and keeps it in an ink-only one", () => {
			drawPageRaster(ctx(), page(), 1, { background: null, images: new Map(), layers: "background" });
			expect(calls.some((c) => c.style === "#facc15")).toBe(false);
			drawPageRaster(ctx(), page(), 1, { background: null, images: new Map(), layers: "ink" });
			expect(calls.some((c) => c.style === "#facc15")).toBe(true);
		});
	});

	it("the look is the highlighter's everywhere", () => {
		expect(areaLook()).toEqual({ alpha: HIGHLIGHTER_ALPHA, blend: "multiply" });
	});

	it("a sheet may be cut through an area (it is not a hard obstacle)", () => {
		const obstacles = contentObstacles(page());
		const mine = obstacles.find((o) => o.minX === 40 && o.minY === 100 && o.maxX === 340);
		expect(mine).toBeDefined();
		expect(mine!.hard).toBe(false);
	});
});

describe("area highlighter: the action, its ranking and its help", () => {
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("is ranked first while the highlighter is in hand and on a PDF page, and not on a plain page with the pen", () => {
		const action = find("highlighter-area");
		const pen = baseContext();
		const hl = baseContext({ tool: "highlighter" });
		const pdf = baseContext({ page: { index: 0, count: 3, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } });
		expect(contextBoost(action, pen)).toBe(0);
		expect(contextBoost(action, hl)).toBeGreaterThanOrEqual(20);
		expect(contextBoost(action, pdf)).toBeGreaterThanOrEqual(20);
		expect(forThisPage(ACTIONS, hl, {}, 1_800_000_000_000).map((a) => a.id)).toContain("highlighter-area");
	});

	it("shows its state, runs on an editable notebook only, and has an explanation in both languages", () => {
		const action = find("highlighter-area");
		expect(isChecked(action, baseContext())).toBe(false);
		expect(isChecked(action, baseContext({ toggles: { ...baseContext().toggles, highlighterArea: true } }))).toBe(true);
		expect(isEnabled(action, baseContext({ editable: false }))).toBe(false);
		expect(isEnabled(action, baseContext())).toBe(true);
		const key = ACTION_HELP["highlighter-area"]!;
		expect(en[key].length).toBeGreaterThan(20);
		expect(it_[key]?.length ?? 0).toBeGreaterThan(20);
		for (const k of ["help.highlighter.modeStroke", "help.highlighter.modeArea", "highlighter.mode.stroke", "highlighter.mode.area", "highlighter.areaAction", "groups.kind.area"] as const) {
			expect(en[k].length, k).toBeGreaterThan(0);
			expect(it_[k]?.length ?? 0, k).toBeGreaterThan(0);
		}
	});
});
