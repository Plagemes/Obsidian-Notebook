/**
 * 0.30 sections review S2 / S8: the merge dialog's summary says when the copy's sections are left out (the main notebook keeps its own
 * version, or its list is full) instead of "Nothing new".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { describeMerge } from "../src/integration/reliability";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { createDocument } from "../src/model/document";
import { planMerge } from "../src/model/merge";
import { parse, serialize } from "../src/model/serialize";
import type { NotebookDocument, Section } from "../src/model/types";

function section(id: string, page: string, over: Partial<Section> = {}): Section {
	return Object.freeze({ id, title: `Section ${id}`, color: "#2f80f7", page, ...over });
}

function twin(): { main: NotebookDocument; other: NotebookDocument } {
	const main = createDocument(new Date("2026-11-10T10:00:00.000Z"));
	main.pages[0]!.id = "p1";
	main.pages.push({ ...main.pages[0]!, id: "p2", strokes: [] });
	main.sections = [section("a", "p1")];
	const r = parse(serialize(main));
	if (!r.ok) throw new Error(r.message);
	return { main, other: r.doc };
}

describe("review S2 / S8: the merge summary names the sections it leaves out", () => {
	it("a copy whose only difference is a renamed section is not 'nothing new'", () => {
		const { main, other } = twin();
		other.sections = [section("a", "p1", { title: "Renamed" })];
		const lines = describeMerge(planMerge(main, other).summary);
		expect(lines).not.toContain(en["merge.summary.nothing"]);
		expect(lines.join("\n")).toContain("1 sections differ in the copy");
	});

	it("a copy identical to the notebook is still 'nothing new'", () => {
		const { main, other } = twin();
		expect(describeMerge(planMerge(main, other).summary)).toEqual([en["merge.summary.nothing"]]);
	});

	it("a full list is said, not hidden", () => {
		const { main, other } = twin();
		const summary = { ...planMerge(main, other).summary, sectionsFull: 2 };
		expect(describeMerge(summary).join("\n")).toContain("2 sections of the copy were not added");
	});

	it("the summary lines exist in English and Italian", () => {
		for (const key of ["merge.summary.sectionsDiffer", "merge.summary.sectionsFull"] as const) {
			expect(en[key]).toContain("{count}");
			expect(itMessages[key]).toContain("{count}");
		}
	});
});
