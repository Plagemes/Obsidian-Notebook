/**
 * "Adapt layout to input" (0.27, roadmap #431) on the real notebook view (doc=inputlayout, the blank "New" notebook;
 * HARNESS_DOC=inputlayout npm run harness:check). The setting pins the layout to the pen, the finger or the mouse (one class,
 * nb-input-*, next to nb-vp-*); the finger layout has larger toolbar targets, the pen and the mouse layouts keep the compact bar.
 * In Automatic the class follows the pointer events the view receives: a few mouse events switch to the mouse layout, a few pen events
 * bring the pen layout back, and a touch right after the pen (a palm) changes nothing. `inputlayoutShot(kind)` leaves the view in that
 * layout for the screenshots (tablet and phone, light and dark: dist/shots/design/inputlayout-*.png).
 */
import type { CheckResult } from "./reading-check";

export interface InputlayoutCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface InputlayoutView {
	host: { settings: { inputLayout: string; toolbarSize: string } };
	applySettings(s: unknown): void;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const root = (): HTMLElement => document.querySelector<HTMLElement>(".notebook-view")!;
const layoutClasses = (): string[] => Array.from(root().classList).filter((c) => c.startsWith("nb-input-"));
const targetPx = (): number => document.querySelector<HTMLElement>(".notebook-tool-button")?.getBoundingClientRect().width ?? 0;

function fire(type: string, kind: string, id: number): void {
	const el = document.querySelector(".notebook-stage")!;
	const r = el.getBoundingClientRect();
	el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId: id, pointerType: kind, isPrimary: true, buttons: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
}

async function pin(api: InputlayoutCheckApi, pref: string): Promise<InputlayoutView> {
	await api.open("inputlayout");
	const v = api.view as InputlayoutView;
	v.host.settings.inputLayout = pref;
	v.applySettings(v.host.settings);
	await api.frames(4);
	return v;
}

/** Leaves the view in the layout of `kind` (pen | touch | mouse). */
export async function inputlayoutShot(api: InputlayoutCheckApi, kind: string): Promise<void> {
	await pin(api, kind);
	await sleep(250);
}

export async function checkInputlayout(api: InputlayoutCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const widths: Record<string, number> = {};
		for (const pref of ["pen", "touch", "mouse"]) {
			await pin(api, pref);
			widths[pref] = targetPx();
			add(`pinned to ${pref}: exactly one class, nb-input-${pref}`, layoutClasses().join() === `nb-input-${pref}`, layoutClasses().join());
			add(`pinned to ${pref}: the nb-vp-* classes are still there`, Array.from(root().classList).some((c) => c.startsWith("nb-vp-")));
		}
		add("the finger layout has larger toolbar targets than the pen layout", widths.touch! > widths.pen!, JSON.stringify(widths));
		add("the mouse layout keeps the compact targets of the pen layout", widths.mouse === widths.pen, JSON.stringify(widths));

		// Automatic: follows the events.
		const v = await pin(api, "auto");
		add("automatic starts with the pen layout", layoutClasses().join() === "nb-input-pen", layoutClasses().join());
		fire("pointerover", "mouse", 1);
		fire("pointerover", "mouse", 1);
		await api.frames(1);
		add("two mouse events do not switch yet", layoutClasses().join() === "nb-input-pen", layoutClasses().join());
		fire("pointerover", "mouse", 1);
		await api.frames(2);
		add("the third mouse event switches to the mouse layout", layoutClasses().join() === "nb-input-mouse", layoutClasses().join());
		for (let i = 0; i < 3; i++) fire("pointerover", "pen", 2);
		await api.frames(2);
		add("three pen events bring the pen layout back", layoutClasses().join() === "nb-input-pen", layoutClasses().join());
		for (let i = 0; i < 6; i++) fire("pointerdown", "touch", 3);
		await api.frames(2);
		add("a touch right after the pen (a palm) changes nothing", layoutClasses().join() === "nb-input-pen", layoutClasses().join());

		// A pinned device ignores the events.
		v.host.settings.inputLayout = "touch";
		v.applySettings(v.host.settings);
		for (let i = 0; i < 5; i++) fire("pointerover", "mouse", 4);
		await api.frames(2);
		add("a pinned layout ignores the events", layoutClasses().join() === "nb-input-touch", layoutClasses().join());
	} catch (e) {
		add("the check ran without throwing", false, e instanceof Error ? e.message : String(e));
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}
