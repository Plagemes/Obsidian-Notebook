import { Modal, Notice, Platform, type App } from "obsidian";
import { t } from "../i18n";
import { findHitStrokes } from "../ink/hit-test";
import { layoutPages } from "../ink/layout";
import { Renderer } from "../ink/renderer";
import { eraseSegment } from "../ink/segment-erase";
import { fitWidth, pan, zoomAt } from "../ink/viewport";
import { parse, serialize, serializeChecked } from "../model/serialize";
import { stressDocument } from "../model/stress";

interface MemoryInfo {
	usedJSHeapSize: number;
}

const pause = () => new Promise<void>((r) => window.setTimeout(r, 0));

function stats(samples: number[]): string {
	const sorted = [...samples].sort((a, b) => a - b);
	const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
	const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
	return `avg ${avg.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`;
}

function time(fn: () => void): number {
	const t0 = performance.now();
	fn();
	return performance.now() - t0;
}

function heapMb(): number | null {
	const mem = (performance as Performance & { memory?: MemoryInfo }).memory;
	return mem ? mem.usedJSHeapSize / 1048576 : null;
}

/**
 * Reproducible benchmark on a generated 10,000-stroke notebook (10 pages), rendered off-screen
 * at the size of the current view. Nothing is written to the vault.
 */
export async function runBenchmark(width: number, height: number, dpr: number, log: (line: string) => void): Promise<void> {
	log(`Device: ${Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : Platform.isMobile ? "mobile" : "desktop"}, view ${Math.round(width)}×${Math.round(height)} @${dpr}x`);
	const heap0 = heapMb();

	let doc = stressDocument(10_000, 10);
	log(`Generate 10,000 strokes / 10 pages: ${time(() => (doc = stressDocument(10_000, 10))).toFixed(0)} ms`);
	await pause();

	let text = "";
	log(`Serialize: ${time(() => (text = serialize(doc))).toFixed(0)} ms (${(text.length / 1e6).toFixed(2)} MB)`);
	log(`Save check, first save: ${time(() => serializeChecked(doc)).toFixed(0)} ms`);
	log(`Save check, next saves: ${time(() => serializeChecked(doc)).toFixed(0)} ms`);
	await pause();
	log(`Parse + validate (open): ${time(() => parse(text)).toFixed(0)} ms`);
	await pause();

	const stage = activeDocument.body.createDiv({ cls: "notebook-bench-stage" });
	try {
		const renderer = new Renderer(stage);
		const layout = layoutPages(doc.pages);
		renderer.resize(width, height, dpr);
		renderer.setDocument(doc.pages, layout);
		let v = fitWidth({ width, height }, layout);
		renderer.setViewport(v);
		log(`First draw (builds stroke paths): ${renderer.renderNow().toFixed(1)} ms, ${renderer.stats.strokesDrawn} strokes`);

		const redraw: number[] = [];
		for (let i = 0; i < 30; i++) redraw.push(renderer.renderNow());
		log(`Redraw, fit width: ${stats(redraw)}`);
		await pause();

		const scroll: number[] = [];
		for (let i = 0; i < 150; i++) {
			v = pan(v, 0, -40);
			renderer.setViewport(v);
			scroll.push(renderer.renderNow());
		}
		log(`Scroll through pages (150 frames): ${stats(scroll)}`);
		await pause();

		v = zoomAt(fitWidth({ width, height }, layout), 3, width / 2, height / 2);
		renderer.setViewport(v);
		const zoomed: number[] = [];
		for (let i = 0; i < 30; i++) zoomed.push(renderer.renderNow());
		log(`Redraw at 3× zoom: ${stats(zoomed)}`);
		renderer.destroy();
	} finally {
		stage.remove();
	}
	await pause();

	const page = doc.pages[0]!;
	let hits = 0;
	const eraseMs = time(() => {
		for (let i = 0; i < 1000; i++) {
			const x = (i * 37) % page.width;
			const y = (i * 53) % page.height;
			hits += findHitStrokes(page.strokes, x, y, x + 4, y + 4, 4).length;
		}
	});
	log(`Eraser hit test, 1000 moves over ${page.strokes.length} strokes: ${(eraseMs / 1000).toFixed(3)} ms per move (${hits} hits)`);
	const segMs = time(() => {
		for (const s of page.strokes.slice(0, 500)) eraseSegment(s, s.points[0]![0], 0, s.points[0]![0], page.height, 2);
	});
	log(`Segment eraser, 500 cuts: ${(segMs / 500).toFixed(3)} ms per cut`);

	const heap1 = heapMb();
	if (heap0 !== null && heap1 !== null) log(`JS heap: ${heap0.toFixed(0)} → ${heap1.toFixed(0)} MB`);
	else log("JS heap: not reported by this browser");
}

export class BenchmarkModal extends Modal {
	private readonly lines: string[] = [];

	constructor(app: App, private readonly size: { width: number; height: number }) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("bench.title"));
		const out = this.contentEl.createEl("pre", { cls: "notebook-bench-output", text: t("bench.running") });
		const copy = this.contentEl.createEl("button", { text: t("bench.copy") });
		copy.disabled = true;
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.lines.join("\n")).then(() => new Notice(t("bench.copied")));
		});
		const log = (line: string) => {
			this.lines.push(line);
			out.setText(this.lines.join("\n"));
		};
		void runBenchmark(this.size.width, this.size.height, window.devicePixelRatio || 1, log)
			.catch((e) => log(`Error: ${(e as Error).message}`))
			.finally(() => (copy.disabled = false));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
