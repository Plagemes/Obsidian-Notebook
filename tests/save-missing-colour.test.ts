import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repairLiveDocument, repairNotebookText } from "../src/model/repair";
import { History, RemoveElement } from "../src/model/history";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument, PageElement, Stroke } from "../src/model/types";
import { DocumentSession, backupText, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

/** An item whose colour was never set: what the harness fixture of the marked view built (a checkbox with no colour). */
function colourless<T extends Stroke | PageElement>(item: T, frozen = true): T {
	const copy = { ...item } as Record<string, unknown>;
	delete copy.color;
	return (frozen ? Object.freeze(copy) : copy) as unknown as T;
}

const BOX: CheckboxElement = { id: "c1", type: "checkbox", x: 40, y: 200, size: 20, color: "#1f2430" };
const ELEMENTS: PageElement[] = [
	BOX,
	{ id: "a1", type: "area", x: 10, y: 10, width: 100, height: 40, color: "#facc15" },
	{ id: "t1", type: "text", x: 10, y: 60, width: 200, text: "Hello", fontSize: 18, color: "#222222" },
	{ id: "k1", type: "sticky", x: 10, y: 100, width: 80, height: 80, color: "#F59E0B", fontSize: 14 },
	{ id: "e1", type: "equation", x: 10, y: 300, width: 80, height: 30, latex: "x^2", fontSize: 20, color: "#000000" },
];

function docWith(element: PageElement | null, stroke: Stroke | null = null): NotebookDocument {
	const doc = sampleDocument(0);
	if (element) doc.pages[0]!.elements = [element];
	if (stroke) doc.pages[0]!.strokes.push(stroke);
	return doc;
}

describe("the writer never emits undefined", () => {
	it.each(ELEMENTS.map((e) => [e.type, e] as const))("a %s without a colour is refused with a clear message before any text is built", (_, element) => {
		const doc = docWith(colourless(element));
		const out = serializeChecked(doc);
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.message).toContain(`${element.type} ${element.id}.color`);
		expect(out.message).not.toContain("invalid JSON");
		expect(() => serialize(doc)).toThrow(/colour/);
	});

	it("a stroke without a colour is refused the same way", () => {
		const doc = docWith(null, colourless(line(0, 0, 50, 50)));
		const out = serializeChecked(doc);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.message).toMatch(/stroke .*\.color/);
	});

	it("a valid document still round-trips", () => {
		const doc = docWith(BOX, line(0, 0, 50, 50));
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.text).not.toContain("undefined");
	});
});

describe("a document in memory with a missing colour gets one, on the same object", () => {
	it.each(ELEMENTS.map((e) => [e.type, e] as const))("%s: the same object, with a valid colour, and the document can be written", (_, element) => {
		const item = colourless(element, false);
		const stroke = colourless(line(0, 0, 50, 50), false);
		const doc = docWith(item, stroke);
		expect(repairLiveDocument(doc)).toBe(2);
		expect(doc.pages[0]!.elements![0]).toBe(item);
		expect(doc.pages[0]!.strokes[0]).toBe(stroke);
		expect((item as PageElement & { color: string }).color).toMatch(/^#[0-9a-fA-F]{6}$/);
		expect(stroke.color).toBe("#000000");
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (out.ok) expect(parse(out.text).ok).toBe(true);
	});

	it("also fills a colour that is not a #rrggbb string", () => {
		const item = { ...BOX, color: "red" };
		const doc = docWith(item);
		expect(repairLiveDocument(doc)).toBe(1);
		expect(item.color).toBe("#1f2430");
	});

	it("changes nothing else, and leaves a good document, a frozen item and other damage alone", () => {
		expect(repairLiveDocument(docWith(BOX))).toBe(0);
		const frozen = colourless(BOX);
		const stuck = docWith(frozen);
		expect(repairLiveDocument(stuck)).toBe(0);
		expect(stuck.pages[0]!.elements![0]).toBe(frozen);
		expect(frozen).not.toHaveProperty("color");
		expect(serializeChecked(stuck).ok).toBe(false);
		const ticked = colourless({ ...BOX, checked: true as const }, false);
		const other = docWith(ticked);
		other.pages[0]!.id = "";
		repairLiveDocument(other);
		expect(ticked).toMatchObject({ id: "c1", x: 40, y: 200, size: 20, checked: true });
		expect(serializeChecked(other).ok).toBe(false);
	});

	it("undo and redo of a command that holds the item still work and hit the same object", () => {
		const item = colourless(BOX, false);
		const doc = docWith(item);
		const pageId = doc.pages[0]!.id;
		const history = new History(() => doc);
		expect(history.execute(new RemoveElement(pageId, item))).toBe(true);
		expect(doc.pages[0]!.elements).toEqual([]);
		history.undo();
		expect(doc.pages[0]!.elements![0]).toBe(item);

		expect(repairLiveDocument(doc)).toBe(1);
		expect(doc.pages[0]!.elements![0]).toBe(item);
		expect(item.color).toBe("#1f2430");

		history.redo();
		expect(doc.pages[0]!.elements).toEqual([]);
		history.undo();
		expect(doc.pages[0]!.elements).toHaveLength(1);
		expect(doc.pages[0]!.elements![0]).toBe(item);
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

const timers: Timers = { set: (fn, ms) => nodeSetTimeout(fn, ms), clear: (h) => nodeClearTimeout(h) };

class FakeIO implements DocumentIO {
	writes: string[] = [];
	constructor(public content: string) {}
	async read(): Promise<string> {
		return this.content;
	}
	async process(fn: (current: string) => string): Promise<void> {
		const next = fn(this.content);
		if (next !== this.content) {
			this.content = next;
			this.writes.push(next);
		}
	}
	async backup(): Promise<string | null> {
		return null;
	}
}

/** An IO that keeps every backup it is asked for. */
class BackupIO extends FakeIO {
	backups: Array<{ text: string; reason: BackupReason }> = [];
	override async backup(content: string, reason: BackupReason): Promise<string | null> {
		this.backups.push({ text: content, reason });
		return `backup-${this.backups.length}`;
	}
}

describe("review fix U2: the unsaved-changes backup is never skipped", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("closing with a frozen colourless item writes a repaired copy as the backup; nothing live is changed", async () => {
		const original = serialize(sampleDocument(1));
		const io = new BackupIO(original);
		const errors: string[] = [];
		const s = new DocumentSession(io, timers, { onError: (m: string) => errors.push(m) });
		await s.load();
		const frozen = colourless(BOX);
		s.doc!.pages[0]!.elements = [frozen, { id: "t9", type: "text", x: 10, y: 60, width: 200, text: "SECRET-unsaved", fontSize: 18, color: "#222222" }];
		s.markChanged();
		// Control: the strict writer refuses this document (the backup was skipped before the fix).
		expect(() => serialize(s.doc!)).toThrow(/colour/);
		expect(await s.flushForClose()).toBe(true);
		expect(io.content).toBe(original);
		expect(io.backups.map((b) => b.reason)).toEqual(["unsaved"]);
		const back = parse(io.backups[0]!.text);
		expect(back.ok).toBe(true);
		if (back.ok) {
			expect(back.doc.pages[0]!.elements).toEqual([expect.objectContaining({ id: "c1", color: "#1f2430" }), expect.objectContaining({ id: "t9", text: "SECRET-unsaved" })]);
		}
		expect(repairNotebookText(io.backups[0]!.text).ok).toBe(true);
		expect(s.doc!.pages[0]!.elements![0]).toBe(frozen);
		expect(frozen).not.toHaveProperty("color");
		expect(errors.some((m) => m.includes("could not be written or backed up"))).toBe(false);
	});

	it("damage the repair cannot fix still gets a backup (lenient writer) whose line scan keeps every other item, on close and on deletion", async () => {
		const broken = Object.freeze({ id: "t0", type: "text", x: 10, y: 10, width: 200, fontSize: 18, color: "#222222" }) as unknown as PageElement; // no text
		const kept: PageElement = { id: "t9", type: "text", x: 10, y: 60, width: 200, text: "SECRET-kept", fontSize: 18, color: "#222222" };
		const doc = docWith(null);
		doc.pages[0]!.elements = [broken, colourless(BOX), kept];
		// Control: neither the strict writer nor a repaired copy can write it.
		expect(() => serialize(doc)).toThrow();
		const text = backupText(doc);
		expect(text).not.toContain("undefined");
		const repaired = repairNotebookText(text);
		expect(repaired.ok).toBe(true);
		if (repaired.ok) {
			const ids = repaired.doc.pages[0]!.elements!.map((e) => e.id);
			expect(ids).toEqual(expect.arrayContaining(["t9", "c1"]));
			expect(JSON.stringify(repaired.doc)).toContain("SECRET-kept");
		}
		for (const end of ["close", "delete"] as const) {
			const io = new BackupIO(serialize(sampleDocument(1)));
			const s = new DocumentSession(io, timers, {});
			await s.load();
			s.doc!.pages[0]!.elements = [broken, kept];
			s.markChanged();
			if (end === "close") await s.flushForClose();
			else await s.markDeleted();
			expect(io.backups.map((b) => b.reason)).toEqual(["unsaved"]);
			expect(io.backups[0]!.text).toContain("SECRET-kept");
		}
	});
});

describe("the save path does not stay stuck", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("repairs a colourless checkbox in memory and saves", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const errors: string[] = [];
		const s = new DocumentSession(io, timers, { onError: (m: string) => errors.push(m) });
		await s.load();
		const item = colourless(BOX, false);
		s.doc!.pages[0]!.elements = [item];
		s.markChanged();
		expect(await s.flush()).toBe(true);
		expect(s.doc?.pages[0]?.elements?.[0]).toBe(item);
		expect(errors).toEqual([]);
		expect(io.writes).toHaveLength(1);
		const back = parse(io.content);
		expect(back.ok).toBe(true);
		if (back.ok) expect(back.doc.pages[0]!.elements).toEqual([expect.objectContaining({ id: "c1", type: "checkbox", color: "#1f2430" })]);
	});

	it("still refuses (and keeps the file) for a frozen colourless item", async () => {
		const original = serialize(sampleDocument(1));
		const io = new FakeIO(original);
		const errors: string[] = [];
		const s = new DocumentSession(io, timers, { onError: (m: string) => errors.push(m) });
		await s.load();
		s.doc!.pages[0]!.elements = [colourless(BOX)];
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(original);
		expect(errors[0]).toContain("Save cancelled");
	});

	it("still refuses (and keeps the file) when the damage is not a colour", async () => {
		const original = serialize(sampleDocument(1));
		const io = new FakeIO(original);
		const errors: string[] = [];
		const s = new DocumentSession(io, timers, { onError: (m: string) => errors.push(m) });
		await s.load();
		s.doc!.pages[0]!.id = "";
		s.markChanged();
		expect(await s.flush()).toBe(false);
		expect(io.content).toBe(original);
		expect(errors[0]).toContain("Save cancelled");
	});
});
