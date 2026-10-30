import { describe, expect, it } from "vitest";
import { createDocument, createId, createStroke } from "../src/model/document";
import type { NotebookDocument, Page, Stroke, TextElement } from "../src/model/types";
import { newCardText } from "../src/zettel/card-content";
import {
	blockKey, blockRegion, collectBlockItems, collectPdfItems, coveredBy, itemIdOf, looseSheetSource, mayHavePdfPages, pageBlocks,
	pdfAnnotationSource, registerInboxSource, registeredInboxSources, sortItems, sourceLabel, suggestTitle, transcriptionText,
	type InboxEnv, type InboxItem, type InboxNotebook, type InboxSource,
} from "../src/zettel/inbox-items";
import {
	applyInboxOp, deviceOfFileName, emptyInbox, INBOX_FORMAT, inboxFileName, mergeInboxFiles, newDeviceId, parseInbox, serializeInbox,
	statusOf, validDeviceId, type InboxEntry, type InboxFile,
} from "../src/zettel/inbox-state";
import { InboxBlockedError, InboxStore, type InboxFileAdapter } from "../src/zettel/inbox-store";

const stroke = (x0: number, y0: number, x1: number, y1: number, tool: Stroke["tool"] = "pen"): Stroke => {
	const s = createStroke("#000000", 2, [[x0, y0, 0.5], [x1, y1, 0.5]]);
	s.tool = tool;
	return s;
};

const text = (x: number, y: number, str: string): TextElement => ({ id: createId(), type: "text", x, y, width: 200, text: str, fontSize: 14, color: "#000000" });

function sheet(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
	return doc;
}

describe("blocks of writing on a page", () => {
	it("splits at vertical gaps and names a block by its first stroke", () => {
		const doc = sheet();
		const page = doc.pages[0]!;
		const a = stroke(50, 50, 200, 60);
		const b = stroke(50, 70, 200, 80);
		const c = stroke(50, 400, 200, 410);
		page.strokes.push(a, b, c);
		const blocks = pageBlocks(page);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.id).toBe(a.id);
		expect(blocks[0]!.count).toBe(2);
		expect(blocks[1]!.id).toBe(c.id);
	});

	it("a block keeps its name while it grows", () => {
		const doc = sheet();
		const page = doc.pages[0]!;
		const a = stroke(50, 50, 200, 60);
		page.strokes.push(a);
		const before = pageBlocks(page)[0]!;
		page.strokes.push(stroke(50, 80, 200, 90));
		const after = pageBlocks(page)[0]!;
		expect(after.id).toBe(before.id);
		expect(after.count).toBe(before.count + 1);
	});

	it("typed text counts, with its text, and empty pages and empty boxes give no block", () => {
		const doc = sheet();
		const page = doc.pages[0]!;
		expect(pageBlocks(page)).toEqual([]);
		page.elements = [text(40, 40, "  "), text(40, 100, "Idea about entropy")];
		const blocks = pageBlocks(page);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.text).toBe("Idea about entropy");
	});

	it("joins writing that is close, even when drawn in another order", () => {
		const doc = sheet();
		const page = doc.pages[0]!;
		page.strokes.push(stroke(50, 300, 100, 310), stroke(50, 100, 100, 110), stroke(50, 130, 100, 140));
		const blocks = pageBlocks(page);
		expect(blocks).toHaveLength(2);
		expect(blocks.map((b) => b.count).sort()).toEqual([1, 2]);
	});

	it("the region is the block with some margin; a block that fills the page is the whole page", () => {
		const page = { width: 595, height: 842 };
		const region = blockRegion({ minX: 100, minY: 100, maxX: 200, maxY: 150 }, page);
		expect(region).toEqual({ x: 90, y: 90, width: 120, height: 70 });
		expect(blockRegion({ minX: 0, minY: 0, maxX: 595, maxY: 800 }, page)).toBeNull();
	});

	it("suggests a title from the first line", () => {
		expect(suggestTitle("Entropy never decreases\nin a closed system")).toBe("Entropy never decreases");
		expect(suggestTitle("# Heading\nbody")).toBe("Heading");
		expect(suggestTitle("")).toBe("");
		const long = suggestTitle("word ".repeat(40));
		expect(long.length).toBeLessThanOrEqual(61);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("collecting items", () => {
	it("loose-sheet items: one per block, with stable keys, page and region", () => {
		const doc = sheet();
		const page = doc.pages[0]!;
		const a = stroke(50, 50, 200, 60);
		const c = stroke(50, 400, 200, 410);
		page.strokes.push(a, c);
		const items = collectBlockItems(doc, { path: "Notebooks/Quick notes.notebook", name: "Quick notes" });
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ kind: "block", source: "loose-sheet", pageId: page.id, pageIndex: 0, notebookId: doc.id, cardType: "permanent", sig: 1 });
		expect(items[0]!.key).toBe(blockKey(doc.id, page.id, a.id));
		expect(itemIdOf(items[0]!.key)).toBe(a.id);
		expect(items[0]!.region).not.toBeNull();
		expect(items[1]!.order).toBeGreaterThan(items[0]!.order);
		expect(collectBlockItems(doc, { path: "x", name: "x" }).map((i) => i.key)).toEqual(items.map((i) => i.key));
	});

	function pdfNotebook(): { doc: NotebookDocument; hl: Stroke; note: TextElement } {
		const doc = sheet();
		doc.assets = { abc: { id: "abc", kind: "pdf", path: "Books/Physics.pdf", name: "Physics.pdf", bytes: 10 } };
		const page: Page = doc.pages[0]!;
		page.background = { kind: "pdf", asset: "abc", page: 12 };
		const hl = stroke(60, 200, 300, 204, "highlighter");
		hl.width = 12;
		page.strokes.push(stroke(10, 10, 20, 20), hl);
		const note = text(60, 100, "check this");
		page.elements = [note, text(60, 300, "   ")];
		return { doc, hl, note };
	}

	it("PDF items: highlights and comments with their source", () => {
		const { doc, hl, note } = pdfNotebook();
		const items = collectPdfItems(doc, { path: "Notebooks/Physics.notebook", name: "Physics" });
		const highlight = items.find((i) => i.kind === "pdf-highlight")!;
		const comment = items.find((i) => i.kind === "pdf-comment")!;
		expect(items).toHaveLength(2);
		expect(highlight.origin).toEqual({ pdfName: "Physics.pdf", pdfPage: 12 });
		expect(highlight.cardType).toBe("literature");
		expect(highlight.key).toBe(`hl|${doc.id}|${doc.pages[0]!.id}|${hl.id}`);
		expect(comment.key).toBe(`cm|${doc.id}|${doc.pages[0]!.id}|${note.id}`);
		expect(comment.text).toBe("check this");
		expect(sourceLabel(highlight)).toBe("Physics.pdf, p. 12");
	});

	it("a notebook without PDF pages gives no PDF items, and the raw-text test is cheap and safe", () => {
		const doc = sheet();
		doc.pages[0]!.strokes.push(stroke(1, 1, 5, 5, "highlighter"));
		expect(collectPdfItems(doc, { path: "x", name: "x" })).toEqual([]);
		expect(mayHavePdfPages('{"background":{"kind":"pdf","asset":"a","page":1},"tool":"highlighter"}')).toBe(true);
		expect(mayHavePdfPages('{"background":{"kind": "pdf"},"type":"text"}')).toBe(true);
		expect(mayHavePdfPages('{"tool":"highlighter"}')).toBe(false);
		expect(mayHavePdfPages('{"background":{"kind":"pdf"}}')).toBe(false);
	});

	it("sorts by source, notebook, page and position", () => {
		const mk = (key: string, source: string, name: string, order: number): InboxItem => ({
			key, source, kind: "block", notebookPath: name, notebookName: name, notebookId: name, pageId: "p", pageIndex: 0,
			pageSize: { width: 1, height: 1 }, region: null, text: "", sig: 1, cardType: "permanent", order,
		});
		const sorted = sortItems([mk("d", "pdf", "A", 1), mk("c", "loose-sheet", "Quick", 2), mk("b", "loose-sheet", "Quick", 1), mk("e", "markers", "A", 1), mk("a", "pdf", "A", 0)]);
		expect(sorted.map((i) => i.key)).toEqual(["b", "c", "a", "d", "e"]);
	});

	it("whether a card already covers an item", () => {
		const base = { pageSize: { width: 600, height: 800 } };
		const item = { ...base, region: { x: 100, y: 100, width: 100, height: 100 } };
		expect(coveredBy(item, null)).toBe(true);
		expect(coveredBy(item, { x: 90, y: 90, width: 200, height: 200 })).toBe(true);
		expect(coveredBy(item, { x: 150, y: 100, width: 100, height: 100 })).toBe(true);
		expect(coveredBy(item, { x: 180, y: 100, width: 100, height: 100 })).toBe(false);
		expect(coveredBy(item, { x: 400, y: 400, width: 50, height: 50 })).toBe(false);
		expect(coveredBy({ ...base, region: null }, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
		expect(coveredBy({ ...base, region: null }, { x: 0, y: 0, width: 600, height: 500 })).toBe(true);
	});

	it("the transcription: a quote for PDF text, as typed otherwise, never a comment marker", () => {
		expect(transcriptionText({ kind: "pdf-highlight", text: "Line one\n\nLine two" })).toBe("> Line one\n>\n> Line two");
		expect(transcriptionText({ kind: "block", text: "Typed idea" })).toBe("Typed idea");
		expect(transcriptionText({ kind: "block", text: "a %% b" })).toBe("a % % b");
		expect(transcriptionText({ kind: "block", text: "  " })).toBe("");
	});
});

describe("sources", () => {
	const nbOf = (doc: NotebookDocument | null, looseSheet: boolean, name = "n"): InboxNotebook => ({
		path: `${name}.notebook`, name, looseSheet, read: async (pre) => (doc && (!pre || pre(JSON.stringify(doc))) ? doc : null),
	});

	it("the loose-sheet source reads only the loose sheet; the PDF source never reads it", async () => {
		const loose = sheet();
		loose.pages[0]!.strokes.push(stroke(50, 50, 100, 60));
		const book = sheet();
		book.assets = { a: { id: "a", kind: "pdf", path: "a.pdf", name: "a.pdf", bytes: 1 } };
		book.pages[0]!.background = { kind: "pdf", asset: "a", page: 1 };
		book.pages[0]!.strokes.push(stroke(50, 50, 100, 52, "highlighter"));
		const env: InboxEnv = { notebooks: () => [nbOf(loose, true, "Quick"), nbOf(book, false, "Book"), nbOf(null, false, "Broken")] };
		const a = await looseSheetSource.collect(env);
		const b = await pdfAnnotationSource.collect(env);
		expect(a.map((i) => i.kind)).toEqual(["block"]);
		expect(b.map((i) => i.kind)).toEqual(["pdf-highlight"]);
	});

	it("other sources (the markers of a later format) plug in and out", () => {
		const source: InboxSource = { id: "markers", collect: async () => [] };
		const off = registerInboxSource(source);
		registerInboxSource(source);
		expect(registeredInboxSources().filter((s) => s === source)).toHaveLength(1);
		off();
		expect(registeredInboxSources()).not.toContain(source);
	});
});

const entry = (key: string, state: InboxEntry["state"], at: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({ key, state, at, ...extra });
const file = (device: string, ...entries: InboxEntry[]): InboxFile => ({ ...emptyInbox(device), entries });

describe("inbox state files", () => {
	it("round-trips, sorted by key, one entry per line", () => {
		const f = file("0a1b2c3d", entry("b", "discarded", 5, { sig: 2 }), entry("a", "card", 3, { card: "2026", path: "Zettelkasten/2026.md" }));
		const text = serializeInbox(f);
		expect(text.indexOf("\"key\":\"a\"")).toBeLessThan(text.indexOf("\"key\":\"b\""));
		expect(text).toContain(INBOX_FORMAT);
		const back = parseInbox(text, "0a1b2c3d");
		expect(back.ok && back.data.entries).toEqual([entry("a", "card", 3, { card: "2026", path: "Zettelkasten/2026.md" }), entry("b", "discarded", 5, { sig: 2 })]);
		expect(serializeInbox(file("0a1b2c3d"))).toBe(serializeInbox(emptyInbox("0a1b2c3d")));
	});

	it("reports foreign, broken and newer files; keeps entries it does not understand", () => {
		// An existing empty file may not be downloaded yet: reported, never read as "nothing dealt with".
		expect(parseInbox("", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseInbox(" 	 ", "0a1b2c3d")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseInbox("{ nope", "0a1b2c3d")).toMatchObject({ ok: false, reason: "json" });
		expect(parseInbox("{\"a\":1}", "0a1b2c3d")).toMatchObject({ ok: false, reason: "format" });
		expect(parseInbox(`{"format":"${INBOX_FORMAT}","version":2,"entries":[]}`, "0a1b2c3d")).toMatchObject({ ok: false, reason: "future" });
		const r = parseInbox(`{"format":"${INBOX_FORMAT}","version":1,"device":"0a1b2c3d","entries":[{"key":"k","state":"discarded","at":1},{"key":"z","state":"flying","at":1}]}`, "ffffffff");
		expect(r.ok && r.data.entries).toHaveLength(1);
		expect(r.ok && r.data.device).toBe("0a1b2c3d");
		expect(serializeInbox((r as { ok: true; data: InboxFile }).data)).toContain("flying");
	});

	it("set and remove operations", () => {
		let f = file("0a1b2c3d");
		f = applyInboxOp(f, { type: "set", entry: entry("k", "discarded", 1) });
		f = applyInboxOp(f, { type: "set", entry: entry("k", "open", 2) });
		expect(f.entries).toEqual([entry("k", "open", 2)]);
		f = applyInboxOp(f, { type: "remove", key: "k" });
		expect(f.entries).toEqual([]);
	});

	it("device ids and file names", () => {
		expect(validDeviceId(newDeviceId())).toBe(true);
		expect(validDeviceId("xyz")).toBe(false);
		expect(deviceOfFileName(inboxFileName("0a1b2c3d"))).toBe("0a1b2c3d");
		expect(deviceOfFileName("inbox-0a1b2c3d.unreadable-1.json")).toBeNull();
		expect(deviceOfFileName("pdf-links.json")).toBeNull();
	});
});

describe("merging devices", () => {
	it("the latest decision wins, on any device; a tie goes to the larger device id", () => {
		const a = file("aaaaaaaa", entry("k", "discarded", 10), entry("only-a", "card", 1));
		const b = file("bbbbbbbb", entry("k", "open", 20), entry("tie", "linked", 5), entry("only-b", "discarded", 2));
		const c = file("cccccccc", entry("tie", "discarded", 5));
		const merged = mergeInboxFiles([a, b, c]);
		expect(merged.get("k")!.state).toBe("open");
		expect(merged.get("tie")!.state).toBe("discarded");
		expect(merged.get("only-a")!.state).toBe("card");
		expect(merged.get("only-b")!.state).toBe("discarded");
		// the order the files are given in does not matter
		expect(mergeInboxFiles([c, b, a]).get("tie")!.state).toBe("discarded");
	});

	it("an item is processed until it has more content than when it was processed", () => {
		const merged = new Map([["k", entry("k", "discarded", 1, { sig: 3 })], ["o", entry("o", "open", 1)]]);
		expect(statusOf({ key: "k", sig: 3 }, merged).status).toBe("discarded");
		expect(statusOf({ key: "k", sig: 2 }, merged).status).toBe("discarded");
		expect(statusOf({ key: "k", sig: 4 }, merged)).toEqual({ status: "open", changed: true });
		expect(statusOf({ key: "o", sig: 9 }, merged)).toEqual({ status: "open", changed: false });
		expect(statusOf({ key: "new", sig: 1 }, merged)).toEqual({ status: "open", changed: false });
		// PDF items have no content count: processed stays processed
		expect(statusOf({ key: "p", sig: 0 }, new Map([["p", entry("p", "card", 1, { sig: 0 })]])).status).toBe("card");
	});
});

class MemoryAdapter implements InboxFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	writes: string[] = [];
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); this.writes.push(p); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

describe("inbox store", () => {
	const make = (device = "0a1b2c3d", adapter = new MemoryAdapter()) => ({ adapter, store: new InboxStore(adapter, () => "Notebooks", device) });

	it("looking never writes; an action writes only this device's file in _meta", async () => {
		const { adapter, store } = make();
		expect((await store.load()).size).toBe(0);
		expect(adapter.writes).toEqual([]);
		await store.update({ type: "set", entry: entry("k", "discarded", 5) });
		expect(adapter.writes).toEqual(["Notebooks/_meta/inbox-0a1b2c3d.json"]);
		expect(store.snapshot().get("k")!.state).toBe("discarded");
		await store.update({ type: "set", entry: entry("k", "discarded", 5) });
		expect(adapter.writes).toHaveLength(1);
	});

	it("another device's file is read, merged and never written", async () => {
		const adapter = new MemoryAdapter();
		const other = make("bbbbbbbb", adapter);
		await other.store.update({ type: "set", entry: entry("k", "discarded", 5) });
		const mine = make("aaaaaaaa", adapter);
		expect(mine.store.snapshot().size).toBe(0);
		await mine.store.load();
		expect(mine.store.snapshot().get("k")!.state).toBe("discarded");
		const before = adapter.files.get(other.store.ownPath);
		await mine.store.update({ type: "set", entry: entry("k", "open", 9) });
		expect(adapter.files.get(other.store.ownPath)).toBe(before);
		expect(mine.store.snapshot().get("k")!.state).toBe("open");
		await other.store.load();
		expect(other.store.snapshot().get("k")!.state).toBe("open");
	});

	it("never overwrites its own file when it cannot read it; keeps one copy", async () => {
		const { adapter, store } = make();
		adapter.files.set(store.ownPath, "{ not json");
		await expect(store.update({ type: "set", entry: entry("k", "discarded", 1) })).rejects.toBeInstanceOf(InboxBlockedError);
		await expect(store.update({ type: "set", entry: entry("k", "discarded", 1) })).rejects.toBeInstanceOf(InboxBlockedError);
		expect(adapter.files.get(store.ownPath)).toBe("{ not json");
		expect([...adapter.files.keys()].filter((k) => k.includes("unreadable"))).toHaveLength(1);
	});

	it("an unreadable file of another device is skipped and reported, and loading writes nothing", async () => {
		const { adapter, store } = make();
		adapter.files.set("Notebooks/_meta/inbox-bbbbbbbb.json", "garbage");
		adapter.files.set("Notebooks/_meta/inbox-cccccccc.json", serializeInbox(file("cccccccc", entry("k", "discarded", 1))));
		await store.load();
		expect(store.unreadable).toEqual(["Notebooks/_meta/inbox-bbbbbbbb.json"]);
		expect(store.snapshot().get("k")!.state).toBe("discarded");
		expect(adapter.writes).toEqual([]);
	});
});

describe("card text from an item", () => {
	const card = {
		id: "20261029144207-k3f9", title: "Entropy", type: "permanent" as const, source: "", tags: [], date: "2026-10-29",
		notebookPath: "Notebooks/Quick notes.notebook", notebookId: "nb", pageId: "pg", page: 1, region: null,
	};
	const stringify = (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join("");

	it("without a transcription the section stays empty, as before", () => {
		expect(newCardText(card, stringify).endsWith("## Transcription\n\n")).toBe(true);
	});

	it("with one, it follows the heading", () => {
		const text = newCardText({ ...card, transcription: "> a quote\n" }, stringify);
		expect(text.endsWith("## Transcription\n\n> a quote\n")).toBe(true);
	});
});
