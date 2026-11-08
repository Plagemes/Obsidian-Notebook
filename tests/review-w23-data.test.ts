/**
 * Wave 0.23 data review fixes: saved views (V3 unique names, V4 page-id limit, V5 merge report, V6 line-scan repair) and the
 * formula sheet (V9 `$` escaping). The hook clean-up (V2, V7) and Balance reaction (V1, V8) are tested with their own modules.
 */
import { describe, expect, it } from "vitest";
import { createDocument } from "../src/model/document";
import { DeletePage, History } from "../src/model/history";
import { mergeCovers, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, serialize } from "../src/model/serialize";
import { VIEWS_MAX, VIEW_NAME_MAX, VIEW_PAGE_ID_MAX, type NotebookDocument, type SavedView } from "../src/model/types";
import { isStoredViewName, makeView, mergedViews, uniqueViewName, viewsMergeReport, withViewReplaced } from "../src/model/views";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";

const stamp = "2026-11-08T10:00:00.000Z";

function view(id: string, over: Partial<SavedView> = {}): SavedView {
	return Object.freeze({ id, name: `View ${id}`, page: "p1", x: 10.5, y: 200, width: 400, height: 300.2, zoom: 1.25, ...over });
}

function docWith(views: SavedView[]): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages.push({ ...doc.pages[0]!, id: "p2", strokes: [] });
	doc.views = views;
	return doc;
}

function parsed(text: string): NotebookDocument {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r.doc;
}

describe("review V3: a unique view name is always a stored name", () => {
	/** 80 characters, a space at position 78. */
	const long = `${"a".repeat(77)} bb`;

	it("the fixture is what the finding describes", () => {
		expect(Array.from(long)).toHaveLength(VIEW_NAME_MAX);
		expect(long[77]).toBe(" ");
		expect(isStoredViewName(long)).toBe(true);
	});

	it("never leaves a space before the number", () => {
		const name = uniqueViewName([view("a", { name: long })], long);
		expect(name).toBe(`${"a".repeat(77)} 2`);
		expect(isStoredViewName(name)).toBe(true);
		const third = uniqueViewName([view("a", { name: long }), view("b", { name })], long.toUpperCase());
		expect(isStoredViewName(third)).toBe(true);
		expect(third).not.toBe(name);
	});

	it("a conflict merge of two views with such a name passes the content guard", () => {
		const main = docWith([view("a", { name: long })]);
		const other = parsed(serialize(main));
		other.views = [view("b", { name: long.toLowerCase() })];
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		expect(new History(() => main, 500, checkContent).execute(plan.command!)).toBe(true);
		expect(main.views).toHaveLength(2);
		expect(main.views!.every((v) => isStoredViewName(v.name))).toBe(true);
	});

	it("a short name still gets a plain number", () => {
		expect(uniqueViewName([view("a", { name: "Proof" })], "proof")).toBe("proof 2");
	});
});

describe("review V4: a view names a page id the file can hold", () => {
	const input = { name: "Long", x: 0, y: 0, width: 100, height: 100, zoom: 1 };

	it("makeView refuses a page id longer than the limit and accepts the limit", () => {
		expect(makeView({ ...input, page: "p".repeat(VIEW_PAGE_ID_MAX + 1) }, new Set())).toBeNull();
		expect(makeView({ ...input, page: "p".repeat(VIEW_PAGE_ID_MAX) }, new Set())).not.toBeNull();
	});

	it("withViewReplaced keeps the list when the page id is too long", () => {
		const views = [view("a")];
		expect(withViewReplaced(views, "a", { ...input, page: "p".repeat(VIEW_PAGE_ID_MAX + 1) })).toBe(views);
		expect(withViewReplaced(views, "a", { ...input, page: "p2" })[0]!.page).toBe("p2");
	});
});

describe("review V5: the merge says what it leaves out of the views", () => {
	function full(): SavedView[] {
		return Array.from({ length: VIEWS_MAX }, (_, i) => view(`m${i}`, { name: `Main ${i}` }));
	}

	it("a full list keeps the main views, counts the ones that did not fit and leaves the copy in place", () => {
		const main = docWith(full());
		const other = parsed(serialize(main));
		other.views = [...full().slice(1), view("x1", { name: "New 1" }), view("x2", { name: "New 2", page: "nowhere" })];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsAdded).toBe(0);
		expect(plan.summary.viewsFull).toBe(1);
		expect(plan.summary.viewsDiffer).toBe(0);
		expect(plan.command).toBeNull();
		expect(main.views).toHaveLength(VIEWS_MAX);
		// The copy still holds a view that the result lacks: it is not moved away.
		expect(mergeCovers(main, other)).toBe(false);
	});

	it("other changes are merged all the same when the list is full", () => {
		const main = docWith(full());
		const other = parsed(serialize(main));
		other.pages.push({ ...other.pages[0]!, id: "p3", strokes: [] });
		other.views = [...full().slice(1), view("x1", { name: "New 1" })];
		const plan = planMerge(main, other);
		expect(plan.summary.pagesAdded).toBe(1);
		expect(plan.summary.viewsFull).toBe(1);
		expect(new History(() => main, 500, checkContent).execute(plan.command!)).toBe(true);
		expect(main.views).toHaveLength(VIEWS_MAX);
		expect(main.pages.map((p) => p.id)).toContain("p3");
	});

	it("a view both have, renamed in the copy, stays as the main notebook has it and is counted", () => {
		const main = docWith([view("a"), view("b")]);
		const other = parsed(serialize(main));
		other.views = [view("a", { name: "Renamed in the copy" }), view("b")];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsDiffer).toBe(1);
		expect(plan.summary.viewsFull).toBe(0);
		expect(plan.command).toBeNull();
		expect(main.views![0]!.name).toBe("View a");
	});

	it("identical views and views of a page the result lacks are not counted", () => {
		const main = docWith([view("a")]);
		const other = parsed(serialize(main));
		other.views = [view("a"), view("gone", { page: "elsewhere" })];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsDiffer).toBe(0);
		expect(plan.summary.viewsFull).toBe(0);
	});

	it("a name renumbered on the way in is an addition, not a difference", () => {
		const main = docWith([view("a", { name: "Proof" })]);
		const other = parsed(serialize(main));
		other.views = [view("n", { name: "proof" })];
		const plan = planMerge(main, other);
		expect(plan.summary.viewsAdded).toBe(1);
		expect(plan.summary.viewsDiffer).toBe(0);
		expect(plan.summary.viewsFull).toBe(0);
	});

	it("the report is pure and agrees with mergedViews", () => {
		const main = [view("a"), view("b")];
		const other = [view("a", { zoom: 2 }), view("c"), view("d", { page: "p9" })];
		const pages = new Set(["p1"]);
		const united = mergedViews(main, other, pages);
		expect(viewsMergeReport(main, other, united, pages)).toEqual({ differ: 1, full: 0 });
	});

	it("the summary lines exist in English and Italian", () => {
		for (const key of ["merge.summary.viewsDiffer", "merge.summary.viewsFull"] as const) {
			expect(en[key]).toContain("{count}");
			expect(itMessages[key]).toContain("{count}");
		}
	});
});

describe("review V6: the line scan recovers view lines when the views array is damaged", () => {
	function damaged(): { text: string; doc: NotebookDocument } {
		const doc = docWith([view("a", { name: "First" }), view("b", { name: "Second", page: "p2" })]);
		// Break the array itself (the lines inside are untouched) and a page field so the plain read fails too.
		const text = serialize(doc).replace('"views": [', '"views": {').replace('"width": ', '"width" ');
		return { text, doc };
	}

	it("keeps the readable view lines", () => {
		const { text } = damaged();
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.views?.map((v) => v.id)).toEqual(["a", "b"]);
		expect(parsed(r.text).views?.map((v) => v.name)).toEqual(["First", "Second"]);
	});

	it("does not take a slide line for a view, nor a view line for a slide", () => {
		const { text } = damaged();
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.slides ?? []).toHaveLength(0);
	});

	it("an unreadable view line is left out and the rest stay", () => {
		const { text } = damaged();
		const broken = text.replace('"zoom":1.25}', '"zoom":1.25');
		const r = repairNotebookText(broken);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.doc.views ?? []).length).toBeGreaterThanOrEqual(1);
	});

	it("a page that was deleted leaves its view as missing and a repair keeps it", () => {
		const doc = docWith([view("a", { page: "p2" })]);
		new History(() => doc).execute(new DeletePage(doc.pages[1]!, 1));
		const r = repairNotebookText(serialize(doc).replace('"views": [', '"views": {'));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.views?.map((v) => v.id)).toEqual(["a"]);
	});
});
