import { describe, expect, it } from "vitest";
import { createDocument, createId, createPage, createStroke, quantizePoint } from "../src/model/document";
import { AddAsset, AddElement, AddPage, Batch, DeletePage, History, InsertPages, SetPageSize } from "../src/model/history";
import { parse, serializeChecked } from "../src/model/serialize";
import {
	A4_HEIGHT, A4_WIDTH, type Asset, type NotebookDocument, type Page, type TextElement,
} from "../src/model/types";
import {
	BOARD_MARGIN, MIN_PHOTO_HEIGHT, boardShotElements, boardTime, contentBottom, planBoardShot,
} from "../src/view/board-shot-logic";
import {
	buildLecturePage, cleanTitle, defaultLectureTitle, isoDate, lectureHeaderText, lecturePageSize, parseIsoDate,
} from "../src/view/lecture-logic";
import { looseSheetPath, notebookBaseName, parentFolder } from "../src/library/loose-sheet-logic";
import { pageAssetIds, pageExcerpt, planPageMove, planSourceRemoval } from "../src/library/page-move";
import { fullFrameQuad } from "../src/scan/auto-sheet";
import { outputSize } from "../src/scan/geometry";
import { readSettings } from "../src/settings";

const fixedMeasure = (s: string, size: number) => s.length * size * 0.5;

function stroke(y: number) {
	return createStroke("#1e1e1e", 2, [quantizePoint(40, y, 0.5), quantizePoint(200, y + 10, 0.5)]);
}

function text(page: Page, content: string, y = 30): TextElement {
	const el: TextElement = { id: createId(), type: "text", x: 20, y, width: 200, text: content, fontSize: 12, color: "#1e1e1e" };
	(page.elements ??= []).push(el);
	return el;
}

const asset = (id: string, kind: Asset["kind"] = "image"): Asset => ({ id, kind, path: `Notebooks/_assets/${id}.${kind === "pdf" ? "pdf" : "jpg"}`, name: `${id}.jpg`, bytes: 10 });

describe("board shot placement", () => {
	const page = { width: A4_WIDTH, height: A4_HEIGHT };

	it("measures the lowest ink and element, ignoring empty pages", () => {
		const p = createPage();
		expect(contentBottom(p)).toBe(0);
		p.strokes.push(stroke(100));
		expect(contentBottom(p)).toBeCloseTo(111, 0);
		text(p, "hello", 400);
		expect(contentBottom(p, fixedMeasure)).toBeGreaterThan(400);
	});

	it("goes under the top margin of an empty page, centred, with the label above", () => {
		const plan = planBoardShot({ page, contentBottom: 0, visible: null, imageWidth: 2000, imageHeight: 1500 });
		expect(plan.placement).toBe("below-ink");
		expect(plan.label.y).toBe(BOARD_MARGIN);
		expect(plan.image.y).toBeGreaterThan(plan.label.y);
		expect(plan.image.x + plan.image.width / 2).toBeCloseTo(page.width / 2, 1);
		expect(plan.image.width / plan.image.height).toBeCloseTo(2000 / 1500, 2);
		expect(plan.image.x).toBeGreaterThanOrEqual(BOARD_MARGIN);
		expect(plan.image.x + plan.image.width).toBeLessThanOrEqual(page.width - BOARD_MARGIN + 0.01);
		expect(plan.pageHeight).toBeUndefined();
	});

	it("goes below the last ink when it fits", () => {
		const plan = planBoardShot({ page, contentBottom: 300, visible: null, imageWidth: 2000, imageHeight: 1500 });
		expect(plan.placement).toBe("below-ink");
		expect(plan.label.y).toBeGreaterThan(300);
		expect(plan.image.y + plan.image.height).toBeLessThanOrEqual(page.height - BOARD_MARGIN + 0.01);
	});

	it("starts at the top of the visible area when the writing is scrolled out of view above", () => {
		const plan = planBoardShot({ page, contentBottom: 100, visible: { minY: 400, maxY: 800 }, imageWidth: 800, imageHeight: 400 });
		expect(plan.label.y).toBe(400 + BOARD_MARGIN);
	});

	it("scales the photo down to the room left under the ink", () => {
		const full = planBoardShot({ page, contentBottom: 0, visible: null, imageWidth: 1000, imageHeight: 1000 });
		const plan = planBoardShot({ page, contentBottom: 600, visible: null, imageWidth: 1000, imageHeight: 1000 });
		expect(plan.placement).toBe("shrunk");
		expect(plan.image.height).toBeLessThan(full.image.height);
		expect(plan.image.height).toBeGreaterThanOrEqual(MIN_PHOTO_HEIGHT);
		expect(plan.image.y + plan.image.height).toBeLessThanOrEqual(page.height - BOARD_MARGIN + 0.01);
		expect(plan.image.width / plan.image.height).toBeCloseTo(1, 2);
	});

	it("grows an infinite page instead of shrinking the photo", () => {
		const plan = planBoardShot({ page: { ...page, infinite: true }, contentBottom: 700, visible: null, imageWidth: 1000, imageHeight: 1000 });
		expect(plan.placement).toBe("grown-page");
		expect(plan.pageHeight).toBeGreaterThan(page.height);
		expect(plan.image.y + plan.image.height).toBeLessThanOrEqual(plan.pageHeight! - BOARD_MARGIN + 0.01);
	});

	it("falls back to the visible area, over the content, when there is no room and the page cannot grow", () => {
		const plan = planBoardShot({ page, contentBottom: 820, visible: { minY: 200, maxY: 600 }, imageWidth: 1000, imageHeight: 700 });
		expect(plan.placement).toBe("over-content");
		expect(plan.image.y).toBeGreaterThanOrEqual(0);
		expect(plan.image.y + plan.image.height).toBeLessThanOrEqual(page.height);
		const centre = plan.image.y + plan.image.height / 2;
		expect(centre).toBeGreaterThan(200);
		expect(centre).toBeLessThan(600);
	});

	it("never produces a size the file format rejects, on tiny pages and odd photos", () => {
		for (const [w, h] of [[200, 200], [595, 842], [1200, 300]] as const) {
			for (const [iw, ih] of [[10, 10], [4000, 100], [100, 4000], [2400, 1800]] as const) {
				const plan = planBoardShot({ page: { width: w, height: h }, contentBottom: h * 0.9, visible: null, imageWidth: iw, imageHeight: ih });
				for (const v of [plan.image.x, plan.image.y, plan.image.width, plan.image.height, plan.label.x, plan.label.y, plan.label.width]) {
					expect(Number.isFinite(v)).toBe(true);
				}
				expect(plan.image.width).toBeGreaterThan(0);
				expect(plan.image.height).toBeGreaterThan(0);
			}
		}
	});

	it("formats the time as HH:MM", () => {
		expect(boardTime(new Date(2026, 9, 29, 9, 5))).toBe("09:05");
		expect(boardTime(new Date(2026, 9, 29, 14, 32))).toBe("14:32");
	});

	it("is one undo step: asset, photo, label (and page growth) go in and out together, and the file stays valid", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		const anchor = doc.pages[0]!;
		anchor.infinite = true;
		anchor.strokes.push(stroke(780));
		const a = asset("ab12");
		const plan = planBoardShot({ page: anchor, contentBottom: contentBottom(anchor), visible: null, imageWidth: 1600, imageHeight: 1200 });
		const { image, label } = boardShotElements(plan, a.id, "Board 14:32", createId);
		const commands = [new AddAsset(a)];
		if (plan.pageHeight !== undefined) commands.push(new SetPageSize(anchor.id, { width: anchor.width, height: anchor.height }, { width: anchor.width, height: plan.pageHeight }) as never);
		commands.push(new AddElement(anchor.id, image, 0) as never, new AddElement(anchor.id, label, 1) as never);
		const history = new History(() => doc);
		const before = serializeChecked(doc);
		history.execute(new Batch("Board shot", commands));
		expect(anchor.elements).toHaveLength(2);
		expect(anchor.elements![0]!.type).toBe("image");
		expect(anchor.elements![1]!.type).toBe("text");
		expect(doc.assets?.[a.id]).toBeDefined();
		expect(anchor.height).toBe(plan.pageHeight);
		expect(serializeChecked(doc).ok).toBe(true);
		history.undo();
		expect(history.canUndo()).toBe(false);
		expect(serializeChecked(doc)).toEqual(before);
	});

	it("keeps the whole frame when detection finds nothing", () => {
		const q = fullFrameQuad(1600, 1200);
		expect(outputSize(q, 2400)).toEqual({ width: 1600, height: 1200 });
		expect(outputSize(fullFrameQuad(4000, 3000), 2400)).toEqual({ width: 2400, height: 1800 });
	});
});

describe("new lecture", () => {
	it("formats and parses dates in local time", () => {
		const d = new Date(2026, 9, 29, 23, 59);
		expect(isoDate(d)).toBe("2026-10-29");
		expect(parseIsoDate("2026-10-29")).not.toBeNull();
		expect(isoDate(parseIsoDate("2026-02-03")!)).toBe("2026-02-03");
		for (const bad of ["", "2026-13-01", "2026-02-30", "29/10/2026", "2026-1-1", "abc"]) expect(parseIsoDate(bad)).toBeNull();
	});

	it("cleans the title and defaults to the notebook name", () => {
		expect(cleanTitle("  Analysis\n II \t ")).toBe("Analysis II");
		expect(cleanTitle("x".repeat(500))).toHaveLength(200);
		expect(defaultLectureTitle("Notebooks/Uni/Analysis II.notebook")).toBe("Analysis II");
		expect(defaultLectureTitle("Quick notes.notebook")).toBe("Quick notes");
		expect(defaultLectureTitle(null)).toBe("");
	});

	it("writes the title and the date in the header", () => {
		const d = new Date(2026, 9, 29);
		expect(lectureHeaderText("Physics", d)).toBe("Physics — 2026-10-29");
		expect(lectureHeaderText("   ", d)).toBe("2026-10-29");
	});

	it("builds a page like the previous one with the header as the only element", () => {
		const like = createPage({ width: 419.53, height: A4_WIDTH }, { kind: "ruled", spacing: 22.67 });
		const page = buildLecturePage(like, "Chemistry", new Date(2026, 9, 29));
		expect(page.id).not.toBe(like.id);
		expect(page.width).toBe(419.53);
		expect(page.paper).toEqual(like.paper);
		expect(page.strokes).toEqual([]);
		expect(page.elements).toHaveLength(1);
		const header = page.elements![0] as TextElement;
		expect(header.type).toBe("text");
		expect(header.text).toBe("Chemistry — 2026-10-29");
		expect(header.x + header.width).toBeLessThanOrEqual(page.width);
		expect(Object.isFrozen(header)).toBe(true);
	});

	it("starts an infinite page again at A4 proportions and falls back to A4 without a previous page", () => {
		expect(lecturePageSize({ width: 500, height: 9000, infinite: true }).height).toBeCloseTo(500 * (A4_HEIGHT / A4_WIDTH), 0);
		expect(lecturePageSize({ width: 500, height: 700 })).toEqual({ width: 500, height: 700 });
		const grown = buildLecturePage({ ...createPage(), height: 9000, infinite: true }, "T", new Date());
		expect(grown.infinite).toBe(true);
		expect(grown.height).toBeLessThan(2000);
		const first = buildLecturePage(undefined, "T", new Date());
		expect(first.width).toBe(A4_WIDTH);
		expect(first.height).toBe(A4_HEIGHT);
	});

	it("is one undo step and the document stays valid and parseable", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		const history = new History(() => doc);
		const page = buildLecturePage(doc.pages[doc.pages.length - 1], "Algebra", new Date(2026, 9, 29));
		history.execute(new AddPage(page, doc.pages.length));
		expect(doc.pages).toHaveLength(2);
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) {
			const back = parse(checked.text);
			expect(back.ok && (back.doc.pages[1]!.elements![0] as TextElement).text).toBe("Algebra — 2026-10-29");
		}
		history.undo();
		expect(doc.pages).toHaveLength(1);
		expect(history.canUndo()).toBe(false);
	});
});

describe("loose sheet location", () => {
	it("defaults to Quick notes in the notebooks folder", () => {
		expect(looseSheetPath("Notebooks", "")).toBe("Notebooks/Quick notes.notebook");
		expect(looseSheetPath("Notebooks/", "  ")).toBe("Notebooks/Quick notes.notebook");
		expect(looseSheetPath("", "")).toBe("Quick notes.notebook");
	});

	it("accepts a custom path and adds the extension", () => {
		expect(looseSheetPath("Notebooks", "Inbox/Today")).toBe("Inbox/Today.notebook");
		expect(looseSheetPath("Notebooks", "/Inbox/Today.notebook")).toBe("Inbox/Today.notebook");
		expect(looseSheetPath("Notebooks", "Inbox\\Today.NOTEBOOK")).toBe("Inbox/Today.notebook");
	});

	it("never escapes the vault, uses forbidden characters, or lands in the library's private folders", () => {
		expect(looseSheetPath("Notebooks", "../../etc/passwd")).toBe("etc/passwd.notebook");
		expect(looseSheetPath("Notebooks", "a/b:c?/n#1")).toBe("a/b c/n 1.notebook");
		expect(looseSheetPath("Notebooks", "Notebooks/_assets/x")).toBe("Notebooks/Quick notes.notebook");
		expect(looseSheetPath("Notebooks", "Notebooks/_backup/x.notebook")).toBe("Notebooks/Quick notes.notebook");
		expect(looseSheetPath("Notebooks", ".notebook")).toBe("Notebooks/Quick notes.notebook");
		expect(looseSheetPath("Notebooks", "..")).toBe("Notebooks/Quick notes.notebook");
	});

	it("splits a path", () => {
		expect(parentFolder("a/b/c.notebook")).toBe("a/b");
		expect(parentFolder("c.notebook")).toBe("");
		expect(notebookBaseName("a/b/c d.notebook")).toBe("c d");
	});

	it("is a setting that survives reading and ignores bad values", () => {
		expect(readSettings({}).looseSheetPath).toBe("");
		expect(readSettings({ looseSheetPath: "  Inbox/Q  " }).looseSheetPath).toBe("Inbox/Q");
		expect(readSettings({ looseSheetPath: 5 }).looseSheetPath).toBe("");
	});
});

describe("moving pages between notebooks", () => {
	function source(): NotebookDocument {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		doc.pages = [createPage(), createPage(), createPage()];
		doc.pages[0]!.strokes.push(stroke(100));
		text(doc.pages[0]!, "First page about limits");
		doc.assets = { aa11: asset("aa11"), bb22: asset("bb22"), cc33: asset("cc33", "pdf") };
		doc.pages[1]!.background = { kind: "image", asset: "aa11" };
		(doc.pages[1]!.elements ??= []).push({ id: createId(), type: "image", asset: "bb22", x: 10, y: 10, width: 50, height: 40, rotation: 0 });
		doc.pages[2]!.background = { kind: "pdf", asset: "cc33", page: 1 };
		doc.pages[2]!.strokes.push(stroke(300));
		return doc;
	}

	it("lists the assets a page uses", () => {
		expect(pageAssetIds(source().pages[1]!).sort()).toEqual(["aa11", "bb22"]);
		expect(pageAssetIds(source().pages[0]!)).toEqual([]);
	});

	it("copies the chosen pages in source order with new ids, and the assets the target lacks", () => {
		const src = source();
		const target = createDocument();
		target.assets = { aa11: asset("aa11") };
		const plan = planPageMove(src, [src.pages[2]!.id, src.pages[1]!.id], target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.pages).toHaveLength(2);
		expect(plan.pages[0]!.background).toEqual({ kind: "image", asset: "aa11" });
		expect(plan.pages[1]!.background).toEqual({ kind: "pdf", asset: "cc33", page: 1 });
		expect(plan.pages.map((p) => p.id)).not.toContain(src.pages[1]!.id);
		expect(plan.pages[1]!.strokes[0]!.id).not.toBe(src.pages[2]!.strokes[0]!.id);
		expect(plan.pages[1]!.strokes[0]!.points).toEqual(src.pages[2]!.strokes[0]!.points);
		expect(plan.assets.map((a) => a.id).sort()).toEqual(["bb22", "cc33"]); // aa11 is already in the target
		expect(plan.moved.map((m) => m.pageId)).toEqual([src.pages[1]!.id, src.pages[2]!.id]);
	});

	it("refuses an empty choice, an unknown page and a page whose asset the source does not list", () => {
		const src = source();
		const target = createDocument();
		expect(planPageMove(src, [], target)).toEqual({ ok: false, reason: "no-pages" });
		expect(planPageMove(src, ["nope"], target)).toEqual({ ok: false, reason: "unknown-page", pageId: "nope" });
		delete src.assets!.bb22;
		expect(planPageMove(src, [src.pages[1]!.id], target)).toEqual({ ok: false, reason: "missing-asset", assetId: "bb22" });
	});

	it("produces a target that is still a valid notebook, applied as one undo step", () => {
		const src = source();
		const target = createDocument(new Date("2026-10-29T09:00:00Z"));
		const plan = planPageMove(src, src.pages.map((p) => p.id), target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const history = new History(() => target);
		const before = JSON.stringify(target);
		history.execute(new Batch("Move pages in", [...plan.assets.map((a) => new AddAsset(a)), new InsertPages(plan.pages, target.pages.length)]));
		expect(target.pages).toHaveLength(4);
		expect(Object.keys(target.assets ?? {}).sort()).toEqual(["aa11", "bb22", "cc33"]);
		const checked = serializeChecked(target, true);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(parse(checked.text).ok).toBe(true);
		history.undo();
		expect(JSON.stringify(target)).toBe(before);
	});

	it("removes from the source only pages still as they were copied", () => {
		const src = source();
		const target = createDocument();
		const ids = [src.pages[0]!.id, src.pages[1]!.id];
		const plan = planPageMove(src, ids, target);
		if (!plan.ok) throw new Error("plan");
		// The first page is edited after the copy was taken.
		src.pages[0]!.strokes.push(stroke(500));
		const removal = planSourceRemoval(src, plan.moved);
		expect(removal.remove.map((p) => p.id)).toEqual([src.pages[1]!.id]);
		expect(removal.changed).toEqual([src.pages[0]!.id]);
		expect(removal.gone).toEqual([]);
		expect(removal.replacement).toBeNull();
	});

	it("reports pages deleted meanwhile", () => {
		const src = source();
		const plan = planPageMove(src, src.pages.map((p) => p.id), createDocument());
		if (!plan.ok) throw new Error("plan");
		const lastId = src.pages[2]!.id;
		src.pages.splice(2, 1);
		const removal = planSourceRemoval(src, plan.moved);
		expect(removal.gone).toEqual([lastId]);
		expect(removal.remove).toHaveLength(2);
		// Both remaining pages leave: the source gets a blank one.
		expect(removal.replacement).not.toBeNull();
	});

	it("gives a blank page when every page leaves, so the source is never empty, in one undo step", () => {
		const full = source();
		const plan = planPageMove(full, full.pages.map((p) => p.id), createDocument());
		if (!plan.ok) throw new Error("plan");
		const rem = planSourceRemoval(full, plan.moved);
		expect(rem.remove).toHaveLength(3);
		expect(rem.replacement).not.toBeNull();
		expect(rem.replacement!.strokes).toEqual([]);
		// As the view applies it: the replacement first, then the deletes from the highest index.
		const going = rem.remove.map((page) => ({ page, index: full.pages.indexOf(page) })).sort((a, b) => b.index - a.index);
		const history = new History(() => full);
		const before = serializeChecked(full);
		history.execute(new Batch("Move pages out", [new AddPage(rem.replacement!, full.pages.length), ...going.map((g) => new DeletePage(g.page, g.index))]));
		expect(full.pages).toHaveLength(1);
		expect(full.pages[0]!.id).toBe(rem.replacement!.id);
		expect(serializeChecked(full).ok).toBe(true);
		history.undo();
		expect(serializeChecked(full)).toEqual(before);
	});

	it("describes a page by the start of its first text box", () => {
		const src = source();
		expect(pageExcerpt(src.pages[0]!)).toBe("First page about limits");
		expect(pageExcerpt(src.pages[1]!)).toBe("");
		const long = createPage();
		text(long, "word ".repeat(40));
		expect(pageExcerpt(long, 20).length).toBeLessThanOrEqual(20);
		expect(pageExcerpt(long, 20).endsWith("…")).toBe(true);
	});
});
