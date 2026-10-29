import { describe, expect, it } from "vitest";
import { pagesToPdf, type PdfPlacedImage } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import type { BBox } from "../src/ink/hit-test";
import { minorVisible, paperPattern, RULED_MARGIN_X } from "../src/ink/paper";
import { HIGHLIGHTER_ALPHA } from "../src/ink/stroke-shape";
import { helveticaWidth } from "../src/pdf/helvetica";
import { A4_HEIGHT, A4_WIDTH, MM, PAPER_SPACING, type ImageElement, type Page, type PageElement, type PaperKind, type Point, type Stroke, type TextElement, type Tool } from "../src/model/types";

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

// ---- images and text elements -------------------------------------------------------------

/** 1x1 baseline grayscale JPEG built byte by byte (decodes to mid grey; contains 0x00 and 0xFF bytes). */
function tinyJpeg(components: 1 | 3 = 1): Uint8Array {
	const bytes: number[] = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)];
	bytes.push(0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 1, 0, 1, components, 1, 0x11, 0);
	for (const tc of [0x00, 0x10]) bytes.push(0xff, 0xc4, 0, 0x14, tc, 1, ...new Array<number>(15).fill(0), 0);
	bytes.push(0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x3f, 0xff, 0xd9);
	return Uint8Array.from(bytes);
}

/** One char per byte, so string offsets are byte offsets. */
const bin = (b: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
	return s;
};

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

function textEl(text: string, extra: Partial<TextElement> = {}): TextElement {
	return { id: "t1", type: "text", x: 50, y: 100, width: 120, text, fontSize: 12, color: "#ff0000", ...extra };
}

function withElements(page: Page, elements: PageElement[]): Page {
	return { ...page, elements };
}

/** Checks the xref table of a PDF byte array; returns the number of entries. */
function checkXref(bytes: Uint8Array): number {
	const text = bin(bytes);
	const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
	expect(text.slice(startxref, startxref + 5)).toBe("xref\n");
	const m = /xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer/.exec(text.slice(startxref))!;
	const count = Number(m[1]);
	const entries = m[2]!.match(/[\s\S]{20}/g)!;
	expect(entries).toHaveLength(count);
	for (let n = 1; n < count; n++) {
		const off = Number(entries[n]!.slice(0, 10));
		expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
	}
	return count;
}

describe("pagesToPdf images", () => {
	const jpeg = tinyJpeg();
	const placed = (extra: Partial<PdfPlacedImage> = {}): PdfPlacedImage => ({
		jpeg, pixelWidth: 1, pixelHeight: 1, x: 10, y: 20, width: 100, height: 50, ...extra,
	});

	it("embeds the JPEG as a DCTDecode image whose /Length is its byte length", () => {
		const bytes = pagesToPdf([makePage("blank")], { images: () => [placed()] });
		const text = bin(bytes);
		expect(jpeg.length).toBe(141);
		expect(text).toContain(
			"/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length 141 >>",
		);
		const at = indexOfBytes(bytes, jpeg);
		expect(at).toBeGreaterThan(0);
		expect(text.slice(at - 7, at)).toBe("stream\n");
		expect(text.slice(at + jpeg.length, at + jpeg.length + 10)).toBe("\nendstream");
		checkXref(bytes);
	});

	it("keeps every xref offset exact in bytes with binary data, text and several pages", () => {
		const pages = [
			withElements(makePage("grid", [makeStroke()]), [textEl("é€ text")]),
			makePage("blank", [makeStroke("highlighter")]),
		];
		const bytes = pagesToPdf(pages, { images: () => [placed()], title: "é" });
		expect(checkXref(bytes)).toBeGreaterThan(5);
	});

	it("references the image from the page resources and draws it with a flipping matrix", () => {
		const text = bin(pagesToPdf([makePage("blank")], { images: () => [placed()] }));
		const n = /\/XObject << \/Im(\d+) (\d+) 0 R >>/.exec(text)!;
		expect(n[1]).toBe(n[2]);
		expect(text).toContain(`q 100 0 0 -50 10 70 cm /Im${n[1]} Do Q`);
		expect(text).toContain(`${n[2]} 0 obj\n<< /Type /XObject`);
	});

	it("rotates around the centre of the box", () => {
		const text = bin(pagesToPdf([makePage("blank")], { images: () => [placed({ rotation: Math.PI / 2 })] }));
		expect(text).toContain("1 0 0 1 60 45 cm");
		expect(text).toContain("0 1 -1 0 0 0 cm");
		expect(text).toContain("100 0 0 -50 -50 25 cm");
	});

	it("embeds one object per distinct Uint8Array instance", () => {
		const count = (images: PdfPlacedImage[]) =>
			bin(pagesToPdf([makePage("blank"), makePage("blank")], { images: () => images })).match(/\/Subtype \/Image/g)?.length ?? 0;
		expect(count([placed(), placed({ x: 0 })])).toBe(1);
		expect(count([placed(), placed({ jpeg: jpeg.slice() })])).toBe(2);
	});

	it("detects colour components from the JPEG", () => {
		const text = bin(pagesToPdf([makePage("blank")], { images: () => [placed({ jpeg: tinyJpeg(3) })] }));
		expect(text).toContain("/ColorSpace /DeviceRGB");
	});

	it("draws background images under the paper, elements above it, then text and ink", () => {
		const bg = placed({ layer: "background", x: 0, y: 0 });
		const el = placed({ jpeg: tinyJpeg(3), x: 5 });
		const page = withElements(makePage("grid", [makeStroke("pen", "#00ff00")]), [textEl("Hi")]);
		const text = bin(pagesToPdf([page], { images: () => [el, bg] }));
		const content = text.match(/stream\n([\s\S]*?)\nendstream/)![1]!;
		const order = [
			content.indexOf("q 100 0 0 -50 0 50 cm"), // background
			content.search(/ S\n/), // paper
			content.indexOf("q 100 0 0 -50 5 70 cm"), // image element
			content.indexOf("BT\n"), // text
			content.indexOf("0 1 0 rg"), // ink
		];
		expect(order.every((v) => v > 0)).toBe(true);
		expect(order).toEqual(order.slice().sort((a, b) => a - b));
	});

	it("paper: false still draws the images", () => {
		const text = bin(pagesToPdf([makePage("grid")], { paper: false, images: () => [placed()] }));
		expect(text).toContain(" Do Q");
	});
});

describe("pagesToPdf text elements", () => {
	it("draws text with Helvetica /F1, wrapped, in the element colour", () => {
		const long = "The quick brown fox jumps over the lazy dog and keeps running";
		const text = bin(pagesToPdf([withElements(makePage("blank"), [textEl(long)])]));
		expect(text).toContain("/BaseFont /Helvetica /Encoding /WinAnsiEncoding");
		expect(text).toMatch(/\/Font << \/F1 \d+ 0 R >>/);
		const content = text.match(/stream\n([\s\S]*?)\nendstream/)![1]!;
		expect(content).toContain("BT\n/F1 12 Tf\n1 0 0 rg");
		expect(content).toContain("\nET");
		const lines = [...content.matchAll(/ Tm \((.*)\) Tj/g)].map((m) => m[1]!);
		expect(lines.length).toBeGreaterThan(2);
		expect(lines.join(" ")).toBe(long);
		for (const l of lines) expect(helveticaWidth(l, 12)).toBeLessThanOrEqual(120);
		// Baselines are 1.25 x font size apart; the negative d of the text matrix keeps glyphs upright in y-down space.
		const ys = [...content.matchAll(/1 0 0 -1 50 ([\d.]+) Tm/g)].map((m) => Number(m[1]));
		expect(ys[0]).toBeCloseTo(100 + 12 * 0.88, 1);
		expect(ys[1]! - ys[0]!).toBeCloseTo(15, 1);
	});

	it("honours newlines, escapes delimiters and replaces characters outside WinAnsi", () => {
		const text = bin(pagesToPdf([withElements(makePage("blank"), [textEl("a (b) \\ é € 日\nsecond")])]));
		expect(text).toContain("(a \\(b\\) \\\\ \\351 \\200 ?) Tj");
		expect(text).toContain("(second) Tj");
	});

	it("has no font resource without text", () => {
		const text = bin(pagesToPdf([makePage("grid", [makeStroke()]), withElements(makePage("blank"), [textEl("")])]));
		expect(text).not.toContain("Helvetica");
		expect(text).not.toContain("/Font");
		expect(text).not.toContain("BT");
	});

	it("shares one font object between pages", () => {
		const pages = [withElements(makePage("blank"), [textEl("a")]), withElements(makePage("blank"), [textEl("b")])];
		const text = bin(pagesToPdf(pages));
		expect(text.match(/\/BaseFont \/Helvetica/g)).toHaveLength(1);
		expect(text.match(/\/Font << \/F1/g)).toHaveLength(2);
	});

	it("ignores image elements of the model (images come from options.images)", () => {
		const img: ImageElement = { id: "i", type: "image", asset: "x", x: 0, y: 0, width: 10, height: 10, rotation: 0 };
		const text = bin(pagesToPdf([withElements(makePage("blank"), [img])]));
		expect(text).not.toContain("/XObject");
	});
});

describe("pageToSvg images and text", () => {
	it("draws images (rotated around the centre) and escapes the href", () => {
		const svg = pageToSvg(makePage("grid"), {
			images: () => [
				{ href: 'data:image/png;base64,AAA"', x: 10, y: 20, width: 100, height: 50, rotation: Math.PI / 2 },
				{ href: "bg.png", x: 0, y: 0, width: 595, height: 842, layer: "background" },
			],
		});
		expect(svg).toContain('href="data:image/png;base64,AAA&quot;"');
		expect(svg).toContain('transform="rotate(90 60 45)"');
		expect(svg.indexOf('href="bg.png"')).toBeLessThan(svg.indexOf("<path"));
		expect(svg.indexOf("<path")).toBeLessThan(svg.indexOf("data:image/png"));
	});

	it("draws text elements as <text> with one <tspan> per wrapped line", () => {
		const text = "one two three four five six seven eight nine ten";
		const svg = pageToSvg(withElements(makePage("blank", [makeStroke()]), [textEl(text, { width: 60 }), textEl("")]));
		expect(svg.match(/<text /g)).toHaveLength(1);
		expect(svg).toContain('font-size="12"');
		expect(svg).toContain('fill="#ff0000"');
		const lines = [...svg.matchAll(/<tspan x="50" dy="([\d.]+)">([^<]*)<\/tspan>/g)];
		expect(lines.length).toBeGreaterThan(3);
		expect(lines[0]![1]).toBe("0");
		expect(lines[1]![1]).toBe("15");
		for (const l of lines) expect(l[2]!.length).toBeLessThanOrEqual(10); // 60 / (0.5 * 12)
		expect(lines.map((l) => l[2]).join(" ")).toBe(text);
		expect(svg.indexOf("<text ")).toBeLessThan(svg.lastIndexOf("<path"));
	});

	it("escapes text and drops invalid XML characters", () => {
		const svg = pageToSvg(withElements(makePage("blank"), [textEl("<b>&\u0001x", { width: 500 })]));
		expect(svg).toContain("&lt;b&gt;&amp;x");
		expect(svg).not.toContain("\u0001");
	});

	it("is unchanged without images or elements", () => {
		const page = makePage("grid", [makeStroke()]);
		expect(pageToSvg(page, { images: () => [] })).toBe(pageToSvg(page));
	});
});
