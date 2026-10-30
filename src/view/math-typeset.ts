import { finishRenderMath, loadMathJax, renderMath } from "obsidian";
import { EQUATION_OUTLINE_MAX } from "../model/math-elements";
import { formatOutline, traceCoverage } from "../math/outline";
import type { Typeset } from "../ink/math-render";
import { unsafeLatexCommand } from "../math/layout";
import { t } from "../i18n";

/**
 * Typesetting equations (#110) with Obsidian's maths engine. `renderMath` gives MathJax output in the DOM; it is laid
 * out off screen at `fontSize` CSS px (1 px = 1 pt, so the measures are the element's pt), painted into a canvas at
 * several pixels per pt, and the painted coverage is traced into the vector outline stored in the element
 * (math/outline.ts). MathJax's SVG output is painted as an image; its HTML (CHTML) output, Obsidian's default, is
 * painted glyph by glyph with the MathJax web fonts the page already uses, plus its rules (fraction bars, roots).
 */

export class TypesetError extends Error {}

/** Pixels per pt of the raster that is traced (8 at most; less for very large equations). */
const MAX_PX_PER_PT = 8;
const MAX_PIXELS = 6_000_000;
/** Margin painted around the typeset box, em. */
const PAD_EM = 0.12;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The text of a CSS `content` value ("\"x\"" → "x"), or null for none/normal. */
export function cssContentText(value: string): string | null {
	const v = value.trim();
	if (v.length < 2 || !(v.startsWith('"') || v.startsWith("'"))) return null;
	const body = v.slice(1, -1);
	const out = body.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch ?? ""));
	return out.length > 0 ? out : null;
}

/** Renders `latex` in the editor's preview (live), reporting a TeX error message, if any. */
export async function renderPreview(target: HTMLElement, latex: string, inline: boolean): Promise<string | null> {
	await loadMathJax();
	target.empty();
	if (latex.trim() === "") return null;
	// Commands that could link out, style the page or load MathJax extensions never reach MathJax.
	const unsafe = unsafeLatexCommand(latex);
	if (unsafe) return t("math.eq.unsafe", { command: unsafe });
	const el = renderMath(latex, !inline);
	target.appendChild(el);
	await finishRenderMath();
	return texError(el);
}

function texError(el: HTMLElement): string | null {
	const err = el.querySelector("mjx-merror, [data-mjx-error]");
	if (!err) return null;
	return err.getAttribute("data-mjx-error") ?? err.getAttribute("title") ?? err.textContent ?? "TeX error";
}

/** Draws MathJax's SVG output into the context (scaled to `w` × `h` CSS px). */
async function paintSvg(ctx: CanvasRenderingContext2D, svg: SVGSVGElement, w: number, h: number): Promise<void> {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute("width", String(w));
	clone.setAttribute("height", String(h));
	clone.setAttribute("color", "#000000");
	clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	const text = new XMLSerializer().serializeToString(clone);
	const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		ctx.drawImage(img, 0, 0, w, h);
	} finally {
		URL.revokeObjectURL(url);
	}
}

interface Glyph {
	text: string;
	font: string;
	x: number;
	baseline: number;
	sx: number;
	sy: number;
	clip: DOMRect | null;
}

/** The nearest ancestor (inside `root`) that clips its content, for stretched delimiters built from pieces. */
function clipOf(el: Element, root: Element): DOMRect | null {
	for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
		const o = getComputedStyle(p).overflow;
		if (o === "hidden" || o === "clip") return p.getBoundingClientRect();
	}
	return null;
}

/** Paints MathJax's HTML output: every glyph (`mjx-c` and its ::before content) and every border (rules). */
async function paintChtml(ctx: CanvasRenderingContext2D, root: HTMLElement, origin: DOMRect): Promise<number> {
	const glyphs: Glyph[] = [];
	for (const c of Array.from(root.querySelectorAll("mjx-c"))) {
		const before = getComputedStyle(c, "::before");
		const text = cssContentText(before.content) ?? (c.textContent && c.textContent.trim() !== "" ? c.textContent : null);
		if (!text) continue;
		const r = c.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		const ow = (c as HTMLElement).offsetWidth;
		const oh = (c as HTMLElement).offsetHeight;
		const sx = ow > 0 ? r.width / ow : 1;
		const sy = oh > 0 ? r.height / oh : 1;
		const depth = parseFloat(before.paddingBottom) || 0;
		glyphs.push({
			text, x: r.left - origin.left, baseline: r.bottom - origin.top - depth * sy, sx, sy,
			font: `${before.fontStyle} ${before.fontWeight} ${before.fontSize} ${before.fontFamily}`,
			clip: clipOf(c, root),
		});
	}
	// The MathJax fonts load on first use: wait for the ones these glyphs need.
	const fonts = activeDocument.fonts;
	await Promise.all([...new Set(glyphs.map((g) => g.font))].map((f) => fonts.load(f).catch(() => [])));
	ctx.fillStyle = "#000000";
	ctx.textBaseline = "alphabetic";
	for (const g of glyphs) {
		ctx.save();
		if (g.clip) {
			ctx.beginPath();
			ctx.rect(g.clip.left - origin.left, g.clip.top - origin.top, g.clip.width, g.clip.height);
			ctx.clip();
		}
		ctx.translate(g.x, g.baseline);
		ctx.scale(g.sx, g.sy);
		ctx.font = g.font;
		ctx.fillText(g.text, 0, 0);
		ctx.restore();
	}
	let rules = 0;
	for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		const x = r.left - origin.left, y = r.top - origin.top;
		const side = (w: string, style: string) => (style !== "none" && style !== "hidden" ? parseFloat(w) || 0 : 0);
		const t = side(cs.borderTopWidth, cs.borderTopStyle);
		const b = side(cs.borderBottomWidth, cs.borderBottomStyle);
		const l = side(cs.borderLeftWidth, cs.borderLeftStyle);
		const rr = side(cs.borderRightWidth, cs.borderRightStyle);
		if (t > 0) ctx.fillRect(x, y, r.width, t);
		if (b > 0) ctx.fillRect(x, y + r.height - b, r.width, b);
		if (l > 0) ctx.fillRect(x, y, l, r.height);
		if (rr > 0) ctx.fillRect(x + r.width - rr, y, rr, r.height);
		if (t + b + l + rr > 0) rules++;
	}
	return glyphs.length + rules;
}

/**
 * Typesets `latex` at `fontSize` pt (display or inline style) into an outline. Throws TypesetError with MathJax's
 * message for a TeX error, or when nothing could be painted.
 */
export async function typesetEquation(latex: string, fontSize: number, inline: boolean): Promise<Typeset> {
	const unsafe = unsafeLatexCommand(latex);
	if (unsafe) throw new TypesetError(t("math.eq.unsafe", { command: unsafe }));
	await loadMathJax();
	const host = activeDocument.body.createDiv({ cls: "notebook-math-measure" });
	host.setCssProps({ "--notebook-math-size": `${fontSize}px` });
	try {
		const el = renderMath(latex, !inline);
		host.appendChild(el);
		await finishRenderMath();
		await activeDocument.fonts.ready;
		const error = texError(el);
		if (error) throw new TypesetError(error);
		const svg = el.querySelector("svg");
		const measured = (svg ?? el.querySelector("mjx-math") ?? el) as HTMLElement;
		const box = measured.getBoundingClientRect();
		const w = box.width, h = box.height;
		if (!(w > 0 && h > 0)) throw new TypesetError("nothing to typeset");
		// A margin around the box: italic glyphs and large operators may reach a little outside it.
		const pad = fontSize * PAD_EM;
		const pw = w + 2 * pad, ph = h + 2 * pad;
		const pxPerPt = Math.min(MAX_PX_PER_PT, Math.sqrt(MAX_PIXELS / (pw * ph)));
		const canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.ceil(pw * pxPerPt));
		canvas.height = Math.max(1, Math.ceil(ph * pxPerPt));
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new TypesetError("no canvas");
		ctx.scale(pxPerPt, pxPerPt);
		ctx.translate(pad, pad);
		if (svg) await paintSvg(ctx, svg, w, h);
		else if ((await paintChtml(ctx, el, box)) === 0) throw new TypesetError("nothing to typeset");
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const coverage = new Uint8Array(canvas.width * canvas.height);
		for (let k = 0; k < coverage.length; k++) coverage[k] = data[k * 4 + 3]!;
		let outline = formatOutline(traceCoverage(coverage, canvas.width, canvas.height, pxPerPt, 0.04));
		if (outline.length > EQUATION_OUTLINE_MAX) outline = formatOutline(traceCoverage(coverage, canvas.width, canvas.height, pxPerPt, 0.15));
		if (outline.length === 0 || outline.length > EQUATION_OUTLINE_MAX) throw new TypesetError("the outline is empty or too large");
		return { width: round2(pw), height: round2(ph), outline };
	} finally {
		host.remove();
	}
}
