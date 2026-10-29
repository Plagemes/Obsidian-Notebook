import { createDocument, createPage } from "./document";
import { freezeStroke } from "./serialize";
import { RENDER_FREEHAND, type NotebookDocument, type Point, type RenderVersion } from "./types";

/**
 * Deterministic handwriting-like document for benchmarks and stress tests: the same
 * (strokes, pages, seed) always produces the same strokes, so measurements are comparable.
 */
export function stressDocument(strokes = 10_000, pages = 10, seed = 42, render: RenderVersion = RENDER_FREEHAND): NotebookDocument {
	let state = seed >>> 0 || 1;
	const rand = () => {
		// xorshift32
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
	const doc = createDocument(new Date("2026-01-01T00:00:00.000Z"));
	doc.id = `stress-${strokes}-${pages}-${seed}`;
	doc.pages = Array.from({ length: Math.max(1, pages) }, (_, i) => ({ ...createPage(), id: `${doc.id}-p${i}` }));
	const perPage = Math.ceil(strokes / doc.pages.length);
	const margin = 40;
	const line = 28.34;
	let n = 0;
	for (const page of doc.pages) {
		let x = margin;
		let y = margin + line;
		for (let k = 0; k < perPage && n < strokes; k++, n++) {
			const count = 15 + Math.floor(rand() * 25);
			const w = 6 + rand() * 8;
			const points: Point[] = [];
			for (let i = 0; i < count; i++) {
				const t = i / (count - 1);
				points.push([
					Math.round((x + t * w + Math.sin(t * 6 + n) * 2) * 100) / 100,
					Math.round((y - Math.abs(Math.sin(t * Math.PI * (1 + (n % 3)))) * 9) * 100) / 100,
					Math.round((0.35 + 0.4 * Math.sin(t * Math.PI)) * 1000) / 1000,
				]);
			}
			page.strokes.push(freezeStroke({ id: `${doc.id}-s${n}`, tool: "pen", color: "#1e1e1e", width: 1.6, render, points }));
			x += w + 2 + (rand() < 0.2 ? 6 : 0);
			if (x > page.width - margin) {
				x = margin;
				y += line;
				if (y > page.height - margin) y = margin + line;
			}
		}
	}
	return doc;
}
