import { describe, expect, it } from "vitest";
import { InkBuilder, inkPath, SvgPathSink } from "../src/ink/ink-geometry";
import { strokeOutline, strokePath, strokeSvgPath } from "../src/ink/stroke-shape";
import { lodSvgPath } from "../src/ink/lod";
import { pageToSvg } from "../src/ink/export-svg";
import { createPage, createStroke } from "../src/model/document";
import { RENDER_FREEHAND, RENDER_INK, type Point, type Tool } from "../src/model/types";

/**
 * 0.22 (pens): the new pens must not change how the three existing ones look. These hashes were taken from the code as it was before
 * the fountain pen, brush and marker existed (0.21.0); a change in the outline or the ink geometry of "pen", "highlighter" or "shape"
 * changes how every existing file looks, so a failure here is a regression, never a number to update.
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

const LINE: Point[] = [[10, 10, 0.5], [60, 12, 0.6], [120, 9, 0.4], [200, 14, 0.7]];
const DOT: Point[] = [[5, 5, 0.5]];
const SHAPES: Array<[string, Point[]]> = [["long", sample(300, 1)], ["short", sample(12, 2)], ["line", LINE], ["dot", DOT], ["two", [[1, 1, 0.5], [3, 4, 0.9]]]];
const TOOLS_BEFORE: Tool[] = ["pen", "highlighter", "shape"];

function everything(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const tool of TOOLS_BEFORE) {
		for (const [name, pts] of SHAPES) {
			const key = `${tool}/${name}`;
			out[`outline ${key}`] = hash(JSON.stringify(strokeOutline(pts, 2.4, true, tool)));
			out[`outline-live ${key}`] = hash(strokePath(pts, 2.4, false, tool));
			out[`svg1 ${key}`] = hash(strokeSvgPath({ points: pts, width: 3, tool, render: RENDER_FREEHAND }));
			out[`svg2 ${key}`] = hash(strokeSvgPath({ points: pts, width: 3, tool, render: RENDER_INK }));
			const g = InkBuilder.fromPoints(pts, 3, tool);
			out[`nodes ${key}`] = hash(JSON.stringify([g.nodeCount, Array.from(g.nx.subarray(0, g.nodeCount)), Array.from(g.ny.subarray(0, g.nodeCount)), Array.from(g.nr.subarray(0, g.nodeCount))]));
			const sink = new SvgPathSink();
			inkPath(sink, pts, 3, tool);
			out[`inkpath ${key}`] = hash(sink.d);
			out[`lod ${key}`] = hash(lodSvgPath({ points: pts, width: 3, tool, render: RENDER_INK }, 3, 2));
		}
	}
	const page = createPage();
	for (const tool of TOOLS_BEFORE) {
		const s = createStroke("#112233", 3, sample(80, 7), tool, RENDER_INK);
		page.strokes.push(s);
		const f = createStroke("#332211", 2, sample(40, 9), tool, RENDER_FREEHAND);
		page.strokes.push({ ...f, id: `${f.id}-f` });
	}
	// Ids are random: the export hashes only the geometry and the paint.
	out["svg export"] = hash(pageToSvg(page).replace(/id="[^"]*"/g, ""));
	return out;
}

const GOLDEN: Record<string, string> = {
	"outline pen/long": "19e3e654ddbd355a",
	"outline-live pen/long": "44d8b59d810944f3",
	"svg1 pen/long": "a0040b4d0127eb8b",
	"svg2 pen/long": "fd668e21428c28e7",
	"nodes pen/long": "4e14540324246611",
	"inkpath pen/long": "fd668e21428c28e7",
	"lod pen/long": "e13475e8702f072e",
	"outline pen/short": "fd250e26fe638f34",
	"outline-live pen/short": "993b2cfa68dadc1c",
	"svg1 pen/short": "2dfda85d2a002587",
	"svg2 pen/short": "c2b7a4ad52054773",
	"nodes pen/short": "af54dd9c90535f82",
	"inkpath pen/short": "c2b7a4ad52054773",
	"lod pen/short": "76b0e5628c35ba18",
	"outline pen/line": "041e78e4008282fe",
	"outline-live pen/line": "8d0a1224bab9e466",
	"svg1 pen/line": "c99391cdb3aed177",
	"svg2 pen/line": "19a1a96678afa7e4",
	"nodes pen/line": "a14cf60c783e4e72",
	"inkpath pen/line": "19a1a96678afa7e4",
	"lod pen/line": "19a1a96678afa7e4",
	"outline pen/dot": "ae4e6ff298f850ac",
	"outline-live pen/dot": "3ac93d0f90f95ce5",
	"svg1 pen/dot": "be478f79301aaa63",
	"svg2 pen/dot": "a5da0d5b55febfc5",
	"nodes pen/dot": "70488284980d24ce",
	"inkpath pen/dot": "a5da0d5b55febfc5",
	"lod pen/dot": "a5da0d5b55febfc5",
	"outline pen/two": "8073ba581a816c82",
	"outline-live pen/two": "542dd446db730f80",
	"svg1 pen/two": "0ccdf881cd1afe8b",
	"svg2 pen/two": "024b41924acbda2c",
	"nodes pen/two": "18e1fb10b7ba23f6",
	"inkpath pen/two": "024b41924acbda2c",
	"lod pen/two": "024b41924acbda2c",
	"outline highlighter/long": "2a87b3289d7f61e2",
	"outline-live highlighter/long": "6990851a23361f5c",
	"svg1 highlighter/long": "93264438c83180fa",
	"svg2 highlighter/long": "ee7b5b77c57d39f9",
	"nodes highlighter/long": "101b740b218b9191",
	"inkpath highlighter/long": "ee7b5b77c57d39f9",
	"lod highlighter/long": "2ff3e3842fdda546",
	"outline highlighter/short": "71e132d323f0b8a9",
	"outline-live highlighter/short": "0e1244761e67f740",
	"svg1 highlighter/short": "6c61c3db3a41b2b1",
	"svg2 highlighter/short": "98de78c278e52d0c",
	"nodes highlighter/short": "31ee5f4a14ccfbb4",
	"inkpath highlighter/short": "98de78c278e52d0c",
	"lod highlighter/short": "16f3c187e7f8d959",
	"outline highlighter/line": "955dc6364fd32b20",
	"outline-live highlighter/line": "7a55527db6142bdb",
	"svg1 highlighter/line": "b819fd98c7a0ccda",
	"svg2 highlighter/line": "d3804c4b33e29dcd",
	"nodes highlighter/line": "1bf87ab27697fa6c",
	"inkpath highlighter/line": "d3804c4b33e29dcd",
	"lod highlighter/line": "d3804c4b33e29dcd",
	"outline highlighter/dot": "2986dd11bbcff00b",
	"outline-live highlighter/dot": "6078daddfebfd1b7",
	"svg1 highlighter/dot": "963b57d8c13d876e",
	"svg2 highlighter/dot": "a5da0d5b55febfc5",
	"nodes highlighter/dot": "70488284980d24ce",
	"inkpath highlighter/dot": "a5da0d5b55febfc5",
	"lod highlighter/dot": "a5da0d5b55febfc5",
	"outline highlighter/two": "211a0a5f51f8d385",
	"outline-live highlighter/two": "b83b37626311843c",
	"svg1 highlighter/two": "5ba2051bd07a9ac1",
	"svg2 highlighter/two": "2a8248961c3d3a48",
	"nodes highlighter/two": "679486385e65b422",
	"inkpath highlighter/two": "2a8248961c3d3a48",
	"lod highlighter/two": "2a8248961c3d3a48",
	"outline shape/long": "a39271a5c85ffb47",
	"outline-live shape/long": "5c592983d2ad17b5",
	"svg1 shape/long": "c95032a9fd53095f",
	"svg2 shape/long": "ee7b5b77c57d39f9",
	"nodes shape/long": "101b740b218b9191",
	"inkpath shape/long": "ee7b5b77c57d39f9",
	"lod shape/long": "2ff3e3842fdda546",
	"outline shape/short": "70399d2d3a7dacb3",
	"outline-live shape/short": "75b73db9f4949a43",
	"svg1 shape/short": "694b485eefc9a55c",
	"svg2 shape/short": "98de78c278e52d0c",
	"nodes shape/short": "31ee5f4a14ccfbb4",
	"inkpath shape/short": "98de78c278e52d0c",
	"lod shape/short": "16f3c187e7f8d959",
	"outline shape/line": "98ac1c97522b4961",
	"outline-live shape/line": "95bc8ffdfd0e00d3",
	"svg1 shape/line": "689f6b9aef1c3714",
	"svg2 shape/line": "d3804c4b33e29dcd",
	"nodes shape/line": "1bf87ab27697fa6c",
	"inkpath shape/line": "d3804c4b33e29dcd",
	"lod shape/line": "d3804c4b33e29dcd",
	"outline shape/dot": "ae4e6ff298f850ac",
	"outline-live shape/dot": "f583b3fb16745081",
	"svg1 shape/dot": "be478f79301aaa63",
	"svg2 shape/dot": "a5da0d5b55febfc5",
	"nodes shape/dot": "70488284980d24ce",
	"inkpath shape/dot": "a5da0d5b55febfc5",
	"lod shape/dot": "a5da0d5b55febfc5",
	"outline shape/two": "82f6e79309cf5bc1",
	"outline-live shape/two": "c5f92fd49f9e4e02",
	"svg1 shape/two": "0ccdf881cd1afe8b",
	"svg2 shape/two": "2a8248961c3d3a48",
	"nodes shape/two": "679486385e65b422",
	"inkpath shape/two": "2a8248961c3d3a48",
	"lod shape/two": "2a8248961c3d3a48",
	"svg export": "d1bf96a3b9c71651",
};

describe("pens: the geometry of the existing pens is frozen", () => {
	const actual = everything();
	it("covers every tool and shape", () => {
		expect(Object.keys(actual).length).toBe(3 * 5 * 7 + 1);
	});
	it("pen, highlighter and shape keep their exact outlines, nodes, paths and export", () => {
		if (Object.keys(GOLDEN).length === 0) throw new Error(JSON.stringify(actual, null, 1));
		expect(actual).toEqual(GOLDEN);
	});
});
