import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { elementContentKey, mergeChangeCount, mergeCovers, planMerge, strokeContentKey } from "../src/model/merge";
import { matchingPageIndex, planPageRestore } from "../src/model/page-restore";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import type { NotebookDocument, Page, TextElement } from "../src/model/types";
import { conflictBaseCandidates, conflictBaseOf, conflictCopiesOf } from "../src/storage/conflicts";
import { line } from "./helpers";

function clone(doc: NotebookDocument): NotebookDocument {
	const r = parse(serialize(doc));
	if (!r.ok) throw new Error(r.message);
	return r.doc;
}

function base(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	const p2 = createPage();
	doc.pages.push(p2);
	doc.pages[0]!.strokes.push(line(10, 10, 100, 10), line(10, 30, 100, 30));
	p2.strokes.push(line(20, 20, 80, 80));
	doc.pages[0]!.elements = [{ id: "t1", type: "text", x: 1, y: 2, width: 100, text: "hello", fontSize: 12, color: "#000000" }];
	doc.meta = { tags: ["a"], favorite: false, cover: "#3b82f6", bookmarks: [] };
	return doc;
}

function merged(main: NotebookDocument, other: NotebookDocument): NotebookDocument {
	const out = clone(main);
	planMerge(out, other).command?.apply(out);
	const checked = serializeChecked(out, true);
	if (!checked.ok) throw new Error(checked.message);
	return clone(out);
}

/** Per page id: the sorted list of content keys (strokes and elements). Ids of copies are new, so they are left out. */
function contentByPage(doc: NotebookDocument): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const p of doc.pages) {
		out[p.id] = [...p.strokes.map((s) => `s${strokeContentKey(s)}`), ...(p.elements ?? []).map((e) => `e${elementContentKey(e)}`)].sort();
	}
	return out;
}

/** Two diverged copies of one notebook, as two devices would produce them. */
function diverged(): { a: NotebookDocument; b: NotebookDocument } {
	const origin = base();
	const a = clone(origin);
	const b = clone(origin);
	// Device A: a new stroke on page 1, a new page at the end, a tag, deletes a stroke on page 2.
	a.pages[0]!.strokes.push(line(200, 200, 300, 300));
	const pa = createPage();
	pa.strokes.push(line(5, 5, 6, 6));
	a.pages.push(pa);
	a.meta!.tags.push("from-a");
	a.pages[1]!.strokes.splice(0, 1);
	// Device B: a new stroke on page 2, a new page at the start, an edited text box (same id), a bookmark.
	b.pages[1]!.strokes.push(line(400, 400, 450, 420));
	const pb = createPage();
	pb.strokes.push(line(7, 7, 8, 8));
	b.pages.unshift(pb);
	b.pages[1]!.elements = [{ ...(b.pages[1]!.elements![0] as TextElement), text: "hello from B" }];
	b.meta = { ...b.meta!, bookmarks: [pb.id], favorite: true };
	return { a, b };
}

describe("planMerge", () => {
	it("nothing is lost: the result contains every item of both sides", () => {
		const { a, b } = diverged();
		const m = merged(a, b);
		expect(mergeCovers(m, a)).toBe(true);
		expect(mergeCovers(m, b)).toBe(true);
		// The stroke deleted on A is still in B, so it comes back: deletions are not inferred.
		expect(m.pages.find((p) => p.id === a.pages[1]!.id)!.strokes.length).toBe(2);
		expect(m.meta?.tags).toEqual(["a", "from-a"]);
		expect(m.meta?.favorite).toBe(true);
		expect(m.meta?.bookmarks).toEqual([b.pages[0]!.id]);
	});

	it("an item changed on both sides is kept twice (the copy's version with a new id)", () => {
		const { a, b } = diverged();
		const plan = planMerge(clone(a), b);
		expect(plan.summary.elementsCopied).toBe(1);
		const m = merged(a, b);
		const page = m.pages.find((p) => p.id === a.pages[0]!.id)!;
		const texts = page.elements!.map((e) => (e.type === "text" ? e.text : "")).sort();
		expect(texts).toEqual(["hello", "hello from B"]);
		expect(page.elements![0]!.id).toBe("t1");
	});

	it("places pages that exist only in the copy after their predecessor", () => {
		const { a, b } = diverged();
		const m = merged(a, b);
		expect(m.pages.map((p) => p.id)).toEqual([b.pages[0]!.id, a.pages[0]!.id, a.pages[1]!.id, a.pages[2]!.id]);
	});

	it("is idempotent: merging the same copy again adds nothing", () => {
		const { a, b } = diverged();
		const once = merged(a, b);
		const plan = planMerge(clone(once), b);
		expect(plan.command).toBeNull();
		expect(mergeChangeCount(plan.summary)).toBe(0);
		expect(serialize(merged(once, b))).toBe(serialize(once));
		// Merging the result into itself adds nothing either.
		expect(planMerge(clone(once), once).command).toBeNull();
	});

	it("is commutative for content: A+B and B+A hold the same items on the same pages", () => {
		const { a, b } = diverged();
		const ab = merged(a, b);
		const ba = merged(b, a);
		expect(contentByPage(ab)).toEqual(contentByPage(ba));
		expect(new Set(ab.meta!.tags)).toEqual(new Set(ba.meta!.tags));
		expect(ab.meta!.favorite).toBe(ba.meta!.favorite);
		expect(Object.keys(ab.assets ?? {}).sort()).toEqual(Object.keys(ba.assets ?? {}).sort());
	});

	it("identical copies merge to nothing", () => {
		const a = base();
		const plan = planMerge(clone(a), clone(a));
		expect(plan.command).toBeNull();
		expect(plan.summary.identical).toBe(4);
	});

	it("is one undo step that restores the exact original", () => {
		const { a, b } = diverged();
		const doc = clone(a);
		const before = serialize(doc);
		const history = new History(() => doc);
		const plan = planMerge(doc, b);
		history.execute(plan.command!);
		expect(serialize(doc)).not.toBe(before);
		history.undo();
		expect(serialize(doc)).toBe(before);
		history.redo();
		expect(mergeCovers(doc, b)).toBe(true);
	});

	it("adds missing assets and keeps the main page settings, counting differences", () => {
		const a = base();
		const b = clone(a);
		b.assets = { abc1: { id: "abc1", kind: "image", path: "_assets/abc1.png", name: "x.png", bytes: 3 } };
		b.pages[0]!.elements!.push({ id: "img", type: "image", asset: "abc1", x: 0, y: 0, width: 10, height: 10, rotation: 0 });
		b.pages[1]!.paper = { kind: "ruled", spacing: 22 };
		const plan = planMerge(clone(a), b);
		expect(plan.summary.assetsAdded).toBe(1);
		expect(plan.summary.elementsAdded).toBe(1);
		expect(plan.summary.pageSettingsDiffer).toBe(1);
		const m = merged(a, b);
		expect(m.assets?.abc1).toBeDefined();
		expect(m.pages[1]!.paper.kind).toBe(a.pages[1]!.paper.kind);
	});

	it("fuzz: random divergent edits never lose anything and stay idempotent", () => {
		let seed = 99;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let iter = 0; iter < 40; iter++) {
			const origin = base();
			const sides = [clone(origin), clone(origin)];
			for (const doc of sides) {
				const ops = 1 + Math.floor(rand() * 6);
				for (let k = 0; k < ops; k++) {
					const page = doc.pages[Math.floor(rand() * doc.pages.length)]!;
					const r = rand();
					if (r < 0.4) page.strokes.push(line(rand() * 300, rand() * 300, rand() * 300, rand() * 300, 4));
					else if (r < 0.6 && page.strokes.length > 0) page.strokes.splice(Math.floor(rand() * page.strokes.length), 1);
					else if (r < 0.75) {
						const p = createPage();
						p.strokes.push(line(1, 1, 2 + rand() * 9, 3));
						doc.pages.splice(Math.floor(rand() * (doc.pages.length + 1)), 0, p);
					} else if (r < 0.9 && page.strokes.length > 0) {
						// Same id, changed content (as a transform would, if ids were kept).
						const i = Math.floor(rand() * page.strokes.length);
						const s = page.strokes[i]!;
						page.strokes[i] = { ...s, color: "#ff0000" };
					} else {
						doc.meta!.tags.push(`t${Math.floor(rand() * 4)}`);
					}
				}
			}
			const [x, y] = sides as [NotebookDocument, NotebookDocument];
			const xy = merged(x, y);
			expect(mergeCovers(xy, x)).toBe(true);
			expect(mergeCovers(xy, y)).toBe(true);
			expect(planMerge(clone(xy), y).command).toBeNull();
			expect(contentByPage(xy)).toEqual(contentByPage(merged(y, x)));
		}
	});
});

describe("planPageRestore", () => {
	function versions(): { old: NotebookDocument; current: NotebookDocument } {
		const old = base();
		old.assets = { ff00: { id: "ff00", kind: "pdf", path: "_assets/ff00.pdf", name: "a.pdf", bytes: 10 } };
		old.pages[1]!.background = { kind: "pdf", asset: "ff00", page: 2 };
		const current = clone(old);
		current.assets = {};
		delete current.pages[1]!.background;
		current.pages[1]!.strokes = [line(1, 1, 9, 9)];
		current.pages[0]!.strokes.push(line(3, 3, 4, 4));
		return { old: clone(old), current };
	}

	it("replaces the page in view, keeping its id, as one undo step; the rest is untouched", () => {
		const { old, current } = versions();
		const doc = clone(current);
		const before = serialize(doc);
		const history = new History(() => doc);
		const plan = planPageRestore(doc, old, 1, 1, "replace")!;
		history.execute(plan.command);
		expect(plan.assetsAdded).toBe(1);
		expect(doc.pages[1]!.id).toBe(current.pages[1]!.id);
		expect(doc.pages[1]!.strokes.map((s) => strokeContentKey(s))).toEqual(old.pages[1]!.strokes.map((s) => strokeContentKey(s)));
		expect(doc.pages[1]!.background).toEqual({ kind: "pdf", asset: "ff00", page: 2 });
		expect(doc.pages[0]).toEqual(current.pages[0]);
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(serialize(doc)).toBe(before);
	});

	it("inserts the old page as a new page after the one in view, with new ids", () => {
		const { old, current } = versions();
		const doc = clone(current);
		const plan = planPageRestore(doc, old, 0, 0, "insert")!;
		plan.command.apply(doc);
		expect(plan.pageIndex).toBe(1);
		expect(doc.pages).toHaveLength(3);
		const restored = doc.pages[1]!;
		expect(restored.id).not.toBe(old.pages[0]!.id);
		expect(restored.strokes.map((s) => strokeContentKey(s))).toEqual(old.pages[0]!.strokes.map((s) => strokeContentKey(s)));
		expect(restored.strokes.every((s) => !old.pages[0]!.strokes.some((o) => o.id === s.id))).toBe(true);
		expect(doc.pages[0]).toEqual(current.pages[0]);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("gives new ids to restored content whose ids are used on another page", () => {
		const { old, current } = versions();
		const doc = clone(current);
		// The old page 1's stroke id now lives on page 0.
		const moved = old.pages[1]!.strokes[0]!;
		doc.pages[0]!.strokes.push(moved);
		planPageRestore(doc, old, 1, 1, "replace")!.command.apply(doc);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("matches pages by id, then position", () => {
		const { old, current } = versions();
		expect(matchingPageIndex(old, current.pages[1], 0)).toBe(1);
		expect(matchingPageIndex(old, createPage() as Page, 1)).toBe(1);
		expect(matchingPageIndex(old, undefined, 9)).toBe(0);
		expect(planPageRestore(current, old, 5, 0, "insert")).toBeNull();
	});
});

describe("conflicted copy names", () => {
	it("recognises the patterns of Google Drive, OneDrive, Dropbox, Syncthing and Android sync apps", () => {
		const cases: Array<[string, string]> = [
			["Notes (1)", "Notes"],
			["Notes (12)", "Notes"],
			["[Conflict] Notes", "Notes"],
			["Notes [Conflict]", "Notes"],
			["Notes-DESKTOP-AB12CD", "Notes"],
			["Notes-LAPTOP-2", "Notes"],
			["Notes-MyPC", "Notes"],
			["Notes (conflicted copy)", "Notes"],
			["Notes (Anna's conflicted copy 2026-10-29)", "Notes"],
			["Notes (conflict 2026-10-29 14.05)", "Notes"],
			["Notes_conflict-20261029", "Notes"],
			["Notes.sync-conflict-20261029-140500-ABCDEFG", "Notes"],
			["My notes 2026-10-29 (1)", "My notes 2026-10-29"],
		];
		for (const [stem, want] of cases) expect(conflictBaseCandidates(stem), stem).toContain(want);
	});

	it("is conservative: ordinary names are not copies", () => {
		for (const stem of ["Notes", "Notes 2", "Notebook 2026-10-29 14.05", "Notes (repaired)", "Meeting (draft)", "2026-10-29"]) {
			const bases = conflictBaseCandidates(stem);
			expect(conflictBaseOf(stem, new Set(["Notes", "Notebook 2026", "Notebook", "2026", "Meeting"])), `${stem} -> ${bases.join("|")}`).toBeNull();
		}
		// A OneDrive-like name only counts when the base file exists.
		expect(conflictBaseOf("Notes-MyPC", new Set(["Other"]))).toBeNull();
		// Device names need a letter: "Notes-2" is an ordinary name.
		expect(conflictBaseCandidates("Notes-2")).toEqual([]);
	});

	it("finds the copies among siblings", () => {
		expect(conflictCopiesOf("Notes", ["Notes", "Notes (1)", "Other (1)", "Notes-DESKTOP-X1", "Notes 2"]).sort()).toEqual(["Notes (1)", "Notes-DESKTOP-X1"]);
	});
});
