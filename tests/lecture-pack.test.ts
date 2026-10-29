import { describe, expect, it, vi } from "vitest";
import { createLectureFromSlides, buildLectureDocument, headerTextElement, lectureNotebookName, type LectureDeps, type LectureSetup } from "../src/library/lecture-pack";
import {
	DEFAULT_LAYOUT_OPTIONS, NOTES_BOTTOM_RATIO, NOTES_RIGHT_RATIO, REFERENCE_SLIDE_SIDE, buildLecturePackPages, parseLayoutOptions,
	planLecturePages, slideGeometry, type LayoutOptions,
} from "../src/model/lecture-pack";
import { backgroundRect } from "../src/model/margins";
import { parse, serializeChecked } from "../src/model/serialize";
import { PAPER_SPACING, type Asset, type NotebookDocument } from "../src/model/types";

const pdf: Asset = { id: "a".repeat(64), kind: "pdf", path: "Notebooks/_assets/a.pdf", name: "slides.pdf", bytes: 100 };
const slide169 = { width: 960, height: 540 };
const slide43 = { width: 720, height: 540 };
const portrait = { width: 595.28, height: 841.89 };
const opts = (o: Partial<LayoutOptions>): LayoutOptions => ({ ...DEFAULT_LAYOUT_OPTIONS, ...o });

describe("slide geometry", () => {
	it("keeps the slide as it is for the 'slide' layout", () => {
		expect(slideGeometry(slide169, "slide")).toEqual({ width: 960, height: 540 });
	});

	it("scales the slide to the reference side and adds a right notes margin", () => {
		const g = slideGeometry(slide169, "notes-right");
		expect(g.margins).toEqual({ left: 0, right: Math.round(REFERENCE_SLIDE_SIDE * NOTES_RIGHT_RATIO * 100) / 100, bottom: 0 });
		expect(g.height).toBe(360);
		expect(g.width).toBeCloseTo(640 + 384, 2);
	});

	it("adds a bottom notes margin and leaves the width alone", () => {
		const g = slideGeometry(slide169, "notes-bottom");
		expect(g.margins).toEqual({ left: 0, right: 0, bottom: Math.round(360 * NOTES_BOTTOM_RATIO * 100) / 100 });
		expect(g.width).toBe(640);
		expect(g.height).toBeCloseTo(360 + 288, 2);
	});

	it.each(["notes-right", "notes-bottom"] as const)("the slide box keeps the aspect ratio of the slide (%s)", (layout) => {
		for (const size of [slide169, slide43, portrait]) {
			const g = slideGeometry(size, layout);
			const box = backgroundRect({ width: g.width, height: g.height, margins: g.margins });
			expect(box.width / box.height).toBeCloseTo(size.width / size.height, 2);
			expect(Math.max(box.width, box.height)).toBeCloseTo(REFERENCE_SLIDE_SIDE, 1);
			expect(box.x).toBe(0);
			expect(box.y).toBe(0);
		}
	});

	it("rejects a slide without a size", () => {
		expect(() => slideGeometry({ width: 0, height: 10 }, "notes-right")).toThrow();
		expect(() => slideGeometry({ width: 10, height: Number.NaN }, "slide")).toThrow();
	});
});

describe("page plan", () => {
	it("is one page per slide, blank paper, without notes", () => {
		const plan = planLecturePages([slide169, slide43], opts({ layout: "slide" }));
		expect(plan.map((p) => [p.kind, p.slide, p.paper])).toEqual([["slide", 0, "blank"], ["slide", 1, "blank"]]);
	});

	it("gives a notes layout the chosen paper", () => {
		const plan = planLecturePages([slide169], opts({ layout: "notes-right", notesPaper: "dotted" }));
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ kind: "slide", paper: "dotted" });
		expect(plan[0]!.margins?.right).toBeGreaterThan(0);
	});

	it("puts a blank notes page of the same size after every slide", () => {
		const plan = planLecturePages([slide169, portrait], opts({ layout: "notes-bottom", notesPageAfter: true, afterPaper: "millimetre" }));
		expect(plan.map((p) => [p.kind, p.slide])).toEqual([["slide", 0], ["notes", 0], ["slide", 1], ["notes", 1]]);
		for (let i = 0; i < plan.length; i += 2) {
			expect(plan[i + 1]).toMatchObject({ width: plan[i]!.width, height: plan[i]!.height, paper: "millimetre" });
			expect(plan[i + 1]!.margins).toBeUndefined();
		}
	});

	it("works with the slide itself as the page", () => {
		const plan = planLecturePages([slide43], opts({ layout: "slide", notesPageAfter: true, afterPaper: "grid" }));
		expect(plan.map((p) => [p.kind, p.width, p.height, p.paper])).toEqual([["slide", 720, 540, "blank"], ["notes", 720, 540, "grid"]]);
	});
});

describe("pages of the lecture pack", () => {
	it("number the PDF pages from firstPage and keep notes pages without a background", () => {
		const pages = buildLecturePackPages(pdf, [slide169, slide169, slide169], 4, opts({ layout: "notes-right", notesPageAfter: true }));
		expect(pages).toHaveLength(6);
		expect(pages.flatMap((p) => (p.background?.kind === "pdf" ? [p.background.page] : []))).toEqual([4, 5, 6]);
		expect(pages.filter((p) => !p.background)).toHaveLength(3);
		expect(new Set(pages.map((p) => p.id)).size).toBe(6);
		expect(pages[0]!.paper).toEqual({ kind: "ruled", spacing: PAPER_SPACING.ruled });
		expect(pages[1]!.paper).toEqual({ kind: "grid", spacing: PAPER_SPACING.grid });
	});

	it("without a layout are the pages 'Import PDF' always made", () => {
		const [p] = buildLecturePackPages(pdf, [slide43], 1, opts({}));
		expect(p).toMatchObject({ width: 720, height: 540, background: { kind: "pdf", asset: pdf.id, page: 1 }, paper: { kind: "blank" } });
		expect(p!.margins).toBeUndefined();
	});

	it("refuse an asset that is not a PDF", () => {
		expect(() => buildLecturePackPages({ ...pdf, kind: "image" }, [slide43], 1, opts({}))).toThrow();
	});

	it.each(["slide", "notes-right", "notes-bottom"] as const)("make a document that passes the format check (%s)", (layout) => {
		const setup: LectureSetup = { title: "Analysis I", date: new Date(2026, 9, 29, 12), header: "text", layout: opts({ layout, notesPageAfter: true }) };
		const doc = buildLectureDocument(pdf, [slide169, slide43, portrait], setup);
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) {
			const back = parse(checked.text);
			expect(back.ok).toBe(true);
			if (back.ok) {
				expect(back.doc.pages).toHaveLength(6);
				expect(back.doc.pages[0]!.margins).toEqual(doc.pages[0]!.margins);
			}
		}
	});
});

describe("lecture header", () => {
	const date = new Date(2026, 9, 29, 12);
	const base = (header: LectureSetup["header"], layout: LayoutOptions): NotebookDocument => buildLectureDocument(pdf, [slide169, slide169], { title: "  Physics\n II ", date, header, layout });

	it("page: a header page before the slides, sized and papered like the first slide page", () => {
		const doc = base("page", opts({ layout: "notes-right" }));
		expect(doc.pages).toHaveLength(3);
		const [head, first] = doc.pages;
		expect(head!.background).toBeUndefined();
		expect(head!.elements?.[0]).toMatchObject({ type: "text", text: "Physics II — 2026-10-29" });
		expect({ w: head!.width, h: head!.height, p: head!.paper.kind }).toEqual({ w: first!.width, h: first!.height, p: "ruled" });
		expect(first!.elements).toBeUndefined();
	});

	it("text: a text box on the first slide page, none on the others", () => {
		const doc = base("text", opts({ layout: "notes-bottom" }));
		expect(doc.pages).toHaveLength(2);
		expect(doc.pages[0]!.elements).toHaveLength(1);
		expect(doc.pages[1]!.elements).toBeUndefined();
	});

	it("none: only the slides", () => {
		const doc = base("none", opts({ layout: "slide" }));
		expect(doc.pages).toHaveLength(2);
		expect(doc.pages.every((p) => p.background && !p.elements)).toBe(true);
	});

	it("the text lands in the notes area and inside the page", () => {
		for (const layout of ["slide", "notes-right", "notes-bottom"] as const) {
			const [page] = buildLecturePackPages(pdf, [slide169], 1, opts({ layout }));
			const el = headerTextElement(page!, "Physics", date);
			const box = backgroundRect(page!);
			expect(el.x + el.width).toBeLessThanOrEqual(page!.width);
			expect(el.y).toBeLessThan(page!.height);
			if (layout === "notes-right") expect(el.x).toBeGreaterThanOrEqual(box.x + box.width);
			if (layout === "notes-bottom") expect(el.y).toBeGreaterThanOrEqual(box.y + box.height);
		}
	});

	it("names the notebook after the title and the date, or after the PDF", () => {
		expect(lectureNotebookName(" Physics II ", "slides.pdf", date)).toBe("Physics II 2026-10-29");
		expect(lectureNotebookName("", "Courses/week 3.pdf", date)).toBe("week 3 2026-10-29");
	});
});

describe("layout options from storage", () => {
	it("fall back to the defaults for anything unusable", () => {
		expect(parseLayoutOptions(null)).toEqual(DEFAULT_LAYOUT_OPTIONS);
		expect(parseLayoutOptions("x")).toEqual(DEFAULT_LAYOUT_OPTIONS);
		expect(parseLayoutOptions({ layout: "diagonal", notesPaper: 3, notesPageAfter: "yes", afterPaper: "lined" })).toEqual(DEFAULT_LAYOUT_OPTIONS);
	});

	it("keep valid values", () => {
		const o = opts({ layout: "notes-bottom", notesPaper: "dotted", notesPageAfter: true, afterPaper: "millimetre" });
		expect(parseLayoutOptions(JSON.parse(JSON.stringify(o)))).toEqual(o);
	});
});

describe("lecture from slides flow", () => {
	const setup: LectureSetup = { title: "Algebra", date: new Date(2026, 9, 29, 12), header: "page", layout: opts({ layout: "notes-right", notesPageAfter: true }) };

	function deps(over: Partial<LectureDeps<string>> = {}) {
		const created: Array<{ folder: string; name: string; doc: NotebookDocument }> = [];
		const notify = vi.fn();
		const d: LectureDeps<string> = {
			pick: async () => ({ name: "Course/week1.pdf", bytes: new ArrayBuffer(10) }),
			ask: async () => setup,
			store: async () => pdf,
			pageSizes: async () => [slide169, slide169],
			create: async (folder, name, doc) => {
				created.push({ folder, name, doc });
				return `${folder}/${name}`;
			},
			open: async () => {},
			progress: () => () => {},
			notify,
			messages: { working: () => "w", failed: (e) => `failed ${e}`, empty: () => "empty" },
			...over,
		};
		return { d, created, notify };
	}

	it("creates the notebook in the folder and opens it", async () => {
		const open = vi.fn(async () => {});
		const { d, created } = deps({ open });
		expect(await createLectureFromSlides(d, "Notebooks/Algebra")).toBe(true);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ folder: "Notebooks/Algebra", name: "Algebra 2026-10-29" });
		expect(created[0]!.doc.pages).toHaveLength(1 + 4);
		expect(Object.keys(created[0]!.doc.assets ?? {})).toEqual([pdf.id]);
		expect(open).toHaveBeenCalledWith("Notebooks/Algebra/Algebra 2026-10-29");
	});

	it("asks with the PDF's name as the default title", async () => {
		const ask = vi.fn(async () => setup);
		await createLectureFromSlides(deps({ ask }).d, "x");
		expect(ask).toHaveBeenCalledWith("week1");
	});

	it("stores nothing and creates nothing when cancelled", async () => {
		const store = vi.fn(async () => pdf);
		const a = deps({ pick: async () => null, store });
		expect(await createLectureFromSlides(a.d, "x")).toBe(false);
		const b = deps({ ask: async () => null, store });
		expect(await createLectureFromSlides(b.d, "x")).toBe(false);
		expect(store).not.toHaveBeenCalled();
		expect(a.created.length + b.created.length).toBe(0);
	});

	it("reports an empty PDF and a failure without throwing", async () => {
		const empty = deps({ pageSizes: async () => [] });
		expect(await createLectureFromSlides(empty.d, "x")).toBe(false);
		expect(empty.notify).toHaveBeenCalledWith("empty");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const bad = deps({ store: async () => { throw new Error("disk full"); } });
		expect(await createLectureFromSlides(bad.d, "x")).toBe(false);
		expect(bad.notify).toHaveBeenCalledWith("failed disk full");
		expect(bad.created).toHaveLength(0);
		err.mockRestore();
	});

	it("shows progress for a large PDF and hides it at the end", async () => {
		const hide = vi.fn();
		const progress = vi.fn(() => hide);
		await createLectureFromSlides(deps({ progress, pick: async () => ({ name: "big.pdf", bytes: new ArrayBuffer(2 * 1024 * 1024) }) }).d, "x");
		expect(progress).toHaveBeenCalledTimes(1);
		expect(hide).toHaveBeenCalledTimes(1);
	});
});
