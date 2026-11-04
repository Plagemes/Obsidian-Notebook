/**
 * Format v16: margin comments (#86) — the page field `comments`, the v15 -> v16 migration, lenient read and strict write,
 * staged loading, repair, the history commands and the page-lock guard, copies and moves, merge of a conflicted copy.
 */
import { describe, expect, it } from "vitest";
import { planPageMove } from "../src/library/page-move";
import {
	addCommentCommand, addReplyCommand, commentCounts, createComment, createReply, deleteCommentCommand, editedComment, editedReply, mergeComments,
	conflictId, notesOf, orderedNotes, regionFromBounds, regionFromDrag, repliesOf, replaceCommentCommand, resolvedComment, SetPageComments, shiftComments, threadsOf,
} from "../src/model/comments";
import { clampRegion, commentLine, normalizeComments, readComments } from "../src/model/comments-format";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History, SetPageMargins } from "../src/model/history";
import { mergeCovers, mergeChangeCount, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { SetPageLocked } from "../src/model/page-lock";
import { planPageRestore } from "../src/model/page-restore";
import { addEntry, emptyPageTrash, makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { duplicatePage } from "../src/model/pages";
import { buildPracticePage } from "../src/model/practice";
import { documentFromTemplate, pageFromTemplate, templateDocument } from "../src/model/templates";
import { planTransfer } from "../src/model/notebook-transfer";
import { repairNotebookText } from "../src/model/repair";
import { freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { COMMENT_ID_MAX, COMMENT_SKETCH_H, COMMENT_SKETCH_W, COMMENT_TEXT_MAX, CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type PageComment, type Stroke } from "../src/model/types";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-04T10:00:00.000Z";
const T0 = 1_760_000_000_000;

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x = 10, y = 10): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 40, y, 0.5], [x + 40, y + 20, 0.5]]), id });
}

function v15Raw(): Raw {
	return {
		format: FORMAT_ID, version: 15, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }],
		}],
	};
}

/** A document with two pages; the first has a comment with two replies, a resolved one and a sketch. */
function commentedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push(stroke("a"), stroke("b", 10, 80));
	const p2 = createPage();
	p2.id = "p2";
	p2.strokes.push(stroke("c"));
	doc.pages.push(p2);
	const one = createComment(p1, { region: { x: 20, y: 40, width: 120, height: 60 }, text: "Check this line\nsecond line", author: "Tablet", now: T0 })!;
	p1.comments = [one];
	const r1 = createReply(p1, one.id, "Done, see the next page", "Phone", T0 + 1000)!;
	p1.comments = [one, r1];
	const r2 = createReply(p1, one.id, "Thanks", "Tablet", T0 + 2000)!;
	const two = createComment({ ...p1, comments: [one, r1, r2] }, {
		region: { x: 300, y: 400, width: 100, height: 40 }, text: "", sketch: { strokes: [[10, 10, 100, 60, 200, 20]] }, author: "Tablet", now: T0 + 3000,
	})!;
	p1.comments = [one, r1, r2, resolvedComment(two, true, T0 + 4000)!];
	return doc;
}

describe("format v16: migration", () => {
	it("has the v15 step (the current format is v16 since margin comments)", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(16);
		expect(MIGRATIONS[15]).toBeTypeOf("function");
	});

	it("reads a v15 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v15Raw()));
		expect(r.migratedFrom).toBe(15);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.comments).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("drops a stray comments key of a v15 file: a v15 reader never kept comments, so neither does the migration", () => {
		const raw = v15Raw();
		setAt(raw, ["pages", 0, "comments"], [{ id: "c", region: { x: 1, y: 1, width: 50, height: 50 }, text: "x", author: "a", created: 1 }]);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.comments).toBeUndefined();
		expect("comments" in r.doc.pages[0]!).toBe(false);
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v15 round trip: v15 text -> v16 document -> text has no comments and the same ink", () => {
		const text = serialize(parsed(JSON.stringify(v15Raw())).doc);
		expect(text).toContain(`"version": ${CURRENT_VERSION}`);
		expect(text).not.toContain('"comments"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("is refused by 0.17 and older as a newer format (they read up to v15, so v16 opens read-only and is never overwritten)", () => {
		const text = serialize(commentedDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		expect(serialize(commentedDoc())).toContain(`"version": ${CURRENT_VERSION}`);
	});
});

describe("format v16: write and read", () => {
	it("round-trips comments byte for byte, one per line before the ink", () => {
		const doc = commentedDoc();
		const text = serialize(doc);
		expect(text).toContain('\t\t\t"comments": [\n\t\t\t\t{"id":');
		expect(text.split('"comments"').length).toBe(2);
		const back = parsed(text).doc;
		expect(back.pages[0]!.comments).toHaveLength(4);
		expect(back.pages[1]!.comments).toBeUndefined();
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
		expect(text.indexOf('"comments"')).toBeLessThan(text.indexOf('"strokes"'));
	});

	it("keeps typed text, sketch, author, times, the resolved flag and the reply link", () => {
		const back = parsed(serialize(commentedDoc())).doc.pages[0]!;
		const [one, r1, r2, two] = back.comments!;
		expect(one).toMatchObject({ text: "Check this line\nsecond line", author: "Tablet", created: T0, region: { x: 20, y: 40, width: 120, height: 60 } });
		expect(r1).toMatchObject({ parent: one!.id, text: "Done, see the next page", author: "Phone", created: T0 + 1000 });
		expect(r2).toMatchObject({ parent: one!.id });
		expect(two).toMatchObject({ resolved: true, text: "", sketch: { strokes: [[10, 10, 100, 60, 200, 20]] } });
		expect((two as { edited?: number }).edited).toBe(T0 + 4000);
	});

	it("writes nothing for a page without comments and leaves other pages' bytes alone", () => {
		const a = commentedDoc();
		const b = commentedDoc();
		delete b.pages[0]!.comments;
		const textA = serialize(a).replace(/\t\t\t"comments": \[\n(\t\t\t\t\{.*\n?)+\t\t\t\],\n/, "");
		expect(textA).toBe(serialize(b));
	});

	it("an empty list is no list", () => {
		const doc = commentedDoc();
		doc.pages[0]!.comments = [];
		expect(serialize(doc)).not.toContain('"comments"');
	});

	it("reads invalid comments leniently (dropped and counted, the page stays) and refuses them strictly", () => {
		const raw = JSON.parse(serialize(commentedDoc())) as Raw;
		setAt(raw, ["pages", 0, "comments", 0, "created"], "yesterday");
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBeGreaterThanOrEqual(1);
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(() => validate(raw)).toThrow(/comments/);
	});

	it("moves a region outside the page back inside when reading (lenient) and refuses it strictly", () => {
		const raw = JSON.parse(serialize(commentedDoc())) as Raw;
		setAt(raw, ["pages", 0, "comments", 0, "region"], { x: 590, y: 790, width: 120, height: 60 });
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(1);
		expect(r.doc.pages[0]!.comments![0]).toMatchObject({ region: { x: 475.2, y: 781.8, width: 120, height: 60 } });
		expect(() => validate(raw)).toThrow(/region/);
	});

	it("promotes a reply whose comment is gone to a comment of its own (no typed text is lost) and counts it", () => {
		const raw = JSON.parse(serialize(commentedDoc())) as Raw;
		const list = getAt<Raw[]>(raw, ["pages", 0, "comments"]);
		setAt(raw, ["pages", 0, "comments"], list.filter((c) => c.parent === undefined ? c.text !== "Check this line\nsecond line" : true));
		const r = parsed(JSON.stringify(raw));
		const notes = notesOf(r.doc.pages[0]!);
		expect(r.dropped).toBeGreaterThanOrEqual(2);
		expect(notes.map((n) => n.text)).toEqual(expect.arrayContaining(["Done, see the next page", "Thanks"]));
		// the result is valid strictly
		expect(() => validate(JSON.parse(serialize(r.doc)))).not.toThrow();
	});

	it("attaches a reply to a reply to the comment of the first one (the thread is flat)", () => {
		const doc = commentedDoc();
		const p = doc.pages[0]!;
		const one = notesOf(p).find((n) => n.text.startsWith("Check"))!;
		const r1 = repliesOf(p, one.id)[0]!;
		const deep = { id: "deep", parent: r1.id, text: "Reply to a reply", author: "Phone", created: T0 + 5000 };
		const { comments, problems } = readComments([...p.comments!, deep], p);
		expect(problems).toHaveLength(1);
		expect(comments.find((c) => c.id === "deep")).toMatchObject({ parent: one.id });
	});

	it("drops repeated ids, cuts over-long text, keeps the first COMMENTS_MAX items", () => {
		const page = createPage();
		const base = { region: { x: 1, y: 1, width: 40, height: 40 }, text: "x", author: "a", created: 5 };
		const dup = readComments([{ id: "a", ...base }, { id: "a", ...base }], page);
		expect(dup.comments).toHaveLength(1);
		expect(dup.problems).toHaveLength(1);
		const long = readComments([{ id: "a", ...base, text: "y".repeat(COMMENT_TEXT_MAX + 50) }], page);
		expect(long.comments[0]!.text).toHaveLength(COMMENT_TEXT_MAX);
		expect(long.problems).toHaveLength(1);
		const many = readComments(Array.from({ length: 1100 }, (_, i) => ({ id: `c${i}`, ...base })), page);
		expect(many.comments).toHaveLength(1000);
	});

	it("keeps only the valid strokes of a sketch, rounds and bounds its points", () => {
		const page = createPage();
		const base = { id: "a", region: { x: 1, y: 1, width: 40, height: 40 }, text: "x", author: "a", created: 5 };
		const { comments, problems } = readComments([{ ...base, sketch: { strokes: [[1.4, 2.6, COMMENT_SKETCH_W + 50, COMMENT_SKETCH_H + 9], [1], "no", [3, 3, 4, 4]] } }], page);
		expect(problems.length).toBeGreaterThanOrEqual(2);
		expect((comments[0] as { sketch: { strokes: number[][] } }).sketch.strokes).toEqual([[1, 3, COMMENT_SKETCH_W, COMMENT_SKETCH_H], [3, 3, 4, 4]]);
	});

	it("writes what it reads: normalizeComments is idempotent and fixes a region outside the page", () => {
		const page = createPage();
		const outside = [{ id: "a", region: { x: -5, y: 5000, width: 30, height: 30 }, text: "x", author: "a", created: 5 }] as PageComment[];
		const once = normalizeComments(outside, page)!;
		expect(once[0]).toMatchObject({ region: { x: 0, y: 811.8, width: 30, height: 30 } });
		expect(normalizeComments(once, page)!.map(commentLine)).toEqual(once.map(commentLine));
		expect(normalizeComments(undefined, page)).toBeUndefined();
	});

	it("clampRegion keeps a region inside a page and at least the minimum side", () => {
		const page = { width: 100, height: 100 };
		expect(clampRegion({ x: 90, y: 90, width: 50, height: 2 }, page)).toEqual({ x: 50, y: 90, width: 50, height: 4 });
		expect(clampRegion({ x: -4, y: -4, width: 500, height: 500 }, page)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it("the writer repairs an in-memory region outside the page rather than refusing the save", () => {
		const doc = commentedDoc();
		doc.pages[0]!.width = 100;
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) {
			const back = parsed(checked.text).doc.pages[0]!;
			for (const n of notesOf(back)) expect(n.region.x + n.region.width).toBeLessThanOrEqual(100);
		}
	});

	it("keeps comments through a large document's skeleton check (the full check is skipped above its limit)", () => {
		const doc = stressDocument(6000, 3, 7);
		const p = doc.pages[1]!;
		p.comments = [createComment(p, { region: { x: 10, y: 10, width: 50, height: 50 }, text: "big", author: "T", now: T0 })!];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(1_000_000);
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(parsed(checked.text).doc.pages.map((q) => q.comments?.length ?? 0)).toEqual([0, 1, 0]);
	});
});

describe("format v16: staged loading", () => {
	it("stages a large v15 file, ignoring a stray comments key page by page", () => {
		const doc = stressDocument(6000, 3, 7);
		let v15 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 15`);
		v15 = v15.replace('"infinite"', '"comments": [{"x":1}],\n\t\t\t"infinite"');
		expect(v15.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v15, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(15);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.comments === undefined)).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("stages a large v16 file with comments and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		const p = doc.pages[2]!;
		p.comments = [createComment(p, { region: { x: 10, y: 10, width: 50, height: 50 }, text: "later page", author: "T", now: T0 })!];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
	});
});

describe("format v16: repair", () => {
	it("recovers the comments of a file cut off after them, from the page lines", () => {
		const text = serialize(commentedDoc());
		const cut = text.slice(0, text.indexOf('			"strokes"', text.indexOf('"comments"')) + 60);
		const r = repairNotebookText(cut);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.pages[0]!.comments).toHaveLength(4);
	});

	it("repairs a region outside the page and an orphan reply, counting them, and the result is a valid file", () => {
		const raw = JSON.parse(serialize(commentedDoc())) as Raw;
		const list = getAt<Raw[]>(raw, ["pages", 0, "comments"]);
		list[0] = { ...list[0], region: { x: 9000, y: 9000, width: 10, height: 10 } };
		list.push({ id: "orphan", parent: "nothing", text: "alone", author: "x", created: 5 });
		setAt(raw, ["pages", 0, "comments"], list);
		// Break the JSON so that the strict parse fails: an extra key makes the validator unhappy through the last stroke
		const broken = JSON.stringify(raw, null, "\t").replace('"tool": "pen"', '"tool": "zzz"');
		const r = repairNotebookText(broken);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const p = r.doc.pages[0]!;
			expect(notesOf(p).some((n) => n.text === "alone")).toBe(true);
			for (const n of notesOf(p)) {
				expect(n.region.x + n.region.width).toBeLessThanOrEqual(p.width);
				expect(n.region.y + n.region.height).toBeLessThanOrEqual(p.height);
			}
			expect(parse(r.text).ok).toBe(true);
		}
	});

	it("reads a readable v16 file as it is (nothing to repair)", () => {
		const r = repairNotebookText(serialize(commentedDoc()));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});
});

describe("comments: commands and the page lock", () => {
	it("one undo step each: add, reply, edit, resolve, delete", () => {
		const doc = createDocument(new Date(stamp));
		const history = new History(() => doc, 100, null);
		const page = doc.pages[0]!;
		const note = createComment(page, { region: { x: 10, y: 10, width: 50, height: 50 }, text: "first", author: "Tablet", now: T0 })!;
		expect(history.execute(addCommentCommand(page, note)!)).toBe(true);
		expect(page.comments).toEqual([note]);
		const reply = createReply(page, note.id, "second", "Phone", T0 + 10)!;
		expect(history.execute(addReplyCommand(page, reply)!)).toBe(true);
		const edited = editedComment(note, { text: "first, changed" }, T0 + 20)!;
		expect(history.execute(replaceCommentCommand(page, note.id, edited, "Edit comment")!)).toBe(true);
		expect(notesOf(page)[0]!.text).toBe("first, changed");
		const resolved = resolvedComment(edited, true, T0 + 30)!;
		expect(history.execute(replaceCommentCommand(page, note.id, resolved, "Resolve comment")!)).toBe(true);
		expect(commentCounts(doc)).toEqual({ open: 0, resolved: 1, total: 1 });
		expect(history.execute(deleteCommentCommand(page, note.id)!)).toBe(true);
		expect(page.comments).toBeUndefined();
		// undo walks back exactly one step at a time
		history.undo();
		expect(page.comments).toHaveLength(2);
		history.undo();
		expect(notesOf(page)[0]!.resolved).toBeUndefined();
		history.undo();
		expect(notesOf(page)[0]!.text).toBe("first");
		history.undo();
		expect(page.comments).toEqual([note]);
		history.undo();
		expect(page.comments).toBeUndefined();
		history.redo();
		expect(page.comments).toEqual([note]);
	});

	it("deleting a comment deletes its replies; deleting a reply leaves the comment", () => {
		const doc = commentedDoc();
		const p = doc.pages[0]!;
		const one = notesOf(p).find((n) => n.text.startsWith("Check"))!;
		const r1 = repliesOf(p, one.id)[0]!;
		const history = new History(() => doc, 100, null);
		history.execute(deleteCommentCommand(p, r1.id)!);
		expect(repliesOf(p, one.id)).toHaveLength(1);
		history.execute(deleteCommentCommand(p, one.id)!);
		expect(p.comments!.every((c) => c.id !== one.id && !("parent" in c))).toBe(true);
		expect(p.comments).toHaveLength(1);
	});

	it("a locked page refuses every comment edit and keeps its comments; unlocked, they work (and one lock step is undoable)", () => {
		const doc = commentedDoc();
		const p = doc.pages[0]!;
		p.locked = true;
		const refused: string[][] = [];
		const history = new History(() => doc, 100, null, null, null, (ids) => refused.push([...ids]));
		const before = p.comments;
		const note = createComment(p, { region: { x: 5, y: 5, width: 20, height: 20 }, text: "late", author: "T", now: T0 + 9 })!;
		expect(history.execute(addCommentCommand(p, note)!)).toBe(false);
		expect(p.comments).toBe(before);
		expect(refused).toEqual([["p1"]]);
		expect(history.execute(deleteCommentCommand(p, before![0]!.id)!)).toBe(false);
		expect(history.execute(new SetPageLocked("p1", false))).toBe(true);
		expect(history.execute(addCommentCommand(p, note)!)).toBe(true);
		expect(p.comments).toHaveLength(5);
	});

	it("is a no-op for a missing page and when a command finds nothing to do", () => {
		const doc = createDocument(new Date(stamp));
		new SetPageComments("nope", undefined, []).apply(doc);
		expect(doc.pages[0]!.comments).toBeUndefined();
		const page = doc.pages[0]!;
		expect(deleteCommentCommand(page, "x")).toBeNull();
		expect(replaceCommentCommand(page, "x", {} as PageComment, "x")).toBeNull();
		expect(createComment(page, { region: { x: 1, y: 1, width: 10, height: 10 }, text: "  ", author: "a", now: 1 })).toBeNull();
		expect(createReply(page, "none", "hi", "a", 1)).toBeNull();
	});

	it("a resolve or an edit is an edit: its time is after the one it replaces, even with a slow clock", () => {
		const page = createPage();
		const note = createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: "x", author: "a", now: T0 })!;
		expect(resolvedComment(note, true, T0 - 5000)!.edited).toBe(T0 + 1);
		expect(resolvedComment(note, false, T0)).toBeNull();
		expect(editedComment(note, { text: "x" }, T0)).toBeNull();
		expect(editedReply({ id: "r", parent: note.id, text: "t", author: "a", created: 5 }, "t2", 1)!.edited).toBe(6);
	});

	it("orders the markers top to bottom and lists threads by page with a filter", () => {
		const doc = commentedDoc();
		const p = doc.pages[0]!;
		expect(orderedNotes(p).map((n) => n.region.y)).toEqual([40, 400]);
		expect(threadsOf(doc, "all").map((t) => [t.pageIndex, t.number, t.replies.length])).toEqual([[0, 1, 2], [0, 2, 0]]);
		expect(threadsOf(doc, "open")).toHaveLength(1);
		expect(threadsOf(doc, "resolved")).toHaveLength(1);
	});

	it("builds a region from a selection (padded, inside the page) and from a drag", () => {
		const page = { width: 600, height: 800 };
		expect(regionFromBounds({ minX: 10, minY: 10, maxX: 30, maxY: 20 }, page)).toEqual({ x: 4, y: 4, width: 32, height: 22 });
		expect(regionFromDrag([100, 100], [50, 70], page)).toEqual({ x: 50, y: 70, width: 50, height: 30 });
	});
});

describe("comments and the page margins", () => {
	it("widening the left margin moves the comments with the ink; undo puts the very same list back", () => {
		const doc = commentedDoc();
		const p = doc.pages[0]!;
		const before = p.comments;
		const cmd = new SetPageMargins("p1", undefined, { left: 30, right: 0, bottom: 0 });
		cmd.apply(doc);
		expect(notesOf(p)[0]!.region.x).toBe(50);
		cmd.revert(doc);
		expect(p.comments).toBe(before);
		expect(shiftComments(before!, 0)).toBe(before);
	});
});

describe("comments: copies, moves, restore, templates", () => {
	it("a duplicated page keeps its comments (new page, same thread ids)", () => {
		const doc = commentedDoc();
		const copy = duplicatePage(doc.pages[0]!);
		expect(copy.comments).toHaveLength(4);
		expect(copy.comments!.map(commentLine)).toEqual(doc.pages[0]!.comments!.map(commentLine));
		expect(copy.comments).not.toBe(doc.pages[0]!.comments);
	});

	it("moving or copying pages to another notebook keeps their comments", () => {
		const doc = commentedDoc();
		const plan = planPageMove(doc, ["p1"], createDocument(new Date(stamp)));
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(plan.pages[0]!.comments).toHaveLength(4);
		const target = createDocument(new Date(stamp));
		for (const mode of ["move", "copy"] as const) {
			const t = planTransfer(doc, ["p1"], target, mode);
			expect("pages" in t && t.pages[0]!.comments?.length).toBe(4);
		}
	});

	it("a page trash entry keeps the comments the page had", () => {
		const doc = commentedDoc();
		const trash = addEntry(emptyPageTrash("doc"), makeEntry(doc, doc.pages[0]!, 0, Date.now()), Date.now());
		const other = createDocument(new Date(stamp));
		const plan = planPageTrashRestore(other, trash.entries[0]!)!;
		plan.command.apply(other);
		expect(other.pages[plan.pageIndex]!.comments).toHaveLength(4);
	});

	it("restoring a version over a page joins the comments of both: a comment written since is not lost, the later edit wins", () => {
		const doc = commentedDoc();
		const old = parsed(serialize(doc)).doc;
		const p = doc.pages[0]!;
		const extra = createComment(p, { region: { x: 5, y: 5, width: 20, height: 20 }, text: "written since", author: "T", now: T0 + 50_000 })!;
		const first = notesOf(p).find((n) => n.text.startsWith("Check"))!;
		p.comments = p.comments!.map((c) => (c.id === first.id ? editedComment(first, { text: "edited since" }, T0 + 60_000)! : c)).concat(extra);
		const plan = planPageRestore(doc, old, 0, 0, "replace")!;
		plan.command.apply(doc);
		const texts = notesOf(doc.pages[0]!).map((n) => n.text);
		expect(texts).toContain("written since");
		expect(texts).toContain("edited since");
	});

	it("a notebook made into a template, or from one, carries no comments", () => {
		const doc = commentedDoc();
		expect(templateFromNotebook(doc).pages.every((p) => p.comments === undefined)).toBe(true);
		expect(notebookFromTemplate(doc).pages.every((p) => p.comments === undefined)).toBe(true);
		expect(notebookFromTemplate(doc, { content: false }).pages.every((p) => p.comments === undefined)).toBe(true);
	});
});

describe("comments: merging a conflicted copy", () => {
	function twoDevices() {
		const base = commentedDoc();
		const a = parsed(serialize(base)).doc;
		const b = parsed(serialize(base)).doc;
		return { a, b };
	}

	it("two devices adding comments and replies both keep theirs", () => {
		const { a, b } = twoDevices();
		const pa = a.pages[0]!;
		const pb = b.pages[0]!;
		const first = notesOf(pa).find((n) => n.text.startsWith("Check"))!;
		pa.comments = [...pa.comments!, createComment(pa, { region: { x: 5, y: 600, width: 20, height: 20 }, text: "from A", author: "A", now: T0 + 70_000 })!];
		pa.comments = [...pa.comments, createReply(pa, first.id, "reply from A", "A", T0 + 71_000)!];
		pb.comments = [...pb.comments!, createComment(pb, { region: { x: 5, y: 700, width: 20, height: 20 }, text: "from B", author: "B", now: T0 + 72_000 })!];
		pb.comments = [...pb.comments, createReply(pb, first.id, "reply from B", "B", T0 + 73_000)!];
		const plan = planMerge(a, b);
		expect(plan.command).not.toBeNull();
		expect(plan.summary.commentsAdded).toBe(2);
		expect(mergeChangeCount(plan.summary)).toBeGreaterThan(0);
		plan.command!.apply(a);
		const texts = (a.pages[0]!.comments ?? []).map((c) => c.text);
		for (const t of ["from A", "from B", "reply from A", "reply from B", "Thanks"]) expect(texts).toContain(t);
		expect(a.pages[0]!.comments).toHaveLength(8);
		expect(mergeCovers(a, b)).toBe(true);
		// idempotent: the merge of the same copy again changes nothing
		expect(planMerge(a, b).command).toBeNull();
	});

	it("an edit of the same comment on both: the later edit wins, either way round", () => {
		const { a, b } = twoDevices();
		const first = notesOf(a.pages[0]!).find((n) => n.text.startsWith("Check"))!;
		a.pages[0]!.comments = a.pages[0]!.comments!.map((c) => (c.id === first.id ? editedComment(first, { text: "A edit" }, T0 + 80_000)! : c));
		b.pages[0]!.comments = b.pages[0]!.comments!.map((c) => (c.id === first.id ? editedComment(first, { text: "B edit (later)" }, T0 + 90_000)! : c));
		const a2 = parsed(serialize(a)).doc;
		const b2 = parsed(serialize(b)).doc;
		planMerge(a, b).command!.apply(a);
		expect(notesOf(a.pages[0]!).find((n) => n.id === first.id)!.text).toBe("B edit (later)");
		// merging the other way round: B already has the later edit, A's older edit does not replace it
		const plan = planMerge(b2, a2);
		if (plan.command) plan.command.apply(b2);
		expect(notesOf(b2.pages[0]!).find((n) => n.id === first.id)!.text).toBe("B edit (later)");
	});

	it("a comment resolved on the other device after the last edit here comes back resolved", () => {
		const { a, b } = twoDevices();
		const two = notesOf(b.pages[0]!).find((n) => n.resolved)!;
		b.pages[0]!.comments = b.pages[0]!.comments!.map((c) => (c.id === two.id ? resolvedComment(two, false, T0 + 99_000)! : c));
		planMerge(a, b).command!.apply(a);
		expect(notesOf(a.pages[0]!).find((n) => n.id === two.id)!.resolved).toBeUndefined();
	});

	it("a page only the copy has comes with its comments, and the merge goes through a locked page", () => {
		const { a, b } = twoDevices();
		const extra = createPage();
		extra.id = "p3";
		extra.comments = [createComment(extra, { region: { x: 5, y: 5, width: 20, height: 20 }, text: "new page", author: "B", now: T0 + 5000 })!];
		b.pages.push(extra);
		a.pages[0]!.locked = true;
		const pb = b.pages[0]!;
		pb.comments = [...pb.comments!, createComment(pb, { region: { x: 5, y: 500, width: 20, height: 20 }, text: "on a locked page", author: "B", now: T0 + 6000 })!];
		const history = new History(() => a, 100, null);
		expect(history.execute(planMerge(a, b).command!)).toBe(true);
		expect(a.pages.find((p) => p.id === "p3")!.comments).toHaveLength(1);
		expect(a.pages[0]!.comments!.some((c) => c.text === "on a locked page")).toBe(true);
	});

	it("mergeComments: items one side has are kept, nothing is deleted, the main side wins a tie", () => {
		const page = createPage();
		const x = createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: "x", author: "a", now: 100 })!;
		const y = createComment(page, { region: { x: 1, y: 60, width: 40, height: 40 }, text: "y", author: "a", now: 200 })!;
		expect(mergeComments([x], [y]).list).toEqual([x, y]);
		expect(mergeComments([x, y], [x]).list).toEqual([x, y]);
		expect(mergeComments([x], undefined).list).toEqual([x]);
		const tie = { ...x, text: "other" };
		// the main side stays the comment on a tie; the other text is kept beside it, marked
		expect(mergeComments([x], [tie]).list).toEqual([x, expect.objectContaining({ text: "⚠ other" })]);
		expect(mergeComments([x], [tie], { conflicts: false }).list).toEqual([x]);
		expect(mergeComments(undefined, [x]).added).toBe(1);
	});

	it("a merge never loses a comment to the COMMENTS_MAX cap silently beyond the cap", () => {
		const page = createPage();
		const many = Array.from({ length: 1000 }, (_, i) => createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: `n${i}`, author: "a", now: 1000 + i })!);
		const extra = createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: "one more", author: "a", now: 99_999 })!;
		expect(mergeComments(many, [extra]).list).toHaveLength(1000);
	});
});

describe("comments: edits that lose a merge are kept, templates and practice carry no threads, restore and merge frames", () => {
	function twoDevices() {
		const base = commentedDoc();
		return { a: parsed(serialize(base)).doc, b: parsed(serialize(base)).doc };
	}
	const firstOf = (doc: NotebookDocument) => notesOf(doc.pages[0]!).find((n) => n.region.x === 20 && n.region.y === 40)!;
	const editNote = (doc: NotebookDocument, text: string, at: number) => {
		const first = firstOf(doc);
		doc.pages[0]!.comments = doc.pages[0]!.comments!.map((c) => (c.id === first.id ? editedComment(first, { text }, at)! : c));
	};

	it("the same comment edited on both devices: the later text stays, the other is kept as a marked comment, counted, covered, and not added twice", () => {
		const { a, b } = twoDevices();
		editNote(a, "A edit", T0 + 80_000);
		editNote(b, "B edit (later)", T0 + 90_000);
		const a2 = parsed(serialize(a)).doc;
		const b2 = parsed(serialize(b)).doc;
		const plan = planMerge(a, b);
		expect(plan.summary.commentsAdded).toBe(2); // the later edit taken + the losing one kept
		plan.command!.apply(a);
		const notes = notesOf(a.pages[0]!);
		const first = notes.find((n) => n.id === firstOf(b).id)!;
		expect(first.text).toBe("B edit (later)");
		const lost = notes.find((n) => n.text.endsWith("A edit"))!;
		expect(lost.text.startsWith("⚠")).toBe(true);
		expect(lost.region).toEqual(first.region);
		expect(lost.author).toBe(first.author);
		expect(lost.resolved).toBeUndefined();
		expect(mergeCovers(a, b2)).toBe(true);
		expect(mergeCovers(a, a2)).toBe(true);
		// the same copy again: nothing new
		expect(planMerge(a, b2).command).toBeNull();
		expect(planMerge(a, a2).command).toBeNull();
		// the other way round: the winner is already there, the losing edit is kept, and a merge of the result into either device converges
		const back = planMerge(b2, a2);
		back.command!.apply(b2);
		expect(notesOf(b2.pages[0]!).map((n) => n.text).sort()).toEqual(notesOf(a.pages[0]!).map((n) => n.text).sort());
	});

	it("a result that lacks the losing version is not reported as covering the copy", () => {
		const { a, b } = twoDevices();
		editNote(a, "A edit", T0 + 80_000);
		editNote(b, "B edit (later)", T0 + 90_000);
		const a2 = parsed(serialize(a)).doc;
		expect(mergeCovers(b, a2)).toBe(false);
	});

	it("a reply edited on both devices keeps the losing text as a marked reply of the same thread", () => {
		const { a, b } = twoDevices();
		const reply = repliesOf(a.pages[0]!, firstOf(a).id)[0]!;
		a.pages[0]!.comments = a.pages[0]!.comments!.map((c) => (c.id === reply.id ? editedReply(reply, "A reply edit", T0 + 80_000)! : c));
		b.pages[0]!.comments = b.pages[0]!.comments!.map((c) => (c.id === reply.id ? editedReply(reply, "B reply edit", T0 + 85_000)! : c));
		const b2 = parsed(serialize(b)).doc;
		planMerge(a, b).command!.apply(a);
		const replies = repliesOf(a.pages[0]!, firstOf(a).id);
		expect(replies.map((r) => r.text)).toContain("B reply edit");
		expect(replies.some((r) => r.text.startsWith("⚠") && r.text.endsWith("A reply edit"))).toBe(true);
		expect(mergeCovers(a, b2)).toBe(true);
	});

	it("a stale copy (the other device never edited it) is not a conflict: the edit simply wins", () => {
		const { a, b } = twoDevices();
		editNote(a, "A edit", T0 + 80_000);
		planMerge(a, b).command?.apply(a);
		expect(notesOf(a.pages[0]!).filter((n) => n.text.startsWith("⚠"))).toHaveLength(0);
		expect(firstOf(a).text).toBe("A edit");
		expect(mergeCovers(a, b)).toBe(true);
		// and the copy that edited it replaces the unedited text of the main notebook, again with no marked copy
		const { a: a3, b: b3 } = twoDevices();
		editNote(b3, "B edit", T0 + 80_000);
		planMerge(a3, b3).command!.apply(a3);
		expect(notesOf(a3.pages[0]!).filter((n) => n.text.startsWith("⚠"))).toHaveLength(0);
		expect(firstOf(a3).text).toBe("B edit");
	});

	it("mergeComments: a conflict keeps the sketch of the losing comment, and a restore (conflicts: false) does not", () => {
		const page = createPage();
		const sk = { strokes: [[10, 10, 100, 60]] };
		const x = createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: "", sketch: sk, author: "a", now: 100 })!;
		const mine = editedComment(x, { text: "mine", sketch: sk }, 200)!;
		const theirs = editedComment(x, { text: "", sketch: { strokes: [[20, 20, 90, 90]] } }, 300)!;
		const merged = mergeComments([mine], [theirs]);
		expect(merged.conflicts).toBe(1);
		const kept = merged.list!.find((c) => c.id !== x.id)!;
		expect(kept.text).toBe("⚠ mine");
		expect(mergeComments([mine], [theirs], { conflicts: false }).list!.map((c) => c.id)).toEqual([x.id]);
		const tie = { ...x, text: "other" };
		expect(mergeComments([x], [tie]).list).toHaveLength(2);
	});

	it("save page as template, a page from a template and a notebook from a template carry no comments; duplicating the page keeps them", () => {
		const doc = commentedDoc();
		const page = doc.pages[0]!;
		const template = templateDocument(doc, page);
		expect(template.pages[0]!.comments).toBeUndefined();
		const withThreads = { ...template, pages: [{ ...template.pages[0]!, comments: page.comments }] };
		expect(pageFromTemplate(withThreads)!.page.comments).toBeUndefined();
		expect(documentFromTemplate(withThreads).pages.every((p) => p.comments === undefined)).toBe(true);
		expect(duplicatePage(page).comments).toHaveLength(4);
		// the original is untouched
		expect(page.comments).toHaveLength(4);
	});

	it("a practice attempt does not repeat the review threads of the original", () => {
		const page = commentedDoc().pages[0]!;
		const { page: attempt } = buildPracticePage(page, {}, 1);
		expect(attempt.comments).toBeUndefined();
		expect(page.comments).toHaveLength(4);
	});

	it("restoring a version with other margins moves the page's comments with its background", () => {
		const doc = commentedDoc();
		const old = parsed(serialize(doc)).doc;
		const op = old.pages[0]!;
		op.margins = { left: 100, right: 0, bottom: 0 };
		op.width += 100;
		delete op.comments;
		const before = notesOf(doc.pages[0]!).map((n) => n.region.x);
		const plan = planPageRestore(doc, old, 0, 0, "replace")!;
		plan.command.apply(doc);
		expect(notesOf(doc.pages[0]!).map((n) => n.region.x)).toEqual(before.map((x) => x + 100));
		plan.command.revert(doc);
		expect(notesOf(doc.pages[0]!).map((n) => n.region.x)).toEqual(before);
	});

	it("a merge that enlarges the page keeps the copy's comments that lie in the new part, even if the copy's page is wider", () => {
		const { a, b } = twoDevices();
		const pb = b.pages[0]!;
		pb.width = 900;
		pb.strokes = [...pb.strokes, stroke("far", 800, 100)];
		const far = createComment(pb, { region: { x: 780, y: 100, width: 40, height: 40 }, text: "out on the right", author: "B", now: T0 + 5000 })!;
		pb.comments = [...pb.comments!, far];
		const plan = planMerge(a, b);
		plan.command!.apply(a);
		expect(a.pages[0]!.width).toBeGreaterThanOrEqual(840);
		const placed = notesOf(a.pages[0]!).find((n) => n.text === "out on the right")!;
		expect(placed.region.x).toBe(780);
		expect(mergeCovers(a, b)).toBe(true);
	});
});

describe("comments: marked copies of lost edits keep ids that fit and do not collide", () => {
	const uuid = (tail: string) => `0f3c9a52-77d1-4c0b-9b1e-2a6d${tail}`;
	function note(id: string, text: string, created: number, edited?: number): PageComment {
		return { id, region: { x: 1, y: 1, width: 40, height: 40 }, text, author: "a", created, ...(edited === undefined ? {} : { edited }) };
	}

	it("the id of a marked copy fits the id cap, never cuts the original and differs for ids that only differ at the end", () => {
		const a = note(uuid("00001"), "x", 100, 200);
		const b = note(uuid("00002"), "x", 100, 200);
		expect(conflictId(a).length).toBeLessThanOrEqual(COMMENT_ID_MAX);
		expect(conflictId(a)).not.toBe(conflictId(b));
		expect(conflictId(a)).toBe(conflictId({ ...a }));
		expect(conflictId(note("short", "x", 1))).not.toBe(conflictId(note("short", "x", 2)));
		// the marked copy of a marked copy (same time) is a third id
		const first = conflictId(a);
		expect(conflictId({ ...a, id: first })).not.toBe(first);
		expect(conflictId({ ...a, id: first }).length).toBeLessThanOrEqual(COMMENT_ID_MAX);
	});

	it("two comments whose ids only differ in the last characters each keep their own lost version", () => {
		const a1 = note(uuid("00001"), "mine 1", 100, 200);
		const a2 = note(uuid("00002"), "mine 2", 100, 200);
		const b1 = note(uuid("00001"), "theirs 1", 100, 300);
		const b2 = note(uuid("00002"), "theirs 2", 100, 300);
		const merged = mergeComments([a1, a2], [b1, b2]);
		expect(merged.conflicts).toBe(2);
		expect(merged.list).toHaveLength(4);
		expect(merged.list!.map((c) => c.text).sort()).toEqual(["theirs 1", "theirs 2", "⚠ mine 1", "⚠ mine 2"]);
		for (const c of merged.list!) expect(c.id.length).toBeLessThanOrEqual(COMMENT_ID_MAX);
		// and the whole list survives a write and a read (ids over the cap would be refused or cut)
		const doc = createDocument(new Date(stamp));
		doc.pages[0]!.comments = [...merged.list!];
		expect(notesOf(parsed(serialize(doc)).doc.pages[0]!).map((n) => n.id).sort()).toEqual(merged.list!.map((c) => c.id).sort());
	});

	it("A and B edit, merge into each other both ways, then merge again: the same lists and nothing new", () => {
		const base = note(uuid("00007"), "base", 100);
		const a = [note(base.id, "A text", 100, 200)];
		const b = [note(base.id, "B text", 100, 300)];
		const intoA = mergeComments(a, b).list!;
		const intoB = mergeComments(b, a).list!;
		expect(intoA.map((c) => c.text).sort()).toEqual(intoB.map((c) => c.text).sort());
		expect(intoA.map((c) => c.id).sort()).toEqual(intoB.map((c) => c.id).sort());
		// exchanging the results changes nothing more
		expect(mergeComments(intoA, intoB).conflicts).toBe(0);
		expect(mergeComments(intoA, intoB).added).toBe(0);
		expect(mergeComments(intoB, intoA).list).toBe(intoB);
	});

	it("three devices that edit one comment end up with the same texts whatever the order of the merges", () => {
		const id = uuid("00009");
		const a = [note(id, "A", 100, 200)];
		const b = [note(id, "B", 100, 300)];
		const c = [note(id, "C", 100, 400)];
		const orders = [[a, b, c], [a, c, b], [b, a, c], [c, b, a]];
		const results = orders.map(([x, y, z]) => {
			const first = mergeComments(x, y).list!;
			return mergeComments(first, z).list!.map((i) => i.text).sort();
		});
		for (const r of results) expect(r).toEqual(["C", "⚠ A", "⚠ B"]);
	});

	it("a comment that one device only resolved and the other edited the text of is not copied when the texts are the same", () => {
		const base = note(uuid("00011"), "same text", 100);
		const resolvedOnA = { ...base, resolved: true as const, edited: 250 };
		const editedOnB = { ...base, edited: 300 };
		const merged = mergeComments([resolvedOnA], [editedOnB]);
		expect(merged.conflicts).toBe(0);
		expect(merged.list).toHaveLength(1);
		// the later action wins as a whole
		expect(merged.list![0]!.edited).toBe(300);
		expect(merged.list![0]!.resolved).toBeUndefined();
	});
});
