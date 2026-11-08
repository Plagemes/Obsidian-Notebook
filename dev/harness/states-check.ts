/**
 * Smoke check of the drawings with states (0.15, #241, format v13) on the `doc=states` notebook (npm run harness:check):
 * a block and a ground line are written with the pen, the block is selected with the lasso and made a part, a state is
 * added, the part is moved with the ordinary selection handles (the strokes stay as drawn, the pose is saved), the strip
 * switches back to "as drawn", undo and redo cover the edit, a colour and hiding work, the file is v13, and the states
 * play. It ends with the part selected in its state for the screenshot (dev/harness/dist/shots/states-*.png).
 */

import { parse } from "../../src/model/serialize";
import type { NotebookView } from "../../src/view/notebook-view";
import { PLAY_STEP_MS } from "../../src/view/states-tools";
import type { HarnessApp, HarnessFile, HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface StatesCheckApi {
	view: unknown;
	app: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	inkNear: (fx: number, fy: number) => boolean;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const BLOCK: Array<[number, number]> = [[0.2, 0.2], [0.34, 0.2], [0.34, 0.28], [0.2, 0.28], [0.2, 0.2]];
const GROUND: Array<[number, number]> = [[0.1, 0.6], [0.85, 0.6]];
const LASSO: Array<[number, number]> = [[0.14, 0.14], [0.42, 0.14], [0.42, 0.34], [0.14, 0.34], [0.14, 0.14]];
const DRAG: Array<[number, number]> = [[0.27, 0.24], [0.47, 0.34]];

const shownEl = (sel: string): HTMLElement | null => {
	const els = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((b) => b.offsetWidth > 0);
	return els[0] ?? null;
};
const all = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((b) => b.offsetWidth > 0);

export async function checkStates(api: StatesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, inkNear, strokeCount, frames } = api;
	const v = api.view as HarnessView;
	const nv = api.view as NotebookView;
	const app = api.app as HarnessApp;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const settle = async () => {
		await frames(3);
		await sleep(60);
		await frames(2);
	};
	const page = () => v.document.pages[v.currentPage()]!;
	const click = async (el: HTMLElement | null | undefined) => {
		el?.click();
		await settle();
	};
	const chip = (label: string): HTMLElement | null => all(".nb-states-chip").find((c) => c.textContent?.trim() === label) ?? null;

	// --- ink: a block (to become a part) and the ground (ordinary ink) ---
	setTool("pen");
	await penStroke(BLOCK);
	await penStroke(GROUND);
	await settle();
	add("the block and the ground are written", strokeCount() === 2, String(strokeCount()));
	const blockBefore = JSON.stringify(page().strokes[0]!.points);

	// --- make the block a part ---
	nv.stateTools?.show();
	await settle();
	const strip = shownEl(".nb-states");
	add("the strip opens", !!strip);
	add("the strip says there are no parts yet", (strip?.textContent ?? "").includes("No parts yet"), strip?.textContent ?? "");
	setTool("lasso");
	await penStroke(LASSO);
	await settle();
	const make = shownEl(".nb-states-make");
	add("selecting ink offers Make part", !!make);
	await click(make);
	const states = () => page().states;
	add("Make part groups the stroke (one part, no state yet)", states()?.parts.length === 1 && states()!.parts[0]!.items.length === 1 && states()!.list.length === 0, JSON.stringify(states()));
	add("the part chip is in the strip", all(".nb-states-part").length === 1);
	add("the ground is not in the part", states()!.parts[0]!.items[0] === page().strokes[0]!.id);

	// --- a state, and the part moved in it with the handles ---
	await click(shownEl(".nb-states-add"));
	add("Add a state creates and shows it (the saved default is not changed by it)", states()?.list.length === 1 && states()?.active === undefined && !!chip("State 1")?.classList.contains("is-active"), JSON.stringify(states()));
	add("the state has a chip", !!chip("State 1"));
	add("the page still shows the block where it was drawn (no pose yet)", inkNear(0.2, 0.24));
	await click(shownEl(".nb-states-part"));
	add("choosing the part selects it with handles and the part editor opens", !!shownEl(".nb-states-edit"));
	add("the contextual selection bar is not used for a part in a state", v.uiContext().selection === null || v.uiContext().selection === undefined);
	await penStroke(DRAG);
	await settle();
	const pose = states()?.list[0]?.poses[0];
	add("the drag becomes the part's pose in the state", !!pose && (pose.dx ?? 0) > 0 && (pose.dy ?? 0) > 0, JSON.stringify(pose));
	add("the stroke itself is unchanged (a state is not an edit of the ink)", JSON.stringify(page().strokes[0]!.points) === blockBefore);
	// A selected part floats on the live layer; the pixel checks look at the static one.
	await click(shownEl(".nb-states-done"));
	add("the block is drawn at its new place", inkNear(0.4, 0.34) && !inkNear(0.2, 0.24), `${inkNear(0.4, 0.34)} ${inkNear(0.2, 0.24)}`);
	add("the ground stays", inkNear(0.5, 0.6));

	// --- back to as drawn ---
	await click(chip("As drawn"));
	add("As drawn shows the block where it was drawn", inkNear(0.2, 0.24) && !inkNear(0.4, 0.34), `${inkNear(0.2, 0.24)} ${inkNear(0.4, 0.34)}`);
	add("switching writes nothing: the notebook is not changed by it", states()?.active === undefined);
	await click(chip("State 1"));
	add("State 1 shows the moved block again", inkNear(0.4, 0.34));
	add("and still writes nothing", states()?.active === undefined);

	// --- undo and redo cover the pose in one step ---
	v.undo();
	await settle();
	add("one undo takes the pose back", (states()?.list[0]?.poses.length ?? 0) === 0 && inkNear(0.2, 0.24), JSON.stringify(states()?.list[0]));
	v.redo();
	await settle();
	add("redo restores it", (states()?.list[0]?.poses.length ?? 0) === 1 && inkNear(0.4, 0.34));

	// --- colour and visibility in the state ---
	await click(shownEl(".nb-states-part"));
	await click(shownEl(".nb-states-swatch:not(.is-original)"));
	add("a swatch colours the part in this state", !!states()?.list[0]?.poses[0]?.color, JSON.stringify(states()?.list[0]?.poses[0]));
	await click(shownEl(".nb-states-eye"));
	add("the eye hides it in this state", states()?.list[0]?.poses[0]?.hidden === true && !inkNear(0.4, 0.34) && !inkNear(0.2, 0.24));
	await click(shownEl(".nb-states-part"));
	await click(shownEl(".nb-states-eye"));
	await click(shownEl(".nb-states-done"));
	add("and shows it again", !states()?.list[0]?.poses[0]?.hidden && inkNear(0.4, 0.34));
	await click(shownEl(".nb-states-part"));
	await click(shownEl(".nb-states-swatch.is-original"));
	add("the original colour comes back", states()?.list[0]?.poses[0]?.color === undefined);

	// --- ink tools leave a moved part alone ---
	setTool("eraser");
	await penStroke([[0.14, 0.24], [0.26, 0.24]]);
	await settle();
	add("the eraser does not touch the part at the spot where it was drawn (the state moved it away)", strokeCount() === 2, String(strokeCount()));

	// --- the file ---
	await v.flushNow();
	const file = app.vault.getFileByPath("Notebooks/New.notebook");
	const text = file ? await (app.vault as unknown as { read(f: HarnessFile): Promise<string> }).read(file) : "";
	add("the saved file is current format (v13 or later) with the states", /"version":\s*(1[3-9]|[2-9]\d)/.test(text) && /"states":\s*\{"parts"/.test(text), `${text.length} chars`);
	const back = parse(text);
	add("it reads back with the same states", back.ok && back.doc.pages[0]?.states?.parts.length === 1 && back.doc.pages[0]?.states?.list.length === 1, back.ok ? "" : back.message);

	// --- a second state, then play ---
	await click(shownEl(".nb-states-add"));
	add("a second state starts from the first", states()?.list.length === 2 && JSON.stringify(states()!.list[1]!.poses.map((p) => p.dx)) === JSON.stringify(states()!.list[0]!.poses.map((p) => p.dx)));
	await click(chip("As drawn"));
	const play = shownEl(".nb-states-play");
	add("play is available", !!play && !(play as HTMLButtonElement).disabled);
	await click(play);
	add("playing shows Stop", shownEl(".nb-states-play")?.classList.contains("is-on") ?? false);
	await sleep(PLAY_STEP_MS * 3.6);
	await settle();
	add("the states play to the last one and stop there (this view keeps showing it)", !(shownEl(".nb-states-play")?.classList.contains("is-on") ?? true) && !!chip("State 2")?.classList.contains("is-active"), `${states()?.active}`);
	add("playing writes nothing", states()?.active === undefined && v.session.isSaved());

	// --- the default state is the one explicit write ---
	add("the options button is there for the default state", !!shownEl(".nb-states-more"));
	nv.stateTools?.setDefault();
	await settle();
	add("Set as default state saves the state in view", states()?.active === states()?.list[1]?.id && !!chip("State 2")?.classList.contains("is-default"), `${states()?.active}`);
	v.undo();
	await settle();
	add("and is one undo step", states()?.active === undefined && !chip("State 2")?.classList.contains("is-default"), `${states()?.active}`);

	// --- sizes and layout ---
	const bar = shownEl(".nb-states");
	const box = bar?.getBoundingClientRect();
	add("the strip stays inside the window", !!box && box.left >= 0 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1, box ? `${Math.round(box.left)}..${Math.round(box.right)} of ${window.innerWidth}` : "");
	const controls = all(".nb-states button");
	add("every control is a touch target of at least 36 px", controls.length > 0 && controls.every((c) => c.getBoundingClientRect().height >= 35.5 && c.getBoundingClientRect().width >= 27.5), controls.map((c) => `${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`).join(","));
	add("the strip does not scroll the page sideways", !!bar && bar.scrollWidth <= bar.clientWidth + 1, bar ? `${bar.scrollWidth} > ${bar.clientWidth}` : "");

	// --- read-only: states can be switched, not changed ---
	v.setReadOnlyMode(true, false);
	await settle();
	await click(chip("State 1"));
	add("a read-only view still switches states", inkNear(0.4, 0.34) && !!chip("State 1")?.classList.contains("is-active"), JSON.stringify(states()?.active));
	add("and saves nothing for it", v.session.isSaved());
	v.setReadOnlyMode(false, false);
	await settle();

	// The screenshot: the part in State 1 with its handles and the part editor.
	await click(chip("State 1"));
	await click(shownEl(".nb-states-part"));

	return {
		ok: results.every((r) => r.ok) && api.errors.length === 0,
		results,
		errors: api.errors,
		notices: api.notices,
		env: { states: states()?.list.length ?? 0, parts: states()?.parts.length ?? 0 },
	};
}
