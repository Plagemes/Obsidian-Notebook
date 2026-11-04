import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { exemptFromLocks } from "../src/model/page-lock";
import { applyRemoval, planMerge, planNewNotebook, planRemoval, planSplit, planTransfer, textLinksToPages, type TransferPlan } from "../src/model/notebook-transfer";
import { parse, serializeChecked } from "../src/model/serialize";
import { freezeStroke } from "../src/model/serialize";
import type { Asset, NotebookDocument, Page, Stroke, TextElement } from "../src/model/types";
import { DeletePage } from "../src/model/history";

const SRC = "pdf-source-1";

function asset(id: string, kind: Asset["kind"] = "pdf"): Asset {
	return { id, kind, path: `Notebooks/_assets/${id}.${kind === "pdf" ? "pdf" : "png"}`, name: `${id}.${kind}`, bytes: 10 };
}

function stroke(slide?: string): Stroke {
	const s = createStroke("#112233", 2, [quantizePoint(10, 10, 0.5), quantizePoint(40, 30, 0.5)]);
	return slide === undefined ? s : freezeStroke({ ...s, slide });
}

function notebook(pages: number, strokesPerPage = 2): NotebookDocument {
	const doc = createDocument(new Date("2026-11-01T10:00:00.000Z"));
	doc.pages = [];
	for (let i = 0; i < pages; i++) {
		const p = createPage();
		for (let j = 0; j < strokesPerPage; j++) p.strokes.push(stroke());
		doc.pages.push(p);
	}
	return doc;
}

const ids = (doc: NotebookDocument) => doc.pages.map((p) => p.id);

function plan(r: ReturnType<typeof planTransfer>): TransferPlan {
	if (!r.ok) throw new Error(`plan failed: ${r.reason}`);
	return r;
}

const textBox = (id: string, text: string): TextElement => ({ id, type: "text", x: 10, y: 10, width: 200, text, fontSize: 14, color: "#000000" });

describe("planTransfer", () => {
	it("copies pages in source order with new stroke ids and puts them where asked", () => {
		const a = notebook(3);
		const b = notebook(4);
		const p = plan(planTransfer(b, [b.pages[2]!.id, b.pages[0]!.id], a, "move", { at: 1 }));
		expect(p.pages.map((x) => x.id)).toEqual([b.pages[0]!.id, b.pages[2]!.id]);
		expect(p.at).toBe(1);
		const sourceStrokes = new Set(b.pages.flatMap((x) => x.strokes.map((s) => s.id)));
		expect(p.pages.flatMap((x) => x.strokes).every((s) => !sourceStrokes.has(s.id))).toBe(true);
		expect(p.pages[0]!.strokes[0]!.points).toEqual(b.pages[0]!.strokes[0]!.points);
		// the plan changes neither document
		expect(b.pages).toHaveLength(4);
		expect(a.pages).toHaveLength(3);
	});

	it("move keeps the page ids, copy gives new ones", () => {
		const a = notebook(1);
		const b = notebook(2);
		const moved = plan(planTransfer(b, ids(b), a, "move"));
		expect(moved.pages.map((x) => x.id)).toEqual(ids(b));
		expect(moved.renamed).toEqual([]);
		const copied = plan(planTransfer(b, ids(b), a, "copy"));
		expect(copied.pages.map((x) => x.id).some((id) => ids(b).includes(id))).toBe(false);
		expect(new Set(copied.pages.map((x) => x.id)).size).toBe(2);
		expect(copied.renamed).toEqual([]);
	});

	it("an id the destination already uses is renamed and reported (move)", () => {
		const a = notebook(1);
		const b = notebook(2);
		// the destination is a copy of the source: same page ids
		a.pages.push({ ...b.pages[0]!, strokes: [] });
		const p = plan(planTransfer(b, ids(b), a, "move"));
		expect(p.renamed).toHaveLength(1);
		expect(p.renamed[0]!.from).toBe(b.pages[0]!.id);
		expect(p.pages[0]!.id).toBe(p.renamed[0]!.to);
		expect(p.pages[0]!.id).not.toBe(b.pages[0]!.id);
		expect(p.pages[1]!.id).toBe(b.pages[1]!.id);
		const all = [...a.pages, ...p.pages].map((x) => x.id);
		expect(new Set(all).size).toBe(all.length);
	});

	it("adds only the asset records the destination lacks and fails on a record the source does not have", () => {
		const a = notebook(1);
		const b = notebook(2);
		b.assets = { aa01: asset("aa01"), bb01: asset("bb01", "image") };
		b.pages[0]!.background = { kind: "pdf", asset: "aa01", page: 2 };
		b.pages[1]!.elements = [{ id: "i1", type: "image", asset: "bb01", x: 0, y: 0, width: 50, height: 50, rotation: 0 }];
		a.assets = { aa01: asset("aa01") };
		const p = plan(planTransfer(b, ids(b), a, "move"));
		expect(p.assets.map((x) => x.id)).toEqual(["bb01"]);
		expect(p.pages[0]!.background).toEqual({ kind: "pdf", asset: "aa01", page: 2 });
		// an element gets a new id, the asset id stays (content addressed)
		expect(p.pages[1]!.elements![0]!.id).not.toBe("i1");
		delete b.assets.bb01;
		const bad = planTransfer(b, ids(b), a, "move");
		expect(bad).toEqual({ ok: false, reason: "missing-asset", assetId: "bb01" });
	});

	it("refuses nothing chosen and unknown pages", () => {
		const a = notebook(1);
		const b = notebook(1);
		expect(planTransfer(b, [], a, "move")).toEqual({ ok: false, reason: "no-pages" });
		expect(planTransfer(b, ["nope"], a, "move")).toEqual({ ok: false, reason: "unknown-page", pageId: "nope" });
	});

	it("clamps the insert position", () => {
		const a = notebook(2);
		const b = notebook(1);
		expect(plan(planTransfer(b, ids(b), a, "move", { at: 99 })).at).toBe(2);
		expect(plan(planTransfer(b, ids(b), a, "move", { at: -3 })).at).toBe(0);
		expect(plan(planTransfer(b, ids(b), a, "move", { at: 1.5 })).at).toBe(2);
	});

	it("carries slide links: matched to an equal entry, or added under a free id", () => {
		const a = notebook(1);
		const b = notebook(2);
		b.slides = [{ id: "s1", source: SRC, page: 3 }, { id: "s2", source: SRC, page: 4 }];
		b.pages[0]!.strokes = [stroke("s1"), stroke("s2"), stroke()];
		// the destination has the same slide under another id, and another slide under the id s2
		a.slides = [{ id: "zz", source: SRC, page: 3 }, { id: "s2", source: "other", page: 1 }];
		const p = plan(planTransfer(b, [b.pages[0]!.id], a, "move"));
		const strokes = p.pages[0]!.strokes;
		expect(strokes[0]!.slide).toBe("zz");
		expect(strokes[1]!.slide).not.toBeUndefined();
		expect(strokes[1]!.slide).not.toBe("s2");
		expect(strokes[2]!.slide).toBeUndefined();
		expect(p.slides).toHaveLength(1);
		expect(p.slides[0]).toMatchObject({ source: SRC, page: 4 });
		expect(p.slides[0]!.id).toBe(strokes[1]!.slide);
	});

	it("a locked page keeps its lock in the copy and is listed", () => {
		const a = notebook(1);
		const b = notebook(3);
		b.pages[1]!.locked = true;
		const p = plan(planTransfer(b, ids(b), a, "copy"));
		expect(p.pages.map((x) => x.locked === true)).toEqual([false, true, false]);
		expect(p.locked).toEqual([b.pages[1]!.id]);
		expect(b.pages[1]!.locked).toBe(true);
	});

	it("remaps drawing states to the copy's stroke ids", () => {
		const a = notebook(1);
		const b = notebook(1, 3);
		const [s0, s1] = b.pages[0]!.strokes;
		b.pages[0]!.states = { parts: [{ id: "part1", pivot: [0, 0], items: [s0!.id, s1!.id] }], list: [{ id: "st1", name: "A", poses: [{ part: "part1", dx: 5 }] }] };
		const p = plan(planTransfer(b, ids(b), a, "copy"));
		const copy = p.pages[0]!;
		const copyIds = new Set(copy.strokes.map((s) => s.id));
		expect(copy.states!.parts[0]!.items.every((id) => copyIds.has(id))).toBe(true);
		expect(copy.states!.parts[0]!.items).toHaveLength(2);
	});

	it("bookmarks of the pages follow them, also to a new id", () => {
		const a = notebook(1);
		const b = notebook(2);
		b.meta!.bookmarks = [b.pages[1]!.id];
		b.meta!.bookmarkInfo = { [b.pages[1]!.id]: { title: "Key" } };
		const moved = plan(planTransfer(b, ids(b), a, "move"));
		expect(moved.bookmarks).toEqual([{ pageId: b.pages[1]!.id, info: { title: "Key" } }]);
		const copied = plan(planTransfer(b, ids(b), a, "copy"));
		expect(copied.bookmarks).toEqual([{ pageId: copied.pages[1]!.id, info: { title: "Key" } }]);
	});

	it("the plan can be written: the destination round-trips through the serializer", () => {
		const a = notebook(2);
		const b = notebook(2);
		b.assets = { aa01: asset("aa01") };
		b.pages[0]!.background = { kind: "pdf", asset: "aa01", page: 1 };
		b.slides = [{ id: "s1", source: SRC, page: 3 }];
		b.pages[1]!.strokes = [stroke("s1")];
		const p = plan(planTransfer(b, ids(b), a, "move", { at: 1 }));
		for (const asset of p.assets) (a.assets ??= {})[asset.id] = asset;
		a.slides = [...(a.slides ?? []), ...p.slides];
		a.pages.splice(p.at, 0, ...p.pages);
		const out = serializeChecked(a, true);
		expect(out.ok ? "" : out.message).toBe("");
		if (!out.ok) return;
		const back = parse(out.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.doc.pages).toHaveLength(4);
		expect(back.doc.pages[2]!.strokes[0]!.slide).toBeDefined();
		expect(back.doc.slides).toHaveLength(1);
		expect(back.doc.assets?.aa01).toBeDefined();
	});
});

describe("planMerge", () => {
	it("appends all of B after the chosen page, or at the end", () => {
		const a = notebook(3);
		const b = notebook(2);
		expect(plan(planMerge(a, b, "copy", 0) as ReturnType<typeof planTransfer>).at).toBe(1);
		expect(plan(planMerge(a, b, "copy") as ReturnType<typeof planTransfer>).at).toBe(3);
		expect(plan(planMerge(a, b, "copy", -1) as ReturnType<typeof planTransfer>).at).toBe(3);
		expect(plan(planMerge(a, b, "copy", 2) as ReturnType<typeof planTransfer>).at).toBe(3);
		const p = planMerge(a, b, "move");
		expect(p.ok && p.pages.map((x) => x.id)).toEqual(ids(b));
	});

	it("never merges a notebook into itself, also not through a copy of the file with the same document id", () => {
		const a = notebook(2);
		expect(planMerge(a, a, "copy")).toEqual({ ok: false, reason: "same-notebook" });
		const twin = { ...a, pages: a.pages.map((p) => ({ ...p })) };
		expect(planMerge(a, twin, "copy")).toEqual({ ok: false, reason: "same-notebook" });
	});

	it("merging the same notebook twice as copies never makes duplicate page ids", () => {
		const a = notebook(2);
		const b = notebook(2);
		for (let i = 0; i < 2; i++) {
			const p = plan(planMerge(a, b, "copy") as ReturnType<typeof planTransfer>);
			a.pages.splice(p.at, 0, ...p.pages);
		}
		expect(new Set(ids(a)).size).toBe(6);
	});
});

describe("planSplit", () => {
	it("the new notebook starts at the page; both halves keep a page", () => {
		const doc = notebook(5);
		const s = planSplit(doc, 2);
		expect(s.ok && s.tail).toEqual(ids(doc).slice(2));
		expect(s.ok && s.head).toBe(2);
		expect(planSplit(doc, 0)).toEqual({ ok: false, reason: "bad-split", at: 0 });
		expect(planSplit(doc, 5)).toEqual({ ok: false, reason: "bad-split", at: 5 });
		expect(planSplit(doc, 4).ok).toBe(true);
		expect(planSplit(doc, 1.5).ok).toBe(false);
		expect(planSplit(notebook(1), 1).ok).toBe(false);
	});
});

describe("planNewNotebook", () => {
	it("makes a valid document with its own identity, the assets and slides the pages need, and the source's colour", () => {
		const src = notebook(3);
		src.assets = { aa01: asset("aa01"), aa02: asset("aa02") };
		src.pages[1]!.background = { kind: "pdf", asset: "aa01", page: 1 };
		src.pages[2]!.background = { kind: "pdf", asset: "aa02", page: 1 };
		src.slides = [{ id: "s1", source: SRC, page: 3 }];
		src.pages[1]!.strokes = [stroke("s1")];
		src.meta!.cover = "#ff8800";
		src.meta!.tags = ["physics"];
		src.meta!.favorite = true;
		src.meta!.description = "Notes";
		src.meta!.coverArt = { kind: "art", style: "waves", seed: "abcd" };
		src.meta!.bookmarks = [src.pages[1]!.id];
		const r = planNewNotebook(src, [src.pages[1]!.id], "move");
		if (!r.ok) throw new Error(r.reason);
		expect(r.doc.id).not.toBe(src.id);
		expect(r.doc.pages.map((p) => p.id)).toEqual([src.pages[1]!.id]);
		expect(Object.keys(r.doc.assets ?? {})).toEqual(["aa01"]);
		expect(r.doc.slides).toHaveLength(1);
		expect(r.doc.meta!.cover).toBe("#ff8800");
		expect(r.doc.meta!.tags).toEqual(["physics"]);
		expect(r.doc.meta!.favorite).toBe(false);
		expect(r.doc.meta!.description).toBeUndefined();
		expect(r.doc.meta!.coverArt).toMatchObject({ kind: "art", style: "waves" });
		expect(r.doc.meta!.coverArt).not.toEqual(src.meta!.coverArt);
		expect(r.doc.meta!.bookmarks).toEqual([src.pages[1]!.id]);
		expect(src.meta!.tags).toEqual(["physics"]);
		const out = serializeChecked(r.doc, true);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const back = parse(out.text);
		expect(back.ok && back.doc.pages[0]!.strokes).toHaveLength(1);
		expect(back.ok && back.doc.slides).toHaveLength(1);
	});

	it("does not take a picture cover (its asset belongs to the source) and fails like the planner does", () => {
		const src = notebook(2);
		src.assets = { cc01: asset("cc01", "image") };
		src.meta!.coverArt = { kind: "image", asset: "cc01" };
		const r = planNewNotebook(src, [src.pages[0]!.id], "copy");
		expect(r.ok && r.doc.meta!.coverArt).toBeUndefined();
		expect(r.ok && Object.keys(r.doc.assets ?? {})).toEqual([]);
		expect(planNewNotebook(src, [], "copy")).toEqual({ ok: false, reason: "no-pages" });
	});

	it("a copy has new page ids so that two notebooks never hold the same page id", () => {
		const src = notebook(2);
		const r = planNewNotebook(src, ids(src), "copy");
		expect(r.ok && r.doc.pages.some((p) => ids(src).includes(p.id))).toBe(false);
	});
});

describe("removal from the source", () => {
	function moved(doc: NotebookDocument, which: Page[]) {
		const p = plan(planTransfer(doc, which.map((x) => x.id), notebook(1), "move"));
		return p.moved;
	}

	it("removes the pages still as they were copied and keeps edited and vanished ones", () => {
		const doc = notebook(4);
		const snap = moved(doc, doc.pages.slice(0, 3));
		doc.pages[1]!.strokes.push(stroke());
		const gone = doc.pages[2]!;
		doc.pages.splice(2, 1);
		const r = planRemoval(doc, snap, false);
		expect(r.remove.map((p) => p.id)).toEqual([doc.pages[0]!.id]);
		expect(r.changed).toEqual([doc.pages[1]!.id]);
		expect(r.gone).toEqual([gone.id]);
		expect(r.replacement).toBeNull();
	});

	it("locked pages stay unless the removal was confirmed", () => {
		const doc = notebook(3);
		doc.pages[1]!.locked = true;
		const snap = moved(doc, doc.pages);
		const refused = planRemoval(doc, snap, false);
		expect(refused.remove.map((p) => p.id)).toEqual([doc.pages[0]!.id, doc.pages[2]!.id]);
		expect(refused.keptLocked).toEqual([doc.pages[1]!.id]);
		expect(refused.replacement).toBeNull();
		const allowed = planRemoval(doc, snap, true);
		expect(allowed.remove).toHaveLength(3);
		expect(allowed.keptLocked).toEqual([]);
		expect(allowed.replacement).not.toBeNull();
	});

	it("a lock added after the copy keeps the page (it changed)", () => {
		const doc = notebook(2);
		const snap = moved(doc, doc.pages);
		doc.pages[0]!.locked = true;
		const r = planRemoval(doc, snap, true);
		expect(r.changed).toEqual([doc.pages[0]!.id]);
		expect(r.remove.map((p) => p.id)).toEqual([doc.pages[1]!.id]);
	});

	it("never leaves the source without a page: a blank one like the last takes its place", () => {
		const doc = notebook(2);
		doc.pages[1]!.width = 300;
		doc.pages[1]!.height = 500;
		doc.pages[1]!.infinite = true;
		const snap = moved(doc, doc.pages);
		const r = planRemoval(doc, snap, false);
		expect(r.replacement).toMatchObject({ width: 300, height: 500, infinite: true });
		expect(r.replacement!.strokes).toEqual([]);
	});

	it("applyRemoval takes the pages out, adds the replacement and drops what named them", () => {
		const doc = notebook(3);
		doc.meta!.bookmarks = [doc.pages[0]!.id, doc.pages[2]!.id];
		doc.meta!.bookmarkInfo = { [doc.pages[0]!.id]: { title: "a" }, [doc.pages[2]!.id]: { title: "c" } };
		doc.position = { page: doc.pages[0]!.id, at: "2026-11-01T10:00:00.000Z" };
		const snap = moved(doc, [doc.pages[0]!, doc.pages[1]!]);
		const keep = doc.pages[2]!;
		applyRemoval(doc, planRemoval(doc, snap, false));
		expect(doc.pages).toEqual([keep]);
		expect(doc.meta!.bookmarks).toEqual([keep.id]);
		expect(doc.meta!.bookmarkInfo).toEqual({ [keep.id]: { title: "c" } });
		expect(doc.position).toBeUndefined();
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("applyRemoval of every page leaves one blank page and a valid document", () => {
		const doc = notebook(2);
		const snap = moved(doc, doc.pages);
		applyRemoval(doc, planRemoval(doc, snap, false));
		expect(doc.pages).toHaveLength(1);
		expect(doc.pages[0]!.strokes).toEqual([]);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("the open document: a confirmed removal of a locked page goes through History only when exempt", () => {
		const doc = notebook(2);
		doc.pages[0]!.locked = true;
		const history = new History(() => doc);
		const page = doc.pages[0]!;
		expect(history.execute(new DeletePage(page, 0))).toBe(false);
		expect(doc.pages).toContain(page);
		expect(history.execute(exemptFromLocks(new DeletePage(page, 0)))).toBe(true);
		expect(doc.pages).not.toContain(page);
		history.undo();
		expect(doc.pages[0]).toBe(page);
		expect(page.locked).toBe(true);
	});
});

describe("textLinksToPages", () => {
	it("finds text boxes that link to a moved page by id, in wikilinks and Markdown links", () => {
		const doc = notebook(3);
		doc.pages[0]!.elements = [
			textBox("t1", "see [[Physics.notebook#p3&id=abc-123]] and [[Other.notebook#p1&id=zzz-999]]"),
			textBox("t2", "plain text with a # sign"),
			textBox("t3", "[a page](Physics.notebook#p2&id=abc-123) and [[Physics.notebook#p4&id=def-456]]"),
		];
		doc.pages[2]!.elements = [textBox("t4", "[[Physics.notebook#p3]] has no id")];
		const found = textLinksToPages(doc.pages, new Set(["abc-123", "def-456"]));
		expect(found).toEqual([
			{ pageId: doc.pages[0]!.id, elementId: "t1", targets: ["abc-123"] },
			{ pageId: doc.pages[0]!.id, elementId: "t3", targets: ["abc-123", "def-456"] },
		]);
		expect(textLinksToPages(doc.pages, new Set())).toEqual([]);
	});

	it("ignores links inside code", () => {
		const doc = notebook(1);
		doc.pages[0]!.elements = [textBox("t1", "`[[Physics.notebook#p3&id=abc-123]]`")];
		expect(textLinksToPages(doc.pages, new Set(["abc-123"]))).toEqual([]);
	});
});

describe("bookmark edits keep the rest of the metadata", () => {
	it("setBookmark and removeBookmark keep the description and the generated cover", async () => {
		const { setBookmark, removeBookmark } = await import("../src/model/bookmarks");
		const meta = { ...createDocument().meta!, description: "Notes", coverArt: { kind: "art" as const, style: "waves" as const, seed: "abcd" } };
		const marked = setBookmark(meta, "p1", { title: "T" });
		expect(marked.description).toBe("Notes");
		expect(marked.coverArt).toEqual(meta.coverArt);
		expect(marked.coverArt).not.toBe(meta.coverArt);
		const cleared = removeBookmark(marked, "p1");
		expect(cleared.description).toBe("Notes");
		expect(cleared.coverArt).toEqual(meta.coverArt);
	});
});
