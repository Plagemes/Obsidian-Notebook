/**
 * A second fake PDF for the harness (`doc=pdftext`, 0.16 roadmap #45 and #46): six pages of text with an outline, named
 * destinations, internal links, a web link and a link to a page the notebook does not show. It answers only for its own file
 * (the first byte of the file is a marker), so the other harness notebooks, which share the fake of fake-pdf.ts, are
 * unchanged. Counts what pdf.js was asked in `window.__pdftextCalls`, to check that an outline is read once.
 */
import { createDocument, createPage } from "../../src/model/document";
import { createPdfPages } from "../../src/model/pages";
import { serialize } from "../../src/model/serialize";
import { FAKE_FONT, FAKE_PAGE } from "./fake-pdf";

export const PDFTEXT_ASSET = "7e57de57ab1e0000000000a1";
export const PDFTEXT_PATH = `Notebooks/_assets/${PDFTEXT_ASSET}.pdf`;
export const PDFTEXT_NAME = "Limits.pdf";
/** First byte of the file: how the fake library recognises it. */
export const PDFTEXT_MARK = 0xab;
export const PDFTEXT_PAGES = 6;

/** Text lines of each page: [text, x, baseline y] in PDF points (y down from the top). */
export const PDFTEXT_LINES: ReadonlyArray<ReadonlyArray<readonly [string, number, number]>> = [
	[
		["Chapter 1: Limits", 72, 100],
		["A limit describes the value a function approaches.", 72, 140],
		["See the summary on page 5 or read more online.", 72, 180],
		["The full table is in the Index at the end.", 72, 220],
	],
	[["1.1 Sequences", 72, 100], ["A sequence is an ordered list of numbers.", 72, 140]],
	[["1.2 Series", 72, 100], ["The convergence of a series is a deli-", 72, 140], ["cate matter that needs care.", 72, 160]],
	[["Chapter 2: Derivatives", 72, 100], ["The derivative measures a rate of change.", 72, 140]],
	[["Summary", 72, 100], ["Limits come first, derivatives follow from them.", 72, 140]],
	[["Index", 72, 100], ["limit, 1  series, 3  derivative, 4", 72, 140]],
];

/** The link texts of page 1 and where each goes: a page of the PDF, or a web address. */
export const PDFTEXT_LINKS: ReadonlyArray<{ text: string; line: number; page?: number; url?: string }> = [
	{ text: "page 5", line: 2, page: 5 },
	{ text: "read more online", line: 2, url: "https://example.org/limits" },
	{ text: "Index", line: 3, page: 6 },
];

/** Outline of the PDF: references are `{ num }` objects, the destination named `series` is a name. */
const OUTLINE = [
	{
		title: "Chapter 1: Limits", dest: [{ num: 1, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [
			{ title: "1.1 Sequences", dest: [{ num: 2, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [] },
			{ title: "1.2 Series", dest: "series", items: [] },
		],
	},
	{ title: "Chapter 2: Derivatives", dest: [{ num: 4, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [] },
	{ title: "Summary", dest: [{ num: 5, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [] },
	{ title: "Index", dest: [{ num: 6, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [] },
];

type Matrix = number[];

export interface PdftextCalls {
	outline: number;
	annotations: number;
}

function calls(): PdftextCalls {
	const w = window as unknown as { __pdftextCalls?: PdftextCalls };
	return (w.__pdftextCalls ??= { outline: 0, annotations: 0 });
}

function measure(text: string): number {
	const c = createEl("canvas").getContext("2d")!;
	c.font = `${FAKE_FONT}px sans-serif`;
	return c.measureText(text).width;
}

/** Link annotations of page 1, boxes in PDF user space (y up). */
function annotations(n: number): unknown[] {
	if (n !== 1) return [];
	return PDFTEXT_LINKS.map((l) => {
		const [line, x, y] = PDFTEXT_LINES[0]![l.line]!;
		const x0 = x + measure(line.slice(0, line.indexOf(l.text)));
		const x1 = x0 + measure(l.text);
		const rect = [x0, FAKE_PAGE.height - (y + 4), x1, FAKE_PAGE.height - (y - FAKE_FONT + 2)];
		return l.page !== undefined
			? { subtype: "Link", rect, dest: [{ num: l.page, gen: 0 }, { name: "XYZ" }, 0, 0, null] }
			: { subtype: "Link", rect, url: l.url, unsafeUrl: l.url };
	}).concat([{ subtype: "Text", rect: [0, 0, 10, 10] }] as never[]);
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
			ctx.fillStyle = "#f4efe4";
			ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			ctx.fillStyle = "#111827";
			ctx.font = `${FAKE_FONT * scale}px sans-serif`;
			ctx.textBaseline = "alphabetic";
			for (const [text, x, y] of PDFTEXT_LINES[n - 1] ?? []) ctx.fillText(text, x * scale, y * scale);
			// The links are underlined, as in a real document.
			if (n === 1) {
				ctx.strokeStyle = "#1d4ed8";
				ctx.lineWidth = Math.max(1, scale);
				for (const l of PDFTEXT_LINKS) {
					const [line, x, y] = PDFTEXT_LINES[0]![l.line]!;
					const x0 = x + measure(line.slice(0, line.indexOf(l.text)));
					ctx.beginPath();
					ctx.moveTo(x0 * scale, (y + 2) * scale);
					ctx.lineTo((x0 + measure(l.text)) * scale, (y + 2) * scale);
					ctx.stroke();
				}
			}
			return { promise: Promise.resolve(), cancel: () => undefined };
		},
		getTextContent: async () => ({
			styles: { f1: { fontFamily: "sans-serif" } },
			items: (PDFTEXT_LINES[n - 1] ?? []).map(([str, x, y]) => ({
				str,
				transform: [FAKE_FONT, 0, 0, FAKE_FONT, x, FAKE_PAGE.height - y],
				width: measure(str),
				height: FAKE_FONT,
				fontName: "f1",
			})),
		}),
		getAnnotations: async () => {
			calls().annotations++;
			return annotations(n);
		},
	};
}

const fakeDoc = () => ({
	numPages: PDFTEXT_PAGES,
	getPage: async (n: number) => fakePage(n),
	destroy: async () => undefined,
	getOutline: async () => {
		calls().outline++;
		return OUTLINE;
	},
	getDestination: async (id: string) => (id === "series" ? [{ num: 3, gen: 0 }, { name: "XYZ" }, 0, 0, null] : null),
	getPageIndex: async (ref: { num: number }) => ref.num - 1,
});

/** Makes the fake library answer for the pdftext file (the first byte is the marker) and leave the others to what it did. */
export function installPdftextFake(): void {
	const w = window as unknown as { __harnessPdfJs?: { getDocument: (p: { data: Uint8Array | ArrayBuffer }) => { promise: Promise<unknown> } } };
	const lib = w.__harnessPdfJs;
	if (!lib) return;
	const base = lib.getDocument.bind(lib);
	lib.getDocument = (params) => {
		const first = (params.data instanceof Uint8Array ? params.data : new Uint8Array(params.data))[0];
		return first === PDFTEXT_MARK ? { promise: Promise.resolve(fakeDoc()) } : base(params);
	};
}

/**
 * A notebook that shows the pages of the fake PDF as a reader would have arranged them: pages 1 to 3, a notes page, then
 * page 5 before page 4, and page 6 left out.
 */
export function pdftextNotebook(): string {
	const doc = createDocument();
	doc.assets = { [PDFTEXT_ASSET]: { id: PDFTEXT_ASSET, kind: "pdf", path: PDFTEXT_PATH, name: PDFTEXT_NAME, bytes: 8 } };
	const asset = doc.assets[PDFTEXT_ASSET]!;
	const pdf = createPdfPages(asset, Array.from({ length: PDFTEXT_PAGES }, () => ({ ...FAKE_PAGE })));
	const notes = createPage({ width: FAKE_PAGE.width, height: FAKE_PAGE.height }, { kind: "ruled", spacing: 22.68 });
	doc.pages = [pdf[0]!, pdf[1]!, pdf[2]!, notes, pdf[4]!, pdf[3]!];
	return serialize(doc);
}
