/**
 * Smoke check of the clean-up of hooks and stray dots (0.23, roadmap #314) on the `doc=hookclean` notebook (the blank "New" notebook;
 * HARNESS_DOC=hookclean npm run harness:check): the real view and History. A page holds lines with a hook at the start, at the end
 * and at both, an L, an arrow with its barb, a circle (real shapes that must stay), the stem and the dot of an "i" (kept) and a stem
 * with a pen-bounce dot touching it (removed). They are selected and "Clean up strokes" is run from the contextual bar: the hooks go,
 * the shapes and the i-dot stay, the bounce dot goes, one undo gives the page back as it was and a redo does it again. Then the
 * setting "Trim hooks as you write" is tried with the synthetic pen (off: the line is saved as written; on: its hook is cut).
 * It leaves the cleaned page selected, with the action in the bar, for the screenshot.
 */
import { AddStroke, Batch } from "../../src/model/history";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface HookcleanCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface CleanView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	selection: { strokes: Stroke[] } | null;
}

/** A line through the vertices with a point about every `step` pt. */
function poly(vertices: Array<[number, number]>, step = 1): Point[] {
	const out: Point[] = [[vertices[0]![0], vertices[0]![1], 0.55]];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!;
		const [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
		for (let k = 1; k <= n; k++) out.push([Math.round((ax + ((bx - ax) * k) / n) * 100) / 100, Math.round((ay + ((by - ay) * k) / n) * 100) / 100, 0.55]);
	}
	return out;
}

const away = (x: number, y: number, deg: number, len: number): [number, number] => [x + Math.cos((deg * Math.PI) / 180) * len, y + Math.sin((deg * Math.PI) / 180) * len];

export async function checkHookclean(api: HookcleanCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames, penStroke, setTool } = api;
	const v = api.view as CleanView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const settings = v.host.settings as unknown as { trimHooks: boolean };
	let n = 0;
	const make = (points: Point[]): Stroke => ({ id: `hc-${++n}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points });
	const lastOf = (s: Stroke): Point => s.points[s.points.length - 1]!;

	// --- the page ---
	const endHook = make(poly([[60, 100], [200, 100], away(200, 100, 150, 5)]));
	const startHook = make(poly([away(60, 140, 10, 5), [60, 140], [200, 140]]));
	const bothHooks = make(poly([away(60, 180, 20, 5), [60, 180], [200, 180], away(200, 180, 155, 5)]));
	const ell = make(poly([[60, 220], [60, 262], [86, 262]]));
	const arrow = make(poly([[120, 262], [260, 262], away(260, 262, 150, 10)]));
	const circle = make(Array.from({ length: 61 }, (_, i): Point => [Math.round((330 + 16 * Math.cos((i / 60) * Math.PI * 2)) * 100) / 100, Math.round((250 + 16 * Math.sin((i / 60) * Math.PI * 2)) * 100) / 100, 0.55]));
	const iStem = make(poly([[400, 232], [400, 266]]));
	const iDot = make([[400, 222, 0.6]]);
	const bStem = make(poly([[460, 232], [460, 266]]));
	const bounce = make([[461.4, 267.6, 0.4]]);
	const all = [endHook, startHook, bothHooks, ell, arrow, circle, iStem, iDot, bStem, bounce];
	const shapes = [ell, arrow, circle];
	v.applyCommand(new Batch("Draw", all.map((s, i) => new AddStroke(page().id, s, i))));
	await frames(3);
	add("the page holds ten strokes: three with hooks, three real shapes, an i and a bounce", page().strokes.length === 10 && page().strokes.every((s, i) => s === all[i]));

	// --- the action ---
	v.selectItems(0, [...page().strokes], []);
	await frames(3);
	const button = q<HTMLElement>('[data-action="selection-cleanup"]');
	add("the contextual bar offers Clean up strokes", !!button);
	const notices0 = api.notices.length;
	(button ?? undefined)?.click();
	await frames(4);
	const after = page().strokes;
	add("the bounce dot is gone and nothing else was removed", after.length === 9 && !after.includes(bounce) && after.includes(iDot), `${after.length} strokes`);
	add("the three hooked lines were cut and keep their ids", [endHook, startHook, bothHooks].every((s) => {
		const now = after.find((x) => x.id === s.id);
		return !!now && now !== s && now.points.length < s.points.length && now.width === s.width && now.color === s.color;
	}));
	const trimmedEnd = after.find((s) => s.id === endHook.id)!;
	add("the end hook is cut at the corner of the line", Math.abs(lastOf(trimmedEnd)[0] - 200) < 0.05 && Math.abs(lastOf(trimmedEnd)[1] - 100) < 0.05 && trimmedEnd.points[0] === endHook.points[0]);
	const trimmedStart = after.find((s) => s.id === startHook.id)!;
	add("the start hook is cut at the corner of the line", Math.abs(trimmedStart.points[0]![0] - 60) < 0.05 && Math.abs(trimmedStart.points[0]![1] - 140) < 0.05 && lastOf(trimmedStart) === lastOf(startHook));
	add("the L, the arrow and the circle are the very same strokes", shapes.every((s) => after.includes(s)));
	add("the i with its dot, and the stem of the bounce, are untouched", after.includes(iStem) && after.includes(iDot) && after.includes(bStem));
	add("the stroke order is kept", after.map((s) => s.id).join() === all.filter((s) => s !== bounce).map((s) => s.id).join());
	add("a notice tells what was done", api.notices.slice(notices0).some((m) => /3/.test(m) && /1/.test(m)), api.notices.slice(notices0).join(" | "));
	add("the selection stays on the cleaned strokes", (v.selection?.strokes.length ?? 0) === 9 && (v.selection?.strokes ?? []).every((s) => after.includes(s)));
	const cleaned = [...after];

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, in its place", page().strokes.length === 10 && page().strokes.every((s, i) => s === all[i]));
	v.redo();
	await frames(3);
	add("one redo cleans the page again", page().strokes.length === 9 && page().strokes.every((s, i) => s === cleaned[i]));

	// --- a second run finds nothing ---
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	const again = q<HTMLElement>('[data-action="selection-cleanup"]');
	const notices1 = api.notices.length;
	again?.click();
	await frames(3);
	add("cleaning a clean page changes nothing and says so", page().strokes.every((s, i) => s === cleaned[i]) && api.notices.slice(notices1).length >= 1, api.notices.slice(notices1).join(" | "));

	// --- the setting, with the synthetic pen ---
	const stage = q<HTMLElement>(".notebook-stage")!;
	const frac = (x: number, y: number): [number, number] => {
		const r = stage.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	v.clearSelection();
	setTool("pen");
	const hooked = (y: number): Array<[number, number]> => [frac(60, y), frac(150, y), frac(240, y), frac(...away(240, y, 170, 5))];
	const gapToCorner = (s: Stroke | undefined, y: number): number => (s ? Math.hypot(lastOf(s)[0] - 240, lastOf(s)[1] - y) : NaN);
	const countBefore = page().strokes.length;
	settings.trimHooks = false;
	await penStroke(hooked(330), { steps: 10 });
	const plain = page().strokes[countBefore];
	add("with the setting off the stroke is saved as written, hook included", !!plain && page().strokes.length === countBefore + 1 && gapToCorner(plain, 330) > 2.5, `${gapToCorner(plain, 330).toFixed(2)} pt from the corner`);
	settings.trimHooks = true;
	await penStroke(hooked(370), { steps: 10 });
	const trimmed = page().strokes[countBefore + 1];
	add("with the setting on the stroke ends without its hook (a near reversal; the stricter writing-time limits)", !!trimmed && page().strokes.length === countBefore + 2 && gapToCorner(trimmed, 370) < gapToCorner(plain, 330) - 1.5, `${gapToCorner(trimmed, 370).toFixed(2)} pt from the corner`);
	const trimmedId = trimmed?.id;
	v.undo();
	await frames(2);
	add("one undo gives back the stroke as it was written, hook included", page().strokes.length === countBefore + 2 && page().strokes[countBefore + 1]?.id === trimmedId && gapToCorner(page().strokes[countBefore + 1], 370) > 2.5, `${gapToCorner(page().strokes[countBefore + 1], 370).toFixed(2)} pt from the corner`);
	v.undo();
	await frames(2);
	add("a second undo removes the stroke", page().strokes.length === countBefore + 1);
	settings.trimHooks = false;
	v.redo();
	await frames(2);
	v.redo();
	await frames(2);

	// --- the page that stays for the screenshot ---
	v.selectItems(0, page().strokes.slice(0, 9), []);
	await frames(3);
	add("the cleaned page stays selected, with the action in the bar", !!q('[data-action="selection-cleanup"]'));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}
