/**
 * Art gallery (dev only): every style of the procedural art in the eight subject colours, as subject cards and notebook
 * covers, plus the folder icons. Built by dev/harness/build.mjs into dist/art.html; `npm run harness:check` screenshots it
 * into dist/shots/art/.
 *
 * URL parameters:
 *   theme=dark|light
 *   style=<an ArtFamily>|mix|growth|icons
 *                                   mix: a header band, one card, cover and empty state per family (each in another
 *                                   colour) and the keyword motifs (a title only, no style);
 *                                   growth: every family at growth 0, 0.25, 0.5, 0.75 and 1; icons: the folder icons only
 *
 * `window.artGallery.check()` returns { ok, results, errors, timings } (determinism, growth, cache, pipeline, timing per family).
 */
import "./setup";
import {
	ART_FAMILIES, artCacheStats, artEnabled, artFamilyFor, artImage, artImageAsync, artPipelineStats, clearArtCache, coverImage, drawArt,
	drawArtLayer, emptyStateImage, folderIconSvg, growthForPages, setArtEnabled, type ArtFamily, type ArtSpec,
} from "../../src/ui/art/generative-art";
import { SUBJECT_COLORS } from "../../src/ui/palette";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const styleParam = params.get("style") ?? "mix";
/** The art's surface follows the page theme. */
const surface = theme;
const SUBJECTS = ["Anatomia", "Fisiologia", "Biomateriali", "Matematica", "Esami", "Con PDF", "Recenti", "Storia"];
/** Titles that carry a keyword motif (English and Italian): the family comes from the words alone. */
const KEYWORD_TITLES = ["Matematica", "Mathematics", "Biologia", "Human anatomy", "Fisica", "Physics II", "Storia antica", "Chemistry", "Diritto privato", "Informatica", "Letteratura", "Ecologia"];
const GROWTH_STEPS = [0, 0.25, 0.5, 0.75, 1];

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));

interface Result {
	name: string;
	ok: boolean;
	detail: string;
}

function svgEl(markup: string): Element {
	const parsed = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
	return activeDocument.importNode(parsed, true);
}

function dpr(): number {
	return window.devicePixelRatio || 1;
}

function card(parent: HTMLElement, spec: ArtSpec, title: string, compact = false): HTMLElement {
	const el = parent.createDiv({ cls: compact ? "art-card art-card-compact" : "art-card" });
	el.setCssProps({ "--subject": spec.color });
	const art = el.createEl("img", { cls: "art-card-art", attr: { alt: "" } });
	const icon = el.createDiv({ cls: "art-card-icon" });
	icon.appendChild(svgEl(folderIconSvg(spec.color, 64)));
	const text = el.createDiv({ cls: "art-card-text" });
	text.createDiv({ cls: "art-card-title", text: title });
	text.createDiv({ cls: "art-card-meta", text: `${spec.style ?? artFamilyFor(spec.title ?? spec.seed)} · ${spec.growth !== undefined ? `growth ${spec.growth}` : "12 notebooks"}` });
	el.createDiv({ cls: "art-card-chevron", text: "›" });
	window.requestAnimationFrame(() => {
		art.src = artImage(spec, el.clientWidth, el.clientHeight, dpr());
	});
	return el;
}

function cover(parent: HTMLElement, spec: ArtSpec, title: string): void {
	const wrap = parent.createDiv({ cls: "art-cover" });
	wrap.createEl("img", { attr: { alt: "", src: coverImage(spec, 150, 210, dpr()), width: 150, height: 210 } });
	wrap.createDiv({ cls: "art-cover-label", text: title });
}

function emptyState(parent: HTMLElement, spec: ArtSpec, title: string): void {
	const wrap = parent.createDiv({ cls: "art-empty" });
	wrap.createEl("img", { attr: { alt: "", src: emptyStateImage(spec, 240, 160, dpr()), width: 240, height: 160 } });
	wrap.createDiv({ cls: "art-cover-label", text: title });
}

function headerBand(parent: HTMLElement, spec: ArtSpec): void {
	const band = parent.createDiv({ cls: "art-band" });
	const img = band.createEl("img", { cls: "art-band-art", attr: { alt: "" } });
	band.createDiv({ cls: "art-band-title", text: "Notebook library" });
	band.createDiv({ cls: "art-band-sub", text: "Header band: 1200 × 160, intensity 0.22" });
	window.requestAnimationFrame(() => {
		img.src = artImage({ ...spec, intensity: 0.22 }, band.clientWidth, band.clientHeight, dpr());
	});
}

function build(): void {
	activeDocument.body.className = `art-gallery theme-${theme}`;
	const root = activeDocument.body.createDiv({ cls: "art-root" });
	if (styleParam === "icons") {
		root.createEl("h1", { text: "Folder icons · 48 / 56 / 72 px" });
		for (const size of [48, 56, 72]) {
			const row = root.createDiv({ cls: "art-icons" });
			for (const c of SUBJECT_COLORS) row.appendChild(svgEl(folderIconSvg(c.base, size)));
		}
		return;
	}
	if (styleParam === "growth") {
		root.createEl("h1", { text: "Growth, 0 to 1 (about 0, 3, 10, 25 and 60 pages)" });
		ART_FAMILIES.forEach((family, i) => {
			const c = SUBJECT_COLORS[i % SUBJECT_COLORS.length]!;
			root.createEl("h2", { text: family });
			const row = root.createDiv({ cls: "art-cards art-cards-growth" });
			for (const growth of GROWTH_STEPS) card(row, { seed: `Growth ${family}`, color: c.base, style: family, growth, surface }, `${family} · ${growth}`, true);
		});
		return;
	}
	const styles: ArtFamily[] = (ART_FAMILIES as readonly string[]).includes(styleParam) ? [styleParam as ArtFamily] : [...ART_FAMILIES];
	if (styleParam === "mix") headerBand(root, { seed: "Library", color: "#6366F1", style: "contours", surface });
	root.createEl("h1", { text: styleParam === "mix" ? "All styles" : styleParam });
	const cards = root.createDiv({ cls: "art-cards" });
	const covers = root.createDiv({ cls: "art-covers" });
	const empties = root.createDiv({ cls: "art-covers" });
	if (styles.length === 1) {
		SUBJECT_COLORS.forEach((c, i) => {
			const spec: ArtSpec = { seed: SUBJECTS[i]!, color: c.base, style: styles[0], surface };
			card(cards, spec, SUBJECTS[i]!);
			cover(covers, spec, `${SUBJECTS[i]!} · ${c.name}`);
			emptyState(empties, spec, `empty state · ${c.name}`);
		});
	} else {
		styles.forEach((style, i) => {
			const c = SUBJECT_COLORS[i % SUBJECT_COLORS.length]!;
			const spec: ArtSpec = { seed: SUBJECTS[i]!, color: c.base, style, surface };
			card(cards, spec, SUBJECTS[i]!);
			cover(covers, spec, style);
			emptyState(empties, spec, `empty state · ${style}`);
		});
	}
	if (styleParam === "mix") {
		root.createEl("h1", { text: "Keyword motifs" });
		const words = root.createDiv({ cls: "art-cards art-cards-growth" });
		KEYWORD_TITLES.forEach((title, i) => {
			const c = SUBJECT_COLORS[i % SUBJECT_COLORS.length]!;
			card(words, { seed: `kw-${title}`, title, color: c.base, growth: growthForPages(i * 6), surface }, title, true);
		});
	}
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Median time (ms) to draw one 600 × 200 card at dpr 2 into a fresh canvas, raster work included. */
function bench(style: ArtFamily, runs = 5, variant: "card" | "noglow" | "flat" = "card"): number {
	const canvas = createEl("canvas");
	canvas.width = 1200;
	canvas.height = 400;
	const ctx = canvas.getContext("2d");
	if (!ctx) return Number.NaN;
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, 1200, 400);
		ctx.setTransform(2, 0, 0, 2, 0, 0);
		const t0 = performance.now();
		const spec: ArtSpec = { seed: `Timing ${i}`, color: SUBJECT_COLORS[i % 8]!.base, style };
		if (variant === "card") drawArt(ctx, 600, 200, spec);
		else drawArtLayer(ctx, 600, 200, spec, { fade: variant === "flat" ? "none" : "right", alpha: 1, focusX: 0.74, focusY: 0.5, glow: variant === "flat" });
		// Force the raster work to happen inside the measurement.
		ctx.getImageData(0, 0, 1, 1);
		times.push(performance.now() - t0);
	}
	return Math.round(median(times) * 10) / 10;
}

async function check(): Promise<{ ok: boolean; results: Result[]; errors: string[]; timings: Record<string, number> }> {
	await new Promise((r) => window.setTimeout(r, 50));
	const results: Result[] = [];
	const add = (name: string, ok: boolean, detail = ""): void => {
		results.push({ name, ok, detail });
	};
	const timings: Record<string, number> = {};
	for (const style of ART_FAMILIES) {
		// The best of three medians: another process on the machine must not fail the budget.
		timings[style] = Math.min(bench(style), bench(style), bench(style));
		add(`${style}: drawing a 600×200 card (dpr 2) takes under 30 ms (median of 5)`, timings[style] < 30, `${timings[style]} ms`);
	}
	for (const style of ART_FAMILIES) {
		const spec: ArtSpec = { seed: "Determinism", color: "#16C2A3", style };
		const a = artImage(spec, 600, 200, 2);
		clearArtCache();
		const b = artImage(spec, 600, 200, 2);
		const other = artImage({ ...spec, seed: "Another seed" }, 600, 200, 2);
		add(`${style}: the same spec gives the same image`, a.length > 1000 && a === b, `${a.length} bytes`);
		add(`${style}: another seed gives another image`, other !== a);
	}
	// Growth: richer in steps, deterministic, and still cheap at the top step.
	for (const style of ART_FAMILIES) {
		const base: ArtSpec = { seed: "Growth", color: "#F59E0B", style };
		const g0 = artImage(base, 600, 200, 2);
		const g1 = artImage({ ...base, growth: 1 }, 600, 200, 2);
		clearArtCache();
		const g1b = artImage({ ...base, growth: 1 }, 600, 200, 2);
		add(`${style}: growth 1 differs from growth 0 and is deterministic`, g0 !== g1 && g1 === g1b, `${g0.length} to ${g1.length} bytes`);
		const canvas = createEl("canvas");
		canvas.width = 1200;
		canvas.height = 400;
		const ctx = canvas.getContext("2d");
		const rounds: number[] = [];
		for (let round = 0; ctx && round < 3; round++) {
			const times: number[] = [];
			for (let i = 0; i < 3; i++) {
				ctx.setTransform(2, 0, 0, 2, 0, 0);
				ctx.clearRect(0, 0, 600, 200);
				const t0 = performance.now();
				drawArt(ctx, 600, 200, { seed: `Grown ${i}`, color: "#16C2A3", style, growth: 1 });
				ctx.getImageData(0, 0, 1, 1);
				times.push(performance.now() - t0);
			}
			rounds.push(median(times));
		}
		timings[`${style}+growth`] = Math.round(Math.min(...rounds) * 10) / 10;
		add(`${style}: a fully grown 600×200 card takes under 80 ms (best of 3 medians)`, (timings[`${style}+growth`] ?? 0) < 80, `${timings[`${style}+growth`]} ms`);
	}
	// Keyword motifs: a title alone picks a family, the same one every time.
	add("keyword motifs: Matematica and Mathematics give waves or grid; Biologia gives veins, cells or branches",
		["waves", "grid"].includes(artFamilyFor("Matematica")) && ["waves", "grid"].includes(artFamilyFor("Mathematics")) && ["veins", "cells", "branches"].includes(artFamilyFor("Biologia")),
		`${artFamilyFor("Matematica")} / ${artFamilyFor("Mathematics")} / ${artFamilyFor("Biologia")}`);
	// The off-main-thread path (Worker + OffscreenCanvas where the browser has them, the main thread otherwise).
	clearArtCache();
	const asyncSpec: ArtSpec = { seed: "Async", color: "#2F80F7", style: "veins", growth: 0.5 };
	const t1 = performance.now();
	const viaPipeline = await artImageAsync(asyncSpec, 600, 200, 2);
	const pipelineMs = performance.now() - t1;
	const pipeline = artPipelineStats();
	add("artImageAsync delivers a PNG (worker or main thread) and the sync call then hits the cache", viaPipeline.startsWith("data:image/png") && artImage(asyncSpec, 600, 200, 2) === viaPipeline,
		`${pipelineMs.toFixed(0)} ms, worker=${pipeline.worker} (${pipeline.workerRenders} worker renders, ${pipeline.workerFallbacks} fallbacks), persistent=${pipeline.persistent}`);
	const offscreen = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined";
	add("the worker was used when the browser offers one (a fallback here would mean the inline worker is broken)", !offscreen || (pipeline.worker && pipeline.workerRenders > 0 && pipeline.workerFallbacks === 0), `worker=${pipeline.worker}, ${pipeline.workerRenders} renders, ${pipeline.workerFallbacks} fallbacks`);
	const spec: ArtSpec = { seed: "Cache", color: "#8B5CF6" };
	artImage(spec, 600, 200, 2);
	const before = artCacheStats();
	const t0 = performance.now();
	artImage(spec, 600, 200, 2);
	const hitMs = performance.now() - t0;
	const after = artCacheStats();
	add("a repeated call is a cache hit", after.hits === before.hits + 1 && after.misses === before.misses, `${hitMs.toFixed(2)} ms`);
	add("the cache holds at most its capacity", after.size <= after.capacity, `${after.size}/${after.capacity}`);
	const band = artImage({ seed: "Band", color: "#2F80F7", intensity: 0.2 }, 1200, 160, 2);
	add("header band (1200×160, intensity 0.2) differs from the full-intensity art", band.startsWith("data:image/png") && band !== artImage({ seed: "Band", color: "#2F80F7" }, 1200, 160, 2));
	add("empty state image is generated", emptyStateImage({ seed: "Empty", color: "#16C2A3" }, 240, 160, 2).startsWith("data:image/png"));
	setArtEnabled(false);
	const off = [artImage(spec, 600, 200, 2), emptyStateImage(spec, 240, 160, 2)];
	const plainCover = coverImage(spec, 150, 210, 2);
	setArtEnabled(true);
	add("switched off: no art, no empty state, the cover keeps its gradient", !artEnabled() || (off.every((u) => u === "") && plainCover.startsWith("data:image/png") && plainCover !== coverImage(spec, 150, 210, 2)));
	const imgs = Array.from(activeDocument.querySelectorAll<HTMLImageElement>("img"));
	add("every card and cover has an image", imgs.every((i) => i.src.startsWith("data:image/png")), `${imgs.length} images`);
	add("no console errors", errors.length === 0, errors.join("; "));
	return { ok: results.every((r) => r.ok), results, errors, timings };
}

build();
(window as unknown as { artGallery: Record<string, unknown> }).artGallery = {
	ready: new Promise((r) => window.setTimeout(() => r(true), 100)),
	check,
	bench,
};
