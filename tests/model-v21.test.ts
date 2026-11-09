/**
 * Format v21: saved views (#264) — the optional notebook-level `views` list: the v20 -> v21 migration, lenient read and strict write,
 * staged loading, repair, the history commands (undo / redo, the guards), merge, copies, and the geometry that captures and recalls a view.
 */
import { describe, expect, it } from "vitest";
import { createDocument } from "../src/model/document";
import { layoutPages } from "../src/ink/layout";
import { layoutPagesHorizontal } from "../src/ink/page-mode";
import { captureRegion, restoreRegion } from "../src/ink/view-region";
import { fitScale } from "../src/ink/view-position";
import { fitWidth, screenToPage, type Size } from "../src/ink/viewport";
import { MIGRATIONS } from "../src/model/migrations";
import { mergeCovers, planMerge } from "../src/model/merge";
import { duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { DeletePage, History } from "../src/model/history";
import {
	A4_HEIGHT, A4_WIDTH, CURRENT_VERSION, FORMAT_ID, VIEWS_MAX, VIEW_NAME_MAX, type NotebookDocument, type SavedView,
} from "../src/model/types";
import {
	isStoredViewName, makeView, mergedViews, newViewId, normalizeViewName, SetViews, setViews, sameViews, uniqueViewName, validRegion, viewPageIndex, viewsOf,
	withViewAdded, withViewMoved, withViewRemoved, withViewRenamed, withViewReplaced,
} from "../src/model/views";
import { moveOptions, viewRows, zoomIsFit, zoomPercent } from "../src/view/saved-views-logic";
import { delAt, getAt, parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-08T10:00:00.000Z";

function view(id: string, over: Partial<SavedView> = {}): SavedView {
	return Object.freeze({ id, name: `View ${id}`, page: "p1", x: 10.5, y: 200, width: 400, height: 300.2, zoom: 1.25, ...over });
}

/** A notebook with three pages and a few views (the last one names a page that is not there). */
function viewDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages.push({ ...doc.pages[0]!, id: "p2", strokes: [] }, { ...doc.pages[0]!, id: "p3", strokes: [] });
	doc.views = [view("a"), view("b", { page: "p3", name: "Proof of lemma 2" }), view("c", { page: "gone", name: "Old page" })];
	return doc;
}

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function v20Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 20, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "fountain", color: "#111111", width: 2, render: 2, nib: 30, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("format v21: saved views", () => {
	it("is the current format and has the v20 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(21);
		expect(typeof MIGRATIONS[20]).toBe("function");
	});

	it("writes the views after the slides and before the assets, one per line, and reads them back exactly", () => {
		const doc = viewDoc();
		const text = serialize(doc);
		expect(text).toContain('"views": [');
		expect(text.indexOf('"views"')).toBeLessThan(text.indexOf('"assets"'));
		expect(text.split("\n").filter((l) => l.startsWith('\t\t{"id":"a"') || l.startsWith('\t\t{"id":"b"') || l.startsWith('\t\t{"id":"c"'))).toHaveLength(3);
		const back = parsed(text);
		expect(back.dropped).toBeUndefined();
		expect(back.doc.views).toEqual(doc.views);
		expect(serialize(back.doc)).toBe(text);
		expect(Object.isFrozen(back.doc.views![0])).toBe(true);
	});

	it("writes no views key when there is none (an empty list is nothing)", () => {
		const doc = viewDoc();
		expect(serialize(doc)).toContain('"views"');
		doc.views = [];
		expect(serialize(doc)).not.toContain('"views"');
		delete doc.views;
		expect(serialize(doc)).not.toContain('"views"');
		expect(parsed(serialize(doc)).doc.views).toBeUndefined();
	});

	it("keeps a view of a page that is gone (it is shown as missing, not dropped)", () => {
		const back = parsed(serialize(viewDoc()));
		expect(back.doc.views!.map((v) => v.id)).toEqual(["a", "b", "c"]);
		expect(back.dropped).toBeUndefined();
		expect(viewPageIndex(back.doc, back.doc.views![2]!)).toBe(-1);
		expect(viewPageIndex(back.doc, back.doc.views![1]!)).toBe(2);
	});

	describe("strict write", () => {
		const refused = (edit: (doc: NotebookDocument) => void): void => {
			const doc = viewDoc();
			edit(doc);
			const checked = serializeChecked(doc);
			expect(checked.ok, "serializeChecked").toBe(false);
			expect(checkContent(doc), "checkContent").not.toBeNull();
		};
		it("refuses a repeated id", () => refused((d) => void d.views!.push(view("a", { name: "Again" }))));
		it("refuses an empty name", () => refused((d) => void (d.views![0] = view("a", { name: "" }))));
		it("refuses a name with spaces around it", () => refused((d) => void (d.views![0] = view("a", { name: " Proof" }))));
		it("refuses a name on two lines", () => refused((d) => void (d.views![0] = view("a", { name: "Two\nlines" }))));
		it("refuses a name with two spaces in a row", () => refused((d) => void (d.views![0] = view("a", { name: "Two  spaces" }))));
		it("refuses a name that is too long", () => refused((d) => void (d.views![0] = view("a", { name: "n".repeat(VIEW_NAME_MAX + 1) }))));
		it("refuses a view without a page", () => refused((d) => void (d.views![0] = view("a", { page: "" }))));
		it("refuses a region without a size", () => refused((d) => void (d.views![0] = view("a", { width: 0 }))));
		it("refuses a zoom out of range", () => refused((d) => void (d.views![0] = view("a", { zoom: 0 }))));
		it("refuses a number that is not finite", () => refused((d) => void (d.views![0] = view("a", { x: Number.NaN }))));
		it("refuses a coordinate beyond the limit", () => refused((d) => void (d.views![0] = view("a", { y: 2e6 }))));
		it("refuses more views than the limit", () => refused((d) => void (d.views = Array.from({ length: VIEWS_MAX + 1 }, (_, i) => view(`v${i}`)))));

		it("accepts exactly the limit and the longest name", () => {
			const doc = viewDoc();
			doc.views = Array.from({ length: VIEWS_MAX }, (_, i) => view(`v${i}`, i === 0 ? { name: "n".repeat(VIEW_NAME_MAX) } : {}));
			expect(serializeChecked(doc).ok).toBe(true);
			expect(checkContent(doc)).toBeNull();
		});

		it("accepts names with other scripts and emoji", () => {
			const doc = viewDoc();
			doc.views = [view("a", { name: "Dimostrazione — è così 数学 😀" })];
			expect(serializeChecked(doc).ok).toBe(true);
			expect(parsed(serialize(doc)).doc.views![0]!.name).toBe("Dimostrazione — è così 数学 😀");
		});

		it("refuses a malformed view in a large notebook too (the skeleton is checked on every save)", () => {
			const doc = stressDocument(40, 2, 3);
			doc.views = [view("a", { page: doc.pages[0]!.id, zoom: -1 })];
			expect(serializeChecked(doc, true).ok).toBe(false);
			expect(serializeChecked(doc).ok).toBe(false);
		});
	});

	describe("lenient read", () => {
		function withViews(list: unknown): string {
			const raw = parseRaw(serialize(viewDoc()));
			setAt(raw, ["views"], list);
			return JSON.stringify(raw);
		}
		const good = { id: "g1", name: "Good", page: "p1", x: 1, y: 2, width: 300, height: 200, zoom: 1 };

		it("drops an invalid entry, counts it and keeps the others", () => {
			const r = parsed(withViews([good, { ...good, id: "g2", zoom: 0 }, { ...good, id: "g3", width: -1 }, "oops", { ...good, id: "g4", name: 3 }, { ...good, id: "g5", page: "" }]));
			expect(r.doc.views!.map((v) => v.id)).toEqual(["g1"]);
			expect(r.dropped).toBe(5);
		});

		it("drops a repeated id", () => {
			const r = parsed(withViews([good, { ...good, name: "Twin" }]));
			expect(r.doc.views).toHaveLength(1);
			expect(r.doc.views![0]!.name).toBe("Good");
			expect(r.dropped).toBe(1);
		});

		it("keeps a name that is not in its stored form, in that form, and counts it", () => {
			const r = parsed(withViews([{ ...good, name: "  Spaced \n out  " }]));
			expect(r.doc.views![0]!.name).toBe("Spaced out");
			expect(r.dropped).toBe(1);
		});

		it("drops a name that is empty once cleaned", () => {
			const r = parsed(withViews([{ ...good, name: " \n " }]));
			expect(r.doc.views).toBeUndefined();
			expect(r.dropped).toBe(1);
		});

		it("drops what is past the limit", () => {
			const many = Array.from({ length: VIEWS_MAX + 3 }, (_, i) => ({ ...good, id: `m${i}` }));
			const r = parsed(withViews(many));
			expect(r.doc.views).toHaveLength(VIEWS_MAX);
			expect(r.dropped).toBe(3);
		});

		it("drops a views value that is not a list", () => {
			const r = parsed(withViews({ id: "x" }));
			expect(r.doc.views).toBeUndefined();
			expect(r.dropped).toBe(1);
		});

		it("never makes the notebook unreadable, and the repaired text is clean", () => {
			const text = withViews([good, { nonsense: true }]);
			const r = parsed(text);
			const saved = serializeChecked(r.doc);
			expect(saved.ok).toBe(true);
			if (saved.ok) expect(parse(saved.text)).toMatchObject({ ok: true });
		});

		it("ignores unknown fields of a view and does not write them back", () => {
			const r = parsed(withViews([{ ...good, colour: "#ff0000" }]));
			expect(r.dropped).toBeUndefined();
			expect(serialize(r.doc)).not.toContain("colour");
		});
	});
});

describe("format v21: migration from v20", () => {
	it("changes nothing but the version of a valid v20 document", () => {
		const raw = v20Raw();
		const migrated = MIGRATIONS[20]!(raw);
		expect(migrated).toEqual({ ...raw, version: 21 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("reads a v20 file, says it was migrated and writes it as v21 without views", () => {
		const r = parsed(JSON.stringify(v20Raw()));
		expect(r.migratedFrom).toBe(20);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.views).toBeUndefined();
		expect(r.dropped).toBeUndefined();
		const text = serialize(r.doc);
		expect(getAt(parseRaw(text), ["version"])).toBe(CURRENT_VERSION);
		expect(text).not.toContain('"views"');
		expect(r.doc.pages[0]!.strokes[0]!.nib).toBe(30);
	});

	it("drops a stray views key of a v20 file (a v20 reader never gave it a meaning)", () => {
		const raw = v20Raw();
		setAt(raw, ["views"], [{ id: "x", name: "Not ours", page: "p1", x: 0, y: 0, width: 10, height: 10, zoom: 1 }]);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(20);
		expect(r.doc.views).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v19 file through every step", () => {
		const raw = v20Raw();
		setAt(raw, ["version"], 19);
		delAt(raw, ["pages", 0, "strokes", 0, "nib"]);
		setAt(raw, ["pages", 0, "strokes", 0, "tool"], "pen");
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(19);
		expect(r.doc.version).toBe(CURRENT_VERSION);
	});

	it("opens a file of a newer format read-only, whatever it holds", () => {
		const raw = parseRaw(serialize(viewDoc()));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		const repaired = repairNotebookText(JSON.stringify(raw));
		expect(repaired.ok).toBe(false);
	});
});

describe("format v21: staged loading", () => {
	it("stages a large v21 file with views and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.views = [view("a", { page: doc.pages[0]!.id }), view("b", { page: doc.pages[1]!.id, name: "Second" })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.views).toEqual(doc.views);
		expect(serialize(r.doc)).toBe(text);
	});

	it("stages a large v20 file, ignoring a stray views key", () => {
		const doc = stressDocument(6000, 3, 7);
		const raw = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, '"version": 20');
		const text = raw.replace('"assets"', '"views": [{"id":"x","name":"Not ours","page":"p","x":0,"y":0,"width":1,"height":1,"zoom":1}],\n\t"assets"');
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		expect(text).toContain('"views"');
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(20);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.views).toBeUndefined();
			expect(r.dropped).toBeUndefined();
		}
	});
});

describe("format v21: repair", () => {
	it("keeps the views of a cut-off file", () => {
		const doc = stressDocument(40, 2, 3);
		doc.views = [view("a", { page: doc.pages[0]!.id }), view("b", { page: doc.pages[1]!.id, name: "Second" })];
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.views!.map((v) => v.name)).toEqual(["View a", "Second"]);
		expect(parsed(r.text).doc.views).toHaveLength(2);
	});

	it("leaves out an invalid view and counts it", () => {
		const doc = viewDoc();
		const raw = parseRaw(serialize(doc));
		setAt(raw, ["views", 1, "zoom"], "big");
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.views!.map((v) => v.id)).toEqual(["a", "c"]);
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(1);
	});

	it("does not call the views key an unknown field", () => {
		const raw = parseRaw(serialize(viewDoc()));
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.unknownFields).toBe(0);
	});
});

describe("format v21: the model rules", () => {
	it("normalises names", () => {
		expect(normalizeViewName("  Proof \t of\nlemma  2 ")).toBe("Proof of lemma 2");
		expect(normalizeViewName("a\u0007b")).toBe("a b");
		expect(normalizeViewName("   ")).toBe("");
		expect(normalizeViewName("x".repeat(200))).toHaveLength(VIEW_NAME_MAX);
		expect(Array.from(normalizeViewName("😀".repeat(200)))).toHaveLength(VIEW_NAME_MAX);
		expect(isStoredViewName("Proof of lemma 2")).toBe(true);
		expect([" a", "a ", "a  b", "", "a\nb", "x".repeat(VIEW_NAME_MAX + 1)].some(isStoredViewName)).toBe(false);
	});

	it("makes ids that are free", () => {
		const taken = new Set(["aaaaaaaa"]);
		expect(newViewId(taken, () => 0)).not.toBe("aaaaaaaa");
		const id = newViewId(new Set(), Math.random);
		expect(id).toMatch(/^[0-9a-z]{8}$/);
	});

	it("numbers a name that is taken", () => {
		const views = [view("a", { name: "Proof" }), view("b", { name: "Proof 2" })];
		expect(uniqueViewName(views, "Other")).toBe("Other");
		expect(uniqueViewName(views, "proof")).toBe("proof 3");
		expect(uniqueViewName([], "  ")).toBe("View");
		expect(Array.from(uniqueViewName([view("a", { name: "x".repeat(VIEW_NAME_MAX) })], "x".repeat(VIEW_NAME_MAX))).length).toBeLessThanOrEqual(VIEW_NAME_MAX);
	});

	it("makes a view, rounded, frozen, or none when it cannot be one", () => {
		const made = makeView({ name: "  Lemma  ", page: "p1", x: 10.123, y: 5.987, width: 400.04, height: 300, zoom: 1.234567 }, new Set(["x"]), () => 0.5)!;
		expect(made).toMatchObject({ name: "Lemma", page: "p1", x: 10.1, y: 6, width: 400, height: 300, zoom: 1.2346 });
		expect(Object.isFrozen(made)).toBe(true);
		const none = { page: "p1", x: 0, y: 0, width: 10, height: 10, zoom: 1 };
		expect(makeView({ ...none, name: " " }, new Set())).toBeNull();
		expect(makeView({ ...none, name: "a", page: "" }, new Set())).toBeNull();
		expect(makeView({ ...none, name: "a", width: 0 }, new Set())).toBeNull();
		expect(makeView({ ...none, name: "a", zoom: Number.NaN }, new Set())).toBeNull();
		expect(makeView({ ...none, name: "a", x: Number.POSITIVE_INFINITY }, new Set())).toBeNull();
		expect(validRegion({ ...none, zoom: 100.5 })).toBe(false);
		expect(validRegion({ ...none, zoom: 0.01 })).toBe(true);
	});

	it("adds, renames, moves, replaces and removes, always as new arrays and never in place", () => {
		const list = Object.freeze([view("a"), view("b"), view("c")]);
		expect(withViewAdded(list, view("d")).map((v) => v.id)).toEqual(["a", "b", "c", "d"]);
		expect(withViewAdded(Array.from({ length: VIEWS_MAX }, (_, i) => view(`v${i}`)), view("z"))).toHaveLength(VIEWS_MAX);
		expect(withViewRenamed(list, "b", "  Better  name ").map((v) => v.name)).toEqual(["View a", "Better name", "View c"]);
		expect(withViewRenamed(list, "b", "   ")).toBe(list);
		expect(withViewRenamed(list, "b", "View b")).toBe(list);
		expect(withViewRenamed(list, "nope", "x")).toBe(list);
		expect(withViewMoved(list, "c", 0).map((v) => v.id)).toEqual(["c", "a", "b"]);
		expect(withViewMoved(list, "a", 99).map((v) => v.id)).toEqual(["b", "c", "a"]);
		expect(withViewMoved(list, "a", 0)).toBe(list);
		expect(withViewMoved(list, "nope", 1)).toBe(list);
		expect(withViewRemoved(list, "b").map((v) => v.id)).toEqual(["a", "c"]);
		expect(withViewRemoved(list, "nope")).toBe(list);
		const moved = withViewReplaced(list, "b", { page: "p2", x: 1, y: 2, width: 30, height: 40, zoom: 2 });
		expect(moved[1]).toMatchObject({ id: "b", name: "View b", page: "p2", x: 1, y: 2, width: 30, height: 40, zoom: 2 });
		expect(withViewReplaced(list, "b", { page: "p2", x: 1, y: 2, width: 0, height: 40, zoom: 2 })).toBe(list);
		expect(withViewReplaced(list, "b", { page: "p1", x: 10.5, y: 200, width: 400, height: 300.2, zoom: 1.25 })).toBe(list);
		expect(list.map((v) => v.id)).toEqual(["a", "b", "c"]);
	});

	it("compares lists by value", () => {
		expect(sameViews([view("a")], [view("a")])).toBe(true);
		expect(sameViews([view("a")], [view("a", { zoom: 2 })])).toBe(false);
		expect(sameViews([view("a")], [view("a"), view("b")])).toBe(false);
	});

	it("shows a view at the fit as Fit, never as a percentage that could look bigger than a smaller one (T4)", () => {
		expect(zoomIsFit(1)).toBe(true);
		expect(zoomIsFit(1.005)).toBe(true);
		expect(zoomIsFit(0.6)).toBe(false);
		// a spread zoomed to one page wide is stored just above 1 (not the fit): 100 %, next to a 60 % view that is smaller on the screen
		expect(zoomIsFit(1.015)).toBe(false);
		expect(zoomPercent(1.015)).toBe(100);
		expect(zoomPercent(0.6)).toBe(60);
		expect(zoomPercent(1.5)).toBe(150);
		const rows = viewRows({ ...viewDoc(), views: [view("fit", { zoom: 1 }), view("page", { zoom: 1.015 }), view("small", { zoom: 0.6 })] });
		expect(rows.map((r) => [r.id, r.fit, r.zoomPercent])).toEqual([["fit", true, 100], ["page", false, 100], ["small", false, 60]]);
	});

	it("lists rows, a missing page marked, and what can move", () => {
		const rows = viewRows(viewDoc());
		expect(rows.map((r) => [r.id, r.pageNumber, r.missing])).toEqual([["a", 1, false], ["b", 3, false], ["c", null, true]]);
		expect(rows[0]!.zoomPercent).toBe(125);
		expect(zoomPercent(0.004)).toBe(1);
		expect(moveOptions(rows, "a")).toEqual({ up: false, down: true });
		expect(moveOptions(rows, "b")).toEqual({ up: true, down: true });
		expect(moveOptions(rows, "c")).toEqual({ up: true, down: false });
		expect(moveOptions(rows, "nope")).toEqual({ up: false, down: false });
	});
});

describe("format v21: history", () => {
	function historyOf(doc: NotebookDocument, extra: { locked?: () => boolean; refused?: (m: string) => void } = {}): History {
		return new History(() => doc, 500, checkContent, extra.refused ? (m) => extra.refused!(m) : null, extra.locked ?? null);
	}

	it("one command per edit: run, undo and redo put the whole list back", () => {
		const doc = viewDoc();
		const history = historyOf(doc);
		const start = viewsOf(doc);
		const cmd = setViews(doc, withViewRenamed(start, "a", "Renamed"), "Rename view")!;
		expect(history.execute(cmd)).toBe(true);
		expect(doc.views![0]!.name).toBe("Renamed");
		expect(history.execute(setViews(doc, withViewMoved(viewsOf(doc), "c", 0), "Move view")!)).toBe(true);
		expect(doc.views!.map((v) => v.id)).toEqual(["c", "a", "b"]);
		history.undo();
		expect(doc.views!.map((v) => v.id)).toEqual(["a", "b", "c"]);
		history.undo();
		expect(doc.views!.map((v) => v.name)).toEqual(start.map((v) => v.name));
		history.redo();
		history.redo();
		expect(doc.views!.map((v) => v.id)).toEqual(["c", "a", "b"]);
		expect(doc.views![1]!.name).toBe("Renamed");
	});

	it("never changes the array in place (the snapshots of the history stay right)", () => {
		const doc = viewDoc();
		const before = doc.views!;
		const history = historyOf(doc);
		history.execute(setViews(doc, withViewRemoved(before, "a"), "Delete view")!);
		expect(before.map((v) => v.id)).toEqual(["a", "b", "c"]);
		expect(doc.views).not.toBe(before);
		history.undo();
		expect(doc.views).not.toBe(before);
		expect(doc.views!.map((v) => v.id)).toEqual(["a", "b", "c"]);
	});

	it("leaves the document without a views key when the last view is removed, and undo brings it back", () => {
		const doc = viewDoc();
		doc.views = [view("a")];
		const history = historyOf(doc);
		history.execute(setViews(doc, withViewRemoved(viewsOf(doc), "a"), "Delete view")!);
		expect("views" in doc).toBe(false);
		expect(serialize(doc)).not.toContain('"views"');
		history.undo();
		expect(doc.views.map((v) => v.id)).toEqual(["a"]);
	});

	it("makes no command for a change that changes nothing", () => {
		const doc = viewDoc();
		expect(setViews(doc, viewsOf(doc), "x")).toBeNull();
		expect(setViews(doc, [...viewsOf(doc)], "x")).toBeNull();
		expect(setViews(doc, withViewRemoved(viewsOf(doc), "nope"), "x")).toBeNull();
	});

	it("is refused by the document guard when the result could not be saved, and nothing changes", () => {
		const doc = viewDoc();
		const said: string[] = [];
		const history = historyOf(doc, { refused: (m) => said.push(m) });
		const bad = setViews(doc, [...viewsOf(doc), view("a", { name: "Twin" })], "Save view")!;
		expect(history.execute(bad)).toBe(false);
		expect(said).toHaveLength(1);
		expect(doc.views!.map((v) => v.id)).toEqual(["a", "b", "c"]);
		expect(history.canUndo()).toBe(false);
	});

	it("does nothing while the history is locked (read-only mode)", () => {
		const doc = viewDoc();
		const history = historyOf(doc, { locked: () => true });
		expect(history.execute(setViews(doc, withViewRemoved(viewsOf(doc), "a"), "Delete view")!)).toBe(false);
		expect(doc.views).toHaveLength(3);
	});

	it("works on a notebook with a locked page (views are not page content)", () => {
		const doc = viewDoc();
		doc.pages[0]!.locked = true;
		const history = historyOf(doc);
		expect(history.execute(setViews(doc, withViewRemoved(viewsOf(doc), "a"), "Delete view")!)).toBe(true);
		expect(doc.views).toHaveLength(2);
	});

	it("keeps a view when its page is deleted: it turns missing, and works again after undo", () => {
		const doc = viewDoc();
		const history = historyOf(doc);
		const page = doc.pages[2]!;
		expect(history.execute(new DeletePage(page, 2))).toBe(true);
		expect(doc.views).toHaveLength(3);
		expect(viewPageIndex(doc, doc.views![1]!)).toBe(-1);
		expect(viewRows(doc)[1]!.missing).toBe(true);
		expect(parsed(serialize(doc)).doc.views).toHaveLength(3);
		history.undo();
		expect(viewPageIndex(doc, doc.views![1]!)).toBe(2);
	});

	it("can remove the view of a page that is gone", () => {
		const doc = viewDoc();
		const history = historyOf(doc);
		expect(history.execute(setViews(doc, withViewRemoved(viewsOf(doc), "c"), "Delete view")!)).toBe(true);
		expect(doc.views!.map((v) => v.id)).toEqual(["a", "b"]);
	});

	it("a command made on one list undoes to that list whatever the document holds now", () => {
		const doc = viewDoc();
		const cmd = new SetViews(viewsOf(doc), [view("z")], "Change saved views");
		cmd.apply(doc);
		doc.views = [view("q")];
		cmd.revert(doc);
		expect(doc.views.map((v) => v.id)).toEqual(["a", "b", "c"]);
	});
});

describe("format v21: merge and copies", () => {
	function twin(): { main: NotebookDocument; other: NotebookDocument } {
		const main = viewDoc();
		const other = parsed(serialize(main)).doc;
		return { main, other };
	}

	it("brings the views of a copy that the notebook lacks, on pages it has, in one step", () => {
		const { main, other } = twin();
		other.views = [...other.views!, view("d", { page: "p2", name: "From the copy" }), view("e", { page: "nowhere", name: "Orphan" })];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsAdded).toBe(1);
		expect(plan.command).not.toBeNull();
		const history = historyOf(main);
		expect(history.execute(plan.command!)).toBe(true);
		expect(main.views!.map((v) => v.id)).toEqual(["a", "b", "c", "d"]);
		expect(mergeCovers(main, other)).toBe(true);
		history.undo();
		expect(main.views!.map((v) => v.id)).toEqual(["a", "b", "c"]);
	});

	function historyOf(doc: NotebookDocument): History {
		return new History(() => doc, 500, checkContent);
	}

	it("keeps the main notebook's view when both have one with that id, and is idempotent", () => {
		const { main, other } = twin();
		other.views = [view("a", { name: "Other name", zoom: 3 }), ...other.views!.slice(1)];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsAdded).toBe(0);
		expect(plan.command).toBeNull();
		expect(main.views![0]!.name).toBe("View a");
	});

	it("numbers a name the notebook already uses", () => {
		const { main, other } = twin();
		other.views = [view("n1", { name: "view a" })];
		const plan = planMerge(main, other);
		const history = historyOf(main);
		history.execute(plan.command!);
		expect(main.views!.map((v) => v.name)).toEqual(["View a", "Proof of lemma 2", "Old page", "view a 2"]);
	});

	it("adds the views of a copy to a notebook that has none", () => {
		const main = viewDoc();
		delete main.views;
		const other = parsed(serialize(viewDoc())).doc;
		const plan = planMerge(main, other);
		expect(plan.summary.viewsAdded).toBe(2);
		new History(() => main, 500, checkContent).execute(plan.command!);
		expect(main.views!.map((v) => v.id)).toEqual(["a", "b"]);
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("does not exceed the limit", () => {
		const base = Array.from({ length: VIEWS_MAX - 1 }, (_, i) => view(`m${i}`));
		const united = mergedViews(base, [view("x1"), view("x2")], new Set(["p1"]));
		expect(united).toHaveLength(VIEWS_MAX);
		expect(mergedViews(base, [], new Set(["p1"]))).toBe(base);
	});

	it("a copied page takes no view along (a view names a page by its id)", () => {
		const doc = viewDoc();
		const copy = duplicatePage(doc.pages[0]!);
		expect(copy.id).not.toBe(doc.pages[0]!.id);
		expect(viewsOf(doc).some((v) => v.page === copy.id)).toBe(false);
		expect(doc.views).toHaveLength(3);
	});
});

describe("format v21: capturing and recalling a view", () => {
	const A4 = { width: A4_WIDTH, height: A4_HEIGHT };
	const pages = Array.from({ length: 6 }, () => A4);
	const vertical = layoutPages(pages);
	const horizontal = layoutPagesHorizontal(pages);
	const tablet: Size = { width: 800, height: 1280 };
	const phone: Size = { width: 390, height: 780 };

	function viewportOn(layout = vertical, view = tablet, index = 2, zoom = 2, x = 100, y = 300) {
		const fit = fitWidth(view, layout).scale;
		const box = layout.boxes[index]!;
		const scale = fit * zoom;
		return { scale, offsetX: -(box.x + x) * scale, offsetY: -(box.y + y) * scale };
	}

	it("captures the region in view in page coordinates and the zoom relative to the fit", () => {
		const v = viewportOn();
		const region = captureRegion("continuous", v, tablet, vertical, 2)!;
		expect(region.pageIndex).toBe(2);
		expect(region.x).toBeCloseTo(100, 3);
		expect(region.y).toBeCloseTo(300, 3);
		expect(region.zoom).toBeCloseTo(2, 6);
		expect(region.width).toBeCloseTo(tablet.width / v.scale, 6);
		expect(region.height).toBeCloseTo(tablet.height / v.scale, 6);
	});

	it("shows exactly the same view again on the same screen", () => {
		const v = viewportOn(vertical, tablet, 4, 1.7, 33, 410);
		const region = captureRegion("continuous", v, tablet, vertical, 4)!;
		const back = restoreRegion(region, 4, "continuous", tablet, vertical)!;
		expect(back.pageIndex).toBe(4);
		expect(back.viewport.scale).toBeCloseTo(v.scale, 6);
		expect(back.viewport.offsetX).toBeCloseTo(v.offsetX, 3);
		expect(back.viewport.offsetY).toBeCloseTo(v.offsetY, 3);
	});

	it("puts the middle of the region in the middle of another screen, at the same relative zoom", () => {
		const v = viewportOn(vertical, tablet, 3, 2.5, 60, 520);
		const region = captureRegion("continuous", v, tablet, vertical, 3)!;
		const back = restoreRegion(region, 3, "continuous", phone, vertical)!;
		expect(back.viewport.scale).toBeCloseTo(fitWidth(phone, vertical).scale * 2.5, 6);
		const [cx, cy] = screenToPage(back.viewport, phone.width / 2, phone.height / 2);
		const box = vertical.boxes[3]!;
		expect(cx - box.x).toBeCloseTo(region.x + region.width / 2, 2);
		expect(cy - box.y).toBeCloseTo(region.y + region.height / 2, 2);
	});

	it("marks a view that fits the width, and clamps a zoom the screen cannot reach", () => {
		const fitted = restoreRegion({ x: 0, y: 0, width: 595, height: 800, zoom: 1 }, 1, "continuous", tablet, vertical)!;
		expect(fitted.fit).toBe(true);
		const huge = restoreRegion({ x: 0, y: 0, width: 5, height: 5, zoom: 100 }, 0, "continuous", tablet, vertical)!;
		expect(huge.viewport.scale).toBe(8);
		expect(huge.fit).toBe(false);
	});

	it("works in the one-page-at-a-time layout too", () => {
		const v = { scale: fitScale("pages", tablet, horizontal, 2) * 1.5, offsetX: 0, offsetY: 0 };
		const region = captureRegion("pages", v, tablet, horizontal, 2)!;
		const back = restoreRegion(region, 2, "pages", tablet, horizontal)!;
		expect(back.viewport.scale).toBeCloseTo(v.scale, 6);
		expect(back.viewport.offsetX).toBeCloseTo(v.offsetX, 3);
		expect(back.viewport.offsetY).toBeCloseTo(v.offsetY, 3);
	});

	it("gives nothing to capture or show while the view has no size or the page is not there", () => {
		const v = viewportOn();
		expect(captureRegion("continuous", v, { width: 0, height: 0 }, vertical, 2)).toBeNull();
		expect(captureRegion("continuous", v, tablet, vertical, 99)).toBeNull();
		expect(captureRegion("continuous", { scale: 0, offsetX: 0, offsetY: 0 }, tablet, vertical, 2)).toBeNull();
		expect(restoreRegion({ x: 0, y: 0, width: 1, height: 1, zoom: 1 }, 99, "continuous", tablet, vertical)).toBeNull();
		expect(restoreRegion({ x: 0, y: 0, width: 1, height: 1, zoom: 1 }, 0, "continuous", { width: 0, height: 0 }, vertical)).toBeNull();
	});

	it("a captured view can be stored: the numbers survive the file and recall the same place", () => {
		const doc = viewDoc();
		const v = viewportOn(vertical, tablet, 1, 1.9, 21.37, 133.91);
		const region = captureRegion("continuous", v, tablet, vertical, 1)!;
		const made = makeView({ name: "Here", page: doc.pages[1]!.id, x: region.x, y: region.y, width: region.width, height: region.height, zoom: region.zoom }, new Set())!;
		doc.views = [made];
		const back = parsed(serialize(doc)).doc.views![0]!;
		const shown = restoreRegion(back, 1, "continuous", tablet, vertical)!;
		expect(shown.viewport.scale).toBeCloseTo(v.scale, 3);
		expect(Math.abs(shown.viewport.offsetX - v.offsetX)).toBeLessThan(0.5);
		expect(Math.abs(shown.viewport.offsetY - v.offsetY)).toBeLessThan(0.5);
	});
});
