// 0.14 generative UI (392, 393, 402): the deterministic rules that adapt the toolbar and the contextual bars. Pure.
//
// Every rule is a table: the same page, selection and settings always give the same bar. Three independent switches
// (settings: "Adaptive toolbar") turn each family off; pinned quick slots always come first, in the order the person
// chose, whatever the rules say. Nothing here learns by itself: the use counts come from ui/usage-store.ts.
import { ACTIONS, type ActionDef, type ToolId, type UiContext } from "./actions";
import type { PageKind } from "./page-kind";
import { mixFromCounts, selectionKindOf, type SelectionKind } from "./selection-kind";

/** The switches of the adaptive behaviours (settings: adaptPageType, adaptLearn, adaptSelection). */
export interface AdaptSwitches {
	/** 392: the toolbar follows the kind of page. */
	pageType: boolean;
	/** 393: quick slots are ranked by what is used in this notebook. */
	learn: boolean;
	/** 402: the selection bar follows what is selected. */
	selection: boolean;
}

export const ADAPT_ON: AdaptSwitches = { pageType: true, learn: true, selection: true };

/** What the layout engine needs from the adaptive rules. */
export interface LayoutAdapt {
	pageType: boolean;
	selection: boolean;
	/** Action ids the person pinned to the quick slots, in order (see `normalisePinned`). */
	pinned: readonly string[];
}

export const NO_ADAPT: LayoutAdapt = { pageType: false, selection: false, pinned: [] };

/** At most this many pinned quick slots (the toolbar keeps room for the ranked ones). */
export const MAX_PINNED = 3;

/** Whatever was stored, as a valid list of pinned ids: only actions that may be quick slots, no duplicates, at most MAX_PINNED. */
export function normalisePinned(data: unknown, actions: readonly ActionDef[] = ACTIONS): string[] {
	if (!Array.isArray(data)) return [];
	const out: string[] = [];
	for (const id of data) {
		if (typeof id !== "string" || out.includes(id)) continue;
		if (!actions.some((a) => a.id === id && a.surfaces.includes("quick"))) continue;
		out.push(id);
		if (out.length >= MAX_PINNED) break;
	}
	return out;
}

/** The pinned list after pinning or unpinning `id`; pinning past MAX_PINNED is refused (the list is returned as is). */
export function togglePinned(pinned: readonly string[], id: string, actions: readonly ActionDef[] = ACTIONS): string[] {
	if (pinned.includes(id)) return pinned.filter((p) => p !== id);
	if (pinned.length >= MAX_PINNED) return [...pinned];
	return normalisePinned([...pinned, id], actions);
}

// ---------------------------------------------------------------------------------------------------- page type (392)

interface PageTypeRule {
	/** Tools the page invites; the toolbar marks them (their order and place never change). */
	tools: readonly ToolId[];
	/** Extra priority for actions of the quick slots and of the PDF and image bars. */
	boosts: Readonly<Record<string, number>>;
}

const PAGE_TYPE: Readonly<Record<PageKind, PageTypeRule>> = {
	// A slide: highlight (snapping to the text lines), search, margins.
	slide: { tools: ["highlighter"], boosts: { "toggle-snap-highlighter": 60, "pdf-search": 20, "pdf-margins": 55, "crop-margins": 20 } },
	pdf: { tools: ["highlighter"], boosts: { "toggle-snap-highlighter": 35, "pdf-search": 15 } },
	image: { tools: ["pen"], boosts: { "pdf-margins": 20 } },
	// Ruled paper: pen and text.
	ruled: { tools: ["pen", "text"], boosts: {} },
	// Grid and dotted paper: ruler and shapes.
	grid: { tools: ["shape"], boosts: { "toggle-ruler": 45 } },
	plain: { tools: [], boosts: {} },
};

/** The tools the page invites (empty when the page-type rules are off or the page has no kind). */
export function suggestedTools(c: UiContext, a: Pick<LayoutAdapt, "pageType">): readonly ToolId[] {
	const kind = c.page?.kind;
	return a.pageType && kind ? PAGE_TYPE[kind].tools : [];
}

/** The page kind of the bar's label ("Slide" instead of "PDF page"), or null. */
export function pageVariant(c: UiContext, a: Pick<LayoutAdapt, "pageType">): "slide" | null {
	return a.pageType && c.page?.kind === "slide" ? "slide" : null;
}

// ----------------------------------------------------------------------------------------------- selection kind (402)

const LAYERS = ["layer-front", "layer-back", "layer-forward", "layer-backward"] as const;
const layers = (delta: number): Record<string, number> => Object.fromEntries(LAYERS.map((id) => [id, delta]));

/**
 * Extra priority per kind of selection. Ink: stamp it, find the same, link it. Picture: make white transparent, order,
 * transform. Text: link it. Mixed: align and order. Objects (maths, graphs, excerpts) keep the designed order.
 */
const keepDelete = (n: number) => ({ "delete-selection": n });  // Delete always stays in the main row of the bar, whatever the content puts first.
const SELECTION: Readonly<Record<SelectionKind, Readonly<Record<string, number>>>> = {
	ink: { ...keepDelete(12), "stamps-save-selection": 35, "selection-similar": 20, "link-selection": 20, ...layers(-25) },
	image: { ...keepDelete(20), "selection-white-transparent": 35, "layer-front": 38, "layer-back": 38, "selection-transform-menu": 25, "stamps-save-selection": -20 },
	text: { ...keepDelete(12), "link-selection": 35, "selection-open-link": 20, ...layers(-25), "stamps-save-selection": -15, "selection-transform-menu": -15 },
	mixed: { ...keepDelete(12), "selection-align-menu": 25, "layer-front": 32, "layer-back": 32, "stamps-save-selection": 10 },
	object: {},
};

/** The kind of the selection when the selection rules are on and something is selected, else null. */
export function selectionVariant(c: UiContext, a: Pick<LayoutAdapt, "selection">): SelectionKind | null {
	if (!a.selection || !c.selection) return null;
	return selectionKindOf(mixFromCounts(c.selection));
}

// -------------------------------------------------------------------------------------------------------------- boost

/** Extra priority of an action in this context from the page-type and selection rules (0 when they are off or do not name it). */
export function adaptBoost(a: ActionDef, c: UiContext, adapt: LayoutAdapt): number {
	let boost = 0;
	if (adapt.pageType && c.page?.kind) boost += PAGE_TYPE[c.page.kind].boosts[a.id] ?? 0;
	const kind = selectionVariant(c, adapt);
	if (kind) boost += SELECTION[kind][a.id] ?? 0;
	return boost;
}
