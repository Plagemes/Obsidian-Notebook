import { describe, expect, it } from "vitest";
import {
	applyLinkOp, decideFromNotes, decideFromPdf, emptyLinks, insertionIndex, linkOf, linkState, notesPagesFor, parseLinks, sameSource,
	serializeLinks, LINKS_FORMAT, type LinksData, type PdfLink,
} from "../src/pdf/sync-links";
import { clampRatio, DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, ratioFromPointer, splitOrientation } from "../src/pdf/sync-layout";
import { LinksBlockedError, LINKS_FILE, PdfLinkStore, type LinkFileAdapter } from "../src/storage/pdf-links-store";

const A = "a".repeat(24);
const B = "b".repeat(24);
const link = (notesPage: string, page: number, source = A, notebook = "nb1", path?: string): PdfLink =>
	({ notebook, notesPage, source, page, ...(path ? { path } : {}) });
const withLinks = (...links: PdfLink[]): LinksData => ({ ...emptyLinks(), links });

class MemoryAdapter implements LinkFileAdapter {
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
}

describe("links file", () => {
	it("round-trips and is deterministic", () => {
		const data = withLinks(link("p1", 1), link("p2", 2, B, "nb1", "Lectures/a.pdf"));
		const text = serializeLinks(data);
		expect(serializeLinks(data)).toBe(text);
		const back = parseLinks(text);
		expect(back.ok && back.data.links).toEqual(data.links);
		expect(text.split("\n").filter((l) => l.startsWith("{\"notebook\"")).length).toBe(2);
		expect(text).toContain(LINKS_FORMAT);
	});

	it("empty text is an empty set; foreign JSON, broken JSON and newer versions are reported", () => {
		expect(parseLinks("")).toEqual({ ok: true, data: emptyLinks() });
		expect(parseLinks("{ nope")).toMatchObject({ ok: false, reason: "json" });
		expect(parseLinks("{\"a\":1}")).toMatchObject({ ok: false, reason: "format" });
		expect(parseLinks(`{"format":"${LINKS_FORMAT}","version":2,"links":[]}`)).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps entries it does not understand and writes them back", () => {
		const text = `{"format":"${LINKS_FORMAT}","version":1,"links":[{"notebook":"n","page":"p","source":"s","pdfPage":3},{"x":1},{"notebook":"n","page":"q","source":"s","pdfPage":0}]}`;
		const r = parseLinks(text);
		expect(r.ok && r.data.links.length).toBe(1);
		expect(r.ok && r.data.unknown).toEqual([{ x: 1 }, { notebook: "n", page: "q", source: "s", pdfPage: 0 }]);
		const out = serializeLinks((r as { ok: true; data: LinksData }).data);
		expect(out).toContain("{\"x\":1}");
		expect(out).toContain("\"pdfPage\":0");
	});
});

describe("operations and queries", () => {
	it("set replaces the link of the same page and keeps the order; remove deletes it", () => {
		let d = withLinks(link("p1", 1), link("p2", 2));
		d = applyLinkOp(d, { type: "set", link: link("p1", 5) });
		expect(d.links.map((l) => [l.notesPage, l.page])).toEqual([["p1", 5], ["p2", 2]]);
		d = applyLinkOp(d, { type: "set", link: link("p3", 3) });
		expect(d.links).toHaveLength(3);
		d = applyLinkOp(d, { type: "remove", notebook: "nb1", notesPage: "p2" });
		expect(d.links.map((l) => l.notesPage)).toEqual(["p1", "p3"]);
		// another notebook's page with the same id is untouched
		d = applyLinkOp(d, { type: "set", link: link("p1", 9, A, "nb2") });
		expect(linkOf(d, "nb1", "p1")?.page).toBe(5);
		expect(linkOf(d, "nb2", "p1")?.page).toBe(9);
	});

	it("the same PDF is recognised by hash, or by path for a file replaced in place", () => {
		expect(sameSource({ source: A }, { source: A })).toBe(true);
		expect(sameSource({ source: A }, { source: B })).toBe(false);
		expect(sameSource({ source: A, path: "x.pdf" }, { source: B, path: "x.pdf" })).toBe(true);
		expect(sameSource({ source: A, path: "x.pdf" }, { source: B, path: "y.pdf" })).toBe(false);
		expect(sameSource({ source: A }, { source: B, path: "y.pdf" })).toBe(false);
	});

	const ids = ["n1", "n2", "n3", "n4"];

	it("finds the notes pages linked to a PDF page, in document order, ignoring missing pages and other PDFs", () => {
		const d = withLinks(link("n3", 2), link("n1", 2), link("gone", 2), link("n2", 2, B), link("n4", 3));
		expect(notesPagesFor(d, "nb1", { source: A, page: 2 }, ids)).toEqual([0, 2]);
		expect(notesPagesFor(d, "other", { source: A, page: 2 }, ids)).toEqual([]);
	});

	it("follows the PDF: stay when the notes page in view is linked, go to the first linked page, else offer to add", () => {
		const d = withLinks(link("n2", 4), link("n3", 4));
		const ref = { source: A, page: 4 };
		expect(decideFromPdf(d, "nb1", ref, ids, 2)).toEqual({ kind: "stay" });
		expect(decideFromPdf(d, "nb1", ref, ids, 0)).toEqual({ kind: "go", index: 1 });
		expect(decideFromPdf(d, "nb1", { source: A, page: 5 }, ids, 0)).toEqual({ kind: "none" });
	});

	it("follows the notes only when the link points into the PDF on the other side", () => {
		const d = withLinks(link("n1", 7, A, "nb1", "L.pdf"));
		expect(decideFromNotes(d, "nb1", "n1", { source: A })?.page).toBe(7);
		expect(decideFromNotes(d, "nb1", "n1", { source: B })).toBeNull();
		expect(decideFromNotes(d, "nb1", "n1", { source: B, path: "L.pdf" })?.page).toBe(7);
		expect(decideFromNotes(d, "nb1", "n2", { source: A })).toBeNull();
	});

	it("link state for the link / unlink button", () => {
		const d = withLinks(link("n1", 2), link("n2", 3));
		expect(linkState(d, "nb1", "n1", { source: A, page: 2 })).toBe("here");
		expect(linkState(d, "nb1", "n2", { source: A, page: 2 })).toBe("elsewhere");
		expect(linkState(d, "nb1", "n3", { source: A, page: 2 })).toBe("none");
	});

	it("inserts a new notes page in slide order", () => {
		const ids5 = ["n1", "n2", "n3", "n4", "n5"];
		const d = withLinks(link("n2", 2), link("n3", 4), link("n4", 4));
		// slide 3: after the last page linked at or before it
		expect(insertionIndex(d, "nb1", { source: A, page: 3 }, ids5, 0)).toBe(2);
		// slide 4 again: after the last page of slide 4
		expect(insertionIndex(d, "nb1", { source: A, page: 4 }, ids5, 0)).toBe(4);
		// slide 1: before the first page linked to a later slide
		expect(insertionIndex(d, "nb1", { source: A, page: 1 }, ids5, 4)).toBe(1);
		// nothing linked to this PDF: after the page in view
		expect(insertionIndex(d, "nb1", { source: B, page: 1 }, ids5, 2)).toBe(3);
		expect(insertionIndex(emptyLinks(), "nb1", { source: A, page: 1 }, ids5, 4)).toBe(5);
	});
});

describe("link store", () => {
	const folder = ".obsidian/plugins/notebook";
	const path = `${folder}/${LINKS_FILE}`;

	it("starts empty without creating a file, then writes only on update", async () => {
		const ad = new MemoryAdapter();
		const store = new PdfLinkStore(ad, folder);
		expect((await store.load()).links).toEqual([]);
		expect(ad.writes).toEqual([]);
		const d = await store.update({ type: "set", link: link("p1", 1) });
		expect(d.links).toHaveLength(1);
		expect(ad.writes).toEqual([path]);
		expect(ad.folders.has(folder)).toBe(true);
		expect(store.snapshot().links).toHaveLength(1);
	});

	it("reads the file again before applying an update, so a change synced from another device is kept", async () => {
		const ad = new MemoryAdapter();
		const store = new PdfLinkStore(ad, folder);
		await store.update({ type: "set", link: link("p1", 1) });
		ad.files.set(path, serializeLinks(withLinks(link("p1", 1), link("other-device", 8))));
		const d = await store.update({ type: "set", link: link("p2", 2) });
		expect(d.links.map((l) => l.notesPage)).toEqual(["p1", "other-device", "p2"]);
	});

	it("does not write when nothing changes", async () => {
		const ad = new MemoryAdapter();
		const store = new PdfLinkStore(ad, folder);
		await store.update({ type: "set", link: link("p1", 1) });
		const n = ad.writes.length;
		await store.update({ type: "set", link: link("p1", 1) });
		await store.update({ type: "remove", notebook: "nb1", notesPage: "nope" });
		expect(ad.writes.length).toBe(n);
	});

	it("never overwrites an unreadable or newer file and keeps one copy of it", async () => {
		for (const bad of ["{ broken", `{"format":"${LINKS_FORMAT}","version":9,"links":[]}`]) {
			const ad = new MemoryAdapter();
			ad.files.set(path, bad);
			const store = new PdfLinkStore(ad, folder);
			await expect(store.update({ type: "set", link: link("p1", 1) })).rejects.toBeInstanceOf(LinksBlockedError);
			await expect(store.update({ type: "set", link: link("p1", 1) })).rejects.toBeInstanceOf(LinksBlockedError);
			expect(ad.files.get(path)).toBe(bad);
			const copies = [...ad.files.keys()].filter((k) => k.includes("unreadable"));
			expect(copies).toHaveLength(1);
			expect(ad.files.get(copies[0]!)).toBe(bad);
		}
	});

	it("serialises concurrent updates", async () => {
		const ad = new MemoryAdapter();
		const store = new PdfLinkStore(ad, folder);
		await Promise.all([1, 2, 3, 4, 5].map((i) => store.update({ type: "set", link: link(`p${i}`, i) })));
		const r = parseLinks(ad.files.get(path)!);
		expect(r.ok && r.data.links.map((l) => l.notesPage)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
	});
});

describe("split layout", () => {
	it("splits side by side on a wide landscape view and stacks otherwise", () => {
		expect(splitOrientation(1280, 800)).toBe("row"); // tablet held sideways
		expect(splitOrientation(800, 1280)).toBe("column"); // tablet upright
		expect(splitOrientation(412, 915)).toBe("column"); // phone upright
		expect(splitOrientation(740, 360)).toBe("row"); // phone sideways
		expect(splitOrientation(600, 300)).toBe("column"); // too narrow for two panes
	});

	it("keeps the divider inside its limits", () => {
		expect(clampRatio(0)).toBe(MIN_RATIO);
		expect(clampRatio(1)).toBe(MAX_RATIO);
		expect(clampRatio(NaN)).toBe(DEFAULT_RATIO);
		expect(ratioFromPointer(500, 100, 800)).toBeCloseTo(0.5);
		expect(ratioFromPointer(110, 100, 800)).toBe(MIN_RATIO);
		expect(ratioFromPointer(5, 0, 0)).toBe(DEFAULT_RATIO);
	});
});
