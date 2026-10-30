import { BOX_LABEL_HEIGHT, MARKER_BADGE, markerRegion } from "../model/markers";
import { RENDER_INK, type BoxElement, type MarkerElement, type Page, type Stroke, type TextElement } from "../model/types";
import type { BBox } from "./hit-test";
import { PAPER_DOT_RADIUS, PAPER_LINE_WIDTH } from "./export-svg";
import { PAPER_COLORS, paperPattern, type PaperLineKind } from "./paper";
import { inkPath, type PathSink } from "./ink-geometry";
import { BOX_COLORS, badgeColor, badgeFace, badgeIsSquare, boxLabelWidth, checkPoints, defaultBoxLabel, glyphSize, starPoints, type BoxLabel } from "./marker-render";
import { HIGHLIGHTER_ALPHA, strokeOutline } from "./stroke-shape";
import { layerFlags, type ExportLayers, type LayerFlags } from "./export-layers";
import { helveticaCodeWidth, toWinAnsi, wrapHelvetica } from "../pdf/helvetica";

/**
 * An image placed on a page, in page coordinates (pt, origin top-left, y down). `jpeg` is a
 * complete baseline/progressive JPEG file; `pixelWidth`/`pixelHeight` are its pixel size.
 * `rotation` is in radians, clockwise on screen, around the centre of the box.
 * The same `Uint8Array` instance used on several pages/places is embedded once.
 */
export interface PdfPlacedImage {
	jpeg: Uint8Array;
	pixelWidth: number;
	pixelHeight: number;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation?: number;
	/**
	 * "background" draws under the paper pattern (a rasterised PDF page); "element" (default) draws
	 * above it, in the order returned.
	 */
	layer?: "background" | "element";
}

export interface PdfOptions {
	paper?: boolean;
	title?: string;
	/** Images of a page (PDF background and image elements). */
	images?: (page: Page) => PdfPlacedImage[];
	/** v8 invisible ink: draw the hidden strokes of a page (default: never; they are the solutions). */
	hiddenInk?: boolean | ((page: Page) => boolean);
	/** v8: label of a structured box (default: the English kind name and the title). */
	boxLabel?: BoxLabel;
	/** wave 0.9 (381): "ink" leaves out the sheet, the PDF/picture background and the paper; "background" leaves out the ink. Default "both". */
	layers?: ExportLayers;
}

/** Line height of text elements, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25;
/** Baseline of the first text line below the top of the box, as a multiple of the font size. */
const TEXT_BASELINE = 0.88;

const enc = new TextEncoder();

/**
 * Minimal PDF 1.4 writer (no dependencies, browser-safe).
 *
 * One PDF page per notebook page; the PDF user unit (1/72 in) is our unit (pt), so MediaBox is the
 * page size as is. Content streams are written uncompressed (no Flate: no dependency, trivially
 * verifiable) and strokes are cubic Bézier outlines, so a page with a lot of ink is several times
 * larger than the same page compressed by a regular PDF producer (roughly 100-200 bytes per
 * stroke point). The file is assembled from byte chunks (JPEG data is binary); content streams and
 * dictionaries are ASCII, so xref offsets are exact byte offsets.
 *
 * Draw order: white page, background images, paper, image elements, text elements, ink. Text uses the
 * standard Helvetica font (not embedded), WinAnsi-encoded; characters outside WinAnsi become "?".
 */
export function pagesToPdf(pages: readonly Page[], options: PdfOptions = {}): Uint8Array {
	const withPaper = options.paper ?? true;
	// Objects are numbered in allocation order; 1 catalog, 2 page tree, 3 info.
	const objects: Uint8Array[][] = [];
	const alloc = (): number => {
		objects.push([]);
		return objects.length;
	};
	const setObject = (n: number, ...chunks: Array<string | Uint8Array>): void => {
		objects[n - 1] = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
	};

	const catalog = alloc();
	const tree = alloc();
	const info = alloc();
	const title = options.title !== undefined ? `/Title ${pdfString(options.title)} ` : "";
	setObject(info, `<< ${title}/Producer (Notebook) >>`);

	let fontObj = 0;
	const getFont = (): number => {
		if (!fontObj) {
			fontObj = alloc();
			setObject(fontObj, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
		}
		return fontObj;
	};
	const imageObjs = new Map<Uint8Array, number>();
	const getImage = (img: PdfPlacedImage): number => {
		let n = imageObjs.get(img.jpeg);
		if (n === undefined) {
			n = alloc();
			imageObjs.set(img.jpeg, n);
			const comps = jpegComponents(img.jpeg);
			// Adobe CMYK JPEGs store inverted values, hence /Decode.
			const csEntry =
				comps === 1 ? "/ColorSpace /DeviceGray" : comps === 4 ? "/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/ColorSpace /DeviceRGB";
			setObject(
				n,
				`<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(img.pixelWidth))} /Height ${Math.max(1, Math.round(img.pixelHeight))} ${csEntry} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
				img.jpeg,
				"\nendstream",
			);
		}
		return n;
	};

	const pageObjs: number[] = [];
	for (const page of pages) {
		const pageObj = alloc();
		const contentObj = alloc();
		pageObjs.push(pageObj);
		const res = { xobjects: new Map<string, number>(), font: false, highlighter: false };
		const hidden = typeof options.hiddenInk === "function" ? options.hiddenInk(page) : !!options.hiddenInk;
		const content = pageContent(page, withPaper, options.images?.(page) ?? [], getImage, res, { hidden, boxLabel: options.boxLabel ?? ((b) => defaultBoxLabel(b)), layers: layerFlags(options.layers) });
		const parts: string[] = [];
		if (res.highlighter) parts.push(`/ExtGState << /GS1 << /Type /ExtGState /ca ${HIGHLIGHTER_ALPHA} /BM /Multiply >> >>`);
		if (res.xobjects.size > 0) {
			parts.push(`/XObject << ${[...res.xobjects].map(([name, n]) => `/${name} ${n} 0 R`).join(" ")} >>`);
		}
		if (res.font) parts.push(`/Font << /F1 ${getFont()} 0 R >>`);
		const resources = `<< ${parts.join(" ")}${parts.length ? " " : ""}>>`;
		setObject(
			pageObj,
			`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentObj} 0 R /Resources ${resources} >>`,
		);
		const body = enc.encode(content);
		setObject(contentObj, `<< /Length ${body.length} >>\nstream\n`, body, "\nendstream");
	}
	setObject(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
	setObject(tree, `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`);

	const chunks: Uint8Array[] = [];
	let length = 0;
	const push = (c: Uint8Array | string) => {
		const b = typeof c === "string" ? enc.encode(c) : c;
		chunks.push(b);
		length += b.length;
	};
	push("%PDF-1.4\n");
	// Binary marker comment: tells transfer tools the file has bytes above 127.
	push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(length);
		push(`${i + 1} 0 obj\n`);
		for (const c of body) push(c);
		push("\nendobj\n");
	});
	const xrefAt = length;
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
	xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	push(xref);

	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/** Number of colour components declared by the first SOF marker of a JPEG (3 if it cannot be found). */
function jpegComponents(jpeg: Uint8Array): number {
	let i = 2;
	while (i + 9 < jpeg.length) {
		if (jpeg[i] !== 0xff) {
			i++;
			continue;
		}
		const m = jpeg[i + 1]!;
		if (m === 0xff) {
			i++;
			continue;
		}
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return jpeg[i + 9] ?? 3;
		if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0x00) {
			i += 2;
			continue;
		}
		i += 2 + (((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0));
	}
	return 3;
}

/** Fixed-point number with `digits` decimals, no exponent (for matrix entries). */
function fix(v: number, digits: number): string {
	if (!Number.isFinite(v)) return "0";
	const f = 10 ** digits;
	const r = Math.round(v * f) / f;
	return Object.is(r, -0) ? "0" : r.toString();
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

interface PageResources {
	xobjects: Map<string, number>;
	font: boolean;
	highlighter: boolean;
}

function pageContent(
	page: Page,
	withPaper: boolean,
	images: readonly PdfPlacedImage[],
	imageObj: (img: PdfPlacedImage) => number,
	res: PageResources,
	v8: { hidden: boolean; boxLabel: BoxLabel; layers?: LayerFlags } = { hidden: false, boxLabel: (b) => defaultBoxLabel(b) },
): string {
	const layers = v8.layers ?? { background: true, content: true };
	const ops: string[] = [];
	ops.push(`1 0 0 -1 0 ${num(page.height)} cm`);
	if (layers.background) ops.push(`1 1 1 rg 0 0 ${num(page.width)} ${num(page.height)} re f`);
	const draw = (img: PdfPlacedImage) => {
		const n = imageObj(img);
		const name = `Im${n}`;
		res.xobjects.set(name, n);
		ops.push(imageOps(img, name));
	};
	if (layers.background) for (const img of images) if (img.layer === "background") draw(img);
	if (layers.background && withPaper) ops.push(...paperOps(page));
	if (!layers.content) return ops.join("\n");
	for (const img of images) if (img.layer !== "background") draw(img);
	for (const el of page.elements ?? []) {
		if (el.type !== "box") continue;
		res.font = true;
		ops.push(boxOps(el, v8.boxLabel(el)));
	}
	for (const el of page.elements ?? []) {
		if (el.type !== "text") continue;
		const op = textOps(el);
		if (op) {
			res.font = true;
			ops.push(op);
		}
	}
	for (const stroke of page.strokes) {
		if (stroke.hidden && !v8.hidden) continue;
		const op = strokeOps(stroke);
		if (op) {
			if (stroke.tool === "highlighter") res.highlighter = true;
			ops.push(op);
		}
	}
	for (const el of page.elements ?? []) {
		if (el.type !== "marker") continue;
		const op = markerOps(el);
		if (op.font) res.font = true;
		ops.push(op.ops);
	}
	return ops.join("\n");
}

/** Polygon (or open polyline) path. */
function polyOps(points: ReadonlyArray<readonly [number, number]>, close = true): string {
	return points.map(([x, y], i) => `${num(x)} ${num(y)} ${i === 0 ? "m" : "l"}`).join(" ") + (close ? " h" : "");
}

/** Circle as four cubic Béziers. */
function circleOps(cx: number, cy: number, r: number): string {
	const k = 0.5523 * r;
	return [
		`${num(cx + r)} ${num(cy)} m`,
		`${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c`,
		`${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c`,
		`${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c`,
		`${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c h`,
	].join(" ");
}

/** One line of Helvetica text with its left end at (x, baseline), cut to `maxWidth`. */
function labelOps(text: string, x: number, baseline: number, size: number, maxWidth: number, color: string): string {
	const codes: number[] = [];
	let w = 0;
	for (const c of toWinAnsi(text)) {
		const cw = helveticaCodeWidth(c, size);
		if (w + cw > maxWidth) break;
		codes.push(c);
		w += cw;
	}
	if (codes.length === 0) return "";
	return `BT /F1 ${num(size)} Tf ${rgb(color)} rg 1 0 0 -1 ${num(x)} ${num(baseline)} Tm ${winAnsiLiteral(codes)} Tj ET`;
}

/** v8 marker: dashed region, badge and glyph, as on the canvas (marker-render.ts). Above the ink. */
function markerOps(m: MarkerElement): { ops: string; font: boolean } {
	const out: string[] = ["q"];
	const color = badgeColor(m);
	const region = markerRegion(m);
	if (region) out.push(`${rgb(color)} RG 1 w [3 2] 0 d ${num(region.x)} ${num(region.y)} ${num(region.width)} ${num(region.height)} re S [] 0 d`);
	const s = MARKER_BADGE;
	out.push(`${rgb(color)} rg 1 1 1 RG 0.8 w`);
	out.push(badgeIsSquare(m) ? `${num(m.x)} ${num(m.y)} ${num(s)} ${num(s)} re B` : `${circleOps(m.x + s / 2, m.y + s / 2, s / 2)} B`);
	const face = badgeFace(m);
	let font = false;
	if (face.kind === "star") out.push(`1 1 1 rg ${polyOps(starPoints(m.x + s / 2, m.y + s / 2 + 0.3, s * 0.36))} f`);
	else if (face.kind === "check") out.push(`1 1 1 RG ${num(s * 0.13)} w 1 J 1 j ${polyOps(checkPoints(m.x, m.y, s), false)} S`);
	else {
		const size = glyphSize(face.text);
		const width = toWinAnsi(face.text).reduce((a, c) => a + helveticaCodeWidth(c, size), 0);
		const op = labelOps(face.text, m.x + (s - width) / 2, m.y + s / 2 + size * 0.36, size, s, "#ffffff");
		if (op) {
			out.push(op);
			font = true;
		}
	}
	out.push("Q");
	return { ops: out.join("\n"), font };
}

/** v8 structured box: frame and label tab (under the ink). */
function boxOps(b: BoxElement, label: string): string {
	const color = BOX_COLORS[b.kind];
	const w = boxLabelWidth(b, label);
	const size = BOX_LABEL_HEIGHT * 0.62;
	return [
		"q",
		`${rgb(color)} RG 1.2 w ${num(b.x)} ${num(b.y)} ${num(b.width)} ${num(b.height)} re S`,
		`${rgb(color)} rg ${num(b.x)} ${num(b.y - BOX_LABEL_HEIGHT)} ${num(w)} ${num(BOX_LABEL_HEIGHT)} re f`,
		labelOps(label, b.x + 4, b.y - BOX_LABEL_HEIGHT / 2 + size * 0.36, size, w - 8, "#ffffff"),
		"Q",
	].filter(Boolean).join("\n");
}

/**
 * Draws image XObject `name` into the box (x, y, width, height), optionally rotated. The content
 * stream is in y-down page coordinates, where a PDF image (unit square, y up) would come out
 * upside down, so the matrix flips it with a negative height.
 */
function imageOps(img: PdfPlacedImage, name: string): string {
	const { x, y, width: w, height: h } = img;
	const rot = img.rotation ?? 0;
	if (!rot) return `q ${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm /${name} Do Q`;
	const cos = Math.cos(rot), sin = Math.sin(rot);
	const cx = x + w / 2, cy = y + h / 2;
	return [
		"q",
		`1 0 0 1 ${num(cx)} ${num(cy)} cm`,
		`${fix(cos, 6)} ${fix(sin, 6)} ${fix(-sin, 6)} ${fix(cos, 6)} 0 0 cm`,
		`${num(w)} 0 0 ${num(-h)} ${num(-w / 2)} ${num(h / 2)} cm`,
		`/${name} Do`,
		"Q",
	].join("\n");
}

/** PDF literal string of WinAnsi codes: printable ASCII as is, everything else as octal escapes. */
function winAnsiLiteral(codes: readonly number[]): string {
	let s = "(";
	for (const c of codes) {
		if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c);
		else if (c >= 32 && c <= 126) s += String.fromCharCode(c);
		else s += "\\" + c.toString(8).padStart(3, "0");
	}
	return s + ")";
}

/** A text element: wrapped to its width with Helvetica metrics, one `Tm`/`Tj` per line. */
function textOps(el: TextElement): string {
	const size = el.fontSize;
	if (!(size > 0) || el.text === "") return "";
	const lines = wrapHelvetica(el.text, size, Math.max(el.width, 1));
	const out = ["BT", `/F1 ${num(size)} Tf`, `${rgb(el.color)} rg`];
	lines.forEach((codes, i) => {
		if (codes.length === 0) return;
		const baseline = el.y + size * (TEXT_BASELINE + i * TEXT_LINE_HEIGHT);
		// The page is y-down: a negative d flips the glyphs upright again.
		out.push(`1 0 0 -1 ${num(el.x)} ${num(baseline)} Tm ${winAnsiLiteral(codes)} Tj`);
	});
	out.push("ET");
	return out.join("\n");
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

/** PDF path operators; full circles as four cubic Béziers in the positive-angle direction (like canvas arc). */
class PdfPathSink implements PathSink {
	readonly parts: string[] = [];
	moveTo(x: number, y: number): void {
		this.parts.push(`${num(x)} ${num(y)} m`);
	}
	lineTo(x: number, y: number): void {
		this.parts.push(`${num(x)} ${num(y)} l`);
	}
	arc(x: number, y: number, r: number): void {
		const c = r * 0.5522847498;
		this.parts.push(
			`${num(x + r)} ${num(y + c)} ${num(x + c)} ${num(y + r)} ${num(x)} ${num(y + r)} c`,
			`${num(x - c)} ${num(y + r)} ${num(x - r)} ${num(y + c)} ${num(x - r)} ${num(y)} c`,
			`${num(x - r)} ${num(y - c)} ${num(x - c)} ${num(y - r)} ${num(x)} ${num(y - r)} c`,
			`${num(x + c)} ${num(y - r)} ${num(x + r)} ${num(y - c)} ${num(x + r)} ${num(y)} c`,
		);
	}
	closePath(): void {
		this.parts.push("h");
	}
}

function strokeOps(stroke: Stroke): string {
	if (stroke.render === RENDER_INK) {
		const sink = new PdfPathSink();
		inkPath(sink, stroke.points, stroke.width, stroke.tool);
		if (sink.parts.length === 0) return "";
		const body = `${rgb(stroke.color)} rg
${sink.parts.join(" ")} f`;
		return stroke.tool === "highlighter" ? `q
/GS1 gs
${body}
Q` : body;
	}
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
