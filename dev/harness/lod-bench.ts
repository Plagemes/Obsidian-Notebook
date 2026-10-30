/**
 * Level-of-detail benchmark (npm run bench:lod): the real Renderer draws a generated notebook while the view scrolls
 * through all of it at zoomed-out scales, with the level of detail off and on. Desktop Chrome, CPU/raster time on a
 * PC: NOT a measurement on Android. After each frame the canvas is read back (1×1 pixel) so the time includes the
 * rasterisation the browser would otherwise defer.
 */
import { layoutPages } from "../../src/ink/layout";
import { Renderer } from "../../src/ink/renderer";
import { stressDocument } from "../../src/model/stress";
import type { RenderVersion } from "../../src/model/types";

export interface LodRow {
	render: RenderVersion;
	scale: number;
	lod: boolean;
	level: number;
	/** First pass over a document nobody has drawn yet (builds the paths). */
	cold: PassStats;
	/** Second pass: paths cached. */
	warm: PassStats;
}

export interface PassStats {
	frames: number;
	meanMs: number;
	p95Ms: number;
	maxMs: number;
	totalMs: number;
	strokesPerFrame: number;
}

function stats(samples: number[], strokes: number): PassStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const total = samples.reduce((a, b) => a + b, 0);
	return {
		frames: samples.length,
		meanMs: total / samples.length,
		p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
		maxMs: sorted[sorted.length - 1]!,
		totalMs: total,
		strokesPerFrame: strokes / samples.length,
	};
}

export interface LodDiff {
	render: RenderVersion;
	scale: number;
	/** Share of pixels whose grey level differs by more than 64 (of 255) between exact and simplified strokes. */
	bigDiffPct: number;
	/** Mean absolute grey-level difference over all pixels (0..255). */
	meanDiff: number;
	/** Share of pixels that differ at all. */
	anyDiffPct: number;
	/** Ink pixels (not paper) in the exact drawing, for scale. */
	inkPct: number;
}

/** Draws the same page of strokes exactly and simplified and compares the pixels. */
export function compareLod(strokes = 1000, scales = [0.49, 0.35, 0.25], renders: RenderVersion[] = [1, 2]): LodDiff[] {
	const width = 640, height = 480;
	const dpr = window.devicePixelRatio || 1;
	const out: LodDiff[] = [];
	for (const render of renders) {
		for (const scale of scales) {
			const grey: Uint8Array[] = [];
			for (const lod of [false, true]) {
				const doc = stressDocument(strokes, 1, 42, render);
				const stage = document.body.appendChild(createDiv());
				stage.className = "notebook-bench-stage";
				const renderer = new Renderer(stage);
				try {
					renderer.setLodEnabled(lod);
					renderer.resize(width, height, dpr);
					renderer.setDocument(doc.pages, layoutPages(doc.pages));
					renderer.setViewport({ scale, offsetX: 10, offsetY: 10 });
					renderer.renderNow();
					const c = renderer.staticCanvas;
					const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
					const g = new Uint8Array(c.width * c.height);
					for (let i = 0; i < g.length; i++) {
						// Over white, so the transparent area around the page counts as paper.
						const a = data[4 * i + 3]! / 255;
						g[i] = ((data[4 * i]! * 0.3 + data[4 * i + 1]! * 0.59 + data[4 * i + 2]! * 0.11) * a + 255 * (1 - a)) | 0;
					}
					grey.push(g);
				} finally {
					renderer.destroy();
					stage.remove();
				}
			}
			const [a, b] = grey as [Uint8Array, Uint8Array];
			let big = 0, any = 0, sum = 0, ink = 0;
			for (let i = 0; i < a.length; i++) {
				const d = Math.abs(a[i]! - b[i]!);
				sum += d;
				if (d > 64) big++;
				if (d > 0) any++;
				if (a[i]! < 128) ink++;
			}
			out.push({ render, scale, bigDiffPct: (100 * big) / a.length, meanDiff: sum / a.length, anyDiffPct: (100 * any) / a.length, inkPct: (100 * ink) / a.length });
		}
	}
	return out;
}

const pause = () => new Promise<void>((r) => window.setTimeout(r, 0));

export async function measureLod(
	strokes = 10_000, pages = 10, scales = [0.49, 0.35, 0.25], renders: RenderVersion[] = [1, 2], frames = 100,
): Promise<{ rows: LodRow[]; width: number; height: number; dpr: number; strokes: number }> {
	const width = Math.round(Math.min(window.innerWidth, 1280));
	const height = Math.round(Math.min(window.innerHeight, 800));
	const dpr = window.devicePixelRatio || 1;
	const rows: LodRow[] = [];
	for (const render of renders) {
		for (const scale of scales) {
			for (const lod of [false, true]) {
				const doc = stressDocument(strokes, pages, 42, render);
				const layout = layoutPages(doc.pages);
				const stage = document.body.appendChild(createDiv());
				stage.className = "notebook-bench-stage";
				const renderer = new Renderer(stage);
				try {
					renderer.setLodEnabled(lod);
					renderer.resize(width, height, dpr);
					renderer.setDocument(doc.pages, layout);
					const flush = () => renderer.staticCanvas.getContext("2d")!.getImageData(0, 0, 1, 1);
					const docHeight = layout.height * scale;
					const step = Math.max(1, (docHeight - height) / frames);
					const pass = (): PassStats => {
						const samples: number[] = [];
						let drawn = 0;
						for (let i = 0; i < frames; i++) {
							renderer.setViewport({ scale, offsetX: (width - doc.pages[0]!.width * scale) / 2, offsetY: 10 - i * step });
							const t0 = performance.now();
							renderer.renderNow();
							flush();
							samples.push(performance.now() - t0);
							drawn += renderer.stats.strokesDrawn;
						}
						return stats(samples, drawn);
					};
					const cold = pass();
					await pause();
					const warm = pass();
					rows.push({ render, scale, lod, level: renderer.stats.lodLevel, cold, warm });
				} finally {
					renderer.destroy();
					stage.remove();
				}
				await pause();
			}
		}
	}
	return { rows, width, height, dpr, strokes };
}
