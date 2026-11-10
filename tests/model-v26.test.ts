/**
 * Format v26: rotate and crop an imported PDF page (#76) — the geometry of a view (turn, crop, size), the plan of a change (the rigid matrix, margins that
 * grow, ink that would end up above the page), the fields and their lenient read and strict write, the v25 -> v26 migration, the History command
 * (ink, elements, areas, comments, states; one undo step; locks; page times), the text boxes and links mapped through the view, the PDF store rendering a
 * view, and the same page in every export.
 */
import { describe, expect, it } from "vitest";
import { apply } from "../src/ink/transform";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { createDocument, createStroke } from "../src/model/document";
import { Batch, History } from "../src/model/history";
import { describeCommand } from "../src/model/history-describe";
import { backgroundRect } from "../src/model/margins";
import { MIGRATIONS } from "../src/model/migrations";
import {
	backgroundViewKey, cropView, effectiveCrop, isIdentityView, mapRect, planPdfView, rotateView, sameView, sourceToPage, sourceToView, viewKey, viewOf, viewSize, viewToSource, withView,
} from "../src/model/pdf-view";
import { buildViewCommands, editedView, pagesOfSamePdf } from "../src/model/pdf-view-ops";
import { pageContentBoxes, planPageView, SetPdfView } from "../src/model/pdf-view-command";
import { freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type AreaElement, type ImageElement, type NotebookDocument, type Page, type PageComment, type PageStates, type TextElement } from "../src/model/types";
import { boxesOnPage, type PageTextContent } from "../src/pdf/text-items";
import { pageToPdf, pdfRectToPage } from "../src/pdf/text-select";
import { isAbortError, PdfStore } from "../src/pdf/pdf-store";
import type { PdfLib, PdfPage } from "../src/pdf/pdfjs-types";
import { cropToFrame, dragFrame, frameToCrop, wholeFrame } from "../src/view/pdf-crop-logic";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { getAt, parseRaw, setAt } from "./raw-json";

const stamp = "2026-11-10T10:00:00.000Z";
const ASSET = "abcdef0123456789abcdef01";
const PICTURE = "ab".repeat(12);
/** The PDF page of the tests: 600 × 800 pt. */
const SOURCE = { width: 600, height: 800 };

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

/** A document with one page showing PDF page 1 of a 600 × 800 pt PDF, with one stroke, a text box, an image and an area on it. */
function pdfDoc(extra: Partial<Page> = {}): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.assets = {
		[ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 },
		[PICTURE]: { id: PICTURE, kind: "image", path: "N/_assets/p.png", name: "p.png", bytes: 10 },
	};
	const page = doc.pages[0]!;
	page.id = "p1";
	page.width = SOURCE.width;
	page.height = SOURCE.height;
	page.background = { kind: "pdf", asset: ASSET, page: 1 };
	page.strokes.push(freezeStroke({ ...createStroke("#112233", 2, [[100, 200, 0.5], [150.25, 260, 0.5], [180, 300, 0.7]]), id: "s1" }));
	const text: TextElement = { id: "t1", type: "text", x: 300, y: 400, width: 100, text: "note", fontSize: 12, color: "#000000" };
	const image: ImageElement = { id: "i1", type: "image", asset: PICTURE, x: 50, y: 500, width: 100, height: 60, rotation: 0.25 };
	const area: AreaElement = { id: "a1", type: "area", x: 200, y: 100, width: 120, height: 20, color: "#FACC15" };
	page.elements = [Object.freeze(text), Object.freeze(image), Object.freeze(area)];
	Object.assign(page, extra);
	return { doc, page };
}

describe("pdf view: the geometry", () => {
	it("knows an identity view", () => {
		expect(isIdentityView(undefined)).toBe(true);
		expect(isIdentityView({})).toBe(true);
		expect(isIdentityView({ rotate: 90 })).toBe(false);
		expect(isIdentityView({ crop: { x: 0, y: 0, width: 100, height: 100 } })).toBe(false);
		expect(viewOf(undefined)).toBeUndefined();
		expect(viewOf({ kind: "image", asset: "a" })).toBeUndefined();
		expect(viewOf({ kind: "pdf", asset: "a", page: 1 })).toBeUndefined();
		expect(viewOf({ kind: "pdf", asset: "a", page: 1, rotate: 180 })).toEqual({ rotate: 180 });
	});

	it("turns the page clockwise: the corners go where a reader puts them", () => {
		const at = (view: Parameters<typeof sourceToView>[0], x: number, y: number) => apply(sourceToView(view, SOURCE), x, y);
		// A quarter turn clockwise: the top-left corner goes to the top-right; the page is 800 wide and 600 high.
		expect(viewSize({ rotate: 90 }, SOURCE)).toEqual({ width: 800, height: 600 });
		expect(at({ rotate: 90 }, 0, 0)).toEqual([800, 0]);
		expect(at({ rotate: 90 }, 600, 0)).toEqual([800, 600]);
		expect(at({ rotate: 90 }, 0, 800)).toEqual([0, 0]);
		expect(at({ rotate: 180 }, 0, 0)).toEqual([600, 800]);
		expect(viewSize({ rotate: 180 }, SOURCE)).toEqual(SOURCE);
		expect(at({ rotate: 270 }, 0, 0)).toEqual([0, 600]);
		expect(at({ rotate: 270 }, 600, 0)).toEqual([0, 0]);
		expect(viewSize({ rotate: 270 }, SOURCE)).toEqual({ width: 800, height: 600 });
	});

	it("crops first and turns second", () => {
		const crop = { x: 100, y: 50, width: 300, height: 200 };
		expect(viewSize({ crop }, SOURCE)).toEqual({ width: 300, height: 200 });
		expect(viewSize({ crop, rotate: 90 }, SOURCE)).toEqual({ width: 200, height: 300 });
		expect(apply(sourceToView({ crop }, SOURCE), 100, 50)).toEqual([0, 0]);
		expect(apply(sourceToView({ crop }, SOURCE), 400, 250)).toEqual([300, 200]);
		// The crop's top-left corner goes to the top-right of the turned crop.
		expect(apply(sourceToView({ crop, rotate: 90 }, SOURCE), 100, 50)).toEqual([200, 0]);
		const back = viewToSource({ crop, rotate: 90 }, SOURCE);
		expect(apply(back, 200, 0)).toEqual([100, 50]);
	});

	it("clamps a crop to the PDF page and shows the whole page when what is left is a sliver", () => {
		expect(effectiveCrop({ crop: { x: 500, y: 700, width: 300, height: 300 } }, SOURCE)).toEqual({ x: 500, y: 700, width: 100, height: 100 });
		expect(effectiveCrop({ crop: { x: 590, y: 0, width: 200, height: 200 } }, SOURCE)).toEqual({ x: 0, y: 0, width: 600, height: 800 });
		expect(effectiveCrop(undefined, SOURCE)).toEqual({ x: 0, y: 0, width: 600, height: 800 });
		expect(viewSize({ crop: { x: 590, y: 0, width: 200, height: 200 } }, SOURCE)).toEqual(SOURCE);
	});

	it("composes turns and keeps the crop in PDF coordinates", () => {
		const crop = { x: 10, y: 20, width: 100, height: 200 };
		expect(rotateView(undefined, 1)).toEqual({ rotate: 90 });
		expect(rotateView(undefined, -1)).toEqual({ rotate: 270 });
		expect(rotateView({ rotate: 90 }, 3)).toBeUndefined();
		expect(rotateView({ rotate: 270 }, 1)).toBeUndefined();
		expect(rotateView({ crop }, 2)).toEqual({ rotate: 180, crop });
		expect(rotateView({ rotate: 90, crop }, -1)).toEqual({ crop });
		expect(cropView({ rotate: 90 }, crop)).toEqual({ rotate: 90, crop });
		expect(cropView({ rotate: 90, crop }, undefined)).toEqual({ rotate: 90 });
		expect(cropView(undefined, { x: 1, y: 2, width: 3, height: 4 })).toBeUndefined();
		expect(sameView({ rotate: 90 }, { rotate: 90 })).toBe(true);
		expect(sameView({ rotate: 90 }, undefined)).toBe(false);
		expect(viewKey(undefined)).toBe("");
		expect(viewKey({ rotate: 90 })).not.toBe(viewKey({ rotate: 180 }));
		expect(backgroundViewKey({ kind: "pdf", asset: "a", page: 2, rotate: 90 })).toBe("a|2|r90");
		expect(backgroundViewKey({ kind: "image", asset: "a" })).toBe("");
	});

	it("withView writes only what is set, rounded", () => {
		const bg = { kind: "pdf" as const, asset: "a", page: 3 };
		expect(withView(bg, undefined)).toEqual(bg);
		expect(withView({ ...bg, rotate: 90 }, undefined)).toEqual(bg);
		expect(withView(bg, { rotate: 180, crop: { x: 1.234, y: 2, width: 100.005, height: 50 } })).toEqual({ ...bg, rotate: 180, crop: { x: 1.23, y: 2, width: 100.01, height: 50 } });
		// An invalid crop is not written.
		expect(withView(bg, { crop: { x: 0, y: 0, width: 2, height: 50 } })).toEqual(bg);
	});

	it("maps rectangles through a quarter turn", () => {
		expect(mapRect(sourceToView({ rotate: 90 }, SOURCE), { x: 0, y: 0, width: 100, height: 40 })).toEqual({ x: 760, y: 0, width: 40, height: 100 });
	});
});

describe("pdf view: the plan of a change", () => {
	it("turns a plain page: the size swaps and the matrix carries a point to the same place on the PDF", () => {
		const { page } = pdfDoc();
		const plan = planPdfView(page, SOURCE, { rotate: 90 })!;
		expect(plan.width).toBe(800);
		expect(plan.height).toBe(600);
		expect(plan.margins).toBeUndefined();
		expect(plan.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, rotate: 90 });
		expect(plan.matrix).toEqual([0, 1, -1, 0, 800, 0]);
		expect(apply(plan.matrix, 10, 20)).toEqual([780, 10]);
		expect(plan.above).toBe(0);
		expect(plan.grown).toEqual({ left: 0, right: 0, bottom: 0 });
	});

	it("crops by moving everything and shrinking the page", () => {
		const { page } = pdfDoc();
		const plan = planPdfView(page, SOURCE, { crop: { x: 100, y: 50, width: 300, height: 200 } })!;
		expect(plan).toMatchObject({ width: 300, height: 200 });
		expect(plan.matrix).toEqual([1, 0, 0, 1, -100, -50]);
	});

	it("a turn and the turn back are the identity", () => {
		const { page } = pdfDoc();
		const there = planPdfView(page, SOURCE, { rotate: 90 })!;
		const turned = { ...page, width: there.width, height: there.height, background: there.background };
		const back = planPdfView(turned, SOURCE, undefined)!;
		expect(back.width).toBe(600);
		expect(back.height).toBe(800);
		expect(back.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		const [x, y] = apply(there.matrix, 123.5, 456.25);
		expect(apply(back.matrix, x, y)).toEqual([123.5, 456.25]);
	});

	it("keeps the margins and moves the background box with them", () => {
		const { page } = pdfDoc({ width: 720, height: 830, margins: { left: 20, right: 100, bottom: 30 } });
		const plan = planPdfView(page, SOURCE, { rotate: 90 })!;
		expect(plan.margins).toEqual({ left: 20, right: 100, bottom: 30 });
		expect(plan.width).toBe(920);
		expect(plan.height).toBe(630);
		// The top-left of the PDF (page point (20, 0)) goes to the top-right of the turned PDF.
		expect(apply(plan.matrix, 20, 0)).toEqual([820, 0]);
	});

	it("grows the margins to keep ink that would end up beyond the left, right or bottom edge", () => {
		const { page } = pdfDoc({ width: 720, height: 830, margins: { left: 20, right: 100, bottom: 30 } });
		// A note in the right margin (x 650..700, y 100..140): turned clockwise it lands below the PDF, in the bottom margin.
		const note = { minX: 650, minY: 100, maxX: 700, maxY: 140 };
		const plan = planPdfView(page, SOURCE, { rotate: 90 }, [note])!;
		expect(plan.above).toBe(0);
		expect(plan.height).toBeGreaterThanOrEqual(630);
		// Whatever the margins did, the note is on the new page.
		const r = mapRect(plan.matrix, { x: 650, y: 100, width: 50, height: 40 });
		expect(r.x).toBeGreaterThanOrEqual(0);
		expect(r.y + r.height).toBeLessThanOrEqual(plan.height);
		expect(r.x + r.width).toBeLessThanOrEqual(plan.width);
	});

	it("grows the left margin and shifts everything when the content would end up left of the page", () => {
		// A bottom-margin note under the PDF turned clockwise goes to the left of it.
		const { page } = pdfDoc({ width: 600, height: 880, margins: { left: 0, right: 0, bottom: 80 } });
		const note = { minX: 100, minY: 820, maxX: 200, maxY: 860 };
		const plan = planPdfView(page, SOURCE, { rotate: 90 }, [note])!;
		expect(plan.grown.left).toBeGreaterThan(0);
		expect(plan.margins!.left).toBe(plan.grown.left);
		const r = mapRect(plan.matrix, { x: 100, y: 820, width: 100, height: 40 });
		expect(r.x).toBeGreaterThanOrEqual(0);
		// The PDF box moved right by the same amount: the note is still beside the same part of it.
		expect(apply(plan.matrix, 0, 0)[0]).toBe(800 + plan.grown.left);
	});

	it("refuses (counts) what would end up above the top edge: the page has no top margin", () => {
		const { page } = pdfDoc({ width: 720, height: 800, margins: { left: 0, right: 120, bottom: 0 } });
		const note = { minX: 640, minY: 100, maxX: 700, maxY: 140 };
		const plan = planPdfView(page, SOURCE, { rotate: 270 }, [note])!;
		expect(plan.above).toBe(1);
		// Items that were wholly off the page before are not counted.
		expect(planPdfView(page, SOURCE, { rotate: 270 }, [{ minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 }])!.above).toBe(0);
	});

	it("is null for a page without a PDF background", () => {
		expect(planPdfView({ width: 100, height: 100, background: { kind: "image", asset: "a" } }, SOURCE, { rotate: 90 })).toBeNull();
		expect(planPdfView({ width: 100, height: 100 }, SOURCE, { rotate: 90 })).toBeNull();
	});
});

describe("format v26: the fields", () => {
	it("writes rotate and crop after page, only when set, and reads them back", () => {
		const { doc, page } = pdfDoc();
		expect(serialize(doc)).not.toContain('"rotate"');
		expect(serialize(doc)).not.toContain('"crop"');
		page.background = { kind: "pdf", asset: ASSET, page: 1, rotate: 90, crop: { x: 10, y: 20.5, width: 300, height: 400.25 } };
		const text = serialize(doc);
		expect(text).toContain(`"background": {"kind":"pdf","asset":"${ASSET}","page":1,"rotate":90,"crop":{"x":10,"y":20.5,"width":300,"height":400.25}}`);
		const r = parsed(text);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.background).toEqual(page.background);
		expect(serialize(r.doc)).toBe(text);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("reads every rotation and a crop with only the fields it knows", () => {
		for (const rotate of [90, 180, 270] as const) {
			const { doc, page } = pdfDoc();
			page.background = { kind: "pdf", asset: ASSET, page: 1, rotate };
			expect(parsed(serialize(doc)).doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, rotate });
		}
		const raw = parseRaw(serialize(pdfDoc().doc));
		setAt(raw, ["pages", 0, "background", "crop"], { x: 1, y: 2, width: 100, height: 200, extra: true });
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, crop: { x: 1, y: 2, width: 100, height: 200 } });
		expect(r.dropped).toBeUndefined();
	});

	const invalid: Array<[string, string, unknown]> = [
		["rotate 0", "rotate", 0],
		["rotate 45", "rotate", 45],
		["rotate 360", "rotate", 360],
		["rotate as a string", "rotate", "90"],
		["rotate negative", "rotate", -90],
		["crop as a number", "crop", 5],
		["crop as an array", "crop", [0, 0, 100, 100]],
		["crop without a side", "crop", { x: 0, y: 0, width: 100 }],
		["crop negative x", "crop", { x: -1, y: 0, width: 100, height: 100 }],
		["crop too thin", "crop", { x: 0, y: 0, width: 8, height: 100 }],
		["crop beyond the limit", "crop", { x: 0, y: 0, width: 100, height: 14401 }],
		["crop with a string", "crop", { x: "0", y: 0, width: 100, height: 100 }],
	];
	for (const [name, key, value] of invalid) {
		it(`drops and counts ${name} when reading leniently, and refuses it when reading strictly`, () => {
			const raw = parseRaw(serialize(pdfDoc().doc));
			setAt(raw, ["pages", 0, "background", key], value);
			const r = parsed(JSON.stringify(raw));
			// The PDF page itself stays; it is shown as before.
			expect(r.dropped).toBe(1);
			expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
			const strict = serializeChecked({ ...r.doc, pages: [{ ...r.doc.pages[0]!, background: { kind: "pdf", asset: ASSET, page: 1, [key]: value } as never }] }, true);
			expect(strict.ok).toBe(false);
		});
	}

	it("ignores a rotate or crop on an image background (they belong to PDF pages)", () => {
		const { doc, page } = pdfDoc();
		doc.assets = { ...doc.assets, ["cd".repeat(12)]: { id: "cd".repeat(12), kind: "image", path: "N/_assets/y.png", name: "scan.png", bytes: 5 } };
		page.background = { kind: "image", asset: "cd".repeat(12) };
		const raw = parseRaw(serialize(doc));
		setAt(raw, ["pages", 0, "background", "rotate"], 90);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.background).toEqual({ kind: "image", asset: "cd".repeat(12) });
		expect(r.dropped).toBeUndefined();
	});

	it("the strict writer refuses a rotate or crop that is not valid", () => {
		for (const bad of [{ rotate: 0 }, { rotate: 45 }, { crop: { x: 0, y: 0, width: 1, height: 100 } }, { crop: { x: Number.NaN, y: 0, width: 100, height: 100 } }]) {
			const { doc, page } = pdfDoc();
			page.background = { kind: "pdf", asset: ASSET, page: 1, ...bad } as never;
			expect(serializeChecked(doc, true).ok, JSON.stringify(bad)).toBe(false);
		}
	});
});

describe("format v26: migration from v25", () => {
	function v25Raw(): ReturnType<typeof parseRaw> {
		return {
			format: FORMAT_ID, version: 25, id: "doc", createdAt: stamp, modifiedAt: stamp,
			meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
			assets: { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } },
			pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, background: { kind: "pdf", asset: ASSET, page: 1 }, strokes: [] }],
		};
	}

	it("changes nothing but the version of a valid v25 document", () => {
		const raw = v25Raw();
		const migrated = MIGRATIONS[25]!(raw);
		expect(migrated).toEqual({ ...raw, version: 26 });
		expect(migrated.pages).toBe(raw.pages);
	});

	it("drops stray rotate and crop keys of a v25 file (a v25 reader ignored them)", () => {
		const raw = v25Raw();
		setAt(raw, ["pages", 0, "background", "rotate"], 90);
		setAt(raw, ["pages", 0, "background", "crop"], { x: 0, y: 0, width: 100, height: 100 });
		const migrated = MIGRATIONS[25]!(raw);
		expect(getAt(migrated, ["pages", 0, "background"])).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		// The input is not touched.
		expect(getAt(raw, ["pages", 0, "background", "rotate"])).toBe(90);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(25);
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
	});

	it("reads a v25 file and writes it as v26", () => {
		const r = parsed(JSON.stringify(v25Raw()));
		expect(r.migratedFrom).toBe(25);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(CURRENT_VERSION).toBe(26);
		expect(getAt(parseRaw(serialize(r.doc)), ["version"])).toBe(26);
	});

	it("reads files of older versions through the chain", () => {
		for (const version of [22, 23, 24]) {
			const raw = v25Raw();
			setAt(raw, ["version"], version);
			const r = parsed(JSON.stringify(raw));
			expect(r.migratedFrom, String(version)).toBe(version);
			expect(r.doc.version).toBe(CURRENT_VERSION);
		}
	});

	it("opens a file of a newer format read-only", () => {
		const raw = parseRaw(serialize(pdfDoc().doc));
		setAt(raw, ["version"], CURRENT_VERSION + 1);
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("stages a large v26 file that uses a view and a large v25 file, and writes them back", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } };
		doc.pages[0]!.background = { kind: "pdf", asset: ASSET, page: 1, rotate: 270, crop: { x: 5, y: 6, width: 200, height: 300 } };
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
		const old = text.replace(`"version": ${CURRENT_VERSION}`, '"version": 25');
		const stagedOld = parseStaged(old, 0);
		expect(stagedOld).toBeInstanceOf(StagedParse);
		const r25 = (stagedOld as StagedParse).finish();
		expect(r25.ok).toBe(true);
		if (r25.ok) {
			expect(r25.migratedFrom).toBe(25);
			expect(r25.dropped).toBeUndefined();
			expect(r25.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
			expect(serialize(r25.doc)).not.toContain('"rotate"');
		}
	});
});

describe("SetPdfView: one undo step for the page and everything on it", () => {
	function setup(extra: Partial<Page> = {}) {
		const { doc, page } = pdfDoc(extra);
		const history = new History(() => doc);
		return { doc, page, history };
	}

	function change(page: Page, next: Parameters<typeof planPageView>[2], kind: "rotate" | "crop" = "rotate"): SetPdfView {
		const plan = planPageView(page, SOURCE, next)!;
		expect(plan.above).toBe(0);
		return new SetPdfView(page.id, plan, kind);
	}

	it("turns the background, the size, the ink and the elements; undo puts back the very same objects", () => {
		const { doc, page, history } = setup();
		const stroke = page.strokes[0]!;
		const [text, image, area] = page.elements!;
		expect(history.execute(change(page, { rotate: 90 }))).toBe(true);
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, rotate: 90 });
		expect(page.width).toBe(800);
		expect(page.height).toBe(600);
		// The stroke is carried: (100, 200) -> (800 - 200, 100).
		expect(page.strokes[0]!.id).toBe("s1");
		expect(page.strokes[0]!.points.map(([x, y]) => [x, y])).toEqual([[600, 100], [540, 150.25], [500, 180]]);
		expect(page.strokes[0]!.points.map((p) => p[2])).toEqual([0.5, 0.5, 0.7]);
		expect(page.strokes[0]!.width).toBe(2);
		// The area turns with the PDF (its sides swap); the picture turns; the text box keeps its size and orientation, its centre goes where it would go.
		const a = page.elements!.find((e) => e.id === "a1") as AreaElement;
		expect([a.x, a.y, a.width, a.height]).toEqual([680, 200, 20, 120]);
		const im = page.elements!.find((e) => e.id === "i1") as ImageElement;
		expect(im.rotation).toBeCloseTo(0.25 + Math.PI / 2, 6);
		const t = page.elements!.find((e) => e.id === "t1") as TextElement;
		expect(t.width).toBe(100);
		expect(t.fontSize).toBe(12);
		expect(serializeChecked(doc, true).ok).toBe(true);

		history.undo();
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		expect([page.width, page.height]).toEqual([600, 800]);
		expect(page.strokes[0]).toBe(stroke);
		expect(page.elements![0]).toBe(text);
		expect(page.elements![1]).toBe(image);
		expect(page.elements![2]).toBe(area);
		history.redo();
		expect(page.strokes[0]!.points[0]).toEqual([600, 100, 0.5]);
		expect(page.width).toBe(800);
	});

	it("four quarter turns bring every item back exactly", () => {
		const { page, history } = setup();
		// The ink and the area (which turn exactly) come back to the point; the text box and the picture are placed by their centres, to a hundredth.
		const before = JSON.stringify([page.strokes, page.elements!.find((e) => e.id === "a1"), page.width, page.height]);
		for (let i = 0; i < 4; i++) expect(history.execute(change(page, rotateView(viewOf(page.background), 1)))).toBe(true);
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		expect(JSON.stringify([page.strokes, page.elements!.find((e) => e.id === "a1"), page.width, page.height])).toBe(before);
		const t = page.elements!.find((e) => e.id === "t1") as TextElement;
		expect(t.x).toBeCloseTo(300, 1);
		expect(t.y).toBeCloseTo(400, 1);
	});

	it("crops: the ink keeps its place on the PDF content and the page shrinks", () => {
		const { doc, page, history } = setup();
		const crop = { x: 40, y: 50, width: 500, height: 600 };
		expect(history.execute(change(page, { crop }, "crop"))).toBe(true);
		expect([page.width, page.height]).toEqual([500, 600]);
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, crop });
		expect(page.strokes[0]!.points[0]).toEqual([60, 150, 0.5]);
		const text = page.elements!.find((e) => e.id === "t1") as TextElement;
		expect([text.x, text.y]).toEqual([260, 350]);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("moves hidden ink, locked elements and grouped items with the page, and never touches page times", () => {
		const { doc, page, history } = setup({ startAt: 1_700_000_000_000, endAt: 1_700_000_900_000 });
		const hidden = freezeStroke({ ...createStroke("#223344", 2, [[300, 300, 0.5], [320, 330, 0.5]]), id: "h1", hidden: true, group: "g1" });
		page.strokes.push(hidden);
		page.strokes[0] = freezeStroke({ ...page.strokes[0]!, group: "g1" });
		const locked = Object.freeze({ ...(page.elements![2] as AreaElement), locked: true as const, lockAt: 5 });
		page.elements![2] = locked;
		history.execute(change(page, { rotate: 180 }));
		const h = page.strokes.find((s) => s.id === "h1")!;
		expect(h.hidden).toBe(true);
		expect(h.group).toBe("g1");
		expect(h.points[0]).toEqual([300, 500, 0.5]);
		const a = page.elements!.find((e) => e.id === "a1") as AreaElement;
		expect(a.locked).toBe(true);
		expect(a.lockAt).toBe(5);
		expect([a.x, a.y]).toEqual([280, 680]);
		expect([page.startAt, page.endAt]).toEqual([1_700_000_000_000, 1_700_000_900_000]);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("carries the comments (kept inside the page) and the states (pivots and shifts turn)", () => {
		const { page, history } = setup();
		const comments: PageComment[] = [{ id: "c1", region: { x: 10, y: 20, width: 50, height: 30 }, text: "look", author: "me", created: 1 }];
		const states: PageStates = {
			parts: [{ id: "pa", pivot: [100, 200], items: ["s1"] }],
			list: [{ id: "st1", name: "Pushed", poses: [{ part: "pa", dx: 30, dy: 10, rot: 15 }] }],
		};
		page.comments = comments;
		page.states = states;
		history.execute(change(page, { rotate: 90 }));
		expect(page.comments[0]).toMatchObject({ id: "c1", region: { x: 750, y: 10, width: 30, height: 50 } });
		expect(page.states.parts[0]!.pivot).toEqual([600, 100]);
		expect(page.states.list[0]!.poses[0]).toEqual({ part: "pa", dx: -10, dy: 30, rot: 15 });
		history.undo();
		expect(page.comments).toBe(comments);
		expect(page.states).toBe(states);
	});

	it("keeps a region of a comment on the page when a crop leaves it outside", () => {
		const { page, history } = setup();
		page.strokes.length = 0;
		page.elements = [];
		page.comments = [{ id: "c1", region: { x: 10, y: 20, width: 50, height: 30 }, text: "look", author: "me", created: 1 }];
		history.execute(change(page, { crop: { x: 300, y: 300, width: 200, height: 200 } }, "crop"));
		const region = (page.comments[0] as { region: { x: number; y: number; width: number; height: number } }).region;
		expect(region.x).toBeGreaterThanOrEqual(0);
		expect(region.y).toBeGreaterThanOrEqual(0);
		expect(region.x + region.width).toBeLessThanOrEqual(200);
		expect(region.y + region.height).toBeLessThanOrEqual(200);
	});

	it("keeps ink in the side margins on the page and lets the margins grow", () => {
		const { page, history } = setup({ width: 720, height: 830, margins: { left: 20, right: 100, bottom: 30 } });
		// Ink that was written in the right margin.
		page.strokes.push(freezeStroke({ ...createStroke("#445566", 2, [[660, 100, 0.5], [690, 130, 0.5]]), id: "m1" }));
		const plan = planPageView(page, SOURCE, { rotate: 90 }, undefined)!;
		expect(plan.above).toBe(0);
		expect(history.execute(new SetPdfView(page.id, plan))).toBe(true);
		for (const s of page.strokes) {
			for (const [x, y] of s.points) {
				expect(x).toBeGreaterThanOrEqual(0);
				expect(y).toBeGreaterThanOrEqual(0);
				expect(x).toBeLessThanOrEqual(page.width);
				expect(y).toBeLessThanOrEqual(page.height);
			}
		}
		history.undo();
		expect(page.margins).toEqual({ left: 20, right: 100, bottom: 30 });
		expect(page.width).toBe(720);
	});

	it("a locked page refuses the change and stays as it was", () => {
		const { page, history } = setup({ locked: true });
		const stroke = page.strokes[0]!;
		expect(history.execute(change(page, { rotate: 90 }))).toBe(false);
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		expect(page.strokes[0]).toBe(stroke);
		expect([page.width, page.height]).toEqual([600, 800]);
	});

	it("is named in the history panel, in English and Italian", () => {
		const { page } = setup();
		const rotate = change(page, { rotate: 90 });
		const crop = change(page, { crop: { x: 0, y: 0, width: 300, height: 300 } }, "crop");
		expect(describeCommand(rotate).key).toBe("histpanel.t.pdfRotate");
		expect(describeCommand(crop).key).toBe("histpanel.t.pdfCrop");
		expect(describeCommand(new Batch("Rotate or crop PDF page", [rotate])).key).toBe("histpanel.t.pdfRotate");
		for (const key of ["histpanel.t.pdfRotate", "histpanel.t.pdfCrop", "pdfView.rotateRight", "pdfView.rotateLeft", "pdfView.crop", "pdfView.title", "pdfView.blocked", "pdfView.grown", "help.pdfRotateRight", "help.pdfRotateLeft", "help.pdfCrop"] as const) {
			expect(en[key], key).toBeTruthy();
			expect(it_[key], key).toBeTruthy();
		}
	});

	it("remaps its held elements after a quiet change", () => {
		const { page, history } = setup();
		const cmd = change(page, { rotate: 90 });
		history.execute(cmd);
		const moved = page.elements!.find((e) => e.id === "a1")!;
		const swapped = Object.freeze({ ...moved, color: "#00FF00" }) as AreaElement;
		cmd.remap((el) => (el === moved ? swapped : el));
		page.elements![page.elements!.indexOf(moved)] = swapped;
		history.undo();
		expect(page.elements!.find((e) => e.id === "a1")).toMatchObject({ x: 200, y: 100, color: "#FACC15" });
	});
});

describe("buildViewCommands: this page or every page of the PDF", () => {
	function twoPages() {
		const { doc, page } = pdfDoc();
		const second = { ...structuredClone(page), id: "p2", background: { kind: "pdf" as const, asset: ASSET, page: 2 }, strokes: [], elements: [] } as Page;
		const plain: Page = { ...structuredClone(page), id: "p3", background: undefined, strokes: [], elements: [] };
		delete plain.background;
		doc.pages.push(second, plain);
		return { doc, page, second, plain };
	}

	it("finds the pages that show a page of the same PDF", () => {
		const { doc, page, second, plain } = twoPages();
		expect(pagesOfSamePdf(doc.pages, page).map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(pagesOfSamePdf(doc.pages, plain)).toEqual([plain]);
		expect(second.background?.kind).toBe("pdf");
	});

	it("builds one command per changed page; a page that does not change is left alone", () => {
		const { doc, page, second } = twoPages();
		const targets = [page, second].map((p) => ({ page: p, source: SOURCE }));
		const build = buildViewCommands(targets, { turns: 1 });
		expect(build.commands).toHaveLength(2);
		expect(build.blocked).toBe(0);
		const history = new History(() => doc);
		expect(history.execute(new Batch("Rotate or crop PDF page", build.commands))).toBe(true);
		expect(doc.pages.slice(0, 2).map((p) => p.background)).toEqual([
			{ kind: "pdf", asset: ASSET, page: 1, rotate: 90 }, { kind: "pdf", asset: ASSET, page: 2, rotate: 90 },
		]);
		history.undo();
		expect(doc.pages.slice(0, 2).map((p) => p.width)).toEqual([600, 600]);
		expect(buildViewCommands(targets, { turns: 4 }).unchanged).toBe(2);
		expect(buildViewCommands([{ page: doc.pages[2]!, source: SOURCE }], { turns: 1 }).commands).toHaveLength(0);
	});

	it("a crop is the same for every page and a turn alone keeps each page's crop", () => {
		expect(editedView({ rotate: 90, crop: { x: 1, y: 2, width: 100, height: 100 } }, { turns: 1 })).toEqual({ rotate: 180, crop: { x: 1, y: 2, width: 100, height: 100 } });
		expect(editedView({ rotate: 90, crop: { x: 1, y: 2, width: 100, height: 100 } }, { turns: 0, crop: null })).toEqual({ rotate: 90 });
		expect(editedView(undefined, { turns: 0, crop: { x: 10, y: 20, width: 100, height: 100 } })).toEqual({ crop: { x: 10, y: 20, width: 100, height: 100 } });
	});

	it("counts the pages it cannot change because ink would end up above them", () => {
		const { page } = pdfDoc({ width: 720, height: 800, margins: { left: 0, right: 120, bottom: 0 } });
		page.strokes.push(freezeStroke({ ...createStroke("#000000", 2, [[660, 100, 0.5], [700, 140, 0.5]]), id: "m1" }));
		const build = buildViewCommands([{ page, source: SOURCE }], { turns: -1 });
		expect(build.blocked).toBe(1);
		expect(build.commands).toHaveLength(0);
		expect(pageContentBoxes(page)).toHaveLength(page.strokes.length + (page.elements?.length ?? 0));
	});
});

describe("text, links and hit-testing through the view", () => {
	const content: PageTextContent = { width: 600, height: 800, items: [{ str: "Hello", x: 100, y: 50, width: 60, height: 12 }, { str: "Gone", x: 10, y: 700, width: 40, height: 12 }] };

	it("places the runs on a turned page", () => {
		const rect = { x: 0, y: 0, width: 800, height: 600 };
		const boxes = boxesOnPage(content, rect, { rotate: 90 });
		expect(boxes[0]).toMatchObject({ str: "Hello", x: 738, y: 100, width: 12, height: 60 });
		expect(boxesOnPage(content, { x: 0, y: 0, width: 600, height: 800 })).toEqual(boxesOnPage(content, { x: 0, y: 0, width: 600, height: 800 }, undefined));
	});

	it("drops the runs a crop leaves out and moves the others", () => {
		const view = { crop: { x: 50, y: 0, width: 300, height: 400 } };
		const boxes = boxesOnPage(content, { x: 0, y: 0, width: 300, height: 400 }, view);
		expect(boxes.map((b) => b.str)).toEqual(["Hello"]);
		expect(boxes[0]).toMatchObject({ x: 50, y: 50, width: 60, height: 12 });
	});

	it("maps a point of the page back to the PDF and a PDF rectangle to the page, for every turn and a crop", () => {
		const views = [undefined, { rotate: 90 as const }, { rotate: 180 as const }, { rotate: 270 as const }, { crop: { x: 100, y: 100, width: 300, height: 200 }, rotate: 90 as const }];
		for (const view of views) {
			const size = viewSize(view, SOURCE);
			// The page is drawn at twice the PDF's scale, with a left margin of 30.
			const rect = { x: 30, y: 0, width: size.width * 2, height: size.height * 2 };
			const r = pdfRectToPage({ x: 150, y: 120, width: 40, height: 10 }, rect, SOURCE, view);
			const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			const back = pageToPdf(centre, rect, SOURCE, view);
			expect(back.x).toBeCloseTo(170, 6);
			expect(back.y).toBeCloseTo(125, 6);
			expect(sourceToPage(view, SOURCE, rect)).toHaveLength(6);
		}
	});
});

describe("the crop dialog's geometry", () => {
	it("drags an edge, a corner and the whole frame inside the page, with a smallest size", () => {
		const bounds = { width: 600, height: 800 };
		const start = { x: 100, y: 100, width: 200, height: 300 };
		expect(dragFrame(start, "e", 50, 0, bounds)).toEqual({ x: 100, y: 100, width: 250, height: 300 });
		expect(dragFrame(start, "w", -500, 0, bounds)).toEqual({ x: 0, y: 100, width: 300, height: 300 });
		expect(dragFrame(start, "nw", 20, 30, bounds)).toEqual({ x: 120, y: 130, width: 180, height: 270 });
		expect(dragFrame(start, "se", 1000, 1000, bounds)).toEqual({ x: 100, y: 100, width: 500, height: 700 });
		// Never thinner than the smallest crop.
		expect(dragFrame(start, "e", -1000, 0, bounds)).toEqual({ x: 100, y: 100, width: 16, height: 300 });
		expect(dragFrame(start, "move", 1000, -1000, bounds)).toEqual({ x: 400, y: 0, width: 200, height: 300 });
	});

	it("turns a frame on the shown page into a crop of the PDF page and back", () => {
		for (const rotate of [0, 90, 180, 270] as const) {
			const crop = { x: 100, y: 50, width: 300, height: 200 };
			const frame = cropToFrame(crop, rotate, SOURCE);
			expect(frameToCrop(frame, rotate, SOURCE)).toEqual(crop);
		}
		expect(frameToCrop(wholeFrame(viewSize({ rotate: 90 }, SOURCE)), 90, SOURCE)).toBeNull();
		expect(cropToFrame(undefined, 270, SOURCE)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
	});
});

describe("PdfStore renders a view", () => {
	interface Call { params: { scale: number; rotation?: number; offsetX?: number; offsetY?: number } }

	function env(pageRotate = 0) {
		const calls: Call[] = [];
		const canvases: Array<{ w: number; h: number }> = [];
		const lib: PdfLib = {
			getDocument: () => ({
				promise: Promise.resolve({
					numPages: 1,
					getPage: async () => {
						const turned = (rot: number | undefined) => ((rot ?? pageRotate) / 90) % 2 === 1;
						const page: PdfPage = {
							rotate: pageRotate,
							getViewport: (params) => {
								if (params.rotation !== undefined) calls.push({ params });
								const swap = turned(params.rotation);
								return { width: (swap ? 800 : 600) * params.scale, height: (swap ? 600 : 800) * params.scale };
							},
							render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
						};
						return page;
					},
					destroy: async () => undefined,
				}),
			}),
		};
		const store = new PdfStore({
			loadPdfJs: async () => lib,
			readAsset: async () => new ArrayBuffer(1),
			createCanvas: (w, h) => {
				canvases.push({ w, h });
				return { width: w, height: h, getContext: () => ({}) } as unknown as HTMLCanvasElement;
			},
		});
		return { store, calls, canvases };
	}

	it("keeps the whole page as before and caches a view apart from it", async () => {
		const { store, canvases } = env();
		const whole = await store.render("a", 1, 1);
		const turned = await store.render("a", 1, 1, { rotate: 90 });
		expect(whole.width).toBe(600);
		expect(turned.width).toBe(800);
		expect(turned.height).toBe(600);
		expect(canvases).toHaveLength(2);
		expect(await store.render("a", 1, 1, { rotate: 90 })).toBe(turned);
		expect(await store.render("a", 1, 1, {})).toBe(whole);
		expect(store.peek("a", 1, 1)?.canvas).toBe(whole);
		expect(store.peek("a", 1, 1, { rotate: 90 })?.canvas).toBe(turned);
		expect(store.peek("a", 1, 1, { rotate: 180 })).toBeNull();
	});

	it("asks pdf.js for the whole rotation (the page's own and ours) and shifts the viewport to the crop", async () => {
		const { store, calls, canvases } = env(90);
		const crop = { x: 100, y: 50, width: 300, height: 200 };
		const c = await store.render("a", 1, 2, { rotate: 180, crop });
		expect(c.width).toBe(600);
		expect(c.height).toBe(400);
		expect(canvases[canvases.length - 1]).toEqual({ w: 600, h: 400 });
		// The page's own rotation is 90 and the view adds 180: pdf.js takes 270.
		const view = calls.find((x) => x.params.rotation !== undefined)!;
		expect(view.params.rotation).toBe(270);
		expect(view.params.scale).toBe(2);
		expect(Number.isFinite(view.params.offsetX)).toBe(true);
		expect(Number.isFinite(view.params.offsetY)).toBe(true);
	});

	it("does not mistake a superseded render for a failure", () => {
		expect(isAbortError(new Error("x"))).toBe(false);
	});
});

describe("the same page in every export", () => {
	function turnedPage(): { doc: NotebookDocument; page: Page } {
		const { doc, page } = pdfDoc();
		const history = new History(() => doc);
		history.execute(new SetPdfView(page.id, planPageView(page, SOURCE, { rotate: 90 })!));
		return { doc, page };
	}

	it("the SVG is the size of the turned page, with the picture in the background box", () => {
		const { page } = turnedPage();
		const box = backgroundRect(page);
		expect(box).toEqual({ x: 0, y: 0, width: 800, height: 600 });
		const svg = pageToSvg(page, { images: () => [{ href: "data:image/jpeg;base64,AAAA", ...box, layer: "background" }] } as never);
		expect(svg).toContain('viewBox="0 0 800 600"');
		expect(svg).toContain('<image href="data:image/jpeg;base64,AAAA" x="0" y="0" width="800" height="600"');
	});

	it("the PDF export has the turned page size and its ink at the carried place", () => {
		const { page } = turnedPage();
		const pdf = pagesToPdf([page]);
		const text = new TextDecoder("latin1").decode(pdf);
		expect(text).toContain("/MediaBox [0 0 800 600]");
	});
});

describe("hit-test helpers stay consistent with the model", () => {
	it("viewToSource inverts sourceToView", () => {
		for (const view of [{ rotate: 90 as const }, { rotate: 270 as const, crop: { x: 20, y: 30, width: 200, height: 300 } }]) {
			const there = apply(sourceToView(view, SOURCE), 77, 99);
			const back = apply(viewToSource(view, SOURCE), there[0], there[1]);
			expect(back[0]).toBeCloseTo(77, 9);
			expect(back[1]).toBeCloseTo(99, 9);
		}
	});

	it("keeps the page parse-able after a change of view (round trip through the file)", () => {
		const { doc, page } = pdfDoc();
		new History(() => doc).execute(new SetPdfView(page.id, planPageView(page, SOURCE, { rotate: 270, crop: { x: 50, y: 60, width: 400, height: 500 } })!));
		const text = serialize(doc);
		const r = parsed(text);
		expect(r.dropped).toBeUndefined();
		expect(serialize(r.doc)).toBe(text);
		expect(r.doc.pages[0]!.background).toEqual({ kind: "pdf", asset: ASSET, page: 1, rotate: 270, crop: { x: 50, y: 60, width: 400, height: 500 } });
		// 500 × 400 for the shown part, plus the margins that grew to keep the ink and the picture that lay outside the crop.
		expect(r.doc.pages[0]!.width).toBeGreaterThanOrEqual(500);
		expect(r.doc.pages[0]!.height).toBeGreaterThanOrEqual(400);
		expect(r.doc.pages[0]!.margins).toBeDefined();
	});
});
