/**
 * Format v17: handwritten checklists (#103) — the element type "checkbox", the v16 -> v17 migration, lenient read and strict write,
 * staged loading, repair, the history commands and the page-lock guard, copies and templates, merge of a conflicted copy, exports,
 * the label ink, the square detector and the task line of a note.
 */
import { describe, expect, it } from "vitest";
import { instantiateClip, captureClip } from "../src/ink/clipboard";
import { checkboxFromStroke, checkboxLabelBounds, checkboxLabelInk } from "../src/ink/checklist";
import { checkboxPaths } from "../src/ink/checkbox-render";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { rectPoints, ellipsePoints } from "../src/ink/shapes";
import { scaleAbout, translate } from "../src/ink/transform";
import {
	blockIdFor, CHECKBOX_LABEL_MAX, CHECKBOX_MAX_SIZE, CHECKBOX_MIN_SIZE, checkboxesOf, checklistCounts, cleanCheckboxLabel, clearChecklist, clearedCheckbox,
	copiedCheckbox, createCheckbox, openCheckboxes, setTaskLineChecked, toggledCheckbox, withCheckboxLabel, withCheckboxTask,
} from "../src/model/checklist";
import { setCheckboxChecked, setCheckboxLabel, setCheckboxTask, toggleCheckbox, UpdateCheckbox } from "../src/model/checklist-commands";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { pageTexts } from "../src/model/export-markdown";
import { AddElement, History, RemoveElement } from "../src/model/history";
import { elementBand } from "../src/model/layers";
import { mergeChangeCount, mergeCovers, mergedCheckbox, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { SetPageLocked } from "../src/model/page-lock";
import { duplicatePage } from "../src/model/pages";
import { pageInfo } from "../src/model/page-info";
import { repairNotebookText } from "../src/model/repair";
import { freezeElement, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { documentFromTemplate, pageFromTemplate, templateDocument } from "../src/model/templates";
import { CURRENT_VERSION, FORMAT_ID, type CheckboxElement, type NotebookDocument, type Page, type Stroke } from "../src/model/types";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-05T10:00:00.000Z";
const T0 = 1_760_000_000_000;

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x: number, y: number, w = 30, h = 10): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + w, y + h / 2, 0.5], [x + w / 2, y + h, 0.5]]), id });
}

function box(over: Partial<CheckboxElement> = {}): CheckboxElement {
	return freezeElement({ id: "c1", type: "checkbox", x: 100, y: 100, size: 20, color: "#1f2430", ...over });
}

/** A document with a ticked, linked and labelled checkbox and an open one on its first page, and handwriting to the right of the first. */
function listDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.elements = [
		box({ checked: true, at: T0, label: "Buy milk", task: { path: "Daily/2026-11-05.md", block: "nb-abc123" } }),
		box({ id: "c2", y: 140 }),
	];
	page.strokes.push(stroke("s1", 130, 102), stroke("s2", 170, 104), stroke("s3", 130, 142));
	return doc;
}

function v16Raw(): Raw {
	return {
		format: FORMAT_ID, version: 16, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }],
		}],
	};
}

const boxRaw = (over: Raw = {}): Raw => ({ id: "c1", type: "checkbox", x: 10, y: 20, size: 20, color: "#1f2430", ...over });

describe("format v17: migration", () => {
	it("has the v16 step (the current format is v17 since handwritten checklists)", () => {
		expect(CURRENT_VERSION).toBe(17);
		expect(typeof MIGRATIONS[16]).toBe("function");
	});

	it("reads a v16 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v16Raw()));
		expect(r.migratedFrom).toBe(16);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes).toHaveLength(1);
		expect(r.dropped).toBeUndefined();
	});

	it("refuses a checkbox in a v16 file: no version of this plugin wrote one", () => {
		const raw = v16Raw();
		setAt(raw, ["pages", 0, "elements"], [boxRaw()]);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
	});

	it("migrates a v16 round trip: the text has the new version, no checkboxes and the same ink", () => {
		const text = serialize(parsed(JSON.stringify(v16Raw())).doc);
		expect(text).toContain(`"version": ${CURRENT_VERSION}`);
		expect(text).not.toContain('"checkbox"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("is refused by 0.18 and older as a newer format (they read up to v16, so v17 opens read-only and is never overwritten)", () => {
		const text = serialize(listDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		expect(serialize(listDoc())).toContain(`"version": ${CURRENT_VERSION}`);
	});
});

describe("format v17: write and read", () => {
	it("round-trips a checkbox on one line, byte for byte, in a fixed key order", () => {
		const doc = listDoc();
		const text = serialize(doc);
		expect(text).toContain('{"id":"c1","type":"checkbox","x":100,"y":100,"size":20,"color":"#1f2430","checked":true,"at":1760000000000,"label":"Buy milk","task":{"path":"Daily/2026-11-05.md","block":"nb-abc123"}}');
		expect(text).toContain('{"id":"c2","type":"checkbox","x":100,"y":140,"size":20,"color":"#1f2430"}');
		const back = parsed(text).doc;
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
		expect(back.pages[0]!.elements![0]).toEqual(doc.pages[0]!.elements![0]);
	});

	it("writes only what is set: no tick, no time, no label and no link for a new checkbox", () => {
		const doc = listDoc();
		doc.pages[0]!.elements = [createCheckbox(50, 50, doc.pages[0]!)];
		const text = serialize(doc);
		for (const key of ['"checked"', '"at"', '"label"', '"task"']) expect(text).not.toContain(key);
	});

	it("reads a bad size, position or colour as an invalid checkbox: dropped and counted leniently, refused strictly", () => {
		for (const over of [{ size: 3 }, { size: CHECKBOX_MAX_SIZE + 1 }, { size: "big" }, { x: "left" }, { color: "red" }]) {
			const raw = JSON.parse(serialize(listDoc())) as Raw;
			setAt(raw, ["pages", 0, "elements", 1], boxRaw({ id: "c2", ...over }));
			const r = parsed(JSON.stringify(raw));
			expect(r.dropped).toBe(1);
			expect(r.doc.pages[0]!.elements).toHaveLength(1);
			expect(() => validate(raw)).toThrow();
		}
	});

	it("keeps a checkbox whose tick time, label or link is invalid, dropping only that detail", () => {
		const bad: Array<[Raw, keyof CheckboxElement]> = [
			[{ at: "yesterday" }, "at"], [{ at: -5 }, "at"], [{ checked: "yes" }, "checked"], [{ label: 7 }, "label"],
			[{ task: "Daily.md" }, "task"], [{ task: { path: "", block: "nb-a" } }, "task"], [{ task: { path: "a.md", block: "other" } }, "task"],
			[{ task: { path: "a.md", block: "^nb-a" } }, "task"], [{ task: { path: "a\nb.md", block: "nb-a" } }, "task"],
		];
		for (const [over, field] of bad) {
			const raw = JSON.parse(serialize(listDoc())) as Raw;
			setAt(raw, ["pages", 0, "elements", 1], boxRaw({ id: "c2", ...over }));
			const r = parsed(JSON.stringify(raw));
			expect(r.dropped, JSON.stringify(over)).toBe(1);
			const el = r.doc.pages[0]!.elements![1] as CheckboxElement;
			expect(el.id).toBe("c2");
			expect(el[field], JSON.stringify(over)).toBeUndefined();
			expect(() => validate(raw)).toThrow();
		}
	});

	it("only accepts block ids this plugin writes (nb-…), so no other line of a note can be named", () => {
		const raw = JSON.parse(serialize(listDoc())) as Raw;
		for (const block of ["abc", "nb-", "nb-a b", "NB-abc", "nb-a^b", `nb-${"x".repeat(60)}`]) {
			setAt(raw, ["pages", 0, "elements", 0, "task", "block"], block);
			expect(() => validate(raw), block).toThrow();
		}
	});

	it("refuses a label that is not normalised strictly and keeps it normalised leniently", () => {
		const raw = JSON.parse(serialize(listDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 0, "label"], "  two   spaces\nand a break ");
		expect(() => validate(raw)).toThrow(/label/);
		const r = parsed(JSON.stringify(raw));
		expect((r.doc.pages[0]!.elements![0] as CheckboxElement).label).toBe("two spaces and a break");
		expect(r.dropped).toBe(1);
	});

	it("refuses a label longer than the limit strictly and cuts it leniently", () => {
		const raw = JSON.parse(serialize(listDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 0, "label"], "a".repeat(CHECKBOX_LABEL_MAX + 10));
		expect(() => validate(raw)).toThrow();
		const r = parsed(JSON.stringify(raw));
		expect((r.doc.pages[0]!.elements![0] as CheckboxElement).label).toHaveLength(CHECKBOX_LABEL_MAX);
	});

	it("shares the element id space: a checkbox with the id of a stroke is refused", () => {
		const raw = JSON.parse(serialize(listDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 1, "id"], "s1");
		expect(() => validate(raw)).toThrow(/duplicate/);
	});

	it("a checkbox does not change the bytes of the rest of the page", () => {
		const a = listDoc();
		const b = listDoc();
		delete b.pages[0]!.elements;
		const strip = (t: string) => t.replace(/\t\t\t"elements": \[\n(\t\t\t\t\{.*\n?)+\t\t\t\],?\n?/, "");
		expect(strip(serialize(a))).toBe(strip(serialize(b)));
	});

	it("the history guard accepts a checkbox and its edits", () => {
		const doc = listDoc();
		const history = new History(() => doc, 100, (d) => (serializeChecked(d).ok ? null : "refused"));
		expect(history.execute(toggleCheckbox("p1", "c2", T0 + 5))).toBe(true);
		expect(history.execute(setCheckboxLabel("p1", "c2", "Call Ana"))).toBe(true);
		expect(history.execute(setCheckboxTask("p1", "c2", { path: "Tasks.md", block: "nb-zzz" }))).toBe(true);
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

describe("format v17: staged loading", () => {
	it("stages a large v16 file and checks each page for checkboxes as it is read", () => {
		const doc = stressDocument(6000, 3, 7);
		const v16 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 16`);
		expect(v16.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v16, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(16);
			expect(r.doc.version).toBe(CURRENT_VERSION);
		}
	});

	it("refuses a large v16 file that holds a checkbox, on the page that holds it", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[2]!.elements = [box()];
		const v16 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 16`);
		const staged = parseStaged(v16, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		expect((staged as StagedParse).finish().ok).toBe(false);
	});

	it("stages a large v17 file with checkboxes and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.elements = [box({ checked: true, at: T0, label: "x", task: { path: "a.md", block: "nb-q" } })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const r = (parseStaged(text, 1) as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
	});
});

describe("checklist model", () => {
	it("creates an unticked checkbox centred on a point and kept inside the page", () => {
		const page = { width: 600, height: 800 };
		const c = createCheckbox(300, 400, page);
		expect(c).toMatchObject({ type: "checkbox", x: 290, y: 390, size: 20 });
		expect(c.checked).toBeUndefined();
		const corner = createCheckbox(-50, 900, page);
		expect(corner.x).toBe(0);
		expect(corner.y).toBe(780);
		expect(createCheckbox(10, 10, page, "#ff0000", 500).size).toBe(CHECKBOX_MAX_SIZE);
		expect(createCheckbox(10, 10, page, "#ff0000", 1).size).toBe(CHECKBOX_MIN_SIZE);
	});

	it("toggles and stamps the time; unticking removes the flag, not the time", () => {
		const a = toggledCheckbox(box(), T0);
		expect(a).toMatchObject({ checked: true, at: T0 });
		const b = toggledCheckbox(a, T0 + 9);
		expect(b.checked).toBeUndefined();
		expect(b.at).toBe(T0 + 9);
	});

	it("cleans the typed label to one line and the limit; empty removes it", () => {
		expect(cleanCheckboxLabel("  Buy \n  milk ")).toBe("Buy milk");
		expect(Array.from(cleanCheckboxLabel("é".repeat(500)))).toHaveLength(CHECKBOX_LABEL_MAX);
		expect(withCheckboxLabel(box({ label: "x" }), "  ").label).toBeUndefined();
	});

	it("links and unlinks without touching anything else", () => {
		const linked = withCheckboxTask(box({ checked: true }), { path: "a.md", block: "nb-1" });
		expect(linked.task).toEqual({ path: "a.md", block: "nb-1" });
		expect(linked.checked).toBe(true);
		expect(withCheckboxTask(linked, null).task).toBeUndefined();
	});

	it("a copy keeps the tick but never the link; a cleared one keeps neither", () => {
		const src = box({ checked: true, at: T0, label: "x", task: { path: "a.md", block: "nb-1" } });
		expect(copiedCheckbox(src, "n")).toMatchObject({ id: "n", checked: true, at: T0, label: "x" });
		expect(copiedCheckbox(src, "n").task).toBeUndefined();
		const cleared = clearedCheckbox(src);
		expect(cleared).toMatchObject({ id: "c1", label: "x" });
		expect(cleared.checked).toBeUndefined();
		expect(cleared.at).toBeUndefined();
		expect(cleared.task).toBeUndefined();
	});

	it("counts and lists open items in reading order", () => {
		const doc = listDoc();
		doc.pages.push({ ...createPage(), id: "p2", elements: [box({ id: "c3" }), box({ id: "c4", checked: true })] });
		expect(checklistCounts(doc.pages[0]!)).toEqual({ total: 2, open: 1, done: 1 });
		expect(checkboxesOf(doc.pages[1]!)).toHaveLength(2);
		expect(openCheckboxes(doc.pages).map((o) => [o.pageIndex, o.checkbox.id])).toEqual([[0, "c2"], [1, "c3"]]);
	});

	it("derives a block id from the element id that a note can hold", () => {
		expect(blockIdFor({ id: "6f9619ff-8b86-d011-b42d-00c04fc964ff" })).toBe("nb-6f9619ff8b86");
		expect(blockIdFor({ id: "---" })).toBe("nb-x");
	});

	it("the stacking band is the markers' (above the ink)", () => {
		expect(elementBand(box())).toBe(5);
	});

	it("is covered by the page statistics and the bounds", () => {
		const info = pageInfo(listDoc(), 0, null);
		expect(info?.elements.checkbox).toBe(2);
		expect(elementBounds(box())).toEqual({ minX: 100, minY: 100, maxX: 120, maxY: 120 });
	});
});

describe("checklist: hit, move and scale", () => {
	it("is hit inside its square and a little around it", () => {
		const els = [box()];
		expect(hitElement(els, 110, 110, 0)).toBe(els[0]);
		expect(hitElement(els, 124, 110, 6)).toBe(els[0]);
		expect(hitElement(els, 140, 110, 6)).toBeNull();
	});

	it("moves and scales as a square that never rotates, within the format's limits", () => {
		const moved = transformElement(box(), translate(30, -10)) as CheckboxElement;
		expect(moved).toMatchObject({ x: 130, y: 90, size: 20 });
		const big = transformElement(box(), scaleAbout(2, 2, 0, 0)) as CheckboxElement;
		expect(big).toMatchObject({ x: 200, y: 200, size: 40 });
		const huge = transformElement(box(), scaleAbout(100, 100, 0, 0)) as CheckboxElement;
		expect(huge.size).toBe(CHECKBOX_MAX_SIZE);
		const tiny = transformElement(box(), scaleAbout(0.01, 0.01, 0, 0)) as CheckboxElement;
		expect(tiny.size).toBe(CHECKBOX_MIN_SIZE);
		expect(moved.checked).toBeUndefined();
	});
});

describe("checklist: history", () => {
	it("adds, ticks, labels, links and removes a checkbox with undo and redo", () => {
		const doc = listDoc();
		delete doc.pages[0]!.elements;
		const history = new History(() => doc, 100, null);
		const c = createCheckbox(300, 300, doc.pages[0]!);
		expect(history.execute(new AddElement("p1", c, 0))).toBe(true);
		expect(history.execute(toggleCheckbox("p1", c.id, T0))).toBe(true);
		expect((doc.pages[0]!.elements![0] as CheckboxElement).checked).toBe(true);
		history.undo();
		expect((doc.pages[0]!.elements![0] as CheckboxElement).checked).toBeUndefined();
		history.redo();
		expect(history.execute(setCheckboxTask("p1", c.id, { path: "a.md", block: "nb-a" }))).toBe(true);
		history.undo();
		expect((doc.pages[0]!.elements![0] as CheckboxElement).task).toBeUndefined();
		history.redo();
		expect(history.execute(new RemoveElement("p1", doc.pages[0]!.elements![0]!))).toBe(true);
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
		history.undo();
		expect(doc.pages[0]!.elements).toHaveLength(1);
	});

	it("one toggle is one undo step", () => {
		const doc = listDoc();
		const history = new History(() => doc, 100, null);
		history.execute(toggleCheckbox("p1", "c2", T0));
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(history.canUndo()).toBe(false);
		expect((doc.pages[0]!.elements![1] as CheckboxElement).checked).toBeUndefined();
	});

	it("setting the state it already has changes nothing", () => {
		const doc = listDoc();
		const cmd = setCheckboxChecked("p1", "c1", true, T0 + 1);
		cmd.apply(doc);
		expect(doc.pages[0]!.elements![0]).toBe(doc.pages[0]!.elements![0]);
		expect((doc.pages[0]!.elements![0] as CheckboxElement).at).toBe(T0);
		cmd.revert(doc);
		expect((doc.pages[0]!.elements![0] as CheckboxElement).at).toBe(T0);
	});

	it("finds its target by id, so a missing checkbox is a no-op both ways", () => {
		const doc = listDoc();
		const cmd = new UpdateCheckbox("p1", "nope", (el) => ({ ...el, checked: true }));
		cmd.apply(doc);
		cmd.revert(doc);
		expect(checkboxesOf(doc.pages[0]!)).toHaveLength(2);
	});

	it("a locked page refuses a tick and keeps the checkbox as it was", () => {
		const doc = listDoc();
		const history = new History(() => doc, 100, null);
		history.execute(new SetPageLocked("p1", true));
		expect(history.execute(toggleCheckbox("p1", "c2", T0))).toBe(false);
		expect(history.execute(setCheckboxLabel("p1", "c2", "no"))).toBe(false);
		expect((doc.pages[0]!.elements![1] as CheckboxElement).checked).toBeUndefined();
		expect((doc.pages[0]!.elements![1] as CheckboxElement).label).toBeUndefined();
	});
});

describe("checklist: copies, clipboard and templates", () => {
	it("duplicating a page keeps the ticks but drops the links", () => {
		const copy = duplicatePage(listDoc().pages[0]!);
		const [a, b] = copy.elements as CheckboxElement[];
		expect(a).toMatchObject({ checked: true, label: "Buy milk" });
		expect(a!.task).toBeUndefined();
		expect(a!.id).not.toBe("c1");
		expect(b!.checked).toBeUndefined();
	});

	it("a pasted checkbox keeps its tick, gets a new id and no link", () => {
		const page = listDoc().pages[0]!;
		const clip = captureClip([], [page.elements![0]!], {})!;
		const out = instantiateClip(clip, 10, 10);
		const c = out.elements[0] as CheckboxElement;
		expect(c).toMatchObject({ type: "checkbox", checked: true, x: 110, y: 110 });
		expect(c.id).not.toBe("c1");
		expect(c.task).toBeUndefined();
	});

	it("a template made from a notebook has unticked checkboxes, without time or link", () => {
		const t = templateFromNotebook(listDoc());
		const [a] = t.pages[0]!.elements as CheckboxElement[];
		expect(a).toMatchObject({ type: "checkbox", label: "Buy milk" });
		expect(a!.checked).toBeUndefined();
		expect(a!.at).toBeUndefined();
		expect(a!.task).toBeUndefined();
		expect(serializeChecked(t).ok).toBe(true);
	});

	it("a notebook, a page and a document made from a template start unticked", () => {
		const doc = listDoc();
		const template = templateFromNotebook(doc);
		// a template edited by hand with a ticked box is cleared when it is used
		template.pages[0]!.elements![0] = freezeElement({ ...(template.pages[0]!.elements![0] as CheckboxElement), checked: true });
		const fresh = notebookFromTemplate(template);
		expect(checklistCounts(fresh.pages[0]!).done).toBe(0);
		const one = templateDocument(doc, doc.pages[0]!);
		expect(checklistCounts(one.pages[0]!).done).toBe(0);
		expect(checklistCounts(pageFromTemplate(one)!.page).done).toBe(0);
		expect(checklistCounts(documentFromTemplate(one).pages[0]!).done).toBe(0);
		expect(checkboxesOf(documentFromTemplate(one).pages[0]!).every((c) => c.task === undefined)).toBe(true);
	});

	it("clearChecklist leaves a page with nothing to clear as it is", () => {
		const page = createPage();
		expect(clearChecklist(page)).toBe(page);
		const plain: Page = { ...createPage(), elements: [box()] };
		expect(clearChecklist(plain)).toBe(plain);
	});
});

describe("checklist: merge", () => {
	function twoCopies() {
		const main = listDoc();
		const other = parsed(serialize(main)).doc;
		return { main, other };
	}

	it("a checkbox in both copies is not added twice", () => {
		const { main, other } = twoCopies();
		const plan = planMerge(main, other);
		expect(plan.command).toBeNull();
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("the later toggle wins, either way round", () => {
		const { main, other } = twoCopies();
		const m = main.pages[0]!.elements![1] as CheckboxElement;
		const o = other.pages[0]!.elements![1] as CheckboxElement;
		// both toggled c2: the copy later (ticked at T0+20), the main earlier (ticked at T0+10 -> already unticked after)
		main.pages[0]!.elements![1] = freezeElement({ ...m, checked: true, at: T0 + 10 });
		other.pages[0]!.elements![1] = freezeElement({ ...o, at: T0 + 20 });
		const history = new History(() => main, 100, null);
		const plan = planMerge(main, other);
		expect(plan.summary.checkboxesUpdated).toBe(1);
		expect(mergeChangeCount(plan.summary)).toBe(1);
		expect(history.execute(plan.command!)).toBe(true);
		const got = main.pages[0]!.elements![1] as CheckboxElement;
		expect(got.checked).toBeUndefined();
		expect(got.at).toBe(T0 + 20);
		expect(mergeCovers(main, other)).toBe(true);
		history.undo();
		expect((main.pages[0]!.elements![1] as CheckboxElement).checked).toBe(true);
	});

	it("keeps the main notebook's state when it toggled later, and on a tie", () => {
		const a = box({ checked: true, at: T0 + 5 });
		expect(mergedCheckbox(a, box({ at: T0 + 1 }))).toBeNull();
		expect(mergedCheckbox(a, box({ at: T0 + 5 }))).toBeNull();
		const later = mergedCheckbox(box(), a)!;
		expect(later).toMatchObject({ checked: true, at: T0 + 5 });
	});

	it("a label or link only the copy has is added; the main notebook's own stays", () => {
		const have = box({ label: "mine", task: { path: "a.md", block: "nb-1" } });
		expect(mergedCheckbox(have, box({ label: "theirs", task: { path: "b.md", block: "nb-2" } }))).toBeNull();
		const filled = mergedCheckbox(box(), box({ label: "theirs", task: { path: "b.md", block: "nb-2" } }))!;
		expect(filled).toMatchObject({ label: "theirs", task: { path: "b.md", block: "nb-2" } });
	});

	it("is not covered while the copy's toggle is newer than the result's", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.elements![1] = freezeElement({ ...(other.pages[0]!.elements![1] as CheckboxElement), checked: true, at: T0 + 99 });
		expect(mergeCovers(main, other)).toBe(false);
		const history = new History(() => main, 100, null);
		history.execute(planMerge(main, other).command!);
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("a checkbox only the copy has comes as it is (a page only the copy has too)", () => {
		const main = createDocument(new Date(stamp));
		main.id = "doc";
		main.pages[0]!.id = "p1";
		const other = listDoc();
		const history = new History(() => main, 100, null);
		expect(history.execute(planMerge(main, other).command!)).toBe(true);
		const page = main.pages.find((p) => p.id === "p1")!;
		expect(checkboxesOf(page)).toHaveLength(2);
		expect(checkboxesOf(page)[0]!.task).toEqual({ path: "Daily/2026-11-05.md", block: "nb-abc123" });
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("a checkbox the copy added to a common page joins it", () => {
		const main = listDoc();
		const other = parsed(serialize(main)).doc;
		other.pages[0]!.elements!.push(box({ id: "c9", x: 300, y: 300 }));
		const history = new History(() => main, 100, null);
		expect(history.execute(planMerge(main, other).command!)).toBe(true);
		expect(checkboxesOf(main.pages[0]!).map((c) => c.id)).toContain("c9");
	});
});

describe("checklist: repair", () => {
	it("keeps a checkbox of a truncated file", () => {
		const doc = stressDocument(40, 2, 3);
		doc.pages[0]!.elements = [box({ checked: true, at: T0, label: "keep me" })];
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
		expect((r.doc.pages[0]!.elements![0] as CheckboxElement).label).toBe("keep me");
		expect(parse(r.text).ok).toBe(true);
	});

	it("keeps the checkbox and drops an invalid link", () => {
		const text = serialize(listDoc()).replace('"block":"nb-abc123"', '"block":"other"');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const el = r.doc.pages[0]!.elements?.[0] as CheckboxElement | undefined;
		expect(el?.id).toBe("c1");
		expect(el?.task).toBeUndefined();
		expect(el?.checked).toBe(true);
	});

	it("a clean v17 file with checkboxes needs no repair", () => {
		expect(parse(serialize(listDoc())).ok).toBe(true);
	});
});

describe("checklist: exports and look", () => {
	it("draws an outline, and a tick when ticked", () => {
		expect(checkboxPaths(box())).toHaveLength(1);
		const paths = checkboxPaths(box({ checked: true }));
		expect(paths).toHaveLength(2);
		expect(paths[0]!.closed).toBe(true);
		expect(paths[1]!.closed).toBe(false);
		expect(paths[1]!.points).toHaveLength(3);
	});

	it("the SVG has the checkbox in its colour above the ink", () => {
		const svg = pageToSvg(listDoc().pages[0]!);
		expect(svg).toContain('stroke="#1f2430"');
		expect(svg.lastIndexOf("stroke-linejoin")).toBeGreaterThan(svg.indexOf("<path"));
	});

	it("the PDF has the outline and the tick", () => {
		const text = new TextDecoder("latin1").decode(pagesToPdf(listDoc().pages));
		// one colour operator per checkbox (two on the page); the ticked one strokes two paths with it
		expect(text.split("0.122 0.141 0.188 RG 1 J 1 j").length).toBe(3);
		expect(text).toMatch(/ h S/);
	});

	it("the Markdown export lists labelled checkboxes as task items", () => {
		expect(pageTexts(listDoc().pages[0]!)).toEqual(["- [x] Buy milk"]);
	});
});

describe("checklist: the handwritten label", () => {
	const cb = box({ id: "a", x: 100, y: 100, size: 20 });

	it("is the ink on the same line to the right, up to a gap", () => {
		const strokes = [stroke("w1", 128, 102), stroke("w2", 165, 104), stroke("w3", 400, 104), stroke("below", 128, 160)];
		expect(checkboxLabelInk(cb, strokes).map((s) => s.id)).toEqual(["w1", "w2"]);
	});

	it("does not take ink to the left, above or below, or a tall scribble", () => {
		const strokes = [stroke("left", 40, 102), stroke("above", 128, 40), stroke("tall", 128, 80, 20, 120)];
		expect(checkboxLabelInk(cb, strokes)).toEqual([]);
	});

	it("skips invisible ink", () => {
		const hidden = { ...stroke("h", 128, 102), hidden: true as const };
		expect(checkboxLabelInk(cb, [hidden])).toEqual([]);
	});

	it("stops before the next checkbox on the same row", () => {
		const other = box({ id: "b", x: 200, y: 100 });
		const strokes = [stroke("w1", 128, 102), stroke("w2", 170, 104), stroke("mine", 230, 104)];
		expect(checkboxLabelInk(cb, strokes, [cb, other]).map((s) => s.id)).toEqual(["w1", "w2"]);
		expect(checkboxLabelInk(other, strokes, [cb, other]).map((s) => s.id)).toEqual(["mine"]);
	});

	it("ink of each row belongs to its own checkbox", () => {
		const second = box({ id: "b", x: 100, y: 140 });
		const strokes = [stroke("r1", 128, 102), stroke("r2", 128, 142)];
		expect(checkboxLabelInk(cb, strokes, [cb, second]).map((s) => s.id)).toEqual(["r1"]);
		expect(checkboxLabelInk(second, strokes, [cb, second]).map((s) => s.id)).toEqual(["r2"]);
	});

	it("the crop is the box and its label together", () => {
		const b = checkboxLabelBounds(cb, [stroke("w1", 128, 102, 60, 10)]);
		expect(b.minX).toBeLessThanOrEqual(100);
		expect(b.maxX).toBeGreaterThanOrEqual(188);
		expect(checkboxLabelBounds(cb, [])).toEqual({ minX: 100, minY: 100, maxX: 120, maxY: 120 });
	});
});

describe("checklist: the drawn square", () => {
	const square = (side: number, x = 50, y = 50) => rectPoints([x, y], [x + side, y + side]);

	it("a small square becomes a checkbox of about its size, centred on it", () => {
		const found = checkboxFromStroke(square(20));
		expect(found).not.toBeNull();
		expect(found!.size).toBeGreaterThan(18);
		expect(found!.size).toBeLessThan(22);
		expect(found!.x + found!.size / 2).toBeCloseTo(60, 0);
		expect(found!.y + found!.size / 2).toBeCloseTo(60, 0);
	});

	it("rejects squares that are too small or too large", () => {
		expect(checkboxFromStroke(square(5))).toBeNull();
		expect(checkboxFromStroke(square(80))).toBeNull();
	});

	it("rejects rectangles, circles, lines and a handful of points", () => {
		expect(checkboxFromStroke(rectPoints([0, 0], [40, 14]))).toBeNull();
		expect(checkboxFromStroke(ellipsePoints([50, 50], 10, 10))).toBeNull();
		expect(checkboxFromStroke([[0, 0, 0.5], [30, 0, 0.5], [60, 0, 0.5], [90, 0, 0.5], [120, 0, 0.5], [150, 0, 0.5], [180, 0, 0.5], [210, 0, 0.5]])).toBeNull();
		expect(checkboxFromStroke([[0, 0, 0.5], [10, 0, 0.5]])).toBeNull();
	});

	it("rejects a diamond (a square turned too far)", () => {
		const d = 12;
		const points = [[50, 50 - d], [50 + d, 50], [50, 50 + d], [50 - d, 50], [50, 50 - d]].flatMap((p, i, a) => {
			const q = a[i + 1];
			if (!q) return [] as Array<[number, number, number]>;
			return [0, 0.25, 0.5, 0.75].map((k): [number, number, number] => [p![0]! + (q[0]! - p![0]!) * k, p![1]! + (q[1]! - p![1]!) * k, 0.5]);
		});
		expect(checkboxFromStroke(points)).toBeNull();
	});
});

describe("the task line of a note", () => {
	const note = ["# Tasks", "- [ ] Buy milk ^nb-abc", "- [ ] Other ^nb-abcd", "plain ^nb-abc", "- [x] Done ^nb-zzz", ""].join("\n");

	it("ticks only the line that ends with the block id", () => {
		const r = setTaskLineChecked(note, "nb-abc", true);
		expect(r).toMatchObject({ found: true, changed: true });
		expect(r.text.split("\n")).toEqual(["# Tasks", "- [x] Buy milk ^nb-abc", "- [ ] Other ^nb-abcd", "plain ^nb-abc", "- [x] Done ^nb-zzz", ""]);
	});

	it("unticks and leaves every other byte alone, line endings included", () => {
		const crlf = "intro\r\n- [x] Buy milk ^nb-abc\r\nend\r\n";
		const r = setTaskLineChecked(crlf, "nb-abc", false);
		expect(r.text).toBe("intro\r\n- [ ] Buy milk ^nb-abc\r\nend\r\n");
	});

	it("says when the line is gone and changes nothing", () => {
		const r = setTaskLineChecked(note, "nb-missing", true);
		expect(r).toEqual({ text: note, found: false, changed: false });
	});

	it("does nothing when the line is already in that state", () => {
		expect(setTaskLineChecked(note, "nb-zzz", true)).toEqual({ text: note, found: true, changed: false });
		expect(setTaskLineChecked(note, "nb-abc", false)).toEqual({ text: note, found: true, changed: false });
	});

	it("leaves a custom status alone when ticking and only turns x into a space when unticking", () => {
		const text = "- [/] half ^nb-a\n- [X] big ^nb-b\n- [-] gone ^nb-c\n";
		expect(setTaskLineChecked(text, "nb-a", true).changed).toBe(false);
		expect(setTaskLineChecked(text, "nb-b", false).text).toBe("- [/] half ^nb-a\n- [ ] big ^nb-b\n- [-] gone ^nb-c\n");
		expect(setTaskLineChecked(text, "nb-c", false).changed).toBe(false);
	});

	it("never touches a block id of someone else's or a line that is not a task", () => {
		expect(setTaskLineChecked("- [ ] mine ^other", "other", true).found).toBe(false);
		expect(setTaskLineChecked("a paragraph ^nb-p", "nb-p", true)).toEqual({ text: "a paragraph ^nb-p", found: false, changed: false });
	});

	it("handles indented and numbered tasks", () => {
		expect(setTaskLineChecked("  - [ ] sub ^nb-i", "nb-i", true).text).toBe("  - [x] sub ^nb-i");
		expect(setTaskLineChecked("1. [ ] one ^nb-n", "nb-n", true).text).toBe("1. [x] one ^nb-n");
	});
});
