/**
 * Smoke check of the ghost guide lines on blank paper (0.20, roadmap #94) on the `doc=ghostlines` notebook (the blank "New"
 * notebook; npm run harness:check): the real view with synthetic pen events. A first line of small strokes is written on blank
 * paper: with the setting off nothing shows; "while writing" shows the baseline and the next line and they fade by themselves
 * after a pause; on ruled paper nothing shows; "always" keeps them. The guides are an overlay only: the page has no new stroke
 * or element because of them. It leaves the guides on the page ("always") for the screenshot.
 */
import type { NotebookSettings } from "../../src/settings";
import type { GhostOverlay } from "../../src/ink/renderer";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface GhostlinesCheckApi {
	view: unknown;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface GhostView extends HarnessView {
	host: { settings: NotebookSettings };
	renderer: { invalidate(): void; ghost: GhostOverlay | null };
}

export async function checkGhostlines(api: GhostlinesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as GhostView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const page = () => v.document.pages[v.currentPage()]!;
	const ghost = () => v.renderer.ghost;
	const settings = v.host.settings;
	const pt = (n: number) => (n * v.viewport.scale) / api.stage().getBoundingClientRect().width;
	const ptY = (n: number) => (n * v.viewport.scale) / api.stage().getBoundingClientRect().height;

	/** A small zigzag letter sitting on the baseline `yPt` at `xPt`, about 9 pt tall. */
	const letter = (xPt: number, yPt: number, top = 9) => penStroke([[pt(xPt), ptY(yPt)], [pt(xPt + 3), ptY(yPt - top)], [pt(xPt + 6), ptY(yPt)]]);
	const writeLine = async (x0: number, y: number, n = 8) => {
		for (let i = 0; i < n; i++) await letter(x0 + i * 10, y, i % 3 === 2 ? 15 : 9);
	};

	setTool("pen");
	page().paper = { kind: "blank", spacing: page().paper.spacing };
	settings.ghostSpacing = "auto";

	settings.ghostLines = "off";
	const before = page().strokes.length;
	await writeLine(60, 120);
	await frames(3);
	add("a first line is written", page().strokes.length === before + 8, `${before} -> ${page().strokes.length}`);
	add("off: no guides", ghost() === null);

	settings.ghostLines = "writing";
	await letter(150, 120);
	await frames(3);
	const g = ghost();
	add("while writing: the baseline and the next line show", !!g && g.segments.length === 2 && g.mode === "writing", JSON.stringify(g?.segments.length));
	add("the next line is below the baseline", !!g && g.segments[1]!.y1 > g.segments[0]!.y1);
	add("the guides are an overlay: no stroke was added for them", page().strokes.length === before + 9);
	await sleep(2600);
	await frames(6);
	add("they fade away after a pause", ghost() === null);

	page().paper = { kind: "ruled", spacing: page().paper.spacing };
	await letter(160, 120);
	await frames(3);
	add("ruled paper: no guides", ghost() === null);

	page().paper = { kind: "blank", spacing: page().paper.spacing };
	settings.ghostLines = "always";
	settings.ghostSpacing = "8";
	await letter(170, 120);
	await frames(3);
	const a = ghost();
	add("always: the guides show with the fixed 8 mm spacing", !!a && a.mode === "always" && Math.abs(a.segments[1]!.y1 - a.segments[0]!.y1 - 22.68) < 0.1, `${a ? a.segments[1]!.y1 - a.segments[0]!.y1 : "none"}`);
	await sleep(2600);
	await frames(4);
	add("always: they stay", ghost() !== null);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}
