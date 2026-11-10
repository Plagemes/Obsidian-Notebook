// 0.29 (#248) Figure captions and references: markers, numbering in reading order, renumbering, display-time resolution (shownText),
// the "Fig. ?" state, the registry and the boxes the actions build.
import { afterEach, describe, expect, it } from "vitest";
import { createId, createPage } from "../src/model/document";
import {
	brokenReferences, captionBoxes, captionElement, captionSpot, markerSafeId, numberFigures, numberMapOf, referenceElement, referencesOf,
	withCaptionWords, withFigureLabels,
} from "../src/model/figure-captions";
import { collectFigures } from "../src/model/figures";
import {
	addFigureLabelSource, captionShown, captionText, captionToken, figureIdOfTarget, figureLabel, figureNumber, figureTokens, FIGURE_TARGET_PREFIX,
	hasFigureTokens, parseCaption, referenceToken, resolveFigureMarkers,
} from "../src/ink/figure-text";
import { hitLink, linkRects } from "../src/ink/link-text";
import { layoutText } from "../src/ink/text-layout";
import { shownText } from "../src/ink/wikilink";
import { companionContent } from "../src/model/companion-content";
import { buildNotebookMarkdown } from "../src/model/export-markdown";
import type { ImageElement, NotebookDocument, Page, TextElement } from "../src/model/types";

const image = (id: string, x = 10, y = 10): ImageElement => ({ id, type: "image", asset: `a-${id}`, x, y, width: 100, height: 50, rotation: 0 });
const text = (t: string, x = 10, y = 200, id = createId()): TextElement => ({ id, type: "text", x, y, width: 200, text: t, fontSize: 12, color: "#000" });
const pageWith = (...elements: NonNullable<Page["elements"]>): Page => {
	const p = createPage();
	p.elements = elements;
	return p;
};

const removers: Array<() => void> = [];
afterEach(() => {
	while (removers.length > 0) removers.pop()!();
});
/** Makes the numbers of `pages` known, as the open view does. */
function open(pages: Page[]): void {
	removers.push(addFigureLabelSource({ abbr: () => "Fig.", number: (id) => numberMapOf(numberFigures(pages)).get(id) ?? null }));
}

describe("markers", () => {
	it("finds caption and reference markers and ignores look-alikes", () => {
		const s = `${captionToken("a-1")} words ${referenceToken("b_2")} {{figure:x}} {{figref:bad id}}`;
		expect(hasFigureTokens(s)).toBe(true);
		expect(figureTokens(s).map((t) => [t.kind, t.id])).toEqual([["cap", "a-1"], ["ref", "b_2"]]);
		expect(figureTokens("plain {{fi}} text")).toEqual([]);
	});

	it("a caption is a box that starts with the marker", () => {
		expect(parseCaption("{{figcap:f1}} Sunset over the lake")).toEqual({ figureId: "f1", text: "Sunset over the lake" });
		expect(parseCaption("  {{figcap:f1}}")).toEqual({ figureId: "f1", text: "" });
		expect(parseCaption("see {{figcap:f1}} words")).toBeNull();
		expect(parseCaption("{{figref:f1}}")).toBeNull();
	});

	it("builds the stored text of a caption", () => {
		expect(captionText("f1", "  Sunset ")).toBe("{{figcap:f1}} Sunset");
		expect(captionText("f1", "")).toBe("{{figcap:f1}}");
		expect(withCaptionWords("{{figcap:f1}} Old", "New words")).toBe("{{figcap:f1}} New words");
		expect(withCaptionWords("not a caption", "x")).toBeNull();
	});

	it("link targets of references", () => {
		expect(figureIdOfTarget(`${FIGURE_TARGET_PREFIX}f1`)).toBe("f1");
		expect(figureIdOfTarget("Note")).toBeNull();
	});

	it("only ids that fit a marker are accepted", () => {
		expect(markerSafeId(createId())).toBe(true);
		expect(markerSafeId("a b")).toBe(false);
		expect(markerSafeId("")).toBe(false);
	});
});

describe("numbering", () => {
	it("numbers only captioned figures, in reading order across pages", () => {
		const a = image("fa", 200, 10);
		const b = image("fb", 10, 10);
		const c = image("fc", 10, 10);
		const nothing = image("fz", 10, 100);
		const pages = [
			pageWith(a, b, nothing, text(captionText("fa", "A")), text(captionText("fb", "B"))),
			pageWith(c, text(captionText("fc", "C"))),
		];
		const list = numberFigures(pages);
		expect(list.map((n) => [n.figure.elementId, n.number, n.caption])).toEqual([["fb", 1, "B"], ["fa", 2, "A"], ["fc", 3, "C"]]);
	});

	it("renumbers when a figure is added before, removed, or a page is moved", () => {
		const p1 = pageWith(image("f1"), text(captionText("f1", "one")));
		const p2 = pageWith(image("f2"), text(captionText("f2", "two")));
		expect(numberMapOf(numberFigures([p1, p2])).get("f2")).toBe(2);
		// a captioned figure is inserted on a page before
		const p0 = pageWith(image("f0"), text(captionText("f0", "zero")));
		expect(numberMapOf(numberFigures([p0, p1, p2])).get("f2")).toBe(3);
		// the first is removed (the caption stays but names nothing)
		expect(numberMapOf(numberFigures([pageWith(text(captionText("f1", "one"))), p2])).get("f2")).toBe(1);
		// pages swapped
		expect(numberMapOf(numberFigures([p2, p1])).get("f2")).toBe(1);
		expect(numberMapOf(numberFigures([p2, p1])).get("f1")).toBe(2);
	});

	it("moving a figure up the page before another one swaps their numbers", () => {
		const top = image("ft", 10, 10);
		const low = image("fl", 10, 300);
		const caps = [text(captionText("ft", "T"), 10, 70), text(captionText("fl", "L"), 10, 360)];
		expect(numberMapOf(numberFigures([pageWith(top, low, ...caps)])).get("ft")).toBe(1);
		expect(numberMapOf(numberFigures([pageWith({ ...top, y: 500 }, low, ...caps)])).get("ft")).toBe(2);
	});

	it("two captions of the same figure share its number; a caption of nothing has none", () => {
		const f = image("f1");
		const pages = [pageWith(f, text(captionText("f1", "a")), text(captionText("f1", "b"), 10, 300), text(captionText("ghost", "x"), 10, 400))];
		const list = numberFigures(pages);
		expect(list).toHaveLength(1);
		expect(list[0]!.captions).toHaveLength(2);
		expect(captionBoxes(pages)).toHaveLength(3);
	});

	it("takes the words of the first caption that has any", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", ""), 10, 60), text(captionText("f1", "Words\nover two lines"), 10, 90))];
		expect(numberFigures(pages)[0]!.caption).toBe("Words over two lines");
	});

	it("an empty notebook has no numbers", () => {
		expect(numberFigures([])).toEqual([]);
		expect(numberFigures([createPage()])).toEqual([]);
	});
});

describe("display-time resolution", () => {
	it("a caption shows its number and a dash before the words", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "Lake")))];
		open(pages);
		expect(shownText(captionText("f1", "Lake")).text).toBe("Fig. 1 — Lake");
		expect(shownText(captionText("f1", "")).text).toBe("Fig. 1");
		expect(shownText("{{figcap:f1}}Lake").text).toBe("Fig. 1 — Lake");
	});

	it("a reference shows the current number and is a link to the figure", () => {
		const pages = [pageWith(image("f0"), text(captionText("f0", "z")), image("f1", 10, 300), text(captionText("f1", "x"), 10, 360))];
		open(pages);
		const shown = shownText(`see ${referenceToken("f1")} for details`);
		expect(shown.text).toBe("see Fig. 2 for details");
		expect(shown.links).toHaveLength(1);
		expect(shown.links[0]).toMatchObject({ start: 4, end: 10, target: `${FIGURE_TARGET_PREFIX}f1` });
		expect(figureIdOfTarget(shown.links[0]!.target)).toBe("f1");
	});

	it("the same stored text shows another number after the document changes (nothing is stored)", () => {
		const ref = text(referenceToken("f1"));
		const f1 = pageWith(image("f1"), text(captionText("f1", "x")), ref);
		const pages = [f1];
		open(pages);
		expect(shownText(ref.text).text).toBe("Fig. 1");
		pages.unshift(pageWith(image("f0"), text(captionText("f0", "z"))));
		expect(shownText(ref.text).text).toBe("Fig. 2");
		expect(ref.text).toBe(referenceToken("f1"));
	});

	it("a reference to a deleted figure shows Fig. ?", () => {
		const pages = [pageWith(text(referenceToken("gone")), text(captionText("gone", "orphan")))];
		open(pages);
		expect(figureNumber("gone")).toBeNull();
		expect(figureLabel("gone")).toBe("Fig. ?");
		expect(shownText(referenceToken("gone")).text).toBe("Fig. ?");
		expect(shownText(captionText("gone", "orphan")).text).toBe("Fig. ? — orphan");
	});

	it("with no source at all every marker reads Fig. ?", () => {
		expect(shownText(referenceToken("f1")).text).toBe("Fig. ?");
	});

	it("markers mix with wikilinks in order", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		open(pages);
		const shown = shownText("[[Note|the note]] and {{figref:f1}} and [[Other]]");
		expect(shown.text).toBe("the note and Fig. 1 and Other");
		expect(shown.links.map((l) => [l.start, l.end, l.target])).toEqual([[0, 8, "Note"], [13, 19, `${FIGURE_TARGET_PREFIX}f1`], [24, 29, "Other"]]);
	});

	it("layout wraps what is shown, not the marker", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		open(pages);
		const lines = layoutText(shownText(referenceToken("f1")).text, 12, 200, (s) => s.length * 6).lines;
		expect(lines).toEqual(["Fig. 1"]);
	});

	it("the tap area of a reference is the shown label", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		open(pages);
		const box = text(`go to ${referenceToken("f1")}`, 10, 100);
		const rects = linkRects(box, (s, size) => s.length * size * 0.5);
		expect(rects).toHaveLength(1);
		expect(rects[0]!.x).toBeCloseTo(10 + "go to ".length * 6);
		expect(rects[0]!.width).toBeCloseTo("Fig. 1".length * 6);
		const hit = hitLink([box], rects[0]!.x + 3, rects[0]!.y + 3, 2, (s, size) => s.length * size * 0.5);
		expect(hit && figureIdOfTarget(hit.link.target)).toBe("f1");
		expect(hit?.whole).toBe(false);
	});

	it("a box with a marker and no [[ is still hit-tested", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		open(pages);
		const box = text(referenceToken("f1"), 0, 0);
		expect(hitLink([box], 3, 3, 2, (s, size) => s.length * size * 0.5)).not.toBeNull();
		expect(hitLink([text("plain", 0, 0)], 3, 3, 2)).toBeNull();
	});

	it("caption text keeps the marker out of the shown words", () => {
		expect(captionShown("zz", " words")).toBe("Fig. ? —");
		expect(captionShown("zz", "")).toBe("Fig. ?");
		expect(captionShown("zz", "\nnext line")).toBe("Fig. ?");
	});
});

describe("registry and scoped numbers", () => {
	it("the most recent source that knows the figure answers", () => {
		removers.push(addFigureLabelSource({ abbr: () => "Fig.", number: (id) => (id === "x" ? 1 : null) }));
		removers.push(addFigureLabelSource({ abbr: () => "Fig.", number: (id) => (id === "x" ? 7 : id === "y" ? 2 : null) }));
		expect(figureNumber("x")).toBe(7);
		expect(figureNumber("y")).toBe(2);
		expect(figureNumber("z")).toBeNull();
	});

	it("uses the abbreviation of the source", () => {
		removers.push(addFigureLabelSource({ abbr: () => "Abb.", number: () => 4 }));
		expect(figureLabel("q")).toBe("Abb. 4");
	});

	it("withFigureLabels knows the numbers only while it runs", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		const inside = withFigureLabels(pages, () => shownText(referenceToken("f1")).text);
		expect(inside).toBe("Fig. 1");
		expect(shownText(referenceToken("f1")).text).toBe("Fig. ?");
	});

	it("withFigureLabels forgets the numbers when the function throws", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "x")))];
		expect(() => withFigureLabels(pages, () => {
			throw new Error("boom");
		})).toThrow("boom");
		expect(figureNumber("f1")).toBeNull();
	});
});

describe("references and broken references", () => {
	it("lists references in reading order and the ones that show Fig. ?", () => {
		const pages = [
			pageWith(image("f1"), text(captionText("f1", "x")), text(`${referenceToken("f1")} and ${referenceToken("gone")}`, 10, 300, "r1")),
			pageWith(text(referenceToken("f1"), 10, 10, "r2")),
		];
		expect(referencesOf(pages).map((r) => [r.figureId, r.boxId, r.pageIndex])).toEqual([["f1", "r1", 0], ["gone", "r1", 0], ["f1", "r2", 1]]);
		expect(brokenReferences(pages).map((r) => r.figureId)).toEqual(["gone"]);
	});

	it("a reference to a figure that lost its caption is broken", () => {
		const pages = [pageWith(image("f1"), text(referenceToken("f1")))];
		expect(brokenReferences(pages)).toHaveLength(1);
	});
});

describe("the boxes the actions build", () => {
	it("a caption goes under the picture, as wide as it, and is a recognisable caption", () => {
		const page = createPage({ width: 600, height: 800 });
		const f = image("f1", 100, 100);
		page.elements = [f];
		const entry = collectFigures([page], [0])[0]!;
		const el = captionElement(entry, page, "A lake", 12, "#000", "cap1");
		expect(el).toMatchObject({ id: "cap1", type: "text", x: 100, y: 154, width: 100, text: "{{figcap:f1}} A lake", fontSize: 12 });
		page.elements.push(el);
		expect(numberFigures([page])[0]).toMatchObject({ number: 1, caption: "A lake" });
	});

	it("a narrow picture gets a readable width and stays inside the page", () => {
		const spot = captionSpot({ x: 560, y: 100, width: 30, height: 30 }, { width: 600, height: 800 }, 12);
		expect(spot.width).toBe(90);
		expect(spot.x + spot.width).toBeLessThanOrEqual(600);
	});

	it("with no room under the picture the caption goes above it", () => {
		const spot = captionSpot({ x: 10, y: 770, width: 100, height: 30 }, { width: 600, height: 800 }, 12);
		expect(spot.y).toBeLessThan(770);
	});

	it("a reference box holds only the marker, one line wide", () => {
		const page = createPage({ width: 600, height: 800 });
		const el = referenceElement("f1", page, 50, 60, 12, "#112233");
		expect(el.text).toBe("{{figref:f1}}");
		expect(el.x).toBe(50);
		expect(el.y).toBe(60);
		expect(el.width).toBeGreaterThanOrEqual(40);
		expect(el.color).toBe("#112233");
	});
});

describe("outputs that carry text as Markdown", () => {
	it("resolveFigureMarkers writes the current labels and leaves wikilinks alone", () => {
		open([pageWith(image("f1"), text(captionText("f1", "x")))]);
		expect(resolveFigureMarkers("{{figcap:f1}} Lake")).toBe("Fig. 1 — Lake");
		expect(resolveFigureMarkers("see {{figref:f1}} and [[Note|n]], {{figref:no}}")).toBe("see Fig. 1 and [[Note|n]], Fig. ?");
		expect(resolveFigureMarkers("nothing here")).toBe("nothing here");
	});

	it("the Markdown export numbers a notebook that is not open", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "Lake"), 10, 80), text(`see ${referenceToken("f1")}`, 10, 300))];
		const md = buildNotebookMarkdown({ title: "T", pages, meta: undefined, images: ["a.png"], pageLabel: (n) => `Page ${n}` });
		expect(md).toContain("Fig. 1 — Lake");
		expect(md).toContain("see Fig. 1");
		expect(md).not.toContain("figcap");
		expect(md).not.toContain("figref");
	});

	it("the companion note body numbers the figures from the document alone", () => {
		const pages = [pageWith(image("f1"), text(captionText("f1", "Lake"), 10, 80), text(`see ${referenceToken("f1")}`, 10, 300))];
		const doc = { id: "d1", version: 27, pages, assets: {}, meta: { bookmarks: [] } } as unknown as NotebookDocument;
		const body = companionContent(doc, { notebookPath: "Notes/T.notebook", pageUri: (n: number) => `obsidian://x/${n}`, searchText: true }).text;
		expect(body).toContain("Fig. 1");
		expect(body).not.toContain("figcap");
	});
});
