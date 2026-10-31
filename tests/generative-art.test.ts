import { beforeEach, describe, expect, it } from "vitest";
import {
	ART_STYLES, artCacheStats, artFamilyFor, artEnabled, artImage, artStyleFor, clearArtCache, coverImage, drawArtLayer, drawCover, emptyStateImage,
	folderIconSvg, setArtCanvasFactory, setArtEnabled, type ArtCanvas, type ArtContext, type ArtSpec, type ImageContext,
} from "../src/ui/art/generative-art";
import { LruCache } from "../src/ui/art/lru";
import { hashString, mulberry32, ValueNoise } from "../src/ui/art/prng";
import { colorFor, SUBJECT_COLORS, subjectColorFor, tintFor } from "../src/ui/palette";

/** A 2D context that records every call and property write as text (numbers rounded), for hashing. */
class RecordingContext implements ImageContext {
	log: string[] = [];
	private gradients = 0;
	private paint: string | CanvasGradient | CanvasPattern = "#000";
	private fillPaint: string | CanvasGradient | CanvasPattern = "#000";
	private width = 1;
	private alpha = 1;
	private cap: CanvasLineCap = "butt";
	private join: CanvasLineJoin = "miter";

	private rec(name: string, args: ArrayLike<unknown>): void {
		const parts: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			parts.push(typeof a === "number" ? a.toFixed(2) : Array.isArray(a) ? `[${a.join(",")}]` : String(a));
		}
		this.log.push(`${name}(${parts.join(",")})`);
	}

	get strokeStyle(): string | CanvasGradient | CanvasPattern {
		return this.paint;
	}
	set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
		this.paint = v;
		this.rec("strokeStyle", [typeof v === "string" ? v : "gradient"]);
	}
	get fillStyle(): string | CanvasGradient | CanvasPattern {
		return this.fillPaint;
	}
	set fillStyle(v: string | CanvasGradient | CanvasPattern) {
		this.fillPaint = v;
		this.rec("fillStyle", [typeof v === "string" ? v : "gradient"]);
	}
	get lineWidth(): number {
		return this.width;
	}
	set lineWidth(v: number) {
		this.width = v;
		this.rec("lineWidth", [v]);
	}
	get globalAlpha(): number {
		return this.alpha;
	}
	set globalAlpha(v: number) {
		this.alpha = v;
		this.rec("globalAlpha", [v]);
	}
	get lineCap(): CanvasLineCap {
		return this.cap;
	}
	set lineCap(v: CanvasLineCap) {
		this.cap = v;
	}
	get lineJoin(): CanvasLineJoin {
		return this.join;
	}
	set lineJoin(v: CanvasLineJoin) {
		this.join = v;
	}
	save(): void {
		this.rec("save", []);
	}
	restore(): void {
		this.rec("restore", []);
	}
	beginPath(): void {
		this.rec("beginPath", []);
	}
	closePath(): void {
		this.rec("closePath", []);
	}
	moveTo(...a: number[]): void {
		this.rec("M", a);
	}
	lineTo(...a: number[]): void {
		this.rec("L", a);
	}
	quadraticCurveTo(...a: number[]): void {
		this.rec("Q", a);
	}
	bezierCurveTo(...a: number[]): void {
		this.rec("C", a);
	}
	arc(...a: Array<number | boolean | undefined>): void {
		this.rec("arc", a);
	}
	ellipse(...a: Array<number | boolean | undefined>): void {
		this.rec("ellipse", a);
	}
	stroke(): void {
		this.rec("stroke", []);
	}
	fill(): void {
		this.rec("fill", []);
	}
	fillRect(...a: number[]): void {
		this.rec("fillRect", a);
	}
	clearRect(...a: number[]): void {
		this.rec("clearRect", a);
	}
	setTransform(...a: number[]): void {
		this.rec("setTransform", a);
	}
	setLineDash(segments: number[]): void {
		this.rec("dash", [segments]);
	}
	private gradient(kind: string, a: number[]): CanvasGradient {
		this.rec(kind, a);
		const id = ++this.gradients;
		return { addColorStop: (o: number, c: string) => this.rec(`stop${id}`, [o, c]) };
	}
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
		return this.gradient("linear", [x0, y0, x1, y1]);
	}
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
		return this.gradient("radial", [x0, y0, r0, x1, y1, r1]);
	}
}

/** A context that does nothing: measures the art's own (JS) cost. */
class NullContext implements ArtContext {
	strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
	fillStyle: string | CanvasGradient | CanvasPattern = "#000";
	lineWidth = 1;
	globalAlpha = 1;
	lineCap: CanvasLineCap = "butt";
	lineJoin: CanvasLineJoin = "miter";
	ops = 0;
	save(): void {}
	restore(): void {}
	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {
		this.ops++;
	}
	lineTo(): void {
		this.ops++;
	}
	quadraticCurveTo(): void {
		this.ops++;
	}
	bezierCurveTo(): void {
		this.ops++;
	}
	arc(): void {
		this.ops++;
	}
	ellipse(): void {
		this.ops++;
	}
	stroke(): void {}
	fill(): void {}
	fillRect(): void {}
	setLineDash(): void {}
	createLinearGradient(): CanvasGradient {
		return { addColorStop: () => undefined };
	}
	createRadialGradient(): CanvasGradient {
		return { addColorStop: () => undefined };
	}
}

function hashOf(spec: ArtSpec, w = 600, h = 200): { hash: number; ops: number } {
	const ctx = new RecordingContext();
	drawArtLayer(ctx, w, h, spec);
	return { hash: hashString(ctx.log.join("\n")), ops: ctx.log.length };
}

/** A fake canvas: its "PNG" is the hash of the drawing log, so equal drawings give equal URLs. */
class FakeCanvas implements ArtCanvas {
	width = 0;
	height = 0;
	renders = 0;
	private ctx = new RecordingContext();
	getContext(): ImageContext {
		this.ctx = new RecordingContext();
		return this.ctx;
	}
	toDataURL(): string {
		this.renders++;
		return `data:image/png;base64,${this.width}x${this.height}-${hashString(this.ctx.log.join("\n")).toString(16)}`;
	}
}

describe("seeded randomness", () => {
	it("mulberry32 repeats for a seed and differs between seeds", () => {
		const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
		const xs = Array.from({ length: 5 }, () => a.next());
		expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
		expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
		for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
	});

	it("hashString is a stable 32-bit value", () => {
		expect(hashString("Anatomia")).toBe(hashString("Anatomia"));
		expect(hashString("Anatomia")).not.toBe(hashString("Anatomib"));
		expect(Number.isInteger(hashString("x")) && hashString("x") >= 0 && hashString("x") < 2 ** 32).toBe(true);
	});

	it("value noise stays in [0, 1] and is continuous", () => {
		const n = new ValueNoise(mulberry32(7));
		for (let i = 0; i < 200; i++) {
			const x = i * 0.137, y = i * 0.071;
			const v = n.fbm(x, y, 3);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
			expect(Math.abs(n.noise(x, y) - n.noise(x + 1e-4, y))).toBeLessThan(0.01);
		}
	});
});

describe("drawArt", () => {
	it("the same spec gives the same drawing, for every style", () => {
		for (const style of ART_STYLES) {
			const spec: ArtSpec = { seed: "Matematica", color: "#16C2A3", style };
			const a = hashOf(spec), b = hashOf({ ...spec });
			expect(a.hash, style).toBe(b.hash);
			expect(a.ops, style).toBeGreaterThan(50);
		}
	});

	it("different seeds give different drawings, for every style", () => {
		for (const style of ART_STYLES) {
			const seen = new Set<number>();
			for (const seed of ["Anatomia", "Fisiologia", "Biomateriali", "Matematica"]) seen.add(hashOf({ seed, color: "#2F80F7", style }).hash);
			expect(seen.size, style).toBe(4);
		}
	});

	it("the colour changes the paint but not the geometry", () => {
		const geometry = (color: string): string => {
			const ctx = new RecordingContext();
			drawArtLayer(ctx, 600, 200, { seed: "Fisiologia", color, style: "cells" });
			return ctx.log.filter((l) => /^(M|L|Q|C|arc|ellipse)\(/.test(l)).join("\n");
		};
		expect(geometry("#2F80F7")).toBe(geometry("#F0565E"));
		expect(hashOf({ seed: "Fisiologia", color: "#2F80F7", style: "cells" }).hash).not.toBe(hashOf({ seed: "Fisiologia", color: "#F0565E", style: "cells" }).hash);
	});

	it("without a style it uses artFamilyFor(seed); bad input is tolerated", () => {
		const seed = "Biomateriali";
		expect(hashOf({ seed, color: "#8B5CF6" }).hash).toBe(hashOf({ seed, color: "#8B5CF6", style: artFamilyFor(seed) }).hash);
		expect(hashOf({ seed, color: "#8B5CF6", density: Number.NaN }).hash).toBe(hashOf({ seed, color: "#8B5CF6", density: 0.6 }).hash);
		expect(hashOf({ seed, color: "#8B5CF6", density: 5 }).hash).toBe(hashOf({ seed, color: "#8B5CF6", density: 1 }).hash);
		expect(() => hashOf({ seed: "", color: "not a colour" })).not.toThrow();
		const empty = new RecordingContext();
		drawArtLayer(empty, 0, 200, { seed, color: "#8B5CF6" });
		expect(empty.log).toEqual([]);
	});

	it("density changes the amount of line work", () => {
		for (const style of ART_STYLES) {
			const lo = hashOf({ seed: "Esami", color: "#F59E0B", style, density: 0 }).ops;
			const hi = hashOf({ seed: "Esami", color: "#F59E0B", style, density: 1 }).ops;
			expect(hi, style).toBeGreaterThan(lo);
		}
	});

	it("keeps the left side clean: no geometry left of 25% of a card", () => {
		for (const style of ART_STYLES) {
			const ctx = new RecordingContext();
			drawArtLayer(ctx, 600, 200, { seed: "Storia", color: "#22C55E", style });
			// Every path starts (M) right of the masked zone, give or take a margin for the outer branches.
			const xs = ctx.log.filter((l) => l.startsWith("M(")).map((l) => Number(l.slice(2).split(",")[0]));
			const left = xs.filter((x) => x < 600 * 0.2).length;
			expect(left / xs.length, style).toBeLessThan(0.05);
		}
	});

	it("is cheap: the art's own work for a 600×200 card stays well under the 30 ms budget", () => {
		const ctx = new NullContext();
		for (const style of ART_STYLES) {
			drawArtLayer(ctx, 600, 200, { seed: "warm-up", color: "#6366F1", style });
			const t0 = performance.now();
			for (let i = 0; i < 5; i++) drawArtLayer(ctx, 600, 200, { seed: `Perf ${i}`, color: "#6366F1", style, density: 1 });
			const ms = (performance.now() - t0) / 5;
			expect(ms, style).toBeLessThan(15);
		}
		expect(ctx.ops).toBeLessThan(400_000);
	});
});

describe("artStyleFor", () => {
	it("is stable, case- and space-insensitive, and lands in ART_STYLES", () => {
		expect(artStyleFor("Matematica")).toBe(artStyleFor("Matematica"));
		expect(artStyleFor("  matematica ")).toBe(artStyleFor("Matematica"));
		const used = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const s = artStyleFor(`Subject ${i}`);
			expect(ART_STYLES).toContain(s);
			used.add(s);
		}
		expect(used.size).toBe(ART_STYLES.length);
	});

	it("keeps the hash assignments of names without a keyword (changing them would change those users' art)", () => {
		expect(["Esami", "Recenti", "Con PDF", "Subject 1"].map(artStyleFor)).toEqual(["waves", "flow", "contours", "flow"]);
	});

	it("gives keyword names the motif of their topic (0.13)", () => {
		expect(["Anatomia", "Fisiologia", "Biomateriali"].map(artStyleFor).every((s) => s === "cells" || s === "branches")).toBe(true);
		expect(["waves", "grid"]).toContain(artStyleFor("Matematica"));
	});
});

describe("palette", () => {
	it("has the eight colours of DESIGN.md §2.3 with matching tints", () => {
		expect(SUBJECT_COLORS.map((c) => c.base)).toEqual(["#F0565E", "#2F80F7", "#8B5CF6", "#16C2A3", "#F59E0B", "#EC4899", "#6366F1", "#22C55E"]);
		for (const c of SUBJECT_COLORS) {
			const n = parseInt(c.base.slice(1), 16);
			expect(c.tint).toBe(`rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`);
			expect(tintFor(c.base)).toBe(c.tint);
			expect(tintFor(c.base.toLowerCase())).toBe(c.tint);
		}
		expect(tintFor("#102030")).toBe("rgba(16,32,48,0.16)");
	});

	it("colorFor is stable, normalised and lands in the palette", () => {
		const bases = SUBJECT_COLORS.map((c) => c.base);
		const used = new Set<string>();
		for (let i = 0; i < 300; i++) {
			const c = colorFor(`Folder ${i}`);
			expect(bases).toContain(c);
			used.add(c);
		}
		expect(used.size).toBe(8);
		expect(colorFor("Anatomia")).toBe(colorFor("Anatomia"));
		expect(colorFor(" ANATOMIA ")).toBe(colorFor("anatomia"));
		expect(subjectColorFor("Anatomia").base).toBe(colorFor("Anatomia"));
		expect(["Anatomia", "Fisiologia", "Biomateriali", "Matematica"].map(colorFor)).toEqual(["#EC4899", "#F59E0B", "#F59E0B", "#16C2A3"]);
	});
});

describe("images and cache", () => {
	let canvas: FakeCanvas;
	beforeEach(() => {
		canvas = new FakeCanvas();
		setArtCanvasFactory(() => canvas);
	});

	it("a repeated call is a cache hit and draws nothing", () => {
		const spec: ArtSpec = { seed: "Anatomia", color: "#F0565E" };
		const a = artImage(spec, 600, 200, 2);
		expect(a.startsWith("data:image/png")).toBe(true);
		expect(canvas.renders).toBe(1);
		const b = artImage({ ...spec }, 600, 200, 2);
		expect(b).toBe(a);
		expect(canvas.renders).toBe(1);
		expect(artCacheStats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
		// The canvas is released after each image.
		expect(canvas.width).toBe(0);
	});

	it("keys by spec, size and dpr", () => {
		const spec: ArtSpec = { seed: "Anatomia", color: "#F0565E" };
		const base = artImage(spec, 600, 200, 2);
		expect(artImage(spec, 600, 200, 3)).not.toBe(base);
		expect(artImage(spec, 400, 200, 2)).not.toBe(base);
		expect(artImage({ ...spec, seed: "Fisiologia" }, 600, 200, 2)).not.toBe(base);
		expect(artImage({ ...spec, style: "orbits" }, 600, 200, 2)).not.toBe(base);
		expect(coverImage(spec, 600, 200, 2)).not.toBe(base);
		expect(canvas.renders).toBe(6);
		// Same image after the cache is cleared: deterministic.
		clearArtCache();
		expect(artImage(spec, 600, 200, 2)).toBe(base);
	});

	it("evicts the least recently used entry beyond 40", () => {
		const first: ArtSpec = { seed: "first", color: "#16C2A3" };
		artImage(first, 100, 50, 1);
		for (let i = 0; i < 39; i++) artImage({ seed: `s${i}`, color: "#16C2A3" }, 100, 50, 1);
		artImage(first, 100, 50, 1); // touch: now the most recent
		artImage({ seed: "one more", color: "#16C2A3" }, 100, 50, 1);
		expect(artCacheStats().size).toBe(40);
		const renders = canvas.renders;
		artImage(first, 100, 50, 1);
		expect(canvas.renders).toBe(renders);
		artImage({ seed: "s0", color: "#16C2A3" }, 100, 50, 1);
		expect(canvas.renders).toBe(renders + 1);
	});

	it("clamps the pixel ratio and refuses empty sizes", () => {
		expect(artImage({ seed: "x", color: "#16C2A3" }, 0, 100, 2)).toBe("");
		artImage({ seed: "x", color: "#16C2A3" }, 100, 50, 10);
		expect(canvas.renders).toBe(1);
		expect(artImage({ seed: "x", color: "#16C2A3" }, 100, 50, 3)).toBe(artImage({ seed: "x", color: "#16C2A3" }, 100, 50, 7));
	});

	it("the LRU counts hits and misses", () => {
		const lru = new LruCache<number>(2);
		lru.getOrCreate("a", () => 1);
		lru.getOrCreate("b", () => 2);
		lru.getOrCreate("a", () => 9);
		lru.getOrCreate("c", () => 3);
		expect(lru.has("a")).toBe(true);
		expect(lru.has("b")).toBe(false);
		expect([lru.hits, lru.misses, lru.size]).toEqual([1, 3, 2]);
	});
});

describe("header bands, empty states, surfaces and the switch", () => {
	let canvas: FakeCanvas;
	beforeEach(() => {
		canvas = new FakeCanvas();
		setArtCanvasFactory(() => canvas);
		setArtEnabled(true);
	});

	it("intensity scales the opacity, not the geometry; 0 draws nothing", () => {
		const draw = (intensity?: number): RecordingContext => {
			const ctx = new RecordingContext();
			drawArtLayer(ctx, 1200, 160, { seed: "Library", color: "#6366F1", style: "contours", intensity });
			return ctx;
		};
		const full = draw(), faint = draw(0.2);
		const geometry = (c: RecordingContext): string => c.log.filter((l) => /^(M|L|Q|C|arc|ellipse)\(/.test(l)).join("\n");
		expect(geometry(faint)).toBe(geometry(full));
		const maxAlpha = (c: RecordingContext): number => Math.max(...c.log.filter((l) => l.startsWith("globalAlpha(")).map((l) => Number(l.slice(12, -1))).filter((a) => a < 1));
		expect(maxAlpha(faint)).toBeLessThan(maxAlpha(full) * 0.25);
		expect(draw(1).log).toEqual(full.log);
		expect(draw(0).log).toEqual([]);
		expect(artImage({ seed: "Library", color: "#6366F1", intensity: 0.2 }, 1200, 160, 2)).not.toBe(artImage({ seed: "Library", color: "#6366F1" }, 1200, 160, 2));
	});

	it("the light surface uses other line colours, the same geometry", () => {
		const draw = (surface?: "dark" | "light"): string[] => {
			const ctx = new RecordingContext();
			drawArtLayer(ctx, 600, 200, { seed: "Esami", color: "#F59E0B", style: "flow", surface });
			return ctx.log;
		};
		expect(draw("dark")).toEqual(draw());
		expect(draw("light")).not.toEqual(draw());
		expect(draw("light").filter((l) => l.startsWith("M("))).toEqual(draw().filter((l) => l.startsWith("M(")));
	});

	it("empty states are centred, deterministic and cached", () => {
		const spec: ArtSpec = { seed: "Nothing here", color: "#16C2A3", style: "cells" };
		const a = emptyStateImage(spec, 240, 160, 2);
		expect(a.startsWith("data:image/png")).toBe(true);
		expect(emptyStateImage(spec, 240, 160, 2)).toBe(a);
		expect(canvas.renders).toBe(1);
		expect(artImage(spec, 240, 160, 2)).not.toBe(a);
		const ctx = new RecordingContext();
		drawArtLayer(ctx, 240, 160, spec, { fade: "radial", alpha: 1, focusX: 0.5, focusY: 0.5, glow: true });
		expect(ctx.log.some((l) => l.startsWith("radial(120.00,80.00,"))).toBe(true);
	});

	it("switched off: no art, no empty state, a plain cover; on again: the same images as before", () => {
		const spec: ArtSpec = { seed: "Switch", color: "#EC4899" };
		const art = artImage(spec, 600, 200, 2), cover = coverImage(spec, 150, 210, 2);
		setArtEnabled(false);
		expect(artEnabled()).toBe(false);
		expect(artImage(spec, 600, 200, 2)).toBe("");
		expect(emptyStateImage(spec, 240, 160, 2)).toBe("");
		const plain = coverImage(spec, 150, 210, 2);
		expect(plain.startsWith("data:image/png")).toBe(true);
		expect(plain).not.toBe(cover);
		setArtEnabled(true);
		expect(artEnabled()).toBe(true);
		expect(artImage(spec, 600, 200, 2)).toBe(art);
		expect(coverImage(spec, 150, 210, 2)).toBe(cover);
	});
});

describe("covers and folder icons", () => {
	it("a cover is opaque (fills the whole rectangle first) and deterministic", () => {
		const draw = (): string[] => {
			const ctx = new RecordingContext();
			drawCover(ctx, 150, 210, { seed: "Matematica", color: "#16C2A3", style: "waves" });
			return ctx.log;
		};
		const log = draw();
		expect(log.join("\n")).toBe(draw().join("\n"));
		expect(log.find((l) => l.startsWith("fillRect("))).toBe("fillRect(0.00,0.00,150.00,210.00)");
	});

	it("folder icon: valid SVG markup in the colour, ids scoped by colour, cached", () => {
		const svg = folderIconSvg("#F0565E", 64);
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg.endsWith("</svg>")).toBe(true);
		expect(svg).toContain('width="64"');
		expect(svg).toContain('height="52"');
		expect(svg).toContain('id="nbf-f0565e-f"');
		expect(svg).toContain('stop-color="#f0565e"');
		expect(folderIconSvg("#f0565e", 64)).toBe(svg);
		expect(folderIconSvg("#2F80F7", 64)).not.toContain("f0565e");
		// Every url(#…) reference has a definition.
		for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) expect(svg).toContain(`id="${m[1]}"`);
		expect(folderIconSvg("nonsense")).toContain("<svg");
	});
});
