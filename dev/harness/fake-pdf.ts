/**
 * A fake pdf.js and a notebook of three "slides" for the harness (`doc=pdf`): the reading tools (search, snapping
 * highlighter, hide annotations, dimming) can be driven in a real browser without pdf.js. Each page draws its text lines on
 * a canvas and reports the same runs through `getTextContent()`, with a transform like pdf.js gives, so what the plugin
 * marks can be compared with what is drawn.
 */
import { createDocument } from "../../src/model/document";
import { createPdfPages } from "../../src/model/pages";
import { serialize } from "../../src/model/serialize";

export const FAKE_ASSET = "0123456789abcdef01234567";
export const FAKE_PATH = `Notebooks/_assets/${FAKE_ASSET}.pdf`;
export const FAKE_PAGE = { width: 595.28, height: 841.89 };
export const FAKE_FONT = 14;
export const FAKE_PAGE_COUNT = 3;

/** Text lines of each slide: [text, x, baseline y] in PDF points (y down from the top, as in the viewport). */
export const FAKE_LINES: ReadonlyArray<ReadonlyArray<readonly [string, number, number]>> = [
	[
		["Introduction to the harness", 72, 100],
		["The quick brown fox jumps over the lazy dog.", 72, 140],
		["A second line says nothing about foxes, only quick things.", 72, 160],
		["Third line: dogs and cats.", 72, 180],
	],
	[
		["Second slide", 72, 100],
		["Nothing to see here, move along.", 72, 140],
		["Except that the QUICK reader notices a quick result.", 72, 160],
	],
	[
		["Last slide: caffè and ﬁne print", 72, 100],
		["The end of the quick tour.", 72, 140],
	],
];

type Matrix = number[];

function measure(text: string): number {
	const c = createEl("canvas").getContext("2d")!;
	c.font = `${FAKE_FONT}px sans-serif`;
	return c.measureText(text).width;
}

/** m × n for [a, b, c, d, e, f] (n first). */
function mul(m: Matrix, n: Matrix): Matrix {
	return [
		m[0]! * n[0]! + m[2]! * n[1]!, m[1]! * n[0]! + m[3]! * n[1]!, m[0]! * n[2]! + m[2]! * n[3]!, m[1]! * n[2]! + m[3]! * n[3]!,
		m[0]! * n[4]! + m[2]! * n[5]! + m[4]!, m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
	];
}

function fakePage(n: number) {
	// 0.28 (#76): like pdf.js, a viewport can be turned (`rotation`, clockwise degrees) and shifted (`offsetX`, `offsetY`, device px).
	const viewport = (scale: number, rotation = 0, offsetX = 0, offsetY = 0) => {
		const w = FAKE_PAGE.width * scale, h = FAKE_PAGE.height * scale;
		const r = ((rotation % 360) + 360) % 360;
		const turn: Matrix = r === 90 ? [0, 1, -1, 0, h, 0] : r === 180 ? [-1, 0, 0, -1, w, h] : r === 270 ? [0, -1, 1, 0, 0, w] : [1, 0, 0, 1, 0, 0];
		const view: Matrix = [turn[0]!, turn[1]!, turn[2]!, turn[3]!, turn[4]! + offsetX, turn[5]! + offsetY];
		const swap = r === 90 || r === 270;
		return { width: swap ? h : w, height: swap ? w : h, transform: mul(view, [scale, 0, 0, -scale, 0, h]), view, scale };
	};
	return {
		rotate: 0,
		getViewport: ({ scale, rotation, offsetX, offsetY }: { scale: number; rotation?: number; offsetX?: number; offsetY?: number }) => viewport(scale, rotation, offsetX, offsetY),
		render: ({ canvasContext, viewport: vp }: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; view?: Matrix; scale?: number } }) => {
			const scale = vp.scale ?? vp.width / FAKE_PAGE.width;
			const ctx = canvasContext;
			ctx.fillStyle = "#e8eef8";
			ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			ctx.save();
			// The sheet is drawn in its own pixels, then carried by the viewport's turn and shift onto the (possibly smaller) bitmap.
			if (vp.view) ctx.setTransform(vp.view[0]!, vp.view[1]!, vp.view[2]!, vp.view[3]!, vp.view[4]!, vp.view[5]!);
			ctx.fillStyle = "#e8eef8";
			ctx.fillRect(0, 0, FAKE_PAGE.width * scale, FAKE_PAGE.height * scale);
			if ((window as unknown as { __harnessPdfMark?: boolean }).__harnessPdfMark) {
				// A frame around the sheet and a red mark in its top-left corner, so a turn and a crop can be seen (`doc=pdfrotate` only).
				ctx.strokeStyle = "#1d4ed8";
				ctx.lineWidth = 3 * scale;
				ctx.strokeRect(1.5 * scale, 1.5 * scale, FAKE_PAGE.width * scale - 3 * scale, FAKE_PAGE.height * scale - 3 * scale);
				ctx.fillStyle = "#dc2626";
				ctx.fillRect(0, 0, 40 * scale, 40 * scale);
			}
			ctx.fillStyle = "#111827";
			ctx.font = `${FAKE_FONT * scale}px sans-serif`;
			ctx.textBaseline = "alphabetic";
			for (const [text, x, y] of FAKE_LINES[n - 1] ?? []) ctx.fillText(text, x * scale, y * scale);
			ctx.restore();
			return { promise: Promise.resolve(), cancel: () => undefined };
		},
		getTextContent: async () => ({
			styles: { f1: { fontFamily: "sans-serif" } },
			// Like pdf.js: one run per line (or per styled stretch), baseline origin in the transform, width in user space.
			items: (FAKE_LINES[n - 1] ?? []).map(([str, x, y]) => ({
				str,
				transform: [FAKE_FONT, 0, 0, FAKE_FONT, x, FAKE_PAGE.height - y],
				width: measure(str),
				height: FAKE_FONT,
				fontName: "f1",
			})),
		}),
	};
}

const fakeLib = {
	getDocument: () => ({
		promise: Promise.resolve({
			numPages: FAKE_PAGE_COUNT,
			getPage: async (n: number) => fakePage(n),
			destroy: async () => undefined,
		}),
	}),
};

/** Makes the stub's `loadPdfJs()` return the fake library. */
export function installFakePdf(): void {
	(window as unknown as { __harnessPdfJs?: unknown }).__harnessPdfJs = fakeLib;
}

/** A notebook with one page per fake PDF page, the asset record included. */
export function slidesNotebook(): string {
	const doc = createDocument();
	doc.assets = { [FAKE_ASSET]: { id: FAKE_ASSET, kind: "pdf", path: FAKE_PATH, name: "Slides.pdf", bytes: 8 } };
	doc.pages = createPdfPages(doc.assets[FAKE_ASSET]!, Array.from({ length: FAKE_PAGE_COUNT }, () => ({ ...FAKE_PAGE })));
	return serialize(doc);
}
