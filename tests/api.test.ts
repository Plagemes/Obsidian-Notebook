import doc from "../docs/api.md?raw";
import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, NotebookApiError } from "../src/integration/api-errors";
import {
	API_METHODS, API_VERSION, KeyedQueue, buildImageElement, buildNewDocument, buildPages, checkAfter, checkFolder, checkName, checkPageNumber,
	describeNotebook, imageExtension, parseCreateOptions, parseImageOptions, parsePageSpec, planClosedEdit, prepareAddPages, prepareInsertImage,
} from "../src/integration/api-plan";
import { createDocument, createPage } from "../src/model/document";
import { parse, serialize } from "../src/model/serialize";
import type { Asset, NotebookDocument } from "../src/model/types";
import { PAGE_SIZES, PAPER_SPACING } from "../src/model/types";
import { sleep } from "./node-env";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const DEFAULTS = { pageSize: "a4", landscape: false, paper: "grid" } as const;

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof NotebookApiError) return e.code;
		throw e;
	}
	return "no error";
}

const ASSET: Asset = { id: "a".repeat(64), kind: "image", path: "Notebooks/_assets/aaaa.png", name: "image.png", bytes: 10 };

function notebookText(pages = 3): string {
	const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
	doc.id = "doc-1";
	for (let i = 1; i < pages; i++) doc.pages.push(createPage());
	doc.meta = { tags: ["physics"], favorite: true, cover: "#112233", bookmarks: doc.pages[1] ? [doc.pages[1].id] : [] };
	return serialize(doc);
}

describe("argument checks", () => {
	it("folders are vault paths", () => {
		expect(checkFolder("Notebooks/Physics")).toBe("Notebooks/Physics");
		expect(checkFolder("/Notebooks//Physics/")).toBe("Notebooks/Physics");
		expect(checkFolder("Notebooks\\Physics")).toBe("Notebooks/Physics");
		expect(checkFolder("")).toBe("");
		expect(checkFolder("/")).toBe("");
		expect(code(() => checkFolder("../outside"))).toBe("invalid-argument");
		expect(code(() => checkFolder("a/.hidden"))).toBe("invalid-argument");
		expect(code(() => checkFolder("a/b:c"))).toBe("invalid-argument");
		expect(code(() => checkFolder("a/b\u0001c"))).toBe("invalid-argument");
		expect(code(() => checkFolder(undefined))).toBe("invalid-argument");
		expect(code(() => checkFolder(3))).toBe("invalid-argument");
	});

	it("names", () => {
		expect(checkName("  Physics  ")).toBe("Physics");
		expect(checkName("Physics.notebook")).toBe("Physics");
		expect(code(() => checkName(""))).toBe("invalid-argument");
		expect(code(() => checkName("   "))).toBe("invalid-argument");
		expect(code(() => checkName(".notebook"))).toBe("invalid-argument");
		expect(code(() => checkName(null))).toBe("invalid-argument");
		expect(code(() => checkName("x".repeat(201)))).toBe("invalid-argument");
	});

	it("page numbers are 1-based whole numbers inside the notebook", () => {
		expect(checkPageNumber("page", 1, 3)).toBe(1);
		expect(checkPageNumber("page", 3, 3)).toBe(3);
		for (const bad of [0, 4, -1, 1.5, NaN, "2", undefined, null]) expect(code(() => checkPageNumber("page", bad, 3))).toBe("invalid-argument");
	});

	it("`after` is 0 to the page count, omitted means the end", () => {
		expect(checkAfter(undefined, 3)).toBe(3);
		expect(checkAfter(null, 3)).toBe(3);
		expect(checkAfter(0, 3)).toBe(0);
		expect(checkAfter(3, 3)).toBe(3);
		for (const bad of [4, -1, 1.5, "1"]) expect(code(() => checkAfter(bad, 3))).toBe("invalid-argument");
	});

	it("createNotebook options: known fields only, tags normalised, bad values refused", () => {
		expect(parseCreateOptions(undefined)).toEqual({ pages: 1, tags: [], open: false });
		expect(parseCreateOptions({ pageSize: "a5", landscape: true, paper: "ruled", pages: 4, tags: ["#Exam", "linear algebra", "exam"], favorite: true, cover: "#AABBCC", open: true })).toEqual({
			pageSize: "a5", landscape: true, paper: "ruled", pages: 4, tags: ["Exam", "linear-algebra"], favorite: true, cover: "#aabbcc", open: true,
		});
		const bad: unknown[] = [
			{ pagesize: "a4" }, { pageSize: "a3" }, { paper: "lined" }, { pages: 0 }, { pages: 501 }, { pages: 1.5 }, { tags: "x" }, { tags: [1] },
			{ tags: ["2026"] }, { cover: "blue" }, { open: "yes" }, { landscape: 1 }, "a4", [],
		];
		for (const o of bad) expect(code(() => parseCreateOptions(o))).toBe("invalid-argument");
	});

	it("page template: a count or a template, unknown fields refused", () => {
		expect(parsePageSpec(3)).toEqual({ count: 3 });
		expect(parsePageSpec({})).toEqual({ count: 1 });
		expect(parsePageSpec({ count: 2, pageSize: "letter", landscape: true, paper: "dotted", spacing: 20, infinite: true })).toEqual({
			count: 2, pageSize: "letter", landscape: true, paper: "dotted", spacing: 20, infinite: true,
		});
		for (const bad of [0, 501, 1.2, "3", undefined, null, [], { count: 0 }, { size: "a4" }, { paper: "x" }, { spacing: 0 }, { infinite: "yes" }]) {
			expect(code(() => parsePageSpec(bad))).toBe("invalid-argument");
		}
	});

	it("image options", () => {
		expect(parseImageOptions(undefined)).toEqual({});
		expect(parseImageOptions({ x: 10, y: 20.5, width: 100 })).toEqual({ x: 10, y: 20.5, width: 100 });
		for (const bad of [{ width: 0 }, { height: -1 }, { x: NaN }, { x: "1" }, { w: 5 }, { width: 100_000 }]) expect(code(() => parseImageOptions(bad))).toBe("invalid-argument");
	});

	it("sniffs the image format from the bytes, not the name", () => {
		expect(imageExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
		expect(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
		expect(imageExtension(new TextEncoder().encode("GIF89a...."))).toBe("gif");
		expect(imageExtension(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
		expect(imageExtension(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
		expect(imageExtension(new TextEncoder().encode("BM...."))).toBeNull();
		expect(imageExtension(new Uint8Array(0))).toBeNull();
	});
});

describe("createNotebook: the new document", () => {
	it("uses the plugin defaults for what the options leave out, and round-trips", () => {
		const doc = buildNewDocument(parseCreateOptions({}), DEFAULTS, NOW);
		expect(doc.pages).toHaveLength(1);
		expect(doc.pages[0]).toMatchObject({ width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height, paper: { kind: "grid" } });
		expect(doc.meta).toMatchObject({ tags: [], favorite: false });
		const back = parse(serialize(doc));
		expect(back.ok && back.doc.id).toBe(doc.id);
	});

	it("applies size, orientation, paper, page count and meta", () => {
		const doc = buildNewDocument(parseCreateOptions({ pageSize: "letter", landscape: true, paper: "ruled", pages: 3, tags: ["Exam"], favorite: true, cover: "#ff0000" }), DEFAULTS, NOW);
		expect(doc.pages).toHaveLength(3);
		for (const p of doc.pages) expect(p).toMatchObject({ width: 792, height: 612, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled } });
		expect(new Set(doc.pages.map((p) => p.id)).size).toBe(3);
		expect(doc.meta).toEqual({ tags: ["Exam"], favorite: true, cover: "#ff0000", bookmarks: [] });
		expect(parse(serialize(doc)).ok).toBe(true);
	});

	it("follows the default orientation of the settings", () => {
		const doc = buildNewDocument(parseCreateOptions({}), { ...DEFAULTS, landscape: true }, NOW);
		expect(doc.pages[0]!.width).toBeGreaterThan(doc.pages[0]!.height);
	});
});

describe("addPages: the pages", () => {
	const like = createPage(PAGE_SIZES.a5, { kind: "dotted", spacing: 20 });

	it("copies size and paper from the neighbouring page, like the Add page button", () => {
		const pages = buildPages({ count: 2 }, like);
		expect(pages).toHaveLength(2);
		for (const p of pages) expect(p).toMatchObject({ width: like.width, height: like.height, paper: { kind: "dotted", spacing: 20 }, strokes: [] });
		expect(pages[0]!.id).not.toBe(pages[1]!.id);
		expect(pages[0]).not.toHaveProperty("background");
		expect(pages[0]).not.toHaveProperty("infinite");
	});

	it("the template overrides only what it names", () => {
		const [p] = buildPages({ count: 1, paper: "ruled" }, like);
		expect(p).toMatchObject({ width: like.width, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled } });
		const [q] = buildPages({ count: 1, pageSize: "letter", landscape: true, infinite: true }, like);
		expect(q).toMatchObject({ width: 792, height: 612, infinite: true, paper: { kind: "dotted", spacing: 20 } });
		const [r] = buildPages({ count: 1, landscape: true }, like);
		expect(r!.width).toBeGreaterThan(r!.height);
		expect(r!.width).toBe(like.height);
		const [s] = buildPages({ count: 1, spacing: 30 }, like);
		expect(s!.paper).toEqual({ kind: "dotted", spacing: 30 });
	});

	it("without a neighbour it is a grid A4 page", () => {
		expect(buildPages({ count: 1 }, undefined)[0]).toMatchObject({ width: PAGE_SIZES.a4.width, paper: { kind: "grid" } });
	});
});

describe("closed notebook: the write plan", () => {
	it("inserts pages at the end by default and the result is valid, checked and verifiable", () => {
		const before = notebookText(3);
		const plan = planClosedEdit(before, prepareAddPages(parsePageSpec(2), undefined), NOW);
		if (!plan.ok) throw plan.error;
		expect(plan.result).toEqual({ added: 2, firstPage: 4, pageCount: 5 });
		const back = parse(plan.text);
		expect(back.ok && back.doc.pages).toHaveLength(5);
		expect(back.ok && back.doc.modifiedAt).toBe(NOW.toISOString());
		expect(plan.verify(plan.text)).toBe(true);
		expect(plan.verify(before)).toBe(false);
		// Everything else is untouched.
		if (!back.ok) throw new Error("unreachable");
		expect(back.doc.id).toBe("doc-1");
		expect(back.doc.meta).toMatchObject({ tags: ["physics"], favorite: true, cover: "#112233" });
		expect(back.doc.meta!.bookmarks).toHaveLength(1);
	});

	it("inserts after a given page, or at the start with 0", () => {
		const before = notebookText(3);
		const original = (parse(before) as { ok: true; doc: NotebookDocument }).doc.pages.map((p) => p.id);
		const middle = planClosedEdit(before, prepareAddPages(parsePageSpec(1), 1), NOW);
		const start = planClosedEdit(before, prepareAddPages(parsePageSpec(1), 0), NOW);
		if (!middle.ok || !start.ok) throw new Error("plan failed");
		expect(middle.result.firstPage).toBe(2);
		expect(start.result.firstPage).toBe(1);
		const ids = (text: string) => (parse(text) as { ok: true; doc: NotebookDocument }).doc.pages.map((p) => p.id);
		expect(ids(middle.text)).toEqual([original[0], expect.any(String), original[1], original[2]]);
		expect(ids(start.text).slice(1)).toEqual(original);
	});

	it("refuses a bad `after` with a typed error and writes nothing", () => {
		expect(code(() => planClosedEdit(notebookText(3), prepareAddPages(parsePageSpec(1), 9), NOW))).toBe("invalid-argument");
	});

	it("an unreadable file gives no text: it is never overwritten", () => {
		for (const text of ["", "not json", "{\"format\":\"other\"}", notebookText(2).slice(0, 200)]) {
			const plan = planClosedEdit(text, prepareAddPages(parsePageSpec(1), undefined), NOW);
			expect(plan.ok).toBe(false);
			if (!plan.ok) {
				expect(plan.error).toBeInstanceOf(NotebookApiError);
				expect(plan.error.code).toBe("unreadable");
			}
		}
	});

	it("a notebook from a newer version is not edited", () => {
		const newer = notebookText(1).replace(/"version":\s*\d+/, '"version": 99');
		const plan = planClosedEdit(newer, prepareAddPages(parsePageSpec(1), undefined), NOW);
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error.code).toBe("unreadable");
	});

	it("an older format is upgraded and flagged so the caller keeps the original", () => {
		const v5 = notebookText(1).replace(/"version":\s*\d+/, '"version": 5');
		const plan = planClosedEdit(v5, prepareAddPages(parsePageSpec(1), undefined), NOW);
		if (!plan.ok) throw plan.error;
		expect(plan.migrated).toBe(true);
	});

	it("an edit whose result would be invalid is refused", () => {
		const duplicate = () => ({
			commands: [{ label: "dup", apply: (d: NotebookDocument) => void d.pages.push(d.pages[0]!), revert: () => undefined }],
			result: null,
			verify: () => true,
		});
		const plan = planClosedEdit(notebookText(2), duplicate, NOW);
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error.code).toBe("write-failed");
	});

	it("inserts an image: asset registered, element on the right page, sized to fit", () => {
		const before = notebookText(2);
		const plan = planClosedEdit(before, prepareInsertImage(2, ASSET, { width: 800, height: 400 }, {}), NOW);
		if (!plan.ok) throw plan.error;
		const back = parse(plan.text);
		if (!back.ok) throw new Error("unreadable result");
		expect(back.doc.assets?.[ASSET.id]).toEqual(ASSET);
		expect(back.doc.pages[0]!.elements ?? []).toHaveLength(0);
		const [el] = back.doc.pages[1]!.elements!;
		expect(el).toMatchObject({ type: "image", asset: ASSET.id, rotation: 0 });
		expect(plan.result).toMatchObject({ page: 2, assetId: ASSET.id, elementId: el!.id });
		expect(plan.verify(plan.text)).toBe(true);
		if (el?.type === "image") {
			const page = back.doc.pages[1]!;
			expect(el.width).toBeLessThanOrEqual(page.width * 0.6 + 0.01);
			expect(el.width / el.height).toBeCloseTo(2, 1);
			expect(el.x).toBeGreaterThanOrEqual(0);
			expect(el.x + el.width).toBeLessThanOrEqual(page.width + 0.01);
		}
	});

	it("refuses an image for a page that does not exist", () => {
		expect(code(() => planClosedEdit(notebookText(2), prepareInsertImage(3, ASSET, { width: 10, height: 10 }, {}), NOW))).toBe("invalid-argument");
		expect(code(() => planClosedEdit(notebookText(2), prepareInsertImage(0, ASSET, { width: 10, height: 10 }, {}), NOW))).toBe("invalid-argument");
	});
});

describe("image element sizing", () => {
	const page = createPage();

	it("explicit width keeps the proportions, explicit width and height are used as given", () => {
		expect(buildImageElement(page, { width: 400, height: 200 }, "x", { width: 100 }, "id")).toMatchObject({ width: 100, height: 50 });
		expect(buildImageElement(page, { width: 400, height: 200 }, "x", { height: 100 }, "id")).toMatchObject({ width: 200, height: 100 });
		expect(buildImageElement(page, { width: 400, height: 200 }, "x", { width: 80, height: 90 }, "id")).toMatchObject({ width: 80, height: 90 });
	});

	it("explicit position is kept, otherwise centred", () => {
		const e = buildImageElement(page, { width: 100, height: 100 }, "x", { x: 10, y: 20 }, "id");
		expect([e.x, e.y]).toEqual([10, 20]);
		const c = buildImageElement(page, { width: 100, height: 100 }, "x", {}, "id");
		expect(c.x + c.width / 2).toBeCloseTo(page.width / 2, 0);
		expect(c.y + c.height / 2).toBeCloseTo(page.height / 2, 0);
	});

	it("an image without size is refused", () => {
		expect(code(() => buildImageElement(page, { width: 0, height: 10 }, "x", {}))).toBe("unsupported-image");
	});
});

describe("getNotebookInfo", () => {
	it("describes pages, tags and meta", () => {
		const doc = (parse(notebookText(3)) as { ok: true; doc: NotebookDocument }).doc;
		doc.pages[2]!.background = { kind: "pdf", asset: "p", page: 1 };
		doc.pages[2]!.infinite = true;
		doc.pages[0]!.elements = [{ id: "t", type: "text", x: 0, y: 0, width: 10, text: "hi", fontSize: 12, color: "#000000" }];
		const info = describeNotebook(doc, { path: "Notebooks/Physics.notebook", basename: "Physics" }, true);
		expect(info).toMatchObject({
			path: "Notebooks/Physics.notebook", name: "Physics", id: "doc-1", pageCount: 3, tags: ["physics"], open: true,
			meta: { favorite: true, cover: "#112233", bookmarks: [2] },
		});
		expect(info.pages.map((p) => p.number)).toEqual([1, 2, 3]);
		expect(info.pages[0]).toMatchObject({ textBoxes: 1, images: 0, background: null, infinite: false, bookmarked: false });
		expect(info.pages[1]).toMatchObject({ bookmarked: true });
		expect(info.pages[2]).toMatchObject({ background: "pdf", infinite: true });
		expect(JSON.parse(JSON.stringify(info))).toEqual(info);
	});
});

describe("KeyedQueue", () => {
	it("runs jobs of one key in order and different keys independently, also after a failure", async () => {
		const q = new KeyedQueue();
		const log: string[] = [];
		const wait = (ms: number) => sleep(ms);
		const a1 = q.run("a", async () => {
			await wait(20);
			log.push("a1");
			return 1;
		});
		const a2 = q.run("a", async () => {
			log.push("a2");
			throw new Error("boom");
		});
		const a3 = q.run("a", async () => {
			log.push("a3");
			return 3;
		});
		const b = q.run("b", async () => {
			log.push("b");
			return 2;
		});
		await expect(a2).rejects.toThrow("boom");
		expect(await Promise.all([a1, a3, b])).toEqual([1, 3, 2]);
		expect(log).toEqual(["b", "a1", "a2", "a3"]);
	});
});

describe("documentation", () => {
	it("describes every method, every error code and the version", () => {
		for (const method of API_METHODS) {
			expect(doc, method).toContain(`api.${method}(`);
			expect(doc, `${method} in the typings`).toMatch(new RegExp(`^\\s+${method}\\(`, "m"));
		}
		for (const c of API_ERROR_CODES) expect(doc, c).toContain(`\`${c}\``);
		expect(doc).toContain(API_VERSION);
	});

	it("shows Templater and QuickAdd", () => {
		expect(doc).toMatch(/Templater/);
		expect(doc).toMatch(/QuickAdd/);
		expect(doc).toContain('app.plugins.plugins["notebook"]');
	});
});
