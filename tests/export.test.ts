import { describe, expect, it } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import type { BBox } from "../src/ink/hit-test";
import { minorVisible, paperPattern, RULED_MARGIN_X } from "../src/ink/paper";
import { HIGHLIGHTER_ALPHA } from "../src/ink/stroke-shape";
import { A4_HEIGHT, A4_WIDTH, MM, PAPER_SPACING, type Page, type PaperKind, type Point, type Stroke, type Tool } from "../src/model/types";

function makeStroke(tool: Tool = "pen", color = "#1e1e1e", id = "s1"): Stroke {
	const points: Point[] = [];
	for (let i = 0; i <= 12; i++) points.push([50 + i * 10, 60 + Math.sin(i / 2) * 8, 0.5]);
	return { id, tool, color, width: tool === "highlighter" ? 12 : 2, points };
}

function makePage(kind: PaperKind, strokes: Stroke[] = [], width = A4_WIDTH, height = A4_HEIGHT): Page {
	return { id: "p1", width, height, paper: { kind, spacing: PAPER_SPACING[kind] }, strokes };
}

const whole = (p: Page): BBox => ({ minX: 0, minY: 0, maxX: p.width, maxY: p.height });

describe("paperPattern", () => {
	it("blank has nothing", () => {
		const p = makePage("blank");
		expect(paperPattern(p, whole(p))).toEqual({ lines: [], dots: [] });
	});

	it("grid: lines at every spacing, none on the edge", () => {
		const p = makePage("grid");
		const { lines, dots } = paperPattern(p, whole(p));
		const s = p.paper.spacing;
		const v = lines.filter((l) => l.x1 === l.x2);
		const h = lines.filter((l) => l.y1 === l.y2);
		expect(v.length).toBe(Math.ceil(p.width / s) - 1);
		expect(h.length).toBe(Math.ceil(p.height / s) - 1);
		expect(dots).toEqual([]);
		expect(lines.every((l) => l.kind === "minor")).toBe(true);
		expect(v.every((l) => l.x1 > 0 && l.x1 < p.width)).toBe(true);
		expect(h.every((l) => l.y1 > 0 && l.y1 < p.height)).toBe(true);
		expect(v[0]).toMatchObject({ x1: s, y1: 0, y2: p.height });
	});

	it("ruled: horizontal lines after a top margin plus a margin line at 25 mm", () => {
		const p = makePage("ruled");
		const { lines } = paperPattern(p, whole(p));
		const s = p.paper.spacing;
		const minor = lines.filter((l) => l.kind === "minor");
		expect(minor.every((l) => l.y1 === l.y2)).toBe(true);
		expect(minor[0]!.y1).toBeCloseTo(3 * s);
		expect(minor.length).toBe(Math.ceil(p.height / s) - 1 - 2);
		const margin = lines.filter((l) => l.kind === "margin");
		expect(margin).toHaveLength(1);
		expect(margin[0]).toMatchObject({ x1: RULED_MARGIN_X, x2: RULED_MARGIN_X, y1: 0, y2: p.height });
		expect(RULED_MARGIN_X).toBeCloseTo(25 * MM);
	});

	it("dotted: a dot at every intersection, no lines", () => {
		const p = makePage("dotted");
		const { lines, dots } = paperPattern(p, whole(p));
		const s = p.paper.spacing;
		expect(lines).toEqual([]);
		expect(dots.length).toBe((Math.ceil(p.width / s) - 1) * (Math.ceil(p.height / s) - 1));
		expect(dots[0]).toEqual([s, s]);
		expect(dots.every(([x, y]) => x > 0 && y > 0 && x < p.width && y < p.height)).toBe(true);
	});

	it("millimetre: a major line every 10th", () => {
		const p = makePage("millimetre");
		const { lines } = paperPattern(p, whole(p));
		const v = lines.filter((l) => l.x1 === l.x2);
		const majors = v.filter((l) => l.kind === "major");
		expect(v.length).toBe(Math.ceil(p.width / MM) - 1);
		expect(majors.length).toBe(Math.floor((Math.ceil(p.width / MM) - 1) / 10));
		expect(majors[0]!.x1).toBeCloseTo(10 * MM);
		expect(majors[1]!.x1).toBeCloseTo(20 * MM);
		for (const l of v) expect(l.kind === "major").toBe(Math.round(l.x1 / MM) % 10 === 0);
	});

	it("culls to the visible rectangle", () => {
		const p = makePage("grid");
		const s = p.paper.spacing;
		const visible: BBox = { minX: 2.5 * s, minY: 4.5 * s, maxX: 5.5 * s, maxY: 6.5 * s };
		const { lines } = paperPattern(p, visible);
		const xs = lines.filter((l) => l.x1 === l.x2).map((l) => Math.round(l.x1 / s));
		const ys = lines.filter((l) => l.y1 === l.y2).map((l) => Math.round(l.y1 / s));
		expect(xs).toEqual([3, 4, 5]);
		expect(ys).toEqual([5, 6]);
		expect(paperPattern(makePage("dotted"), visible).dots).toHaveLength(3 * 2);
		expect(paperPattern(p, { minX: -100, minY: -100, maxX: -50, maxY: -50 }).lines).toEqual([]);
	});

	it("includeMinor false keeps only major and margin lines", () => {
		const grid = makePage("grid");
		expect(paperPattern(grid, whole(grid), { includeMinor: false }).lines).toEqual([]);
		const dotted = makePage("dotted");
		expect(paperPattern(dotted, whole(dotted), { includeMinor: false }).dots).toEqual([]);
		const ruled = makePage("ruled");
		expect(paperPattern(ruled, whole(ruled), { includeMinor: false }).lines.map((l) => l.kind)).toEqual(["margin"]);
		const mm = makePage("millimetre");
		const kinds = new Set(paperPattern(mm, whole(mm), { includeMinor: false }).lines.map((l) => l.kind));
		expect([...kinds]).toEqual(["major"]);
	});

	it("minorVisible needs about 3 CSS px between lines", () => {
		expect(minorVisible(MM, 1)).toBe(false);
		expect(minorVisible(MM, 4)).toBe(true);
		expect(minorVisible(PAPER_SPACING.grid, 0.25)).toBe(true);
		expect(minorVisible(PAPER_SPACING.grid, 0.1)).toBe(false);
	});
});

describe("pageToSvg", () => {
	it("is a standalone svg sized in mm with a pt viewBox and a white background", () => {
		const svg = pageToSvg(makePage("blank"));
		expect(svg.startsWith("<svg ")).toBe(true);
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('width="210mm" height="297mm"');
		expect(svg).toContain(`viewBox="0 0 ${A4_WIDTH} ${A4_HEIGHT}"`);
		expect(svg).toContain('fill="#ffffff"');
		expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
	});

	it("has one path per stroke on blank paper", () => {
		const svg = pageToSvg(makePage("blank", [makeStroke("pen", "#112233", "a"), makeStroke("pen", "#445566", "b")]));
		expect(svg.match(/<path /g)).toHaveLength(2);
		expect(svg).toContain('fill="#112233"');
	});

	it("draws paper by default and omits it with paper: false", () => {
		const page = makePage("grid", [makeStroke()]);
		expect(pageToSvg(page).match(/<path /g)!.length).toBeGreaterThan(1);
		expect(pageToSvg(page, { paper: false }).match(/<path /g)).toHaveLength(1);
		expect(pageToSvg(makePage("dotted")).match(/<path /g)).toHaveLength(1);
	});

	it("draws highlighter strokes translucent and multiplied", () => {
		const svg = pageToSvg(makePage("blank", [makeStroke("highlighter", "#ffe600")]));
		expect(svg).toContain(`fill-opacity="${HIGHLIGHTER_ALPHA}"`);
		expect(svg).toContain("mix-blend-mode:multiply");
		expect(pageToSvg(makePage("blank", [makeStroke("pen")]))).not.toContain("fill-opacity");
	});

	it("escapes attribute values", () => {
		const svg = pageToSvg(makePage("blank", [makeStroke("pen", "\"><script>&'")]));
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&quot;&gt;&lt;script&gt;&amp;&apos;");
	});

	it("is deterministic", () => {
		const page = makePage("millimetre", [makeStroke(), makeStroke("highlighter", "#ff0", "h")]);
		expect(pageToSvg(page)).toBe(pageToSvg(page));
	});
});

describe("pagesToPdf", () => {
	const decode = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

	it("has header, trailer and one page object per page", () => {
		const text = decode(pagesToPdf([makePage("blank"), makePage("grid", [makeStroke()]), makePage("ruled")]));
		expect(text.startsWith("%PDF-1.4\n")).toBe(true);
		expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
		expect(text.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(3);
		expect(text).toContain("/Count 3");
		expect(text).toContain("/Producer (Notebook)");
	});

	it("xref offsets point exactly at their objects and startxref at the table", () => {
		const text = decode(
			pagesToPdf([makePage("millimetre", [makeStroke(), makeStroke("highlighter")]), makePage("dotted")], { title: "Fisica (1)" }),
		);
		const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
		expect(text.slice(startxref, startxref + 5)).toBe("xref\n");
		const m = /xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer/.exec(text.slice(startxref))!;
		const count = Number(m[1]);
		const entries = m[2]!.match(/[\s\S]{20}/g)!;
		expect(entries).toHaveLength(count);
		expect(entries[0]).toBe("0000000000 65535 f \n");
		for (let n = 1; n < count; n++) {
			const off = Number(entries[n]!.slice(0, 10));
			expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
		}
		expect(text).toContain(`/Size ${count}`);
		expect(text).toContain("/Root 1 0 R");
		expect(text).toContain("/Info 3 0 R");
	});

	it("uses the page size as MediaBox and the stream /Length matches", () => {
		const text = decode(pagesToPdf([makePage("blank"), makePage("blank", [], 612, 792)]));
		expect(text).toContain(`/MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}]`);
		expect(text).toContain("/MediaBox [0 0 612 792]");
		const streams = [...text.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
		expect(streams).toHaveLength(2);
		for (const m of streams) expect(m[2]!.length).toBe(Number(m[1]));
	});

	it("flips y and fills strokes with their colour", () => {
		const text = decode(pagesToPdf([makePage("blank", [makeStroke("pen", "#ff8000")])]));
		expect(text).toContain(`1 0 0 -1 0 ${A4_HEIGHT} cm`);
		expect(text).toContain("1 0.502 0 rg");
		expect(text).toMatch(/ m [\s\S]* c [\s\S]*h f/);
		expect(text).not.toMatch(/\de[+-]?\d/);
	});

	it("adds the multiply ExtGState only when a highlighter stroke exists", () => {
		const plain = decode(pagesToPdf([makePage("grid", [makeStroke()])]));
		expect(plain).not.toContain("/ExtGState");
		expect(plain).not.toContain(" gs");
		const hl = decode(pagesToPdf([makePage("blank", [makeStroke("highlighter", "#ffe600")]), makePage("blank")]));
		expect(hl.match(/\/ExtGState <</g)).toHaveLength(1);
		expect(hl).toContain(`/ca ${HIGHLIGHTER_ALPHA}`);
		expect(hl).toContain("/BM /Multiply");
		expect(hl).toContain("/GS1 gs");
	});

	it("draws paper unless paper: false, and escapes the title", () => {
		const page = makePage("grid");
		expect(decode(pagesToPdf([page]))).toMatch(/ S\n?/);
		expect(decode(pagesToPdf([page], { paper: false }))).not.toMatch(/ S(\n|$)/);
		expect(decode(pagesToPdf([page], { title: "a (b) \\c" }))).toContain("/Title (a \\(b\\) \\\\c)");
		expect(decode(pagesToPdf([page], { title: "é" }))).toContain("/Title <FEFF00E9>");
	});

	it("keeps coordinates to 2 decimals", () => {
		const text = decode(pagesToPdf([makePage("millimetre", [makeStroke()])]));
		const content = text.match(/stream\n([\s\S]*?)\nendstream/)![1]!;
		const withoutColours = content.split("\n").filter((l) => !/ (rg|RG)$/.test(l)).join("\n");
		expect(withoutColours).not.toMatch(/\d\.\d{3,}/);
	});
});
