/**
 * Smoke check of the recent symbols (0.21, roadmap #212) on the `doc=symbols` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pointer events. The strip shows the typographic defaults in their designed
 * order; tapping a button arms it and the next tap on the page places a text box (one undo step); a symbol saved as a stamp
 * joins the strip, is placed pen-sized with fresh ids and one group, and the used symbols move to the front; the settings
 * hide the strip and change its length. It leaves the strip with six buttons, one symbol and one character on the page.
 */
import type { App } from "obsidian";
import { captureClip } from "../../src/ink/clipboard";
import { createStroke } from "../../src/model/document";
import { freezeStroke } from "../../src/model/serialize";
import type { Point } from "../../src/model/types";
import { saveStamp } from "../../src/storage/stamps";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SymbolsCheckApi {
	view: unknown;
	app: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface SymbolsView extends HarnessView {
	symbolStripView: { el: HTMLElement; isArmed: boolean; disarm(): void; refresh(): Promise<void>; sync(): void; shown: Array<{ label: string }> } | null;
	stage: HTMLElement;
}

const pts = (...p: Array<[number, number]>): Point[] => p.map(([x, y]) => [x, y, 0.5]);

export async function checkSymbols(api: SymbolsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as SymbolsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const settings = v.host.settings as unknown as { symbolStrip: boolean; symbolCount: number; folder: string };
	const strip = v.symbolStripView!;
	const page = () => v.document.pages[v.currentPage()]!;
	const buttons = (): HTMLButtonElement[] => [...strip.el.querySelectorAll<HTMLButtonElement>(".notebook-symbol-btn")];
	const labels = (): string[] => buttons().map((b) => b.textContent ?? "");
	const shown = (): boolean => !strip.el.classList.contains("notebook-hidden") && strip.el.getBoundingClientRect().width > 0;
	const catcher = (): HTMLElement | null => strip.el.parentElement?.querySelector<HTMLElement>(".notebook-symbol-catcher") ?? null;
	const tapPage = (): void => {
		const c = catcher()!;
		const r = v.stage.getBoundingClientRect();
		const x = r.left + r.width / 2;
		const y = r.top + r.height * 0.4;
		c.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 71, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true }));
		c.dispatchEvent(new PointerEvent("pointerup", { pointerId: 71, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 0, bubbles: true, cancelable: true }));
	};
	const texts = (): string[] => (page().elements ?? []).flatMap((e) => (e.type === "text" ? [e.text] : []));

	settings.symbolStrip = true;
	settings.symbolCount = 6;
	v.applySettings(v.host.settings);
	await frames(3);

	// --- the defaults ---
	add("the strip is shown", shown());
	add("six buttons in the designed order", labels().join("") === "∀∃∫→⇒≠", labels().join(" "));
	add("every button has a name", buttons().every((b) => (b.getAttribute("aria-label") ?? "") !== ""));
	add("no catcher over the page until a button is tapped", catcher()?.classList.contains("notebook-hidden") === true);

	// --- a typographic symbol: tap it, tap the page ---
	const before = texts().length;
	const arrow = buttons().find((b) => b.textContent === "≠")!;
	arrow.click();
	await frames(2);
	add("a tap on a button arms it", strip.isArmed);
	add("the catcher covers the page", catcher()?.classList.contains("notebook-hidden") === false);
	tapPage();
	await frames(3);
	add("the next tap on the page places the character as a text box", texts().length === before + 1 && texts().includes("≠"), texts().join(","));
	add("it is no longer armed", !strip.isArmed && catcher()?.classList.contains("notebook-hidden") === true);
	v.undo();
	await frames(2);
	add("one undo takes it away", texts().length === before);
	v.redo();
	await frames(2);
	add("redo brings it back", texts().includes("≠"));

	// --- the used symbol moves to the front ---
	add("the used symbol is first", labels()[0] === "≠", labels().join(" "));

	// --- a symbol of the user ---
	const strokesBefore = page().strokes.length;
	const a = freezeStroke(createStroke("#222222", 2, pts([0, 0], [30, 0], [15, 30], [30, 30]), "pen"));
	const b = freezeStroke(createStroke("#222222", 2, pts([0, 0], [0, 30]), "pen"));
	const clip = captureClip([a, b], [], undefined)!;
	await saveStamp(api.app as App,settings.folder, "Sum", clip);
	await strip.refresh();
	await frames(2);
	add("a saved symbol joins the strip", shown() && strip.el.querySelectorAll(".notebook-symbol-art").length === 1);
	const mine = buttons().find((x) => x.querySelector(".notebook-symbol-art"))!;
	mine.click();
	await frames(2);
	tapPage();
	await frames(3);
	const placed = page().strokes.slice(strokesBefore);
	add("the symbol is placed with fresh ids", placed.length === 2 && placed.every((s) => s.id !== a.id && s.id !== b.id));
	add("two strokes share one new group", new Set(placed.map((s) => s.group)).size === 1 && !!placed[0]?.group);
	const ys = placed.flatMap((s) => s.points.map((p) => p[1]));
	add("it is pen-sized (about a text line)", ys.length > 0 && Math.max(...ys) - Math.min(...ys) < 40, String(Math.max(...ys) - Math.min(...ys)));
	v.undo();
	await frames(2);
	add("one undo removes the whole symbol", page().strokes.length === strokesBefore);
	v.redo();
	await frames(2);
	add("the saved symbol is first once used", buttons()[0]?.querySelector(".notebook-symbol-art") != null, labels().join(" "));

	// --- settings ---
	settings.symbolCount = 3;
	v.applySettings(v.host.settings);
	await frames(2);
	add("the number of buttons follows the setting", buttons().length === 3, String(buttons().length));
	settings.symbolStrip = false;
	v.applySettings(v.host.settings);
	await frames(2);
	add("the strip hides when the setting is off", !shown());
	settings.symbolStrip = true;
	settings.symbolCount = 6;
	v.applySettings(v.host.settings);
	await frames(3);
	add("and comes back", shown() && buttons().length === 6);
	// leave a character and the symbol on the page, strip armed off
	strip.disarm();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
