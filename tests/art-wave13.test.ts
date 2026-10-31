import { beforeEach, describe, expect, it } from "vitest";
import {
	ART_FAMILIES, ART_STYLES, artCacheStats, artFamilyFor, artImage, artImageAsync, artPipelineStats, artStyleFor, clearArtCache, coverImageAsync, drawArtLayer,
	growthForPages, prewarmArt, resetArtFailures, setArtCanvasFactory, setArtPersistence, warmArtCache, type ArtCanvas, type ArtFamily, type ArtSpec, type ImageContext,
} from "../src/ui/art/generative-art";
import { darken, glowColour, lighten } from "../src/ui/art/art-colour";
import { motifFor, topicOf, TOPICS, wordsOf } from "../src/ui/art/keywords";
import { mixOklch, oklchRamp, oklchToRgb, rgbToOklch } from "../src/ui/art/oklch";
import type { ArtStore } from "../src/ui/art/persist";
import { createIdbStore } from "../src/ui/art/persist";
import { RecordingCanvasContext, replayOps, workerMain, workerSource, type WorkerRequest, type WorkerScope } from "../src/ui/art/record";
import { setArtWorkerFactory, disposeArtWorker, type WorkerLike } from "../src/ui/art/render-worker";
import { hashString } from "../src/ui/art/prng";
import { rampFor } from "../src/ui/palette";
import { LoggingContext } from "./art-helpers";
import { sleep } from "./node-env";

const spec = (over: Partial<ArtSpec> = {}): ArtSpec => ({ seed: "Wave13", color: "#16C2A3", style: "veins", ...over });

function logOf(s: ArtSpec, w = 600, h = 200): string[] {
	const ctx = new LoggingContext();
	drawArtLayer(ctx, w, h, s);
	return ctx.log;
}

describe("OKLCH colour", () => {
	it("round-trips sRGB through OKLCH within one step per channel", () => {
		let worst = 0;
		for (let r = 0; r <= 255; r += 15) {
			for (let g = 0; g <= 255; g += 15) {
				for (let b = 0; b <= 255; b += 15) {
					const back = oklchToRgb(rgbToOklch({ r, g, b }));
					worst = Math.max(worst, Math.abs(back.r - r), Math.abs(back.g - g), Math.abs(back.b - b));
				}
			}
		}
		expect(worst).toBeLessThan(0.6);
	});

	it("matches known values: white, black, a grey and pure red", () => {
		const white = rgbToOklch({ r: 255, g: 255, b: 255 });
		expect(white.l).toBeCloseTo(1, 3);
		expect(white.c).toBeLessThan(1e-3);
		expect(rgbToOklch({ r: 0, g: 0, b: 0 }).l).toBeCloseTo(0, 5);
		expect(rgbToOklch({ r: 119, g: 119, b: 119 }).l).toBeCloseTo(0.57, 1);
		const red = rgbToOklch({ r: 255, g: 0, b: 0 });
		expect(red.l).toBeCloseTo(0.628, 2);
		expect(red.c).toBeCloseTo(0.2577, 2);
		expect(red.h).toBeCloseTo(29.2, 0);
	});

	it("keeps lightness and hue when a colour is outside the sRGB gamut (chroma gives way)", () => {
		const out = oklchToRgb({ l: 0.7, c: 0.4, h: 150 });
		for (const v of [out.r, out.g, out.b]) expect(v >= 0 && v <= 255).toBe(true);
		const back = rgbToOklch(out);
		expect(back.l).toBeCloseTo(0.7, 1);
		expect(Math.abs(back.h - 150)).toBeLessThan(8);
		expect(back.c).toBeLessThan(0.4);
		expect(() => oklchToRgb({ l: Number.NaN, c: Number.NaN, h: Number.NaN })).not.toThrow();
	});

	it("mixes along the shortest hue arc and keeps the hue of a grey end's partner", () => {
		const a = oklchToRgb({ l: 0.7, c: 0.12, h: 350 }), b = oklchToRgb({ l: 0.7, c: 0.12, h: 20 });
		const mid = rgbToOklch(mixOklch(a, b, 0.5));
		// 350° → 20° passes through 5°, not through 185°.
		expect(Math.min(Math.abs(mid.h - 5), 360 - Math.abs(mid.h - 5))).toBeLessThan(6);
		const blue = { r: 47, g: 128, b: 247 };
		const toWhite = rgbToOklch(mixOklch(blue, { r: 255, g: 255, b: 255 }, 0.5));
		expect(Math.abs(toWhite.h - rgbToOklch(blue).h)).toBeLessThan(6);
		expect(mixOklch(blue, { r: 0, g: 0, b: 0 }, 0)).toEqual(expect.objectContaining({ r: expect.closeTo(47, 0) as unknown as number }));
	});

	it("lighten and darken move lightness the right way without changing the hue", () => {
		const base = { r: 139, g: 92, b: 246 };
		const o = rgbToOklch(base);
		expect(rgbToOklch(lighten(base, 0.3)).l).toBeGreaterThan(o.l);
		expect(rgbToOklch(darken(base, 0.3)).l).toBeLessThan(o.l);
		expect(Math.abs(rgbToOklch(lighten(base, 0.3)).h - o.h)).toBeLessThan(6);
		expect(Math.abs(rgbToOklch(darken(base, 0.3)).h - o.h)).toBeLessThan(6);
		// The glow is brighter than the base on a dark surface and not lighter than it on a light one.
		expect(rgbToOklch(glowColour(base, "dark")).l).toBeGreaterThanOrEqual(0.74 - 0.01);
		expect(rgbToOklch(glowColour(base, "light")).l).toBeLessThanOrEqual(0.63);
	});

	it("builds ramps from dark to light with one hue (palette rampFor)", () => {
		const ramp = oklchRamp({ r: 22, g: 194, b: 163 }, 6);
		const ls = ramp.map((c) => rgbToOklch(c).l);
		expect([...ls].sort((x, y) => x - y)).toEqual(ls);
		const hues = ramp.map((c) => rgbToOklch(c).h);
		expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(15);
		const hexes = rampFor("#16C2A3", 5);
		expect(hexes).toHaveLength(5);
		for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/);
		expect(rampFor("not a colour", 3)).toHaveLength(3);
	});
});

describe("keyword motifs", () => {
	it("maps English and Italian title words to the families of their topic", () => {
		const cases: Array<[string, string, ArtFamily[]]> = [
			["Matematica", "mathematics", ["waves", "grid"]],
			["Linear Algebra", "mathematics", ["waves", "grid"]],
			["Analisi 2", "mathematics", ["waves", "grid"]],
			["Biologia", "biology", ["veins", "cells", "branches"]],
			["Human Anatomy", "biology", ["veins", "cells", "branches"]],
			["Fisiologia", "biology", ["veins", "cells", "branches"]],
			["Fisica generale", "physics", ["orbits", "flow"]],
			["Quantum mechanics", "physics", ["orbits", "flow"]],
			["Storia dell'arte", "history", ["contours", "flow"]],
			["Ancient History", "history", ["contours", "flow"]],
			["Chimica organica", "chemistry", ["cells", "orbits", "grid"]],
			["Informatica", "computing", ["grid", "flow", "waves"]],
			["Letteratura italiana", "language", ["flow", "contours"]],
			["Economia", "economics", ["grid", "waves"]],
			["Diritto privato", "law", ["grid", "contours"]],
		];
		for (const [title, id, families] of cases) {
			expect(topicOf(title)?.id, title).toBe(id);
			expect(families, title).toContain(motifFor(title));
		}
	});

	it("ignores case and accents, matches word starts only and needs whole words for short stems", () => {
		expect(wordsOf("Física — Meccànica 2")).toEqual(["fisica", "meccanica"]);
		expect(topicOf("FÍSICA")?.id).toBe("physics");
		expect(topicOf("Start")).toBeNull();
		expect(topicOf("Smart notes")).toBeNull();
		expect(topicOf("Law")?.id).toBe("law");
		expect(topicOf("Lawn care")).toBeNull();
		expect(topicOf("Biografie")).toBeNull();
		expect(topicOf("")).toBeNull();
		expect(motifFor("Appunti vari")).toBeNull();
	});

	it("is deterministic and respects the allowed families", () => {
		expect(motifFor("Biologia")).toBe(motifFor("Biologia"));
		expect(motifFor("  biologia ")).toBe(motifFor("Biologia"));
		for (const t of ["Biologia", "Anatomia", "Zoologia", "Botanica", "Patologia generale"]) {
			expect(["cells", "branches"]).toContain(motifFor(t, ["cells", "branches"]));
		}
		expect(motifFor("Matematica", ["orbits"])).toBeNull();
	});

	it("the first matching word of a path decides, so a folder path gets its subject's motif", () => {
		expect(topicOf("Università/Fisica/Lezione 3")?.id).toBe("physics");
		expect(topicOf("Notebooks/Matematica")?.id).toBe("mathematics");
	});

	it("artStyleFor never returns a family the file format cannot store; artFamilyFor may return veins", () => {
		const titles = ["Biologia", "Anatomia", "Botanica", "Ecologia", "Ambiente", "Natura", "Foresta", "Plants", "Zoologia", "Neuroscience", "Matematica", "Fisica", "Storia"];
		for (const t of titles) expect(ART_STYLES).toContain(artStyleFor(t));
		const families = new Set(titles.map(artFamilyFor));
		expect(families.has("veins")).toBe(true);
		for (const f of families) expect(ART_FAMILIES).toContain(f);
		expect(artStyleFor("Matematica")).toBe(motifFor("Matematica", ART_STYLES));
	});

	it("every rule lists real families and unique topic ids", () => {
		const ids = new Set<string>();
		for (const t of TOPICS) {
			expect(ids.has(t.id)).toBe(false);
			ids.add(t.id);
			expect(t.families.length).toBeGreaterThan(0);
			for (const f of t.families) expect(ART_FAMILIES).toContain(f);
			expect(t.stems.length).toBeGreaterThan(0);
		}
	});

	it("a spec without a style gets its family from the title, then the seed", () => {
		const bio = logOf({ seed: "x1", title: "Biologia", color: "#22C55E" });
		const same = logOf({ seed: "x1", style: artFamilyFor("Biologia"), color: "#22C55E" });
		expect(bio).toEqual(same);
		const bySeed = logOf({ seed: "Fisica", color: "#22C55E" });
		expect(bySeed).toEqual(logOf({ seed: "Fisica", style: artFamilyFor("Fisica"), color: "#22C55E" }));
	});
});

describe("veins (space colonization)", () => {
	it("is deterministic and differs between seeds", () => {
		expect(logOf(spec())).toEqual(logOf(spec()));
		const seen = new Set<number>();
		for (const seed of ["Anatomia", "Botanica", "Foglie", "Nervi", "Radici", "Alberi"]) seen.add(hashString(logOf(spec({ seed })).join("\n")));
		expect(seen.size).toBe(6);
	});

	it("draws real venation (hundreds of segments) in the three layouts, with finite coordinates, on cards, covers and empty states", () => {
		const modes = new Set<string>();
		for (let i = 0; i < 24; i++) {
			const log = logOf(spec({ seed: `Mode ${i}` }));
			const segments = log.filter((l) => l.startsWith("L(")).length;
			expect(segments, `seed ${i}`).toBeGreaterThan(150);
			expect(log.some((l) => /NaN|Infinity/.test(l))).toBe(false);
			// A closed outline (leaf) is the one layout with closePath.
			modes.add(log.some((l) => l === "closePath()") ? "leaf" : segments > 700 ? "dense" : "open");
		}
		expect(modes.size).toBeGreaterThan(1);
		for (const [w, h] of [[240, 160], [150, 210], [1200, 160], [96, 120]] as const) {
			const log = logOf(spec({ seed: "Sizes" }), w, h);
			expect(log.some((l) => /NaN|Infinity/.test(l)), `${w}x${h}`).toBe(false);
		}
	});

	it("stays cheap: the geometry of a card is built in a few milliseconds", () => {
		const ctx = new LoggingContext();
		drawArtLayer(ctx, 600, 200, spec({ seed: "warm" }));
		const t0 = performance.now();
		for (let i = 0; i < 6; i++) drawArtLayer(new LoggingContext(), 600, 200, spec({ seed: `Perf ${i}`, density: 1, growth: 1 }));
		expect((performance.now() - t0) / 6).toBeLessThan(80);
	});
});

describe("growth", () => {
	it("growthForPages rises smoothly from 0 and stays below 1", () => {
		expect(growthForPages(0)).toBe(0);
		expect(growthForPages(Number.NaN)).toBe(0);
		expect(growthForPages(-3)).toBe(0);
		let prev = 0;
		for (const n of [1, 5, 10, 20, 40, 80, 160, 1000]) {
			const g = growthForPages(n);
			expect(g).toBeGreaterThan(prev);
			expect(g).toBeLessThanOrEqual(1);
			prev = g;
		}
		expect(growthForPages(10)).toBeGreaterThan(0.15);
		expect(growthForPages(10)).toBeLessThan(0.3);
	});

	it("every family gets richer with growth, deterministically", () => {
		for (const style of ART_FAMILIES) {
			const ops = (growth: number): number => logOf({ seed: "Growth", color: "#6366F1", style, growth }).length;
			const a = ops(0), b = ops(0.5), c = ops(1);
			expect(b, style).toBeGreaterThan(a);
			expect(c, style).toBeGreaterThan(b);
			expect(logOf({ seed: "Growth", color: "#6366F1", style, growth: 1 })).toEqual(logOf({ seed: "Growth", color: "#6366F1", style, growth: 1 }));
		}
	});

	it("is drawn in quarters: nearby values give one picture, bad values mean zero", () => {
		const h = (growth: number | undefined): string => hashString(logOf(spec({ growth })).join("\n")).toString();
		expect(h(0.1)).toBe(h(0));
		expect(h(0.13)).toBe(h(0.25));
		expect(h(0.26)).toBe(h(0.25));
		expect(h(0.2)).not.toBe(h(0.5));
		expect(h(Number.NaN)).toBe(h(undefined));
		expect(h(7)).toBe(h(1));
		expect(h(-1)).toBe(h(0));
	});

	it("the image cache keys on growth", () => {
		setArtCanvasFactory(() => new FakeCanvas());
		setArtPersistence(null);
		const a = artImage(spec({ growth: 0 }), 300, 100, 1), b = artImage(spec({ growth: 1 }), 300, 100, 1);
		expect(a).not.toBe(b);
		expect(artImage(spec({ growth: 0.1 }), 300, 100, 1)).toBe(a);
	});
});

describe("glow passes", () => {
	it("a glow path is stroked three times on a small surface and twice on a wide band, always ending with the crisp line", () => {
		const widths = (w: number, h: number): number[] => {
			const ctx = new LoggingContext();
			drawArtLayer(ctx, w, h, { seed: "Glow", color: "#2F80F7", style: "orbits" });
			return ctx.log.filter((l) => l.startsWith("stroke(")).map((l) => Number(l.slice(7, -1).split(",")[0]));
		};
		const small = widths(600, 200), band = widths(1600, 240);
		// Wide passes (width > 4) exist only with the halo; the crisp lines are all thin.
		expect(small.filter((x) => x > 6).length).toBeGreaterThan(0);
		expect(band.filter((x) => x > 6).length).toBe(0);
		expect(Math.min(...small)).toBeLessThan(1);
	});
});

/** A fake canvas: its "PNG" is a hash of the drawing log. */
class FakeCanvas implements ArtCanvas {
	width = 0;
	height = 0;
	private ctx = new LoggingContext();
	getContext(): ImageContext {
		this.ctx = new LoggingContext();
		return this.ctx;
	}
	toDataURL(): string {
		return `data:image/png;base64,${this.width}x${this.height}-${hashString(this.ctx.log.join("\n")).toString(16)}`;
	}
}

function memoryStore(): ArtStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		get: (k) => Promise.resolve(map.get(k)),
		put: (k, u) => {
			map.set(k, u);
			return Promise.resolve();
		},
		recent: (n) => Promise.resolve([...map].reverse().slice(0, n)),
		clear: () => {
			map.clear();
			return Promise.resolve();
		},
	};
}

describe("recording and replay", () => {
	it("replaying a recording draws exactly what the families drew", () => {
		for (const style of ART_FAMILIES) {
			const s: ArtSpec = { seed: "Replay", color: "#EC4899", style, growth: 0.5 };
			const direct = new LoggingContext();
			drawArtLayer(direct, 400, 160, s);
			const rec = new RecordingCanvasContext();
			drawArtLayer(rec, 400, 160, s);
			const replayed = new LoggingContext();
			replayOps(replayed, rec.ops, rec.strings);
			expect(replayed.log, style).toEqual(direct.log);
		}
	});

	it("covers (gradients, fills) replay exactly too", async () => {
		const { drawCover } = await import("../src/ui/art/generative-art");
		const direct = new LoggingContext();
		drawCover(direct, 150, 210, { seed: "Cover", color: "#F59E0B", style: "cells" });
		const rec = new RecordingCanvasContext();
		drawCover(rec, 150, 210, { seed: "Cover", color: "#F59E0B", style: "cells" });
		const replayed = new LoggingContext();
		replayOps(replayed, rec.ops, rec.strings);
		expect(replayed.log).toEqual(direct.log);
	});

	it("the worker handler, run against fake worker globals, answers with a data URL of the same drawing", async () => {
		const s: ArtSpec = { seed: "Script", color: "#8B5CF6", style: "waves" };
		const rec = new RecordingCanvasContext();
		drawArtLayer(rec, 300, 100, s);
		const canvasLog = new LoggingContext();
		class FakeOffscreen {
			constructor(readonly width: number, readonly height: number) {}
			getContext(): LoggingContext {
				return canvasLog;
			}
			convertToBlob(): Promise<string> {
				return Promise.resolve("blob");
			}
		}
		class FakeReaderSync {
			readAsDataURL(b: string): string {
				return `data:image/png;base64,${b}`;
			}
		}
		const posted: unknown[] = [];
		const scope: WorkerScope = { onmessage: null, postMessage: (m) => posted.push(m) };
		workerMain(scope, FakeOffscreen, FakeReaderSync, replayOps);
		const request: WorkerRequest = { id: 7, pw: 600, ph: 200, dpr: 2, ops: rec.ops, strings: rec.strings };
		scope.onmessage?.({ data: request });
		await sleep(0);
		expect(posted).toEqual([{ id: 7, url: "data:image/png;base64,blob" }]);
		const direct = new LoggingContext();
		direct.setTransform(2, 0, 0, 2, 0, 0);
		drawArtLayer(direct, 300, 100, s);
		expect(canvasLog.log).toEqual(direct.log);
		// The text that really goes into the worker carries both functions and calls the handler with the worker globals.
		const source = workerSource();
		expect(source).toContain("const replay=");
		expect(source).toContain("main(self,OffscreenCanvas,FileReaderSync,replay);");
		expect(source).toContain("convertToBlob");
	});

	it("the worker handler answers with an error when the canvas cannot be made", () => {
		const posted: unknown[] = [];
		const scope: WorkerScope = { onmessage: null, postMessage: (m) => posted.push(m) };
		class NoContext {
			getContext(): null {
				return null;
			}
			convertToBlob(): Promise<string> {
				return Promise.resolve("");
			}
		}
		workerMain(scope, NoContext, class { readAsDataURL(): string { return ""; } }, replayOps);
		scope.onmessage?.({ data: { id: 3, pw: 10, ph: 10, dpr: 1, ops: [], strings: [] } });
		expect(posted).toEqual([{ id: 3, error: "no 2d context" }]);
	});
});

/** A fake worker that replays the recording in-process and answers like the real script. */
function fakeWorker(mode: "ok" | "error" | "silent" = "ok"): { make: () => WorkerLike; jobs: number } {
	const state = { jobs: 0, make: (): WorkerLike => {
		const w: WorkerLike = {
			onmessage: null,
			onerror: null,
			terminate: () => undefined,
			postMessage: (m) => {
				state.jobs++;
				const job = m as { id: number; ops: number[]; strings: string[]; pw: number; ph: number };
				if (mode === "silent") return;
				queueMicrotask(() => {
					if (mode === "error") {
						w.onmessage?.({ data: { id: job.id, error: "boom" } });
						return;
					}
					const ctx = new LoggingContext();
					replayOps(ctx, job.ops, job.strings);
					w.onmessage?.({ data: { id: job.id, url: `data:image/png;base64,W${job.pw}x${job.ph}-${hashString(ctx.log.join("\n")).toString(16)}` } });
				});
			},
		};
		return w;
	} };
	return state;
}

describe("pipeline: memory, IndexedDB, worker, main thread", () => {
	beforeEach(() => {
		setArtCanvasFactory(() => new FakeCanvas());
		setArtPersistence(null);
		setArtWorkerFactory(null);
		resetArtFailures();
		clearArtCache();
	});

	it("without a worker or IndexedDB the async functions still deliver, on the main thread, and agree with the sync ones", async () => {
		const s = spec({ seed: "Plain" });
		const url = await artImageAsync(s, 300, 100, 1);
		expect(url.startsWith("data:image/png")).toBe(true);
		clearArtCache();
		expect(artImage(s, 300, 100, 1)).toBe(url);
		expect(await coverImageAsync(s, 150, 210, 1)).toMatch(/^data:image\/png/);
	});

	it("renders in the worker when there is one, caches the result and shares concurrent requests", async () => {
		const fw = fakeWorker();
		setArtWorkerFactory(fw.make);
		const before = artPipelineStats().workerRenders;
		const s = spec({ seed: "Worker" });
		const [a, b] = await Promise.all([artImageAsync(s, 300, 100, 2), artImageAsync(s, 300, 100, 2)]);
		expect(a).toBe(b);
		expect(a).toMatch(/^data:image\/png;base64,W600x200-/);
		expect(fw.jobs).toBe(1);
		expect(artPipelineStats().workerRenders).toBe(before + 1);
		expect(await artImageAsync(s, 300, 100, 2)).toBe(a);
		expect(fw.jobs).toBe(1);
		expect(artImage(s, 300, 100, 2)).toBe(a);
		disposeArtWorker();
	});

	it("falls back to the main thread when the worker fails, and stops trying the worker after two failures", async () => {
		const fw = fakeWorker("error");
		setArtWorkerFactory(fw.make);
		const one = await artImageAsync(spec({ seed: "Fail 1" }), 200, 80, 1);
		expect(one).toMatch(/^data:image\/png;base64,200x80-/);
		await artImageAsync(spec({ seed: "Fail 2" }), 200, 80, 1);
		await artImageAsync(spec({ seed: "Fail 3" }), 200, 80, 1);
		expect(fw.jobs).toBe(2);
		expect(artPipelineStats().worker).toBe(false);
		// Worker trouble is not a drawing failure: the engine is still on.
		expect(await artImageAsync(spec({ seed: "Still on" }), 200, 80, 1)).not.toBe("");
	});

	it("persists what it renders and finds it again after the memory cache is gone", async () => {
		const store = memoryStore();
		setArtPersistence(store);
		const s = spec({ seed: "Persist" });
		const url = await artImageAsync(s, 300, 100, 1);
		await sleep(5);
		expect(store.map.size).toBe(1);
		expect([...store.map.keys()][0]).toMatch(/^13\.1\|art\|/);
		clearArtCache();
		const hits = artPipelineStats().persistHits;
		expect(await artImageAsync(s, 300, 100, 1)).toBe(url);
		expect(artPipelineStats().persistHits).toBe(hits + 1);
	});

	it("warms the memory cache from the store, ignoring entries of another engine version", async () => {
		const store = memoryStore();
		setArtPersistence(store);
		const s = spec({ seed: "Warm" });
		const url = await artImageAsync(s, 300, 100, 1);
		await sleep(5);
		expect(store.map.size).toBe(1);
		store.map.set("9.9|art|old", "data:image/png;base64,old");
		clearArtCache();
		setArtPersistence(store);
		expect(await warmArtCache()).toBe(1);
		expect(artPipelineStats().hydrated).toBeGreaterThan(0);
		// Now a synchronous call is a memory hit with the stored picture.
		const hits = artCacheStats().hits;
		expect(artImage(s, 300, 100, 1)).toBe(url);
		expect(artCacheStats().hits).toBe(hits + 1);
		expect(await warmArtCache()).toBe(0);
	});

	it("keeps working when the store throws, and never blocks on a store that does not answer", async () => {
		const broken: ArtStore = {
			get: () => Promise.reject(new Error("idb down")),
			put: () => Promise.reject(new Error("idb down")),
			recent: () => Promise.reject(new Error("idb down")),
			clear: () => Promise.reject(new Error("idb down")),
		};
		setArtPersistence(broken);
		// A rejecting `get` is a failure of the async path (it counts towards the guard) but never an exception for the caller.
		expect(typeof (await artImageAsync(spec({ seed: "Broken" }), 200, 80, 1))).toBe("string");
		expect(await warmArtCache()).toBe(0);
		resetArtFailures();
	});

	it("the IndexedDB store is null without IndexedDB and empty when opening fails", async () => {
		expect(createIdbStore()).toBeNull();
		const store = createIdbStore({ open: () => { throw new Error("blocked"); } } as unknown as IDBFactory);
		expect(store).not.toBeNull();
		expect(await store!.get("k")).toBeUndefined();
		await expect(store!.put("k", "u")).resolves.toBeUndefined();
		expect(await store!.recent(5)).toEqual([]);
	});

	it("prewarm prepares pictures and counts them; switched off, nothing is made", async () => {
		const n = await prewarmArt([
			{ kind: "art", spec: spec({ seed: "P1" }), w: 300, h: 100, dpr: 1 },
			{ kind: "cover", spec: spec({ seed: "P2" }), w: 150, h: 210, dpr: 1 },
			{ kind: "empty", spec: spec({ seed: "P3" }), w: 240, h: 160, dpr: 1 },
		]);
		expect(n).toBe(3);
		expect(artImage(spec({ seed: "P1" }), 300, 100, 1)).toMatch(/^data:image\/png/);
	});

	it("three drawing failures still switch the engine off (the 0.12.3 guard), async or not", async () => {
		setArtCanvasFactory(() => {
			throw new Error("no canvas");
		});
		for (let i = 0; i < 3; i++) expect(await artImageAsync(spec({ seed: `Guard ${i}` }), 200, 80, 1)).toBe("");
		setArtCanvasFactory(() => new FakeCanvas());
		// The factory reset clears the failures; fail again and check the sync side is off too.
		setArtCanvasFactory(() => {
			throw new Error("no canvas");
		});
		for (let i = 0; i < 3; i++) await artImageAsync(spec({ seed: `Guard b${i}` }), 200, 80, 1);
		const { artFailures } = await import("../src/ui/art/generative-art");
		expect(artFailures().off).toBe(true);
		expect(artImage(spec({ seed: "After" }), 200, 80, 1)).toBe("");
		expect(await artImageAsync(spec({ seed: "After 2" }), 200, 80, 1)).toBe("");
	});
});
