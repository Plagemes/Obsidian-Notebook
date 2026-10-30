/**
 * v8 markers and structured boxes: their look, shared by the canvas (notebook view), the SVG and the PDF export.
 * Pure geometry plus canvas drawing in page coordinates (vector, so badges stay crisp at any zoom and device
 * pixel ratio). No 'obsidian': labels are passed in by the caller (translated in the view).
 */
import { BOX_LABEL_HEIGHT, MARKER_BADGE, markerRegion } from "../model/markers";
import type { BoxElement, BoxKind, MarkerElement, MarkerKind } from "../model/types";

export const MARKER_COLORS: Readonly<Record<MarkerKind, string>> = {
	gap: "#d97706",
	question: "#2563eb",
	important: "#dc2626",
	critical: "#991b1b",
	star: "#ca8a04",
	homework: "#7c3aed",
};
/** Badge of a resolved question, filled gap or finished homework. */
export const MARKER_DONE_COLOR = "#16a34a";

export const BOX_COLORS: Readonly<Record<BoxKind, string>> = {
	definition: "#2563eb",
	theorem: "#7c3aed",
	example: "#16a34a",
	proof: "#475569",
	remark: "#d97706",
};

/** English names of the box kinds (the view passes translated ones). */
export const BOX_NAMES: Readonly<Record<BoxKind, string>> = {
	definition: "Definition",
	theorem: "Theorem",
	example: "Example",
	proof: "Proof",
	remark: "Remark",
};

export type BoxLabel = (box: BoxElement) => string;

/** Label of a box: its title after the kind name ("Theorem · Pythagoras"), or the kind name alone. */
export function defaultBoxLabel(box: BoxElement, names: Readonly<Record<BoxKind, string>> = BOX_NAMES): string {
	return box.title ? `${names[box.kind]} · ${box.title}` : names[box.kind];
}

/** What the badge shows: a glyph (ASCII, so the PDF export's Helvetica has it), a star or a check mark. */
export type BadgeFace = { kind: "text"; text: string } | { kind: "star" } | { kind: "check" };

export function badgeFace(m: MarkerElement): BadgeFace {
	if (m.done && (m.kind === "gap" || m.kind === "question" || m.kind === "homework")) return { kind: "check" };
	switch (m.kind) {
		case "gap":
			return { kind: "text", text: "..." };
		case "question":
			return { kind: "text", text: "?" };
		case "important":
			return { kind: "text", text: "!" };
		case "critical":
			return { kind: "text", text: "!!" };
		case "star":
			return { kind: "star" };
		case "homework":
			// The day of the due date, else "HW".
			return { kind: "text", text: m.due ? String(Number(m.due.slice(8, 10))) : "HW" };
	}
}

/** Colour of a marker's badge. */
export function badgeColor(m: MarkerElement): string {
	return m.done && (m.kind === "gap" || m.kind === "question" || m.kind === "homework") ? MARKER_DONE_COLOR : MARKER_COLORS[m.kind];
}

/** Homework badges are rounded squares (a task), every other badge a circle. */
export function badgeIsSquare(m: MarkerElement): boolean {
	return m.kind === "homework";
}

/** Five-pointed star centred on (cx, cy), outer radius `r`: ten points, the first at the top. */
export function starPoints(cx: number, cy: number, r: number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < 10; i++) {
		const radius = i % 2 === 0 ? r : r * 0.45;
		const a = -Math.PI / 2 + (i * Math.PI) / 5;
		out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
	}
	return out;
}

/** Check mark inside a badge of side `s` at (x, y): three points of a polyline. */
export function checkPoints(x: number, y: number, s: number): Array<[number, number]> {
	return [[x + s * 0.27, y + s * 0.52], [x + s * 0.44, y + s * 0.69], [x + s * 0.74, y + s * 0.33]];
}

/** Font size of the badge glyph, pt. */
export function glyphSize(text: string): number {
	return text.length >= 3 ? MARKER_BADGE * 0.42 : text.length === 2 ? MARKER_BADGE * 0.5 : MARKER_BADGE * 0.62;
}

const BADGE_FONT = "bold {size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.arcTo(x + w, y, x + w, y + r, r);
	ctx.lineTo(x + w, y + h - r);
	ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
	ctx.lineTo(x + r, y + h);
	ctx.arcTo(x, y + h, x, y + h - r, r);
	ctx.lineTo(x, y + r);
	ctx.arcTo(x, y, x + r, y, r);
	ctx.closePath();
}

/** A marker in page coordinates: the dashed region (if any), then the badge on its top-left corner. */
export function drawMarker(ctx: CanvasRenderingContext2D, m: MarkerElement): void {
	const color = badgeColor(m);
	const region = markerRegion(m);
	ctx.save();
	try {
		if (region) {
			ctx.strokeStyle = color;
			ctx.globalAlpha = 0.75;
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 2]);
			ctx.strokeRect(region.x, region.y, region.width, region.height);
			ctx.setLineDash([]);
			ctx.globalAlpha = 1;
		}
		const s = MARKER_BADGE;
		ctx.fillStyle = color;
		if (badgeIsSquare(m)) roundRect(ctx, m.x, m.y, s, s, s * 0.22);
		else {
			ctx.beginPath();
			ctx.arc(m.x + s / 2, m.y + s / 2, s / 2, 0, Math.PI * 2);
		}
		ctx.fill();
		ctx.lineWidth = 0.8;
		ctx.strokeStyle = "#ffffff";
		ctx.stroke();
		const face = badgeFace(m);
		ctx.fillStyle = "#ffffff";
		if (face.kind === "star") {
			ctx.beginPath();
			starPoints(m.x + s / 2, m.y + s / 2 + 0.3, s * 0.36).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			ctx.closePath();
			ctx.fill();
		} else if (face.kind === "check") {
			ctx.beginPath();
			checkPoints(m.x, m.y, s).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			ctx.lineWidth = s * 0.13;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.stroke();
		} else {
			ctx.font = BADGE_FONT.replace("{size}", String(glyphSize(face.text)));
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(face.text, m.x + s / 2, m.y + s / 2 + 0.4);
		}
	} finally {
		ctx.restore();
	}
}

/** Width of a box's label tab for `text` at the label font (estimated: 0.55 em per character), capped at the box width. */
export function boxLabelWidth(box: BoxElement, text: string): number {
	return Math.min(box.width, Math.max(30, Array.from(text).length * BOX_LABEL_HEIGHT * 0.62 * 0.55 + 8));
}

/** A structured box: a light tint, the frame, and the label tab above its top-left corner. Under the ink. */
export function drawBox(ctx: CanvasRenderingContext2D, box: BoxElement, label: BoxLabel = (b) => defaultBoxLabel(b)): void {
	const color = BOX_COLORS[box.kind];
	const text = label(box);
	ctx.save();
	try {
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.05;
		ctx.fillRect(box.x, box.y, box.width, box.height);
		ctx.globalAlpha = 0.9;
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.2;
		ctx.strokeRect(box.x, box.y, box.width, box.height);
		ctx.globalAlpha = 1;
		const w = boxLabelWidth(box, text);
		ctx.fillRect(box.x, box.y - BOX_LABEL_HEIGHT, w, BOX_LABEL_HEIGHT);
		ctx.fillStyle = "#ffffff";
		ctx.font = BADGE_FONT.replace("{size}", String(BOX_LABEL_HEIGHT * 0.62));
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillText(text, box.x + 4, box.y - BOX_LABEL_HEIGHT / 2 + 0.4, w - 8);
	} finally {
		ctx.restore();
	}
}
