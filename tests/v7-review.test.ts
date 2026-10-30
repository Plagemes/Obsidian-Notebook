/**
 * Review fixes of format v7: field-by-field bookmark merge, bounded paper geometry, page time of the
 * workspace layout, page moves keeping bookmarks, lenient read of bad v7 details, categories of existing
 * pages, the library index version.
 */
import { describe, expect, it } from "vitest";
import { patchNotebookMeta } from "../src/library/host-logic";
import { categoriesInUse, setBookmark } from "../src/model/bookmarks";
import { cloneMeta, createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import { DEFAULT_META, type NotebookDocument } from "../src/model/types";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
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

describe("categories in use", () => {
	it("ignores bookmarks left on pages that no longer exist", () => {
		const doc = twoPages();
		let meta = setBookmark(doc.meta!, "p1", { category: "review" });
		meta = setBookmark(meta, "gone", { category: "old course" });
		expect(categoriesInUse(meta)).toEqual(["review", "old course"]);
		expect(categoriesInUse(meta, doc.pages)).toEqual(["review"]);
	});
});

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rawOf(doc: NotebookDocument): Raw {
	return JSON.parse(serialize(doc)) as Raw;
}

describe("lenient read of invalid v7 details", () => {
	function withBadDetails(): Raw {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { title: "Keep me", category: "review" });
		doc.position = { page: "p2", y: 40, at: "2026-10-29T11:00:00.000Z" };
		const raw = rawOf(doc);
		raw.meta.bookmarkInfo.p1.color = "red";
		// A detail entry of a page that is not bookmarked (an orphan) with a bad colour.
		raw.meta.bookmarkInfo.orphan = { color: 12 };
		raw.position.y = "forty";
		return raw;
	}

	it("drops only the invalid fields and counts them; the notebook opens", () => {
		const r = parse(JSON.stringify(withBadDetails()));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.dropped).toBe(3);
		expect(r.doc.meta?.bookmarkInfo).toEqual({ p1: { title: "Keep me", category: "review" } });
		expect(r.doc.position).toEqual({ page: "p2", at: "2026-10-29T11:00:00.000Z" });
		// What is written is valid as a whole and reads back with nothing dropped.
		const again = parsed(serializeChecked(r.doc).ok ? serialize(r.doc) : "");
		expect(again.dropped).toBeUndefined();
	});

	it("drops a position or a details map that is not an object, and invalid entries", () => {
		const raw = withBadDetails();
		raw.position = "page 2";
		raw.meta.bookmarkInfo.p1 = "x";
		const r = parsed(JSON.stringify(raw));
		// The position, the p1 entry and the orphan's colour.
		expect(r.dropped).toBe(3);
		expect(r.doc.position).toBeUndefined();
		expect(r.doc.meta?.bookmarkInfo).toBeUndefined();
		raw.meta.bookmarkInfo = [1, 2];
		const list = parsed(JSON.stringify(raw)).doc;
		expect(list.meta?.bookmarks).toEqual(["p1"]);
		expect(list.meta?.bookmarkInfo).toBeUndefined();
	});

	it("a valid file reports nothing dropped", () => {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { color: "#22c55e" });
		expect(parsed(serialize(doc)).dropped).toBeUndefined();
	});

	it("never writes invalid details: what is written reads back with nothing dropped", () => {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { title: "T" });
		doc.meta.bookmarkInfo!.p1!.color = "red";
		doc.position = { page: "p1", y: Number.NaN, at: "2026-10-29T11:00:00.000Z" };
		for (const full of [false, true]) {
			const out = serializeChecked(doc, full);
			expect(out.ok).toBe(true);
			if (!out.ok) continue;
			const back = parsed(out.text);
			expect(back.dropped).toBeUndefined();
			expect(back.doc.meta?.bookmarkInfo).toEqual({ p1: { title: "T" } });
			expect(back.doc.position).toEqual({ page: "p1", at: "2026-10-29T11:00:00.000Z" });
		}
	});

	it("a library meta edit of such a file asks for a backup; repair counts the dropped fields", () => {
		const text = JSON.stringify(withBadDetails());
		const patched = patchNotebookMeta(text, { favorite: true });
		expect(patched.ok && patched.migrated).toBe(true);
		const repaired = repairNotebookText(text);
		expect(repaired.ok).toBe(true);
		if (repaired.ok) expect(repaired.summary.fieldsReset).toBe(3);
	});

	it("the session keeps a backup of the original text before it can be rewritten", async () => {
		const text = JSON.stringify(withBadDetails());
		const backups: Array<{ content: string; reason: BackupReason }> = [];
		const io: DocumentIO = {
			read: async () => text,
			process: async () => undefined,
			backup: async (content, reason) => {
				backups.push({ content, reason });
				return "backup.bak";
			},
		};
		const timers: Timers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (h) => clearTimeout(h) };
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("ok");
		expect(backups).toEqual([{ content: text, reason: "dropped-details" }]);
		s.dispose();
	});
});
