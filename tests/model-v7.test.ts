/**
 * Format v7: bookmark details, page tags, the shared reading position and the new paper kinds; the v6 -> v7
 * migration; and every path that copies pages or metadata (clone, history, library patch, duplicate, page
 * restore, conflicted-copy merge, repair, companion) keeping the new fields.
 */
import { describe, expect, it } from "vitest";
import { patchNotebookMeta } from "../src/library/host-logic";
import {
	bookmarkColor, categoriesInUse, outlineEntries, patchBookmark, removeBookmark, setBookmark,
} from "../src/model/bookmarks";
import { companionContent } from "../src/model/companion-content";
import { cloneMeta, createDocument, createPage } from "../src/model/document";
import { History, SetMeta } from "../src/model/history";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { planPageRestore } from "../src/model/page-restore";
import { normalizePageTags, pageHasTag, pageTagCounts, parsePageTagInput, SetPageTags } from "../src/model/page-tags";
import { duplicatePage } from "../src/model/pages";
import { chooseStart, positionAt, resolvePosition, updatePosition } from "../src/model/position";
import { repairNotebookText } from "../src/model/repair";
import { FULL_CHECK_LIMIT, parse, serialize, serializeChecked } from "../src/model/serialize";
import { CURRENT_VERSION, DEFAULT_META, FORMAT_ID, PAPER_KINDS, PAPER_KINDS_V7, PAPER_SPACING, type NotebookDocument } from "../src/model/types";
import { mergeMeta as viewMergeMeta, metaEquals, toggleBookmark } from "../src/view/view-helpers";
import { line } from "./helpers";

const stamp = "2026-10-29T10:00:00.000Z";
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function v6Doc(): Raw {
	return {
		format: FORMAT_ID, version: 6, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: ["a"], favorite: false, cover: "#3b82f6", bookmarks: ["p1"] },
		assets: {},
		pages: [
			{ id: "p1", width: 600, height: 800, paper: { kind: "ruled", spacing: 22.68 }, strokes: [{ id: "s1", tool: "pen", color: "#112233", width: 2, render: 1, points: [[10, 20, 0.5]] }] },
			{ id: "p2", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [] },
		],
	};
}

/** Two pages; p1 bookmarked with details and tagged; position on p2. */
function richDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.tags = ["exam", "chapter 2"];
	p1.strokes.push(line(10, 10, 100, 100));
	const p2 = createPage();
	p2.id = "p2";
	p2.paper = { kind: "cornell", spacing: PAPER_SPACING.cornell };
	doc.pages.push(p2);
	doc.meta = setBookmark(cloneMeta(DEFAULT_META), "p1", { title: "Intro", color: "#ef4444", category: "important" });
	doc.position = { page: "p2", y: 120.5, at: "2026-10-29T11:00:00.000Z" };
	return doc;
}

describe("format v7", () => {
	it("is at version 7 with a v6 step", () => {
		expect(CURRENT_VERSION).toBe(7);
		expect(MIGRATIONS[6]).toBeTypeOf("function");
	});

	it("migrates a v6 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v6Doc()));
		expect(r.migratedFrom).toBe(6);
		expect(r.doc.version).toBe(7);
		expect(r.doc.position).toBeUndefined();
		expect(r.doc.meta?.bookmarks).toEqual(["p1"]);
		expect(r.doc.meta?.bookmarkInfo).toBeUndefined();
		expect(r.doc.pages.map((p) => p.tags)).toEqual([undefined, undefined]);
		const text = serialize(r.doc);
		expect(parsed(text).migratedFrom).toBeNull();
		expect(serialize(parsed(text).doc)).toBe(text);
	});

	it("drops v7 keys found in a v6 file (a v6 reader ignored them)", () => {
		const raw = v6Doc();
		raw.position = { page: "p1", at: stamp };
		raw.meta.bookmarkInfo = { p1: { title: "x" } };
		raw.pages[0].tags = ["t"];
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.position).toBeUndefined();
		expect(r.doc.meta?.bookmarkInfo).toBeUndefined();
		expect(r.doc.pages[0]!.tags).toBeUndefined();
	});

	it.each(PAPER_KINDS_V7)("rejects a v6 file that uses the v7 paper %s", (kind) => {
		const raw = v6Doc();
		raw.pages[1].paper = { kind, spacing: 10 };
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
	});

	it.each(PAPER_KINDS)("round-trips paper kind %s with its default spacing", (kind) => {
		const doc = createDocument(new Date(stamp), undefined, { kind, spacing: PAPER_SPACING[kind] });
		const text = serialize(doc);
		const back = parsed(text).doc;
		expect(back.pages[0]!.paper).toEqual({ kind, spacing: PAPER_SPACING[kind] });
		expect(serialize(back)).toBe(text);
	});

	it("serializes the new fields deterministically, in a fixed place", () => {
		const doc = richDoc();
		const text = serialize(doc);
		const lines = text.split("\n");
		const meta = lines.findIndex((l) => l.startsWith('\t"meta": '));
		expect(lines[meta]).toBe('\t"meta": {"tags":[],"favorite":false,"cover":"#3b82f6","bookmarks":["p1"],"bookmarkInfo":{"p1":{"title":"Intro","color":"#ef4444","category":"important"}}},');
		expect(lines[meta + 1]).toBe('\t"position": {"page":"p2","y":120.5,"at":"2026-10-29T11:00:00.000Z"},');
		const paper = lines.findIndex((l) => l.startsWith('\t\t\t"paper": '));
		expect(lines[paper + 1]).toBe('\t\t\t"tags": ["exam","chapter 2"],');
		const back = parsed(text).doc;
		expect(back.position).toEqual(doc.position);
		expect(back.meta?.bookmarkInfo).toEqual({ p1: { title: "Intro", color: "#ef4444", category: "important" } });
		expect(back.pages[0]!.tags).toEqual(["exam", "chapter 2"]);
		expect(serialize(back)).toBe(text);
		// The details are written in bookmark order, whatever order the keys were added in.
		const shuffled = { ...doc, meta: { ...doc.meta!, bookmarks: ["p2", "p1"], bookmarkInfo: { p1: { title: "A" }, p2: { title: "B" } } } };
		expect(serialize(shuffled)).toContain('"bookmarkInfo":{"p2":{"title":"B"},"p1":{"title":"A"}}');
	});

	it("writes no v7 field when there is nothing to write", () => {
		const text = serialize(createDocument(new Date(stamp)));
		expect(text).not.toContain('"position"');
		expect(text).not.toContain('"tags": [');
		expect(text).not.toContain("bookmarkInfo");
		const doc = createDocument(new Date(stamp));
		doc.pages[0]!.tags = ["#", " "];
		const id = doc.pages[0]!.id;
		doc.meta = { ...cloneMeta(DEFAULT_META), bookmarks: [id], bookmarkInfo: { [id]: { title: "  " } } };
		const out = serialize(doc);
		expect(out).not.toContain('"tags": [');
		expect(out).not.toContain("bookmarkInfo");
		expect(out).toContain(`"bookmarks":[${JSON.stringify(id)}]}`);
	});

	it("normalises on read and write: tags, details of non-bookmarked pages, positions on missing pages", () => {
		const raw = JSON.parse(serialize(richDoc())) as Raw;
		raw.pages[0].tags = ["#exam", " Exam ", "x  y", ""];
		raw.meta.bookmarkInfo.p2 = { title: "not bookmarked" };
		raw.meta.bookmarkInfo.p1.title = "  Intro   one ";
		const doc = parsed(JSON.stringify(raw)).doc;
		expect(doc.pages[0]!.tags).toEqual(["exam", "x y"]);
		expect(doc.meta?.bookmarkInfo).toEqual({ p1: { title: "Intro one", color: "#ef4444", category: "important" } });
		raw.position.page = "gone";
		expect(parsed(JSON.stringify(raw)).doc.position).toBeUndefined();
		// In memory: a deleted page keeps neither its bookmark details nor the position in the file.
		const d = richDoc();
		d.pages.splice(0, 1);
		d.position = { page: "p1", at: stamp };
		const out = parsed(serialize(d)).doc;
		expect(out.position).toBeUndefined();
		expect(out.meta?.bookmarkInfo).toBeUndefined();
	});

	it("rejects malformed v7 fields", () => {
		const base = JSON.parse(serialize(richDoc())) as Raw;
		const bad = (fn: (r: Raw) => void, path: string) => {
			const raw = structuredClone(base);
			fn(raw);
			const r = parse(JSON.stringify(raw));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.message).toContain(path);
		};
		bad((r) => (r.meta.bookmarkInfo.p1.color = "red"), "meta.bookmarkInfo.p1.color");
		bad((r) => (r.meta.bookmarkInfo.p1.title = 3), "meta.bookmarkInfo.p1.title");
		bad((r) => (r.meta.bookmarkInfo = []), "meta.bookmarkInfo");
		bad((r) => (r.pages[0].tags = "exam"), "pages[0].tags");
		bad((r) => (r.pages[0].tags = ["ok", 1]), "pages[0].tags[1]");
		bad((r) => (r.position = { page: "p1" }), "position.at");
		bad((r) => (r.position = { at: stamp }), "position.page");
		bad((r) => (r.position.y = "top"), "position.y");
		bad((r) => (r.pages[1].paper.kind = "staff"), "pages[1].paper");
	});

	it("does not let a '__proto__' key change the details object", () => {
		const raw = JSON.parse(serialize(richDoc())) as Raw;
		const text = JSON.stringify(raw).replace('"bookmarkInfo":{', '"bookmarkInfo":{"__proto__":{"title":"x"},');
		const doc = parsed(text).doc;
		expect(Object.getPrototypeOf(doc.meta!.bookmarkInfo)).toBe(Object.prototype);
		expect(doc.meta?.bookmarkInfo?.p1?.title).toBe("Intro");
	});

	it("a file of a later version is a future version (opens read-only)", () => {
		const r = parse(serialize(richDoc()).replace('"version": 7', '"version": 8'));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("the save check validates the new fields, also on the incremental path", () => {
		const doc = richDoc();
		expect(serializeChecked(doc).ok).toBe(true);
		doc.meta!.bookmarkInfo!.p1!.color = "nope";
		expect(serializeChecked(doc).ok).toBe(true); // an invalid colour is not written (normalised away)
		const big = richDoc();
		const stroke = line(0, 0, 500, 500, 400);
		for (let i = 0; i < 400 && serialize(big).length < FULL_CHECK_LIMIT; i += 20) for (let k = 0; k < 20; k++) big.pages[0]!.strokes.push({ ...stroke, id: `s${i + k}` });
		expect(serialize(big).length).toBeGreaterThan(FULL_CHECK_LIMIT);
		const checked = serializeChecked(big);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(parsed(checked.text).doc.position).toEqual(big.position);
	});
});

describe("v7 metadata through the editing paths", () => {
	it("cloneMeta, SetMeta undo/redo and the view helpers keep bookmark details", () => {
		const doc = richDoc();
		const copy = cloneMeta(doc.meta!);
		copy.bookmarkInfo!.p1!.title = "changed";
		expect(doc.meta!.bookmarkInfo!.p1!.title).toBe("Intro");
		const history = new History(() => doc);
		const before = doc.meta!;
		history.execute(new SetMeta(before, patchBookmark(before, "p1", { title: "Renamed", color: "#22c55e" })));
		expect(doc.meta!.bookmarkInfo!.p1).toEqual({ title: "Renamed", color: "#22c55e", category: "important" });
		history.undo();
		expect(doc.meta!.bookmarkInfo!.p1!.title).toBe("Intro");
		history.redo();
		expect(doc.meta!.bookmarkInfo!.p1!.title).toBe("Renamed");
		// Toggling the bookmark off drops its details; on again starts without them.
		const off = toggleBookmark(doc.meta!, "p1");
		expect(off.bookmarks).toEqual([]);
		expect(off.bookmarkInfo).toBeUndefined();
		expect(toggleBookmark(off, "p1").bookmarkInfo).toBeUndefined();
		// The library's partial patches keep the details unless they change them.
		const patched = viewMergeMeta(doc.meta!, { favorite: true });
		expect(patched.bookmarkInfo).toEqual(doc.meta!.bookmarkInfo);
		expect(metaEquals(patched, { ...doc.meta!, favorite: true })).toBe(true);
		expect(metaEquals(doc.meta!, removeBookmark(doc.meta!, "p1"))).toBe(false);
		expect(metaEquals(doc.meta!, patchBookmark(doc.meta!, "p1", { color: "#000000" }))).toBe(false);
	});

	it("a library metadata patch keeps details, tags and position in the file", () => {
		const text = serialize(richDoc());
		const r = patchNotebookMeta(text, { favorite: true });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const doc = parsed(r.text).doc;
		expect(doc.meta?.favorite).toBe(true);
		expect(doc.meta?.bookmarkInfo?.p1?.title).toBe("Intro");
		expect(doc.pages[0]!.tags).toEqual(["exam", "chapter 2"]);
		expect(doc.position?.page).toBe("p2");
	});

	it("the companion note does not show bookmark details as a property", () => {
		const props = companionContent(richDoc(), { notebookPath: "N/a.notebook", pageUri: (p) => `obsidian://x?p=${p}` }).properties;
		expect(props.bookmarks).toEqual([1]);
		expect("bookmarkInfo" in props).toBe(false);
	});
});

describe("bookmark helpers", () => {
	it("setBookmark, patchBookmark and removeBookmark", () => {
		let meta = setBookmark(cloneMeta(DEFAULT_META), "a", { title: "  A ", category: "review" });
		expect(meta.bookmarks).toEqual(["a"]);
		expect(meta.bookmarkInfo).toEqual({ a: { title: "A", category: "review" } });
		meta = patchBookmark(meta, "a", { title: "", color: "#3b82f6" });
		expect(meta.bookmarkInfo).toEqual({ a: { color: "#3b82f6", category: "review" } });
		meta = setBookmark(meta, "b", undefined);
		expect(meta.bookmarks).toEqual(["a", "b"]);
		expect(meta.bookmarkInfo?.b).toBeUndefined();
		meta = removeBookmark(meta, "a");
		expect(meta.bookmarks).toEqual(["b"]);
		expect(meta.bookmarkInfo).toBeUndefined();
	});

	it("outline entries follow page order and filter by category; colours fall back to the category's", () => {
		const doc = richDoc();
		let meta = setBookmark(doc.meta!, "p2", { category: "my course" });
		meta = setBookmark(meta, "p0-missing", { title: "x" });
		const all = outlineEntries(doc.pages, meta);
		expect(all.map((e) => [e.pageId, e.index, e.title, e.category])).toEqual([["p1", 0, "Intro", "important"], ["p2", 1, "", "my course"]]);
		expect(outlineEntries(doc.pages, meta, "important").map((e) => e.pageId)).toEqual(["p1"]);
		expect(categoriesInUse(setBookmark(meta, "p2", { category: "review" }))).toEqual(["important", "review"]);
		expect(categoriesInUse(meta)).toEqual(["important", "my course"]);
		expect(bookmarkColor({ category: "review" })).toBe("#eab308");
		expect(bookmarkColor({ category: "mine" })).toBeNull();
		expect(bookmarkColor({ color: "#123456", category: "review" })).toBe("#123456");
	});
});

describe("page tags", () => {
	it("normalises and parses user input", () => {
		expect(normalizePageTags(["#a", "A", " b  c ", 3, ""])).toEqual(["a", "b c"]);
		expect(normalizePageTags([])).toBeUndefined();
		expect(parsePageTagInput("exam, #Chapter 2; exam\nlab #x")).toEqual(["exam", "Chapter 2", "lab", "x"]);
		const doc = richDoc();
		expect(pageHasTag(doc.pages[0]!, "EXAM")).toBe(true);
		doc.pages[1]!.tags = ["Exam", "other"];
		expect(pageTagCounts(doc.pages)).toEqual([{ tag: "exam", count: 2 }, { tag: "chapter 2", count: 1 }, { tag: "other", count: 1 }]);
	});

	it("SetPageTags is undoable", () => {
		const doc = richDoc();
		const history = new History(() => doc);
		history.execute(new SetPageTags("p2", undefined, ["new"]));
		expect(doc.pages[1]!.tags).toEqual(["new"]);
		history.execute(new SetPageTags("p1", doc.pages[0]!.tags, []));
		expect(doc.pages[0]!.tags).toBeUndefined();
		history.undo();
		history.undo();
		expect(doc.pages[0]!.tags).toEqual(["exam", "chapter 2"]);
		expect(doc.pages[1]!.tags).toBeUndefined();
	});

	it("duplicating a page keeps its tags (a copy, not shared)", () => {
		const page = richDoc().pages[0]!;
		const copy = duplicatePage(page);
		expect(copy.tags).toEqual(page.tags);
		expect(copy.tags).not.toBe(page.tags);
	});
});

describe("page restore keeps the v7 fields", () => {
	it("replace unites the tags of the page in view and of the version; the bookmark stays", () => {
		const doc = richDoc();
		const old = richDoc();
		old.pages[0]!.tags = ["old tag", "exam"];
		doc.pages[0]!.tags = ["exam", "new tag"];
		const plan = planPageRestore(doc, old, 0, 0, "replace")!;
		new History(() => doc).execute(plan.command);
		expect(doc.pages[0]!.tags).toEqual(["exam", "new tag", "old tag"]);
		expect(doc.meta?.bookmarkInfo?.p1?.title).toBe("Intro");
		expect(parsed(serialize(doc)).doc.pages[0]!.tags).toEqual(["exam", "new tag", "old tag"]);
	});

	it("insert copies the version's tags onto the new page", () => {
		const doc = richDoc();
		const old = richDoc();
		old.pages[0]!.tags = ["old"];
		const plan = planPageRestore(doc, old, 0, 0, "insert")!;
		new History(() => doc).execute(plan.command);
		expect(doc.pages[1]!.tags).toEqual(["old"]);
	});
});

describe("merge of a conflicted copy with v7 fields", () => {
	it("unites the page tags of common pages and brings pages of the copy with their tags", () => {
		const main = richDoc();
		const other = richDoc();
		other.pages[0]!.tags = ["Exam", "lab"];
		const extra = createPage();
		extra.id = "p3";
		extra.tags = ["only in copy"];
		other.pages.push(extra);
		const plan = planMerge(main, other);
		expect(plan.summary.pageTagsAdded).toBe(1);
		expect(mergeChangeCount(plan.summary)).toBeGreaterThan(0);
		expect(mergeCovers(main, other)).toBe(false);
		const history = new History(() => main);
		history.execute(plan.command!);
		expect(main.pages[0]!.tags).toEqual(["exam", "chapter 2", "lab"]);
		expect(main.pages[2]!.tags).toEqual(["only in copy"]);
		const saved = parsed(serialize(main)).doc;
		expect(mergeCovers(saved, other)).toBe(true);
		// Idempotent: merging again adds nothing.
		expect(planMerge(saved, other).summary.pageTagsAdded).toBe(0);
		history.undo();
		expect(main.pages[0]!.tags).toEqual(["exam", "chapter 2"]);
	});

	it("keeps the main bookmark details and takes the copy's where the main has none", () => {
		const main = richDoc();
		const other = richDoc();
		other.meta = setBookmark(other.meta!, "p1", { title: "Copy title" });
		other.meta = setBookmark(other.meta, "p2", { title: "From copy", category: "review" });
		const plan = planMerge(main, other);
		expect(plan.summary.bookmarksAdded).toBe(1);
		expect(plan.summary.bookmarkInfoAdded).toBe(2);
		expect(plan.summary.bookmarkInfoDiffer).toBe(1);
		new History(() => main).execute(plan.command!);
		expect(main.meta?.bookmarkInfo?.p1?.title).toBe("Intro");
		expect(main.meta?.bookmarkInfo?.p2).toEqual({ title: "From copy", category: "review" });
		// The copy's other title for p1 is not in the result: the copy is not covered (it stays).
		expect(mergeCovers(parsed(serialize(main)).doc, other)).toBe(false);
		other.meta = setBookmark(other.meta, "p1", { title: "Intro" });
		expect(mergeCovers(parsed(serialize(main)).doc, other)).toBe(true);
	});

	it("is not covered when a bookmark or its details were lost; the main position is kept", () => {
		const main = richDoc();
		const other = richDoc();
		other.position = { page: "p1", at: "2030-01-01T00:00:00.000Z" };
		other.meta = setBookmark(other.meta!, "p2", { title: "x" });
		expect(mergeCovers(main, other)).toBe(false);
		const plan = planMerge(main, other);
		new History(() => main).execute(plan.command!);
		expect(main.position?.page).toBe("p2");
		const lost = parsed(serialize(main)).doc;
		lost.meta = removeBookmark(lost.meta!, "p2");
		expect(mergeCovers(lost, other)).toBe(false);
		lost.meta = setBookmark(lost.meta, "p2", undefined);
		expect(mergeCovers(lost, other)).toBe(false);
	});
});

describe("repair of a damaged v7 notebook keeps the new fields", () => {
	it("recovers tags, bookmark details and the position after a damaged region", () => {
		const doc = richDoc();
		for (let i = 0; i < 5; i++) doc.pages[1]!.strokes.push(line(10, 10 + i * 10, 200, 20 + i * 10));
		const text = serialize(doc);
		const lines = text.split("\n");
		// Damage a stroke line of the first page: the JSON is no longer complete.
		const at = lines.findIndex((l) => l.startsWith("\t\t\t\t{"));
		lines[at] = lines[at]!.slice(0, 30);
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.damaged).toBe(true);
		expect(r.doc.pages[0]!.tags).toEqual(["exam", "chapter 2"]);
		expect(r.doc.pages[1]!.paper.kind).toBe("cornell");
		expect(r.doc.meta?.bookmarkInfo?.p1).toEqual({ title: "Intro", color: "#ef4444", category: "important" });
		expect(r.doc.position).toEqual(doc.position);
		expect(r.summary.unknownFields).toBe(0);
	});

	it("keeps the valid fields of a damaged bookmark entry and drops a bad position", () => {
		const raw = JSON.parse(serialize(richDoc())) as Raw;
		raw.meta.bookmarkInfo.p1.color = "red";
		raw.position = { page: "p2", at: 5 };
		raw.pages[0].tags = ["ok", 7];
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.meta?.bookmarkInfo?.p1).toEqual({ title: "Intro", category: "important" });
		expect(r.doc.position).toBeUndefined();
		expect(r.doc.pages[0]!.tags).toEqual(["ok"]);
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(3);
	});
});

describe("reading position", () => {
	it("positionAt, updatePosition and resolvePosition", () => {
		const doc = richDoc();
		const at = new Date("2026-10-29T12:00:00.000Z");
		expect(positionAt(doc, 5, 0, at)).toBeUndefined();
		const p = positionAt(doc, 0, 99.999, at)!;
		expect(p).toEqual({ page: "p1", y: 100, at: at.toISOString() });
		expect(positionAt(doc, 0, -20, at)).toEqual({ page: "p1", at: at.toISOString() });
		updatePosition(doc, p);
		expect(resolvePosition(doc)).toEqual({ index: 0, y: 100 });
		updatePosition(doc, undefined);
		expect(doc.position).toEqual(p);
		doc.pages.splice(0, 1);
		expect(resolvePosition(doc)).toBeNull();
	});

	it("chooseStart: a link wins, a newer stored position beats the device's own page, else the device's page", () => {
		const doc = richDoc(); // stored: p2 (index 1) at 11:00
		expect(chooseStart(doc, { link: 1, restored: 2 })).toEqual({ index: 0, y: 0 });
		expect(chooseStart(doc, { link: 99 })).toEqual({ index: 1, y: 0 });
		expect(chooseStart(doc, {})).toEqual({ index: 1, y: 120.5 });
		expect(chooseStart(doc, { restored: 1, localAt: "2026-10-29T10:00:00.000Z" })).toEqual({ index: 1, y: 120.5 });
		expect(chooseStart(doc, { restored: 1, localAt: "2026-10-29T12:00:00.000Z" })).toEqual({ index: 0, y: 0 });
		expect(chooseStart(doc, { restored: 1, localAt: null })).toEqual({ index: 1, y: 120.5 });
		delete doc.position;
		expect(chooseStart(doc, {})).toBeNull();
		expect(chooseStart(doc, { restored: 2 })).toEqual({ index: 1, y: 0 });
	});
});
