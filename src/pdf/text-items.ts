/**
 * Text of a PDF page as positioned boxes, from pdf.js `getTextContent()`. Pure: no pdf.js, DOM or
 * 'obsidian' import, so it is tested in Node.
 */

/** A run of text and its axis-aligned box, in viewport coordinates at scale 1 (pt, origin top-left). */
export interface TextBox {
	str: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** CSS font family of the run (from pdf.js `styles`), to measure the characters of the run. */
	font?: string;
}

/** Width of `text` set in `font` at any fixed size: only the ratios matter (the view measures with a canvas). */
export type TextMeasure = (text: string, font: string | undefined) => number;

/**
 * The share (0-1) of a run's width taken by its first `n` characters. With a `measure` the characters have their own
 * widths (as in the font the run is set in); without one, or when it gives nothing usable, they are all equal.
 */
export function prefixShare(box: TextBox, n: number, measure?: TextMeasure): number {
	const len = box.str.length;
	if (len === 0 || n <= 0) return 0;
	if (n >= len) return 1;
	if (measure) {
		const total = measure(box.str, box.font);
		const part = total > 0 ? measure(box.str.slice(0, n), box.font) : NaN;
		if (Number.isFinite(part)) return Math.min(1, Math.max(0, part / total));
	}
	return n / len;
}

/** The text of one PDF page: its size at scale 1 (pt) and its runs in content-stream order. */
export interface PageTextContent {
	width: number;
	height: number;
	items: TextBox[];
}

type Matrix6 = readonly [number, number, number, number, number, number];

function isMatrix(v: unknown): v is Matrix6 {
	return Array.isArray(v) && v.length >= 6 && v.slice(0, 6).every((n) => typeof n === "number" && Number.isFinite(n));
}

/** m1 × m2 for PDF matrices `[a, b, c, d, e, f]` (pdf.js `Util.transform`). */
function multiply(m1: Matrix6, m2: Matrix6): Matrix6 {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
	];
}

/** The font family of a run: `styles[fontName].fontFamily`, when pdf.js gave one. */
function fontFamilyOf(styles: unknown, fontName: unknown): string | undefined {
	if (typeof styles !== "object" || styles === null || typeof fontName !== "string") return undefined;
	const style = (styles as Record<string, unknown>)[fontName];
	const family = typeof style === "object" && style !== null ? (style as { fontFamily?: unknown }).fontFamily : undefined;
	return typeof family === "string" && family.length > 0 ? family : undefined;
}

/**
 * Boxes of pdf.js text items. `viewportTransform` maps PDF user space to the viewport (y down); each
 * item's `transform` places its baseline origin and carries the font size, and `width` is its advance
 * in user space. The box is the bounding box of the run's baseline-to-ascent parallelogram, so rotated
 * pages and rotated text get a box too. Items without text (marked content) or without a usable
 * transform are skipped. `styles` is pdf.js's `TextContent.styles` (font name to font family).
 */
export function textBoxes(items: readonly unknown[], viewportTransform: unknown, styles?: unknown): TextBox[] {
	const vt: Matrix6 = isMatrix(viewportTransform) ? viewportTransform : [1, 0, 0, -1, 0, 0];
	const out: TextBox[] = [];
	for (const raw of items) {
		if (typeof raw !== "object" || raw === null) continue;
		const it = raw as { str?: unknown; transform?: unknown; width?: unknown; fontName?: unknown };
		if (typeof it.str !== "string" || it.str.length === 0 || !isMatrix(it.transform)) continue;
		const m = multiply(vt, it.transform);
		const advance = typeof it.width === "number" && Number.isFinite(it.width) ? Math.abs(it.width) : 0;
		const fontX = Math.hypot(m[0], m[1]);
		// Direction of the baseline (unit) and the "up" vector (length = font size) in the viewport.
		const dir = fontX > 0 ? [m[0] / fontX, m[1] / fontX] : [1, 0];
		const scaleX = Math.hypot(vt[0], vt[1]) || 1;
		const ax = dir[0]! * advance * scaleX;
		const ay = dir[1]! * advance * scaleX;
		const ux = m[2];
		const uy = m[3];
		const xs = [m[4], m[4] + ax, m[4] + ux, m[4] + ax + ux];
		const ys = [m[5], m[5] + ay, m[5] + uy, m[5] + ay + uy];
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		const box: TextBox = { str: it.str, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
		const font = fontFamilyOf(styles, it.fontName);
		if (font) box.font = font;
		out.push(box);
	}
	return out;
}

/**
 * Text boxes moved from PDF viewport coordinates to the page: the PDF is drawn in `rect` (its box on the
 * page, see backgroundRect), scaled from its natural `width` × `height`.
 */
export function boxesOnPage(content: PageTextContent, rect: { x: number; y: number; width: number; height: number }): TextBox[] {
	const sx = content.width > 0 ? rect.width / content.width : 1;
	const sy = content.height > 0 ? rect.height / content.height : 1;
	return content.items.map((b) => {
		const box: TextBox = { str: b.str, x: rect.x + b.x * sx, y: rect.y + b.y * sy, width: b.width * sx, height: b.height * sy };
		if (b.font) box.font = b.font;
		return box;
	});
}
