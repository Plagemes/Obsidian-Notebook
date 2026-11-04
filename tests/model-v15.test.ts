/**
 * Format v15: sticky notes (#20) — the element type "sticky", the v14 -> v15 migration, lenient read and strict write, staged
 * loading, the note's own list of hidden strokes, ownership of ink, moving and scaling, copies, merge, repair, exports.
 */
import { describe, expect, it } from "vitest";
import { attachedInk, inkOwner, linkedInkIds, pinnedInk } from "../src/ink/attach";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { pageToSvg } from "../src/ink/export-svg";
import { instantiateClip } from "../src/ink/clipboard";
import { pagesToPdf } from "../src/ink/export-pdf";
import { inkOwnership } from "../src/ink/selection-transform";
import { stickyShapes, stickyTextBox } from "../src/ink/sticky-render";
import { scaleAbout, translate } from "../src/ink/transform";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddElement, History, RemoveElement, ReplaceElement } from "../src/model/history";
import { planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { pageTexts } from "../src/model/export-markdown";
import { SetPageLocked } from "../src/model/page-lock";
import { repairNotebookText } from "../src/model/repair";
import { freezeElement, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import {
	cleanStickyText, createSticky, editedSticky, hiddenStickyInk, liveInk, remapStickyInk, STICKY_ICON, STICKY_MAX_SIZE, STICKY_MIN_SIZE, STICKY_TEXT_MAX,
	stickyBounds, toggledSticky,
} from "../src/model/sticky";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type PageElement, type StickyElement, type Stroke } from "../src/model/types";
import { elementBand } from "../src/model/layers";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-05T10:00:00.000Z";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x = 10, y = 10): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 20, y, 0.5], [x + 20, y + 10, 0.5]]), id });
}

function note(over: Partial<StickyElement> = {}): StickyElement {
	return freezeElement({ id: "n1", type: "sticky", x: 100, y: 100, width: 150, height: 150, color: "#F59E0B", fontSize: 14, ...over });
}

/** A document with a note on its first page and ink written on it (s1, s2), and ink off it (s3). */
function noteDoc(over: Partial<StickyElement> = {}): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.elements = [note(over)];
	page.strokes.push(stroke("s1", 110, 120), stroke("s2", 120, 160), stroke("s3", 400, 400));
	return doc;
}

function v14Raw(): Raw {
	return {
		format: FORMAT_ID, version: 14, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [
				{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] },
				{ id: "s2", tool: "pen", color: "#111111", width: 2, render: 1, points: [[5, 6, 0.5], [7, 8, 0.5]] },
			],
		}],
	};
}

const stickyRaw = (over: Raw = {}): Raw => ({ id: "n1", type: "sticky", x: 10, y: 20, width: 150, height: 150, color: "#F59E0B", fontSize: 14, ...over });

describe("format v15: migration", () => {
	it("is at version 15 with a v14 step", () => {
		expect(CURRENT_VERSION).toBe(15);
		expect(MIGRATIONS[14]).toBeTypeOf("function");
	});

	it("reads a v14 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v14Raw()));
		expect(r.migratedFrom).toBe(14);
		expect(r.doc.version).toBe(15);
		expect(r.doc.pages[0]!.elements).toBeUndefined();
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(r.dropped).toBeUndefined();
	});

	it("keeps a v14 file's locked page and other elements as they were", () => {
		const raw = v14Raw();
		setAt(raw, ["pages", 0, "locked"], true);
		setAt(raw, ["pages", 0, "elements"], [{ id: "t1", type: "text", x: 5, y: 5, width: 100, text: "hi", fontSize: 12, color: "#000000" }]);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.locked).toBe(true);
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
	});

	it("refuses a sticky note in a v14 file: no version of this plugin wrote one", () => {
		const raw = v14Raw();
		setAt(raw, ["pages", 0, "elements"], [stickyRaw()]);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toMatch(/sticky/);
		}
	});

	it("migrates a v14 round trip: v14 text -> v15 document -> text has no notes and the same ink", () => {
		const text = serialize(parsed(JSON.stringify(v14Raw())).doc);
		expect(text).toContain('"version": 15');
		expect(text).not.toContain('"sticky"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(2);
	});

	it("is refused by 0.16 and older as a newer format (they read up to v14, so v15 opens read-only and is never overwritten)", () => {
		const text = serialize(noteDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		expect(serialize(noteDoc())).toContain('"version": 15');
	});
});

describe("format v15: write and read", () => {
	it("round-trips a note on one line, byte for byte", () => {
		const doc = noteDoc({ text: "Buy milk\nand eggs" });
		const text = serialize(doc);
		expect(text).toContain('"type":"sticky"');
		expect(text.split('"type":"sticky"').length).toBe(2);
		const back = parsed(text).doc;
		const el = back.pages[0]!.elements![0] as StickyElement;
		expect(el).toMatchObject({ id: "n1", x: 100, y: 100, width: 150, height: 150, color: "#F59E0B", fontSize: 14, text: "Buy milk\nand eggs" });
		expect(el.collapsed).toBeUndefined();
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
	});

	it("writes the collapsed flag and the list of hidden strokes only for a collapsed note", () => {
		const doc = noteDoc({ collapsed: true, ink: ["s1", "s2"] });
		const text = serialize(doc);
		expect(text).toContain('"collapsed":true,"ink":["s1","s2"]');
		const back = parsed(text).doc;
		const el = back.pages[0]!.elements![0] as StickyElement;
		expect(el.collapsed).toBe(true);
		expect(el.ink).toEqual(["s1", "s2"]);
		expect(serialize(back)).toBe(text);
		// An open note never writes a list, even one that was left on the object.
		expect(serialize(noteDoc({ ink: ["s1"] }))).not.toContain('"ink"');
	});

	it("drops ids of strokes that are gone when it reads, and the list when none is left", () => {
		const doc = noteDoc({ collapsed: true, ink: ["s1", "gone"] });
		expect((parsed(serialize(doc)).doc.pages[0]!.elements![0] as StickyElement).ink).toEqual(["s1"]);
		const none = noteDoc({ collapsed: true, ink: ["gone"] });
		expect((parsed(serialize(none)).doc.pages[0]!.elements![0] as StickyElement).ink).toBeUndefined();
	});

	it("reads a bad frame, colour or size strictly as an invalid note and leniently as a dropped detail", () => {
		for (const bad of [{ width: 5 }, { width: STICKY_MAX_SIZE + 1 }, { height: -3 }, { color: "yellow" }, { fontSize: 0 }, { fontSize: 500 }, { x: "1" }]) {
			const raw = JSON.parse(serialize(noteDoc())) as Raw;
			setAt(raw, ["pages", 0, "elements", 0], stickyRaw(bad));
			expect(() => validate(raw), JSON.stringify(bad)).toThrow();
			const r = parsed(JSON.stringify(raw));
			expect(r.doc.pages[0]!.elements, JSON.stringify(bad)).toBeUndefined();
			expect(r.dropped).toBe(1);
			expect(r.doc.pages[0]!.strokes).toHaveLength(3);
		}
	});

	it("keeps a note whose text, flag or list is invalid, dropping only that detail", () => {
		const raw = JSON.parse(serialize(noteDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 0], stickyRaw({ text: 5, collapsed: "yes" }));
		const r = parsed(JSON.stringify(raw));
		const el = r.doc.pages[0]!.elements![0] as StickyElement;
		expect(el.text).toBeUndefined();
		expect(el.collapsed).toBeUndefined();
		expect(r.dropped).toBe(2);
		setAt(raw, ["pages", 0, "elements", 0], stickyRaw({ collapsed: true, ink: "s1" }));
		const r2 = parsed(JSON.stringify(raw));
		expect((r2.doc.pages[0]!.elements![0] as StickyElement).collapsed).toBe(true);
		expect((r2.doc.pages[0]!.elements![0] as StickyElement).ink).toBeUndefined();
		expect(r2.dropped).toBe(1);
	});

	it("refuses text longer than the limit when strict, and counts it when lenient", () => {
		const raw = JSON.parse(serialize(noteDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 0], stickyRaw({ text: "x".repeat(STICKY_TEXT_MAX + 1) }));
		expect(() => validate(raw)).toThrow(/characters/);
		expect(parsed(JSON.stringify(raw)).dropped).toBe(1);
	});

	it("shares the element id space: a note with the id of a stroke is refused", () => {
		const raw = JSON.parse(serialize(noteDoc())) as Raw;
		setAt(raw, ["pages", 0, "elements", 0, "id"], "s1");
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
	});

	it("a note does not change the bytes of the rest of the page", () => {
		const a = noteDoc();
		const b = noteDoc();
		delete b.pages[0]!.elements;
		const lines = serialize(a).split("\n").filter((l) => !l.includes('"type":"sticky"'));
		const withoutBlock = lines.join("\n").replace('\t\t\t"elements": [\n\t\t\t],\n', "");
		expect(withoutBlock).toBe(serialize(b));
	});

	it("the history guard accepts a note and its edits", () => {
		const doc = noteDoc();
		const history = new History(() => doc, 100, null);
		const el = doc.pages[0]!.elements![0] as StickyElement;
		expect(history.execute(new ReplaceElement("p1", el, editedSticky(el, { text: "x", color: "#2F80F7" })))).toBe(true);
		expect(parsed(serialize(doc)).doc.pages[0]!.elements).toHaveLength(1);
	});
});

describe("format v15: staged loading", () => {
	it("stages a large v14 file and checks each page for notes as it is read", () => {
		const doc = stressDocument(6000, 3, 7);
		const v14 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 14`);
		expect(v14.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v14, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(14);
			expect(r.doc.version).toBe(CURRENT_VERSION);
		}
	});

	it("refuses a large v14 file that holds a note, on the page that holds it", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[2]!.elements = [note()];
		const v14 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 14`);
		const staged = parseStaged(v14, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(false);
	});

	it("stages a large v15 file with a note and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.elements = [note({ text: "hello", collapsed: true })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const r = (parseStaged(text, 1) as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
	});
});

describe("sticky notes: model helpers", () => {
	it("creates a note centred on a point and kept inside the page", () => {
		const page = { width: 600, height: 800 };
		const mid = createSticky(300, 400, page);
		expect(mid).toMatchObject({ type: "sticky", x: 225, y: 325, width: 150, height: 150 });
		const corner = createSticky(2, 2, page);
		expect(corner.x).toBe(0);
		expect(corner.y).toBe(0);
		const far = createSticky(700, 900, page);
		expect(far.x + far.width).toBeLessThanOrEqual(600);
		expect(far.y + far.height).toBeLessThanOrEqual(800);
		const tiny = createSticky(10, 10, { width: 100, height: 100 });
		expect(tiny.width).toBeLessThanOrEqual(100);
		expect(tiny.width).toBeGreaterThanOrEqual(STICKY_MIN_SIZE);
	});

	it("cleans typed text: line breaks, trailing space, the length limit", () => {
		expect(cleanStickyText("a  \r\nb\t\n\n")).toBe("a\nb");
		expect(cleanStickyText("")).toBe("");
		expect(Array.from(cleanStickyText("é".repeat(STICKY_TEXT_MAX + 50)))).toHaveLength(STICKY_TEXT_MAX);
	});

	it("edits text, colour and size; empty text removes the field", () => {
		const n = note({ text: "old" });
		expect(editedSticky(n, { text: "new" }).text).toBe("new");
		expect("text" in editedSticky(n, { text: "  \n " })).toBe(false);
		expect(editedSticky(n, { color: "#2F80F7" }).color).toBe("#2F80F7");
		expect(editedSticky(n, { fontSize: 1000 }).fontSize).toBe(72);
		expect(editedSticky(n, { fontSize: 1 }).fontSize).toBe(5);
		expect(n.text).toBe("old");
	});

	it("collapses over a list of strokes and opens again without a trace of it", () => {
		const n = note();
		const closed = toggledSticky(n, ["s1", "s2"]);
		expect(closed).toMatchObject({ collapsed: true, ink: ["s1", "s2"] });
		const open = toggledSticky(closed, []);
		expect(open.collapsed).toBeUndefined();
		expect("ink" in open).toBe(false);
		expect(toggledSticky(n, []).ink).toBeUndefined();
	});

	it("bounds: the box, or the icon when collapsed", () => {
		expect(stickyBounds(note())).toEqual({ minX: 100, minY: 100, maxX: 250, maxY: 250 });
		expect(stickyBounds(note({ collapsed: true }))).toEqual({ minX: 100, minY: 100, maxX: 100 + STICKY_ICON, maxY: 100 + STICKY_ICON });
		expect(elementBounds(note({ collapsed: true }))).toEqual(stickyBounds(note({ collapsed: true })));
	});

	it("lists the ink a collapsed note keeps hidden, and only that of collapsed notes", () => {
		const doc = noteDoc({ collapsed: true, ink: ["s1", "s2"] });
		const page = doc.pages[0]!;
		expect([...hiddenStickyInk(page.elements)!]).toEqual(["s1", "s2"]);
		expect(hiddenStickyInk(noteDoc().pages[0]!.elements)).toBeNull();
		expect(hiddenStickyInk(undefined)).toBeNull();
		expect(liveInk(page.elements![0] as StickyElement, page.strokes)).toEqual(["s1", "s2"]);
		expect(liveInk(note({ collapsed: true, ink: ["s1", "zz"] }), page.strokes)).toEqual(["s1"]);
	});

	it("the note's stacking band sits between boxes and equations", () => {
		const eq = { id: "e", type: "equation" } as unknown as PageElement;
		const box = { id: "b", type: "box" } as unknown as PageElement;
		expect(elementBand(note())).toBeGreaterThan(elementBand(box));
		expect(elementBand(note())).toBeLessThan(elementBand(eq));
	});
});

describe("sticky notes: ink belongs to the note", () => {
	it("ink written on the note is owned by it; ink beside it is not", () => {
		const page = noteDoc().pages[0]!;
		const [n] = page.elements!;
		expect(inkOwner(page.strokes[0]!, page.elements!)).toBe(n);
		expect(inkOwner(page.strokes[1]!, page.elements!)).toBe(n);
		expect(inkOwner(page.strokes[2]!, page.elements!)).toBeNull();
		expect(attachedInk(page.strokes, page.elements!, [n!]).map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("moving and scaling the note moves and scales the same ink", () => {
		const page = noteDoc().pages[0]!;
		const [n] = page.elements!;
		const moved = transformElement(n!, translate(30, 40)) as StickyElement;
		expect(moved).toMatchObject({ x: 130, y: 140, width: 150, height: 150 });
		const grown = transformElement(n!, scaleAbout(2, 2, 100, 100)) as StickyElement;
		expect(grown).toMatchObject({ x: 100, y: 100, width: 300, height: 300, fontSize: 28 });
		const ownership = inkOwnership(page, [], [n!]);
		expect(ownership.followers.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("a note never gets smaller or larger than the format allows, and its text stays readable", () => {
		const n = note();
		const small = transformElement(n, scaleAbout(0.01, 0.01, 100, 100)) as StickyElement;
		expect(small.width).toBe(STICKY_MIN_SIZE);
		expect(small.fontSize).toBeGreaterThanOrEqual(5);
		const huge = transformElement(n, scaleAbout(50, 50, 100, 100)) as StickyElement;
		expect(huge.width).toBe(STICKY_MAX_SIZE);
		expect(huge.fontSize).toBeLessThanOrEqual(72);
		expect(validate(JSON.parse(serialize(Object.assign(noteDoc(), {})))).pages[0]!.elements).toHaveLength(1);
	});

	it("a collapsed note owns exactly the strokes in its list, wherever they lie, and no longer the ones under its place", () => {
		const doc = noteDoc({ collapsed: true, ink: ["s1"] });
		const page = doc.pages[0]!;
		const [n] = page.elements!;
		expect(linkedInkIds(n!)?.has("s1")).toBe(true);
		expect(linkedInkIds(note())).toBeNull();
		// s1 is hidden and owned; s2 (written there afterwards) is neither.
		expect(inkOwner(page.strokes[0]!, page.elements!)).toBe(n);
		expect(inkOwner(page.strokes[1]!, page.elements!)).toBeNull();
		expect(attachedInk(page.strokes, page.elements!, [n!]).map((s) => s.id)).toEqual(["s1"]);
		expect(pinnedInk(page.strokes, page.elements!).map((s) => s.id)).toEqual(["s1"]);
		// It follows the icon when the setting "Ink follows objects" is off too.
		expect(inkOwnership(page, [], [n!], undefined, false).followers.map((s) => s.id)).toEqual(["s1"]);
		// An open note's ink follows only with the setting on.
		const open = noteDoc().pages[0]!;
		expect(inkOwnership(open, [], [open.elements![0]!], undefined, false).followers).toEqual([]);
		expect(inkOwnership(open, [], [open.elements![0]!], undefined, true).followers).toHaveLength(2);
	});

	it("the collapsed icon is hit where it is drawn, not over the empty place of the note", () => {
		const n = note({ collapsed: true });
		expect(hitElement([n], 105, 105, 0)).toBe(n);
		expect(hitElement([n], 200, 200, 0)).toBeNull();
		expect(hitElement([note()], 200, 200, 0)).not.toBeNull();
	});

	it("copies a collapsed note with its hidden strokes under their new ids", () => {
		const doc = noteDoc({ collapsed: true, ink: ["s1", "s2"] });
		const page = doc.pages[0]!;
		const clip = { strokes: [page.strokes[0]!], elements: [page.elements![0]!], assets: [], bounds: { minX: 100, minY: 100, maxX: 250, maxY: 250 } };
		const made = instantiateClip(clip, 20, 20);
		const copy = made.elements[0] as StickyElement;
		expect(copy.id).not.toBe("n1");
		expect(copy.x).toBe(120);
		// Only the stroke that came along is named, under its new id.
		expect(copy.ink).toEqual([made.strokes[0]!.id]);
		expect(made.strokes[0]!.id).not.toBe("s1");
		expect(remapStickyInk(note({ collapsed: true, ink: ["a"] }), new Map()).ink).toBeUndefined();
	});
});

describe("sticky notes: history", () => {
	it("adds, edits, collapses and removes a note with undo and redo", () => {
		const doc = noteDoc();
		delete doc.pages[0]!.elements;
		const history = new History(() => doc, 100, null);
		const n = createSticky(300, 300, doc.pages[0]!);
		expect(history.execute(new AddElement("p1", n, 0))).toBe(true);
		expect(doc.pages[0]!.elements).toHaveLength(1);
		const closed = toggledSticky(n, ["s1"]);
		expect(history.execute(new ReplaceElement("p1", n, closed))).toBe(true);
		expect((doc.pages[0]!.elements![0] as StickyElement).collapsed).toBe(true);
		history.undo();
		expect((doc.pages[0]!.elements![0] as StickyElement).collapsed).toBeUndefined();
		history.redo();
		expect(history.execute(new RemoveElement("p1", closed))).toBe(true);
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
		history.undo();
		expect(doc.pages[0]!.elements).toHaveLength(1);
	});

	it("a locked page refuses every note edit and keeps the note as it was", () => {
		const doc = noteDoc();
		const history = new History(() => doc, 100, null);
		history.execute(new SetPageLocked("p1", true));
		const n = doc.pages[0]!.elements![0] as StickyElement;
		expect(history.execute(new ReplaceElement("p1", n, editedSticky(n, { text: "no" })))).toBe(false);
		expect(history.execute(new AddElement("p1", createSticky(50, 50, doc.pages[0]!), 1))).toBe(false);
		expect(history.execute(new RemoveElement("p1", n))).toBe(false);
		expect(doc.pages[0]!.elements).toHaveLength(1);
		expect((doc.pages[0]!.elements![0] as StickyElement).text).toBeUndefined();
	});
});

describe("sticky notes: merge", () => {
	it("brings a note of the copy, with its hidden strokes under the ids they have in the main notebook", () => {
		const main = createDocument(new Date(stamp));
		main.id = "doc";
		main.pages[0]!.id = "p1";
		const other = noteDoc({ collapsed: true, ink: ["s1", "s2"] });
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		const history = new History(() => main, 100, null);
		expect(history.execute(plan.command!)).toBe(true);
		const page = main.pages.find((p) => p.id === "p1")!;
		const el = page.elements!.find((e) => e.type === "sticky") as StickyElement;
		expect(el.collapsed).toBe(true);
		expect(el.ink!.every((id) => page.strokes.some((s) => s.id === id))).toBe(true);
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("the same note in both copies is not added twice, even when its hidden strokes have other ids", () => {
		const main = noteDoc({ collapsed: true, ink: ["s1"] });
		const other = parsed(serialize(main)).doc;
		const plan = planMerge(main, other);
		expect(plan.command).toBeNull();
	});
});

describe("sticky notes: repair", () => {
	it("keeps a note of a truncated file", () => {
		const doc = stressDocument(40, 2, 3);
		doc.pages[0]!.elements = [note({ text: "keep me" })];
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
		expect((r.doc.pages[0]!.elements![0] as StickyElement).text).toBe("keep me");
		expect(parse(r.text).ok).toBe(true);
	});

	it("keeps the note and drops an invalid text", () => {
		const text = serialize(noteDoc({ text: "ok" })).replace('"text":"ok"', '"text":7');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const el = r.doc.pages[0]!.elements?.[0] as StickyElement | undefined;
		expect(el?.id).toBe("n1");
		expect(el?.text).toBeUndefined();
	});

	it("a clean v15 file with notes needs no repair", () => {
		const r = repairNotebookText(serialize(noteDoc({ text: "x", collapsed: true, ink: ["s1"] })));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});

	it("repairs an older file: the version is current in the result", () => {
		const r = repairNotebookText(JSON.stringify(v14Raw()));
		expect(r.ok).toBe(true);
		if (r.ok) expect(getAt(JSON.parse(r.text), ["version"])).toBe(15);
	});
});

describe("sticky notes: exports and look", () => {
	it("draws the same shapes everywhere: shadow, paper, band, folded corner (an icon has two lines of writing)", () => {
		const open = stickyShapes(note());
		expect(open).toHaveLength(4);
		expect(open[0]!.alpha).toBeLessThan(1);
		expect(open.slice(1).every((s) => s.alpha === 1)).toBe(true);
		const icon = stickyShapes(note({ collapsed: true }));
		expect(icon).toHaveLength(6);
		for (const s of icon) {
			if (s.kind === "rect") expect(s.x + s.width).toBeLessThanOrEqual(100 + STICKY_ICON + 1);
		}
		expect(stickyShapes(note(), true)[1]).not.toEqual(stickyShapes(note(), false)[1]);
	});

	it("keeps the typed text inside the note", () => {
		const box = stickyTextBox(note());
		expect(box.x).toBeGreaterThan(100);
		expect(box.x + box.width).toBeLessThan(250);
		expect(box.y + box.height).toBeLessThan(250);
		const tiny = stickyTextBox(note({ width: STICKY_MIN_SIZE, height: STICKY_MIN_SIZE }));
		expect(tiny.width).toBeGreaterThan(0);
		expect(tiny.height).toBeGreaterThan(0);
	});

	it("the SVG has the note and its text, and leaves out the ink a collapsed note keeps", () => {
		const open = pageToSvg(noteDoc({ text: "Buy <milk>" }).pages[0]!);
		expect(open).toContain("<polygon");
		expect(open).toContain("Buy &lt;milk&gt;");
		expect(open).toContain("nb-sticky-n1");
		const strokesOpen = (open.match(/<path d="M[^"]*" fill="#111111"/g) ?? []).length;
		expect(strokesOpen).toBe(3);
		const closed = pageToSvg(noteDoc({ text: "Buy milk", collapsed: true, ink: ["s1", "s2"] }).pages[0]!);
		expect(closed).not.toContain("Buy milk");
		expect((closed.match(/<path d="M[^"]*" fill="#111111"/g) ?? []).length).toBe(1);
	});

	it("the PDF has the note, its text and the ink; a collapsed note hides its ink", () => {
		const open = new TextDecoder("latin1").decode(pagesToPdf(noteDoc({ text: "Buy milk" }).pages));
		expect(open).toContain("(Buy milk) Tj");
		const closed = pagesToPdf(noteDoc({ text: "Buy milk", collapsed: true, ink: ["s1", "s2"] }).pages);
		expect(new TextDecoder("latin1").decode(closed)).not.toContain("(Buy milk) Tj");
		expect(closed.length).toBeLessThan(pagesToPdf(noteDoc({ text: "Buy milk" }).pages).length);
	});

	it("the Markdown export has the typed text of a note as a quote, in reading order", () => {
		const page = createPage();
		page.elements = [
			note({ id: "b", y: 300, text: "second\nline [x]" }),
			note({ id: "a", y: 100, text: "first" }),
			note({ id: "c", y: 400 }),
		];
		expect(pageTexts(page)).toEqual(["> first", "> second\n> line \\[x\\]"]);
	});
});

describe("page-info and thumbnails count notes", () => {
	it("is covered by the page statistics type (compile-time) and the page signature", async () => {
		const { pageSignature } = await import("../src/view/view-helpers");
		const doc = noteDoc();
		const a = pageSignature(doc.pages[0]!);
		const closed = noteDoc({ collapsed: true, ink: ["s1"] });
		expect(pageSignature(closed.pages[0]!)).not.toBe(a);
		expect(pageSignature(noteDoc({ text: "x" }).pages[0]!)).not.toBe(a);
	});
});
