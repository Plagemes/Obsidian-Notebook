// 0.24 (#424): the plugin's own action search ranked by context. Obsidian's command palette order cannot be changed by a
// plugin, so the "All actions" sheet does it: what suits the view in front of the person (a selection, a PDF page, a
// lecture, the side pane, a presentation, the current tool) comes first, and a short "For this page" section tops the
// sheet. Pure and deterministic: no 'obsidian' import, unit-tested.
import { activeContexts, canOpacity, isChecked, isEnabled, isOneFigure, isRelevant, type ActionDef, type ToolId, type UiContext } from "./actions";
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
	// 0.28 (#403): what the shape of the selection suggests (the chips) also comes first under "For this page".
	if (hasSelection && c.selection?.suggest?.includes(a.id)) boost += HERE_MIN_BOOST + 5;
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
	// 0.30 (#245): tidying a flowchart fits a selection of a good many strokes (boxes, arrows and their writing), on any paper without lines to write on.
	if (a.id === "selection-flowchart" && hasSelection) boost += (c.selection?.strokes ?? 0) >= 6 ? (c.page?.kind === "ruled" ? 3 : 7) : 2;
	// 0.27 (#170): a macro fits where its first step can start: one that starts on the selection comes first when something is selected (enough for "For this page");
	// one that starts somewhere it cannot (nothing selected, a locked page) steps back; any other leans forward a little.
	// 0.28 (#41): the table actions fit a selected table above all (enough for "For this page"); inserting one leans forward a little on grid and plain paper.
	if (a.id.startsWith("table-") && c.selection?.table === true) boost += HERE_MIN_BOOST + 4;
	// 0.29 (#248): captioning fits a selected picture above all (enough for "For this page"); a reference fits once the notebook has a captioned
	// figure, and most with the text tool in hand (it puts a text box), but it only leans forward in the list: it never crowds "For this page".
	if (a.id === "figure-caption" && isOneFigure(c)) boost += HERE_MIN_BOOST;
	if (a.id === "figure-ref") boost += (c.figures?.captioned ?? 0) > 0 && !hasSelection ? (c.tool === "text" ? 12 : 6) : 0;
	// 0.29 (#244): "Chart from table" fits a selected table and "Update chart" a selected chart (both enough for "For this page"; the actions only show then).
	if (a.id === "chart-from-table" && c.selection?.chartable === true) boost += HERE_MIN_BOOST + 5;
	if (a.id === "chart-update" && c.selection?.chart === true) boost += HERE_MIN_BOOST + 6;
	// 0.30 (#147): "Compute table" fits a selected table a little more than its other actions (it is what typing a formula leads to).
	if (a.id === "table-compute" && c.selection?.table === true) boost += 2;
	// 0.30 (#247): numbered markers fit a selected picture above all (enough for "For this page"); on any other drawn selection the action only leans
	// forward; renumbering fits the markers of a figure that was changed since (one was deleted, a legend line is missing or left over).
	if (a.id === "figure-marker-add") boost += isOneFigure(c) ? HERE_MIN_BOOST + 1 : c.selection?.markers?.kind === "set" ? 6 : c.selection?.markers?.kind === "region" ? 3 : 0;
	if (a.id === "figure-markers-renumber" && c.selection?.markers?.kind === "set") boost += c.selection.markers.stale ? HERE_MIN_BOOST + 7 : 2;
	if (a.id === "insert-table" && !hasSelection && (c.page?.kind === "grid" || c.page?.kind === "plain")) boost += 4;
	if (a.group === "macros") boost += macroFit(a, c, hasSelection);
	// 0.29 (#182): the calculator fits where numbers are being worked on: a selected text box, equation or graph (the expression to work out,
	// or the formula to check) and the text tool in hand (enough for "For this page" when a text or an equation is selected); otherwise it
	// only leans forward a little on a page that can be edited, and never reaches "For this page" on its own.
	if (a.id === "calculator") {
		const worked = (c.selection?.texts ?? 0) + (c.selection?.equations ?? 0) + (c.selection?.graphs ?? 0);
		boost += worked > 0 ? HERE_MIN_BOOST + 2 : c.tool === "text" ? 12 : c.page && !c.page.locked ? 2 : 0;
	}
	// 0.28 (#184): the paint bucket fills shapes: with the shape tool in hand it is the next thing wanted (enough for "For this page"); with a selection
	// it steps back (the person is editing, not colouring); otherwise it only leans forward a little on a page that can be edited.
	if (a.id === "paint-bucket") boost += hasSelection ? 0 : c.tool === "shape" ? HERE_MIN_BOOST + 2 : c.page && !c.page.locked ? 3 : 0;
	// 0.29 (#10): the study tape comes first while its mode is on (to turn it off); revealing or hiding all the tapes fits a notebook that has
	// tapes (enough for "For this page"); laying one leans forward a little on a PDF page (slides to learn from) when the mode is off.
	if (a.id === "study-tape") boost += c.tapes?.drawing ? HERE_MIN_BOOST + 6 : c.page?.background === "pdf" ? 4 : 0;
	if ((a.id === "tapes-reveal-all" || a.id === "tapes-hide-all") && (c.tapes?.total ?? 0) > 0) boost += HERE_MIN_BOOST + 2;
	// 0.30 (#52): the sections list and the jumps fit a notebook divided into two or more sections (enough for "For this page" with three or
	// more); a new section leans forward in a long notebook that has none yet; editing one leans forward a little on the page that starts it.
	const sections = c.sections?.count ?? 0;
	if (a.id === "sections-list" || a.id === "section-next" || a.id === "section-previous") boost += sections >= 3 ? HERE_MIN_BOOST + 1 : sections >= 2 ? 10 : 0;
	if (a.id === "section-new") boost += sections === 0 && (c.page?.count ?? 0) >= 12 ? 8 : 0;
	if ((a.id === "section-rename" || a.id === "section-recolour") && c.sections?.starts) boost += 6;
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
