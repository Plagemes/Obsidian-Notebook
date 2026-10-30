import { BOX_LABEL_HEIGHT, MARKER_BADGE, markerRegion } from "../model/markers";
import type { BoxElement, EquationElement, MarkerElement, Page, TextElement } from "../model/types";
import { EQUATION_NUMBER_GAP, equationNumberLabel, equationNumbers } from "../model/math-elements";
import { graphScene, GRAPH_STYLE, type GraphScene } from "../math/graph-scene";
import type { Polygon } from "../math/outline";
import { equationOutline } from "./math-render";
import type { BBox } from "./hit-test";
import { BOX_COLORS, badgeColor, badgeFace, badgeIsSquare, boxLabelWidth, checkPoints, defaultBoxLabel, glyphSize, starPoints, type BoxLabel } from "./marker-render";
import { layerFlags, type ExportLayers } from "./export-layers";
import { PAPER_COLORS, paperPattern, type PaperLineKind } from "./paper";
import { HIGHLIGHTER_ALPHA, strokeSvgPath } from "./stroke-shape";

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
	/** v8 invisible ink: draw the page's hidden strokes (default false: they are the solutions). */
	hiddenInk?: boolean;
	/** v8: label of a structured box (default: the English kind name and the title). */
	boxLabel?: BoxLabel;
	/** v9: numbers of the numbered equations (default: counted on this page). */
	equationNumbers?: ReadonlyMap<string, number>;
	/** v9: outline of an equation without a cached one (default: one typeset this session, else its source as text). */
	equationOutline?: (el: EquationElement) => { polys: Polygon[]; sx: number; sy: number } | null;
	/** wave 0.9 (381): "ink" has no white sheet (transparent), PDF/picture background or paper; "background" has no ink. Default "both". */
	layers?: ExportLayers;
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
	const layers = layerFlags(options.layers);
	if (layers.background) out.push(`<rect width="${num(width)}" height="${num(height)}" fill="#ffffff"/>`);

	const images = options.images?.(page) ?? [];
	if (layers.background) for (const img of images) if (img.layer === "background") out.push(imageTag(img));

	if (layers.background && (options.paper ?? true)) {
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

	if (!layers.content) {
		out.push("</svg>");
		return out.join("\n") + "\n";
	}
	for (const img of images) if (img.layer !== "background") out.push(imageTag(img));
	// v9 graphs: clip paths are numbered in page order, so the output stays deterministic.
	let clip = 0;
	for (const el of page.elements ?? []) if (el.type === "graph") out.push(graphTag(graphScene(el), `nb-graph-${++clip}`));
	const boxLabel = options.boxLabel ?? ((b: BoxElement) => defaultBoxLabel(b));
	for (const el of page.elements ?? []) if (el.type === "box") out.push(boxTag(el, boxLabel(el)));
	const numbers = options.equationNumbers ?? equationNumbers([page]);
	const outlineOf = options.equationOutline ?? equationOutline;
	for (const el of page.elements ?? []) if (el.type === "equation") out.push(equationTag(el, numbers.get(el.id), outlineOf(el)));
	for (const el of page.elements ?? []) {
		if (el.type === "text") {
			const t = textTag(el);
			if (t) out.push(t);
		}
	}

	for (const stroke of page.strokes) {
		if (stroke.hidden && !options.hiddenInk) continue;
		const d = strokeSvgPath(stroke);
		if (!d) continue;
		const fill = escapeAttr(stroke.color);
		out.push(
			stroke.tool === "highlighter"
				? `<path d="${d}" fill="${fill}" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"/>`
				: `<path d="${d}" fill="${fill}"/>`,
		);
	}
	for (const el of page.elements ?? []) if (el.type === "marker") out.push(markerTag(el));
	out.push("</svg>");
	return out.join("\n") + "\n";
}

const pointsAttr = (pts: ReadonlyArray<readonly [number, number]>): string => pts.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");

const pathOf = (pts: ReadonlyArray<readonly [number, number]>, close: boolean): string =>
	pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${num(x)} ${num(y)}`).join("") + (close ? "Z" : "");

/** Baseline of an anchored scene text (the same approximation as the PDF export). */
function sceneBaseline(y: number, size: number, baseline: "top" | "middle" | "bottom"): number {
	return baseline === "top" ? y + size * 0.76 : baseline === "middle" ? y + size * 0.35 : y - size * 0.21;
}

/** v9 graph: the scene as vector paths and text, clipped to the frame. */
function graphTag(s: GraphScene, clipId: string): string {
	const S = GRAPH_STYLE;
	const f = s.frame;
	const rect = `x="${num(f.x)}" y="${num(f.y)}" width="${num(f.width)}" height="${num(f.height)}"`;
	const out: string[] = [`<g>`, `<clipPath id="${clipId}"><rect ${rect}/></clipPath>`, `<rect ${rect} fill="${S.background}"/>`, `<g clip-path="url(#${clipId})" stroke-linecap="round" stroke-linejoin="round">`];
	const lines = (list: GraphScene["grid"], color: string, width: number) => {
		if (list.length === 0) return;
		out.push(`<path d="${list.map((l) => `M${num(l.x1)} ${num(l.y1)}L${num(l.x2)} ${num(l.y2)}`).join("")}" fill="none" stroke="${color}" stroke-width="${num(width)}"/>`);
	};
	lines(s.grid, S.grid, S.gridWidth);
	lines(s.axes, S.axis, S.axisWidth);
	for (const a of s.areas) out.push(`<path d="${a.polygons.map((p) => pathOf(p, true)).join("")}" fill="${escapeAttr(a.color)}" fill-opacity="${S.areaAlpha}"/>`);
	const curve = (c: GraphScene["curves"][number]) => {
		const d = c.lines.filter((l) => l.length > 1).map((l) => pathOf(l, false)).join("");
		if (!d) return;
		const dash = c.dash ? ` stroke-dasharray="${c.dash.map(num).join(" ")}"` : "";
		out.push(`<path d="${d}" fill="none" stroke="${escapeAttr(c.color)}" stroke-width="${num(c.width)}"${dash}/>`);
	};
	for (const c of s.curves) curve(c);
	for (const p of s.points) out.push(`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${num(S.pointRadius)}" fill="${escapeAttr(p.color)}"/>`);
	for (const p of s.panels) out.push(`<rect x="${num(p.x)}" y="${num(p.y)}" width="${num(p.width)}" height="${num(p.height)}" fill="${S.panel}" stroke="${S.panelBorder}" stroke-width="0.5"/>`);
	for (const c of s.overlay) curve(c);
	for (const t of s.texts) {
		const anchor = t.align === "left" ? "start" : t.align === "right" ? "end" : "middle";
		out.push(`<text x="${num(t.x)}" y="${num(sceneBaseline(t.y, t.size, t.baseline))}" font-family="Helvetica, Arial, sans-serif" font-size="${num(t.size)}" text-anchor="${anchor}" fill="${escapeAttr(t.color)}">${escapeAttr(t.text)}</text>`);
	}
	out.push("</g>", `<rect ${rect} fill="none" stroke="${S.border}" stroke-width="${num(S.borderWidth)}"/>`, "</g>");
	return out.join("\n");
}

/** v9 equation: its outline filled with the even-odd rule (the LaTeX source as text when it has none), then its number. */
function equationTag(el: EquationElement, n: number | undefined, o: { polys: Polygon[]; sx: number; sy: number } | null): string {
	const parts: string[] = [];
	const color = escapeAttr(el.color);
	if (o && o.polys.length > 0) {
		const d = o.polys.map((p) => pathOf(p.map(([x, y]): [number, number] => [el.x + x * o.sx, el.y + y * o.sy]), true)).join("");
		parts.push(`<path d="${d}" fill="${color}" fill-rule="evenodd"/>`);
	} else {
		const size = Math.max(4, Math.min(el.fontSize, el.height) * 0.8);
		parts.push(`<text x="${num(el.x + 2)}" y="${num(el.y + el.height / 2 + size * 0.35)}" font-family="monospace" font-size="${num(size)}" fill="${color}">${escapeAttr(el.latex.replace(/\s+/g, " "))}</text>`);
	}
	if (n !== undefined) {
		parts.push(`<text x="${num(el.x + el.width + el.fontSize * EQUATION_NUMBER_GAP)}" y="${num(el.y + el.height / 2 + el.fontSize * 0.35)}" font-family="serif" font-size="${num(el.fontSize)}" fill="${color}">${escapeAttr(equationNumberLabel(n))}</text>`);
	}
	return parts.join("\n");
}

/** v8 marker: dashed region, badge and glyph, as on the canvas (marker-render.ts). Above the ink. */
function markerTag(m: MarkerElement): string {
	const color = escapeAttr(badgeColor(m));
	const s = MARKER_BADGE;
	const parts: string[] = [];
	const region = markerRegion(m);
	if (region) {
		parts.push(`<rect x="${num(region.x)}" y="${num(region.y)}" width="${num(region.width)}" height="${num(region.height)}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 2" stroke-opacity="0.75"/>`);
	}
	parts.push(badgeIsSquare(m)
		? `<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(s)}" height="${num(s)}" rx="${num(s * 0.22)}" fill="${color}" stroke="#ffffff" stroke-width="0.8"/>`
		: `<circle cx="${num(m.x + s / 2)}" cy="${num(m.y + s / 2)}" r="${num(s / 2)}" fill="${color}" stroke="#ffffff" stroke-width="0.8"/>`);
	const face = badgeFace(m);
	if (face.kind === "star") parts.push(`<polygon points="${pointsAttr(starPoints(m.x + s / 2, m.y + s / 2 + 0.3, s * 0.36))}" fill="#ffffff"/>`);
	else if (face.kind === "check") {
		parts.push(`<polyline points="${pointsAttr(checkPoints(m.x, m.y, s))}" fill="none" stroke="#ffffff" stroke-width="${num(s * 0.13)}" stroke-linecap="round" stroke-linejoin="round"/>`);
	} else {
		const size = glyphSize(face.text);
		parts.push(`<text x="${num(m.x + s / 2)}" y="${num(m.y + s / 2 + size * 0.36)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="${num(size)}" fill="#ffffff">${escapeAttr(face.text)}</text>`);
	}
	return `<g>${parts.join("")}</g>`;
}

/** v8 structured box: frame and label tab (under the ink). */
function boxTag(b: BoxElement, label: string): string {
	const color = escapeAttr(BOX_COLORS[b.kind]);
	const w = boxLabelWidth(b, label);
	const size = BOX_LABEL_HEIGHT * 0.62;
	return `<g><rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" fill="none" stroke="${color}" stroke-width="1.2"/>`
		+ `<rect x="${num(b.x)}" y="${num(b.y - BOX_LABEL_HEIGHT)}" width="${num(w)}" height="${num(BOX_LABEL_HEIGHT)}" fill="${color}"/>`
		+ `<text x="${num(b.x + 4)}" y="${num(b.y - BOX_LABEL_HEIGHT / 2 + size * 0.36)}" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="${num(size)}" fill="#ffffff" textLength="${num(Math.max(1, w - 8))}" lengthAdjust="spacingAndGlyphs">${escapeAttr(stripInvalidXml(label))}</text></g>`;
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
