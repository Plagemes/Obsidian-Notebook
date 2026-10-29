// Generates a .notebook file with many handwriting-like strokes, for manual performance tests.
// Usage: node scripts/make-stress-notebook.mjs [strokes=5000] [out=stress.notebook]
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const count = Number(process.argv[2] ?? 5000);
const out = process.argv[3] ?? "stress.notebook";
const W = 595.28, H = 841.89, MARGIN = 40, LINE = 14.17 * 2;

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const r2 = (v) => Math.round(v * 100) / 100;

const strokes = [];
let x = MARGIN, y = MARGIN + LINE;
for (let i = 0; i < count; i++) {
	// A short "letter": a wobbly curve of 15–40 points.
	const n = 15 + Math.floor(rand() * 25);
	const w = 6 + rand() * 8;
	const points = [];
	for (let k = 0; k < n; k++) {
		const t = k / (n - 1);
		points.push([
			r2(x + t * w + Math.sin(t * 6 + i) * 2),
			r2(y - Math.abs(Math.sin(t * Math.PI * (1 + (i % 3)))) * 9),
			Math.round((0.35 + 0.4 * Math.sin(t * Math.PI)) * 1000) / 1000,
		]);
	}
	strokes.push({ id: randomUUID(), tool: "pen", color: "#1e1e1e", width: 1.6, render: 1, points });
	x += w + 2 + (rand() < 0.2 ? 6 : 0);
	if (x > W - MARGIN) {
		x = MARGIN;
		y += LINE;
		if (y > H - MARGIN) y = MARGIN + LINE; // overwrite the page again: density test
	}
}

const now = new Date().toISOString();
const doc = {
	format: "obsidian-notebook",
	version: 5,
	id: randomUUID(),
	createdAt: now,
	modifiedAt: now,
	pages: [{ id: randomUUID(), width: W, height: H, paper: { kind: "grid", spacing: 14.17 }, strokes }],
};
writeFileSync(out, JSON.stringify(doc));
const points = strokes.reduce((a, s) => a + s.points.length, 0);
console.log(`${out}: ${count} strokes, ${points} points`);
