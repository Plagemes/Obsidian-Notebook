// 0.24 (#424): the plugin's own action search ranked by context. Obsidian's command palette order cannot be changed by a
// plugin, so the "All actions" sheet does it: what suits the view in front of the person (a selection, a PDF page, a
// lecture, the side pane, a presentation, the current tool) comes first, and a short "For this page" section tops the
// sheet. Pure and deterministic: no 'obsidian' import, unit-tested.
import { activeContexts, canOpacity, isChecked, isEnabled, isRelevant, type ActionDef, type ToolId, type UiContext } from "./actions";
import { isMacroActionId, startOfMacroAction } from "./macros";
import { usageBoost, type UsageMap } from "./usage";

/** At most this many entries in the "For this page" section. */
export const HERE_COUNT = 5;
/** An action needs at least this much context boost to be listed under "For this page". */
export const HERE_MIN_BOOST = 20;

/** Ids of the actions that belong to each tool in hand (by id prefix). */
const TOOL_PREFIXES: Readonly<Record<ToolId, readonly string[]>> = {
	pen: [],
	highlighter: ["highlighter-", "toggle-snap-highlighter"],
	eraser: ["eraser-"],
	lasso: ["select-"],
	shape: ["shape-"],
	text: ["text-"],
	space: ["space-"],
};

/** Extra score for how well an action fits the view in front of the person (0 when nothing is open). */
export function contextBoost(a: ActionDef, c: UiContext): number {
	if (!c.open) return 0;
	let boost = 0;
	// The contextual bar of the situation already treats this action as its own.
	const active = activeContexts(c);
	if (a.contexts?.some((k) => active.includes(k))) boost += 30;
	const hasSelection = !!c.selection && c.selection.strokes + c.selection.elements > 0;
	switch (a.group) {
		case "selection":
			boost += hasSelection ? 25 : c.tool === "lasso" ? 10 : 0;
			break;
		case "reading":
			boost += c.page?.background === "pdf" ? 22 : c.page?.background === "image" ? 10 : 0;
			break;
		case "lecture":
			boost += c.lecture ? 25 : 0;
			break;
		case "side":
			boost += c.sidePane.open ? 25 : c.sidePane.available ? 8 : 0;
			break;
		case "page":
			boost += c.page ? 6 : 0;
			break;
		case "navigate":
			boost += c.presenting ? 22 : c.page && c.page.count > 1 ? 4 : 0;
			break;
		case "history":
			// 0.25 (#84): the history panel fits once there is something to go back to (a little), and most when steps were just undone
			// (the way forward is in the panel: enough for "For this page"). It steps back for a presentation. The toolbar's own Undo and
			// Redo are fixed slots and do not take part.
			if (a.id === "history-panel" && !c.presenting && c.history) boost += c.history.redo > 0 ? HERE_MIN_BOOST + 2 : c.history.undo > 0 ? 12 : 0;
			break;
		case "app":
		case "dev":
			// Library-level and diagnostic actions step back while a notebook is in front.
			boost -= 10;
			break;
		default:
			break;
	}
	// The tool in hand: "eraser-…" options come first with the eraser, and so on.
	if (TOOL_PREFIXES[c.tool].some((p) => a.id.startsWith(p))) boost += 22;
	if (c.presenting && a.id === "present") boost += 30;
	// 0.25 (#219): the Lecture profile comes first during a class (until it is the one in use); Study only leans forward outside a class.
	if (a.id === "profile-lecture") boost += c.lecture && c.profile !== "lecture" ? 30 : 0;
	if (a.id === "profile-study") boost += !c.lecture && c.profile !== "study" ? 8 : 0;
	// 0.27 (#375): during a class the Lecture workspace (slides, notebook, outline) comes first until it holds; the picker leans forward
	// with a class on, and with the slides pane open (the arrangement is being built), but is never a "For this page" entry otherwise.
	if (a.id === "workspace-lecture") boost += c.lecture && c.workspace !== "lecture" ? 30 : c.sidePane.open && c.workspace !== "lecture" ? 6 : 0;
	if (a.id === "workspace-presets") boost += c.lecture ? 12 : c.sidePane.open ? 8 : 0;
	if (c.comments?.panel && a.id.startsWith("comment")) boost += 15;
	// 0.25 (#93): lining the words up fits ink on ruled paper above all (the words go onto the ruled line).
	if (a.id === "selection-baseline" && hasSelection && c.page?.kind === "ruled") boost += 10;
	// 0.28 (#76): turning and cropping the page fit a PDF page (a scan on its side, a slide with wide margins): they lean forward on one, but not
	// enough for "For this page" (the page is turned once, not all the time).
	if ((a.id === "pdf-rotate-right" || a.id === "pdf-rotate-left" || a.id === "pdf-crop") && c.page?.background === "pdf") boost += 6;
	// 0.26 (#358): the opacity fits a selection of ink, pictures or areas best, then the highlighter or a shape in hand (both enough for "For this page");
	// with the plain pen in hand (always, nearly) it only leans forward in the list, so it does not crowd "For this page".
	if (a.id === "opacity" && canOpacity(c)) boost += hasSelection ? HERE_MIN_BOOST + 8 : c.tool === "highlighter" || c.tool === "shape" ? HERE_MIN_BOOST : 10;
	// 0.26 (#238): the tidy-up fits writing: a good many strokes selected, and a ruled page when nothing is (the words go onto the rules).
	// On grid or plain paper it only leans forward in the page group: an ordinary page with the pen in hand shows no "For this page" section.
	if (a.id === "selection-tidy" && (c.selection?.strokes ?? 0) >= 12) boost += 8;
	if (a.id === "page-tidy" && !hasSelection && (c.page?.kind === "ruled" || c.page?.kind === "grid" || c.page?.kind === "plain")) boost += c.page.kind === "ruled" ? 16 : 10;
	// 0.28 (#256): reordering lines fits a page of writing: it comes first while the mode is on (to turn it off), leans forward on paper made for writing
	// when nothing is selected, and never reaches "For this page" on its own otherwise.
	if (a.id === "page-reorder-lines") boost += c.toggles.lineHandles ? HERE_MIN_BOOST + 6 : !hasSelection && (c.page?.kind === "ruled" || c.page?.kind === "grid" || c.page?.kind === "plain") ? (c.page.kind === "ruled" ? 6 : 3) : 0;
	// 0.26 (#66): reshaping handwriting fits a selection of strokes; a long wobbly line (underline, ruler line) on grid or plain paper is likelier meant straight.
	if (a.id === "selection-smooth" && hasSelection) boost += 4;
	if (a.id === "selection-straighten" && hasSelection && (c.page?.kind === "grid" || c.page?.kind === "plain")) boost += 6;
	// 0.27 (#170): a macro fits where its first step can start: one that starts on the selection comes first when something is selected (enough for "For this page");
	// one that starts somewhere it cannot (nothing selected, a locked page) steps back; any other leans forward a little.
	if (a.group === "macros") boost += macroFit(a, c, hasSelection);
	return boost;
}

/** The context boost of a macro (0 for any other action of the macros group). */
function macroFit(a: ActionDef, c: UiContext, hasSelection: boolean): number {
	if (!isMacroActionId(a.id)) return 0;
	const first = startOfMacroAction(a.id);
	if (!first) return -10;
	if (!isRelevant(first, c) || !isEnabled(first, c)) return -10;
	if (first.group === "selection") return hasSelection ? HERE_MIN_BOOST + 5 : 0;
	return first.group === "page" ? 6 : 4;
}

/** Score for ordering: designed priority, recent use, and the fit to the context. */
export function contextScore(a: ActionDef, c: UiContext, usage: UsageMap, now: number): number {
	return a.priority + usageBoost(usage[a.id], now) + contextBoost(a, c);
}

/** The "For this page" section: the best fitting usable actions of `pool`, apart from the ids shown elsewhere. */
export function forThisPage(pool: readonly ActionDef[], c: UiContext, usage: UsageMap, now: number, visible: ReadonlySet<string> = new Set(), limit: number = HERE_COUNT): ActionDef[] {
	if (!c.open) return [];
	return pool
		.map((a, i) => ({ a, i, b: contextBoost(a, c) }))
		.filter(({ a, b }) => b >= HERE_MIN_BOOST && !a.choices && !isChecked(a, c) && !visible.has(a.id) && isRelevant(a, c) && isEnabled(a, c))
		.sort((x, y) => contextScore(y.a, c, usage, now) - contextScore(x.a, c, usage, now) || x.i - y.i)
		.slice(0, limit)
		.map(({ a }) => a);
}
