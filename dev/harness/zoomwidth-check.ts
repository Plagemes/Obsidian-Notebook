/**
 * "Pen width follows zoom" (0.26, roadmap #350) on the real notebook view (doc=zoomwidth, the blank "New" notebook;
 * HARNESS_DOC=zoomwidth npm run harness:check). Off, a stroke keeps the chosen width in page units at any zoom; On, the stored width is the
 * chosen width divided by the zoom (so it looks the chosen size on screen), the pen options show the on-screen width with a "x zoom" hint,
 * and the live stroke and the committed one have the same width. `zoomwidthShot(zoom, on)` leaves the view for the screenshots.
 */
import type { CheckResult } from "./reading-check";

export interface ZoomwidthCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ZoomView {
	document: { pages: Array<{ strokes: Array<{ width: number; tool: string }> }> };
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void };
	host: { settings: { penWidthFollowsZoom: boolean } };
	applySettings(s: unknown): void;
	setViewport(v: { scale: number; offsetX: number; offsetY: number }, interactive?: boolean): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);

function setup(api: ZoomwidthCheckApi, zoom: number, on: boolean): ZoomView {
	const v = api.view as ZoomView;
	v.host.settings.penWidthFollowsZoom = on;
	v.applySettings(v.host.settings);
	const box = v.layout.boxes[v.currentPage()]!;
	v.setViewport({ scale: zoom, offsetX: -(box.x + 20) * zoom, offsetY: -(box.y + 20) * zoom });
	return v;
}

async function write(api: ZoomwidthCheckApi, v: ZoomView, y: number): Promise<number> {
	const r = q(".notebook-stage")!.getBoundingClientRect();
	const box = v.layout.boxes[v.currentPage()]!;
	const f = (px: number, py: number): [number, number] => [(v.viewport.offsetX + (box.x + px) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + py) * v.viewport.scale) / r.height];
	const strokes = v.document.pages[v.currentPage()]!.strokes;
	const before = strokes.length;
	await api.penStroke([f(30, y), f(50, y + 4), f(70, y - 2), f(90, y + 3)], { steps: 12 });
	await api.frames(3);
	return strokes.length > before ? strokes[strokes.length - 1]!.width : NaN;
}

export async function checkZoomwidth(api: ZoomwidthCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		api.setTool("pen");
		const chosen = Number((api.view as ZoomView).toolbar.state.penWidth);
		for (const zoom of [0.5, 1, 4]) {
			const off = await write(api, setup(api, zoom, false), 30);
			add(`off at ${zoom}x keeps the chosen width`, off === chosen, `${off}`);
			const v = setup(api, zoom, true);
			const on = await write(api, v, 60);
			add(`on at ${zoom}x stores chosen / zoom`, Math.abs(on - chosen / zoom) < 1e-9, `${on}`);
			add(`on at ${zoom}x looks the chosen width on screen`, Math.abs(on * zoom - chosen) < 1e-6);
		}
		await api.openOptions("pen");
		setup(api, 4, true);
		await api.frames(3);
		const hint = q<HTMLElement>(".notebook-options .notebook-zoom-hint");
		add("the pen options show the zoom hint when on", !!hint && hint.offsetWidth > 0 && /×/.test(hint.textContent ?? ""), hint?.textContent ?? "");
		// 0.26 integration: the opacity row (#358) shows beside the zoom hint and both apply to the next stroke.
		const opRow = q<HTMLElement>(".notebook-options .notebook-pen-opacity");
		add("the opacity row shows beside the zoom hint", !!opRow && opRow.offsetWidth > 0 && !!hint && hint.offsetWidth > 0);
		const zv = api.view as ZoomView;
		zv.toolbar.update({ penOpacity: 0.5 });
		const strokes = zv.document.pages[zv.currentPage()]!.strokes as Array<{ width: number; opacity?: number }>;
		const w = await write(api, zv, 90);
		const last = strokes[strokes.length - 1]!;
		add("a stroke written with both keeps the on-screen width and the opacity", Math.abs(w - chosen / 4) < 1e-9 && last.opacity === 0.5, `${w} ${last.opacity}`);
		zv.toolbar.update({ penOpacity: 1 });
		setup(api, 4, false);
		await api.frames(3);
		add("the hint is hidden when off", !q<HTMLElement>(".notebook-options .notebook-zoom-hint:not(.notebook-hidden)"));
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

/** Leaves two strokes (as written at this zoom) and the pen options open, for the screenshots. */
export async function zoomwidthShot(api: ZoomwidthCheckApi, zoom: number, on: boolean): Promise<void> {
	const v = setup(api, zoom, on);
	await write(api, v, 40);
	await write(api, v, 70);
	await api.openOptions("pen");
	setup(api, zoom, on);
	await api.frames(4);
}
