import type { Page, Stroke } from "../model/types";
import type { BBox } from "./hit-test";
import { PAPER_DOT_RADIUS, PAPER_LINE_WIDTH } from "./export-svg";
import { PAPER_COLORS, paperPattern, type PaperLineKind } from "./paper";
import { HIGHLIGHTER_ALPHA, strokeOutline } from "./stroke-shape";

/**
 * Minimal PDF 1.4 writer (no dependencies, browser-safe).
 *
 * One PDF page per notebook page; the PDF user unit (1/72 in) is our unit (pt), so MediaBox is the
 * page size as is. Content streams are written uncompressed (no Flate: no dependency, trivially
 * verifiable) and strokes are cubic Bézier outlines, so a page with a lot of ink is several times
 * larger than the same page compressed by a regular PDF producer (roughly 100-200 bytes per
 * stroke point). Everything is ASCII, so string length equals byte length and xref offsets are exact.
 */
export function pagesToPdf(pages: readonly Page[], options: { paper?: boolean; title?: string } = {}): Uint8Array {
	const withPaper = options.paper ?? true;
	// Object numbers: 1 catalog, 2 page tree, 3 info, then (page, content) pairs.
	const objects: string[] = [];
	const pageObj = (i: number) => 4 + 2 * i;

	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
	const title = options.title !== undefined ? `/Title ${pdfString(options.title)} ` : "";
	objects.push(`<< ${title}/Producer (Notebook) >>`);

	pages.forEach((page, i) => {
		const content = pageContent(page, withPaper);
		const highlighter = page.strokes.some((s) => s.tool === "highlighter");
		const resources = highlighter
			? `<< /ExtGState << /GS1 << /Type /ExtGState /ca ${HIGHLIGHTER_ALPHA} /BM /Multiply >> >> >>`
			: "<< >>";
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${pageObj(i) + 1} 0 R /Resources ${resources} >>`,
		);
		objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	});

	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

/** Number with at most 2 decimals and never in exponent notation. */
function num(v: number): string {
	if (!Number.isFinite(v)) return "0";
	const r = Math.round(v * 100) / 100;
	return Object.is(r, -0) ? "0" : r.toString();
}

/** `#rrggbb` (or `#rgb`) to "r g b" in 0..1 with 3 decimals; anything else is black. */
function rgb(color: string): string {
	let h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
	if (!h) return "0 0 0";
	if (h.length === 3) h = h.replace(/./g, (c) => c + c);
	const hex = h;
	const c = (k: number) => {
		const v = Math.round((parseInt(hex.slice(k, k + 2), 16) / 255) * 1000) / 1000;
		return v.toString();
	};
	return `${c(0)} ${c(2)} ${c(4)}`;
}

/** PDF string: a literal for printable ASCII, UTF-16BE hex (with BOM) otherwise. */
function pdfString(s: string): string {
	if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => "\\" + c)})`;
	let hex = "FEFF";
	for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
	return `<${hex}>`;
}

function pageContent(page: Page, withPaper: boolean): string {
	const ops: string[] = [];
	ops.push(`1 0 0 -1 0 ${num(page.height)} cm`);
	ops.push(`1 1 1 rg 0 0 ${num(page.width)} ${num(page.height)} re f`);
	if (withPaper) ops.push(...paperOps(page));
	for (const stroke of page.strokes) {
		const op = strokeOps(stroke);
		if (op) ops.push(op);
	}
	return ops.join("\n");
}

function paperOps(page: Page): string[] {
	const whole: BBox = { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
	const { lines, dots } = paperPattern(page, whole);
	const ops: string[] = [];
	for (const kind of ["minor", "major", "margin"] as const satisfies readonly PaperLineKind[]) {
		const ofKind = lines.filter((l) => l.kind === kind);
		if (ofKind.length === 0) continue;
		ops.push(`${PAPER_LINE_WIDTH[kind]} w ${rgb(PAPER_COLORS[kind])} RG`);
		ops.push(ofKind.map((l) => `${num(l.x1)} ${num(l.y1)} m ${num(l.x2)} ${num(l.y2)} l`).join(" ") + " S");
	}
	if (dots.length > 0) {
		// Tiny filled squares (a circle would be four Béziers per dot).
		const side = PAPER_DOT_RADIUS * 2;
		ops.push(`${rgb(PAPER_COLORS.dot)} rg`);
		ops.push(dots.map(([x, y]) => `${num(x - side / 2)} ${num(y - side / 2)} ${side} ${side} re`).join(" ") + " f");
	}
	return ops;
}

function strokeOps(stroke: Stroke): string {
	const outline = strokeOutline(stroke.points, stroke.width, true, stroke.tool);
	const n = outline.length;
	if (n < 3) return "";
	const P = (i: number): [number, number] => [outline[i]![0]!, outline[i]![1]!];
	const [x0, y0] = P(0);
	const parts = [`${num(x0)} ${num(y0)} m`];
	let cx = x0, cy = y0;
	// Same construction as outlineToPath(): quadratics with control point P(i) ending at the
	// midpoint of P(i) and P(i+1), raised to cubics: c1 = p0 + 2/3 (q - p0), c2 = p + 2/3 (q - p).
	for (let i = 1; i <= n - 2; i++) {
		const [qx, qy] = P(i);
		const [bx, by] = P(i + 1);
		const ex = (qx + bx) / 2, ey = (qy + by) / 2;
		const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
		const c2x = ex + (2 / 3) * (qx - ex), c2y = ey + (2 / 3) * (qy - ey);
		parts.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(ex)} ${num(ey)} c`);
		cx = ex;
		cy = ey;
	}
	parts.push("h f");
	const body = `${rgb(stroke.color)} rg\n${parts.join(" ")}`;
	return stroke.tool === "highlighter" ? `q\n/GS1 gs\n${body}\nQ` : body;
}
