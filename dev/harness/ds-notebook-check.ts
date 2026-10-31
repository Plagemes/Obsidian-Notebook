/**
 * 0.13 ds-notebook: the notebook's editing chrome on the design system (doc=chrome, npm run harness:check). The real view
 * on the harness vault; each state of the chrome (toolbar, tool options, "All actions" sheet, page sheet, the selection's
 * contextual bar, the dial, the heavy-page banner) is opened the way a person does and checked for touch targets, sideways
 * overflow, Obsidian's grey button look and the design system's glass surfaces. `chromeState` leaves one state open for
 * the screenshots (dist/shots/design/notebook-*).
 */
import type { HeavyPageBanner } from "../../src/view/heavy-page-banner";
import type { CheckResult } from "./reading-check";
import { obsidianStyledButtons } from "./library-check";

export interface ChromeCheckApi {
	view: unknown;
	/** The harness's own state openers. */
	openOptions: (tool: string) => Promise<void>;
	openMore: () => Promise<void>;
	openPageSheet: () => Promise<void>;
	selectFirstStroke: () => Promise<void>;
	radialState: (state: string) => Promise<void>;
	closeAll: () => Promise<void>;
	wait: (ms: number) => Promise<unknown>;
	errors: string[];
	notices: string[];
}

export const CHROME_STATES = ["toolbar", "options-pen", "options-eraser", "sheet", "page-sheet", "selection", "radial-main", "radial-color", "heavy"] as const;
export type ChromeState = (typeof CHROME_STATES)[number];

/** The view's heavy-page banner (a private member of the view), for showing it without 3,500 strokes. */
interface WithBanner {
	heavy: HeavyPageBanner | null;
}

function shown(el: Element): boolean {
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
}

/** The visible buttons of `root` smaller than `min` px in either direction. */
function smallTargets(root: ParentNode, min: number, selector = "button"): string[] {
	return Array.from(root.querySelectorAll<HTMLElement>(selector))
		.filter(shown)
		.filter((b) => {
			const r = b.getBoundingClientRect();
			return r.height < min - 0.5 || r.width < min - 0.5;
		})
		.map((b) => `${b.className.split(" ").slice(0, 2).join(".")} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
}

export async function chromeState(api: ChromeCheckApi, state: ChromeState): Promise<void> {
	await api.closeAll();
	const v = api.view as WithBanner;
	v.heavy?.hide();
	if (state === "options-pen") await api.openOptions("pen");
	else if (state === "options-eraser") await api.openOptions("eraser");
	else if (state === "sheet") await api.openMore();
	else if (state === "page-sheet") await api.openPageSheet();
	else if (state === "selection") await api.selectFirstStroke();
	else if (state === "radial-main") await api.radialState("main");
	else if (state === "radial-color") await api.radialState("color");
	else if (state === "heavy") {
		v.heavy?.show({ pageIndex: 0, load: { strokes: 3412, points: 131000, assetBytes: 0 }, reasons: ["strokes", "points"], canSplit: true });
		await api.wait(250);
	}
	await api.wait(120);
}

export async function checkChrome(api: ChromeCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const width = window.innerWidth;
	const add = (name: string, ok: unknown, detail = "") => results.push({ name: `${width}px: ${name}`, ok: !!ok, detail });
	const root = document.querySelector<HTMLElement>(".notebook-view")!;
	const inView = (el: Element | null) => {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
	};
	// A phone this narrow keeps the compact 40 px targets so that the eight tools stay on one line (ui/toolbar-size).
	const min = width >= 400 ? 44 : 40;
	const touch = window.matchMedia("(pointer: coarse)").matches;

	// --- the main toolbar ---
	await chromeState(api, "toolbar");
	const bar = root.querySelector<HTMLElement>(".notebook-toolbar");
	const capsule = bar?.querySelector<HTMLElement>(".notebook-toolbar-group");
	add("the toolbar sits inside the view and its tool groups are rounded capsules", !!bar && inView(bar) && !!capsule && parseFloat(getComputedStyle(capsule).borderTopLeftRadius) >= 12, capsule ? getComputedStyle(capsule).borderTopLeftRadius : "no group");
	const tools = smallTargets(bar ?? root, min, ".notebook-tool");
	add(`every tool of the toolbar is at least ${min} px`, tools.length === 0, tools.join(", "));
	add("the toolbar does not overflow sideways", !!bar && bar.scrollWidth <= bar.clientWidth + 1, bar ? `${bar.scrollWidth} > ${bar.clientWidth}` : "none");
	const grey = obsidianStyledButtons(root).filter((el) => !el.closest(".notebook-stage"));
	add("no button of the chrome shows Obsidian's default button look", grey.length === 0, grey.slice(0, 4).map((el) => el.className || el.tagName).join(", "));
	const dot = root.querySelector<HTMLElement>(".notebook-status-dot");
	add("the save state is a dot, not a control", !dot || dot.tagName !== "BUTTON");

	// --- the options popover of a tool ---
	await chromeState(api, "options-pen");
	const pop = root.querySelector<HTMLElement>(".notebook-popover");
	add("the pen options are a glass panel inside the view", !!pop && inView(pop) && parseFloat(getComputedStyle(pop).borderTopLeftRadius) >= 12, pop ? getComputedStyle(pop).borderTopLeftRadius : "none");
	const popSmall = pop ? smallTargets(pop, 40) : ["no popover"];
	add("every button of the options is at least 40 px", popSmall.length === 0, popSmall.slice(0, 5).join(", "));

	// --- the "All actions" sheet and the page sheet ---
	for (const state of ["sheet", "page-sheet"] as const) {
		await chromeState(api, state);
		const sheet = root.querySelector<HTMLElement>(".notebook-sheet");
		add(`${state}: opens inside the view`, !!sheet && inView(sheet));
		const rows = sheet ? Array.from(sheet.querySelectorAll<HTMLElement>("button")).filter(shown) : [];
		const short = rows.filter((b) => b.getBoundingClientRect().height < (touch ? 43.5 : 31.5));
		add(`${state}: rows are ${touch ? 44 : 32} px tall or more`, rows.length > 0 && short.length === 0, `${rows.length} rows, short: ${short.map((b) => `${b.className.split(" ").slice(0, 2).join(".")} ${Math.round(b.getBoundingClientRect().height)}`).join(", ")}`);
		add(`${state}: nothing overflows sideways`, !!sheet && sheet.scrollWidth <= sheet.clientWidth + 1, sheet ? `${sheet.scrollWidth} > ${sheet.clientWidth}` : "none");
	}

	// --- the contextual bar of a selection ---
	await chromeState(api, "selection");
	const ctx = root.querySelector<HTMLElement>(".notebook-context-bar:not(.notebook-hidden)");
	add("a selection shows the contextual bar inside the view", !!ctx && inView(ctx));
	const ctxSmall = ctx ? smallTargets(ctx, min, "button") : ["no bar"];
	add(`its buttons are at least ${min} px`, ctxSmall.length === 0, ctxSmall.slice(0, 5).join(", "));
	const label = ctx?.querySelector<HTMLElement>(".notebook-context-label");
	add("its label is decoration (not a button)", !!label && label.tagName !== "BUTTON");

	// --- the dial ---
	await chromeState(api, "radial-main");
	const dial = document.querySelector<HTMLElement>(".notebook-dial");
	add("the dial opens and stays inside the view", !!dial && inView(dial));
	await api.closeAll();

	// --- the heavy-page banner ---
	await chromeState(api, "heavy");
	const heavy = root.querySelector<HTMLElement>(".notebook-heavy");
	add("the heavy-page banner is a card with an icon square, text and two buttons", !!heavy && shown(heavy) && !!heavy.querySelector(".notebook-heavy-icon svg") && heavy.querySelectorAll("button").length === 2);
	add("its icon square is not a button", !heavy?.querySelector("button .notebook-heavy-icon"));
	const heavySmall = heavy ? smallTargets(heavy, touch ? 44 : 32) : ["no banner"];
	add("its buttons are big enough to tap", heavySmall.length === 0, heavySmall.join(", "));
	add("it stays inside the view", inView(heavy));
	(api.view as WithBanner).heavy?.hide();

	await chromeState(api, "toolbar");
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, touch } };
}
