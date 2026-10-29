import type { Page, TextElement } from "../model/types";
import type { BBox } from "./hit-test";
import { PAPER_COLORS, paperPattern, type PaperLineKind } from "./paper";
import { HIGHLIGHTER_ALPHA, strokePath } from "./stroke-shape";

/** Line widths of the paper pattern, pt. Shared with the PDF exporter. */
export const PAPER_LINE_WIDTH: Readonly<Record<PaperLineKind, number>> = { minor: 0.3, major: 0.5, margin: 0.5 };
/** Dot radius of dotted paper, pt. */
export const PAPER_DOT_RADIUS = 0.6;

const PT_TO_MM = 25.4 / 72;

const num = (v: number): string => {
	const r = Math.round(v * 100) / 100;
	return (Object.is(r, -0) ? 0 : r).toString();
};

/** Escapes a string for use inside a double-quoted XML attribute. */
export function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** An image to draw on an SVG page; `href` is usually a data: URI. Rotation in radians around the centre. */
export interface SvgPlacedImage {
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation?: number;
	/** "background" draws under the paper pattern, "element" (default) above it. */
	layer?: "background" | "element";
}

export interface SvgOptions {
	paper?: boolean;
	images?: (page: Page) => SvgPlacedImage[];
}

/** Line height of text elements as a multiple of the font size (same as the PDF export). */
const TEXT_LINE_HEIGHT = 1.25;
const TEXT_BASELINE = 0.88;
/** Average Helvetica/Arial glyph width as a fraction of the font size, for wrapping by character count. */
const AVG_CHAR_WIDTH = 0.5;

/**
 * Standalone SVG of one page. `width`/`height` are in mm (so it prints at real size), the viewBox
 * is in pt (the document unit). Output is deterministic: no ids, dates or random values.
 * Draw order: white page, background images, paper, image elements, text, ink.
 * Text elements are wrapped by character count (width / (0.5 * fontSize) characters per line, an
 * approximation of Helvetica: the real font metrics are only used by the PDF export).
 */
export function pageToSvg(page: Page, options: SvgOptions = {}): string {
	const { width, height } = page;
	const out: string[] = [];
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * PT_TO_MM)}mm" height="${num(height * PT_TO_MM)}mm" viewBox="0 0 ${num(width)} ${num(height)}">`,
	);
	out.push(`<rect width="${num(width)}" height="${num(height)}" fill="#ffffff"/>`);

	const images = options.images?.(page) ?? [];
	for (const img of images) if (img.layer === "background") out.push(imageTag(img));

	if (options.paper ?? true) {
		const whole: BBox = { minX: 0, minY: 0, maxX: width, maxY: height };
		const { lines, dots } = paperPattern(page, whole);
		for (const kind of ["minor", "major", "margin"] as const) {
			const d = lines
				.filter((l) => l.kind === kind)
				.map((l) => `M${num(l.x1)} ${num(l.y1)}L${num(l.x2)} ${num(l.y2)}`)
				.join("");
			if (d) {
				out.push(
					`<path d="${d}" fill="none" stroke="${PAPER_COLORS[kind]}" stroke-width="${PAPER_LINE_WIDTH[kind]}"/>`,
				);
			}
		}
		if (dots.length > 0) {
			const r = PAPER_DOT_RADIUS;
			const d = dots
				.map(([x, y]) => `M${num(x + r)} ${num(y)}a${r} ${r} 0 1 0 ${num(-2 * r)} 0a${r} ${r} 0 1 0 ${num(2 * r)} 0Z`)
				.join("");
			out.push(`<path d="${d}" fill="${PAPER_COLORS.dot}"/>`);
		}
	}

	for (const img of images) if (img.layer !== "background") out.push(imageTag(img));
	for (const el of page.elements ?? []) {
		if (el.type === "text") {
			const t = textTag(el);
			if (t) out.push(t);
		}
	}

	for (const stroke of page.strokes) {
		const d = strokePath(stroke.points, stroke.width, true, stroke.tool);
		if (!d) continue;
		const fill = escapeAttr(stroke.color);
		out.push(
			stroke.tool === "highlighter"
				? `<path d="${d}" fill="${fill}" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"/>`
				: `<path d="${d}" fill="${fill}"/>`,
		);
	}
	out.push("</svg>");
	return out.join("\n") + "\n";
}

function imageTag(img: SvgPlacedImage): string {
	const rot = img.rotation
		? ` transform="rotate(${num((img.rotation * 180) / Math.PI)} ${num(img.x + img.width / 2)} ${num(img.y + img.height / 2)})"`
		: "";
	return `<image href="${escapeAttr(img.href)}" x="${num(img.x)}" y="${num(img.y)}" width="${num(img.width)}" height="${num(img.height)}" preserveAspectRatio="none"${rot}/>`;
}

/** Greedy wrap by character count; newlines start a line, words longer than a line are split. */
function wrapByChars(text: string, maxChars: number): string[] {
	const lines: string[] = [];
	for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
		let line = "";
		for (const word of para.split(/ +/)) {
			let w = word;
			while (w.length > maxChars) {
				if (line) {
					lines.push(line);
					line = "";
				}
				lines.push(w.slice(0, maxChars));
				w = w.slice(maxChars);
			}
			if (line && line.length + 1 + w.length > maxChars) {
				lines.push(line);
				line = w;
			} else line = line ? `${line} ${w}` : w;
		}
		lines.push(line);
	}
	return lines;
}

/** Drops characters that are not valid in XML 1.0 (controls other than tab, LF, CR). */
function stripInvalidXml(text: string): string {
	let out = "";
	for (const ch of text) {
		const c = ch.codePointAt(0)!;
		if (c >= 32 || c === 9 || c === 10 || c === 13) out += ch;
	}
	return out;
}

function textTag(el: TextElement): string {
	const size = el.fontSize;
	if (!(size > 0) || el.text === "") return "";
	const maxChars = Math.max(1, Math.floor(el.width / (size * AVG_CHAR_WIDTH)));
	const tspans = wrapByChars(stripInvalidXml(el.text), maxChars).map((line, i) => {
		const dy = i === 0 ? 0 : num(size * TEXT_LINE_HEIGHT);
		return `<tspan x="${num(el.x)}" dy="${dy}">${escapeAttr(line)}</tspan>`;
	});
	return `<text x="${num(el.x)}" y="${num(el.y + size * TEXT_BASELINE)}" font-family="Helvetica, Arial, sans-serif" font-size="${num(size)}" fill="${escapeAttr(el.color)}">${tspans.join("")}</text>`;
}
