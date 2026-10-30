import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { attachedInk, inkOnRemoved, inkOwner, ownsInk } from "../src/ink/attach";
import { detectScribble, scribbleEraseCommand, scribbleEraseSteps, scribbleVictims } from "../src/ink/scribble";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { createBox, createMarker } from "../src/model/markers";
import type { NotebookDocument, Page, Point, Stroke } from "../src/model/types";

const { gestureWorld, runGesture } = await import("../src/view/pen-gesture-actions");

// --- shared helpers ---

function stroke(points: Array<[number, number]>, width = 2): Stroke {
	return createStroke("#1e1e1e", width, points.map(([x, y]) => quantizePoint(x, y, 0.5)));
}

function hidden(s: Stroke): Stroke {
	return { ...s, hidden: true };
}

/** A handwritten word: tall strokes side by side. */
function word(x0: number, y0: number, n = 6): Stroke[] {
	return Array.from({ length: n }, (_, i) => stroke([[x0 + i * 14, y0 - 10], [x0 + i * 14 + 1, y0], [x0 + i * 14, y0 + 10]]));
}

/** A fast zig-zag scratch sampled every ~1 pt. */
function zigzag(cx = 190, cy = 100, half = 50, legs = 7, pitch = 4): Point[] {
	const vertices: Array<[number, number]> = [];
	for (let i = 0; i <= legs; i++) vertices.push([cx + (i % 2 === 0 ? -half : half), cy + (i - legs / 2) * pitch]);
	const out: Point[] = [];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!, [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
	}
	return out;
}

function docWith(strokes: Stroke[]): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"));
	const page = doc.pages[0]!;
	page.strokes.push(...strokes);
	return { doc, page };
}

// --- 1. scribble erase and pen gestures leave hidden ink alone ---

describe("scribble erase and hidden ink (invisible solutions)", () => {
	it("scratching visible writing does not delete the hidden ink under it", () => {
		const visible = word(150, 100);
		const solution = word(150, 102).map(hidden);
		const { doc, page } = docWith([...visible, ...solution]);
		const cmd = scribbleEraseCommand(page, zigzag(), 500, 2);
		expect(cmd).not.toBeNull();
		new History(() => doc).execute(cmd!);
		expect(page.strokes).toEqual(solution);
	});

	it("deletes hidden ink only while the solutions of the page are shown", () => {
		const solution = word(150, 100).map(hidden);
		const scribble = detectScribble(zigzag(), 500)!;
		expect(scribbleVictims(scribble, solution, 2)).toEqual([]);
		expect(scribbleVictims(scribble, solution, 2, undefined, true)).toEqual(solution);
	});

	it("two-step erase keeps indices against all the strokes of the page", () => {
		const a = hidden(stroke([[10, 10], [20, 20]]));
		const visible = word(150, 100);
		const b = hidden(stroke([[400, 400], [420, 420]]));
		const { doc, page } = docWith([a, ...visible.slice(0, 3), hidden(visible[3]!), ...visible.slice(4), b]);
		const before = [...page.strokes];
		const scratch = stroke(zigzag().map((p) => [p[0], p[1]] as [number, number]));
		const steps = scribbleEraseSteps(page, scratch, 500)!;
		expect(steps).not.toBeNull();
		const history = new History(() => doc);
		history.execute(steps.keep);
		history.execute(steps.erase);
		expect(page.strokes).toEqual([a, before[4], b]);
		history.undo();
		history.undo();
		expect(page.strokes).toEqual(before);
	});

	it("a scribble over hidden ink only is not a scribble erase", () => {
		const { page } = docWith(word(150, 100).map(hidden));
		const scratch = stroke(zigzag().map((p) => [p[0], p[1]] as [number, number]));
		expect(scribbleEraseSteps(page, scratch, 500)).toBeNull();
		expect(scribbleEraseSteps(page, scratch, 500, undefined, {}, true)).not.toBeNull();
	});
});

/** A gesture view on one page at scale 1 (stage px = page pt). */
function gestureView(doc: NotebookDocument, revealed: boolean, executed: unknown[][]) {
	return {
		app: {} as never,
		settings: () => ({ penGestureSpacePt: 40 }) as never,
		doc: () => doc,
		editable: () => true,
		pageIndexAt: () => 0,
		toLocal: (_i: number, p: { x: number; y: number }) => [p.x, p.y] as [number, number],
		stageRect: () => ({ left: 0, top: 0 }) as DOMRect,
		boundsOf: () => undefined,
		revealed: () => revealed,
		selection: () => null,
		selectionHit: () => false,
		selectPolygon: () => undefined,
		clearSelection: () => undefined,
		penStyle: () => ({ color: "#1e1e1e", width: 2 }),
		execute: (commands: unknown[]) => void executed.push(commands),
		editTags: () => undefined,
		openSearch: () => undefined,
	};
}

describe("pen gestures and hidden ink", () => {
	const trail = zigzag().map((p, i) => ({ x: p[0], y: p[1], t: i * 2, p: 0.5 }));
	const loop = Array.from({ length: 40 }, (_, i) => {
		const a = (i / 39) * Math.PI * 2;
		return { x: 190 + Math.cos(a) * 80, y: 100 + Math.sin(a) * 30, t: i * 5, p: 0.5 };
	});

	it("the delete gesture neither counts nor removes hidden ink", () => {
		const visible = word(150, 100);
		const solution = word(150, 102).map(hidden);
		const { doc, page } = docWith([...visible, ...solution]);
		const executed: unknown[][] = [];
		const v = gestureView(doc, false, executed);
		expect(gestureWorld(v).scribbleVictims(trail)).toBe(visible.length);
		runGesture(v, { type: "builtin", id: "delete" } as never, trail);
		expect(executed).toHaveLength(1);
		const history = new History(() => doc);
		for (const c of executed[0]!) history.execute(c as never);
		expect(page.strokes).toEqual(solution);
	});

	it("hidden ink alone is no target of the delete or the circle-select gesture", () => {
		const { doc } = docWith(word(150, 100).map(hidden));
		const shut = gestureView(doc, false, []);
		expect(gestureWorld(shut).scribbleVictims(trail)).toBe(0);
		expect(gestureWorld(shut).enclosedInk(loop)).toBe(0);
		const open = gestureView(doc, true, []);
		expect(gestureWorld(open).scribbleVictims(trail)).toBe(6);
		expect(gestureWorld(open).enclosedInk(loop)).toBe(6);
	});
});

// --- 7. markers and boxes do not own ink; hidden ink is not offered ---

describe("ink ownership: markers and boxes frame the page, they hold no ink", () => {
	it("a box or a region marker never owns the ink inside it", () => {
		const box = createBox("definition", { x: 100, y: 100, width: 200, height: 100 });
		const marker = createMarker("gap", 0, 0, { region: { x: 100, y: 100, width: 200, height: 100 } });
		const inside = stroke([[120, 120], [200, 150], [280, 180]]);
		expect(ownsInk(box)).toBe(false);
		expect(ownsInk(marker)).toBe(false);
		expect(inkOwner(inside, [box])).toBeNull();
		expect(inkOwner(inside, [marker])).toBeNull();
		expect(attachedInk([inside], [box, marker], [box, marker])).toEqual([]);
		expect(inkOnRemoved([inside, hidden(inside)], [box], [box])).toEqual([]);
	});

	it("ink on an image framed by a box still belongs to the image", () => {
		const img = { id: "img1", type: "image" as const, asset: "ab", x: 100, y: 100, width: 200, height: 100, rotation: 0 };
		const box = createBox("example", { x: 90, y: 90, width: 220, height: 120 });
		const s = stroke([[120, 120], [200, 150], [280, 180]]);
		expect(inkOwner(s, [img, box])).toBe(img);
		expect(attachedInk([s], [img, box], [img])).toEqual([s]);
	});
});
