/**
 * Smoke check of the paint bucket (0.28, roadmap #184) on the `doc=bucket` notebook (the blank "New" notebook; HARNESS_DOC=bucket npm run
 * harness:check): the real view, History and renderer. A page holds a closed square, a square with a small gap (closed by the tolerance), a
 * square with a wide gap (open), a circle and two nested squares, all drawn in ink. "Paint bucket" is armed with the registry action and tapped
 * (synthetic pointer events on the page): the area under the tap becomes a filled shape stroke at the back of the page's ink, in the colour in
 * use, as one undo step; a tap that is not enclosed, or on a line, gives one notice and adds nothing; Escape ends the mode. The setting turns the
 * tint into the solid colour. It leaves the filled page on screen for the screenshot (tablet and phone, light and dark).
 */
import { AddStroke, Batch } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { isBucketFill } from "../../src/ink/paint-bucket";
import { RENDER_INK, type NotebookDocument, type Page, type Point, type Stroke } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface BucketCheckApi {
	view: unknown;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface BucketView {
	document: NotebookDocument;
	currentPage(): number;
	applyCommand(command: unknown): void;
	runAction(id: string): void;
	undo(): void;
	redo(): void;
	host: { settings: { bucketTint: boolean } };
	toolbar: { update(patch: Record<string, unknown>): void };
	paintBucket: { armed: boolean } | null;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
}

/** A line through the vertices with a point about every pt. */
function poly(vertices: Array<[number, number]>): Point[] {
	const out: Point[] = [[vertices[0]![0], vertices[0]![1], 0.55]];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!;
		const [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = 1; k <= n; k++) out.push([Math.round((ax + ((bx - ax) * k) / n) * 100) / 100, Math.round((ay + ((by - ay) * k) / n) * 100) / 100, 0.55]);
	}
	return out;
}

export async function checkBucket(api: BucketCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as BucketView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const stageEl = (): HTMLElement => document.querySelector<HTMLElement>(".notebook-stage")!;
	let n = 0;
	const make = (points: Point[]): Stroke => ({ id: `bk-${++n}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points });
	const ring = (cx: number, cy: number, r: number): Point[] =>
		Array.from({ length: 73 }, (_, i): Point => [Math.round((cx + r * Math.cos((i / 72) * Math.PI * 2)) * 100) / 100, Math.round((cy + r * Math.sin((i / 72) * Math.PI * 2)) * 100) / 100, 0.55]);

	api.setTool("pen");
	v.toolbar.update({ penColor: "#e03131" });
	v.host.settings.bucketTint = true;

	// --- the page ---
	const A = make(poly([[40, 60], [180, 60], [180, 200], [40, 200], [40, 60]]));
	const B = make(poly([[298, 60], [220, 60], [220, 200], [360, 200], [360, 60], [301, 60]])); // 3 pt between the ends: 1 pt of paper between the lines
	const C = make(poly([[473, 60], [400, 60], [400, 200], [540, 200], [540, 60], [487, 60]])); // 14 pt between the ends: open
	const D = make(ring(110, 320, 60));
	const E1 = make(poly([[220, 250], [360, 250], [360, 390], [220, 390], [220, 250]]));
	const E2 = make(poly([[260, 290], [320, 290], [320, 350], [260, 350], [260, 290]]));
	const ink = [A, B, C, D, E1, E2];
	v.applyCommand(new Batch("Draw", ink.map((s, i) => new AddStroke(page().id, s, i))));
	await frames(4);
	add("the page holds six shapes drawn in ink", page().strokes.length === 6);

	// --- helpers to tap the page ---
	const clientOf = (x: number, y: number): [number, number] => {
		const r = stageEl().getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [r.left + v.viewport.offsetX + (box.x + x) * v.viewport.scale, r.top + v.viewport.offsetY + (box.y + y) * v.viewport.scale];
	};
	const tap = async (x: number, y: number): Promise<void> => {
		const [cx, cy] = clientOf(x, y);
		const target = stageEl().querySelector("canvas") ?? stageEl();
		const init = { pointerId: 41, pointerType: "pen", isPrimary: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true };
		target.dispatchEvent(new PointerEvent("pointerdown", init));
		target.dispatchEvent(new PointerEvent("pointerup", init));
		await frames(4);
	};
	const pixelAt = (x: number, y: number): number[] => {
		const c = stageEl().querySelector<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
		const [cx, cy] = clientOf(x, y);
		const r = c.getBoundingClientRect();
		const px = Math.floor(((cx - r.left) * c.width) / r.width), py = Math.floor(((cy - r.top) * c.height) / r.height);
		return Array.from(c.getContext("2d")!.getImageData(px, py, 1, 1).data);
	};
	const differs = (a: number[], b: number[]): boolean => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 24;
	const fills = (): Stroke[] => page().strokes.filter(isBucketFill);
	const bounds = (s: Stroke) => ({
		minX: Math.min(...s.points.map((p) => p[0])), maxX: Math.max(...s.points.map((p) => p[0])),
		minY: Math.min(...s.points.map((p) => p[1])), maxY: Math.max(...s.points.map((p) => p[1])),
	});

	// --- a closed square ---
	const before = pixelAt(110, 130);
	v.runAction("paint-bucket");
	await frames(2);
	add("the action arms the bucket and says what to do", v.paintBucket?.armed === true && api.notices.some((m) => /Tap inside an area/.test(m)), api.notices.slice(-1).join(" | "));
	const t0 = performance.now();
	await tap(110, 130);
	const took = performance.now() - t0;
	const first = fills()[0];
	add("a tap inside the square adds one filled shape, at the back", page().strokes.length === 7 && page().strokes[0] === first && !!first);
	add("it is a closed shape stroke with a tint fill in the pen colour", !!first && first.tool === "shape" && first.fill === "#e03131" && first.fillTint === true && first.color === "#e03131", JSON.stringify({ tool: first?.tool, fill: first?.fill, tint: first?.fillTint }));
	const fb = first ? bounds(first) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	add("its polygon (page coordinates) follows the inside of the square", !!first && first.points.length >= 4 && first.points.length <= 12 && fb.minX > 38 && fb.minX < 44 && fb.maxX > 176 && fb.maxX < 182 && fb.minY > 58 && fb.minY < 64 && fb.maxY > 196 && fb.maxY < 202, JSON.stringify(fb));
	add("the mode ended with the fill", v.paintBucket?.armed === false);
	add("the page shows the fill", differs(before, pixelAt(110, 130)), `${before.join(",")} -> ${pixelAt(110, 130).join(",")}`);
	add("the fill took well under the budget", took < 2500, `${took.toFixed(0)} ms`);

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo takes the fill away", page().strokes.length === 6 && fills().length === 0 && !differs(before, pixelAt(110, 130)));
	v.redo();
	await frames(3);
	add("one redo puts it back", page().strokes.length === 7 && fills()[0] === first);

	// --- not enclosed, on a line ---
	const counted = page().strokes.length;
	const noticed = api.notices.length;
	v.runAction("paint-bucket");
	await tap(470, 130);
	add("the square with a wide gap is not enclosed: one notice, nothing added", page().strokes.length === counted && api.notices.slice(noticed).filter((m) => /not closed/.test(m)).length === 1, api.notices.slice(noticed).join(" | "));
	add("it stays armed to try again", v.paintBucket?.armed === true);
	const noticed2 = api.notices.length;
	await tap(40, 130);
	add("a tap on a line says so and adds nothing", page().strokes.length === counted && api.notices.slice(noticed2).some((m) => /on a line/.test(m)), api.notices.slice(noticed2).join(" | "));
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	await frames(2);
	add("Escape ends the mode", v.paintBucket?.armed === false);
	const noticed3 = api.notices.length;
	v.runAction("paint-bucket");
	await tap(10, 10);
	add("the page margin (outside every outline) is open too", page().strokes.length === counted && api.notices.slice(noticed3).some((m) => /not closed/.test(m)));
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

	// --- a small gap is closed ---
	v.runAction("paint-bucket");
	await tap(290, 130);
	const gapFill = fills().find((s) => s !== first);
	const gb = gapFill ? bounds(gapFill) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	add("a square with a small gap is filled, and the fill does not run out of the gap", !!gapFill && gb.minX > 217 && gb.maxX < 363 && gb.minY > 57 && gb.maxY < 203, JSON.stringify(gb));

	// --- solid, a round shape ---
	v.host.settings.bucketTint = false;
	v.runAction("paint-bucket");
	await tap(110, 320);
	const round = fills().find((s) => s !== first && s !== gapFill);
	add("the setting makes a solid fill, and a circle is filled with a simplified outline", !!round && round.fill === "#e03131" && round.fillTint === undefined && round.points.length > 8 && round.points.length < 200, `${round?.points.length} points`);
	v.host.settings.bucketTint = true;

	// --- nested shapes ---
	v.toolbar.update({ penColor: "#2f9e44" });
	v.runAction("paint-bucket");
	await tap(235, 270);
	v.toolbar.update({ penColor: "#1c7ed6" });
	v.runAction("paint-bucket");
	await tap(290, 320);
	const all = fills();
	add("five areas are filled, and every fill lies before all the ink", all.length === 5 && page().strokes.slice(0, 5).every(isBucketFill) && page().strokes.slice(5).every((s) => !isBucketFill(s)) && page().strokes.length === 11, `${all.length} fills of ${page().strokes.length}`);
	add("the inner square keeps its own colour (a later fill lies over an earlier one)", all[4]?.fill === "#1c7ed6" && all[3]?.fill === "#2f9e44");

	// --- writer and reader ---
	const back = parse(serialize(v.document));
	const stored = back.ok ? back.doc.pages[v.currentPage()]!.strokes.filter(isBucketFill) : [];
	add("the writer and the reader keep the five fills (vector polygons)", back.ok && back.dropped === undefined && stored.length === 5 && stored.every((s) => s.points.length >= 4));

	// --- a last look ---
	await frames(3);
	add("no script errors", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length, fills: fills().length } };
}
