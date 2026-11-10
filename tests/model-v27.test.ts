/**
 * Format v27: the study tape (#10) — the page element "tape" (an opaque rectangle that hides what is under it and is revealed by a tap): the fields,
 * the v26 -> v27 migration, lenient read and strict write, staged loading, repair, merge, geometry (bounds, hit, move, turn, layers), the view-only
 * reveal state, the tool (drag to lay, tap to reveal or hide, with the pen, a finger and on a read-only notebook), the history, the order and look in
 * every render and export path (hidden), the clean copy and the hand-in (left out), redaction (fail-closed), the actions, the setting and the texts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { TapeTools } = await import("../src/view/tape-tools");
const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };

import { createDocument, createPage } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { elementContentKey, planMerge } from "../src/model/merge";
import { repairLiveDocument, repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { AddElement, History, RemoveElement, type Command } from "../src/model/history";
import { describeCommand } from "../src/model/history-describe";
import { elementBand } from "../src/model/layers";
import { pageInfo } from "../src/model/page-info";
import { cleanPagesForExport, resolveCleanOptions, TAPES_ONLY } from "../src/model/clean-export";
import {
	coveredByTape, createTape, DEFAULT_TAPE_COLOR, hidingTapes, isTapeColorName, TAPE_COLOR_NAMES, TAPE_COLORS, TAPE_MAX_SIDE, TAPE_MIN_SIDE, tapeAt, tapeColorOf,
	tapeCounts, TapeReveal, tapeRect, tapesOf, underTape,
} from "../src/model/tape";
import {
	CURRENT_VERSION, ELEMENT_TYPES_V27, FORMAT_ID, type AreaElement, type MarkerElement, type NotebookDocument, type Page, type PageElement, type TapeElement, type TextElement,
} from "../src/model/types";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { rotate90Matrix } from "../src/ink/selection-transform";
import { apply, rotateAbout, scaleAbout, translate } from "../src/ink/transform";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { drawPageRaster } from "../src/ink/page-raster";
import { redactPage } from "../src/ink/redact";
import { drawTape, mixHex, nightTape, TAPE_EDGE, tapeEdge } from "../src/ink/tape-render";
import { pageSignature } from "../src/view/view-helpers";
import { readSettings, DEFAULT_SETTINGS } from "../src/settings";
import { settingSpecs } from "../src/view/settings-schema";
import { ACTIONS, baseContext, isChecked, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { en, type MessageKey } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { delAt, getAt, parseRaw, setAt } from "./raw-json";
import { line } from "./helpers";

const stamp = "2026-11-10T10:00:00.000Z";
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

function tape(id: string, extra: Partial<TapeElement> = {}): TapeElement {
	return Object.freeze({ id, type: "tape", x: 40, y: 100, width: 300, height: 24, color: "#8fd3bf", ...extra });
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

function v26Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 26, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("format v27: the fields", () => {
	it("writes and reads a tape in a fixed order and writes it back byte for byte", () => {
		const doc = docWith([tape("a"), tape("b", { x: 10.5, y: 20.25, width: 120, height: 14, color: "#9cc3ec", locked: true, lockAt: 1_700_000_000_000 })]);
		const checked = serializeChecked(doc, true);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.text).toContain('{"id":"a","type":"tape","x":40,"y":100,"width":300,"height":24,"color":"#8fd3bf"}');
		const back = parsed(checked.text).doc.pages[0]!.elements!;
		expect(back[0]).toMatchObject({ id: "a", type: "tape", width: 300, height: 24, color: "#8fd3bf" });
		expect(back[1]).toMatchObject({ id: "b", x: 10.5, y: 20.25, locked: true, lockAt: 1_700_000_000_000 });
		expect(serialize(parsed(checked.text).doc)).toBe(checked.text);
	});

	it("is a document of the current version", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(27);
		expect(ELEMENT_TYPES_V27).toEqual(["tape"]);
		expect(parsed(serialize(docWith([tape("a")]))).doc.version).toBe(CURRENT_VERSION);
	});

	it("never stores whether a tape is revealed, and has no opacity (stray keys are not read back)", () => {
		const raw = parseRaw(serialize(docWith([tape("a")])));
		setAt(raw, ["pages", 0, "elements", 0, "revealed"], true);
		setAt(raw, ["pages", 0, "elements", 0, "opacity"], 0.5);
		const el = parsed(JSON.stringify(raw)).doc.pages[0]!.elements![0]!;
		expect(el).toEqual({ id: "a", type: "tape", x: 40, y: 100, width: 300, height: 24, color: "#8fd3bf" });
		expect(serialize(parsed(JSON.stringify(raw)).doc)).not.toContain("revealed");
	});

	it("refuses to write a malformed one (strict)", () => {
		for (const extra of [
			{ color: "mint" }, { color: "#12345" }, { width: 3 }, { height: 0 }, { width: -5 }, { width: TAPE_MAX_SIDE + 1 }, { height: TAPE_MAX_SIDE + 1 }, { x: Number.NaN }, { y: Infinity },
		]) {
			const r = serializeChecked(docWith([tape("a", extra)]), true);
			expect(r.ok, JSON.stringify(extra)).toBe(false);
		}
		expect(serializeChecked(docWith([tape("a", { width: TAPE_MIN_SIDE, height: TAPE_MAX_SIDE })]), true).ok).toBe(true);
	});

	it("reads leniently: a tape with an invalid value is dropped and counted, the rest of the page stays", () => {
		const raw = parseRaw(serialize(docWith([tape("a"), tape("b"), tape("c"), tape("d")], [line(10, 10, 50, 10)])));
		setAt(raw, ["pages", 0, "elements", 0, "color"], "mint");
		setAt(raw, ["pages", 0, "elements", 1, "width"], 2);
		delAt(raw, ["pages", 0, "elements", 2, "height"]);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(3);
		expect(r.doc.pages[0]!.elements!.map((e) => e.id)).toEqual(["d"]);
		expect(r.doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("shares the id space of strokes and elements", () => {
		const doc = docWith([tape("a")], [line(10, 10, 50, 10)]);
		doc.pages[0]!.strokes[0] = { ...doc.pages[0]!.strokes[0]!, id: "a" };
		expect(serializeChecked(doc, true).ok).toBe(false);
	});
});

describe("format v27: migration from v26", () => {
	it("changes nothing but the version of a valid v26 document", () => {
		const raw = v26Raw();
		const migrated = MIGRATIONS[26]!(raw);
		expect(migrated).toEqual({ ...raw, version: 27 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("reads a v26 file and writes it as the current version", () => {
		const r = parsed(JSON.stringify(v26Raw()));
		expect(r.migratedFrom).toBe(26);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(CURRENT_VERSION);
	});

	it("reads files of older versions through the chain", () => {
		for (const version of [22, 23, 25]) {
			const raw = v26Raw();
			setAt(raw, ["version"], version);
			const r = parsed(JSON.stringify(raw));
			expect(r.migratedFrom, String(version)).toBe(version);
			expect(r.doc.version).toBe(CURRENT_VERSION);
		}
	});

	it("opens a file of a newer format read-only (an older plugin opens a v27 file the same way)", () => {
		const raw = parseRaw(serialize(docWith([tape("a")])));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it.each([10, 17, 22, 23, 25, 26])("v%i: a file that holds a tape is refused, with the reason (it was not written by this plugin)", (version) => {
		const raw = parseRaw(serialize(docWith([tape("a")], [line(10, 10, 50, 10)])));
		setAt(raw, ["version"], version);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).not.toBe("future-version");
			expect(r.message).toMatch(/tape/);
		}
	});

	it("stages a large v27 file with tapes and a large v26 file without, and writes them back", () => {
		const doc = stressDocument(6000, 3, 7);
		const plain = serialize(doc);
		doc.pages[0]!.elements = [tape("zz1"), tape("zz2", { color: "#f2aebf" })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
		const old = plain.replace(`"version": ${CURRENT_VERSION}`, '"version": 26');
		const stagedOld = parseStaged(old, 1);
		expect(stagedOld).toBeInstanceOf(StagedParse);
		const r26 = (stagedOld as StagedParse).finish();
		expect(r26.ok).toBe(true);
		if (r26.ok) {
			expect(r26.migratedFrom).toBe(26);
			expect(serialize(r26.doc)).toBe(plain);
		}
	});

	it("a large v26 file with a tape is refused when its page is read, in the staged path too", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.elements = [tape("zz1")];
		const text = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, '"version": 26');
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 0);
		const r = staged instanceof StagedParse ? staged.finish() : staged;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/tape/);
	});
});

describe("format v27: repair, merge and page info", () => {
	it("repair keeps a valid tape and its flags, and drops an invalid one", () => {
		const raw = parseRaw(serialize(docWith([tape("a", { locked: true, lockAt: 5 }), tape("b"), tape("c")])));
		setAt(raw, ["pages", 0, "elements", 1, "width"], "wide");
		delAt(raw, ["pages", 0, "elements", 2, "color"]);
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const els = r.doc.pages[0]!.elements ?? [];
		expect(els.map((e) => e.id)).toEqual(["a"]);
		expect(els[0]).toMatchObject({ type: "tape", locked: true, lockAt: 5 });
	});

	it("a tape held in memory without a colour gets the default one, so the save is not refused forever", () => {
		const doc = docWith([{ id: "a", type: "tape", x: 1, y: 1, width: 10, height: 10, color: "" }]);
		expect(repairLiveDocument(doc)).toBe(1);
		expect(doc.pages[0]!.elements![0]).toMatchObject({ color: TAPE_COLORS[DEFAULT_TAPE_COLOR] });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("merge: the same tape on both sides is one tape, a tape only the copy has is brought in", () => {
		const main = docWith([tape("a")]);
		const copy = docWith([tape("a2"), tape("b", { y: 300 })]);
		const plan = planMerge(main, copy);
		expect(plan.command).not.toBeNull();
		plan.command!.apply(main);
		const els = tapesOf(main.pages[0]!);
		expect(els.map((e) => e.y).sort((x, y) => x - y)).toEqual([100, 300]);
		expect(elementContentKey(tape("x"))).toBe(elementContentKey(tape("y")));
		expect(elementContentKey(tape("x"))).not.toBe(elementContentKey(tape("x", { color: "#9cc3ec" })));
	});

	it("page info counts the tapes", () => {
		const doc = docWith([tape("a"), tape("b", { y: 300 })]);
		const info = pageInfo(doc, 0, 0);
		expect(info?.elements.tape).toBe(2);
		expect(info?.elements.total).toBe(2);
	});
});

describe("study tape: geometry", () => {
	const page = { width: 400, height: 600 };

	it("a drag from any corner to the opposite one is the same rectangle, kept on the page", () => {
		const r = tapeRect([100, 50], [20.004, 80.9], page)!;
		expect(r).toEqual({ x: 20, y: 50, width: 80, height: 30.9 });
		expect(tapeRect([20, 80.9], [100, 50], page)).toEqual(r);
		expect(tapeRect([-50, -10], [900, 300], page)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
	});

	it("a drag too small to be a tape lays nothing", () => {
		expect(tapeRect([10, 10], [10, 10], page)).toBeNull();
		expect(tapeRect([10, 10], [10 + TAPE_MIN_SIDE - 0.5, 200], page)).toBeNull();
		expect(tapeRect([Number.NaN, 1], [5, 100], page)).toBeNull();
		expect(createTape([10, 10], [12, 12], page, "#8fd3bf")).toBeNull();
		const made = createTape([10, 10], [110, 40], page, "#8fd3bf")!;
		expect(made).toMatchObject({ type: "tape", x: 10, y: 10, width: 100, height: 30, color: "#8fd3bf" });
		expect(made.id.length).toBeGreaterThan(10);
	});

	it("has the bounds of its rectangle and is hit first, above every other element (top-most tape first)", () => {
		const a = tape("a");
		const b = tape("b", { x: 100, y: 110, width: 50, height: 50 });
		const text: TextElement = { id: "t", type: "text", x: 40, y: 100, width: 300, text: "answer", fontSize: 14, color: "#000000" };
		expect(elementBounds(a)).toEqual({ minX: 40, minY: 100, maxX: 340, maxY: 124 });
		expect(hitElement([a, text], 300, 112, 0)).toBe(a);
		expect(hitElement([text, a], 300, 112, 0)).toBe(a);
		expect(hitElement([a, b], 120, 118, 0)).toBe(b);
		expect(hitElement([b, a], 120, 118, 0)).toBe(a);
		expect(tapeAt([a, b], 120, 118)).toBe(b);
		expect(tapeAt([a, b], 20, 112)).toBeNull();
		expect(tapeAt([a, b], 36, 112, 6)).toBe(a);
	});

	it("covers what lies wholly under it", () => {
		const a = tape("a");
		expect(underTape([a], 40, 100)).toBe(true);
		expect(underTape([a], 39, 100)).toBe(false);
		expect(coveredByTape({ minX: 50, minY: 105, maxX: 300, maxY: 120 }, [a])).toBe(true);
		expect(coveredByTape({ minX: 50, minY: 105, maxX: 350, maxY: 120 }, [a])).toBe(false);
		expect(coveredByTape({ minX: 50, minY: 105, maxX: 300, maxY: 120 }, [])).toBe(false);
	});

	it("moves, resizes each side on its own (within the limits) and keeps its colour", () => {
		const a = tape("a");
		expect(transformElement(a, translate(10, -20))).toMatchObject({ x: 50, y: 80, width: 300, height: 24, color: "#8fd3bf", id: "a" });
		expect(transformElement(a, scaleAbout(2, 0.5, 40, 100))).toMatchObject({ x: 40, y: 100, width: 600, height: 12 });
		const tiny = transformElement(a, scaleAbout(0.001, 0.001, 40, 100)) as TapeElement;
		expect(tiny.width).toBe(TAPE_MIN_SIDE);
		expect(tiny.height).toBe(TAPE_MIN_SIDE);
		const huge = transformElement(a, scaleAbout(1e6, 1e6, 40, 100)) as TapeElement;
		expect(huge.width).toBe(TAPE_MAX_SIDE);
	});

	it("turns a quarter turn with the selection, and any other turn keeps it upright with its centre where the turn takes it", () => {
		const a = tape("a", { x: 100, y: 100, width: 60, height: 20 });
		const quarter = transformElement(a, rotate90Matrix(elementBounds(a), true)) as TapeElement;
		expect([quarter.width, quarter.height]).toEqual([20, 60]);
		expect(quarter.x + quarter.width / 2).toBeCloseTo(130);
		const turned = transformElement(a, rotateAbout(Math.PI / 6, 0, 0)) as TapeElement;
		expect(turned.width).toBeCloseTo(60, 1);
		const c = apply(rotateAbout(Math.PI / 6, 0, 0), 130, 110);
		expect(turned.x + turned.width / 2).toBeCloseTo(c[0], 1);
		expect(turned.y + turned.height / 2).toBeCloseTo(c[1], 1);
	});

	it("is the top layer of all the elements", () => {
		const text: TextElement = { id: "t", type: "text", x: 0, y: 0, width: 50, text: "x", fontSize: 12, color: "#000000" };
		const area: AreaElement = { id: "ar", type: "area", x: 0, y: 0, width: 50, height: 50, color: "#facc15" };
		const marker: MarkerElement = { id: "m", type: "marker", kind: "gap", x: 0, y: 0, width: 40, height: 20, at: stamp };
		for (const other of [text, area, marker]) expect(elementBand(tape("a")), other.type).toBeGreaterThan(elementBand(other));
	});

	it("changes the thumbnail signature when its rectangle or colour changes", () => {
		const p = docWith([tape("a")]).pages[0]!;
		const before = pageSignature(p);
		p.elements = [tape("a", { color: "#9cc3ec" })];
		expect(pageSignature(p)).not.toBe(before);
		p.elements = [tape("a", { width: 301 })];
		expect(pageSignature(p)).not.toBe(before);
	});
});

describe("study tape: the reveal state (view-only)", () => {
	it("toggles one tape, reveals all and hides all, and counts", () => {
		const reveal = new TapeReveal();
		const doc = docWith([tape("a"), tape("b", { y: 300 })]);
		const page = doc.pages[0]!;
		expect(hidingTapes(page, reveal).map((t) => t.id)).toEqual(["a", "b"]);
		expect(reveal.toggle("a")).toBe(true);
		expect(reveal.isRevealed("a")).toBe(true);
		expect(hidingTapes(page, reveal).map((t) => t.id)).toEqual(["b"]);
		expect(tapeCounts(doc.pages, reveal)).toEqual({ total: 2, revealed: 1 });
		const v = reveal.version;
		expect(reveal.revealAll(tapesOf(page))).toBe(true);
		expect(reveal.version).toBeGreaterThan(v);
		expect(reveal.revealAll(tapesOf(page))).toBe(false);
		expect(tapeCounts(doc.pages, reveal)).toEqual({ total: 2, revealed: 2 });
		expect(reveal.hideAll()).toBe(true);
		expect(reveal.hideAll()).toBe(false);
		expect(reveal.size).toBe(0);
		expect(reveal.toggle("a")).toBe(true);
		expect(reveal.toggle("a")).toBe(false);
		expect(hidingTapes(page, null)).toHaveLength(2);
	});

	it("forgets the tapes a new document does not have, and keeps the others", () => {
		const reveal = new TapeReveal();
		reveal.revealAll([{ id: "a" }, { id: "gone" }]);
		reveal.prune(docWith([tape("a")]));
		expect(reveal.isRevealed("a")).toBe(true);
		expect(reveal.isRevealed("gone")).toBe(false);
		reveal.prune(null);
		expect(reveal.size).toBe(0);
	});

	it("is not in the document: the same notebook written with tapes revealed or hidden is the same text", () => {
		const doc = docWith([tape("a")]);
		const before = serialize(doc);
		new TapeReveal().toggle("a");
		expect(serialize(doc)).toBe(before);
	});
});

describe("study tape: the tool", () => {
	interface FakeStage { handlers: Map<string, (e: unknown) => void>; addEventListener(t: string, f: (e: unknown) => void): void; removeEventListener(t: string): void }
	function setup(options: { editable?: boolean; fingerPans?: boolean; penBusy?: boolean } = {}) {
		const doc = docWith([tape("t1", { x: 100, y: 100, width: 100, height: 40 })]);
		const history = new History(() => doc, 100, checkContent);
		const stage: FakeStage = {
			handlers: new Map(),
			addEventListener(type, fn) { this.handlers.set(type, fn); },
			removeEventListener(type) { this.handlers.delete(type); },
		};
		const previews: Array<TapeElement | null> = [];
		let repaints = 0;
		const state = { editable: options.editable ?? true };
		const tools = new TapeTools({
			stage: () => stage as unknown as HTMLElement,
			doc: () => doc,
			editable: () => state.editable,
			execute: (cmd: Command) => history.execute(cmd),
			color: () => tapeColorOf("sky"),
			scale: () => 1,
			pageAt: (x: number, y: number) => ({ pageIndex: 0, local: [x, y] }),
			fingerNavigates: () => options.fingerPans ?? true,
			penBusy: () => options.penBusy ?? false,
			preview: (_i: number, t: TapeElement | null) => void previews.push(t),
			repaint: () => void repaints++,
		});
		const page = doc.pages[0]!;
		const pointer = (type: string, x: number, y: number, timeStamp: number, pointerType = "touch") =>
			stage.handlers.get(type)?.({ isPrimary: true, pointerType, pointerId: 1, clientX: x, clientY: y, timeStamp });
		return { doc, page, history, tools, previews, repaints: () => repaints, pointer, state };
	}

	beforeEach(() => {
		Notice.shown.length = 0;
	});

	it("the mode lays a tape with a drag, in the colour of the setting, as one undo step", () => {
		const s = setup();
		s.tools.toggleDrawing();
		expect(s.tools.drawing).toBe(true);
		expect(last(Notice.shown)).toBe(en["tape.mode.on"]);
		expect(s.tools.begin(0, s.page, [10, 300], { x: 10, y: 300, t: 0 }, "pen")).toBe(true);
		expect(s.tools.move([150, 340], { x: 150, y: 340 })).toBe(true);
		expect(last(s.previews)).toMatchObject({ type: "tape", x: 10, y: 300, width: 140, height: 40 });
		expect(s.tools.end(false, 200)).toBe(true);
		expect(last(s.previews)).toBeNull();
		const laid = tapesOf(s.page);
		expect(laid).toHaveLength(2);
		expect(laid[1]).toMatchObject({ x: 10, y: 300, width: 140, height: 40, color: TAPE_COLORS.sky });
		s.history.undo();
		expect(tapesOf(s.page)).toHaveLength(1);
		s.tools.toggleDrawing();
		expect(s.tools.drawing).toBe(false);
		expect(last(Notice.shown)).toBe(en["tape.mode.off"]);
	});

	it("in the mode a tap reveals the tape under it, or gives a hint where there is none; a locked page lays nothing", () => {
		const s = setup();
		s.tools.toggleDrawing();
		s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen");
		s.tools.end(false, 100);
		expect(s.tools.reveal.isRevealed("t1")).toBe(true);
		s.tools.begin(0, s.page, [10, 500], { x: 10, y: 500, t: 0 }, "pen");
		s.tools.end(false, 100);
		expect(last(Notice.shown)).toBe(en["tape.hint.drag"]);
		expect(s.tools.begin(0, s.page, [10, 300], { x: 10, y: 300, t: 0 }, "pen", true)).toBe(false);
		expect(tapesOf(s.page)).toHaveLength(1);
	});

	it("with the pen, a contact on a hidden tape is taken whole (a tap reveals it, a drag writes nothing)", () => {
		const s = setup();
		expect(s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen")).toBe(true);
		s.tools.move([190, 130], { x: 190, y: 130 });
		expect(s.tools.end(false, 300)).toBe(true);
		expect(s.tools.reveal.isRevealed("t1")).toBe(false);
		expect(s.page.strokes).toHaveLength(0);
		expect(s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen")).toBe(true);
		expect(s.tools.end(false, 120)).toBe(true);
		expect(s.tools.reveal.isRevealed("t1")).toBe(true);
		expect(s.repaints()).toBeGreaterThan(0);
	});

	it("with the pen, a contact on a revealed tape is ink unless it was a tap, which hides it again", () => {
		const s = setup();
		s.tools.reveal.toggle("t1");
		expect(s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen")).toBe(false);
		expect(s.tools.takeTap(false, 100, () => 1)?.id).toBe("t1");
		s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen");
		s.tools.move(null, { x: 190, y: 120 });
		expect(s.tools.takeTap(false, 100, () => 1)).toBeNull();
		s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "pen");
		expect(s.tools.takeTap(false, 900, () => 1)).toBeNull();
		expect(s.tools.begin(0, s.page, [150, 120], { x: 150, y: 120, t: 0 }, "eraser")).toBe(false);
		expect(s.tools.takeTap(false, 100, () => 1)).toBeNull();
	});

	it("a finger that pans taps a tape open and shut, a palm does not, and a drag is a pan", () => {
		const s = setup();
		s.pointer("pointerdown", 150, 120, 0);
		s.pointer("pointerup", 151, 121, 100);
		expect(s.tools.reveal.isRevealed("t1")).toBe(true);
		s.pointer("pointerdown", 97, 120, 200);
		s.pointer("pointerup", 97, 120, 300);
		expect(s.tools.reveal.isRevealed("t1")).toBe(false);
		s.pointer("pointerdown", 150, 120, 400);
		s.pointer("pointerup", 150, 200, 500);
		expect(s.tools.reveal.isRevealed("t1")).toBe(false);
		const palm = setup({ penBusy: true });
		palm.pointer("pointerdown", 150, 120, 0);
		palm.pointer("pointerup", 150, 120, 100);
		expect(palm.tools.reveal.isRevealed("t1")).toBe(false);
		// A finger that draws goes through the pen path instead (begin), not the stage listeners.
		const drawing = setup({ fingerPans: false });
		drawing.pointer("pointerdown", 150, 120, 0);
		drawing.pointer("pointerup", 150, 120, 100);
		expect(drawing.tools.reveal.isRevealed("t1")).toBe(false);
	});

	it("a read-only notebook still reveals with any pointer, and never lays a tape", () => {
		const s = setup({ editable: false });
		s.pointer("pointerdown", 150, 120, 0, "pen");
		s.pointer("pointerup", 150, 120, 100, "pen");
		expect(s.tools.reveal.isRevealed("t1")).toBe(true);
		s.tools.toggleDrawing();
		expect(s.tools.drawing).toBe(false);
		expect(s.tools.begin(0, s.page, [10, 300], { x: 10, y: 300, t: 0 }, "pen")).toBe(false);
	});

	it("reveal all and hide all act on every tape of the notebook; a new document forgets the gone ones", () => {
		const s = setup();
		s.page.elements = [...(s.page.elements ?? []), tape("t2", { y: 400 })];
		s.tools.revealAll();
		expect(s.tools.counts()).toEqual({ total: 2, revealed: 2 });
		s.tools.hideAll();
		expect(s.tools.counts()).toEqual({ total: 2, revealed: 0 });
		s.tools.reveal.toggle("t2");
		s.page.elements = s.page.elements.filter((e) => e.id !== "t2");
		s.tools.docChanged();
		expect(s.tools.reveal.size).toBe(0);
		s.tools.destroy();
		s.pointer("pointerdown", 150, 120, 0);
		s.pointer("pointerup", 150, 120, 100);
		expect(s.tools.reveal.isRevealed("t1")).toBe(false);
	});
});

describe("study tape: the history and the page lock", () => {
	it("laying a tape is one undo step with a title that names it, and redo gives the very same tape", () => {
		const doc = docWith([]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const t = createTape([10, 10], [200, 40], page, "#8fd3bf")!;
		const cmd = new AddElement(page.id, t, 0);
		expect(history.execute(cmd)).toBe(true);
		expect(describeCommand(cmd).thing).toBe("histpanel.thing.tape");
		history.undo();
		expect(tapesOf(page)).toHaveLength(0);
		history.redo();
		expect(tapesOf(page)[0]).toMatchObject({ id: t.id, x: 10, y: 10 });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("a locked page refuses a new tape and the removal of one", () => {
		const doc = docWith([tape("a")]);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		page.locked = true;
		expect(history.execute(new AddElement(page.id, tape("b"), 1))).toBe(false);
		expect(history.execute(new RemoveElement(page.id, page.elements![0]!))).toBe(false);
		expect(tapesOf(page).map((t) => t.id)).toEqual(["a"]);
	});
});

describe("study tape: the order and the look in every render and export path (hidden)", () => {
	const page = (): Page => {
		const p = createPage({ width: 400, height: 600 }, { kind: "blank", spacing: 14.17 });
		p.id = "p1";
		p.strokes = [Object.freeze(line(20, 110, 380, 112, 12, 3))];
		const text: TextElement = { id: "t", type: "text", x: 40, y: 104, width: 200, text: "answer", fontSize: 14, color: "#000000" };
		p.elements = [tape("a"), text];
		return p;
	};

	it("the SVG draws the tape opaque, after the typed text and the ink", () => {
		const svg = pageToSvg(page());
		const rect = svg.indexOf('<rect x="40" y="100" width="300" height="24" fill="#8fd3bf"/>');
		expect(rect).toBeGreaterThan(0);
		expect(svg.indexOf("<text")).toBeLessThan(rect);
		expect(svg.indexOf('fill="#1e1e1e"')).toBeLessThan(rect);
		expect(svg).toContain(`stroke="${tapeEdge("#8fd3bf")}" stroke-width="${TAPE_EDGE}"`);
		expect(svg.slice(rect)).not.toContain("opacity");
	});

	it("the PDF fills the tape after the ink, at full opacity", () => {
		const bytes = new TextDecoder("latin1").decode(pagesToPdf([page()]));
		const at = bytes.indexOf("40 100 300 24 re f");
		expect(at).toBeGreaterThan(0);
		expect(bytes.indexOf("0.118 0.118 0.118 rg")).toBeLessThan(at);
	});

	describe("the raster (PNG, Copy as image, excerpts, thumbnails)", () => {
		interface Call { op: string; style: unknown; alpha: unknown; args: unknown[] }
		const calls: Call[] = [];
		beforeEach(() => {
			calls.length = 0;
			vi.stubGlobal("Path2D", class { constructor(readonly d?: string) {} });
		});
		afterEach(() => vi.unstubAllGlobals());
		function ctx(): CanvasRenderingContext2D {
			const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
			return new Proxy(state, {
				get(t, k: string) {
					if (k in t) return t[k];
					if (k === "measureText") return () => ({ width: 10 });
					if (k === "fillRect" || k === "fill" || k === "strokeRect") return (...args: unknown[]) => calls.push({ op: k, style: k === "strokeRect" ? t.strokeStyle : t.fillStyle, alpha: t.globalAlpha, args });
					return () => undefined;
				},
				set(t, k: string, v) {
					t[k] = v;
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		}

		it("paints the tape opaque, after the ink", () => {
			drawPageRaster(ctx(), page(), 1, { background: null, images: new Map() });
			const rect = calls.findIndex((c) => c.op === "fillRect" && c.style === "#8fd3bf");
			expect(rect).toBeGreaterThanOrEqual(0);
			expect(calls[rect]).toMatchObject({ alpha: 1, args: [40, 100, 300, 24] });
			const ink = calls.findIndex((c) => c.op === "fill" && c.style === "#1e1e1e");
			expect(ink).toBeGreaterThanOrEqual(0);
			expect(ink).toBeLessThan(rect);
		});

		it("draws a revealed tape as a faint tint and an outline, and a night tape darker", () => {
			drawTape(ctx(), tape("a"), { revealed: true, scale: 2 });
			const fill = calls.find((c) => c.op === "fillRect")!;
			expect(fill.alpha).toBeLessThan(0.3);
			expect(calls.some((c) => c.op === "strokeRect")).toBe(true);
			calls.length = 0;
			drawTape(ctx(), tape("a"), { night: true });
			expect(calls.find((c) => c.op === "fillRect")!.style).toBe(nightTape("#8fd3bf"));
		});
	});

	it("mixes colours exactly and leaves a non-colour alone", () => {
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		expect(mixHex("#8fd3bf", "#000000", 0)).toBe("#8fd3bf");
		expect(mixHex("red", "#000000", 0.5)).toBe("red");
		expect(tapeEdge("#8fd3bf")).not.toBe("#8fd3bf");
	});
});

describe("study tape: the clean copy, the hand-in and redaction", () => {
	const marker: MarkerElement = { id: "m", type: "marker", kind: "gap", x: 0, y: 300, width: 40, height: 20, at: stamp };
	const page = (): Page => ({ ...docWith([tape("a"), marker]).pages[0]! });

	it("a clean copy leaves the tapes out by default (it shows the answers), and keeps them when asked", () => {
		expect(resolveCleanOptions().tapes).toBe(true);
		expect(cleanPagesForExport([page()])[0]!.elements ?? []).toEqual([]);
		expect((cleanPagesForExport([page()], { tapes: false })[0]!.elements ?? []).map((e) => e.id)).toEqual(["a"]);
	});

	it("the hand-in leaves only the tapes out", () => {
		expect((cleanPagesForExport([page()], TAPES_ONLY)[0]!.elements ?? []).map((e) => e.id)).toEqual(["m"]);
	});

	it("redaction cuts a tape around a box (the box is never under a tape), and leaves one away from the boxes alone", () => {
		const p = docWith([tape("a"), tape("far", { y: 400 })]).pages[0]!;
		const out = redactPage(p, [{ x: 100, y: 90, width: 50, height: 50 }]);
		const tapes = tapesOf(out);
		expect(tapes.find((t) => t.id === "far")).toBe(p.elements![1]);
		const parts = tapes.filter((t) => t.id !== "far");
		expect(parts.length).toBeGreaterThanOrEqual(2);
		for (const t of parts) expect(t.x + t.width <= 100 || t.x >= 150).toBe(true);
		const covered = parts.reduce((sum, t) => sum + t.width, 0);
		expect(covered).toBeCloseTo(250);
	});
});

describe("study tape: the actions, the setting and the texts", () => {
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("the mode shows its state and needs an editable notebook; reveal and hide all appear only when they would do something", () => {
		const draw = find("study-tape");
		expect(isChecked(draw, baseContext())).toBe(false);
		expect(isChecked(draw, baseContext({ tapes: { drawing: true, total: 0, revealed: 0 } }))).toBe(true);
		expect(isEnabled(draw, baseContext({ editable: false }))).toBe(false);
		const revealAll = find("tapes-reveal-all");
		const hideAll = find("tapes-hide-all");
		const none = baseContext({ tapes: { drawing: false, total: 0, revealed: 0 } });
		const someHidden = baseContext({ tapes: { drawing: false, total: 3, revealed: 1 } });
		const allShown = baseContext({ tapes: { drawing: false, total: 3, revealed: 3 } });
		expect(isRelevant(revealAll, none)).toBe(false);
		expect(isRelevant(hideAll, none)).toBe(false);
		expect(isRelevant(revealAll, someHidden)).toBe(true);
		expect(isRelevant(hideAll, someHidden)).toBe(true);
		expect(isRelevant(revealAll, allShown)).toBe(false);
		expect(isEnabled(revealAll, { ...someHidden, editable: false })).toBe(true);
	});

	it("is ranked first while the mode is on, and reveal / hide all fit a notebook with tapes", () => {
		const draw = find("study-tape");
		const on = baseContext({ tapes: { drawing: true, total: 0, revealed: 0 } });
		expect(contextBoost(draw, baseContext())).toBe(0);
		expect(contextBoost(draw, on)).toBeGreaterThanOrEqual(20);
		const some = baseContext({ tapes: { drawing: false, total: 2, revealed: 0 } });
		expect(forThisPage(ACTIONS, some, {}, 1_800_000_000_000).map((a) => a.id)).toContain("tapes-reveal-all");
		expect(contextBoost(find("tapes-reveal-all"), baseContext())).toBeLessThan(20);
	});

	it("has its explanations, notices, names and colours in both languages", () => {
		for (const id of ["study-tape", "tapes-reveal-all", "tapes-hide-all"]) {
			const key = ACTION_HELP[id]!;
			expect(en[key].length, id).toBeGreaterThan(20);
			expect(it_[key]?.length ?? 0, id).toBeGreaterThan(20);
		}
		const keys: MessageKey[] = [
			"tape.action.draw", "tape.action.revealAll", "tape.action.hideAll", "tape.mode.on", "tape.mode.off", "tape.hint.drag", "tape.info", "histpanel.thing.tape",
			"groups.kind.tape", "settings.tapeColor", "settings.tapeColor.desc", ...TAPE_COLOR_NAMES.map((n) => `tape.color.${n}` as MessageKey),
		];
		for (const k of keys) {
			expect(en[k].length, k).toBeGreaterThan(0);
			expect(it_[k]?.length ?? 0, k).toBeGreaterThan(0);
		}
	});

	it("the tape colour is a setting of the study section, read only when it is one of the colours", () => {
		expect(DEFAULT_SETTINGS.tapeColor).toBe(DEFAULT_TAPE_COLOR);
		expect(readSettings({ tapeColor: "rose" }).tapeColor).toBe("rose");
		expect(readSettings({ tapeColor: "purple" }).tapeColor).toBe(DEFAULT_TAPE_COLOR);
		expect(readSettings({ tapeColor: 3 }).tapeColor).toBe(DEFAULT_TAPE_COLOR);
		expect(isTapeColorName("slate")).toBe(true);
		expect(isTapeColorName("#ffffff")).toBe(false);
		expect(tapeColorOf("sand")).toBe(TAPE_COLORS.sand);
		expect(tapeColorOf("nonsense")).toBe(TAPE_COLORS[DEFAULT_TAPE_COLOR]);
		const spec = settingSpecs().find((s) => s.id === "tapeColor")!;
		expect(spec.section).toBe("study");
		expect(spec.control.type).toBe("dropdown");
		if (spec.control.type === "dropdown") expect(Object.keys(spec.control.options((k) => en[k]))).toEqual([...TAPE_COLOR_NAMES]);
	});
});
