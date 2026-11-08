import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repairLiveDocument } from "../src/model/repair";
import { freezeElement, parse, serialize, serializeChecked } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument, PageElement, Stroke } from "../src/model/types";
import { DocumentSession, type DocumentIO, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

/** An item whose colour was never set: what the harness fixture of the marked view built (a checkbox with no colour). */
function colourless<T extends Stroke | PageElement>(item: T): T {
	const copy = { ...item } as Record<string, unknown>;
	delete copy.color;
	return Object.freeze(copy) as unknown as T;
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
	if (element) doc.pages[0]!.elements = [freezeElement(element)];
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

describe("a document in memory with a missing colour is repaired", () => {
	it.each(ELEMENTS.map((e) => [e.type, e] as const))("%s: kept, with a valid colour, and the document can be written", (_, element) => {
		const doc = docWith(colourless(element), colourless(line(0, 0, 50, 50)));
		expect(repairLiveDocument(doc)).toBe(2);
		const kept = doc.pages[0]!.elements![0]! as PageElement & { color: string };
		expect(kept.id).toBe(element.id);
		expect(kept.type).toBe(element.type);
		expect(kept.color).toMatch(/^#[0-9a-fA-F]{6}$/);
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (out.ok) expect(parse(out.text).ok).toBe(true);
	});

	it("leaves a document that is fine, or one that fails for another reason, alone", () => {
		const fine = docWith(BOX);
		expect(repairLiveDocument(fine)).toBe(0);
		const broken = docWith(colourless(BOX));
		broken.pages[0]!.width = Number.NaN;
		broken.pages[0]!.id = "";
		expect(repairLiveDocument(broken)).toBe(0);
		expect(broken.pages[0]!.elements![0]!).not.toHaveProperty("color");
	});

	it("keeps the rest of the item (a ticked checkbox stays ticked)", () => {
		const doc = docWith(colourless({ ...BOX, checked: true }));
		repairLiveDocument(doc);
		expect(doc.pages[0]!.elements![0]).toMatchObject({ id: "c1", x: 40, y: 200, size: 20, checked: true });
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

describe("the save path does not stay stuck", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("repairs a colourless checkbox in memory and saves", async () => {
		const io = new FakeIO(serialize(sampleDocument(1)));
		const errors: string[] = [];
		const s = new DocumentSession(io, timers, { onError: (m: string) => errors.push(m) });
		await s.load();
		s.doc!.pages[0]!.elements = [colourless(BOX)];
		s.markChanged();
		expect(await s.flush()).toBe(true);
		expect(errors).toEqual([]);
		expect(io.writes).toHaveLength(1);
		const back = parse(io.content);
		expect(back.ok).toBe(true);
		if (back.ok) expect(back.doc.pages[0]!.elements).toEqual([expect.objectContaining({ id: "c1", type: "checkbox", color: "#1f2430" })]);
	});

	it("still refuses (and keeps the file) when the damage is not repairable", async () => {
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
