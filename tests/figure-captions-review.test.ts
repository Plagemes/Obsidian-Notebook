// 0.29 (#248) review fixes for the figure captions: scoped and exclusive label resolution (F1), markers follow copies (F2), frozen numbers
// across the yields of a long export (F3) and the text measured in the same scope as it is drawn (F4).
import { afterEach, describe, expect, it } from "vitest";
import { createId, createPage } from "../src/model/document";
import { figureLabelSourceOf, numberFigures, numberMapOf, referenceElement, withFigureLabels } from "../src/model/figure-captions";
import {
	addFigureLabelSource, captionText, enterFigureScope, figureLabel, figureNumber, frozenFigureSource, referenceToken, remapFigureMarkers,
	resolveFigureMarkers, withFigureScope, type FigureLabelSource,
} from "../src/ink/figure-text";
import { pagesToPdf, pagesToPdfYielding } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { instantiateClip, type ClipContent } from "../src/ink/clipboard";
import { shownText } from "../src/ink/wikilink";
import { companionContent } from "../src/model/companion-content";
import { buildNotebookMarkdown } from "../src/model/export-markdown";
import { duplicatePage, duplicatePages } from "../src/model/pages";
import { duplicateCommand } from "../src/model/page-ops";
import { notebookFromTemplate } from "../src/model/notebook-template";
import type { ImageElement, NotebookDocument, Page, TextElement } from "../src/model/types";

const image = (id: string, x = 10, y = 10): ImageElement => ({ id, type: "image", asset: `a-${id}`, x, y, width: 100, height: 50, rotation: 0 });
const text = (t: string, x = 10, y = 200, id = createId()): TextElement => ({ id, type: "text", x, y, width: 200, text: t, fontSize: 12, color: "#000" });
const pageWith = (...elements: NonNullable<Page["elements"]>): Page => {
	const p = createPage();
	p.elements = elements;
	return p;
};
const textsOf = (p: Page): string[] => (p.elements ?? []).flatMap((e) => (e.type === "text" ? [e.text] : []));
const sourceOf = (pages: Page[]): FigureLabelSource => ({ abbr: () => "Fig.", number: (id) => numberMapOf(numberFigures(pages)).get(id) ?? null });
const latin = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

const removers: Array<() => void> = [];
afterEach(() => {
	while (removers.length > 0) removers.pop()!();
});

/** Two notebooks that share element ids (B is a copy of A made in the file manager, then edited). */
function twoNotebooks(): { a: Page[]; b: Page[] } {
	const a = [pageWith(image("f0"), text(captionText("f0", "First"), 10, 70), image("f1", 10, 300), text(captionText("f1", "Second"), 10, 360), text(`see ${referenceToken("f1")}`, 10, 500))];
	const b = [pageWith(image("f1"), text(captionText("f1", "Only"), 10, 70), text(`see ${referenceToken("f1")} and ${referenceToken("f0")}`, 10, 500))];
	return { a, b };
}

describe("F1: label resolution is scoped and exclusive", () => {
	it("a scope answers from its own notebook, whatever other views are open", () => {
		const { a, b } = twoNotebooks();
		removers.push(addFigureLabelSource(sourceOf(a)));
		removers.push(addFigureLabelSource(sourceOf(b))); // B registered last: it used to answer for A as well
		expect(withFigureScope(sourceOf(a), () => shownText(referenceToken("f1")).text)).toBe("Fig. 2");
		expect(withFigureScope(sourceOf(b), () => shownText(referenceToken("f1")).text)).toBe("Fig. 1");
	});

	it("an id the scope does not know is Fig. ?, never the number another open view gives it", () => {
		const { a, b } = twoNotebooks();
		removers.push(addFigureLabelSource(sourceOf(a)));
		expect(figureNumber("f0")).toBe(1); // the ambient fallback, outside any scope
		expect(withFigureScope(sourceOf(b), () => figureNumber("f0"))).toBeNull();
		expect(withFigureScope(sourceOf(b), () => figureLabel("f0"))).toBe("Fig. ?");
	});

	it("scopes nest and are left in order, also when the function throws", () => {
		const { a, b } = twoNotebooks();
		const outer = withFigureScope(sourceOf(a), () => [figureNumber("f1"), withFigureScope(sourceOf(b), () => figureNumber("f1")), figureNumber("f1")]);
		expect(outer).toEqual([2, 1, 2]);
		expect(() => withFigureScope(sourceOf(a), () => {
			throw new Error("boom");
		})).toThrow("boom");
		expect(figureNumber("f1")).toBeNull();
	});

	it("the Markdown export of A does not depend on which other notebooks are open", () => {
		const { a, b } = twoNotebooks();
		const input = { title: "T", pages: a, meta: undefined, images: ["a.png"], pageLabel: (n: number) => `Page ${n}` };
		const alone = buildNotebookMarkdown(input);
		removers.push(addFigureLabelSource(sourceOf(b)));
		expect(buildNotebookMarkdown(input)).toBe(alone);
		expect(alone).toContain("see Fig. 2");
	});

	it("a reference to a deleted figure is Fig. ? in the companion note on every device", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "Lake"), 10, 80), text(`gone: ${referenceToken("f9")}`, 10, 300))];
		const doc = { id: "d1", version: 26, pages, assets: {}, meta: { bookmarks: [] } } as unknown as NotebookDocument;
		const ctx = { notebookPath: "Notes/T.notebook", pageUri: (n: number) => `obsidian://x/${n}`, searchText: true };
		const alone = companionContent(doc, ctx).text;
		expect(alone).toContain("gone: Fig. ?");
		// Another notebook is open and knows the id "f9": the note must not change.
		removers.push(addFigureLabelSource({ abbr: () => "Fig.", number: (id) => (id === "f9" ? 4 : null) }));
		expect(companionContent(doc, ctx).text).toBe(alone);
	});

	it("withFigureLabels is exclusive: unknown ids stay Fig. ? with another view open", () => {
		removers.push(addFigureLabelSource({ abbr: () => "Fig.", number: (id) => (id === "f9" ? 4 : null) }));
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		expect(withFigureLabels(pages, () => resolveFigureMarkers(`${referenceToken("f1")} ${referenceToken("f9")}`))).toBe("Fig. 1 Fig. ?");
	});

	it("SVG and PDF writers resolve through the figures they are given", () => {
		const { a, b } = twoNotebooks();
		removers.push(addFigureLabelSource(sourceOf(a)));
		removers.push(addFigureLabelSource(sourceOf(b)));
		// A numbers f0 as Fig. 1 and f1 as Fig. 2: the caption of f1 and the reference to it both say Fig. 2 (with B's numbers the reference said Fig. 1).
		const count = (s: string, what: string): number => s.split(what).length - 1;
		const svg = pageToSvg(a[0]!, { figures: sourceOf(a) });
		expect(count(svg, "Fig. 2")).toBe(2);
		expect(count(svg, "Fig. 1")).toBe(1);
		const pdf = latin(pagesToPdf(a, { figures: sourceOf(a) }));
		expect(count(pdf, "(Fig. 2")).toBe(2);
		expect(count(pdf, "(Fig. 1")).toBe(1);
	});
});

describe("F3 / F4: frozen numbers, kept across yields", () => {
	it("a frozen source ignores later edits and keeps the word it had", () => {
		const live = new Map([["f1", 1]]);
		const frozen = frozenFigureSource(live, "Abb.");
		live.set("f1", 5);
		live.set("f2", 2);
		expect(withFigureScope(frozen, () => figureLabel("f1"))).toBe("Abb. 1");
		expect(withFigureScope(frozen, () => figureLabel("f2"))).toBe("Abb. ?");
	});

	it("a long PDF export resolves every page against the numbers of its start and holds no scope while it yields", async () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x"), 10, 70)), pageWith(text(`see ${referenceToken("f1")}`, 10, 10))];
		const figures = figureLabelSourceOf(pages);
		const seen: Array<number | null> = [];
		const bytes = await pagesToPdfYielding(pages, { figures }, () => {
			seen.push(figureNumber("f1")); // while yielding, no scope is in force: other code is not affected
			pages[0]!.elements = []; // the notebook is edited (the caption and the picture are gone) during the export
			return Promise.resolve();
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((n) => n === null)).toBe(true);
		expect(latin(bytes)).toContain("(Fig. 1) Tj"); // the reference on page 2 still says Fig. 1 although the figure was removed meanwhile
	});

	it("enterFigureScope leaves exactly its own frame", () => {
		const leaveA = enterFigureScope(frozenFigureSource(new Map([["x", 1]]), "Fig."));
		const leaveB = enterFigureScope(frozenFigureSource(new Map([["x", 2]]), "Fig."));
		expect(figureNumber("x")).toBe(2);
		leaveA(); // out of order: B stays on top
		expect(figureNumber("x")).toBe(2);
		leaveB();
		expect(figureNumber("x")).toBeNull();
	});
});

describe("F2: markers follow the copies", () => {
	const captioned = (): Page => pageWith(image("p1"), text(captionText("p1", "Lake"), 10, 70, "c1"), text(`see ${referenceToken("p1")}`, 10, 300, "r1"));

	it("remapFigureMarkers renames only the ids it is given", () => {
		const ids = new Map([["a", "A"]]);
		expect(remapFigureMarkers("{{figcap:a}} x {{figref:a}} {{figref:b}}", ids)).toBe("{{figcap:A}} x {{figref:A}} {{figref:b}}");
		expect(remapFigureMarkers("[[note {{figref:a}}]] {{figref:a}}", ids)).toBe("[[note {{figref:a}}]] {{figref:A}}");
		expect(remapFigureMarkers("plain", ids)).toBe("plain");
		expect(remapFigureMarkers("{{figref:a}}", new Map())).toBe("{{figref:a}}");
	});

	it("duplicating a page: the caption and the references name the copied picture", () => {
		const page = captioned();
		const copy = duplicatePage(page);
		const picture = copy.elements!.find((e) => e.type === "image")!;
		expect(picture.id).not.toBe("p1");
		expect(textsOf(copy)).toEqual([`{{figcap:${picture.id}}} Lake`, `see {{figref:${picture.id}}}`]);
		// the original is untouched and the numbering counts each picture once
		expect(textsOf(page)).toEqual(["{{figcap:p1}} Lake", "see {{figref:p1}}"]);
		const numbered = numberFigures([page, copy]);
		expect(numbered.map((n) => n.figure.elementId)).toEqual(["p1", picture.id]);
		expect(numbered.map((n) => n.captions.length)).toEqual([1, 1]);
	});

	it("a reference to a picture that is not copied keeps pointing at the original", () => {
		const page = pageWith(text(`see ${referenceToken("elsewhere")}`, 10, 10));
		expect(textsOf(duplicatePage(page))).toEqual(["see {{figref:elsewhere}}"]);
	});

	it("duplicating several pages: a reference on one copy follows the picture on another copy, in either order", () => {
		const pic = pageWith(image("p1"), text(captionText("p1", "Lake"), 10, 70));
		const ref = pageWith(text(`see ${referenceToken("p1")}`, 10, 10));
		for (const order of [[pic, ref], [ref, pic]]) {
			const [first, second] = duplicatePages(order);
			const copies = [first!, second!];
			const picture = copies.flatMap((p) => p.elements ?? []).find((e) => e.type === "image")!;
			const refText = copies.flatMap(textsOf).find((s) => s.startsWith("see"));
			expect(refText).toBe(`see {{figref:${picture.id}}}`);
		}
		// copying only the page with the reference leaves it pointing at the original
		expect(textsOf(duplicatePages([ref])[0]!)).toEqual(["see {{figref:p1}}"]);
	});

	it("the duplicate pages command uses one id map for the whole selection", () => {
		const pic = pageWith(image("p1"), text(captionText("p1", "Lake"), 10, 70));
		const ref = pageWith(text(`see ${referenceToken("p1")}`, 10, 10));
		const doc = { id: "d", version: 26, pages: [ref, pic], assets: {}, meta: { bookmarks: [] } } as unknown as NotebookDocument;
		const made = duplicateCommand(doc, [ref.id, pic.id]);
		expect(made).not.toBeNull();
		made!.command.apply(doc);
		expect(doc.pages).toHaveLength(4);
		const copyPic = doc.pages[3]!.elements!.find((e) => e.type === "image")!;
		expect(textsOf(doc.pages[2]!)).toEqual([`see {{figref:${copyPic.id}}}`]);
	});

	it("a notebook made from a template numbers its own pictures", () => {
		const source = { id: "d", version: 26, pages: [captioned()], assets: {}, meta: { bookmarks: [] } } as unknown as NotebookDocument;
		const made = notebookFromTemplate(source);
		const picture = made.pages[0]!.elements!.find((e) => e.type === "image")!;
		expect(textsOf(made.pages[0]!)).toContain(`{{figcap:${picture.id}}} Lake`);
	});

	function clipOf(...elements: NonNullable<Page["elements"]>): ClipContent {
		return { strokes: [], elements, assets: [], bounds: { minX: 0, minY: 0, maxX: 300, maxY: 400 } };
	}

	it("pasting a captioned picture: the pasted caption names the pasted picture", () => {
		const made = instantiateClip(clipOf(image("p1"), text(captionText("p1", "Lake"), 10, 70, "c1"), text(`see ${referenceToken("p1")}`, 10, 300, "r1")), 20, 20);
		const picture = made.elements.find((e) => e.type === "image")!;
		const texts = made.elements.flatMap((e) => (e.type === "text" ? [e.text] : []));
		expect(picture.id).not.toBe("p1");
		expect(texts).toEqual([`{{figcap:${picture.id}}} Lake`, `see {{figref:${picture.id}}}`]);
	});

	it("pasting a caption without its picture leaves it naming the original", () => {
		const made = instantiateClip(clipOf(text(captionText("p1", "Lake"), 10, 70, "c1")), 20, 20);
		expect(made.elements.flatMap((e) => (e.type === "text" ? [e.text] : []))).toEqual(["{{figcap:p1}} Lake"]);
	});

	it("the reference box helper still builds a marker the copy can follow", () => {
		const el = referenceElement("p1", { width: 400, height: 600 }, 10, 10, 12, "#000");
		expect(remapFigureMarkers(el.text, new Map([["p1", "q1"]]))).toBe("{{figref:q1}}");
	});
});
