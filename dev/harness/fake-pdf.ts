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
	const c = document.createElement("canvas").getContext("2d")!;
	c.font = `${FAKE_FONT}px sans-serif`;
	return c.measureText(text).width;
}

function fakePage(n: number) {
	const viewport = (scale: number) => ({
		width: FAKE_PAGE.width * scale,
		height: FAKE_PAGE.height * scale,
		transform: [scale, 0, 0, -scale, 0, FAKE_PAGE.height * scale] as Matrix,
	});
	return {
		getViewport: ({ scale }: { scale: number }) => viewport(scale),
		render: ({ canvasContext, viewport: vp }: { canvasContext: CanvasRenderingContext2D; viewport: { width: number } }) => {
			const scale = vp.width / FAKE_PAGE.width;
			const ctx = canvasContext;
			ctx.fillStyle = "#e8eef8";
			ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			ctx.fillStyle = "#111827";
			ctx.font = `${FAKE_FONT * scale}px sans-serif`;
			ctx.textBaseline = "alphabetic";
			for (const [text, x, y] of FAKE_LINES[n - 1] ?? []) ctx.fillText(text, x * scale, y * scale);
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
	(globalThis as { __harnessPdfJs?: unknown }).__harnessPdfJs = fakeLib;
}

/** A notebook with one page per fake PDF page, the asset record included. */
export function slidesNotebook(): string {
	const doc = createDocument();
	doc.assets = { [FAKE_ASSET]: { id: FAKE_ASSET, kind: "pdf", path: FAKE_PATH, name: "Slides.pdf", bytes: 8 } };
	doc.pages = createPdfPages(doc.assets[FAKE_ASSET]!, Array.from({ length: FAKE_PAGE_COUNT }, () => ({ ...FAKE_PAGE })));
	return serialize(doc);
}
