// 0.16 (#90) Highlights digest: the regions (clustering), the PDF text under them, the Markdown section and its replacement.
import { describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import { liveStateView } from "../src/model/states";
import {
	buildDigestSection, colourFamily, cropRect, digestImageName, digestSectionOf, highlightRegions, newDigestNote, replaceDigestSection,
	sectionImageNames, strokeBands, DIGEST_END, DIGEST_START, type DigestBuild, type DigestItem,
} from "../src/model/highlight-digest";
import type { Page, Stroke } from "../src/model/types";
import { textUnderBands } from "../src/pdf/region-text";
import type { TextBox } from "../src/pdf/text-items";

const YELLOW = "#facc15";
const GREEN = "#4ade80";

/** A straight highlighter stroke along y from x0 to x1. */
function hl(x0: number, x1: number, y: number, color = YELLOW, width = 14): Stroke {
	const points: Array<[number, number, number]> = [];
	for (let x = x0; x <= x1; x += 5) points.push([x, y, 0.5]);
	return createStroke(color, width, points, "highlighter");
}

function pageWith(...strokes: Stroke[]): Page {
	const p = createPage({ width: 600, height: 800 });
	p.strokes = strokes;
	return p;
}

describe("highlightRegions", () => {
	it("joins the strokes of one paragraph (one per line) into a region and keeps far ones apart", () => {
		const page = pageWith(hl(50, 300, 100), hl(50, 280, 120), hl(50, 200, 140), hl(50, 300, 400));
		const regions = highlightRegions([page]);
		expect(regions).toHaveLength(2);
		expect(regions[0]!.strokeIds).toHaveLength(3);
		expect(regions[0]!.rect.y).toBeLessThan(regions[1]!.rect.y);
		expect(regions[1]!.strokeIds).toHaveLength(1);
	});

	it("keeps different colours in different regions even when they overlap", () => {
		const regions = highlightRegions([pageWith(hl(50, 300, 100, YELLOW), hl(50, 300, 105, GREEN))]);
		expect(regions.map((r) => r.colour).sort()).toEqual([GREEN, YELLOW]);
	});

	it("ignores pens, hidden ink and other pages' strokes, and numbers pages from 0 in order", () => {
		const pen = createStroke("#000000", 2, [[10, 10, 0.5], [50, 10, 0.5]], "pen");
		const hidden: Stroke = { ...hl(50, 100, 300), hidden: true };
		const a = pageWith(pen, hidden);
		const b = pageWith(hl(20, 80, 50));
		const c = pageWith(hl(20, 80, 50, GREEN));
		const regions = highlightRegions([a, b, c]);
		expect(regions.map((r) => r.pageIndex)).toEqual([1, 2]);
		expect(regions[0]!.pageId).toBe(b.id);
	});

	it("is case-insensitive about the colour and survives a stroke without points", () => {
		const empty = createStroke(YELLOW, 14, [], "highlighter");
		const regions = highlightRegions([pageWith(empty, hl(50, 100, 100, YELLOW.toUpperCase()), hl(50, 100, 108, YELLOW))]);
		expect(regions).toHaveLength(1);
		expect(regions[0]!.strokeIds).toHaveLength(2);
	});

	it("orders the regions of a page top to bottom, then left to right", () => {
		const regions = highlightRegions([pageWith(hl(400, 500, 300), hl(50, 100, 300), hl(50, 100, 50))]);
		expect(regions.map((r) => [Math.round(r.rect.x), Math.round(r.rect.y)])).toEqual([[43, 43], [43, 293], [393, 293]]);
	});

	it("sees the strokes of the state a page is shown in", () => {
		const base = pageWith(hl(50, 100, 100));
		const moved: Page = { ...base, strokes: [{ ...base.strokes[0]!, points: base.strokes[0]!.points.map((p) => [p[0], p[1] + 200, p[2]] as [number, number, number]) }] };
		expect(highlightRegions([liveStateView(moved)])[0]!.rect.y).toBeGreaterThan(250);
	});

	it("handles a thousand strokes quickly", () => {
		const many = Array.from({ length: 1000 }, (_, i) => hl(10 + (i % 20) * 25, 25 + (i % 20) * 25, 20 + Math.floor(i / 20) * 30));
		const t0 = Date.now();
		const regions = highlightRegions([pageWith(...many)]);
		expect(regions.length).toBeGreaterThan(0);
		expect(Date.now() - t0).toBeLessThan(3000);
	});
});

describe("cropRect", () => {
	it("pads the region, stays inside the page and has a minimum size", () => {
		const [r] = highlightRegions([pageWith(hl(2, 30, 5))]);
		const c = cropRect(r!, { width: 600, height: 800 });
		expect(c.x).toBe(0);
		expect(c.y).toBe(0);
		expect(c.width).toBeGreaterThanOrEqual(40);
		const [far] = highlightRegions([pageWith(hl(560, 599, 790))]);
		const f = cropRect(far!, { width: 600, height: 800 });
		expect(f.x + f.width).toBeLessThanOrEqual(600);
		expect(f.y + f.height).toBeLessThanOrEqual(800);
	});
});

describe("strokeBands", () => {
	it("gives one band to a straight stroke and several to one that crosses lines", () => {
		expect(strokeBands(hl(50, 300, 100))).toHaveLength(1);
		const zig = createStroke(YELLOW, 10, [[50, 100, 0.5], [200, 100, 0.5], [200, 130, 0.5], [50, 130, 0.5], [50, 160, 0.5], [200, 160, 0.5]], "highlighter");
		expect(strokeBands(zig).length).toBeGreaterThanOrEqual(3);
	});
});

describe("textUnderBands", () => {
	const run = (str: string, x: number, y: number, width: number, height = 12): TextBox => ({ str, x, y, width, height });
	const boxes = [
		run("The quick brown fox", 50, 100, 190),
		run("jumps over the lazy", 50, 116, 200),
		run("dog and then some", 50, 132, 170),
		run("unrelated", 50, 300, 90),
	];

	it("reads whole words, line by line, in reading order", () => {
		const bands = [{ x0: 45, y0: 98, x1: 245, y1: 130 }];
		expect(textUnderBands(boxes, bands)).toBe("The quick brown fox jumps over the lazy");
	});

	it("keeps only the words a partial highlight covers", () => {
		const bands = [{ x0: 50, y0: 100, x1: 120, y1: 112 }];
		expect(textUnderBands(boxes, bands)).toBe("The quick");
	});

	it("does not list a word twice when two strokes cover it", () => {
		const bands = [{ x0: 45, y0: 98, x1: 245, y1: 112 }, { x0: 100, y0: 99, x1: 200, y1: 111 }];
		expect(textUnderBands(boxes, bands)).toBe("The quick brown fox");
	});

	it("skips lines the band only brushes and gives nothing for no text", () => {
		expect(textUnderBands(boxes, [{ x0: 0, y0: 112, x1: 600, y1: 113 }])).toBe("");
		expect(textUnderBands([], [{ x0: 0, y0: 0, x1: 10, y1: 10 }])).toBe("");
		expect(textUnderBands(boxes, [])).toBe("");
	});

	it("joins a hyphenated word across a line break", () => {
		const hy = [run("an inter-", 50, 100, 90), run("national word", 50, 116, 130)];
		expect(textUnderBands(hy, [{ x0: 40, y0: 98, x1: 200, y1: 130 }])).toBe("an international word");
	});
});

describe("colourFamily", () => {
	it("names the toolbar highlighter colours", () => {
		expect(colourFamily("#facc15")).toBe("yellow");
		expect(colourFamily("#4ade80")).toBe("green");
		expect(colourFamily("#f472b6")).toBe("pink");
		expect(colourFamily("#60a5fa")).toBe("blue");
		expect(colourFamily("#fb923c")).toBe("orange");
		expect(colourFamily("#888888")).toBe("grey");
		expect(colourFamily("nonsense")).toBe("grey");
	});
});

describe("the Markdown section", () => {
	const page = pageWith(hl(50, 300, 100), hl(50, 300, 400, GREEN));
	const regions = highlightRegions([page, pageWith(hl(50, 200, 100, GREEN))]);
	const items: DigestItem[] = regions.map((region, i) => ({
		region, pageNumber: region.pageIndex + 1, image: `![[img ${i}.png]]`, text: i === 0 ? "first quote\nsecond line" : "",
	}));
	const build = (group: "page" | "colour", list: readonly DigestItem[] = items): DigestBuild => ({
		items: list, group,
		pageLink: (n, id) => `[[Nb.notebook#p${n}&id=${id}|Page ${n}]]`,
		pageHeading: (n, id) => `[[Nb.notebook#p${n}&id=${id}|Page ${n}]]`,
		colourName: (f) => f.toUpperCase(),
		intro: "Intro", none: "Nothing",
	});

	it("groups by page with a heading and a link per page, quoting the PDF text", () => {
		const s = buildDigestSection(build("page"));
		expect(s.startsWith(DIGEST_START)).toBe(true);
		expect(s.endsWith(DIGEST_END)).toBe(true);
		expect(s.match(/^## /gmu)).toHaveLength(2);
		expect(s).toContain("> first quote\n> second line");
		expect(s).toContain("![[img 0.png]]");
		expect(s).toContain(`#p1&id=${page.id}`);
		expect(s).toContain("YELLOW");
	});

	it("groups by colour, each highlight linking back to its page", () => {
		const s = buildDigestSection(build("colour"));
		const headings = s.match(/^## .*$/gmu)!;
		expect(headings).toEqual(["## YELLOW", "## GREEN"]);
		expect(s).toContain("[[Nb.notebook#p2&id=");
	});

	it("says so when there is nothing", () => {
		expect(buildDigestSection(build("page", []))).toContain("Nothing");
	});

	it("replaces only what is between the markers and is idempotent", () => {
		const section = buildDigestSection(build("page"));
		const mine = "# My notes\n\nSome thoughts before.\n\n";
		const after = "\n\n## After\nmore text I wrote\n";
		const first = replaceDigestSection(mine + section + after, section);
		expect(first.outcome).toBe("replaced");
		expect(first.text).toBe(mine + section + after);
		const other = buildDigestSection(build("colour"));
		const second = replaceDigestSection(first.text, other);
		expect(second.text.startsWith(mine)).toBe(true);
		expect(second.text.endsWith(after)).toBe(true);
		expect(second.text).toContain("## GREEN");
		expect(second.text).not.toContain("## Page");
		expect(replaceDigestSection(second.text, other).text).toBe(second.text);
		const back = replaceDigestSection(second.text, section);
		expect(back.text).toBe(first.text);
	});

	it("appends to a note without markers, creates from an empty one, and appending twice does not duplicate", () => {
		const section = buildDigestSection(build("page"));
		const appended = replaceDigestSection("my text\n\n\n", section);
		expect(appended.outcome).toBe("appended");
		expect(appended.text.startsWith("my text\n\n" + DIGEST_START)).toBe(true);
		const again = replaceDigestSection(appended.text, section);
		expect(again.text).toBe(appended.text);
		expect(replaceDigestSection("  \n", section).outcome).toBe("created");
		expect(newDigestNote("T", section).startsWith("# T\n\n" + DIGEST_START)).toBe(true);
	});

	it("never touches a note with an unpaired marker", () => {
		const section = buildDigestSection(build("page"));
		for (const broken of [`text ${DIGEST_START} no end`, `text ${DIGEST_END} alone`]) {
			const r = replaceDigestSection(broken, section);
			expect(r.outcome).toBe("unsafe");
			expect(r.text).toBe(broken);
		}
	});

	it("replaces the first pair when a note has several and keeps text between them", () => {
		const section = buildDigestSection(build("page"));
		const note = `${DIGEST_START}old${DIGEST_END}\nmiddle\n${DIGEST_START}other${DIGEST_END}`;
		const r = replaceDigestSection(note, section);
		expect(r.text).toBe(`${section}\nmiddle\n${DIGEST_START}other${DIGEST_END}`);
	});

	it("finds the section and the pictures an earlier digest embedded", () => {
		const section = buildDigestSection(build("page", [{ ...items[0]!, image: "![[Nb highlight p1-1.png]]" }, { ...items[1]!, image: "![x](sub%20dir/Nb%20highlight%20p2-1.png)" }]));
		expect(digestSectionOf("a\n" + section + "\nb")).toBe(section);
		expect(digestSectionOf("nothing")).toBe("");
		expect([...sectionImageNames(section)].sort()).toEqual(["nb highlight p1-1.png", "nb highlight p2-1.png"]);
		expect(digestImageName("Nb", 3, 2)).toBe("Nb highlight p3-2.png");
	});
});
