import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import type { NotebookDocument, Point, Stroke } from "../src/model/types";

export function line(x0: number, y0: number, x1: number, y1: number, n = 10, width = 2): Stroke {
	const points: Point[] = [];
	for (let i = 0; i <= n; i++) {
		const k = i / n;
		points.push(quantizePoint(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, 0.3 + 0.4 * k));
	}
	return createStroke("#1e1e1e", width, points);
}

export function sampleDocument(strokes = 3): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	const page = doc.pages[0]!;
	for (let i = 0; i < strokes; i++) page.strokes.push(line(50, 50 + i * 20, 300, 60 + i * 20));
	return doc;
}
