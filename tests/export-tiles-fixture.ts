import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type Page, type Point, type Stroke, type TextElement } from "../src/model/types";

/** Deterministic pages shared by the tile tests and the byte-identical check of the non-split PDF. */
export function stroke(id: string, x: number, y: number, len = 120, tool: Stroke["tool"] = "pen"): Stroke {
	const points: Point[] = [];
	for (let i = 0; i <= 12; i++) points.push([x + (i * len) / 12, y + Math.sin(i / 2) * 3, 0.5]);
	return { id, tool, color: "#1e1e1e", width: 2, render: 1, points };
}

export function textBox(id: string, x: number, y: number, width = 200, text = "Hello"): TextElement {
	return { id, type: "text", x, y, width, text, fontSize: 14, color: "#1e1e1e" };
}

export function goldenPages(): Page[] {
	const a: Page = { id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes: [stroke("a", 50, 60), stroke("b", 60, 200, 300, "highlighter")], elements: [textBox("t1", 80, 400)] };
	const b: Page = { id: "p2", width: 400, height: 1200, infinite: true, paper: { kind: "grid", spacing: PAPER_SPACING.grid }, strokes: [stroke("c", 20, 30, 200)] };
	return [a, b];
}
