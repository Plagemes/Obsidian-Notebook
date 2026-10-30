/**
 * Art gallery (dev only): every style of the procedural art in the eight subject colours, as subject cards and notebook
 * covers, plus the folder icons. Built by dev/harness/build.mjs into dist/art.html; `npm run harness:check` screenshots it
 * into dist/shots/art/.
 *
 * URL parameters:
 *   theme=dark|light
 *   style=<an ArtStyle>|mix|icons   mix: a header band, then one card, cover and empty state per style (each in another
 *                                   colour); icons: the folder icons only
 *
 * `window.artGallery.check()` returns { ok, results, errors, timings } (determinism, cache, timing per style).
 */
import "./setup";
import {
	ART_STYLES, artCacheStats, artEnabled, artImage, clearArtCache, coverImage, drawArt, drawArtLayer, emptyStateImage, folderIconSvg, setArtEnabled,
	type ArtSpec, type ArtStyle,
} from "../../src/ui/art/generative-art";
import { SUBJECT_COLORS } from "../../src/ui/palette";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const styleParam = params.get("style") ?? "mix";
/** The art's surface follows the page theme. */
const surface = theme;
const SUBJECTS = ["Anatomia", "Fisiologia", "Biomateriali", "Matematica", "Esami", "Con PDF", "Recenti", "Storia"];

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

function card(parent: HTMLElement, spec: ArtSpec, title: string): HTMLElement {
	const el = parent.createDiv({ cls: "art-card" });
	el.setCssProps({ "--subject": spec.color });
	const art = el.createEl("img", { cls: "art-card-art", attr: { alt: "" } });
	const icon = el.createDiv({ cls: "art-card-icon" });
	icon.appendChild(svgEl(folderIconSvg(spec.color, 64)));
	const text = el.createDiv({ cls: "art-card-text" });
	text.createDiv({ cls: "art-card-title", text: title });
	text.createDiv({ cls: "art-card-meta", text: `${spec.style ?? ""} · 12 notebooks` });
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
	const styles: ArtStyle[] = (ART_STYLES as readonly string[]).includes(styleParam) ? [styleParam as ArtStyle] : [...ART_STYLES];
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
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Median time (ms) to draw one 600 × 200 card at dpr 2 into a fresh canvas, raster work included. */
function bench(style: ArtStyle, runs = 5, variant: "card" | "noglow" | "flat" = "card"): number {
	const canvas = activeDocument.createEl("canvas");
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
	for (const style of ART_STYLES) {
		timings[style] = bench(style);
		add(`${style}: drawing a 600×200 card (dpr 2) takes under 30 ms (median of 5)`, timings[style] < 30, `${timings[style]} ms`);
	}
	for (const style of ART_STYLES) {
		const spec: ArtSpec = { seed: "Determinism", color: "#16C2A3", style };
		const a = artImage(spec, 600, 200, 2);
		clearArtCache();
		const b = artImage(spec, 600, 200, 2);
		const other = artImage({ ...spec, seed: "Another seed" }, 600, 200, 2);
		add(`${style}: the same spec gives the same image`, a.length > 1000 && a === b, `${a.length} bytes`);
		add(`${style}: another seed gives another image`, other !== a);
	}
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
