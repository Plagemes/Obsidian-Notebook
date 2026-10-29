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

/**
 * Boxes of pdf.js text items. `viewportTransform` maps PDF user space to the viewport (y down); each
 * item's `transform` places its baseline origin and carries the font size, and `width` is its advance
 * in user space. The box is the bounding box of the run's baseline-to-ascent parallelogram, so rotated
 * pages and rotated text get a box too. Items without text (marked content) or without a usable
 * transform are skipped.
 */
export function textBoxes(items: readonly unknown[], viewportTransform: unknown): TextBox[] {
	const vt: Matrix6 = isMatrix(viewportTransform) ? viewportTransform : [1, 0, 0, -1, 0, 0];
	const out: TextBox[] = [];
	for (const raw of items) {
		if (typeof raw !== "object" || raw === null) continue;
		const it = raw as { str?: unknown; transform?: unknown; width?: unknown };
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
		out.push({ str: it.str, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
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
	return content.items.map((b) => ({ str: b.str, x: rect.x + b.x * sx, y: rect.y + b.y * sy, width: b.width * sx, height: b.height * sy }));
}
