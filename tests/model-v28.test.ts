/**
 * Format v28: coloured sections (#52) — the optional notebook-level `sections` list: the v27 -> v28 migration, lenient read and strict write,
 * staged loading, repair, the history (SetSections, and the page commands that keep sections consistent: delete, move, reorder, undo), merge,
 * templates, page transfer and the pure rules of model/sections.ts.
 */
import { describe, expect, it } from "vitest";
import { createDocument } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { AddPage, Batch, DeletePage, History, MovePage } from "../src/model/history";
import { deleteCommand, duplicateCommand, moveCommand, ReorderPages } from "../src/model/page-ops";
import { computeScope, CLASSIFIED } from "../src/model/page-undo";
import { describeCommand } from "../src/model/history-describe";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { applyRemoval } from "../src/model/notebook-transfer";
import { CURRENT_VERSION, FORMAT_ID, SECTIONS_MAX, SECTION_TITLE_MAX, type NotebookDocument, type Section } from "../src/model/types";
import {
	isSectionColor, isStoredSectionTitle, makeSection, mergedSections, movedPages, newSectionId, normalizeSectionTitle, resolveSections, sameSections,
	sectionAtIndex, sectionOfPage, sectionsAfterDelete, sectionsAfterReorder, sectionsForCopy, sectionsMergeReport, sectionsOf, sectionStartingAt, SetSections, setSections,
	withSectionAdded, withSectionRecoloured, withSectionRemoved, withSectionRenamed,
} from "../src/model/sections";
import { getAt, parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-10T10:00:00.000Z";

function section(id: string, page: string, over: Partial<Section> = {}): Section {
	return Object.freeze({ id, title: `Section ${id}`, color: "#2f80f7", page, ...over });
}

/** Six pages p1..p6; section A starts at p2 (p2, p3), B at p4 (p4..p6). p1 is in no section. */
function sectionDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const first = doc.pages[0]!;
	first.id = "p1";
	for (let i = 2; i <= 6; i++) doc.pages.push({ ...first, id: `p${i}`, strokes: [] });
	doc.sections = [section("a", "p2", { title: "Chemistry" }), section("b", "p4", { title: "Physics", color: "#16c2a3" })];
	return doc;
}

const ids = (doc: NotebookDocument): string[] => doc.pages.map((p) => p.id);
const anchors = (doc: NotebookDocument): string[] => sectionsOf(doc).map((s) => `${s.id}@${s.page}`);
const ranges = (doc: NotebookDocument): string[] => resolveSections(doc.pages, sectionsOf(doc)).map((r) => `${r.section.id}:${r.start}-${r.end}`);

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function historyOf(doc: NotebookDocument, extra: { locked?: () => boolean; refused?: (m: string) => void } = {}): History {
	return new History(() => doc, 500, checkContent, extra.refused ? (m) => extra.refused!(m) : null, extra.locked ?? null);
}

function v27Raw(): ReturnType<typeof parseRaw> {
	return {
		format: FORMAT_ID, version: 27, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 2, points: [[1, 2, 0.5], [3, 4, 0.5]] }] }],
	};
}

describe("format v28: sections in the file", () => {
	it("is the current format and has the v27 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(28);
		expect(typeof MIGRATIONS[27]).toBe("function");
	});

	it("writes the sections before the assets, one per line, and reads them back exactly", () => {
		const doc = sectionDoc();
		const text = serialize(doc);
		expect(text).toContain('"sections": [');
		expect(text.indexOf('"sections"')).toBeLessThan(text.indexOf('"assets"'));
		expect(text).toContain('\t\t{"id":"a","title":"Chemistry","color":"#2f80f7","page":"p2"}');
		const back = parsed(text);
		expect(back.dropped).toBeUndefined();
		expect(back.doc.sections).toEqual(doc.sections);
		expect(serialize(back.doc)).toBe(text);
		expect(Object.isFrozen(back.doc.sections![0])).toBe(true);
	});

	it("writes no sections key when there is none", () => {
		const doc = sectionDoc();
		doc.sections = [];
		expect(serialize(doc)).not.toContain('"sections"');
		delete doc.sections;
		expect(serialize(doc)).not.toContain('"sections"');
		expect(parsed(serialize(doc)).doc.sections).toBeUndefined();
	});

	it("keeps a section whose page is gone (dormant: it shows nowhere)", () => {
		const doc = sectionDoc();
		doc.sections = [...doc.sections!, section("c", "gone")];
		const back = parsed(serialize(doc));
		expect(back.doc.sections!.map((s) => s.id)).toEqual(["a", "b", "c"]);
		expect(resolveSections(back.doc.pages, back.doc.sections!).map((r) => r.section.id)).toEqual(["a", "b"]);
	});

	describe("strict write", () => {
		const refused = (edit: (doc: NotebookDocument) => void): void => {
			const doc = sectionDoc();
			edit(doc);
			expect(serializeChecked(doc).ok, "serializeChecked").toBe(false);
			expect(checkContent(doc), "checkContent").not.toBeNull();
		};
		it("refuses a repeated id", () => refused((d) => void d.sections!.push(section("a", "p5"))));
		it("refuses two sections on one page", () => refused((d) => void d.sections!.push(section("c", "p2"))));
		it("refuses an empty title", () => refused((d) => void (d.sections![0] = section("a", "p2", { title: "" }))));
		it("refuses a title with spaces around it", () => refused((d) => void (d.sections![0] = section("a", "p2", { title: " Chem" }))));
		it("refuses a title on two lines", () => refused((d) => void (d.sections![0] = section("a", "p2", { title: "Two\nlines" }))));
		it("refuses a title that is too long", () => refused((d) => void (d.sections![0] = section("a", "p2", { title: "t".repeat(SECTION_TITLE_MAX + 1) }))));
		it("refuses a colour that is not #rrggbb", () => refused((d) => void (d.sections![0] = section("a", "p2", { color: "blue" }))));
		it("refuses a section without a page", () => refused((d) => void (d.sections![0] = section("a", ""))));
		it("refuses more sections than the limit", () => refused((d) => void (d.sections = Array.from({ length: SECTIONS_MAX + 1 }, (_, i) => section(`s${i}`, `x${i}`)))));

		it("accepts exactly the limit and the longest title", () => {
			const doc = sectionDoc();
			doc.sections = Array.from({ length: SECTIONS_MAX }, (_, i) => section(`s${i}`, `x${i}`, i === 0 ? { title: "t".repeat(SECTION_TITLE_MAX) } : {}));
			expect(serializeChecked(doc).ok).toBe(true);
			expect(checkContent(doc)).toBeNull();
		});
	});

	describe("lenient read", () => {
		const edited = (edit: (raw: ReturnType<typeof parseRaw>) => void) => {
			const raw = parseRaw(serialize(sectionDoc()));
			edit(raw);
			return parse(JSON.stringify(raw));
		};
		it("drops an invalid entry, counts it and keeps the others", () => {
			const r = edited((raw) => setAt(raw, ["sections", 0, "color"], 12));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.doc.sections!.map((s) => s.id)).toEqual(["b"]);
			expect(r.dropped).toBe(1);
		});
		it("drops a second section on the same page", () => {
			const r = edited((raw) => setAt(raw, ["sections", 1, "page"], "p2"));
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.doc.sections!.map((s) => s.id)).toEqual(["a"]);
		});
		it("keeps a title that is not in its stored form, cleaned, and counts it", () => {
			const r = edited((raw) => setAt(raw, ["sections", 0, "title"], "  Organic\n chemistry "));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.doc.sections![0]!.title).toBe("Organic chemistry");
			expect(r.dropped).toBe(1);
		});
		it("drops a sections value that is not a list, and the notebook still opens", () => {
			const r = edited((raw) => setAt(raw, ["sections"], { a: 1 }));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.doc.sections).toBeUndefined();
			expect(r.dropped).toBe(1);
		});
		it("review S3: leaves out unknown keys of an entry and counts them, so a backup is kept before the save that loses them", () => {
			const r = edited((raw) => {
				setAt(raw, ["sections", 0, "icon"], "flask");
				setAt(raw, ["sections", 0, "note"], "x");
			});
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.doc.sections!.map((s) => s.id)).toEqual(["a", "b"]);
			expect(r.dropped).toBe(1); // one per entry
			expect(serialize(r.doc)).not.toContain('"icon"');
			// The strict check of what the plugin holds never sees such a key.
			expect(checkContent(r.doc)).toBeNull();
			// A file without them reads with nothing dropped.
			expect(parsed(serialize(sectionDoc())).dropped).toBeUndefined();
		});
	});
});

describe("format v28: migration from v27", () => {
	it("changes nothing but the version of a valid v27 document", () => {
		const raw = v27Raw();
		const migrated = MIGRATIONS[27]!(raw);
		expect(migrated).toEqual({ ...raw, version: 28 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("reads a v27 file, says it was migrated and writes it as v28 without sections", () => {
		const r = parsed(JSON.stringify(v27Raw()));
		expect(r.migratedFrom).toBe(27);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.sections).toBeUndefined();
		const text = serialize(r.doc);
		expect(getAt(parseRaw(text), ["version"])).toBe(CURRENT_VERSION);
		expect(text).not.toContain('"sections"');
	});

	it("drops a stray sections key of a v27 file (a v27 reader never gave it a meaning)", () => {
		const raw = v27Raw();
		setAt(raw, ["sections"], [{ id: "x", title: "Not ours", color: "#000000", page: "p1" }]);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(27);
		expect(r.doc.sections).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v26 file through every step", () => {
		const raw = v27Raw();
		setAt(raw, ["version"], 26);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(26);
		expect(r.doc.version).toBe(CURRENT_VERSION);
	});

	it("opens a file of a newer format read-only", () => {
		const raw = parseRaw(serialize(sectionDoc()));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});
});

describe("format v28: staged loading and repair", () => {
	it("stages a large v28 file with sections and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.sections = [section("a", doc.pages[0]!.id), section("b", doc.pages[2]!.id, { title: "Second" })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.sections).toEqual(doc.sections);
		expect(serialize(r.doc)).toBe(text);
	});

	it("stages a large v27 file, ignoring a stray sections key", () => {
		const doc = stressDocument(6000, 3, 7);
		const raw = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, '"version": 27');
		const text = raw.replace('"assets"', '"sections": [{"id":"x","title":"Not ours","color":"#000000","page":"p"}],\n\t"assets"');
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(27);
			expect(r.doc.sections).toBeUndefined();
		}
	});

	it("keeps the sections of a cut-off file", () => {
		const doc = stressDocument(40, 2, 3);
		doc.sections = [section("a", doc.pages[0]!.id), section("b", doc.pages[1]!.id, { title: "Second" })];
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.sections!.map((s) => s.title)).toEqual(["Section a", "Second"]);
	});

	it("leaves out an invalid section, counts it, and does not call the key unknown", () => {
		const raw = parseRaw(serialize(sectionDoc()));
		setAt(raw, ["sections", 1, "color"], "teal");
		setAt(raw, ["pages", 0, "width"], "wide");
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.sections!.map((s) => s.id)).toEqual(["a"]);
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(1);
		expect(r.summary.unknownFields).toBe(0);
	});
});

describe("model/sections: the rules", () => {
	it("normalises titles and checks colours", () => {
		expect(normalizeSectionTitle("  Organic \t chemistry\n ")).toBe("Organic chemistry");
		expect(normalizeSectionTitle(" \n ")).toBe("");
		expect(Array.from(normalizeSectionTitle("x".repeat(100)))).toHaveLength(SECTION_TITLE_MAX);
		expect(isStoredSectionTitle("Physics")).toBe(true);
		expect(isStoredSectionTitle(" Physics")).toBe(false);
		expect(isSectionColor("#AbCdEf")).toBe(true);
		expect(isSectionColor("#abc")).toBe(false);
	});

	it("makes free ids and frozen sections, or none when it cannot be one", () => {
		const taken = new Set(["aaaaaaaa"]);
		let n = 0;
		const random = () => (n++ < 8 ? 0 : 0.5);
		expect(newSectionId(taken, random)).not.toBe("aaaaaaaa");
		const s = makeSection({ title: " Biology ", color: "#22C55E", page: "p1" }, new Set());
		expect(s).toMatchObject({ title: "Biology", color: "#22c55e", page: "p1" });
		expect(Object.isFrozen(s)).toBe(true);
		expect(makeSection({ title: " ", color: "#22c55e", page: "p1" }, new Set())).toBeNull();
		expect(makeSection({ title: "X", color: "green", page: "p1" }, new Set())).toBeNull();
		expect(makeSection({ title: "X", color: "#22c55e", page: "" }, new Set())).toBeNull();
	});

	it("resolves ranges in page order, whatever the list order", () => {
		const doc = sectionDoc();
		doc.sections = [doc.sections![1]!, doc.sections![0]!];
		expect(ranges(doc)).toEqual(["a:1-2", "b:3-5"]);
		const all = resolveSections(doc.pages, doc.sections);
		expect(sectionAtIndex(all, 0)).toBeNull();
		expect(sectionAtIndex(all, 2)!.section.id).toBe("a");
		expect(sectionAtIndex(all, 5)!.count).toBe(3);
		expect(sectionOfPage(doc, "p5")!.section.title).toBe("Physics");
		expect(sectionOfPage(doc, "p1")).toBeNull();
		expect(sectionOfPage(doc, "nope")).toBeNull();
		expect(sectionStartingAt(doc.sections, "p4")!.id).toBe("b");
	});

	it("adds, renames, recolours and removes, always as new arrays", () => {
		const doc = sectionDoc();
		const start = sectionsOf(doc);
		const added = withSectionAdded(start, section("c", "p6"));
		expect(added).not.toBe(start);
		expect(start).toHaveLength(2);
		expect(withSectionAdded(start, section("d", "p2"))).toBe(start); // a section already starts there
		expect(withSectionAdded(start, section("a", "p6"))).toBe(start); // id taken
		const renamed = withSectionRenamed(start, "a", "  Organic chemistry ");
		expect(renamed[0]!.title).toBe("Organic chemistry");
		expect(withSectionRenamed(start, "a", "Chemistry")).toBe(start);
		expect(withSectionRenamed(start, "a", "  ")).toBe(start);
		const recoloured = withSectionRecoloured(start, "b", "#F0565E");
		expect(recoloured[1]!.color).toBe("#f0565e");
		expect(withSectionRecoloured(start, "b", "red")).toBe(start);
		expect(withSectionRemoved(start, "a").map((s) => s.id)).toEqual(["b"]);
		expect(withSectionRemoved(start, "zz")).toBe(start);
		expect(sameSections(start, [...start])).toBe(true);
		expect(sameSections(start, renamed)).toBe(false);
	});

	it("follows a delete: the start moves to the next page of the section, or the section goes when it had no other page", () => {
		const list = sectionDoc().sections!;
		expect(sectionsAfterDelete(list, "p2", "p3").map((s) => s.page)).toEqual(["p3", "p4"]);
		expect(sectionsAfterDelete(list, "p3", "p4")).toBe(list); // not a start
		const one = [section("a", "p3"), section("b", "p4")];
		expect(sectionsAfterDelete(one, "p3", "p4").map((s) => s.id)).toEqual(["b"]); // only page of a
		expect(sectionsAfterDelete(one, "p4", undefined).map((s) => s.id)).toEqual(["a"]); // last page of the notebook
	});

	it("follows a reorder: a section stays where its other pages stay, and goes with them when they all move", () => {
		const list = sectionDoc().sections!;
		const before = ["p1", "p2", "p3", "p4", "p5", "p6"];
		// p2 (start of A) moved to the end: A now starts at p3, p2 joins B.
		const a = sectionsAfterReorder(list, before, ["p1", "p3", "p4", "p5", "p6", "p2"], new Set(["p2"]));
		expect(a.map((s) => s.page)).toEqual(["p3", "p4"]);
		// The whole of A (p2, p3) moved after p6: A goes with them.
		const b = sectionsAfterReorder(list, before, ["p1", "p4", "p5", "p6", "p2", "p3"], new Set(["p2", "p3"]));
		expect(b).toBe(list);
		expect(resolveSections(["p1", "p4", "p5", "p6", "p2", "p3"].map((id) => ({ id })), b).map((r) => `${r.section.id}:${r.start}-${r.end}`)).toEqual(["b:1-3", "a:4-5"]);
		// A page that does not start a section changes nothing.
		expect(sectionsAfterReorder(list, before, ["p1", "p2", "p5", "p3", "p4", "p6"], new Set(["p5"]))).toBe(list);
	});

	it("finds the pages that moved when the choice is not known", () => {
		expect([...movedPages(["a", "b", "c", "d"], ["a", "c", "d", "b"])]).toEqual(["b"]);
		expect([...movedPages(["a", "b", "c", "d"], ["d", "a", "b", "c"])]).toEqual(["d"]);
		expect(movedPages(["a", "b"], ["a", "b"]).size).toBe(0);
	});

	it("copies sections onto copies of pages with new ids, leaving out those whose page was not copied", () => {
		const list = sectionDoc().sections!;
		const copies = sectionsForCopy(list, new Map([["p2", "q2"]]));
		expect(copies).toHaveLength(1);
		expect(copies[0]).toMatchObject({ title: "Chemistry", color: "#2f80f7", page: "q2" });
		expect(copies[0]!.id).not.toBe("a");
	});

	it("merges by id, on pages the result has that start no section", () => {
		const main = [section("a", "p2")];
		const other = [section("a", "p2", { title: "Changed" }), section("b", "p4"), section("c", "p2"), section("d", "gone")];
		const united = mergedSections(main, other, new Set(["p2", "p4"]));
		expect(united.map((s) => s.id)).toEqual(["a", "b"]);
		expect(united[0]!.title).toBe("Section a");
		expect(mergedSections(main, [], new Set())).toBe(main);
	});
});

describe("format v28: history", () => {
	it("one command per edit: run, undo and redo put the whole list back", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		const made = makeSection({ title: "Maths", color: "#8b5cf6", page: "p6" }, new Set(sectionsOf(doc).map((s) => s.id)))!;
		expect(history.execute(setSections(doc, withSectionAdded(sectionsOf(doc), made), "New section")!)).toBe(true);
		expect(ranges(doc)).toEqual(["a:1-2", "b:3-4", `${made.id}:5-5`]);
		expect(history.execute(setSections(doc, withSectionRenamed(sectionsOf(doc), "a", "Organic"), "Rename section")!)).toBe(true);
		history.undo();
		expect(doc.sections![0]!.title).toBe("Chemistry");
		history.undo();
		expect(doc.sections).toHaveLength(2);
		history.redo();
		history.redo();
		expect(doc.sections).toHaveLength(3);
		expect(doc.sections![0]!.title).toBe("Organic");
	});

	it("leaves the document without a sections key when the last one is removed, and undo brings it back", () => {
		const doc = sectionDoc();
		doc.sections = [section("a", "p2")];
		const history = historyOf(doc);
		history.execute(setSections(doc, withSectionRemoved(sectionsOf(doc), "a"), "Delete section")!);
		expect("sections" in doc).toBe(false);
		history.undo();
		expect(anchors(doc)).toEqual(["a@p2"]);
	});

	it("is refused by the document guard when the result could not be saved", () => {
		const doc = sectionDoc();
		const said: string[] = [];
		const history = historyOf(doc, { refused: (m) => said.push(m) });
		expect(history.execute(new SetSections(sectionsOf(doc), [...sectionsOf(doc), section("c", "p2")], "New section"))).toBe(false);
		expect(said).toHaveLength(1);
		expect(doc.sections).toHaveLength(2);
	});

	it("makes no command for a change that changes nothing, and works with a locked page", () => {
		const doc = sectionDoc();
		expect(setSections(doc, [...sectionsOf(doc)], "x")).toBeNull();
		doc.pages[1]!.locked = true;
		const history = historyOf(doc);
		expect(history.execute(setSections(doc, withSectionRecoloured(sectionsOf(doc), "a", "#f0565e"), "Recolour section")!)).toBe(true);
	});

	it("deleting the first page of a section moves the start to the next page; undo puts it back", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		expect(history.execute(new DeletePage(doc.pages[1]!, 1))).toBe(true);
		expect(anchors(doc)).toEqual(["a@p3", "b@p4"]);
		expect(ranges(doc)).toEqual(["a:1-1", "b:2-4"]);
		history.undo();
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
		history.redo();
		expect(anchors(doc)).toEqual(["a@p3", "b@p4"]);
	});

	it("deleting every page of a section removes it, in one step that undo reverses", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		expect(history.execute(deleteCommand(doc, ["p2", "p3"])!)).toBe(true);
		expect(ids(doc)).toEqual(["p1", "p4", "p5", "p6"]);
		expect(anchors(doc)).toEqual(["b@p4"]);
		expect(checkContent(doc)).toBeNull();
		history.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
	});

	it("deleting the last page of the notebook that starts a section removes it", () => {
		const doc = sectionDoc();
		doc.sections = [...doc.sections!, section("c", "p6")];
		const history = historyOf(doc);
		expect(history.execute(new DeletePage(doc.pages[5]!, 5))).toBe(true);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
	});

	it("a delete that does nothing (the only page) changes no section", () => {
		const doc = createDocument(new Date(stamp));
		doc.sections = [section("a", doc.pages[0]!.id)];
		const cmd = new DeletePage(doc.pages[0]!, 0);
		cmd.apply(doc);
		expect(doc.sections).toHaveLength(1);
		cmd.revert(doc);
		expect(doc.sections).toHaveLength(1);
	});

	it("moving one page (MovePage) keeps the section with the pages that stay", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		// p4 (start of B) one place up: it lands at the end of A; B now starts at p5.
		expect(history.execute(new MovePage("p4", 3, 2))).toBe(true);
		expect(ids(doc)).toEqual(["p1", "p2", "p4", "p3", "p5", "p6"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p5"]);
		history.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
	});

	it("moving a whole section (ReorderPages from the page selection) takes it along", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		expect(history.execute(moveCommand(doc, ["p2", "p3"], "end")!)).toBe(true);
		expect(ids(doc)).toEqual(["p1", "p4", "p5", "p6", "p2", "p3"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
		expect(ranges(doc)).toEqual(["b:1-3", "a:4-5"]);
		history.undo();
		expect(ranges(doc)).toEqual(["a:1-2", "b:3-5"]);
	});

	it("moving part of a section away re-anchors it; undo restores the exact list", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		expect(history.execute(moveCommand(doc, ["p4"], "start")!)).toBe(true);
		expect(ids(doc)).toEqual(["p4", "p1", "p2", "p3", "p5", "p6"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p5"]);
		history.undo();
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
		// Without the person's choice the command works out which pages moved.
		const cmd = new ReorderPages(ids(doc), ["p1", "p2", "p3", "p5", "p6", "p4"]);
		cmd.apply(doc);
		expect(anchors(doc)).toEqual(["a@p2", "b@p5"]);
		cmd.revert(doc);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
	});

	it("adding, inserting and duplicating pages change no section (new pages join the section they land in)", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		const before = doc.sections;
		const dup = duplicateCommand(doc, ["p2"])!;
		expect(history.execute(dup.command)).toBe(true);
		expect(doc.sections).toBe(before);
		expect(sectionOfPage(doc, doc.pages[2]!.id)!.section.id).toBe("a");
		expect(history.execute(new AddPage({ ...doc.pages[0]!, id: "n1", strokes: [] }, 0))).toBe(true);
		expect(ranges(doc)).toEqual(["a:2-4", "b:5-7"]);
	});

	it("a notebook without sections never gets a sections key from page commands", () => {
		const doc = sectionDoc();
		delete doc.sections;
		const history = historyOf(doc);
		history.execute(new Batch("x", [new DeletePage(doc.pages[1]!, 1), new MovePage("p4", 2, 0)]));
		expect("sections" in doc).toBe(false);
		history.undo();
		expect("sections" in doc).toBe(false);
	});

	/** Pages named `names`; `starts`: section id → its first page (title `Section <id>`, one colour each). */
	function laidOut(names: string[], starts: Record<string, string>): NotebookDocument {
		const doc = createDocument(new Date(stamp));
		const first = doc.pages[0]!;
		first.id = names[0]!;
		for (const id of names.slice(1)) doc.pages.push({ ...first, id, strokes: [] });
		const colours = ["#2f80f7", "#16c2a3", "#f0565e", "#8b5cf6"];
		doc.sections = Object.entries(starts).map(([id, page], i) => section(id, page, { color: colours[i % colours.length]! }));
		return doc;
	}
	/** Which section each page is in, in page order ("-" for none). */
	const membership = (doc: NotebookDocument): string[] => doc.pages.map((p) => sectionOfPage(doc, p.id)?.section.id ?? "-");
	/** Same, by look (title and colour), for sections that a continuation carries on. */
	const looks = (doc: NotebookDocument): string[] => doc.pages.map((p) => sectionOfPage(doc, p.id)?.section.title ?? "-");

	it("review S1: Move up of a one-page section keeps the pages around it in their sections, and a second Move up puts the host back together", () => {
		const doc = laidOut(["x1", "x2", "s1", "y1"], { x: "x1", s: "s1", y: "y1" });
		const history = historyOf(doc);
		const start = [...doc.sections!];
		expect(history.execute(new MovePage("s1", 2, 1))).toBe(true);
		expect(ids(doc)).toEqual(["x1", "s1", "x2", "y1"]);
		// x2 did not move: it keeps the look of X through a continuation (same title and colour), and y1 keeps Y.
		expect(looks(doc)).toEqual(["Section x", "Section s", "Section x", "Section y"]);
		const cont = doc.sections!.find((s) => s.page === "x2")!;
		expect(cont.id).not.toBe("x");
		expect(cont).toMatchObject({ title: "Section x", color: "#2f80f7" });
		expect(checkContent(doc)).toBeNull();
		const afterFirst = anchors(doc);
		history.undo();
		expect(ids(doc)).toEqual(["x1", "x2", "s1", "y1"]);
		expect(doc.sections).toEqual(start);
		history.redo();
		expect(anchors(doc)).toEqual(afterFirst); // the continuation gets the same id on redo
		// A second Move up: S is now first, and X is one section again (the continuation is gone).
		expect(history.execute(new MovePage("s1", 1, 0))).toBe(true);
		expect(ids(doc)).toEqual(["s1", "x1", "x2", "y1"]);
		expect(membership(doc)).toEqual(["s", "x", "x", "y"]);
		expect(anchors(doc)).toEqual(["x@x1", "s@s1", "y@y1"]);
		history.undo();
		expect(anchors(doc)).toEqual(afterFirst);
		history.undo();
		expect(doc.sections).toEqual(start);
	});

	it("review S1: Move down of a one-page section keeps the section it passes, and undo is exact", () => {
		const doc = laidOut(["x1", "s1", "y1", "y2"], { x: "x1", s: "s1", y: "y1" });
		const history = historyOf(doc);
		const start = [...doc.sections!];
		expect(history.execute(new MovePage("s1", 1, 2))).toBe(true);
		expect(ids(doc)).toEqual(["x1", "y1", "s1", "y2"]);
		expect(looks(doc)).toEqual(["Section x", "Section y", "Section s", "Section y"]);
		expect(membership(doc).slice(0, 3)).toEqual(["x", "y", "s"]);
		history.undo();
		expect(ids(doc)).toEqual(["x1", "s1", "y1", "y2"]);
		expect(doc.sections).toEqual(start);
		// Down to the end: nothing to split, Y keeps both its pages.
		expect(history.execute(new MovePage("s1", 1, 3))).toBe(true);
		expect(membership(doc)).toEqual(["x", "y", "y", "s"]);
		expect(anchors(doc)).toEqual(["x@x1", "s@s1", "y@y1"]);
		history.undo();
		expect(doc.sections).toEqual(start);
	});

	it("review S1: a whole section moved to the start in front of pages in no section takes them (the anchor model has no 'none' after a section)", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		const start = [...doc.sections!];
		expect(history.execute(moveCommand(doc, ["p2", "p3"], "start")!)).toBe(true);
		expect(ids(doc)).toEqual(["p2", "p3", "p1", "p4", "p5", "p6"]);
		// B's pages keep B; p1 can no longer be in no section and joins A, the only thing it can show.
		expect(membership(doc)).toEqual(["a", "a", "a", "b", "b", "b"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
		history.undo();
		expect(ids(doc)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
		expect(doc.sections).toEqual(start);
		history.redo();
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
	});

	it("review S1: a whole section dropped into the middle of another splits it; the host's tail keeps its look and undo is exact", () => {
		const doc = sectionDoc();
		const history = historyOf(doc);
		const start = [...doc.sections!];
		// B (p4..p6) between p2 and p3, both in A.
		const cmd = new ReorderPages(ids(doc), ["p1", "p2", "p4", "p5", "p6", "p3"], ["p4", "p5", "p6"]);
		expect(history.execute(cmd)).toBe(true);
		expect(looks(doc)).toEqual(["-", "Chemistry", "Physics", "Physics", "Physics", "Chemistry"]);
		expect(membership(doc).slice(0, 5)).toEqual(["-", "a", "b", "b", "b"]);
		expect(doc.sections).toHaveLength(3);
		expect(checkContent(doc)).toBeNull();
		const split = anchors(doc);
		history.undo();
		expect(doc.sections).toEqual(start);
		expect(membership(doc)).toEqual(["-", "a", "a", "b", "b", "b"]);
		history.redo();
		expect(anchors(doc)).toEqual(split);
		// Moving B back to the end puts A back together: the continuation is removed.
		expect(history.execute(new ReorderPages(ids(doc), ["p1", "p2", "p3", "p4", "p5", "p6"], ["p4", "p5", "p6"]))).toBe(true);
		expect(membership(doc)).toEqual(["-", "a", "a", "b", "b", "b"]);
		expect(anchors(doc)).toEqual(["a@p2", "b@p4"]);
		history.undo();
		expect(anchors(doc)).toEqual(split);
	});

	it("review S1: with a full list there is no continuation (the host's tail joins the block), and nothing the writer refuses", () => {
		const doc = sectionDoc();
		const pages = ids(doc);
		const list: Section[] = [section("a", "p2"), section("b", "p4", { title: "Other", color: "#16c2a3" })];
		for (let i = list.length; i < SECTIONS_MAX; i++) list.push(section(`d${i}`, `gone${i}`));
		const next = sectionsAfterReorder(list, pages, ["p1", "p2", "p4", "p5", "p6", "p3"], new Set(["p4", "p5", "p6"]));
		expect(next).toHaveLength(SECTIONS_MAX);
		expect(next.slice(0, 2).map((s) => `${s.id}@${s.page}`)).toEqual(["a@p2", "b@p4"]);
	});

	it("review S1: two sections that already sat next to each other with the same look are not joined by a move", () => {
		const same = { title: "Same", color: "#2f80f7" };
		const list = [section("a", "p2", same), section("b", "p4", same), section("c", "p6", { title: "Other" })];
		const before = ["p1", "p2", "p3", "p4", "p5", "p6"];
		// c (p6) moved to the start: a and b stay as they were.
		expect(sectionsAfterReorder(list, before, ["p6", "p1", "p2", "p3", "p4", "p5"], new Set(["p6"]))).toBe(list);
	});

	it("review R1: recurring sections with the same look (Lecture / Homework every week) are never joined by a move", () => {
		const lecture = { title: "Lecture", color: "#2f80f7" };
		const homework = { title: "Homework", color: "#16c2a3" };
		const doc = laidOut(["a1", "a2", "b1", "c1", "c2", "d1"], {});
		doc.sections = [section("l1", "a1", lecture), section("h1", "b1", homework), section("l2", "c1", lecture), section("h2", "d1", homework)];
		const start = [...doc.sections];
		const history = historyOf(doc);
		// The one-page section h1 moved to the end, then back, with MovePage (the page panel's moves).
		expect(history.execute(new MovePage("b1", 2, 5))).toBe(true);
		expect(ids(doc)).toEqual(["a1", "a2", "c1", "c2", "d1", "b1"]);
		expect(membership(doc)).toEqual(["l1", "l1", "l2", "l2", "h2", "h1"]);
		expect(doc.sections).toHaveLength(4);
		expect(history.execute(new MovePage("b1", 5, 2))).toBe(true);
		expect(membership(doc)).toEqual(["l1", "l1", "h1", "l2", "l2", "h2"]);
		expect(doc.sections).toEqual(start);
		history.undo();
		history.undo();
		expect(doc.sections).toEqual(start);
		// A whole section dropped right after an independent section with the same look stays a section of its own.
		expect(history.execute(new ReorderPages(ids(doc), ["a1", "a2", "c1", "c2", "b1", "d1"], ["c1", "c2"]))).toBe(true);
		expect(membership(doc)).toEqual(["l1", "l1", "l2", "l2", "h1", "h2"]);
		expect(doc.sections).toHaveLength(4);
	});

	it("review R1: the pieces of a section split twice are put back together, the original keeping its id", () => {
		const doc = laidOut(["x1", "x2", "x3", "s1", "t1", "y1"], { x: "x1", s: "s1", t: "t1", y: "y1" });
		const start = [...doc.sections!];
		const history = historyOf(doc);
		// s1 between x1 and x2, then t1 between x2 and x3: X is in three pieces.
		expect(history.execute(new MovePage("s1", 3, 1))).toBe(true);
		expect(history.execute(new MovePage("t1", 4, 3))).toBe(true);
		expect(ids(doc)).toEqual(["x1", "s1", "x2", "t1", "x3", "y1"]);
		expect(looks(doc)).toEqual(["Section x", "Section s", "Section x", "Section t", "Section x", "Section y"]);
		expect(doc.sections).toHaveLength(6);
		// Both moved back out, in the other order: one X again, with its own id.
		expect(history.execute(new MovePage("s1", 1, 4))).toBe(true);
		expect(history.execute(new MovePage("t1", 2, 4))).toBe(true);
		expect(ids(doc)).toEqual(["x1", "x2", "x3", "s1", "t1", "y1"]);
		expect(membership(doc)).toEqual(["x", "x", "x", "s", "t", "y"]);
		expect(doc.sections).toHaveLength(4);
		for (let i = 0; i < 4; i++) history.undo();
		expect(doc.sections).toEqual(start);
	});

	it("review R1: a continuation renamed by the person is a section of its own and is not joined back", () => {
		const doc = laidOut(["x1", "x2", "s1", "y1"], { x: "x1", s: "s1", y: "y1" });
		const history = historyOf(doc);
		expect(history.execute(new MovePage("s1", 2, 1))).toBe(true);
		const cont = doc.sections!.find((s) => s.page === "x2")!;
		expect(history.execute(setSections(doc, withSectionRenamed(sectionsOf(doc), cont.id, "Part two"), "Rename section")!)).toBe(true);
		expect(history.execute(new MovePage("s1", 1, 0))).toBe(true);
		expect(looks(doc)).toEqual(["Section s", "Section x", "Part two", "Section y"]);
		expect(doc.sections).toHaveLength(4);
	});

	it("review T2: the pieces of a section renamed while split, then renamed back, are put back together", () => {
		const doc = laidOut(["x1", "x2", "x3", "s1", "t1", "y1"], { x: "x1", s: "s1", t: "t1", y: "y1" });
		const history = historyOf(doc);
		const rename = (id: string, title: string): void => {
			expect(history.execute(setSections(doc, withSectionRenamed(sectionsOf(doc), id, title), "Rename section")!)).toBe(true);
		};
		// s1 between x1 and x2; X renamed; t1 dropped inside the continuation; X renamed back.
		expect(history.execute(new MovePage("s1", 3, 1))).toBe(true);
		rename("x", "Tmp");
		expect(history.execute(new MovePage("t1", 4, 3))).toBe(true);
		expect(looks(doc)).toEqual(["Tmp", "Section s", "Section x", "Section t", "Section x", "Section y"]);
		// While the names differ, the pieces stay apart.
		expect(doc.sections).toHaveLength(6);
		rename("x", "Section x");
		expect(history.execute(new MovePage("s1", 1, 4))).toBe(true);
		expect(history.execute(new MovePage("t1", 2, 4))).toBe(true);
		expect(ids(doc)).toEqual(["x1", "x2", "x3", "s1", "t1", "y1"]);
		expect(membership(doc)).toEqual(["x", "x", "x", "s", "t", "y"]);
		expect(doc.sections).toHaveLength(4);
	});

	it("is classified as a global step for per-page undo, and the panel has a title for it", () => {
		expect(CLASSIFIED).toContain("SetSections");
		const scope = computeScope(new SetSections([], [section("a", "p1")], "New section"));
		expect(scope.local).toBe(false);
		expect(describeCommand(new SetSections([], [section("a", "p1")], "New section")).key).toBe("histpanel.t.sections");
	});
});

describe("format v28: merge, templates and transfers", () => {
	function twin(): { main: NotebookDocument; other: NotebookDocument } {
		const main = sectionDoc();
		const other = parsed(serialize(main)).doc;
		return { main, other };
	}

	it("brings the sections of a copy that the notebook lacks, in one step, and the check sees them", () => {
		const { main, other } = twin();
		other.sections = [...other.sections!, section("c", "p6", { title: "Maths" }), section("d", "nowhere")];
		const plan = planMerge(main, other);
		expect(plan.summary.sectionsAdded).toBe(1);
		expect(mergeChangeCount(plan.summary)).toBeGreaterThanOrEqual(1);
		const history = historyOf(main);
		expect(history.execute(plan.command!)).toBe(true);
		expect(anchors(main)).toEqual(["a@p2", "b@p4", "c@p6"]);
		expect(mergeCovers(main, other)).toBe(true);
		history.undo();
		expect(mergeCovers(main, other)).toBe(false);
	});

	it("keeps the main notebook's section on a shared id or page, and is idempotent", () => {
		const { main, other } = twin();
		other.sections = [section("a", "p2", { title: "Theirs" }), section("x", "p4", { title: "Other on B's page" })];
		const plan = planMerge(main, other);
		expect(plan.summary.sectionsAdded).toBe(0);
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("review S2: counts the copy's sections that differ (renamed, recoloured, moved, or another one on a page main already starts)", () => {
		const { main, other } = twin();
		other.sections = [
			section("a", "p2", { title: "Theirs" }), // renamed
			section("b", "p5", { title: "Physics", color: "#16c2a3" }), // moved
			section("x", "p4", { title: "Other on B's page" }), // blocked by B's anchor
			section("z", "gone", { title: "Elsewhere" }), // a page the result lacks: not counted
		];
		const plan = planMerge(main, other);
		expect(plan.summary.sectionsAdded).toBe(0);
		expect(plan.summary.sectionsDiffer).toBe(3);
		expect(plan.summary.sectionsFull).toBe(0);
		expect(mergeChangeCount(plan.summary)).toBe(0);
		expect(plan.command).toBeNull();
		// The same look on the same page is not a difference.
		const same = twin();
		same.other.sections = [section("y", "p2", { title: "Chemistry" })];
		expect(planMerge(same.main, same.other).summary.sectionsDiffer).toBe(0);
		// Identical sections are not counted.
		const twins = twin();
		expect(planMerge(twins.main, twins.other).summary.sectionsDiffer).toBe(0);
	});

	it("review S8: counts the copy's sections that did not fit a full list, and the copy is not covered", () => {
		const { main, other } = twin();
		const full: Section[] = [...main.sections!];
		for (let i = full.length; i < SECTIONS_MAX; i++) full.push(section(`d${i}`, `gone${i}`));
		main.sections = full;
		other.sections = [section("a", "p2", { title: "Chemistry" }), section("b", "p4", { title: "Physics", color: "#16c2a3" }), section("n", "p6", { title: "New" })];
		const plan = planMerge(main, other);
		expect(plan.summary.sectionsAdded).toBe(0);
		expect(plan.summary.sectionsFull).toBe(1);
		expect(plan.summary.sectionsDiffer).toBe(0);
		expect(plan.command).toBeNull();
		expect(mergeCovers(main, other)).toBe(false);
	});

	it("review S2: the report is pure and agrees with mergedSections", () => {
		const main = [section("a", "p1")];
		const other = [section("a", "p1", { color: "#f0565e" }), section("c", "p2"), section("d", "p9")];
		const pages = new Set(["p1", "p2"]);
		expect(sectionsMergeReport(main, other, mergedSections(main, other, pages), pages)).toEqual({ differ: 1, full: 0 });
	});

	it("a notebook template keeps its sections on the copies of their pages", () => {
		const source = sectionDoc();
		const template = templateFromNotebook(source, new Date(stamp));
		expect(template.sections).toHaveLength(2);
		const tplIds = ids(template);
		expect(template.sections!.map((s) => tplIds.indexOf(s.page))).toEqual([1, 3]);
		expect(template.sections!.map((s) => s.id)).not.toContain("a");
		const made = notebookFromTemplate(template, { content: false, now: new Date(stamp) });
		expect(resolveSections(made.pages, made.sections!).map((r) => `${r.section.title}:${r.start}-${r.end}`)).toEqual(["Chemistry:1-2", "Physics:3-5"]);
		expect(serializeChecked(made).ok).toBe(true);
	});

	it("taking pages out of a closed notebook follows the sections like a delete", () => {
		const doc = sectionDoc();
		applyRemoval(doc, { remove: [doc.pages[1]!, doc.pages[3]!, doc.pages[4]!, doc.pages[5]!], changed: [], gone: [], replacement: null });
		expect(ids(doc)).toEqual(["p1", "p3"]);
		expect(anchors(doc)).toEqual(["a@p3"]);
		const all = sectionDoc();
		applyRemoval(all, { remove: [...all.pages.slice(1)], changed: [], gone: [], replacement: null });
		expect("sections" in all).toBe(false);
	});
});
