import { describe, expect, it } from "vitest";
import { needsNextPage, needsPageOffer, OfferGate } from "../src/ink/auto-page";
import { createDocument, createId, createPage } from "../src/model/document";
import { Batch, History, ReorderLayer } from "../src/model/history";
import { boxesOverlap, elementBand, layerCommand, reorder } from "../src/model/layers";
import { pageAssetIds, pageInfo } from "../src/model/page-info";
import { serialize, parse } from "../src/model/serialize";
import {
	DEFAULT_FIND, findInDocument, findInText, MAX_RESULTS, nextHitIndex, replaceAllCommand, replaceHitCommand, replaceInText,
} from "../src/model/text-search";
import type { BoxElement, ImageElement, MarkerElement, NotebookDocument, TextElement } from "../src/model/types";
import { ACTIONS, activeContexts, baseContext, isRelevant } from "../src/ui/actions";
import { buildSheet, contextBar } from "../src/ui/layout";
import { line } from "./helpers";

const NOW = new Date("2026-10-29T10:00:00.000Z");

const text = (value: string, x = 0, y = 0): TextElement => ({ id: createId(), type: "text", x, y, width: 100, text: value, fontSize: 14, color: "#1e1e1e" });
const image = (x = 0, y = 0): ImageElement => ({ id: createId(), type: "image", asset: "aa", x, y, width: 50, height: 50, rotation: 0 });
const box = (x = 0, y = 0): BoxElement => ({ id: createId(), type: "box", kind: "definition", x, y, width: 80, height: 40 });
const marker = (kind: MarkerElement["kind"], done = false): MarkerElement => ({ id: createId(), type: "marker", kind, x: 5, y: 5, ...(done ? { done: true as const } : {}) });

describe("layer order planning (357)", () => {
	const all = (...x: string[]) => new Set(x);
	const list = ["a", "b", "c", "d", "e"];

	it("front and back move the selection to the end, keeping its internal order", () => {
		expect(reorder(list, all("b", "d"), "front")).toEqual(["a", "c", "e", "b", "d"]);
		expect(reorder(list, all("b", "d"), "back")).toEqual(["b", "d", "a", "c", "e"]);
	});

	it("is null when nothing would change", () => {
		expect(reorder(list, all("d", "e"), "front")).toBeNull();
		expect(reorder(list, all("a", "b"), "back")).toBeNull();
		expect(reorder(list, all(), "front")).toBeNull();
		expect(reorder(list, all("zz"), "front")).toBeNull();
	});

	it("forward and backward step one neighbour at a time", () => {
		expect(reorder(list, all("b"), "forward")).toEqual(["a", "c", "b", "d", "e"]);
		expect(reorder(list, all("b"), "backward")).toEqual(["b", "a", "c", "d", "e"]);
		// a group moves as a block and keeps its order
		expect(reorder(list, all("b", "c"), "forward")).toEqual(["a", "d", "b", "c", "e"]);
		expect(reorder(list, all("c", "d"), "backward")).toEqual(["a", "c", "d", "b", "e"]);
		// non-adjacent members never swap with each other
		expect(reorder(list, all("a", "c"), "forward")).toEqual(["b", "a", "d", "c", "e"]);
		expect(reorder(list, all("c", "e"), "forward")).toEqual(["a", "b", "d", "c", "e"]);
		expect(reorder(list, all("d", "e"), "forward")).toBeNull();
		expect(reorder(list, all("a"), "backward")).toBeNull();
	});

	it("forward and backward skip what does not overlap", () => {
		const overlaps = (a: string, b: string) => !(a === "b" && (b === "c" || b === "d"));
		// b passes c and d without effect (no overlap) and lands above e, the first overlapping item above it
		expect(reorder(list, all("b"), "forward", { overlaps })).toEqual(["a", "c", "d", "e", "b"]);
		const onlyE = (_a: string, b: string) => b === "e";
		expect(reorder(list, all("a"), "forward", { overlaps: onlyE })).toEqual(["b", "c", "d", "e", "a"]);
		expect(reorder(list, all("e"), "backward", { overlaps: (_a, b) => b === "b" })).toEqual(["a", "e", "b", "c", "d"]);
		expect(reorder(list, all("a"), "forward", { overlaps: () => false })).toBeNull();
	});

	it("keeps elements inside their stacking band", () => {
		const band = (x: string) => (x.startsWith("img") ? 0 : 1);
		const mixed = ["img1", "txt1", "img2", "txt2"];
		// "front" for an image goes above the other image only; text boxes stay in their slots above the images' band
		expect(reorder(mixed, new Set(["img1"]), "front", { band })).toEqual(["img2", "txt1", "img1", "txt2"]);
		// the first text box is already at the back of the text boxes: the images below it do not count
		expect(reorder(mixed, new Set(["txt1"]), "back", { band })).toBeNull();
		expect(reorder(mixed, new Set(["txt2"]), "back", { band })).toEqual(["img1", "txt2", "img2", "txt1"]);
	});

	it("knows the stacking of element kinds as the renderer draws them", () => {
		// v9: graphs sit between images and boxes, equations between boxes and text (bands 1 and 3).
		expect([image(), box(), text("x"), marker("star")].map(elementBand)).toEqual([0, 2, 4, 5]);
	});

	it("overlap of boxes includes touching edges", () => {
		expect(boxesOverlap({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
		expect(boxesOverlap({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
	});
});

describe("layer order command (357)", () => {
	function setup() {
		const doc = createDocument(NOW);
		const page = doc.pages[0]!;
		// three crossing strokes (all overlap) and a far one
		page.strokes.push(line(0, 0, 100, 100), line(0, 100, 100, 0), line(0, 50, 100, 50), line(400, 400, 450, 450));
		const t1 = text("one", 0, 0), t2 = text("two", 10, 10), img = image(0, 0);
		page.elements = [t1, img, t2];
		return { doc, page, t1, t2, img };
	}

	it("reorders strokes as one undo step and undo restores the very same order", () => {
		const { doc, page } = setup();
		const [a, b, c, far] = page.strokes;
		const history = new History(() => doc);
		const cmd = layerCommand(page, { strokes: [a!], elements: [] }, "front");
		expect(cmd).not.toBeNull();
		history.execute(cmd!);
		expect(page.strokes).toEqual([b, c, far, a]);
		history.undo();
		expect(page.strokes).toEqual([a, b, c, far]);
		history.redo();
		expect(page.strokes).toEqual([b, c, far, a]);
	});

	it("forward passes only strokes that overlap", () => {
		const { doc, page } = setup();
		const [a, b, c, far] = page.strokes;
		const history = new History(() => doc);
		// `far` is the topmost and does not overlap `c`; moving c forward has nothing to pass
		expect(layerCommand(page, { strokes: [c!], elements: [] }, "forward")).toBeNull();
		history.execute(layerCommand(page, { strokes: [a!], elements: [] }, "forward")!);
		expect(page.strokes).toEqual([b, a, c, far]);
	});

	it("moves strokes and elements of one selection in a single step, never mixing the two layers", () => {
		const { doc, page, t1, t2, img } = setup();
		const [a, b, c, far] = page.strokes;
		const history = new History(() => doc);
		const cmd = layerCommand(page, { strokes: [a!], elements: [t1] }, "front");
		expect(cmd).toBeInstanceOf(Batch);
		history.execute(cmd!);
		expect(page.strokes).toEqual([b, c, far, a]);
		// the text box goes above the other text box; the image keeps its slot between them
		expect(page.elements).toEqual([t2, img, t1]);
		history.undo();
		expect(page.strokes).toEqual([a, b, c, far]);
		expect(page.elements).toEqual([t1, img, t2]);
		expect(history.canUndo()).toBe(false);
	});

	it("is null for an already-front selection and for items that are not on the page", () => {
		const { page, t2 } = setup();
		expect(layerCommand(page, { strokes: [page.strokes[3]!], elements: [t2] }, "front")).toBeNull();
		expect(layerCommand(page, { strokes: [], elements: [] }, "back")).toBeNull();
	});

	it("survives an erased stroke between apply and revert (stale lists never corrupt the page)", () => {
		const { doc, page } = setup();
		const [a, b, c, far] = page.strokes;
		const cmd = new ReorderLayer(page.id, "strokes", [a!, b!, c!, far!], [b!, c!, far!, a!]);
		cmd.apply(doc);
		expect(page.strokes).toEqual([b, c, far, a]);
		page.strokes.splice(page.strokes.indexOf(c!), 1);
		cmd.revert(doc);
		expect(page.strokes).toEqual([a, b, far]);
		expect(new Set(page.strokes).size).toBe(page.strokes.length);
	});

	it("round-trips through the file format unchanged: the order is the array order", () => {
		const { doc, page, t1 } = setup();
		doc.assets = { aa: { id: "aa", kind: "image", path: "_assets/aa.png", name: "a.png", bytes: 10 } };
		const history = new History(() => doc);
		history.execute(layerCommand(page, { strokes: [page.strokes[0]!], elements: [t1] }, "front")!);
		const back = parse(serialize(doc));
		if (!back.ok) throw new Error(back.message);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(page.strokes.map((s) => s.id));
		expect(back.doc.pages[0]!.elements!.map((e) => e.id)).toEqual(page.elements!.map((e) => e.id));
		expect(back.doc.version).toBe(doc.version);
	});
});

describe("find in text (361)", () => {
	it("finds every non-overlapping match, case-insensitive by default", () => {
		expect(findInText("Cat cat CAT", "cat")).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
		expect(findInText("aaaa", "aa")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
		expect(findInText("anything", "")).toEqual([]);
	});

	it("matches case when asked", () => {
		expect(findInText("Cat cat CAT", "cat", { matchCase: true, wholeWord: false })).toEqual([{ start: 4, end: 7 }]);
	});

	it("whole word treats letters, digits, underscore and accents as word characters", () => {
		const opts = { matchCase: false, wholeWord: true };
		expect(findInText("cat concat cat_ cat. (cat) 2cat", "cat", opts).map((m) => m.start)).toEqual([0, 16, 22]);
		expect(findInText("città cittàdino", "città", opts)).toEqual([{ start: 0, end: 5 }]);
	});

	it("treats the query literally, never as a pattern", () => {
		expect(findInText("a.b a+b (x) [y] $1", "a.b")).toEqual([{ start: 0, end: 3 }]);
		expect(findInText("1+1=2 (a)", "1+1")).toEqual([{ start: 0, end: 3 }]);
		expect(findInText("x [y] z", "[y]")).toEqual([{ start: 2, end: 5 }]);
	});

	it("replaces literally, including $ sequences and an empty replacement", () => {
		expect(replaceInText("price: cost", "cost", "$& and $1")).toBe("price: $& and $1");
		expect(replaceInText("a-b-c", "-", "")).toBe("abc");
		expect(replaceInText("aaa", "a", "aa")).toBe("aaaaaa");
	});
});

describe("find and replace in a notebook (361)", () => {
	function notebook(): { doc: NotebookDocument; a: TextElement; b: TextElement; c: TextElement } {
		const doc = createDocument(NOW);
		doc.pages.push(createPage(), createPage());
		const a = text("Euler formula and euler number"), b = text("nothing here"), c = text("Euler");
		doc.pages[0]!.elements = [a, image(), b];
		doc.pages[2]!.elements = [c];
		// ink and markers are never searched
		doc.pages[1]!.elements = [marker("question"), { ...box(), title: "Euler" }];
		return { doc, a, b, c };
	}

	it("lists the matches in reading order with page, snippet and counts", () => {
		const { doc } = notebook();
		const r = findInDocument(doc, "euler", DEFAULT_FIND);
		expect(r.total).toBe(3);
		expect(r.boxes).toBe(2);
		expect(r.hits.map((h) => [h.pageIndex, h.start])).toEqual([[0, 0], [0, 18], [2, 0]]);
		expect(r.hits[0]).toMatchObject({ before: "", match: "Euler", ordinal: 0 });
		expect(r.hits[0]!.after.startsWith(" formula and euler numb")).toBe(true);
		expect(r.hits[0]!.after.endsWith("…")).toBe(true);
		expect(r.hits[1]).toMatchObject({ ordinal: 1, match: "euler" });
		expect(r.truncated).toBe(false);
	});

	it("has no results for an empty query and caps the list without capping the count", () => {
		const { doc } = notebook();
		expect(findInDocument(doc, "", DEFAULT_FIND)).toMatchObject({ total: 0, hits: [] });
		doc.pages[0]!.elements = [text("x ".repeat(MAX_RESULTS + 50))];
		const r = findInDocument(doc, "x", DEFAULT_FIND);
		expect(r.hits.length).toBe(MAX_RESULTS);
		expect(r.total).toBe(MAX_RESULTS + 50);
		expect(r.truncated).toBe(true);
	});

	it("replace all is one undo step over the whole notebook, and undo gives back the very same objects", () => {
		const { doc, a, c } = notebook();
		const history = new History(() => doc);
		const plan = replaceAllCommand(doc, "euler", "Gauss", DEFAULT_FIND);
		expect(plan).not.toBeNull();
		expect(plan).toMatchObject({ replaced: 3, boxes: 2 });
		history.execute(plan!.command);
		expect((doc.pages[0]!.elements![0] as TextElement).text).toBe("Gauss formula and Gauss number");
		expect((doc.pages[2]!.elements![0] as TextElement).text).toBe("Gauss");
		// untouched: other boxes, ink-less pages, markers and the box title
		expect((doc.pages[0]!.elements![2] as TextElement).text).toBe("nothing here");
		expect((doc.pages[1]!.elements![1] as BoxElement).title).toBe("Euler");
		// position and style survive; ids too
		expect(doc.pages[0]!.elements![0]).toMatchObject({ id: a.id, x: a.x, y: a.y, width: a.width, fontSize: a.fontSize, color: a.color });
		history.undo();
		expect(doc.pages[0]!.elements![0]).toBe(a);
		expect(doc.pages[2]!.elements![0]).toBe(c);
		expect(history.canUndo()).toBe(false);
		history.redo();
		expect((doc.pages[2]!.elements![0] as TextElement).text).toBe("Gauss");
	});

	it("replace all is null when nothing matches or nothing would change", () => {
		const { doc } = notebook();
		expect(replaceAllCommand(doc, "zzz", "y", DEFAULT_FIND)).toBeNull();
		expect(replaceAllCommand(doc, "", "y", DEFAULT_FIND)).toBeNull();
		expect(replaceAllCommand(doc, "Euler", "Euler", { matchCase: true, wholeWord: false })).toBeNull();
	});

	it("replaces exactly one match, finds the next one after the new text, and refuses a stale hit", () => {
		const { doc } = notebook();
		const history = new History(() => doc);
		const first = findInDocument(doc, "euler", DEFAULT_FIND);
		const second = first.hits[1]!;
		history.execute(replaceHitCommand(doc, second, "euler euler", "euler", DEFAULT_FIND)!);
		expect((doc.pages[0]!.elements![0] as TextElement).text).toBe("Euler formula and euler euler number");
		history.undo();
		expect((doc.pages[0]!.elements![0] as TextElement).text).toBe("Euler formula and euler number");
		// the first match's replacement contains the query: moving on must not land on it again
		const hit0 = first.hits[0]!;
		history.execute(replaceHitCommand(doc, hit0, "Euler Euler", "euler", DEFAULT_FIND)!);
		const fresh = findInDocument(doc, "euler", DEFAULT_FIND);
		expect(fresh.total).toBe(4);
		const next = nextHitIndex(fresh.hits, { pageIndex: 0, elementIndex: hit0.elementIndex, offset: hit0.start + "Euler Euler".length });
		expect(fresh.hits[next]).toMatchObject({ pageIndex: 0, start: "Euler Euler formula and ".length });
		// a hit from before the edit no longer matches its text box
		expect(replaceHitCommand(doc, second, "x", "euler", DEFAULT_FIND)).toBeNull();
	});

	it("keeps a text box empty rather than removing it", () => {
		const { doc } = notebook();
		const history = new History(() => doc);
		history.execute(replaceAllCommand(doc, "Euler", "", DEFAULT_FIND)!.command);
		expect(doc.pages[2]!.elements).toHaveLength(1);
		expect((doc.pages[2]!.elements![0] as TextElement).text).toBe("");
	});

	it("nextHitIndex is -1 when no hit follows", () => {
		const { doc } = notebook();
		const r = findInDocument(doc, "euler", DEFAULT_FIND);
		expect(nextHitIndex(r.hits, { pageIndex: 2, elementIndex: 0, offset: 99 })).toBe(-1);
	});
});

describe("page information (379)", () => {
	function documentWithPage(): { doc: NotebookDocument } {
		const doc = createDocument(NOW);
		doc.assets = {
			aa: { id: "aa", kind: "image", path: "_assets/aa.png", name: "a.png", bytes: 2048 },
			pp: { id: "pp", kind: "pdf", path: "_assets/pp.pdf", name: "p.pdf", bytes: 1024 * 1024 },
		};
		const page = doc.pages[0]!;
		page.strokes.push(line(0, 0, 10, 10, 10), { ...line(0, 0, 10, 10, 4), tool: "highlighter" }, { ...line(5, 5, 9, 9, 2), hidden: true });
		page.background = { kind: "pdf", asset: "pp", page: 1 };
		page.elements = [text("x"), image(), image(), box(), marker("question"), marker("star", true)];
		page.tags = ["physics", "exam"];
		doc.pages.push(createPage());
		doc.meta = { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [page.id], bookmarkInfo: { [page.id]: { title: "Start", category: "important" } } };
		return { doc };
	}

	it("counts strokes, points, objects, markers and tags", () => {
		const { doc } = documentWithPage();
		const info = pageInfo(doc, 0)!;
		expect(info.number).toBe(1);
		expect(info.total).toBe(2);
		expect(info.strokes).toEqual({ total: 3, byTool: { pen: 2, highlighter: 1, shape: 0 }, hidden: 1 });
		expect(info.points).toBe(11 + 5 + 3);
		expect(info.elements).toEqual({ total: 6, text: 1, image: 2, marker: 2, box: 1, equation: 0, graph: 0 });
		expect(info.markers).toEqual({ total: 2, open: 1, byKind: { question: 1, star: 1 } });
		expect(info.tags).toEqual(["physics", "exam"]);
		expect(info.bookmark).toEqual({ title: "Start", category: "important" });
		expect(info.background).toBe("pdf");
		expect(info.preset).toBe("a4");
	});

	it("sums each file once and reports files the notebook does not list", () => {
		const { doc } = documentWithPage();
		expect(pageAssetIds(doc.pages[0]!).sort()).toEqual(["aa", "pp"]);
		expect(pageInfo(doc, 0)!.assets).toEqual({ count: 2, bytes: 2048 + 1024 * 1024, unknown: 0 });
		delete doc.assets!.aa;
		expect(pageInfo(doc, 0)!.assets).toEqual({ count: 2, bytes: 1024 * 1024, unknown: 1 });
		doc.assets = undefined;
		expect(pageInfo(doc, 0)!.assets).toEqual({ count: 2, bytes: 0, unknown: 2 });
	});

	it("an empty page and a page that is not bookmarked", () => {
		const { doc } = documentWithPage();
		const info = pageInfo(doc, 1)!;
		expect(info.strokes.total).toBe(0);
		expect(info.points).toBe(0);
		expect(info.elements.total).toBe(0);
		expect(info.assets).toEqual({ count: 0, bytes: 0, unknown: 0 });
		expect(info.bookmark).toBeNull();
		expect(info.tags).toEqual([]);
		expect(pageInfo(doc, 5)).toBeNull();
	});

	it("gives the dates the file has and the page's own edit time only when this device knows it", () => {
		const { doc } = documentWithPage();
		expect(pageInfo(doc, 0)!.dates).toEqual({ notebookCreated: doc.createdAt, notebookSaved: doc.modifiedAt, pageEditedHere: null });
		expect(pageInfo(doc, 0, 1_700_000_000_000)!.dates.pageEditedHere).toBe(1_700_000_000_000);
		doc.createdAt = "not a date";
		expect(pageInfo(doc, 0)!.dates.notebookCreated).toBeNull();
	});

	it("recognises a custom size and the landscape preset", () => {
		const { doc } = documentWithPage();
		doc.pages[1]!.width = 300;
		doc.pages[1]!.height = 500;
		expect(pageInfo(doc, 1)!.preset).toBeNull();
		const a4 = doc.pages[0]!;
		[a4.width, a4.height] = [a4.height, a4.width];
		expect(pageInfo(doc, 0)!.preset).toBe("a4");
	});
});

describe("automatic page in the middle (389)", () => {
	const page = { height: 800 };

	it("offers on a page that is not the last, near the bottom, when the setting is on", () => {
		expect(needsPageOffer(page, false, 760, true)).toBe(true);
		expect(needsPageOffer(page, false, 720, true)).toBe(true);
		expect(needsPageOffer(page, false, 719, true)).toBe(false);
	});

	it("never on the last page (that one appends by itself), never when the setting is off, never on infinite or background pages", () => {
		expect(needsPageOffer(page, true, 790, true)).toBe(false);
		expect(needsPageOffer(page, false, 790, false)).toBe(false);
		expect(needsPageOffer({ ...page, infinite: true }, false, 790, true)).toBe(false);
		expect(needsPageOffer({ ...page, background: { kind: "pdf", asset: "a", page: 1 } }, false, 790, true)).toBe(false);
		expect(needsPageOffer(page, false, Number.NaN, true)).toBe(false);
	});

	it("is exactly the complement of the automatic append for the same ink", () => {
		for (const isLast of [true, false]) {
			for (const maxY of [100, 719, 720, 790]) {
				const append = needsNextPage(page, isLast, maxY, true);
				const offer = needsPageOffer(page, isLast, maxY, true);
				expect(append && offer).toBe(false);
				expect(append || offer).toBe(maxY >= 720);
			}
		}
	});

	it("remembers a page whose offer was settled until the document is replaced", () => {
		const gate = new OfferGate();
		expect(gate.allows("p1")).toBe(true);
		gate.settle("p1");
		expect(gate.allows("p1")).toBe(false);
		expect(gate.allows("p2")).toBe(true);
		gate.reset();
		expect(gate.allows("p1")).toBe(true);
	});
});

describe("registry entries of wave 0.9 text and objects", () => {
	const by = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("registers the four layer moves for a selection, with commands", () => {
		for (const move of ["front", "forward", "backward", "back"]) {
			const a = by(`layer-${move}`);
			expect(a.contexts).toContain("selection");
			expect(a.surfaces).toContain("context");
			expect(a.command).toBeTruthy();
			expect(isRelevant(a, baseContext())).toBe(false);
			expect(isRelevant(a, baseContext({ tool: "lasso", selection: { strokes: 1, elements: 0, images: 0 } }))).toBe(true);
		}
	});

	it("shows the layer entries in the contextual bar of a selection, best first, within the width", () => {
		const c = baseContext({ tool: "lasso", selection: { strokes: 1, elements: 1, images: 0 } });
		expect(activeContexts(c)[0]).toBe("selection");
		// The bar holds at most 8 entries: the two strongest moves fit beside copy, cut, duplicate, paste, delete and link;
		// forward and backward are in the All actions sheet and on hotkeys.
		const wide = contextBar(c, 1280, {}, 0)!;
		expect(wide.actions).toContain("layer-front");
		expect(wide.actions).toContain("layer-back");
		expect(wide.actions.indexOf("layer-front")).toBeLessThan(wide.actions.indexOf("layer-back"));
	});

	it("keeps the layer moves reachable on a phone through the All actions sheet", () => {
		const c = baseContext({ tool: "lasso", selection: { strokes: 1, elements: 0, images: 0 }, narrow: true });
		const sections = buildSheet(c, { kind: "all", usage: {}, now: 0, label: (a) => a.id });
		const ids = sections.flatMap((s) => s.actions.map((a) => a.id));
		for (const id of ["layer-front", "layer-forward", "layer-backward", "layer-back", "find-replace", "page-info"]) expect(ids).toContain(id);
	});

	it("puts page information in the page sheet and find and replace in the All actions sheet", () => {
		expect(by("page-info").surfaces).toContain("page");
		expect(by("find-replace").surfaces).toContain("sheet");
		expect(by("find-replace").readOnly).toBe(true);
		expect(by("page-info").readOnly).toBe(true);
	});
});
