/**
 * "Toolbar fades while writing" (0.25, roadmap #399) on the real notebook view (doc=toolfade, the blank "New" notebook;
 * HARNESS_DOC=toolfade npm run harness:check). A long pen stroke dims the toolbar, the contextual bar and the floating pills (one class,
 * opacity only, no layout shift, still hit-testable); a finger touch on a faded bar only restores it, a pen hovering over it restores
 * it, a finger on the page does not, a long press on a faded bar restores it and shows the help; the setting off and an open dialog
 * keep the bars shown. `toolfadeShot(state)` leaves the view faded or restored for the screenshots.
 */
import { setLongPressHelpEnabled } from "../../src/ui/long-press-help";
import { HELP_PRESS_MS } from "../../src/ui/long-press-logic";
import type { CheckResult } from "./reading-check";

export interface ToolfadeCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>, opts?: { steps?: number }) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ToolfadeView {
	toolbar: { setTool(tool: string): void };
	host: { settings: { toolFade: string; toolFadeSeconds: number; toolFadeFirstTouch: boolean; symbolStrip: boolean; symbolCount: number } };
	applySettings(s: unknown): void;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const root = (): HTMLElement => document.querySelector<HTMLElement>(".notebook-view")!;
const isFaded = (): boolean => root().classList.contains("is-tools-faded");
const opacity = (sel: string): number | null => {
	const el = root().querySelector<HTMLElement>(sel);
	return el ? Number(getComputedStyle(el).opacity) : null;
};
const toolButton = (n: number): HTMLElement => document.querySelectorAll<HTMLElement>(".notebook-tool-button")[n]!;

function fire(el: Element, type: string, kind: string, id = 61, buttons = 1): void {
	const r = el.getBoundingClientRect();
	el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: kind, isPrimary: true, buttons, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
}

async function prepare(api: ToolfadeCheckApi): Promise<ToolfadeView> {
	await api.open("toolfade");
	const v = api.view as ToolfadeView;
	const s = v.host.settings;
	s.toolFade = "writing";
	s.toolFadeSeconds = 1;
	s.toolFadeFirstTouch = true;
	s.symbolStrip = true;
	s.symbolCount = 6;
	setLongPressHelpEnabled(true);
	v.applySettings(s);
	await api.frames(4);
	return v;
}

/** A stroke long enough (about 1.5 s of pen down) to pass the 1 s delay: the bars dim while it is still being written. */
async function fade(api: ToolfadeCheckApi): Promise<void> {
	await api.penStroke([[0.15, 0.3], [0.45, 0.36], [0.75, 0.3], [0.5, 0.4]], { steps: 90 });
}

export async function toolfadeShot(api: ToolfadeCheckApi, state: string): Promise<void> {
	await prepare(api);
	await fade(api);
	await sleep(400);
	if (state === "restored") {
		const bar = document.querySelector(".notebook-toolbar")!;
		fire(bar, "pointerdown", "touch", 62);
		fire(bar, "pointerup", "touch", 62, 0);
		await sleep(500);
	}
}

export async function checkToolfade(api: ToolfadeCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const tb = root().querySelector<HTMLElement>(".notebook-toolbar")!;
		const before = tb.getBoundingClientRect();
		add("bars are fully shown before writing", !isFaded() && opacity(".notebook-toolbar") === 1);

		await fade(api);
		await sleep(400);
		add("a long pen stroke fades the bars (one class)", isFaded());
		const o = opacity(".notebook-toolbar");
		add("the toolbar is dimmed to low opacity", o !== null && o < 0.25 && o > 0, `${o}`);
		const ctx = opacity(".notebook-context-bar:not(.notebook-hidden)");
		if (ctx !== null) add("the contextual bar dims too", ctx < 0.25, `${ctx}`);
		const strip = opacity(".notebook-symbol-strip:not(.notebook-hidden)");
		if (strip !== null) add("the floating pills dim too", strip < 0.25, `${strip}`);
		const after = tb.getBoundingClientRect();
		add("no layout shift", before.top === after.top && before.height === after.height && before.width === after.width, `${before.height}->${after.height}`);
		add("faded bars stay hit-testable", getComputedStyle(tb).pointerEvents !== "none" && getComputedStyle(tb).visibility === "visible");

		// A finger on the page does not bring the bars back.
		const stage = root().querySelector(".notebook-stage")!;
		fire(stage, "pointerdown", "touch", 63);
		fire(stage, "pointerup", "touch", 63, 0);
		await sleep(50);
		add("a finger on the page leaves them faded", isFaded());

		// A finger outside the page brings them back.
		const body = root().querySelector(".notebook-body")!;
		fire(body, "pointerdown", "touch", 64);
		fire(body, "pointerup", "touch", 64, 0);
		await sleep(450);
		add("a finger outside the page restores them", !isFaded() && opacity(".notebook-toolbar") === 1, `${opacity(".notebook-toolbar")}`);

		// The pen hovering near a bar.
		await fade(api);
		await sleep(300);
		add("faded again after writing", isFaded());
		fire(tb, "pointermove", "pen", 65, 0);
		await sleep(50);
		add("a pen hovering over a bar restores them", !isFaded());

		// First touch only restores.
		await fade(api);
		await sleep(300);
		const eraser = toolButton(2);
		let clicks = 0;
		eraser.addEventListener("click", () => clicks++);
		fire(eraser, "pointerdown", "touch", 66);
		fire(eraser, "pointerup", "touch", 66, 0);
		eraser.click();
		await sleep(50);
		add("the first touch on a faded bar restores it", !isFaded());
		add("... and does not press the button", clicks === 0, `${clicks} clicks`);
		fire(eraser, "pointerdown", "touch", 67);
		fire(eraser, "pointerup", "touch", 67, 0);
		eraser.click();
		await sleep(50);
		add("the next tap presses it", clicks === 1, `${clicks} clicks`);
		v.toolbar.setTool("pen");

		// With the setting off the first touch presses at once.
		v.host.settings.toolFadeFirstTouch = false;
		await fade(api);
		await sleep(300);
		clicks = 0;
		fire(eraser, "pointerdown", "touch", 68);
		fire(eraser, "pointerup", "touch", 68, 0);
		eraser.click();
		await sleep(50);
		add("with the setting off the first touch also presses", !isFaded() && clicks === 1, `${clicks} clicks`);
		v.toolbar.setTool("pen");
		v.host.settings.toolFadeFirstTouch = true;

		// A long press on a faded bar restores it and shows the help.
		await fade(api);
		await sleep(300);
		fire(eraser, "pointerdown", "touch", 69);
		await sleep(HELP_PRESS_MS + 200);
		add("a long press on a faded bar restores it", !isFaded());
		add("... and shows the icon help", !!document.querySelector(".nb-help-bubble"));
		fire(eraser, "pointerup", "touch", 69, 0);
		fire(document.body, "pointerdown", "touch", 70);
		await sleep(100);

		// An open dialog never lets them fade.
		const modal = document.body.createDiv({ cls: "modal-container" });
		await fade(api);
		await sleep(200);
		add("an open dialog keeps the bars shown", !isFaded());
		modal.remove();

		// Off: nothing fades.
		v.host.settings.toolFade = "off";
		v.applySettings(v.host.settings);
		await fade(api);
		await sleep(200);
		add("the setting off never fades", !isFaded() && opacity(".notebook-toolbar") === 1);
		v.host.settings.toolFade = "writing";
		v.applySettings(v.host.settings);
		add("reduced motion removes the transition", (() => {
			const rules = Array.from(document.styleSheets).flatMap((sh) => {
				try { return Array.from(sh.cssRules); } catch { return []; }
			});
			return rules.some((r) => r instanceof CSSMediaRule && /reduce/.test(r.conditionText) && Array.from(r.cssRules).some((c) => c.cssText.includes("notebook-toolbar") && c.cssText.includes("transition: none")));
		})());
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
