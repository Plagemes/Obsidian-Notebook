/**
 * Repository banner and social preview (dev only), drawn with the plugin's own engines: the procedural subject art
 * (src/ui/art), the notebook covers and a pen stroke shaped by the real pen outline (src/ink/stroke-shape.ts).
 * Built by dev/harness/build.mjs into dist/banner.html; `npm run harness:check` screenshots it into dist/shots/banner/
 * (1280 × 400 banner and 1280 × 640 social preview, dark and light; a 1600 × 240 art band at very low intensity and
 * without text for the roadmap page's hero, which overlays its own title). The images in docs/media/ are copies of those.
 *
 * URL parameters:
 *   theme=dark|light
 *   kind=banner|social|band
 *
 * `window.banner.check()` returns { ok, results, errors }.
 */
import "./setup";
import { coverImage, drawArtLayer, type ArtSpec } from "../../src/ui/art/generative-art";
import { strokePath } from "../../src/ink/stroke-shape";
import type { Point } from "../../src/model/types";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const kindParam = params.get("kind");
const kind = kindParam === "social" || kindParam === "band" ? kindParam : "banner";
const W = kind === "band" ? 1600 : 1280;
const H = kind === "social" ? 640 : kind === "band" ? 240 : 400;

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));

const ACCENT = theme === "dark" ? "#6D8BFF" : "#4F6BF0";

/** The art behind the right half: three layers from the subject palette, fading in from the left. */
function paintArt(canvas: HTMLCanvasElement): void {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(W * dpr);
	canvas.height = Math.round(H * dpr);
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const surface = theme;
	const layers: [ArtSpec, number, number, number][] = [
		[{ seed: "Notebook", color: "#6366F1", style: "contours", surface, density: 0.7 }, 0.95, 0.74, 0.46],
		[{ seed: "Notebook waves", color: "#16C2A3", style: "waves", surface, density: 0.55 }, 0.5, 0.66, 0.78],
		[{ seed: "Notebook orbits", color: "#8B5CF6", style: "orbits", surface, density: 0.5 }, 0.42, 0.9, 0.22],
	];
	// Glow passes on, the engine's rectangular glow fill off (on a wide image its left edge shows): the page background
	// carries a soft radial glow instead (banner.css).
	// The roadmap page's band sits behind the page's own title: a faint wash of the same art.
	const intensity = kind === "band" ? 0.3 : 1;
	for (const [spec, alpha, focusX, focusY] of layers) drawArtLayer(ctx, W, H, spec, { fade: "right", alpha: alpha * intensity, focusX, focusY, glow: false });
}

/** A handwritten underline below the name, outlined like a real pen stroke (pressure rises then falls). */
function underlineSvg(width: number): string {
	const pts: Point[] = [];
	const n = 48;
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const x = 4 + t * (width - 8);
		const y = 14 - Math.sin(t * Math.PI) * 6 + Math.sin(t * Math.PI * 3) * 1.2 + t * 3;
		const pressure = 0.25 + Math.sin(t * Math.PI) * 0.65;
		pts.push([x, y, pressure]);
	}
	const d = strokePath(pts, kind === "social" ? 9 : 7);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" viewBox="0 0 ${width} 28"><path d="${d}" fill="${ACCENT}"/></svg>`;
}

function build(): void {
	activeDocument.body.className = `banner theme-${theme} kind-${kind}`;
	const root = activeDocument.body.createDiv({ cls: "banner-root" });
	const art = root.createEl("canvas", { cls: "banner-art" });
	paintArt(art);
	if (kind === "band") return;
	const covers = root.createDiv({ cls: "banner-covers" });
	const coverW = kind === "social" ? 210 : 150;
	const coverH = Math.round(coverW * 1.4);
	const specs: ArtSpec[] = [
		{ seed: "Fisiologia", color: "#2F80F7", style: "waves", surface: theme },
		{ seed: "Matematica", color: "#16C2A3", style: "grid", surface: theme },
		{ seed: "Anatomia", color: "#F0565E", style: "branches", surface: theme },
	];
	specs.forEach((spec, i) => {
		covers.createEl("img", { cls: `banner-cover banner-cover-${i}`, attr: { alt: "", width: coverW, height: coverH, src: coverImage(spec, coverW, coverH, 2) } });
	});
	const text = root.createDiv({ cls: "banner-text" });
	text.createDiv({ cls: "banner-eyebrow", text: "Obsidian plugin · free and open source" });
	text.createDiv({ cls: "banner-title", text: "Notebook" });
	const line = text.createDiv({ cls: "banner-underline" });
	const svg = new DOMParser().parseFromString(underlineSvg(kind === "social" ? 380 : 300), "image/svg+xml").documentElement;
	line.appendChild(activeDocument.importNode(svg, true));
	text.createDiv({ cls: "banner-tagline", text: "Handwrite in Obsidian — like a real notebook, with your S Pen." });
	text.createDiv({ cls: "banner-value", text: "Pressure-sensitive ink, PDFs and equations, saved as plain files in your vault." });
	const chips = text.createDiv({ cls: "banner-chips" });
	for (const label of ["S Pen pressure", "PDFs & equations", "Local-first"]) chips.createDiv({ cls: "banner-chip", text: label });
}

interface Result {
	name: string;
	ok: boolean;
	detail: string;
}

async function check(): Promise<{ ok: boolean; results: Result[]; errors: string[] }> {
	await Promise.all(Array.from(activeDocument.images).map((i) => i.decode().catch(() => undefined)));
	const results: Result[] = [];
	const add = (name: string, ok: boolean, detail = ""): void => {
		results.push({ name, ok, detail });
	};
	const body = activeDocument.body.getBoundingClientRect();
	add(`page is ${W} × ${H}`, Math.round(body.width) === W && Math.round(body.height) === H, `${body.width} × ${body.height}`);
	const imgs = Array.from(activeDocument.querySelectorAll<HTMLImageElement>("img.banner-cover"));
	if (kind === "band") {
		add("no text on the band", !activeDocument.querySelector(".banner-text"));
		add("no console errors", errors.length === 0, errors.join("; "));
		return { ok: results.every((r) => r.ok), results, errors };
	}
	add("three covers drawn", imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth > 0));
	const text = activeDocument.querySelector(".banner-text")?.getBoundingClientRect();
	add("the text fits inside the image", !!text && text.right < W && text.bottom < H && text.top > 0, text ? `${Math.round(text.right)} × ${Math.round(text.bottom)}` : "");
	const coversBox = activeDocument.querySelector(".banner-covers")?.getBoundingClientRect();
	add("the text stays clear of the covers", !!text && !!coversBox && text.right < coversBox.left, text && coversBox ? `${Math.round(text.right)} < ${Math.round(coversBox.left)}` : "");
	add("no console errors", errors.length === 0, errors.join("; "));
	return { ok: results.every((r) => r.ok), results, errors };
}

build();
(window as unknown as { banner: Record<string, unknown> }).banner = {
	ready: new Promise((r) => window.setTimeout(() => r(true), 100)),
	check,
};
