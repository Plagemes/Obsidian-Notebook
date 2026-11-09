import { describe, expect, it } from "vitest";
import { InkBuilder, inkPath, SvgPathSink } from "../src/ink/ink-geometry";
import { lodSvgPath } from "../src/ink/lod";
import { strokeSvgPath } from "../src/ink/stroke-shape";
import { RENDER_INK, type Point, type Tool } from "../src/model/types";

/**
 * Review fix R7 (stroke taper, format v25, #351): the geometry of tapered strokes is frozen now that the ramp is final (start taper by arc
 * length, end taper, short strokes). A change in `emit` / `finishTapered` changes every tapered stroke on screen, in the SVG / PDF export
 * and in thumbnails, so a failure here is a regression to look at, never a number to update without knowing why. Strokes without a taper
 * are frozen by tests/pens-golden.test.ts.
 */

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Handwriting-like points (loops, direction changes, varying pressure), already on the file's quantization. */
function sample(n: number, seed: number): Point[] {
	const r = rng(seed);
	const out: Point[] = [];
	for (let i = 0; i < n; i++) {
		const s = i / 60;
		out.push([
			Math.round((100 + 240 * s + 18 * Math.sin(s * 14) + (r() - 0.5) * 0.3) * 100) / 100,
			Math.round((200 + 22 * Math.cos(s * 9) + 9 * Math.sin(s * 23) + (r() - 0.5) * 0.3) * 100) / 100,
			Math.round((0.1 + 0.8 * Math.sin(s * 5) ** 2) * 1000) / 1000,
		]);
	}
	return out;
}

/** FNV-1a over the UTF-16 code units, twice with different seeds (64 bits in all). */
function hash(text: string): string {
	let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const SHAPES: Array<[string, Point[]]> = [["long", sample(300, 1)], ["short", sample(12, 2)], ["tiny", [[1, 1, 0.5], [3, 4, 0.9]]], ["fast", sample(40, 5).filter((_, i) => i % 5 === 0)]];
const TAPERS: Array<[string, { start: number; end: number }]> = [["start", { start: 0.5, end: 0 }], ["end", { start: 0, end: 0.5 }], ["both", { start: 0.4, end: 0.8 }]];
const TOOLS: Tool[] = ["pen", "fountain", "brush"];

function everything(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const tool of TOOLS) {
		for (const [shape, pts] of SHAPES) {
			for (const [kind, taper] of TAPERS) {
				const key = `${tool}/${shape}/${kind}`;
				const g = InkBuilder.fromPoints(pts, 3, tool, new InkBuilder(), undefined, taper);
				out[`nodes ${key}`] = hash(JSON.stringify([g.nodeCount, Array.from(g.nx.subarray(0, g.nodeCount)), Array.from(g.ny.subarray(0, g.nodeCount)), Array.from(g.nr.subarray(0, g.nodeCount))]));
				const sink = new SvgPathSink();
				inkPath(sink, pts, 3, tool, undefined, taper);
				const stroke = { points: pts, width: 3, tool, render: RENDER_INK, taperStart: taper.start || undefined, taperEnd: taper.end || undefined } as const;
				// the export path (a stored stroke) is the live ink path of the same taper
				out[`svg ${key}`] = hash(strokeSvgPath(stroke));
				if (hash(sink.d) !== out[`svg ${key}`]) throw new Error(`export and ink path differ for ${key}`);
				out[`lod ${key}`] = hash(lodSvgPath(stroke, 3, 2));
			}
		}
	}
	return out;
}

const GOLDEN: Record<string, string> = {
	"nodes pen/long/start": "220d38c888d69812", "svg pen/long/start": "401018e7dbd40079", "lod pen/long/start": "ca44b3b9814e514f",
	"nodes pen/long/end": "c25a7fdd0114b2b3", "svg pen/long/end": "4677be0ce4e68b56", "lod pen/long/end": "ecf6584f18281fd9",
	"nodes pen/long/both": "09c4f6f809a418a2", "svg pen/long/both": "af61f5fa688914cc", "lod pen/long/both": "4c9c165339f25d1d",
	"nodes pen/short/start": "8de8872441c3c91e", "svg pen/short/start": "dea23d31683c604b", "lod pen/short/start": "c718646e2c1d74c4",
	"nodes pen/short/end": "29184a4256bdb1d0", "svg pen/short/end": "b8e37d365e1b9cc0", "lod pen/short/end": "6b8122132a9e8799",
	"nodes pen/short/both": "b4b77e853cad354b", "svg pen/short/both": "e665d59a1814fa90", "lod pen/short/both": "b9de3a9edbd9fac8",
	"nodes pen/tiny/start": "e1e542db1a71c4fd", "svg pen/tiny/start": "ec1b859b0d0eadc9", "lod pen/tiny/start": "ec1b859b0d0eadc9",
	"nodes pen/tiny/end": "5dbf9c79459b0a53", "svg pen/tiny/end": "e3a441c000c08f46", "lod pen/tiny/end": "e3a441c000c08f46",
	"nodes pen/tiny/both": "11f064280071380e", "svg pen/tiny/both": "2a5f9656884f8f14", "lod pen/tiny/both": "2a5f9656884f8f14",
	"nodes pen/fast/start": "dbd22a8f668c97e1", "svg pen/fast/start": "569f28eb21dd1c05", "lod pen/fast/start": "866b11f4d71adefe",
	"nodes pen/fast/end": "58fc032dfd0acf73", "svg pen/fast/end": "c9d56bd6442079f4", "lod pen/fast/end": "bd42ff89700ea63b",
	"nodes pen/fast/both": "d80007e90bf3f85b", "svg pen/fast/both": "eea2fc07192ee075", "lod pen/fast/both": "75e14cadaf148f53",
	"nodes fountain/long/start": "4851d0c09115285a", "svg fountain/long/start": "2846a6e760ed714d", "lod fountain/long/start": "88d5a4b24e7b78dc",
	"nodes fountain/long/end": "6dc32c87975d69ed", "svg fountain/long/end": "e00d2abbc72bce59", "lod fountain/long/end": "34852c5dd280bc7f",
	"nodes fountain/long/both": "85da358fa361b28d", "svg fountain/long/both": "9bfe3cbf3c07e165", "lod fountain/long/both": "8c29a9a03680fdb2",
	"nodes fountain/short/start": "62467555c75450a3", "svg fountain/short/start": "58e86882c245e474", "lod fountain/short/start": "290c3db76c7caec9",
	"nodes fountain/short/end": "dfc10c24bbc82d16", "svg fountain/short/end": "90e6259d797ed77f", "lod fountain/short/end": "8d0c6ad10c7d5983",
	"nodes fountain/short/both": "1d0d9e32ad66593c", "svg fountain/short/both": "37ed2ed0708a5c8a", "lod fountain/short/both": "e66bf36aacc0f3dc",
	"nodes fountain/tiny/start": "c75492c888c7708e", "svg fountain/tiny/start": "f2af87ab167ad3ed", "lod fountain/tiny/start": "f2af87ab167ad3ed",
	"nodes fountain/tiny/end": "52db871961ef0ac3", "svg fountain/tiny/end": "e187a932c0da7ca8", "lod fountain/tiny/end": "e187a932c0da7ca8",
	"nodes fountain/tiny/both": "d02ae08eca0f0bc8", "svg fountain/tiny/both": "560f5132dc405300", "lod fountain/tiny/both": "560f5132dc405300",
	"nodes fountain/fast/start": "3a7130266b124210", "svg fountain/fast/start": "422e5543a89d715d", "lod fountain/fast/start": "93e582356cfa321f",
	"nodes fountain/fast/end": "2c145364a897678a", "svg fountain/fast/end": "9d9b60b3b828a0d1", "lod fountain/fast/end": "669695dc4ba88f6e",
	"nodes fountain/fast/both": "b4594bdc960221ca", "svg fountain/fast/both": "7d148a1f67cd8fed", "lod fountain/fast/both": "65fdbbe3cef03075",
	"nodes brush/long/start": "ef74b170268a9f62", "svg brush/long/start": "e10b9eff2bcb9d79", "lod brush/long/start": "079233647b199f36",
	"nodes brush/long/end": "a6d23380d9aa5d1e", "svg brush/long/end": "2d6cdf6e0c2591f8", "lod brush/long/end": "704fc91b6c87ea21",
	"nodes brush/long/both": "6d80044c6538f076", "svg brush/long/both": "6b754e8f872256f5", "lod brush/long/both": "3d213733cc86ed89",
	"nodes brush/short/start": "13ef66ce58b35c44", "svg brush/short/start": "31e226d2c54ba2ac", "lod brush/short/start": "b2c1bd0962f87a13",
	"nodes brush/short/end": "2153ab7ba1473019", "svg brush/short/end": "1e556d74994ba5f2", "lod brush/short/end": "a1c016491b262e17",
	"nodes brush/short/both": "5ba27426e9d10a70", "svg brush/short/both": "01c2ea5c57e46d52", "lod brush/short/both": "d726dcf2bcb8391c",
	"nodes brush/tiny/start": "63c39a24939c2172", "svg brush/tiny/start": "a26edcb9a9b1974f", "lod brush/tiny/start": "a26edcb9a9b1974f",
	"nodes brush/tiny/end": "d972b54965295693", "svg brush/tiny/end": "fd5444fc62d3d89e", "lod brush/tiny/end": "fd5444fc62d3d89e",
	"nodes brush/tiny/both": "16b15ed4076149ee", "svg brush/tiny/both": "119ac59a137e3ad0", "lod brush/tiny/both": "119ac59a137e3ad0",
	"nodes brush/fast/start": "ab7c307821112b76", "svg brush/fast/start": "302ae1ec9cc09c46", "lod brush/fast/start": "823ec1db7d679c59",
	"nodes brush/fast/end": "9693e488dfd4b61a", "svg brush/fast/end": "a0fda94ac78f8880", "lod brush/fast/end": "98818b15bbf08acf",
	"nodes brush/fast/both": "89737df6dcf97824", "svg brush/fast/both": "e63cabb48a7c6692", "lod brush/fast/both": "021d53fa0f1ef2c8",
};

describe("taper: the geometry of tapered strokes is frozen", () => {
	const actual = everything();
	it("covers every pen, shape and taper", () => {
		expect(Object.keys(actual).length).toBe(3 * 4 * 3 * 3);
	});
	it("a taper changes the stroke (the three kinds differ from each other for a long stroke)", () => {
		for (const tool of TOOLS) {
			const set = new Set(TAPERS.map(([kind]) => actual[`svg ${tool}/long/${kind}`]));
			expect(set.size).toBe(3);
		}
	});
	it("tapered strokes keep their exact nodes, paths, export and thumbnail outlines", () => {
		if (Object.keys(GOLDEN).length === 0) throw new Error(JSON.stringify(actual, null, 1));
		expect(actual).toEqual(GOLDEN);
	});
});
