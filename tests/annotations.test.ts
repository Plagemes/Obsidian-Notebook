import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { freezeStroke } from "../src/model/serialize";
import type { NotebookDocument, Point, TextElement } from "../src/model/types";
import {
	annotationsMarkdown, collectAnnotations, escapeMarkdown, hasPdfAnnotations, pagesNeedingText, textUnderStroke, uniquePath,
	type AnnotationLabels,
} from "../src/pdf/annotations";
import { PdfStore } from "../src/pdf/pdf-store";
import type { PdfLib } from "../src/pdf/pdfjs-types";
import { boxesOnPage, textBoxes, type TextBox } from "../src/pdf/text-items";
import { notebookUri } from "../src/integration/links";

const ASSET = "abcdef0123456789abcdef01";

/** A line of text as runs of words, 6 pt per character, baseline at `y + 10`, 10 pt tall. */
function line(words: string[], x: number, y: number): TextBox[] {
	const out: TextBox[] = [];
	let cx = x;
	for (const w of words) {
		out.push({ str: w, x: cx, y, width: w.length * 6, height: 10 });
		cx += (w.length + 1) * 6;
	}
	return out;
}

const highlighter = (points: Point[], width = 12) => freezeStroke(createStroke("#facc15", width, points, "highlighter"));

describe("text boxes from pdf.js", () => {
	it("maps item transforms through the viewport (y down)", () => {
		// Page 400 pt tall; text at baseline y = 300 (from the bottom), font size 10, 50 pt wide.
		const boxes = textBoxes([{ str: "Hello", transform: [10, 0, 0, 10, 72, 300], width: 50 }], [1, 0, 0, -1, 0, 400]);
		expect(boxes).toHaveLength(1);
		const b = boxes[0]!;
		expect(b.str).toBe("Hello");
		expect(b.x).toBeCloseTo(72);
		expect(b.width).toBeCloseTo(50);
		expect(b.y).toBeCloseTo(90); // 400 - 300 - 10
		expect(b.height).toBeCloseTo(10);
	});

	it("handles a rotated viewport and skips marked content and bad items", () => {
		const items = [
			{ type: "beginMarkedContent" },
			{ str: "", transform: [10, 0, 0, 10, 0, 0], width: 1 },
			{ str: "x", transform: [10, 0, 0], width: 1 },
			null,
			{ str: "Up", transform: [10, 0, 0, 10, 100, 100], width: 20 },
		];
		// 90° rotation: user (x, y) -> viewport (y, x).
		const boxes = textBoxes(items, [0, 1, 1, 0, 0, 0]);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]!.width).toBeCloseTo(10);
		expect(boxes[0]!.height).toBeCloseTo(20);
	});

	it("places boxes in the background box of a page with margins", () => {
		const content = { width: 600, height: 400, items: [{ str: "a", x: 60, y: 40, width: 6, height: 10 }] };
		expect(boxesOnPage(content, { x: 50, y: 0, width: 300, height: 200 })).toEqual([{ str: "a", x: 80, y: 20, width: 3, height: 5 }]);
	});

	it("PdfStore.pageText reads text content at scale 1", async () => {
		const lib: PdfLib = {
			getDocument: () => ({
				promise: Promise.resolve({
					numPages: 1,
					getPage: async () => ({
						getViewport: ({ scale }) => ({ width: 600 * scale, height: 400 * scale, transform: [scale, 0, 0, -scale, 0, 400 * scale] }),
						render: () => ({ promise: Promise.resolve(), cancel() {} }),
						getTextContent: async () => ({ items: [{ str: "Word", transform: [10, 0, 0, 10, 10, 390], width: 24 }] }),
					}),
					destroy: async () => {},
				}),
			}),
		};
		const store = new PdfStore({ loadPdfJs: async () => lib, readAsset: async () => new ArrayBuffer(1), createCanvas: () => ({}) as HTMLCanvasElement });
		const text = await store.pageText("a", 1);
		expect(text.width).toBe(600);
		expect(text.items).toEqual([{ str: "Word", x: 10, y: 0, width: 24, height: 10 }]);
		await expect(store.pageText("a", 2)).rejects.toThrow(RangeError);
	});
});

describe("textUnderStroke", () => {
	const boxes = [...line(["The", "quick", "brown", "fox"], 100, 100), ...line(["jumps", "over", "it"], 100, 130)];

	it("returns the words under a straight highlight", () => {
		// Over "quick brown" on the first line (x 124..178), centre line at y = 105.
		expect(textUnderStroke(highlighter([[124, 105, 0.5], [189, 105, 0.5]]), boxes)).toBe("quick brown");
	});

	it("selects characters, not whole runs, and nothing on other lines", () => {
		expect(textUnderStroke(highlighter([[124, 105, 0.5], [140, 105, 0.5]], 10), boxes)).toBe("quic");
		expect(textUnderStroke(highlighter([[100, 200, 0.5], [300, 200, 0.5]]), boxes)).toBe("");
	});

	it("follows a stroke across two lines", () => {
		const s = highlighter([[160, 105, 0.5], [214, 105, 0.5], [100, 135, 0.5], [160, 135, 0.5]]);
		expect(textUnderStroke(s, boxes)).toBe("brown fox jumps over");
	});

	it("a dot highlights the characters around it", () => {
		expect(textUnderStroke(highlighter([[103, 105, 0.5]], 4), boxes)).toBe("T");
	});
});

function annotatedDoc(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "Slides (v2).pdf", bytes: 1 } };
	const p1 = doc.pages[0]!; // plain page: highlights here are not PDF annotations
	p1.strokes.push(highlighter([[0, 0, 0.5], [10, 0, 0.5]]));
	const p2 = createPage({ width: 600, height: 400 });
	p2.background = { kind: "pdf", asset: ASSET, page: 4 };
	p2.strokes.push(freezeStroke(createStroke("#000000", 2, [[1, 1, 0.5]])));
	p2.strokes.push(highlighter([[136, 135, 0.5], [177, 135, 0.5]]));
	p2.strokes.push(highlighter([[124, 105, 0.5], [189, 105, 0.5]]));
	const comment: TextElement = { id: "c1", type: "text", x: 400, y: 50, width: 100, text: "Ask about **this**\nin class", fontSize: 12, color: "#000000" };
	const empty: TextElement = { id: "c2", type: "text", x: 0, y: 0, width: 10, text: "  ", fontSize: 12, color: "#000000" };
	p2.elements = [comment, empty];
	const p3 = createPage({ width: 600, height: 400 });
	p3.background = { kind: "pdf", asset: ASSET, page: 5 };
	doc.pages.push(p2, p3);
	return doc;
}

const labels: AnnotationLabels = {
	title: "Annotations: Physics",
	source: "Notebook",
	exported: "Exported",
	pageHeading: (pdf, n, page) => `Page ${page}: ${pdf}, p. ${n}`,
	highlight: "Highlight",
	comment: "Comment",
	noText: "no PDF text",
	openPage: (page) => `Open page ${page}`,
};

describe("collectAnnotations and the Markdown note", () => {
	it("lists highlights and text boxes of PDF pages only, top to bottom", () => {
		const doc = annotatedDoc();
		expect(hasPdfAnnotations(doc)).toBe(true);
		expect(pagesNeedingText(doc)).toEqual([doc.pages[1]]);
		const boxes = [...line(["The", "quick", "brown", "fox"], 100, 100), ...line(["jumps", "over", "it"], 100, 130)];
		const items = collectAnnotations(doc, () => boxes);
		expect(items.map((i) => [i.kind, i.notebookPage, i.pdfPage, i.text])).toEqual([
			["comment", 2, 4, "Ask about **this**\nin class"],
			["highlight", 2, 4, "quick brown"],
			["highlight", 2, 4, "over it"],
		]);
		expect(collectAnnotations(doc, () => null).filter((i) => i.kind === "highlight").every((i) => i.text === "")).toBe(true);
	});

	it("a document without PDF annotations has nothing to export", () => {
		const doc = createDocument();
		expect(hasPdfAnnotations(doc)).toBe(false);
		expect(collectAnnotations(doc, () => [])).toEqual([]);
	});

	it("writes callouts with a link to the notebook page for each item", () => {
		const doc = annotatedDoc();
		const items = collectAnnotations(doc, (p) => (p === doc.pages[1] ? line(["quick", "brown"], 124, 100) : null));
		const md = annotationsMarkdown({
			items,
			notebookLink: "[[Notebooks/Physics.notebook|Physics]]",
			date: "2026-10-29",
			pdfName: (id) => doc.assets![id]!.name,
			pageUrl: (n) => notebookUri("My (vault)", "Notebooks/Physics.notebook", n),
			labels,
		});
		expect(md.startsWith("# Annotations: Physics\n\nNotebook: [[Notebooks/Physics.notebook|Physics]]\nExported: 2026-10-29\n")).toBe(true);
		expect(md).toContain("## Page 2: Slides (v2).pdf, p. 4");
		expect(md).toContain("> [!quote] Highlight\n> quick brown\n>\n> [Open page 2](obsidian://notebook?vault=My%20%28vault%29&path=Notebooks%2FPhysics.notebook&page=2)");
		expect(md).toContain("> [!note] Comment\n> Ask about **this**\n> in class\n");
		expect(md).toContain("> *no PDF text*");
		expect(md.match(/\[Open page 2\]/g)).toHaveLength(3);
		expect(md.endsWith("\n")).toBe(true);
	});

	it("escapes PDF text so it shows literally", () => {
		expect(escapeMarkdown("a*b_c [x](y) <b> #tag | ~~s~~ $x$")).toBe("a\\*b\\_c \\[x\\](y) \\<b\\> \\#tag \\| \\~\\~s\\~\\~ \\$x\\$");
	});

	it("never reuses an existing note name", () => {
		const taken = new Set(["N/Physics annotations.md", "N/Physics annotations 2.md"]);
		expect(uniquePath((p) => taken.has(p), "N", "Physics annotations", "md")).toBe("N/Physics annotations 3.md");
		expect(uniquePath(() => false, "", "a/b:c", "md")).toBe("a b c.md");
		expect(uniquePath(() => false, "/", "", "md")).toBe("Annotations.md");
	});
});
