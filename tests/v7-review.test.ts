/**
 * Review fixes of format v7: field-by-field bookmark merge, bounded paper geometry, page time of the
 * workspace layout, page moves keeping bookmarks, lenient read of bad v7 details, categories of existing
 * pages, the library index version.
 */
import { describe, expect, it } from "vitest";
import { setBookmark } from "../src/model/bookmarks";
import { cloneMeta, createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { parse, serialize } from "../src/model/serialize";
import { DEFAULT_META, type NotebookDocument } from "../src/model/types";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.error);
	return r;
}

function twoPages(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages[0]!.id = "p1";
	const p2 = createPage();
	p2.id = "p2";
	doc.pages.push(p2);
	doc.meta = cloneMeta(DEFAULT_META);
	return doc;
}

describe("merge of bookmark details, field by field", () => {
	it("fills in the fields the main notebook lacks (main {color} + copy {title})", () => {
		const main = twoPages();
		main.meta = setBookmark(main.meta!, "p1", { color: "#22c55e" });
		const other = twoPages();
		other.meta = setBookmark(other.meta!, "p1", { title: "Chapter 3" });
		expect(mergeCovers(main, other)).toBe(false);
		const plan = planMerge(main, other);
		expect(plan.summary.bookmarkInfoAdded).toBe(1);
		expect(plan.summary.bookmarkInfoDiffer).toBe(0);
		expect(mergeChangeCount(plan.summary)).toBe(1);
		expect(plan.command).not.toBeNull();
		new History(() => main).execute(plan.command!);
		expect(main.meta?.bookmarkInfo?.p1).toEqual({ title: "Chapter 3", color: "#22c55e" });
		const saved = parsed(serialize(main)).doc;
		expect(mergeCovers(saved, other)).toBe(true);
		// Idempotent.
		expect(planMerge(saved, other).command).toBeNull();
	});

	it("keeps the main value of a field set on both sides, counts it, and is not covered", () => {
		const main = twoPages();
		main.meta = setBookmark(main.meta!, "p1", { title: "Main", category: "review" });
		const other = twoPages();
		other.meta = setBookmark(other.meta!, "p1", { title: "Copy", color: "#3b82f6", category: "review" });
		const plan = planMerge(main, other);
		expect(plan.summary.bookmarkInfoAdded).toBe(1);
		expect(plan.summary.bookmarkInfoDiffer).toBe(1);
		new History(() => main).execute(plan.command!);
		expect(main.meta?.bookmarkInfo?.p1).toEqual({ title: "Main", color: "#3b82f6", category: "review" });
		expect(mergeCovers(parsed(serialize(main)).doc, other)).toBe(false);
	});
});
