import { orderedNotes, repliesOf } from "../model/comments";
import { BOX_LABEL_HEIGHT, MARKER_BADGE, markerRegion } from "../model/markers";
import { COMMENT_SKETCH_H, COMMENT_SKETCH_W, RENDER_INK, type BoxElement, type CheckboxElement, type EquationElement, type MarkerElement, type Page, type StickyElement, type Stroke, type TextElement } from "../model/types";
import { EQUATION_NUMBER_GAP, equationNumberLabel, equationNumbers } from "../model/math-elements";
import { graphScene, GRAPH_STYLE, type GraphScene, type SceneText } from "../math/graph-scene";
import { equationOutline } from "./math-render";
import { graphClips, strokeClip } from "./attach";
import { hiddenStickyInk, stickyColours } from "../model/sticky";
import { stickyShapes, stickyTextBox } from "./sticky-render";
import { checkboxPaths } from "./checkbox-render";
import type { Polygon } from "../math/outline";
import type { BBox } from "./hit-test";
import { PAPER_DOT_RADIUS, PAPER_LINE_WIDTH } from "./export-svg";
import { PAPER_COLORS, paperPattern, type PaperLineKind } from "./paper";
import { inkPath, type PathSink } from "./ink-geometry";
import { BOX_COLORS, badgeColor, badgeFace, badgeIsSquare, boxLabelWidth, checkPoints, defaultBoxLabel, glyphSize, starPoints, type BoxLabel } from "./marker-render";
import { HIGHLIGHTER_ALPHA, MARKER_ALPHA, strokeOutline } from "./stroke-shape";
import { layerFlags, type ExportLayers, type LayerFlags } from "./export-layers";
import { HEADER_COLOR_DAY, type HeaderLayout } from "./page-header";
import { helveticaCodeWidth, helveticaWidth, toWinAnsi, wrapHelvetica } from "../pdf/helvetica";
import { LINK_COLOR, lineRuns, linksInCodePoints, shownText } from "./link-text";
import { tileLabel, type SplitPlan } from "./export-tiles";

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
	/** v9: numbers of the numbered equations (default: counted over the exported pages). */
	equationNumbers?: ReadonlyMap<string, number>;
	/** v9: outline of an equation without a cached one (default: one typeset this session, else its source as text). */
	equationOutline?: (el: EquationElement) => { polys: Polygon[]; sx: number; sy: number } | null;
	/** wave 0.9 (381): "ink" leaves out the sheet, the PDF/picture background and the paper; "background" leaves out the ink. Default "both". */
	layers?: ExportLayers;
	/** 0.15 (#75): the automatic page header or footer of a page (null: none); drawn with the background layer. */
	header?: (page: Page) => HeaderLayout | null;
	/**
	 * 0.18 (#86): add the margin comments as notes. A page that has comments is made wider by a strip (`PDF_NOTES_STRIP`) on its right:
	 * each comment is outlined on the page, joined by a thin line to its note in the strip (author, time, text, replies, sketch).
	 * Absent: the pages are exported as they are.
	 */
	comments?: PdfCommentLabels;
	/**
	 * 0.18 (#178): the sheets a page is split into (null: the page is written as one PDF page, exactly as without this option).
	 * A split page is drawn once, as a form, and every sheet shows the part of it that its tile says, in reading order.
	 */
	split?: (page: Page) => SplitPlan | null;
}

/** The words of the margin notes (translated by the caller). */
export interface PdfCommentLabels {
	resolved: string;
	sketch: string;
	/** "+3 more comments", written at the end of the strip when the notes do not fit beside the page. */
	more: (n: number) => string;
	/** A time of a comment, as the reader's language writes it. */
	when: (ms: number) => string;
}

/** Width (pt) of the strip of margin notes beside a page that has comments. */
export const PDF_NOTES_STRIP = 190;

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
function* pdfSteps(pages: readonly Page[], options: PdfOptions): Generator<void, Uint8Array, void> {
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
	const numbers = options.equationNumbers ?? equationNumbers(pages);
	for (const page of pages) {
		const pageObj = alloc();
		const contentObj = alloc();
		pageObjs.push(pageObj);
		const res: PageResources = { xobjects: new Map<string, number>(), font: false, highlighter: false, area: false };
		const hidden = typeof options.hiddenInk === "function" ? options.hiddenInk(page) : !!options.hiddenInk;
		let content = pageContent(page, withPaper, options.images?.(page) ?? [], getImage, res, {
			hidden, boxLabel: options.boxLabel ?? ((b) => defaultBoxLabel(b)), layers: layerFlags(options.layers),
			numbers, outline: options.equationOutline ?? equationOutline, header: options.header?.(page) ?? null,
		});
		const plan = options.split?.(page) ?? null;
		// 0.18 (#86): the margin notes, in a strip to the right of the page (only when asked, and only for pages that have comments).
		// A page split into sheets (#178) leaves the strip out: the sheets show the page itself, not the room beside it.
		let stripped = false;
		const notes = options.comments && !(plan && plan.tiles.length > 0) && layerFlags(options.layers).content ? commentNotesOps(page, options.comments) : null;
		if (notes) {
			stripped = true;
			res.font = true;
			content += `\n${notes}`;
		}
		const parts: string[] = [];
		const states: string[] = [];
		if (res.highlighter) states.push(`/GS1 << /Type /ExtGState /ca ${HIGHLIGHTER_ALPHA} /BM /Multiply >>`);
		// Format v20: the marker is 85% opaque, source-over (the highlighter multiplies).
		if (res.marker) states.push(`/GS3 << /Type /ExtGState /ca ${MARKER_ALPHA} >>`);
		// v9: shaded areas of graphs.
		if (res.area) states.push(`/GS2 << /Type /ExtGState /ca ${GRAPH_STYLE.areaAlpha} >>`);
		if (states.length > 0) parts.push(`/ExtGState << ${states.join(" ")} >>`);
		if (res.xobjects.size > 0) {
			parts.push(`/XObject << ${[...res.xobjects].map(([name, n]) => `/${name} ${n} 0 R`).join(" ")} >>`);
		}
		if (res.font) parts.push(`/Font << /F1 ${getFont()} 0 R >>`);
		const resources = `<< ${parts.join(" ")}${parts.length ? " " : ""}>>`;
		if (plan && plan.tiles.length > 0) {
			// 0.18 (#178): one form holds the page; each sheet places the part of it its tile says, clipped to the tile.
			const formBody = enc.encode(content);
			const form = alloc();
			setObject(
				form,
				`<< /Type /XObject /Subtype /Form /BBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources ${resources} /Length ${formBody.length} >>\nstream\n`,
				formBody, "\nendstream",
			);
			const k = plan.scale;
			plan.tiles.forEach((tile, i) => {
				const sheetPage = i === 0 ? pageObj : alloc();
				const sheetContent = i === 0 ? contentObj : alloc();
				if (i > 0) pageObjs.push(sheetPage);
				const clipY = plan.sheetHeight - tile.oy - tile.height * k;
				const a = tile.ox - k * tile.x;
				const b = plan.sheetHeight - tile.oy + k * tile.y - k * page.height;
				const ops = [
					`q ${num(tile.ox)} ${num(clipY)} ${num(tile.width * k)} ${num(tile.height * k)} re W n`,
					`${fix(k, 5)} 0 0 ${fix(k, 5)} ${num(a)} ${num(b)} cm`, "/Pg Do", "Q",
				];
				let fonts = "";
				if (plan.pageNumbers) {
					const label = tileLabel(plan, i);
					ops.push(`BT /F1 9 Tf 0.35 g ${num((plan.sheetWidth - helveticaWidth(label, 9)) / 2)} 10 Td ${pdfString(label)} Tj ET`);
					fonts = ` /Font << /F1 ${getFont()} 0 R >>`;
				}
				setObject(
					sheetPage,
					`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(plan.sheetWidth)} ${num(plan.sheetHeight)}] /Contents ${sheetContent} 0 R /Resources << /XObject << /Pg ${form} 0 R >>${fonts} >> >>`,
				);
				const sheetBody = enc.encode(ops.join("\n"));
				setObject(sheetContent, `<< /Length ${sheetBody.length} >>\nstream\n`, sheetBody, "\nendstream");
			});
			yield;
			continue;
		}
		setObject(
			pageObj,
			`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(page.width + (stripped ? PDF_NOTES_STRIP : 0))} ${num(page.height)}] /Contents ${contentObj} 0 R /Resources ${resources} >>`,
		);
		const body = enc.encode(content);
		setObject(contentObj, `<< /Length ${body.length} >>\nstream\n`, body, "\nendstream");
		yield; // 0.17 (#23): where a caller may let the interface breathe between two pages
	}
	setObject(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
	setObject(tree, `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjs.length} >>`);

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

/** The PDF of `pages` (see `pdfSteps` above for the layout). Synchronous. */
export function pagesToPdf(pages: readonly Page[], options: PdfOptions = {}): Uint8Array {
	const steps = pdfSteps(pages, options);
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

/**
 * The same bytes as `pagesToPdf`, built page by page with `pause()` awaited between two pages, so a long notebook does
 * not hold the interface for the whole build (0.17 #23: the automatic PDF copy).
 */
export async function pagesToPdfYielding(pages: readonly Page[], options: PdfOptions, pause: () => Promise<void>): Promise<Uint8Array> {
	const steps = pdfSteps(pages, options);
	let step = steps.next();
	while (!step.done) {
		await pause();
		step = steps.next();
	}
	return step.value;
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
	/** Format v20: a marker stroke (ExtGState GS3). */
	marker?: boolean;
	/** v9: a graph shades an area (ExtGState GS2). */
	area?: boolean;
}

interface ElementOptions {
	hidden: boolean;
	boxLabel: BoxLabel;
	/** wave 0.9 (381): which layers are drawn. Equations and graphs are content (drawn with the ink, never with the background). */
	layers?: LayerFlags;
	header?: HeaderLayout | null;
	numbers?: ReadonlyMap<string, number>;
	outline?: (el: EquationElement) => { polys: Polygon[]; sx: number; sy: number } | null;
}

function pageContent(
	page: Page,
	withPaper: boolean,
	images: readonly PdfPlacedImage[],
	imageObj: (img: PdfPlacedImage) => number,
	res: PageResources,
	v8: ElementOptions = { hidden: false, boxLabel: (b) => defaultBoxLabel(b) },
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
	if (layers.background && v8.header) {
		res.font = true;
		ops.push(headerOps(v8.header));
	}
	if (!layers.content) return ops.join("\n");
	for (const img of images) if (img.layer !== "background") draw(img);
	for (const el of page.elements ?? []) {
		if (el.type !== "graph") continue;
		ops.push(graphOps(graphScene(el), res));
	}
	for (const el of page.elements ?? []) {
		if (el.type !== "box") continue;
		res.font = true;
		ops.push(boxOps(el, v8.boxLabel(el)));
	}
	// v15 sticky notes: between the boxes and the equations, as on screen. The ink a collapsed note keeps hidden is left out.
	for (const el of page.elements ?? []) {
		if (el.type !== "sticky") continue;
		const op = stickyOps(el);
		if (op.font) res.font = true;
		ops.push(op.ops);
	}
	const noteInk = hiddenStickyInk(page.elements);
	for (const el of page.elements ?? []) {
		if (el.type !== "equation") continue;
		ops.push(equationOps(el, v8.numbers?.get(el.id), (v8.outline ?? equationOutline)(el), res));
	}
	for (const el of page.elements ?? []) {
		if (el.type !== "text") continue;
		const op = textOps(el);
		if (op) {
			res.font = true;
			ops.push(op);
		}
	}
	const clips = graphClips(page.elements);
	for (const stroke of page.strokes) {
		if ((stroke.hidden && !v8.hidden) || noteInk?.has(stroke.id)) continue;
		const op = strokeOps(stroke);
		if (op) {
			if (stroke.tool === "highlighter") res.highlighter = true;
			if (stroke.tool === "marker") res.marker = true;
			// v9: ink bound to a graph is clipped to its frame, as on screen.
			const clip = strokeClip(stroke, clips);
			ops.push(clip ? `q ${num(clip.x)} ${num(clip.y)} ${num(clip.width)} ${num(clip.height)} re W n\n${op}\nQ` : op);
		}
	}
	for (const el of page.elements ?? []) {
		if (el.type !== "marker") continue;
		const op = markerOps(el);
		if (op.font) res.font = true;
		ops.push(op.ops);
	}
	// v17 checkboxes above the ink, like marker badges.
	for (const el of page.elements ?? []) if (el.type === "checkbox") ops.push(checkboxOps(el));
	return ops.join("\n");
}

/** Baseline of a scene text from its vertical anchor (Helvetica: ascent about 0.72 em, descent about 0.21 em). */
export function textBaselineY(t: Pick<SceneText, "y" | "size" | "baseline">): number {
	return t.baseline === "top" ? t.y + t.size * 0.76 : t.baseline === "middle" ? t.y + t.size * 0.35 : t.y - t.size * 0.21;
}

/** One line of Helvetica text anchored like a scene text. */
function anchoredTextOps(t: SceneText): string {
	const codes = toWinAnsi(t.text);
	if (codes.length === 0) return "";
	const width = codes.reduce((a, c) => a + helveticaCodeWidth(c, t.size), 0);
	const x = t.align === "left" ? t.x : t.align === "right" ? t.x - width : t.x - width / 2;
	return `BT /F1 ${num(t.size)} Tf ${rgb(t.color)} rg 1 0 0 -1 ${num(x)} ${num(textBaselineY(t))} Tm ${winAnsiLiteral(codes)} Tj ET`;
}

/** v9 graph: the scene as vector paths and Helvetica text, clipped to the frame. */
function graphOps(s: GraphScene, res: PageResources): string {
	const S = GRAPH_STYLE;
	const f = s.frame;
	const out: string[] = ["q", `1 1 1 rg ${num(f.x)} ${num(f.y)} ${num(f.width)} ${num(f.height)} re f`];
	out.push(`${num(f.x)} ${num(f.y)} ${num(f.width)} ${num(f.height)} re W n`, "1 J 1 j");
	const lines = (list: GraphScene["grid"], color: string, width: number) => {
		if (list.length === 0) return;
		out.push(`${rgb(color)} RG ${num(width)} w ${list.map((l) => `${num(l.x1)} ${num(l.y1)} m ${num(l.x2)} ${num(l.y2)} l`).join(" ")} S`);
	};
	lines(s.grid, S.grid, S.gridWidth);
	lines(s.axes, S.axis, S.axisWidth);
	for (const a of s.areas) {
		res.area = true;
		out.push(`q /GS2 gs ${rgb(a.color)} rg ${a.polygons.map((p) => polyOps(p)).join(" ")} f Q`);
	}
	const curve = (c: GraphScene["curves"][number]) => {
		const paths = c.lines.filter((l) => l.length > 1).map((l) => polyOps(l, false));
		if (paths.length === 0) return;
		out.push(`${rgb(c.color)} RG ${num(c.width)} w ${c.dash ? `[${c.dash.map(num).join(" ")}] 0 d` : "[] 0 d"} ${paths.join(" ")} S`);
	};
	for (const c of s.curves) curve(c);
	out.push("[] 0 d");
	for (const p of s.points) out.push(`${rgb(p.color)} rg ${circleOps(p.x, p.y, S.pointRadius)} f`);
	for (const p of s.panels) out.push(`1 1 1 rg ${rgb(S.panelBorder)} RG 0.5 w ${num(p.x)} ${num(p.y)} ${num(p.width)} ${num(p.height)} re B`);
	for (const c of s.overlay) curve(c);
	for (const t of s.texts) {
		const op = anchoredTextOps(t);
		if (op) {
			res.font = true;
			out.push(op);
		}
	}
	out.push("Q", `q ${rgb(S.border)} RG ${num(S.borderWidth)} w ${num(f.x)} ${num(f.y)} ${num(f.width)} ${num(f.height)} re S Q`);
	return out.join("\n");
}

/** v9 equation: its outline filled with the even-odd rule (the LaTeX source as text when it has none), then its number. */
function equationOps(el: EquationElement, n: number | undefined, o: { polys: Polygon[]; sx: number; sy: number } | null, res: PageResources): string {
	const out: string[] = ["q"];
	if (o && o.polys.length > 0) {
		out.push(`${rgb(el.color)} rg ${o.polys.map((p) => polyOps(p.map(([x, y]): [number, number] => [el.x + x * o.sx, el.y + y * o.sy]))).join(" ")} f*`);
	} else {
		const size = Math.max(4, Math.min(el.fontSize, el.height) * 0.8);
		const op = labelOps(el.latex.replace(/\s+/g, " "), el.x + 2, el.y + el.height / 2 + size * 0.35, size, Math.max(4, el.width - 4), el.color);
		if (op) {
			res.font = true;
			out.push(op);
		}
	}
	if (n !== undefined) {
		const op = labelOps(equationNumberLabel(n), el.x + el.width + el.fontSize * EQUATION_NUMBER_GAP, el.y + el.height / 2 + el.fontSize * 0.35, el.fontSize, el.fontSize * 6, el.color);
		if (op) {
			res.font = true;
			out.push(op);
		}
	}
	out.push("Q");
	return out.join("\n");
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

/**
 * v15 sticky note: its solid shapes (the translucent shadow is left out of a page on paper) and the typed text in Helvetica,
 * wrapped to the note's text box and clipped to it.
 */
function stickyOps(el: StickyElement): { ops: string; font: boolean } {
	const out: string[] = ["q"];
	for (const s of stickyShapes(el)) {
		if (s.alpha < 1) continue;
		if (s.kind === "rect") out.push(`${rgb(s.fill)} rg ${num(s.x)} ${num(s.y)} ${num(s.width)} ${num(s.height)} re f`);
		else out.push(`${rgb(s.fill)} rg ${polyOps(s.points)} f`);
	}
	let font = false;
	if (!el.collapsed && el.text) {
		const box = stickyTextBox(el);
		const size = el.fontSize;
		const lines = wrapHelvetica(el.text, size, box.width);
		out.push(`q ${num(box.x)} ${num(box.y)} ${num(box.width)} ${num(box.height)} re W n`, "BT", `/F1 ${num(size)} Tf`, `${rgb(stickyColours(el.color).text)} rg`);
		lines.forEach((codes, i) => {
			if (codes.length === 0) return;
			out.push(`1 0 0 -1 ${num(box.x)} ${num(box.y + size * (TEXT_BASELINE + i * TEXT_LINE_HEIGHT))} Tm ${winAnsiLiteral(codes)} Tj`);
		});
		out.push("ET", "Q");
		font = true;
	}
	out.push("Q");
	return { ops: out.join("\n"), font };
}

/**
 * 0.18 (#86): the margin notes of a page, in the strip to the right of it (the page is `PDF_NOTES_STRIP` wider). In page
 * coordinates (y down). Each comment is outlined on the page and joined by a thin line to its note, which sits level with the
 * region where it fits and is pushed down below the note before it where it does not; what does not fit above the bottom edge
 * is counted in one last line. Null when the page has no comments.
 */
function commentNotesOps(page: Page, labels: PdfCommentLabels): string | null {
	const notes = orderedNotes(page);
	if (notes.length === 0) return null;
	const x0 = page.width;
	const textX = x0 + 24;
	const textW = PDF_NOTES_STRIP - 32;
	const SIZE = 8;
	const LINE = 10;
	const out: string[] = ["q", "0.965 0.965 0.972 rg", `${num(x0)} 0 ${num(PDF_NOTES_STRIP)} ${num(page.height)} re f`, "0.8 0.8 0.85 RG 0.6 w", `${num(x0)} 0 m ${num(x0)} ${num(page.height)} l S`];
	const lines = (text: string, size: number, width: number, max: number): number[][] => {
		const wrapped = wrapHelvetica(text, size, width);
		if (wrapped.length <= max) return wrapped;
		const cut = wrapped.slice(0, max);
		cut[max - 1] = [...cut[max - 1]!, 0x85]; // the WinAnsi ellipsis
		return cut;
	};
	const textLines = (ls: number[][], x: number, y: number, size: number, color: string): string => {
		const ops = ["BT", `/F1 ${num(size)} Tf`, `${rgb(color)} rg`];
		ls.forEach((codes, i) => {
			if (codes.length > 0) ops.push(`1 0 0 -1 ${num(x)} ${num(y + i * LINE)} Tm ${winAnsiLiteral(codes)} Tj`);
		});
		ops.push("ET");
		return ops.join("\n");
	};
	let cursor = 8;
	let shown = 0;
	for (const n of notes) {
		const head = `${n.author || "?"}, ${labels.when(n.created)}${n.resolved ? ` (${labels.resolved})` : ""}`;
		const body = lines(n.text.trim() === "" ? labels.sketch : n.text, SIZE, textW, 14);
		const sketchH = n.sketch ? 52 : 0;
		const replies = repliesOf(page, n.id).slice(0, 5).map((r) => ({
			head: `${r.author || "?"}, ${labels.when(r.created)}`, body: lines(r.text, SIZE, textW - 8, 6),
		}));
		const height = 10 + body.length * LINE + sketchH + replies.reduce((h, r) => h + 10 + r.body.length * LINE + 2, 0) + 6;
		const wanted = n.region.y + n.region.height / 2 - 8;
		const top = Math.max(wanted, cursor);
		if (top + height > page.height - 4) break;
		shown++;
		const done = n.resolved === true;
		const accent = done ? "0.55 0.58 0.62" : "0.15 0.45 0.9";
		const r = n.region;
		out.push(`${accent} RG 0.7 w [2 2] 0 d ${num(r.x)} ${num(r.y)} ${num(r.width)} ${num(r.height)} re S [] 0 d`);
		out.push(`0.5 w ${num(r.x + r.width)} ${num(r.y + r.height / 2)} m ${num(x0 + 12)} ${num(top + 7)} l S`);
		out.push(`${accent} rg ${circleOps(x0 + 12, top + 7, 7)} f`);
		const label = String(notes.indexOf(n) + 1);
		out.push(labelOps(label, x0 + 12 - helveticaWidth(label, 7.5) / 2, top + 9.6, 7.5, 14, "#ffffff"));
		let y = top + 6;
		out.push(textLines([toWinAnsi(head)], textX, y, 6.5, "#6b7280"));
		y += 10 + 2;
		out.push(textLines(body, textX, y, SIZE, "#1f2430"));
		y += body.length * LINE;
		if (n.sketch) {
			out.push(`0.12 0.14 0.19 RG 0.8 w 1 J 1 j`);
			for (const s of n.sketch.strokes) {
				const pts: string[] = [];
				for (let i = 0; i + 1 < s.length; i += 2) pts.push(`${num(textX + (s[i]! / COMMENT_SKETCH_W) * 100)} ${num(y + 2 + (s[i + 1]! / COMMENT_SKETCH_H) * 50)} ${i === 0 ? "m" : "l"}`);
				out.push(`${pts.join(" ")} S`);
			}
			y += sketchH;
		}
		for (const rep of replies) {
			out.push(textLines([toWinAnsi(rep.head)], textX + 8, y + 6, 6.5, "#6b7280"));
			out.push(textLines(rep.body, textX + 8, y + 18, SIZE, "#1f2430"));
			y += 10 + rep.body.length * LINE + 2;
		}
		cursor = top + height;
	}
	if (shown < notes.length) {
		out.push(labelOps(labels.more(notes.length - shown), x0 + 8, page.height - 8, 7.5, PDF_NOTES_STRIP - 16, "#6b7280"));
	}
	out.push("Q");
	return out.join("\n");
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

/**
 * A text element: wrapped to its width with Helvetica metrics, one `Tm`/`Tj` per line. A `[[link]]` shows its label (the alias,
 * else a short name), in the link colour and underlined, like on the page (K-planner).
 */
function textOps(el: TextElement): string {
	const size = el.fontSize;
	if (!(size > 0) || el.text === "") return "";
	const shown = shownText(el.text);
	const lines = wrapHelvetica(shown.text, size, Math.max(el.width, 1));
	const out = ["BT", `/F1 ${num(size)} Tf`, `${rgb(el.color)} rg`];
	// The lines as strings of WinAnsi codes (one per code point), to cut them into plain and linked runs; the link offsets follow.
	const asCodes = (s: string) => String.fromCharCode(...toWinAnsi(s));
	const runs = shown.links.length > 0 ? lineRuns(shown.text.split("\n").map(asCodes).join("\n"), lines.map((codes) => String.fromCharCode(...codes)), linksInCodePoints(shown.text, shown.links)) : null;
	const underlines: string[] = [];
	lines.forEach((codes, i) => {
		if (codes.length === 0) return;
		const baseline = el.y + size * (TEXT_BASELINE + i * TEXT_LINE_HEIGHT);
		if (!runs) {
			// The page is y-down: a negative d flips the glyphs upright again.
			out.push(`1 0 0 -1 ${num(el.x)} ${num(baseline)} Tm ${winAnsiLiteral(codes)} Tj`);
			return;
		}
		let x = el.x;
		for (const run of runs[i] ?? []) {
			if (run.text === "") continue;
			const runCodes = Array.from(run.text, (c) => c.charCodeAt(0));
			out.push(`${rgb(run.link ? LINK_COLOR : el.color)} rg`, `1 0 0 -1 ${num(x)} ${num(baseline)} Tm ${winAnsiLiteral(runCodes)} Tj`);
			const width = runCodes.reduce((sum, c) => sum + helveticaCodeWidth(c, size), 0);
			if (run.link) underlines.push(`${num(x)} ${num(baseline + size * 0.1)} ${num(width)} ${num(Math.max(0.5, size / 14))} re`);
			x += width;
		}
	});
	if (runs) out.push(`${rgb(el.color)} rg`);
	out.push("ET");
	if (underlines.length > 0) out.push(`q ${rgb(LINK_COLOR)} rg ${underlines.join(" ")} f Q`);
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

/** 0.15 (#75): the page header line (Helvetica), aligned like on screen. */
function headerOps(h: HeaderLayout): string {
	const width = helveticaWidth(h.text, h.size);
	const fit = Math.min(1, h.maxWidth / Math.max(width, 1));
	const size = h.size * fit;
	const w = width * fit;
	const left = h.align === "left" ? h.x : h.align === "right" ? h.x - w : h.x - w / 2;
	return labelOps(h.text, left, h.y + size * 0.35, size, w + 1, HEADER_COLOR_DAY);
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
		inkPath(sink, stroke.points, stroke.width, stroke.tool, stroke.nib);
		if (sink.parts.length === 0) return "";
		const body = `${rgb(stroke.color)} rg
${sink.parts.join(" ")} f`;
		if (stroke.tool === "marker") return `q
/GS3 gs
${body}
Q`;
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

/** v17 checkbox: its outline and, when ticked, its tick, stroked in the checkbox's colour (the shapes are the canvas's, ink/checkbox-render.ts). */
function checkboxOps(el: CheckboxElement): string {
	const out: string[] = ["q", `${rgb(el.color)} RG 1 J 1 j`];
	for (const p of checkboxPaths(el)) out.push(`${num(p.width)} w ${polyOps(p.points, p.closed)} S`);
	out.push("Q");
	return out.join("\n");
}
