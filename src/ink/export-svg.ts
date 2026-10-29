import type { Page } from "../model/types";
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

/**
 * Standalone SVG of one page. `width`/`height` are in mm (so it prints at real size), the viewBox
 * is in pt (the document unit). Output is deterministic: no ids, dates or random values.
 */
export function pageToSvg(page: Page, options: { paper?: boolean } = {}): string {
	const { width, height } = page;
	const out: string[] = [];
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * PT_TO_MM)}mm" height="${num(height * PT_TO_MM)}mm" viewBox="0 0 ${num(width)} ${num(height)}">`,
	);
	out.push(`<rect width="${num(width)}" height="${num(height)}" fill="#ffffff"/>`);

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
