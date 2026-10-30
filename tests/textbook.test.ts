import { describe, expect, it } from "vitest";
import {
	applyTextbookOp, emptyTextbooks, findPageRefs, parseTextbooks, pdfLinkText, pdfPageFor, placeRefs, referenceText, serializeTextbooks,
	textbookName, textbooksFor, TEXTBOOKS_FORMAT, type Textbook, type TextbookData,
} from "../src/view/textbook-ref";
import { TextbooksBlockedError, TextbookStore } from "../src/view/textbook-store";
import type { DeviceFileAdapter } from "../src/storage/device-files";

const pages = (text: string) => findPageRefs(text).map((r) => r.page);

describe("page references in typed text", () => {
	it("finds p. 134, pag. 134, p134 and friends", () => {
		expect(pages("see p. 134 for the proof")).toEqual([134]);
		expect(pages("pag. 12")).toEqual([12]);
		expect(pages("Pag.12")).toEqual([12]);
		expect(pages("p134")).toEqual([134]);
		expect(pages("P.7")).toEqual([7]);
		expect(pages("page 7 and pagina 9")).toEqual([7, 9]);
		expect(pages("pp. 134-136")).toEqual([134]);
		expect(pages("pagg. 12–14")).toEqual([12]);
		expect(pages("(p. 134), then p. 5.")).toEqual([134, 5]);
	});

	it("does not take the end of a longer word or a bare number", () => {
		expect(pages("step. 3")).toEqual([]);
		expect(pages("up 4")).toEqual([]);
		expect(pages("p 5")).toEqual([]);
		expect(pages("134")).toEqual([]);
		expect(pages("p. 12345")).toEqual([]);
		expect(pages("p. 0")).toEqual([]);
		expect(pages("p.134a")).toEqual([]);
	});

	it("reports where the match is", () => {
		const text = "a p. 134 b";
		const [ref] = findPageRefs(text);
		expect(text.slice(ref!.start, ref!.end)).toBe("p. 134");
	});

	it("referenceText turns what was typed into p. N", () => {
		expect(referenceText("134")).toBe("p. 134");
		expect(referenceText(" pag. 12 ")).toBe("p. 12");
		expect(referenceText("p134")).toBe("p. 134");
		expect(referenceText("abc")).toBeNull();
		expect(referenceText("0")).toBeNull();
		expect(referenceText("12 and 13")).toBeNull();
	});
});

describe("where a reference is drawn", () => {
	// 10 pt per character, whatever the font: easy to check by hand.
	const measure = (s: string) => s.length * 10;
	const box = (text: string, width = 1000) => ({ x: 100, y: 50, width, fontSize: 16, text });

	it("a reference on the first line", () => {
		const [r] = placeRefs(box("see p. 134"), measure);
		expect(r!.page).toBe(134);
		expect(r!.rect).toMatchObject({ x: 100 + 40, y: 50, width: 60 });
		expect(r!.rect.height).toBeCloseTo(20);
	});

	it("a reference after an explicit newline is on the second line", () => {
		const [r] = placeRefs(box("first\np. 7"), measure);
		expect(r!.rect.y).toBeCloseTo(50 + 20);
		expect(r!.rect.x).toBe(100);
		expect(r!.rect.width).toBe(40);
	});

	it("a reference on a wrapped line", () => {
		// width 100 = 10 characters: "aaaa bbbb" fits, "p. 134" goes to the next line.
		const [r] = placeRefs(box("aaaa bbbb p. 134", 100), measure);
		expect(r!.rect.y).toBeCloseTo(50 + 20);
		expect(r!.rect.x).toBe(100);
		expect(r!.rect.width).toBe(60);
	});

	it("punctuation after the number does not move the reference", () => {
		const [r] = placeRefs(box("p. 134, then"), measure);
		expect(r!.rect.x).toBe(100);
		expect(r!.rect.width).toBe(60);
	});

	it("a text without references gives nothing", () => {
		expect(placeRefs(box("nothing here"), measure)).toEqual([]);
	});
});

const nb = (target: string, pdf = "Books/A.pdf", offset = 0): Textbook => ({ scope: "notebook", target, pdf, offset });
const folder = (target: string, pdf = "Books/A.pdf", offset = 0): Textbook => ({ scope: "folder", target, pdf, offset });
const all = (pdf = "Books/A.pdf", offset = 0): Textbook => ({ scope: "all", target: "", pdf, offset });
const data = (...books: Textbook[]): TextbookData => ({ ...emptyTextbooks(), books });

describe("textbook configuration", () => {
	it("round-trips and is deterministic", () => {
		const d = data(nb("n1", "Books/Physics.pdf", 11), folder("Notebooks/Physics"), all());
		const text = serializeTextbooks(d);
		expect(serializeTextbooks(d)).toBe(text);
		expect(text).toContain(TEXTBOOKS_FORMAT);
		const back = parseTextbooks(text);
		expect(back.ok && back.data.books).toEqual(d.books);
	});

	it("an existing empty file, foreign, broken and newer files are reported", () => {
		// Empty: it may not be downloaded yet (a missing file is no textbooks; the store never parses one).
		expect(parseTextbooks("")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseTextbooks("{ nope")).toMatchObject({ ok: false, reason: "json" });
		expect(parseTextbooks("{\"a\":1}")).toMatchObject({ ok: false, reason: "format" });
		expect(parseTextbooks(`{"format":"${TEXTBOOKS_FORMAT}","version":2,"textbooks":[]}`)).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps entries it does not understand and writes them back", () => {
		const text = `{"format":"${TEXTBOOKS_FORMAT}","version":1,"textbooks":[{"scope":"all","target":"","pdf":"a.pdf","offset":2},{"scope":"galaxy","pdf":"b.pdf"},{"scope":"notebook","pdf":"c.pdf"}]}`;
		const r = parseTextbooks(text);
		expect(r.ok && r.data.books).toEqual([{ scope: "all", target: "", pdf: "a.pdf", offset: 2 }]);
		const out = serializeTextbooks((r as { ok: true; data: TextbookData }).data);
		expect(out).toContain("galaxy");
		expect(out).toContain("c.pdf");
	});

	it("set replaces the same textbook for the same scope and keeps the order; remove deletes it", () => {
		let d = data(nb("n1", "a.pdf"), nb("n1", "b.pdf"));
		d = applyTextbookOp(d, { type: "set", book: { ...nb("n1", "a.pdf"), offset: 5, label: "Main" } });
		expect(d.books.map((b) => b.pdf)).toEqual(["a.pdf", "b.pdf"]);
		expect(d.books[0]).toMatchObject({ offset: 5, label: "Main" });
		d = applyTextbookOp(d, { type: "set", book: nb("n2", "a.pdf") });
		expect(d.books).toHaveLength(3);
		d = applyTextbookOp(d, { type: "remove", book: nb("n1", "a.pdf") });
		expect(d.books.map((b) => `${b.target}:${b.pdf}`)).toEqual(["n1:b.pdf", "n2:a.pdf"]);
	});

	it("the textbooks of a notebook: its own first, then the nearest folder, then everything", () => {
		const d = data(all("all.pdf"), folder("", "root.pdf"), folder("Notebooks/Physics", "course.pdf"), nb("n1", "own.pdf"), nb("n2", "other.pdf"), folder("Notebooks/Chem", "chem.pdf"));
		expect(textbooksFor(d, "n1", "Notebooks/Physics/Lectures/Week 1.notebook").map((b) => b.pdf)).toEqual(["own.pdf", "course.pdf", "root.pdf", "all.pdf"]);
		expect(textbooksFor(d, "n9", "Notebooks/Physics/Week 2.notebook").map((b) => b.pdf)).toEqual(["course.pdf", "root.pdf", "all.pdf"]);
		expect(textbooksFor(d, "n9", "Notebooks/Physics2/x.notebook").map((b) => b.pdf)).toEqual(["root.pdf", "all.pdf"]);
		expect(textbooksFor(d, "n9", "Quick notes.notebook").map((b) => b.pdf)).toEqual(["root.pdf", "all.pdf"]);
		expect(textbooksFor(emptyTextbooks(), "n1", "x.notebook")).toEqual([]);
	});

	it("page offset, names and links", () => {
		expect(pdfPageFor({ offset: 11 }, 1)).toBe(12);
		expect(pdfPageFor({ offset: -3 }, 2)).toBe(1);
		expect(pdfPageFor({ offset: 0 }, 134)).toBe(134);
		expect(textbookName({ pdf: "Books/Halliday 10e.pdf" })).toBe("Halliday 10e");
		expect(textbookName({ pdf: "a.pdf", label: "Main text" })).toBe("Main text");
		expect(pdfLinkText("Books/A.pdf", 134)).toBe("Books/A.pdf#page=134");
		expect(pdfLinkText("A.pdf", 0)).toBe("A.pdf#page=1");
	});
});

class MemoryAdapter implements DeviceFileAdapter {
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

/** Books without the time stamp of the per-device files, to compare with what was set. */
const plain = (d: TextbookData) => d.books.map((b) => {
	const copy = { ...b };
	delete copy.at;
	return copy;
});

describe("textbook store (one file per device)", () => {
	const LEGACY = "Notebooks/_meta/textbooks.json";
	const make = (device = "aaaaaaaa", adapter = new MemoryAdapter()) => ({ adapter, store: new TextbookStore(adapter, () => "Notebooks", device) });

	it("lives in _meta of the notebooks folder and reading never writes", async () => {
		const { adapter, store } = make();
		expect(store.path).toBe("Notebooks/_meta/textbooks-aaaaaaaa.json");
		expect(store.watches(LEGACY) && store.watches("Notebooks/_meta/textbooks-bbbbbbbb.json")).toBe(true);
		expect((await store.load()).books).toEqual([]);
		expect(adapter.writes).toEqual([]);
	});

	it("writes this device's file on update, once, and not again when nothing changes", async () => {
		const { adapter, store } = make();
		await store.update({ type: "set", book: nb("n1", "a.pdf", 3) });
		expect(adapter.writes).toEqual(["Notebooks/_meta/textbooks-aaaaaaaa.json"]);
		expect(adapter.folders.has("Notebooks/_meta")).toBe(true);
		const fresh = make("aaaaaaaa", adapter).store;
		expect(plain(await fresh.load())).toEqual([nb("n1", "a.pdf", 3)]);
	});

	it("merges the other devices' files and the old shared file, which is never written", async () => {
		const adapter = new MemoryAdapter();
		const legacy = serializeTextbooks(data(nb("n1", "old.pdf"), nb("n2", "gone.pdf")));
		adapter.files.set(LEGACY, legacy);
		const mine = make("aaaaaaaa", adapter).store;
		const theirs = make("bbbbbbbb", adapter).store;
		await theirs.update({ type: "set", book: nb("n3", "theirs.pdf") });
		await mine.update({ type: "set", book: nb("n4", "mine.pdf") });
		await mine.update({ type: "remove", book: nb("n2", "gone.pdf") });
		expect(plain(await mine.load()).map((b) => b.pdf)).toEqual(["old.pdf", "theirs.pdf", "mine.pdf"]);
		expect(plain(await theirs.load()).map((b) => b.pdf)).toEqual(["old.pdf", "theirs.pdf", "mine.pdf"]);
		expect(adapter.files.get(LEGACY)).toBe(legacy);
		// Set again later on the other device: the newer setting wins over the removal.
		await new Promise((r) => setTimeout(r, 5));
		await theirs.update({ type: "set", book: nb("n2", "gone.pdf", 4) });
		expect(plain(await mine.load()).find((b) => b.pdf === "gone.pdf")?.offset).toBe(4);
	});

	it("never overwrites its own file when it cannot read it or it is empty; one copy is kept", async () => {
		for (const bad of ["{ not json", ""]) {
			const { adapter, store } = make();
			adapter.files.set(store.path, bad);
			await expect(store.update({ type: "set", book: nb("n1") })).rejects.toBeInstanceOf(TextbooksBlockedError);
			await expect(store.update({ type: "set", book: nb("n1") })).rejects.toBeInstanceOf(TextbooksBlockedError);
			expect(adapter.files.get(store.path)).toBe(bad);
			expect([...adapter.files.keys()].filter((k) => k.includes("unreadable"))).toHaveLength(1);
			expect(store.blocked).not.toBeNull();
		}
	});

	it("a newer file is not overwritten either, and loading it gives no textbooks", async () => {
		const { adapter, store } = make();
		const future = `{"format":"${TEXTBOOKS_FORMAT}","version":9,"textbooks":[]}`;
		adapter.files.set(store.path, future);
		expect((await store.load()).books).toEqual([]);
		expect(adapter.writes).toEqual([]);
		await expect(store.update({ type: "set", book: nb("n1") })).rejects.toBeInstanceOf(TextbooksBlockedError);
		expect(adapter.files.get(store.path)).toBe(future);
	});
});
