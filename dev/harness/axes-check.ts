/**
 * Smoke check of instant axes (0.22, roadmap #206) on the "axes" notebook (the blank "New" notebook; npm run harness:check): the
 * real view with synthetic pen events. An L drawn by hand is offered as axes in a chip; taking it replaces the stroke with plain
 * shape strokes and number labels, all in one group, in one undo step; a + of two lines gives four quadrants; a handwritten letter,
 * a curve and a T are not offered; the settings (off, ticks, numbers) are followed; "Axes" in the insert sheet drops four-quadrant
 * axes. It leaves first-quadrant axes, four-quadrant axes and the "Make axes" chip for one more L on the page for the screenshot.
 */
import type { Page, Stroke, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface AxesCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkAxes(api: AxesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const click = async (el: Element | null | undefined) => {
		(el as HTMLElement | null)?.click();
		await frames(2);
	};
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	/** A straight hand-drawn line a to b in page points (dense, a little wobble). */
	const line = (a: [number, number], b: [number, number]): Array<[number, number]> => {
		const n = 14;
		return Array.from({ length: n + 1 }, (_, i) => frac(a[0] + ((b[0] - a[0]) * i) / n + Math.sin(i * 1.7) * 0.4, a[1] + ((b[1] - a[1]) * i) / n));
	};
	const lShape = (x: number, y: number, up: number, right: number): Array<[number, number]> => [...line([x, y - up], [x, y]), ...line([x, y], [x + right, y]).slice(1)];
	const offer = (): HTMLElement | null => q<HTMLElement>(".nb-axes-offer");
	const settings = v.host.settings as unknown as { axesDraw: string; axesTicks: boolean; axesLabels: boolean };
	const shapes = (): Stroke[] => page().strokes.filter((s) => s.tool === "shape");
	const labels = (): TextElement[] => (page().elements ?? []).filter((e): e is TextElement => e.type === "text");
	const groupsOf = (): Set<string> => new Set([...page().strokes, ...(page().elements ?? [])].map((i) => i.group).filter((g): g is string => !!g));

	setTool("pen");
	settings.axesDraw = "offer";
	settings.axesTicks = true;
	settings.axesLabels = true;
	const ink0 = strokeCount();

	// --- things that are not axes ---
	await penStroke(lShape(60, 120, 12, 12));
	add("a handwritten-size L is not offered", offer() === null);
	await penStroke(line([60, 200], [200, 200]));
	await penStroke(line([70, 200], [70, 260]));
	add("a T is not offered", offer() === null);
	const arc: Array<[number, number]> = Array.from({ length: 30 }, (_, i) => frac(300 + 80 * Math.cos((i / 29) * Math.PI), 200 + 80 * Math.sin((i / 29) * Math.PI)));
	await penStroke(arc);
	add("a curve is not offered", offer() === null);
	for (let i = 0; i < 8 && strokeCount() > ink0; i++) {
		v.undo();
		await frames(1);
	}
	add("the page is clean again", strokeCount() === ink0, `${strokeCount() - ink0} strokes left`);

	// --- an L ---
	await penStroke(lShape(110, 330, 150, 200));
	await frames(3);
	add("an L drawn by hand offers axes", !!offer(), `${strokeCount() - ink0} strokes`);
	await click(offer()?.querySelector("button"));
	add("taking the offer replaces the L with two shape strokes", shapes().length === 2 && strokeCount() === ink0 + 2 && offer() === null, `${shapes().length} shape strokes`);
	add("number labels sit beside the ticks", labels().length >= 4, `${labels().length} labels`);
	add("everything is in one fresh group", groupsOf().size === 1 && shapes().every((s) => !!s.group));
	v.undo();
	await frames(2);
	add("one undo gives the L back and removes the axes and labels", shapes().length === 0 && labels().length === 0 && strokeCount() === ink0 + 1 && groupsOf().size === 0);
	v.redo();
	await frames(2);
	add("one redo makes the axes again", shapes().length === 2 && labels().length >= 4);

	// --- a + of two lines ---
	await penStroke(line([280, 250], [560, 250]));
	add("the first line of a + is not offered", offer() === null);
	await penStroke(line([420, 120], [420, 380]));
	await frames(3);
	add("a + drawn as two lines offers axes", !!offer());
	await click(offer()?.querySelector("button"));
	add("the + gives four-quadrant axes in a second group", shapes().length === 6 && groupsOf().size === 2, `${shapes().length} strokes, ${groupsOf().size} groups`);
	add("labels are negative on the left side", labels().some((t) => t.text.startsWith("−")));

	// --- the settings ---
	const labels0 = labels().length;
	settings.axesTicks = false;
	await penStroke(lShape(60, 520, 100, 150));
	await click(offer()?.querySelector("button"));
	add("with ticks off the axes have no numbers", shapes().length === 8 && labels().length === labels0, `${shapes().length} shapes, ${labels().length} labels vs ${labels0}, offer=${!!offer()}`);
	v.undo();
	await frames(2);
	v.undo();
	await frames(2);
	settings.axesTicks = true;
	settings.axesLabels = false;
	await penStroke(lShape(60, 520, 100, 150));
	await click(offer()?.querySelector("button"));
	add("with numbers off only the ticks are drawn", shapes().length === 8 && labels().length === labels0, `${shapes().length} shapes, ${labels().length} labels vs ${labels0}`);
	v.undo();
	await frames(2);
	v.undo();
	await frames(2);
	settings.axesLabels = true;
	settings.axesDraw = "off";
	await penStroke(lShape(60, 520, 100, 150));
	add("with the setting off nothing is offered", offer() === null);
	v.undo();
	await frames(2);
	settings.axesDraw = "offer";
	add("the page is back to two sets of axes", shapes().length === 6 && groupsOf().size === 2, `${shapes().length} strokes`);

	// --- the insert sheet ---
	const shapes0 = shapes().length;
	setTool("lasso");
	v.runAction("insert-axes");
	await frames(3);
	add("Insert axes drops four-quadrant axes and selects them", shapes().length === shapes0 + 4 && !!v.uiContext().selection);
	v.undo();
	await frames(2);
	add("one undo takes the inserted axes away", shapes().length === shapes0);
	v.clearSelection();
	setTool("pen");

	// --- the page that stays for the screenshot ---
	await penStroke(lShape(110, 640, 90, 130));
	await frames(3);
	add("the page shows two sets of axes and the offer for one more", shapes().length === 6 && !!offer(), `${shapes().length} shape strokes`);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { shapes: shapes().length, labels: labels().length, groups: groupsOf().size } };
}
