/**
 * Smoke check of the magnetic snap and alignment guides (0.17, roadmap #71) on the `doc=snap` notebook (the blank "New"
 * notebook; npm run harness:check): the real view with synthetic pen and touch events. Two strokes are written, one is
 * selected and dragged with the lasso so that its left edge ends 2 pt beside the other's: with the setting on it lands
 * exactly on it; with the setting off, with the Snap button paused, with a finger held on the screen and with the
 * Snap button back on it behaves as it should; the guides exist during the drag and are gone after it. It leaves a drag
 * in progress (pointer still down) so the screenshot shows the guides over the page.
 */
import type { NotebookSettings } from "../../src/settings";
import { strokeBounds } from "../../src/ink/hit-test";
import type { Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SnapCheckApi {
	view: unknown;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

/** The members of the real view this check reads or calls with more detail than `HarnessView` declares. */
interface SnapView extends HarnessView {
	host: { settings: NotebookSettings };
	selection: { strokes: Stroke[]; guides?: unknown[] } | null;
	toggleSnap(): void;
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
}

export async function checkSnap(api: SnapCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as SnapView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const page = () => v.document.pages[v.currentPage()]!;
	const ctx = () => v.uiContext() as unknown as { toggles: { snap?: boolean; snapAvailable?: boolean } };
	const settings = v.host.settings;
	const scale = () => v.viewport.scale;
	const stageRect = () => api.stage().getBoundingClientRect();
	// A drag of the selection by `dxPage` points to the right, as a pen drag that starts on the selected stroke.
	const dragBy = async (from: [number, number], dxPage: number, opts: { pointerType?: string } = {}) => {
		const df = (dxPage * scale()) / stageRect().width;
		await penStroke([from, [from[0] + df, from[1]]], opts);
	};
	settings.snapMode = "both";
	settings.snapStrength = 10;
	setTool("pen");
	const before = page().strokes.length;
	await penStroke([[0.55, 0.25], [0.8, 0.25]]);
	await penStroke([[0.15, 0.6], [0.35, 0.6]]);
	const strokes = page().strokes;
	add("two strokes were written", strokes.length === before + 2, `${before} -> ${strokes.length}`);
	const other = strokes[strokes.length - 2]!;
	let moving = strokes[strokes.length - 1]!;
	const otherLeft = strokeBounds(other).minX;
	// Where a stroke is on the stage, as a fraction of its width: the written stroke's centre is at 0.25, and a page point moves by scale / width.
	const centre0 = (strokeBounds(moving).minX + strokeBounds(moving).maxX) / 2;
	const startOf = (s: Stroke): [number, number] => [0.25 + (((strokeBounds(s).minX + strokeBounds(s).maxX) / 2 - centre0) * scale()) / stageRect().width, 0.6];

	const select = async (s: Stroke) => {
		setTool("lasso");
		v.selectItems(v.currentPage(), [s], []);
		await frames(3);
	};
	// A drag shorter than the tap slop is a tap: park the selection well to the right (snap off) so the test drag is a real one.
	const park = async () => {
		const mode = settings.snapMode;
		settings.snapMode = "off";
		const s0 = v.selection!.strokes[0]!;
		await dragBy(startOf(s0), otherLeft + 80 - strokeBounds(s0).minX);
		await frames(2);
		settings.snapMode = mode;
	};
	const leftOfSelection = (): number => strokeBounds(v.selection!.strokes[0]!).minX;

	// --- snap on: the left edge lands exactly on the other stroke's left edge ---
	await select(moving);
	add("the selection bar offers Snap, on", ctx().toggles.snapAvailable === true && ctx().toggles.snap === true);
	const gap0 = otherLeft - strokeBounds(moving).minX;
	await dragBy(startOf(moving), gap0 + 2);
	await frames(3);
	add("snap on: the left edge lands on the other stroke's edge", Math.abs(leftOfSelection() - otherLeft) < 0.06, `${leftOfSelection()} vs ${otherLeft}`);
	moving = v.selection!.strokes[0]!;
	add("the guides are gone after the drag", !v.selection?.guides);

	// --- snap off in the settings ---
	settings.snapMode = "off";
	await frames(2);
	add("the selection bar does not offer Snap while the setting is off", ctx().toggles.snapAvailable === false);
	await park();
	moving = v.selection!.strokes[0]!;
	const left1 = strokeBounds(moving).minX;
	await dragBy(startOf(moving), -(left1 - otherLeft) + 2);
	await frames(3);
	add("setting off: the edge stays where it was dragged (2 pt off)", Math.abs(leftOfSelection() - (otherLeft + 2)) < 0.3, `${leftOfSelection() - otherLeft} pt from the edge`);
	settings.snapMode = "both";
	await frames(2);

	// --- paused with the Snap button ---
	v.toggleSnap();
	await frames(2);
	add("the Snap button shows paused", ctx().toggles.snap === false);
	await park();
	moving = v.selection!.strokes[0]!;
	await dragBy(startOf(moving), (otherLeft - strokeBounds(moving).minX) - 3);
	await frames(3);
	add("paused: no pull", Math.abs(leftOfSelection() - (otherLeft - 3)) < 0.3, `${leftOfSelection() - otherLeft} pt from the edge`);
	v.toggleSnap();
	await frames(2);
	add("the Snap button shows on again", ctx().toggles.snap === true);

	// --- a finger held on the screen (the second contact) while the pen drags ---
	const stage = api.stage();
	const r = stageRect();
	const finger = (type: string) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 77, pointerType: "touch", isPrimary: false, width: 8, height: 8, clientX: r.left + r.width * 0.9, clientY: r.top + r.height * 0.9, buttons: type === "pointerup" ? 0 : 1 });
	await park();
	moving = v.selection!.strokes[0]!;
	stage.dispatchEvent(finger("pointerdown"));
	await dragBy(startOf(moving), (otherLeft - strokeBounds(moving).minX) + 2.5);
	await frames(3);
	stage.dispatchEvent(finger("pointerup"));
	add("a finger held: the drag is free", Math.abs(leftOfSelection() - (otherLeft + 2.5)) < 0.3, `${leftOfSelection() - otherLeft} pt from the edge`);

	// --- guides during a drag: leave one in progress for the screenshot ---
	await park();
	moving = v.selection!.strokes[0]!;
	const id = 99;
	const at = (fx: number, fy: number) => ({ clientX: r.left + fx * r.width, clientY: r.top + fy * r.height });
	const ev = (name: string, fx: number, fy: number) => new PointerEvent(name, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: "pen", isPrimary: true, pressure: 0.6, width: 1, height: 1, button: 0, buttons: 1, ...at(fx, fy) });
	const from = startOf(moving);
	const target = document.elementFromPoint(at(from[0], from[1]).clientX, at(from[0], from[1]).clientY) ?? stage;
	const need = (otherLeft - strokeBounds(moving).minX) + 2; // 2 pt past the edge: within the reach
	const df = (need * scale()) / r.width;
	target.dispatchEvent(ev("pointerdown", from[0], from[1]));
	for (let s = 1; s <= 6; s++) {
		target.dispatchEvent(ev("pointermove", from[0] + (df * s) / 6, 0.6));
		await sleep(8);
	}
	await frames(3);
	const guides = v.selection?.guides ?? [];
	add("guides exist during the drag", guides.length > 0, `${guides.length}`);
	const live = api.stage().querySelector<HTMLCanvasElement>("canvas.notebook-canvas-live");
	add("the live canvas exists (the guides are drawn there)", !!live);

	return { ok: results.every((x) => x.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
