/**
 * 0.30 sections review S4 / S6, the view side: one count for the 200 limit (sections that show nowhere count, and can be removed), and the
 * *New section* dialog keeps the page id, not its index.
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ save: null as null | ((title: string, color: string) => boolean), page: 0 }));

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());
vi.mock("../src/view/sections-modal", () => ({
	SectionsModal: class {
		open(): void {}
	},
	SectionEditModal: class {
		constructor(_app: unknown, o: { page: number }, save: (title: string, color: string) => boolean) {
			captured.save = save;
			captured.page = o.page;
		}
		open(): void {}
	},
}));

import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import { hiddenSections, resolveSections, sectionsOf } from "../src/model/sections";
import { checkContent } from "../src/model/serialize";
import { SECTIONS_MAX, type NotebookDocument, type Section } from "../src/model/types";
import { SectionTools } from "../src/view/sections-tools";

const section = (id: string, page: string): Section => Object.freeze({ id, title: `Section ${id}`, color: "#2f80f7", page });

function setup(): { doc: NotebookDocument; tools: SectionTools; history: History } {
	const doc = createDocument(new Date("2026-11-10T10:00:00.000Z"));
	doc.pages[0]!.id = "p1";
	for (let i = 2; i <= 4; i++) doc.pages.push({ ...doc.pages[0]!, id: `p${i}`, strokes: [] });
	const history = new History(() => doc, 500, checkContent);
	const tools = new SectionTools({
		app: {} as never, doc: () => doc, editable: () => true, execute: (cmd) => history.execute(cmd), current: () => 2, goTo: () => undefined,
	});
	return { doc, tools, history };
}

describe("review S4: sections that show nowhere count toward the limit, and can be removed", () => {
	it("finds dormant sections and a second section on one page", () => {
		const pages = [{ id: "p1" }, { id: "p2" }];
		const a = section("a", "p1");
		const twin = section("t", "p1");
		const gone = section("g", "nowhere");
		expect(hiddenSections(pages, [a, twin, gone])).toEqual([twin, gone]);
		expect(hiddenSections(pages, [])).toEqual([]);
	});

	it("the button and create() agree on full, and removing the hidden ones makes room in one undo step", () => {
		const { doc, tools, history } = setup();
		const list: Section[] = [section("a", "p1")];
		for (let i = 1; i < SECTIONS_MAX; i++) list.push(section(`d${i}`, `gone${i}`));
		doc.sections = list;
		expect(resolveSections(doc.pages, list)).toHaveLength(1); // one shows
		expect(tools.isFull()).toBe(true);
		expect(tools.hiddenCount()).toBe(SECTIONS_MAX - 1);
		captured.save = null;
		tools.create(2);
		expect(captured.save).toBeNull(); // full: no dialog
		expect(tools.removeHidden()).toBe(true);
		expect(sectionsOf(doc).map((s) => s.id)).toEqual(["a"]);
		expect(tools.isFull()).toBe(false);
		expect(tools.hiddenCount()).toBe(0);
		history.undo();
		expect(sectionsOf(doc)).toHaveLength(SECTIONS_MAX);
		expect(tools.removeHidden()).toBe(true);
		expect(tools.removeHidden()).toBe(false); // nothing left to remove
	});
});

describe("review R7: the hidden-sections texts", () => {
	it("say one section in the singular, in English and Italian, and name both reasons a section shows nowhere", async () => {
		const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };
		const { doc, tools } = setup();
		doc.sections = [section("a", "p1"), section("g", "gone")];
		Notice.shown.length = 0;
		expect(tools.removeHidden()).toBe(true);
		expect(Notice.shown.join("\n")).toContain("1 section that showed nowhere removed");
		const { en } = await import("../src/i18n/en");
		const { it: itMessages } = await import("../src/i18n/it");
		for (const m of [en, itMessages]) {
			expect(m["sections.hidden.noteOne"]).not.toContain("{count}");
			expect(m["sections.notice.hiddenRemovedOne"]).not.toContain("{count}");
		}
		expect(en["sections.hidden.note"]).toContain("another section already starts there");
	});
});

describe("review S6: the New section dialog keeps the page id", () => {
	it("starts the section at the page the dialog showed, even when the pages moved meanwhile", () => {
		const { doc, tools } = setup();
		captured.save = null;
		tools.create(2); // p3
		expect(captured.page).toBe(3);
		// The page list changes while the dialog is open: a page arrives in front.
		doc.pages.unshift({ ...doc.pages[0]!, id: "p0", strokes: [] });
		expect(captured.save!("Chemistry", "#2f80f7")).toBe(true);
		expect(sectionsOf(doc).map((s) => s.page)).toEqual(["p3"]);
	});

	it("makes nothing when the page is gone, and closes the dialog", () => {
		const { doc, tools } = setup();
		captured.save = null;
		tools.create(1); // p2
		doc.pages.splice(1, 1);
		expect(captured.save!("Chemistry", "#2f80f7")).toBe(true);
		expect(sectionsOf(doc)).toHaveLength(0);
	});
});
