/**
 * 0.13 hints: just-in-time tips on the `doc=hints` scenario (npm run harness:check). The whole plugin is started against the
 * stub (as plugin-check.ts does), so the real service, listeners, settings and bubble run. Checks: a pen contact inside a
 * notebook view shows the tip once, the × closes it, the next tip waits for the gap and for a reset, "Turn off tips" turns
 * the setting off and stops tips, and the bubble stays inside the screen at the scenario's width. The last tip is left on
 * screen for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { hint, resetHints } from "../../src/ui/hints";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface HintsCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

export async function checkHints(api: HintsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const until = async (cond: () => boolean, ms = 4000) => {
		const t0 = performance.now();
		while (!cond() && performance.now() - t0 < ms) await new Promise((r) => window.setTimeout(r, 50));
	};
	const bubble = () => document.querySelector<HTMLElement>(".nb-hint");
	const title = () => bubble()?.querySelector(".nb-hint-title")?.textContent ?? "";

	const plugin = new NotebookPlugin(new App() as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	add("the plugin starts with tips on and none seen", plugin.settings.hintsEnabled && plugin.settings.hintsSeen.length === 0);

	// A fake notebook view to receive a pen contact.
	const view = document.body.createDiv({ cls: "notebook-view" });
	view.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 7, bubbles: true }));
	view.dispatchEvent(new PointerEvent("pointerup", { pointerType: "pen", pointerId: 7, bubbles: true }));
	// The pen was just on the screen: the tip waits for the pause (never while writing), then appears.
	add("no tip while the pen is writing", !bubble());
	await until(() => !!bubble());
	add("a pen contact in a notebook shows the pen tip", !!bubble() && title() === "Pen detected", title());
	add("it is stored as seen in the settings", plugin.settings.hintsSeen.includes("pen-detected"));
	add("with a working dismiss control of 40 px or more", (bubble()?.querySelector<HTMLElement>(".nb-hint-close")?.offsetWidth ?? 0) >= 40);
	add("and a Turn off tips control", !!bubble()?.querySelector(".nb-hint-off"));

	bubble()?.querySelector<HTMLElement>(".nb-hint-close")?.click();
	add("the × closes it", !bubble());

	hint("pen-detected");
	hint("lasso-selected");
	add("the seen tip never returns and the next one waits for the gap", !bubble());

	plugin.settings.hintsSeen = [];
	// "Show tips again" is the settings action; it resets the stored ids and the gap.
	resetHints(plugin);
	hint("lasso-selected");
	await until(() => !!bubble());
	add("after Show tips again a tip can appear again", !!bubble() && title() === "Selection", title());

	bubble()?.querySelector<HTMLElement>(".nb-hint-off")?.click();
	add("Turn off tips switches the setting off and closes the tip", plugin.settings.hintsEnabled === false && !bubble());
	hint("pdf-imported");
	add("with tips off nothing appears", !bubble());

	resetHints(plugin);
	add("Show tips again turns tips back on", plugin.settings.hintsEnabled === true);
	hint("palm-blocked");
	await until(() => !!bubble());
	const el = bubble();
	const r = el?.getBoundingClientRect();
	add("the bubble sits inside the screen", !!r && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight && r.top >= 0, r ? `${Math.round(r.left)}..${Math.round(r.right)} of ${window.innerWidth}` : "none");
	add("and shows a title and a sentence", (el?.querySelector(".nb-hint-body")?.textContent ?? "").length > 20);

	return { ok: results.every((x) => x.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { width: window.innerWidth } };
}
