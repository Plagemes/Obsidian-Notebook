// 0.28 (#205) Box numbering: order, chapters, shared counters, renumbering, labels and the index note.
import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import {
	BOXES_END, boxesRegionOf, boxesStartMarker, buildBoxesSection, EN_ABBREVIATIONS, numberBoxes, numberedBoxLabel, numberMap, pickBoxesNote, replaceBoxesSection,
} from "../src/model/box-numbering";
import { BOX_NAMES } from "../src/ink/marker-render";
import type { BoxElement, BoxKind, Page } from "../src/model/types";

let n = 0;
function box(kind: BoxKind, x: number, y: number, title?: string): BoxElement {
	return { id: `b${++n}`, type: "box", kind, x, y, width: 100, height: 60, ...(title ? { title } : {}) };
}
function page(...els: BoxElement[]): Page {
	const p = createPage({ width: 600, height: 800 });
	p.elements = els;
	return p;
}
const nums = (pages: Page[], marks: Array<{ pageIndex: number; y: number }> = [], o = { chapter: true, shared: false }) =>
	numberBoxes(pages, marks, o).map((i) => `${i.kind[0]}${i.number}`);

describe("numbering", () => {
	it("counts per kind across pages, by position inside a page", () => {
		const p1 = page(box("definition", 10, 300), box("definition", 10, 100), box("theorem", 10, 200));
		const p2 = page(box("definition", 10, 50), box("theorem", 10, 60));
		expect(nums([p1, p2])).toEqual(["d1", "t1", "d2", "d3", "t2"]);
	});
	it("never numbers proofs and shares one counter on request", () => {
		const p = page(box("definition", 0, 10), box("proof", 0, 20), box("theorem", 0, 30), box("remark", 0, 40));
		expect(nums([p])).toEqual(["d1", "t1", "r1"]);
		expect(nums([p], [], { chapter: true, shared: true })).toEqual(["d1", "t2", "r3"]);
	});
	it("prefixes the chapter and restarts counters in each chapter", () => {
		const p1 = page(box("definition", 0, 10), box("definition", 0, 300));
		const p2 = page(box("definition", 0, 10), box("definition", 0, 500));
		// headings: chapter 1 at page 0 y 100, chapter 2 on page 1 y 200
		expect(nums([p1, p2], [{ pageIndex: 1, y: 200 }, { pageIndex: 0, y: 100 }])).toEqual(["d1", "d1.1", "d1.2", "d2.1"]);
	});
	it("ignores headings when the prefix is off or there are none", () => {
		const p = page(box("definition", 0, 10), box("definition", 0, 300));
		expect(nums([p], [{ pageIndex: 0, y: 100 }], { chapter: false, shared: false })).toEqual(["d1", "d2"]);
		expect(nums([p])).toEqual(["d1", "d2"]);
	});
	it("renumbers when a box is deleted or moved", () => {
		const a = box("theorem", 0, 10), b = box("theorem", 0, 100), c = box("theorem", 0, 200);
		expect(numberMap(numberBoxes([page(a, b, c)], [])).get(c.id)).toBe("3");
		expect(numberMap(numberBoxes([page(a, c)], [])).get(c.id)).toBe("2");
		const moved = { ...c, y: 1 };
		expect(numberMap(numberBoxes([page(a, b, moved)], [])).get(moved.id)).toBe("1");
	});
	it("tolerates pages without elements and malformed entries", () => {
		const p = createPage({ width: 600, height: 800 });
		(p as { elements?: unknown }).elements = [null, { type: "box" }, 3];
		expect(numberBoxes([p], [])).toEqual([]);
	});
});

describe("labels", () => {
	it("writes the number, the title, or the plain name when unnumbered", () => {
		const b = box("definition", 0, 0, "Limit");
		expect(numberedBoxLabel(b, "3.2", BOX_NAMES, EN_ABBREVIATIONS)).toBe("Def. 3.2 · Limit");
		expect(numberedBoxLabel(box("theorem", 0, 0), "4", BOX_NAMES, EN_ABBREVIATIONS)).toBe("Thm. 4");
		expect(numberedBoxLabel(box("proof", 0, 0), undefined, BOX_NAMES, EN_ABBREVIATIONS)).toBe(BOX_NAMES.proof);
	});
});

describe("index note", () => {
	const items = numberBoxes([page(box("definition", 0, 10, "A *b*"), box("theorem", 0, 20))], []);
	const section = (owner?: string, id?: string) => buildBoxesSection({
		items, names: BOX_NAMES, abbr: EN_ABBREVIATIONS, pageLink: (p) => `[[Nb#page=${p}|p. ${p}]]`, intro: "Intro", none: "None", owner, ownerId: id,
	});
	it("lists one bullet per box and is deterministic", () => {
		const s = section("Nb.md", "id1");
		expect(s).toBe(section("Nb.md", "id1"));
		expect(s).toContain("**Def. 1** — A \\*b\\* ([[Nb#page=1|p. 1]])");
		expect(s).toContain("**Thm. 1**");
		expect(boxesRegionOf(s)).toEqual({ path: "Nb.md", id: "id1" });
	});
	it("replaces only the region, appends or refuses otherwise", () => {
		const s = section("Nb.md");
		const r = replaceBoxesSection(`mine\n\n${boxesStartMarker("Nb.md")}\nold\n${BOXES_END}\n\ntail`, s, "Nb.md");
		expect(r.outcome).toBe("replaced");
		expect(r.text.startsWith("mine\n\n")).toBe(true);
		expect(r.text.endsWith("\n\ntail")).toBe(true);
		expect(replaceBoxesSection("user text", s, "Nb.md").outcome).toBe("appended");
		expect(replaceBoxesSection(`x ${BOXES_END}`, s, "Nb.md").outcome).toBe("unsafe");
		expect(replaceBoxesSection(`${boxesStartMarker("Other.md")}\n${BOXES_END}`, s, "Nb.md").outcome).toBe("other");
		expect(replaceBoxesSection("", s, "Nb.md").outcome).toBe("created");
	});
	it("picks the first usable note name", async () => {
		expect(await pickBoxesNote(async () => ({ exists: false }), "Nb.md")).toBe(1);
		expect(await pickBoxesNote(async (i) => (i === 1 ? { exists: true, owner: undefined } : { exists: false }), "Nb.md")).toBe(2);
	});
});
