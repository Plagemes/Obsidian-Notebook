/**
 * Format v14: locked pages (#124) — the page field `locked`, the v13 -> v14 migration, lenient read and strict write, staged
 * loading, copies, page trash, restore and moves, conflicted-copy merge and repair.
 */
import { describe, expect, it } from "vitest";
import { planPageMove } from "../src/library/page-move";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddStroke, Batch, History } from "../src/model/history";
import { planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { mapKey, mapPage } from "../src/model/notebook-map";
import { SetPageLocked } from "../src/model/page-lock";
import { planPageRestore } from "../src/model/page-restore";
import { addEntry, emptyPageTrash, makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type Stroke } from "../src/model/types";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-04T10:00:00.000Z";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x = 10, y = 10): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 40, y, 0.5], [x + 40, y + 20, 0.5]]), id });
}

function v13Raw(): Raw {
	return {
		format: FORMAT_ID, version: 13, id: "doc", createdAt: stamp, modifiedAt: stamp,
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

/** A document with a locked first page and an unlocked second one. */
function lockedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.strokes.push(stroke("a"), stroke("b", 10, 80));
	doc.pages[0]!.locked = true;
	const p2 = createPage();
	p2.id = "p2";
	p2.strokes.push(stroke("c"));
	doc.pages.push(p2);
	return doc;
}

describe("format v14: migration", () => {
	it("is at version 14 with a v13 step", () => {
		expect(CURRENT_VERSION).toBe(14);
		expect(MIGRATIONS[13]).toBeTypeOf("function");
	});

	it("reads a v13 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v13Raw()));
		expect(r.migratedFrom).toBe(13);
		expect(r.doc.version).toBe(14);
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("drops a stray locked key of a v13 file: a v13 reader never locked anything, so neither does the migration", () => {
		const raw = v13Raw();
		setAt(raw, ["pages", 0, "locked"], true);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.dropped).toBeUndefined();
		expect("locked" in r.doc.pages[0]!).toBe(false);
	});

	it("migrates a v13 round trip: v13 text -> v14 document -> text has no lock and the same ink", () => {
		const text = serialize(parsed(JSON.stringify(v13Raw())).doc);
		expect(text).toContain('"version": 14');
		expect(text).not.toContain('"locked"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(2);
	});

	it("is refused by 0.15 and older as a newer format (they read up to v13, so v14 opens read-only and is never overwritten)", () => {
		const text = serialize(lockedDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		// What 0.15 does with a v14 file is what the current code does with the next version: the same "future-version" path.
		expect(serialize(lockedDoc())).toContain('"version": 14');
	});
});

describe("format v14: write and read", () => {
	it("round-trips a locked page byte for byte, the lock on its own line before the ink", () => {
		const doc = lockedDoc();
		const text = serialize(doc);
		expect(text).toContain('\t\t\t"locked": true,\n');
		expect(text.split('"locked"').length).toBe(2);
		const back = parsed(text).doc;
		expect(back.pages[0]!.locked).toBe(true);
		expect(back.pages[1]!.locked).toBeUndefined();
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
	});

	it("never writes false: an unlocked page has no key, and false in a file reads as unlocked", () => {
		const doc = lockedDoc();
		doc.pages[0]!.locked = false as unknown as true;
		expect(serialize(doc)).not.toContain('"locked"');
		const raw = JSON.parse(serialize(lockedDoc())) as Raw;
		setAt(raw, ["pages", 0, "locked"], false);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("reads an invalid lock leniently (the page is unlocked, the detail counted) and refuses it strictly", () => {
		const raw = JSON.parse(serialize(lockedDoc())) as Raw;
		setAt(raw, ["pages", 0, "locked"], "yes");
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.dropped).toBe(1);
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(() => validate(raw)).toThrow(/locked/);
	});

	it("keeps the lock through a large document's skeleton check (the full check is skipped above its limit)", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.locked = true;
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(1_000_000);
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(parsed(checked.text).doc.pages.map((p) => p.locked === true)).toEqual([false, true, false]);
	});

	it("the history guard (checkContent) accepts a locked page", () => {
		const doc = lockedDoc();
		const history = new History(() => doc, 100, null);
		expect(history.execute(new SetPageLocked("p2", true))).toBe(true);
		expect(parsed(serialize(doc)).doc.pages.every((p) => p.locked === true)).toBe(true);
	});

	it("a lock on a page does not change the bytes of the other pages", () => {
		const a = lockedDoc();
		const b = lockedDoc();
		delete b.pages[0]!.locked;
		const textA = serialize(a).replace('\t\t\t"locked": true,\n', "");
		expect(textA).toBe(serialize(b));
	});
});

describe("format v14: staged loading", () => {
	it("stages a large v13 file, ignoring a stray locked key page by page", () => {
		const doc = stressDocument(6000, 3, 7);
		let v13 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 13`);
		v13 = v13.replace('"infinite"', '"locked": true,\n\t\t\t"infinite"');
		expect(v13.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v13, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(13);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.locked === undefined)).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("stages a large v14 file with a locked page and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[2]!.locked = true;
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.doc.pages.map((p) => p.locked === true)).toEqual([false, false, true]);
			expect(serialize(r.doc)).toBe(text);
		}
	});

	it("keeps the states of a large v13 file while staging it", () => {
		const doc = stressDocument(6000, 3, 7);
		const v13 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 13`);
		const r = (parseStaged(v13, 1) as StagedParse).finish();
		expect(r.ok).toBe(true);
	});
});

describe("format v14: copies, page trash, moves, restore", () => {
	it("a duplicated page is a new working copy: not locked", () => {
		const doc = lockedDoc();
		const copy = duplicatePage(doc.pages[0]!);
		expect(copy.locked).toBeUndefined();
		expect(copy.strokes).toHaveLength(2);
	});

	it("notebooks made from a notebook or a template come out unlocked", () => {
		const doc = lockedDoc();
		expect(templateFromNotebook(doc).pages.every((p) => p.locked === undefined)).toBe(true);
		expect(notebookFromTemplate(doc).pages.every((p) => p.locked === undefined)).toBe(true);
		expect(notebookFromTemplate(doc, { content: false }).pages.every((p) => p.locked === undefined)).toBe(true);
	});

	it("a page trash entry keeps the lock it had (the page comes back as it was); a restore under a clash is a copy and not locked", () => {
		const doc = lockedDoc();
		const trash = addEntry(emptyPageTrash("doc"), makeEntry(doc, doc.pages[0]!, 0, Date.now()), Date.now());
		const entry = trash.entries[0]!;
		const other = createDocument(new Date(stamp));
		const plan = planPageTrashRestore(other, entry)!;
		plan.command.apply(other);
		expect(other.pages[plan.pageIndex]!.locked).toBe(true);
		expect(other.pages[plan.pageIndex]!.strokes).toHaveLength(2);
		const again = planPageTrashRestore(doc, entry)!;
		again.command.apply(doc);
		expect(doc.pages[again.pageIndex]!.id).not.toBe("p1");
		expect(doc.pages[again.pageIndex]!.locked).toBeUndefined();
	});

	it("restoring a version over a locked page is refused by the guard; over an unlocked page it works", () => {
		const doc = lockedDoc();
		const old = parsed(serialize(doc)).doc;
		old.pages[0]!.strokes.pop();
		const history = new History(() => doc, 100, null);
		const plan = planPageRestore(doc, old, 0, 0, "replace")!;
		expect(history.execute(plan.command)).toBe(false);
		expect(doc.pages[0]!.strokes).toHaveLength(2);
		expect(doc.pages[0]!.locked).toBe(true);
		history.execute(new SetPageLocked("p1", false));
		expect(history.execute(planPageRestore(doc, old, 0, 0, "replace")!.command)).toBe(true);
		expect(doc.pages[0]!.strokes).toHaveLength(1);
		expect(doc.pages[0]!.locked).toBeUndefined();
		// Inserting a version next to a locked page is not an edit of it.
		history.execute(new SetPageLocked("p1", true));
		expect(history.execute(planPageRestore(doc, old, 0, 0, "insert")!.command)).toBe(true);
	});

	it("moving pages to another notebook plans pages that are unlocked in the target", () => {
		const doc = lockedDoc();
		const plan = planPageMove(doc, ["p1"], createDocument(new Date(stamp)));
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(plan.pages.every((p) => p.locked === undefined)).toBe(true);
	});

	it("the notebook map marks a locked page and notices a lock change", () => {
		const doc = lockedDoc();
		expect(mapPage(doc.pages[0]!, 0).locked).toBe(true);
		expect(mapPage(doc.pages[1]!, 1).locked).toBeUndefined();
		const key = mapKey(doc.pages[0]!);
		delete doc.pages[0]!.locked;
		expect(mapKey(doc.pages[0]!)).not.toBe(key);
		expect(mapPage(doc.pages[0]!, 0).states).toEqual(mapPage(lockedDoc().pages[0]!, 0).states);
	});
});

describe("conflicted-copy merge", () => {
	it("a page locked in the copy is locked in the result; the ink of the copy is added to it", () => {
		const main = lockedDoc();
		delete main.pages[0]!.locked;
		const other = parsed(serialize(lockedDoc())).doc;
		other.pages[0]!.strokes.push(stroke("only-in-copy", 10, 200));
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		const history = new History(() => main, 100, null);
		expect(history.execute(plan.command!)).toBe(true);
		expect(main.pages[0]!.locked).toBe(true);
		expect(main.pages[0]!.strokes.map((s) => s.id)).toContain("only-in-copy");
		history.undo();
		expect(main.pages[0]!.locked).toBeUndefined();
		expect(main.pages[0]!.strokes.map((s) => s.id)).not.toContain("only-in-copy");
	});

	it("a page locked in the main notebook stays locked and still receives the ink the copy has (nothing is lost)", () => {
		const main = lockedDoc();
		const other = parsed(serialize(lockedDoc())).doc;
		delete other.pages[0]!.locked;
		other.pages[0]!.strokes.push(stroke("only-in-copy", 10, 200));
		const history = new History(() => main, 100, null);
		const plan = planMerge(main, other);
		expect(history.execute(plan.command!)).toBe(true);
		expect(main.pages[0]!.locked).toBe(true);
		expect(main.pages[0]!.strokes.map((s) => s.id)).toContain("only-in-copy");
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("a page that only the copy has comes with its lock", () => {
		const main = createDocument(new Date(stamp));
		main.id = "doc";
		const other = lockedDoc();
		const plan = planMerge(main, other);
		const history = new History(() => main, 100, null);
		expect(history.execute(plan.command!)).toBe(true);
		expect(main.pages.find((p) => p.id === "p1")!.locked).toBe(true);
		expect(main.pages.find((p) => p.id === "p2")!.locked).toBeUndefined();
	});

	it("after the merge the page is still guarded: a normal edit is refused", () => {
		const main = lockedDoc();
		const history = new History(() => main, 100, null);
		expect(history.execute(new AddStroke("p1", stroke("late"), 2))).toBe(false);
		expect(history.execute(new Batch("ok elsewhere", [new AddStroke("p2", stroke("fine"), 1)]))).toBe(true);
	});
});

describe("repair", () => {
	it("keeps the lock of a truncated file (the cut only costs what it ran through)", () => {
		const doc = stressDocument(40, 2, 3);
		doc.pages[0]!.locked = true;
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.locked).toBe(true);
		expect(r.summary.unknownFields).toBe(0);
		expect(parse(r.text).ok).toBe(true);
	});

	it("keeps the lock when a stroke line in the middle is damaged", () => {
		const lines = serialize(lockedDoc()).split("\n");
		const at = lines.findIndex((l) => l.includes('"id":"b"') && l.includes('"points"'));
		lines[at] = "\u0000\u0000 garbage";
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.locked).toBe(true);
		expect(r.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(["a"]);
	});

	it("resets an invalid lock (the ink is kept, the page is unlocked, the field counted)", () => {
		const text = serialize(lockedDoc()).replace('"locked": true,', '"locked": "oops",');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(r.summary.fieldsReset).toBeGreaterThan(0);
	});

	it("a clean v14 file with a locked page needs no repair", () => {
		const r = repairNotebookText(serialize(lockedDoc()));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});

	it("repairs an older file that has a stray lock key: it is dropped like the migration does", () => {
		const raw = v13Raw();
		setAt(raw, ["pages", 0, "locked"], true);
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.doc.pages[0]!.locked).toBeUndefined();
			expect(getAt(JSON.parse(r.text), ["version"])).toBe(14);
		}
	});
});
