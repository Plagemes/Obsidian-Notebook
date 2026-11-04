/**
 * 0.14 toolbar: the generative interface (392, 393, 402) on the real notebook view (doc=toolbar: the 0.3.0 notebook, grid
 * paper then ruled; doc=toolbar-pdf: the fake PDF pages, resized to slides). Checks, the way a person does them: the tools a
 * page invites are marked and never move, the ruler leads the quick slots on grid paper, each switch turns its behaviour off,
 * pressing and holding a quick action (or a row of "All actions") pins it and the pin survives a change of page, an ink
 * selection says so and offers its own actions, and the snapping highlighter is a working control of the PDF bar.
 * `adaptiveToolbarShot` leaves one state on screen for the review screenshots (dist/shots/design/toolbar-*).
 */
import { t } from "../../src/i18n";
import type { Stroke } from "../../src/model/types";
import type { NotebookSettings } from "../../src/settings";
import type { CheckResult } from "./reading-check";

interface ToolbarView {
	document: { pages: Array<{ width: number; height: number; strokes: Stroke[] }> };
	host: { settings: NotebookSettings };
	ui: { sheet: { isOpen: boolean; close(): void } };
	toolbar: { closePopover(): void };
	goToPage(index: number): void;
	refreshUi(): void;
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	uiContext(): { page: { kind?: string } | null };
	readingTools: { snapping: boolean } | null;
}

export interface AdaptiveCheckApi {
	view: unknown;
	openMore: () => Promise<void>;
	closeAll: () => Promise<void>;
	wait: (ms: number) => Promise<unknown>;
	errors: string[];
	notices: string[];
}

export const ADAPTIVE_SHOT_STATES = ["page", "pinned", "selection"] as const;
export type AdaptiveShotState = (typeof ADAPTIVE_SHOT_STATES)[number];

interface HarnessMenu {
	titles: string[];
	run(title: string): void;
}

const docName = (): string => new URLSearchParams(window.location.search).get("doc") ?? "toolbar";

function shown(el: Element | null): el is HTMLElement {
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
}

const suggested = (): string[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-tool-button.is-suggested")).map((b) => b.getAttribute("aria-label") ?? "");
const quickIds = (): string[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-quick [data-action]")).map((b) => b.dataset.action ?? "");
const bar = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-context-bar:not(.notebook-hidden)");

/** Holds the element the way a pen or finger does, then lets go: the long-press handler listens to pointer events and `contextmenu`. */
function openPinMenu(el: Element): HarnessMenu | null {
	(window as unknown as { harnessMenu?: HarnessMenu }).harnessMenu = undefined;
	el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	return (window as unknown as { harnessMenu?: HarnessMenu }).harnessMenu ?? null;
}

async function settle(api: AdaptiveCheckApi, v: ToolbarView): Promise<void> {
	v.refreshUi();
	await api.wait(200);
}

export async function adaptiveToolbarShot(api: AdaptiveCheckApi, state: AdaptiveShotState): Promise<void> {
	const v = api.view as ToolbarView;
	await api.closeAll();
	v.host.settings.pinnedQuick = state === "pinned" ? ["fit-width"] : [];
	v.goToPage(0);
	if (state === "selection") v.selectItems(0, v.document.pages[0]!.strokes.slice(0, 2), []);
	await settle(api, v);
}

export async function checkAdaptiveToolbar(api: AdaptiveCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as ToolbarView;
	const s = v.host.settings;
	const width = window.innerWidth;
	const pdf = docName() === "toolbar-pdf";
	await api.closeAll();
	await settle(api, v);

	if (!pdf) {
		// Grid paper (page 1): shapes are invited, and the ruler leads the quick slots when there are any.
		add("page 1 is grid paper", v.uiContext().page?.kind === "grid", String(v.uiContext().page?.kind));
		add("grid paper marks the shape tool and nothing else", suggested().length === 1 && suggested()[0] === t("tool.shape"), suggested().join(","));
		const marked = document.querySelector<HTMLElement>(".notebook-tool-button.is-suggested");
		add("the mark is a dot on the tool itself, not a control of its own", !!marked && getComputedStyle(marked).backgroundImage.includes("radial-gradient"), marked ? getComputedStyle(marked).backgroundImage.slice(0, 40) : "none");
		const tools = Array.from(document.querySelectorAll<HTMLElement>(".notebook-tool-button")).map((b) => b.getAttribute("aria-label"));
		add("the seven tools keep their order", tools.length === 7 && tools[0] === t("tool.pen") && tools[4] === t("tool.shape") && tools[5] === t("tool.text"), tools.join(","));
		if (quickIds().length > 0) {
			add("on grid paper the ruler is the first quick action", quickIds()[0] === "toggle-ruler", quickIds().join(","));
			s.adaptPageType = false;
			await settle(api, v);
			add("with the page-type switch off nothing is marked and the ruler is not first", suggested().length === 0 && quickIds()[0] !== "toggle-ruler", `${suggested().length} marked, ${quickIds().join(",")}`);
			s.adaptPageType = true;
			await settle(api, v);
		} else {
			add("the view is too narrow for quick slots (phone): the mark alone adapts", suggested().length === 1);
		}

		// Ruled paper (page 2): pen and text.
		v.goToPage(1);
		await settle(api, v);
		add("page 2 is ruled paper", v.uiContext().page?.kind === "ruled", String(v.uiContext().page?.kind));
		add("ruled paper marks the pen and the text tool", suggested().length === 2 && suggested().includes(t("tool.pen")) && suggested().includes(t("tool.text")), suggested().join(","));
		v.goToPage(0);
		await settle(api, v);

		// Pinning: press and hold a row of "All actions"; the pin is a quick action that never moves.
		await api.openMore();
		const row = document.querySelector(`.notebook-sheet [data-action="fit-width"]`);
		add("the All actions sheet lists the quick action Fit width", !!row);
		const menu = row ? openPinMenu(row) : null;
		add("press and hold on it offers to pin it", !!menu && menu.titles.includes(t("ui.pin.pin")), menu?.titles.join(",") ?? "no menu");
		menu?.run(t("ui.pin.pin"));
		await api.wait(120);
		add("it is pinned in the settings", s.pinnedQuick.includes("fit-width"), s.pinnedQuick.join(","));
		add("and the row shows the pin", !!document.querySelector(`.notebook-sheet [data-action="fit-width"] .notebook-menu-pin`));
		v.ui.sheet.close();
		await settle(api, v);
		if (quickIds().length > 0) {
			add("the pinned action is the first quick slot, marked as pinned", quickIds()[0] === "fit-width" && !!document.querySelector(`.notebook-quick [data-action="fit-width"].is-pinned`), quickIds().join(","));
			v.goToPage(1);
			await settle(api, v);
			add("it stays first on another kind of page", quickIds()[0] === "fit-width", quickIds().join(","));
			v.goToPage(0);
			await settle(api, v);
			const slot = document.querySelector(`.notebook-quick [data-action="fit-width"]`);
			const again = slot ? openPinMenu(slot) : null;
			add("press and hold on the slot offers to unpin it", !!again && again.titles.includes(t("ui.pin.unpin")), again?.titles.join(",") ?? "no menu");
			again?.run(t("ui.pin.unpin"));
			await settle(api, v);
			add("unpinning gives the slot back to the ranking", s.pinnedQuick.length === 0 && quickIds()[0] !== "fit-width", `${s.pinnedQuick.join(",")} / ${quickIds().join(",")}`);
		} else {
			s.pinnedQuick = [];
		}

		// Selection (page 1 has pen strokes): an ink selection says so and puts the ink actions first.
		v.selectItems(0, v.document.pages[0]!.strokes.slice(0, 2), []);
		await settle(api, v);
		const ctx = bar();
		add("a selection of ink shows the selection bar", ctx?.dataset.context === "selection", ctx?.dataset.context ?? "none");
		add("its label says Ink selection", ctx?.dataset.variant === "ink" && (ctx.querySelector(".notebook-context-label-text")?.textContent ?? "") === t("ui.context.selection.ink"), ctx?.dataset.variant ?? "none");
		const first = Array.from(ctx?.querySelectorAll<HTMLElement>(".notebook-context-main [data-action]") ?? []).map((b) => b.dataset.action);
		add("the stamp action leads and the layer actions are not in the bar", first.slice(0, 4).includes("stamps-save-selection") && !first.includes("layer-front"), first.join(","));
		add("Select similar is on its second row", !!ctx?.querySelector(`.notebook-context-second [data-action="selection-similar"]`));
		const tiny = Array.from(ctx?.querySelectorAll<HTMLElement>("button") ?? []).filter((b) => shown(b) && (b.getBoundingClientRect().height < 39.5 || b.getBoundingClientRect().width < 39.5)).length;
		add("every button of the bar is at least 40 px", tiny === 0, `${tiny} small`);
		const r = ctx?.getBoundingClientRect();
		add("the bar stays inside the view", !!r && r.left >= -0.5 && r.right <= width + 0.5, r ? `${Math.round(r.left)}..${Math.round(r.right)} of ${width}` : "none");
		s.adaptSelection = false;
		await settle(api, v);
		const plain = bar();
		add("with the selection switch off the bar is the plain Selection", !plain?.dataset.variant && (plain?.querySelector(".notebook-context-label-text")?.textContent ?? "") === t("ui.context.selection"), plain?.dataset.variant ?? "");
		s.adaptSelection = true;
		await api.closeAll();
	} else {
		// The fake PDF pages are portrait; as slides (landscape) they are a slide deck.
		add("a portrait PDF page is a PDF page, not a slide", v.uiContext().page?.kind === "pdf", String(v.uiContext().page?.kind));
		const plain = bar();
		add("its bar offers the snapping highlighter beside search", plain?.dataset.context === "pdf" && !!plain.querySelector(`[data-action="toggle-snap-highlighter"]`) && !!plain.querySelector(`[data-action="pdf-search"]`), plain?.dataset.context ?? "none");
		for (const p of v.document.pages) {
			p.width = 960;
			p.height = 540;
		}
		await settle(api, v);
		add("landscape PDF pages are slides", v.uiContext().page?.kind === "slide", String(v.uiContext().page?.kind));
		const slide = bar();
		add("the bar is labelled Slide", slide?.dataset.variant === "slide" && (slide.querySelector(".notebook-context-label-text")?.textContent ?? "") === t("ui.context.pdf.slide"), slide?.dataset.variant ?? "none");
		const ids = Array.from(slide?.querySelectorAll<HTMLElement>(".notebook-context-main [data-action]") ?? []).map((b) => b.dataset.action);
		add("snapping highlighter, search and margins come first", ids.slice(0, 3).sort().join() === ["pdf-margins", "pdf-search", "toggle-snap-highlighter"].join(), ids.join(","));
		add("the highlighter is the invited tool", suggested().length === 1 && suggested()[0] === t("tool.highlighter"), suggested().join(","));
		const snap = slide?.querySelector<HTMLButtonElement>(`[data-action="toggle-snap-highlighter"]`);
		const before = s.snapHighlighter;
		snap?.click();
		await api.wait(250);
		const pressed = bar()?.querySelector(`[data-action="toggle-snap-highlighter"]`)?.getAttribute("aria-pressed");
		add("the snap button works: it switches the setting and shows it", s.snapHighlighter === !before && pressed === String(!before), `setting ${s.snapHighlighter}, pressed ${pressed}`);
		add("and the highlighter option of the toolbar agrees", v.readingTools?.snapping === !before);
		bar()?.querySelector<HTMLButtonElement>(`[data-action="toggle-snap-highlighter"]`)?.click();
		await api.wait(250);
		add("pressing it again restores it", s.snapHighlighter === before, String(s.snapHighlighter));
		s.adaptPageType = false;
		await settle(api, v);
		add("with the page-type switch off the bar is the plain PDF page", !bar()?.dataset.variant && suggested().length === 0, bar()?.dataset.variant ?? "");
		s.adaptPageType = true;
		await settle(api, v);
	}

	const overflow = document.documentElement.scrollWidth - window.innerWidth;
	add("nothing overflows sideways", overflow <= 1, `${overflow}px`);
	return { ok: results.every((x) => x.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { width, doc: docName() } };
}
