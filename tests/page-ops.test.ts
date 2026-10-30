/** Operations on several selected pages (wave 0.8, 378): each one is a single undo step, and undo restores the notebook exactly. */
import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import {
	addTagsCommand, allBookmarked, bookmarkCommand, deleteCommand, duplicateCommand, exportSuffix, moveCommand, paperCommand, planMove,
	rangeIds, removeTagCommand, ReorderPages, selectedPages, selectionTags, sizeCommand,
} from "../src/model/page-ops";
import { PAGE_SIZES, type NotebookDocument } from "../src/model/types";

/** A document of `n` pages whose ids are p1…pn. */
function docOf(n: number): NotebookDocument {
	const doc = createDocument();
	doc.pages = Array.from({ length: n }, (_, i) => ({ ...createPage(), id: `p${i + 1}` }));
	return doc;
}

const ids = (doc: NotebookDocument) => doc.pages.map((p) => p.id);

describe("planMove", () => {
	const order = ["a", "b", "c", "d", "e"];

	it("moves the selection, in page order, to the start or the end", () => {
		expect(planMove(order, new Set(["d", "b"]), "start")).toEqual(["b", "d", "a", "c", "e"]);
		expect(planMove(order, new Set(["b", "d"]), "end")).toEqual(["a", "c", "e", "b", "d"]);
	});

	it("position = the page number the first selected page gets", () => {
		expect(planMove(order, new Set(["a", "b"]), { position: 4 })).toEqual(["c", "d", "e", "a", "b"]);
		expect(planMove(order, new Set(["a", "b"]), { position: 3 })).toEqual(["c", "d", "a", "b", "e"]);
		expect(planMove(order, new Set(["e"]), { position: 1 })).toEqual(["e", "a", "b", "c", "d"]);
		// Past the end and before the start are clamped.
		expect(planMove(order, new Set(["a"]), { position: 99 })).toEqual(["b", "c", "d", "e", "a"]);
		expect(planMove(order, new Set(["e"]), { position: -5 })).toEqual(["e", "a", "b", "c", "d"]);
	});

	it("gives null when nothing changes or nothing is selected", () => {
		expect(planMove(order, new Set(["a", "b"]), "start")).toBeNull();
		expect(planMove(order, new Set(["d", "e"]), "end")).toBeNull();
		expect(planMove(order, new Set(), "end")).toBeNull();
		expect(planMove(order, new Set(["zz"]), "end")).toBeNull();
		expect(planMove(order, new Set(order), { position: 3 })).toBeNull();
	});
});

describe("moveCommand", () => {
	it("is one undo step and undo puts every page back", () => {
		const doc = docOf(6);
		const h = new History(() => doc);
		const cmd = moveCommand(doc, ["p2", "p5", "p3"], "start")!;
		h.execute(cmd);
		expect(ids(doc)).toEqual(["p2", "p3", "p5", "p1", "p4", "p6"]);
		h.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		expect(h.canUndo()).toBe(false);
		h.redo();
		expect(ids(doc)).toEqual(["p2", "p3", "p5", "p1", "p4", "p6"]);
	});

	it("keeps the page objects (ink is not copied) and tolerates a page that appeared meanwhile", () => {
		const doc = docOf(3);
		const [first] = doc.pages;
		const cmd = new ReorderPages(["p1", "p2", "p3"], ["p3", "p1", "p2"]);
		doc.pages.push({ ...createPage(), id: "late" });
		cmd.apply(doc);
		expect(ids(doc)).toEqual(["p3", "p1", "p2", "late"]);
		expect(doc.pages[1]).toBe(first);
		cmd.revert(doc);
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "late"]);
	});
});

describe("selection helpers", () => {
	it("selectedPages keeps document order and drops unknown ids", () => {
		const doc = docOf(4);
		expect(selectedPages(doc, ["p4", "p2", "gone"]).map((p) => p.id)).toEqual(["p2", "p4"]);
	});

	it("rangeIds covers the pages shown between two taps, in either direction", () => {
		const shown = ["p1", "p3", "p4", "p7"];
		expect(rangeIds(shown, "p1", "p4")).toEqual(["p1", "p3", "p4"]);
		expect(rangeIds(shown, "p7", "p3")).toEqual(["p3", "p4", "p7"]);
		expect(rangeIds(shown, "p3", "p3")).toEqual(["p3"]);
		expect(rangeIds(shown, "p3", "p2")).toEqual(["p3"]);
		expect(rangeIds(shown, "x", "y")).toEqual([]);
	});
});

describe("paper and size", () => {
	it("changes only the pages that differ, in one step", () => {
		const doc = docOf(4);
		doc.pages[1]!.paper = { kind: "ruled", spacing: 28 };
		const h = new History(() => doc);
		const before = doc.pages.map((p) => ({ ...p.paper }));
		expect(paperCommand(doc, ["p2"], "ruled")).toBeNull();
		h.execute(paperCommand(doc, ["p1", "p2", "p3"], "ruled")!);
		expect(doc.pages.map((p) => p.paper.kind)).toEqual(["ruled", "ruled", "ruled", before[3]!.kind]);
		h.undo();
		expect(doc.pages.map((p) => p.paper)).toEqual(before);
	});

	it("sets the size of every selected page and keeps each page's orientation; strokes stay where they are", () => {
		const doc = docOf(3);
		const a5 = PAGE_SIZES.a5;
		Object.assign(doc.pages[1]!, { width: PAGE_SIZES.a4.height, height: PAGE_SIZES.a4.width });
		const h = new History(() => doc);
		const sizes = () => doc.pages.map((p) => [p.width, p.height]);
		const before = sizes();
		h.execute(sizeCommand(doc, ["p1", "p2"], a5)!);
		expect(sizes()).toEqual([[a5.width, a5.height], [a5.height, a5.width], before[2]]);
		expect(sizeCommand(doc, ["p1", "p2"], a5)).toBeNull();
		h.undo();
		expect(sizes()).toEqual(before);
	});
});

describe("tags", () => {
	it("adds tags to all, ignoring duplicates, and one undo removes them from all", () => {
		const doc = docOf(3);
		doc.pages[0]!.tags = ["Exam"];
		const h = new History(() => doc);
		h.execute(addTagsCommand(doc, ["p1", "p2"], ["exam", "lab"])!);
		expect(doc.pages[0]!.tags).toEqual(["Exam", "lab"]);
		expect(doc.pages[1]!.tags).toEqual(["exam", "lab"]);
		expect(doc.pages[2]!.tags).toBeUndefined();
		expect(addTagsCommand(doc, ["p1", "p2"], ["LAB"])).toBeNull();
		h.undo();
		expect(doc.pages[0]!.tags).toEqual(["Exam"]);
		expect(doc.pages[1]!.tags).toBeUndefined();
	});

	it("removes a tag in any capitalisation, and drops the list when it empties", () => {
		const doc = docOf(3);
		doc.pages[0]!.tags = ["Exam", "lab"];
		doc.pages[1]!.tags = ["exam"];
		const h = new History(() => doc);
		expect(selectionTags(doc, ["p1", "p2", "p3"])).toEqual([{ tag: "Exam", count: 2 }, { tag: "lab", count: 1 }]);
		h.execute(removeTagCommand(doc, ["p1", "p2", "p3"], "EXAM")!);
		expect(doc.pages[0]!.tags).toEqual(["lab"]);
		expect(doc.pages[1]!.tags).toBeUndefined();
		expect(removeTagCommand(doc, ["p1"], "exam")).toBeNull();
		h.undo();
		expect(doc.pages[1]!.tags).toEqual(["exam"]);
	});
});

describe("bookmarks", () => {
	it("bookmarks all, keeping the details of the ones already bookmarked; all bookmarked = remove them", () => {
		const doc = docOf(4);
		doc.meta = { tags: [], favorite: false, cover: "", bookmarks: ["p2"], bookmarkInfo: { p2: { title: "Key idea" } } };
		const h = new History(() => doc);
		expect(allBookmarked(doc, ["p1", "p2"])).toBe(false);
		h.execute(bookmarkCommand(doc, ["p1", "p2", "p3"])!);
		expect(doc.meta.bookmarks).toEqual(["p2", "p1", "p3"]);
		expect(doc.meta.bookmarkInfo?.p2).toEqual({ title: "Key idea" });
		expect(allBookmarked(doc, ["p1", "p2", "p3"])).toBe(true);
		h.execute(bookmarkCommand(doc, ["p1", "p2", "p3"])!);
		expect(doc.meta.bookmarks).toEqual([]);
		expect(doc.meta.bookmarkInfo?.p2).toBeUndefined();
		h.undo();
		expect(doc.meta.bookmarks).toEqual(["p2", "p1", "p3"]);
		expect(doc.meta.bookmarkInfo?.p2).toEqual({ title: "Key idea" });
		h.undo();
		expect(doc.meta.bookmarks).toEqual(["p2"]);
	});
});

describe("duplicate and delete", () => {
	it("copies the selected pages, in order, right after the last one, with new ids", () => {
		const doc = docOf(5);
		doc.pages[1]!.tags = ["x"];
		const h = new History(() => doc);
		const dup = duplicateCommand(doc, ["p4", "p2"])!;
		expect(dup.index).toBe(4);
		h.execute(dup.command);
		expect(doc.pages).toHaveLength(7);
		expect(doc.pages.map((p) => p.id).filter((id) => id.startsWith("p"))).toEqual(["p1", "p2", "p3", "p4", "p5"]);
		expect(doc.pages[4]!.tags).toEqual(["x"]);
		expect(new Set(ids(doc)).size).toBe(7);
		h.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
	});

	it("deletes the selected pages in one step and undo puts each back where it was", () => {
		const doc = docOf(6);
		const h = new History(() => doc);
		h.execute(deleteCommand(doc, ["p2", "p3", "p6"])!);
		expect(ids(doc)).toEqual(["p1", "p4", "p5"]);
		h.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		h.redo();
		expect(ids(doc)).toEqual(["p1", "p4", "p5"]);
	});

	it("never deletes every page", () => {
		const doc = docOf(3);
		expect(deleteCommand(doc, ["p1", "p2", "p3"])).toBeNull();
		expect(deleteCommand(doc, [])).toBeNull();
		expect(deleteCommand(doc, ["p1", "p2"])).not.toBeNull();
	});
});

describe("export file name", () => {
	it("names a run of pages by its range and any other selection 'selection'", () => {
		const doc = docOf(8);
		const pick = (...n: number[]) => n.map((i) => doc.pages[i - 1]!);
		expect(exportSuffix(doc, pick(3))).toBe(" p3");
		expect(exportSuffix(doc, pick(3, 4, 5))).toBe(" p3-5");
		expect(exportSuffix(doc, pick(2, 4))).toBe(" selection");
	});
});
