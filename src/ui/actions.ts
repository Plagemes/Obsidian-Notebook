// ui redesign: the action registry. One entry per user-facing action of the plugin: where it may appear, when it is
// relevant, how important it is and which command (hotkey) it is. Pure data and predicates: no 'obsidian' import, so the
// layout engine and the coverage tests run in Node. The behaviour lives elsewhere: view actions in view/view-actions.ts,
// global ones in main.ts, external ones in the module named by `owner`.
import type { MessageKey } from "../i18n";
import type { PageKind } from "./page-kind";

export type ToolId = "pen" | "highlighter" | "eraser" | "lasso" | "shape" | "text" | "space";

/** Sections of the sheets and of docs/design-ui.md, in display order. */
export const GROUP_ORDER = [
	"tool", "history", "selection", "navigate", "insert", "page", "reading", "side", "lecture", "view", "share", "notebook", "app", "zettel", "integration", "dev",
] as const;
export type ActionGroup = typeof GROUP_ORDER[number];

/**
 * Where an action may be placed.
 * - toolbar: fixed slot of the primary toolbar (tools, history, pages panel, page indicator, more).
 * - quick: candidate for the ranked quick slots of the primary toolbar (as many as fit the width).
 * - context: the contextual bar, for the contexts listed in `contexts`.
 * - options: the tool options popover (tap the active tool again).
 * - favourites: the favourite pens strip (and the radial favourites ring).
 * - radial: the pen's radial menu.
 * - sheet: the grouped "All actions" sheet (more button).
 * - page: the page sheet (page indicator, navigator thumbnail menu): actions on one page.
 * - notebook: Obsidian's "More options" menu of the notebook tab.
 * - library: the library view.
 * - palette: the command palette only (every action with `command` is also there).
 * - banner: a status banner of the view (safe mode, storage full, integrity, open on another device, heavy page); the
 *   banner owns its recovery buttons because they only make sense while it is shown.
 */
export type Surface = "toolbar" | "quick" | "context" | "options" | "favourites" | "radial" | "sheet" | "page" | "notebook" | "library" | "palette" | "banner";

/** Situations that bring their own contextual bar. */
export type ContextKind = "selection" | "lasso" | "side-pane" | "lecture" | "pdf" | "image";
/** When several apply, the first one in this list wins. */
export const CONTEXT_ORDER: readonly ContextKind[] = ["selection", "lasso", "side-pane", "lecture", "pdf", "image"];

/** Everything the UI needs to know to decide what to show. Built by the view (view/view-actions.ts) from its state. */
export interface UiContext {
	/** A document is open and can be edited (false: loading, read-only, annotations hidden). */
	editable: boolean;
	/** A document is open (possibly read-only). */
	open: boolean;
	tool: ToolId;
	selection: {
		strokes: number; elements: number; images: number; /** 1 when a selected text box holds a [[link]] */ links?: number;
		/** v9: selected equations and graphs (optional, 0 when absent). */ equations?: number; graphs?: number;
		/** v10: selected anchored excerpts (optional, 0 when absent). */ excerpts?: number;
		/** 0.14 (402): selected text boxes (optional, 0 when absent). */ texts?: number;
		/** 0.23 (#294): selected text boxes and equations that hold a typed chemical reaction (optional, 0 when absent). */ reactions?: number;
		/** 0.17 (#20): selected sticky notes, and how many of them are collapsed (optional, 0 when absent). */ stickies?: number; stickiesCollapsed?: number;
		/** 0.19 (#103): selected checkboxes, and how many of them are linked to a task (optional, 0 when absent). */ checkboxes?: number; checkboxesLinked?: number;
		/** 0.20 (#39): the selected items can be made one group (two or more, not already exactly one group), and how many of them are in a group now (optional, false and 0 when absent). */ canGroup?: boolean; grouped?: number;
	} | null;
	/** The page in view (index of the page sheet when it was opened from a thumbnail). */
	page: {
		index: number; count: number; background: "none" | "pdf" | "image"; infinite: boolean; bookmarked: boolean;
		/** wave 0.7: the page is flagged as heavy and can be split. Optional (false when absent). */
		splittable?: boolean;
		/** 0.14 (392): the kind of page (slide, PDF, image, ruled, grid, plain), for the adaptive toolbar. Optional (no adaptation when absent). */
		kind?: PageKind;
		/** 0.16 (#124): the page is locked and refuses edits. Optional (false when absent). */
		locked?: boolean;
		/** 0.18 (#227): the page is a quick tab of this notebook. Optional (false when absent). */
		quickTab?: boolean;
		/** 0.24 (#265): the page is in the global bookmarks list. Optional (false when absent). */
		globalBookmark?: boolean;
		/** 0.20 (#39): how many locked elements the page has. Optional (0 when absent). */
		lockedElements?: number;
	} | null;
	notebook: { pdfPages: boolean; backgrounds: boolean };
	/** A class of the timetable is on now. */
	lecture: boolean;
	sidePane: { available: boolean; open: boolean };
	reading: { annotationsHidden: boolean; dim: boolean; /** 0.14 (392): the highlighter snaps to the text lines of PDF pages. Optional (off when absent). */ snap?: boolean; /** 0.16 (#45): the Select text mode of PDF pages is on. Optional (off when absent). */ selectText?: boolean };
	toggles: {
		ruler: boolean; penOnly: boolean; navigator: boolean; /** One page at a time (wave 0.7). */ pageMode?: boolean; /** Pen gesture mode (wave 0.8). */ penGestures?: boolean;
		/** wave 0.10 (63): the lasso tool selects with a rectangle instead of a freehand outline. */ selectRectangle?: boolean;
		/** 0.25 (#99): the highlighter marks rectangles (area highlighter) instead of strokes. */ highlighterArea?: boolean;
		/** wave 0.10 (51): the user switched this view to read-only mode. */ readOnly?: boolean;
		/** 0.17 (#71): snap is available (the setting is not "off") and whether it is on now (not paused in this view). Optional (absent: available, on). */ snapAvailable?: boolean; snap?: boolean;
	};
	/** wave 0.10 (81): the device can print (desktop with a print dialog); false or absent on a phone or tablet. */
	canPrint?: boolean;
	/** wave 0.8: invisible-ink pen mode and the view-only "Show solutions" toggles (notebook, page in view). Optional. */
	markers?: { invisibleInk: boolean; solutions: boolean; pageSolutions: boolean };
	/** wave 0.9: view-only night mode (367) and cropped PDF margins (376). Optional (both off when absent). */
	display?: { night: boolean; crop: boolean };
	/** 0.15 (241): the state strip is open. Optional (closed when absent). */
	states?: { open: boolean };
	/** 0.18 (#86): the comments panel is open, how many comments the notebook has (open ones apart), and a rectangle is being drawn for a new one. Optional (absent: none). */
	comments?: { panel: boolean; total: number; open: number; drawing?: boolean };
	/** 0.24 (#424): presentation mode is on. Optional (off when absent). */
	presenting?: boolean;
	/** wave 0.10: how many notebook views are open in the workspace (tabs). Optional (0 when absent). */
	openNotebooks?: number;
	/** wave 0.10 (18): the back/forward history of visited pages has somewhere to go. Optional (absent: nothing to go back to). */
	nav?: { back: boolean; forward: boolean };
	/** 0.25 (#84): how many steps the undo history holds (to take back) and how many were undone (to bring back). Optional (absent: none). */
	history?: { undo: number; redo: number };
	/** Phone-sized view (the page panel is a drawer, the toolbar has two rows). */
	narrow: boolean;
}

export interface ActionDef {
	/** Stable id. For actions with `command` it is the Obsidian command id (hotkeys depend on it: never rename). */
	readonly id: string;
	readonly label: MessageKey;
	/** Lucide icon name (setIcon). */
	readonly icon: string;
	readonly group: ActionGroup;
	readonly surfaces: readonly Surface[];
	/** 0–100: higher comes first in the quick slots and the contextual bar. */
	readonly priority: number;
	/** view: runs on the active notebook view; global: runs on the plugin; external: registered by another module. */
	readonly scope: "view" | "global" | "external";
	/** Registers an Obsidian command (name: this key, or the label). */
	readonly command?: MessageKey | true;
	/** The module that registers an external command (documentation and tests). */
	readonly owner?: string;
	readonly contexts?: readonly ContextKind[];
	/** Relevant in this context (hidden otherwise). Default: always. */
	readonly when?: (c: UiContext) => boolean;
	/** Shown but disabled when false. Default: view actions need an editable document unless `readOnly`. */
	readonly enabled?: (c: UiContext) => boolean;
	/** Works on a read-only document (navigation, export, reading). */
	readonly readOnly?: boolean;
	/** Toggle state shown on the control. */
	readonly checked?: (c: UiContext) => boolean;
	readonly danger?: boolean;
	/** wave 0.10: on the second row of the contextual bar (under the main row), for contexts that have one (the selection). */
	readonly second?: true;
	/** An inline row of choices in the sheets instead of a single row. */
	readonly choices?: "paper" | "size";
	/** Extra search words (any language). */
	readonly keywords?: string;
}

/** Back and Forward only show once the history has somewhere to go. */
const hasNav = (c: UiContext) => !!c.nav && (c.nav.back || c.nav.forward);
/** 0.16 (#124): the page in view can be changed (the notebook is editable and the page is not locked). */
const pageOpen = (c: UiContext) => c.editable && !c.page?.locked;
const pdfPage = (c: UiContext) => c.page?.background === "pdf";
const backgroundPage = (c: UiContext) => !!c.page && c.page.background !== "none";
const hasSelection = (c: UiContext) => !!c.selection && c.selection.strokes + c.selection.elements > 0;
/** wave 0.10: how many things are selected (strokes and elements), and whether the selection holds ink. */
const itemCount = (c: UiContext) => (c.selection?.strokes ?? 0) + (c.selection?.elements ?? 0);
const lassoOrSelection = (c: UiContext) => c.tool === "lasso" || itemCount(c) > 0;
const hasInk = (c: UiContext) => (c.selection?.strokes ?? 0) > 0;
/** wave 0.10 (363): another notebook is open to go to. */
const otherNotebooks = (c: UiContext) => (c.openNotebooks ?? 0) > 1;
const sideOpen = (c: UiContext) => c.sidePane.available && c.sidePane.open;
/** v9: exactly one equation or graph is selected (its editor or panel can open). */
const oneMath = (c: UiContext) => (c.selection?.equations ?? 0) + (c.selection?.graphs ?? 0) === 1;

function tool(id: ToolId, icon: string, label: MessageKey, command: MessageKey, priority: number): ActionDef {
	return { id: `tool-${id}`, label, icon, group: "tool", surfaces: ["toolbar", "radial"], priority, scope: "view", command, checked: (c) => c.tool === id };
}

function favourite(n: number): ActionDef {
	return { id: `favourite-${n}`, label: "command.favourite", icon: "star", group: "tool", surfaces: ["favourites", "radial"], priority: 50, scope: "view", command: true };
}

function external(id: string, label: MessageKey, icon: string, group: ActionGroup, owner: string, surfaces: readonly Surface[] = ["palette"]): ActionDef {
	return { id, label, icon, group, surfaces, priority: 10, scope: "external", command: true, owner, readOnly: true };
}

/** A recovery button of a status banner (no command: it only applies while its banner is shown). */
function banner(id: string, label: MessageKey, icon: string, group: ActionGroup, owner: string): ActionDef {
	return { id, label, icon, group, surfaces: ["banner"], priority: 50, scope: "external", owner, readOnly: true };
}

function global(id: string, label: MessageKey, icon: string, group: ActionGroup, surfaces: readonly Surface[], priority = 20): ActionDef {
	return { id, label, icon, group, surfaces, priority, scope: "global", command: true, readOnly: true };
}

/** Every action, in a designed order (the order of the sheets inside each group). */
export const ACTIONS: readonly ActionDef[] = [
	// --- tools: always in the primary toolbar, and in the radial pen case.
	tool("pen", "pencil", "tool.pen", "command.tool.pen", 100),
	tool("highlighter", "highlighter", "tool.highlighter", "command.tool.highlighter", 99),
	tool("eraser", "eraser", "tool.eraser", "command.tool.eraser", 98),
	tool("lasso", "lasso", "tool.lasso", "command.tool.lasso", 97),
	tool("shape", "shapes", "tool.shape", "command.tool.shape", 96),
	tool("text", "type", "tool.text", "command.tool.text", 95),
	tool("space", "move-vertical", "tool.space", "command.tool.space", 94),
	...(["line", "arrow", "rectangle", "ellipse"] as const).map((kind): ActionDef => ({
		id: `shape-${kind}`, label: `shape.${kind}`, icon: { line: "minus", arrow: "arrow-up-right", rectangle: "square", ellipse: "circle" }[kind],
		group: "tool", surfaces: ["options", "radial"], priority: 60, scope: "view", command: `command.tool.${kind}`,
	})),
	{ id: "eraser-stroke", label: "tool.eraser.stroke", icon: "eraser", group: "tool", surfaces: ["options"], priority: 60, scope: "view", command: "command.tool.eraserStroke" },
	{ id: "eraser-segment", label: "tool.eraser.segment", icon: "scissors", group: "tool", surfaces: ["options"], priority: 60, scope: "view", command: "command.tool.eraserSegment" },
	{ id: "eraser-area", label: "tool.eraser.area", icon: "square-dashed", group: "tool", surfaces: ["options"], priority: 60, scope: "view" },
	{ id: "eraser-larger", label: "command.eraserLarger", icon: "plus", group: "tool", surfaces: ["options", "palette"], priority: 40, scope: "view", command: true },
	{ id: "eraser-smaller", label: "command.eraserSmaller", icon: "minus", group: "tool", surfaces: ["options", "palette"], priority: 40, scope: "view", command: true },
	// wave 0.10 (7, 68): the free colour picker, the page eyedropper and the style eyedropper (view/colour-tools.ts). The picker and the
	// eyedropper are also on the radial colour ring; all three are buttons of the colour row of the tool options.
	{ id: "colour-picker", label: "command.colourPicker", icon: "palette", group: "tool", surfaces: ["options", "radial", "palette"], priority: 45, scope: "view", command: true, keywords: "colour color custom hex hue recent" },
	{ id: "colour-eyedropper", label: "command.colourEyedropper", icon: "pipette", group: "tool", surfaces: ["options", "radial", "palette"], priority: 44, scope: "view", command: true, keywords: "colour color pick sample" },
	{ id: "style-eyedropper", label: "command.styleEyedropper", icon: "droplets", group: "tool", surfaces: ["options", "palette"], priority: 43, scope: "view", command: true, keywords: "style pen width tool copy format stroke" },
	...[1, 2, 3, 4, 5, 6].map(favourite),

	// --- history: fixed in the toolbar, also in the radial menu and as gestures.
	{ id: "undo", label: "tool.undo", icon: "undo", group: "history", surfaces: ["toolbar", "radial"], priority: 100, scope: "view", command: "command.undo" },
	{ id: "redo", label: "tool.redo", icon: "redo", group: "history", surfaces: ["toolbar", "radial"], priority: 99, scope: "view", command: "command.redo" },
	// 0.25 (#84): every step listed, a tap goes back or forward to that point. The list can be read on a read-only notebook (it cannot jump there).
	{ id: "history-panel", label: "histpanel.menu", icon: "history", group: "history", surfaces: ["sheet", "notebook"], priority: 45, scope: "view", command: "command.historyPanel", readOnly: true, keywords: "undo redo history steps jump back go to point storico passi azioni annulla ripeti torna" },

	// --- selection: the contextual bar of the lasso.
	{ id: "selection-copy", label: "selection.copy", icon: "copy", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 90, scope: "view", when: hasSelection },
	{ id: "selection-cut", label: "selection.cut", icon: "scissors", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 85, scope: "view", when: hasSelection },
	{ id: "selection-duplicate", label: "selection.duplicate", icon: "copy-plus", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 80, scope: "view", when: hasSelection },
	{ id: "selection-paste", label: "selection.paste", icon: "clipboard-paste", group: "selection", surfaces: ["context"], contexts: ["selection", "lasso"], priority: 75, scope: "view", when: (c) => c.tool === "lasso" || hasSelection(c) },
	{ id: "selection-white-transparent", label: "selection.whiteTransparent", icon: "eraser", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 60, scope: "view", when: (c) => (c.selection?.images ?? 0) > 0 },
	{ id: "link-selection", label: "penlinks.linkSelection", icon: "link", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 55, scope: "view", command: "command.linkSelection", when: hasSelection },
	{ id: "selection-open-link", label: "penlinks.openLink", icon: "external-link", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 56, scope: "view", when: (c) => (c.selection?.links ?? 0) > 0 },
	// wave 0.9: math — edit the selected equation or graph, turn equations into ink.
	{ id: "math-edit", label: "math.edit", icon: "square-function", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 92, scope: "view", command: "math.command.edit", when: oneMath },
	{ id: "math-convert-ink", label: "math.convertInk", icon: "pen-line", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 58, scope: "view", command: "math.command.convertInk", when: (c) => (c.selection?.equations ?? 0) > 0 },
	// 0.23 (#294): balance the chemical reaction typed in the selected text boxes and equations.
	{ id: "chem-balance", label: "chem.balance", icon: "flask-conical", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 57, scope: "view", command: "chem.command.balance", when: (c) => (c.selection?.reactions ?? 0) > 0, keywords: "chemistry reaction balance equation stoichiometry chimica reazione bilancia" },
	// v10: anchored excerpts (#105). With a selection they excerpt its region; with nothing selected the next drag on a page
	// outlines the region (lasso bar, All actions sheet). "Go to source" when an excerpt is selected.
	{ id: "excerpt-open-source", label: "excerpt.openSource", icon: "corner-up-left", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 93, scope: "view", command: "excerpt.command.openSource", readOnly: true, when: (c) => (c.selection?.excerpts ?? 0) > 0, keywords: "excerpt source back jump origin estratto fonte" },
	{ id: "excerpt-to-page", label: "excerpt.toPage", icon: "crop", group: "insert", surfaces: ["context", "sheet"], contexts: ["selection", "lasso"], priority: 46, scope: "view", command: "excerpt.command.toPage", keywords: "excerpt clip cut region quote anchor pdf estratto ritaglio citazione" },
	{ id: "excerpt-copy", label: "excerpt.copy", icon: "clipboard-copy", group: "insert", surfaces: ["context", "sheet"], contexts: ["selection", "lasso"], priority: 44, scope: "view", command: "excerpt.command.copy", keywords: "excerpt clip region another notebook estratto copia quaderno" },
	{ id: "stamps-save-selection", label: "stamps.save", icon: "stamp", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 50, scope: "view", when: hasSelection },
	// 0.21 (212): the lasso selection as a symbol of the quick strip.
	{ id: "symbols-save-selection", label: "symbols.save", icon: "sigma", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 30, scope: "view", when: hasSelection, keywords: "symbol maths formula simbolo" },
	// wave 0.9 (357): layer order of the selection. Front and back are the strongest moves, so they rank higher in a narrow bar.
	...([
		["front", "bring-to-front", 52, "command.layerFront"], ["back", "send-to-back", 51, "command.layerBack"],
		["forward", "move-up", 45, "command.layerForward"], ["backward", "move-down", 44, "command.layerBackward"],
	] as const).map(([move, icon, priority, command]): ActionDef => ({
		id: `layer-${move}`, label: `layer.${move}`, icon, group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"],
		priority, scope: "view", command, when: hasSelection, keywords: "layer order z arrange stack front back behind above below",
	})),
	// wave 0.10: rectangle selection mode (63) and select by colour or tool (64) belong to the lasso; the rest of the arranging
	// (38, 65) and "Select similar" (64) are menus on the second row of the selection bar, each entry also in the sheet and a command.
	{ id: "select-rectangle", label: "select.rectangle", icon: "box-select", group: "selection", surfaces: ["context", "sheet"], contexts: ["lasso"], priority: 66, scope: "view", command: "command.selectRectangle", when: lassoOrSelection, checked: (c) => !!c.toggles.selectRectangle, keywords: "lasso freehand box marquee mode" },
	{ id: "select-by-style", label: "select.byStyle", icon: "palette", group: "selection", surfaces: ["context", "sheet"], contexts: ["lasso"], priority: 64, scope: "view", command: "command.selectByStyle", when: lassoOrSelection, keywords: "colour color tool pen highlighter same similar all page" },
	{ id: "selection-similar", label: "select.similar", icon: "check-check", group: "selection", surfaces: ["context"], contexts: ["selection"], second: true, priority: 62, scope: "view", when: hasInk },
	// 0.23 (#314): hooks at the ends of strokes and stray dots, cleaned in one undo step.
	{ id: "selection-cleanup", label: "cleanup.action", icon: "sparkles", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], second: true, priority: 58, scope: "view", command: "command.cleanUp", when: hasInk, keywords: "clean tidy hook tick dot bounce stray trim pulisci uncino puntino" },
	// 0.24 (#313): strokes that a tiny pen dropout split in two are joined, in one undo step (needs two strokes).
	{ id: "selection-join", label: "joinstrokes.action", icon: "merge", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], second: true, priority: 58, scope: "view", command: "command.joinStrokes", when: (c) => (c.selection?.strokes ?? 0) >= 2, keywords: "join merge broken split dropout gap line connect unisci spezzato tratto interruzione" },
	// 0.15 states (#241): the selected ink becomes a part of the drawing, which the states of the page move together (view/states-tools.ts).
	{ id: "selection-part", label: "states.makePart", icon: "group", group: "selection", surfaces: ["sheet"], priority: 38, scope: "view", command: "command.makePart", when: hasInk, keywords: "states part group figure physics stati parte gruppo" },
	{ id: "select-same-colour", label: "select.sameColour", icon: "palette", group: "selection", surfaces: ["sheet"], priority: 48, scope: "view", command: "command.selectSameColour", when: hasInk, keywords: "similar color all" },
	{ id: "select-same-tool", label: "select.sameTool", icon: "highlighter", group: "selection", surfaces: ["sheet"], priority: 47, scope: "view", command: "command.selectSameTool", when: hasInk, keywords: "similar pen highlighter all" },
	{ id: "selection-align-menu", label: "arrange.align", icon: "align-horizontal-distribute-center", group: "selection", surfaces: ["context"], contexts: ["selection"], second: true, priority: 60, scope: "view", when: (c) => itemCount(c) >= 2 },
	...([
		["left", "align-start-vertical"], ["centre", "align-center-vertical"], ["right", "align-end-vertical"],
		["top", "align-start-horizontal"], ["middle", "align-center-horizontal"], ["bottom", "align-end-horizontal"],
	] as const).map(([mode, icon]): ActionDef => ({
		id: `selection-align-${mode}`, label: `arrange.align.${mode}`, icon, group: "selection", surfaces: ["sheet"], priority: 40, scope: "view",
		command: `command.align.${mode}`, when: (c) => itemCount(c) >= 2, keywords: "align arrange edge centre center middle",
	})),
	...([["horizontal", "align-horizontal-distribute-center"], ["vertical", "align-vertical-distribute-center"]] as const).map(([axis, icon]): ActionDef => ({
		id: `selection-distribute-${axis === "horizontal" ? "h" : "v"}`, label: `arrange.distribute.${axis}`, icon, group: "selection", surfaces: ["sheet"], priority: 39, scope: "view",
		command: `command.distribute.${axis}`, when: (c) => itemCount(c) >= 3, keywords: "distribute spread space evenly arrange",
	})),
	{ id: "snap-toggle", label: "snap.toggle", icon: "magnet", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 30, scope: "view", when: (c) => hasSelection(c) && c.toggles.snapAvailable !== false, checked: (c) => c.toggles.snap !== false, keywords: "snap magnet grid guides align pause free move aggancio guide griglia" },
	{ id: "selection-transform-menu", label: "transform.menu", icon: "rotate-3d", group: "selection", surfaces: ["context"], contexts: ["selection"], second: true, priority: 58, scope: "view", when: hasSelection },
	{ id: "selection-rotate-cw", label: "transform.rotateCw", icon: "rotate-cw", group: "selection", surfaces: ["sheet"], priority: 38, scope: "view", command: "command.rotateCw", when: hasSelection, keywords: "turn quarter 90 clockwise" },
	{ id: "selection-rotate-ccw", label: "transform.rotateCcw", icon: "rotate-ccw", group: "selection", surfaces: ["sheet"], priority: 37, scope: "view", command: "command.rotateCcw", when: hasSelection, keywords: "turn quarter 90 anticlockwise counterclockwise" },
	{ id: "selection-mirror-h", label: "transform.mirrorH", icon: "flip-horizontal", group: "selection", surfaces: ["sheet"], priority: 36, scope: "view", command: "command.mirrorH", when: hasSelection, keywords: "flip reflect left right" },
	{ id: "selection-mirror-v", label: "transform.mirrorV", icon: "flip-vertical", group: "selection", surfaces: ["sheet"], priority: 35, scope: "view", command: "command.mirrorV", when: hasSelection, keywords: "flip reflect up down top bottom" },
	{ id: "selection-resize", label: "transform.resize", icon: "maximize-2", group: "selection", surfaces: ["sheet"], priority: 34, scope: "view", command: "command.resizeSelection", when: hasSelection, keywords: "size width height scale exact dimensions proportions" },
	{ id: "delete-selection", label: "tool.deleteSelection", icon: "trash-2", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 70, scope: "view", command: "command.deleteSelection", when: hasSelection, danger: true },

	// --- navigation (wave 0.7): the first section of the page sheet (the page indicator opens it) and of the sheet.
	{ id: "goto-page-number", label: "command.gotoPageNumber", icon: "hash", group: "navigate", surfaces: ["page", "sheet"], priority: 85, scope: "view", command: true, readOnly: true, keywords: "jump number bookmark" },
	{ id: "recent-pages", label: "command.recentPages", icon: "history", group: "navigate", surfaces: ["page", "sheet", "library"], priority: 60, scope: "global", command: true, readOnly: true, keywords: "edited last" },
	// wave 0.10 (18): back/forward through the visited pages, within and across notebooks. They are quick slots (when the
	// width allows), part of the Go to section of the page sheet, commands (hotkeys) and the mouse side buttons on desktop.
	{ id: "nav-back", label: "nav.back", icon: "arrow-left", group: "navigate", surfaces: ["quick", "page", "sheet"], priority: 64, scope: "view", command: "command.navBack", readOnly: true, when: hasNav, enabled: (c) => !!c.nav?.back, keywords: "previous history visited return indietro" },
	{ id: "nav-forward", label: "nav.forward", icon: "arrow-right", group: "navigate", surfaces: ["quick", "page", "sheet"], priority: 63, scope: "view", command: "command.navForward", readOnly: true, when: hasNav, enabled: (c) => !!c.nav?.forward, keywords: "next history visited avanti" },
	{ id: "bookmarks-open", label: "gbm.open", icon: "bookmark", group: "navigate", surfaces: ["page", "sheet", "library"], priority: 54, scope: "global", command: true, readOnly: true, keywords: "bookmarks list pages notebooks segnalibri elenco pagine" },
	{ id: "go-to-page", label: "command.goToPage", icon: "file-search", group: "navigate", surfaces: ["sheet", "library"], priority: 55, scope: "global", command: true, readOnly: true, keywords: "switcher find notebook" },
	{ id: "toggle-page-mode", label: "toolbar.pageMode", icon: "book-open", group: "navigate", surfaces: ["quick", "page", "sheet"], priority: 46, scope: "view", command: "command.pageMode", readOnly: true, checked: (c) => !!c.toggles.pageMode, keywords: "swipe paged continuous scroll" },
	// wave 0.9 (361): find and replace in the text boxes of the notebook (a panel; the results jump to the page).
	{ id: "find-replace", label: "command.findReplace", icon: "replace", group: "navigate", surfaces: ["sheet"], priority: 48, scope: "view", command: true, readOnly: true, keywords: "search text box substitute change word" },

	// --- insert: quick slots (ranked) and the sheet.
	{ id: "insert-image", label: "tool.image", icon: "image-plus", group: "insert", surfaces: ["quick", "sheet"], priority: 70, scope: "view", keywords: "picture photo" },
	{ id: "stamps", label: "stamps.menu", icon: "stamp", group: "insert", surfaces: ["quick", "sheet"], priority: 62, scope: "view", keywords: "sticker" },
	{ id: "board-shot", label: "tool.boardShot", icon: "camera", group: "insert", surfaces: ["quick", "context", "sheet"], contexts: ["lecture"], priority: 55, scope: "view", command: "command.boardShot", keywords: "photo camera blackboard" },
	// wave 0.9: math
	{ id: "insert-equation", label: "math.insertEquation", icon: "sigma", group: "insert", surfaces: ["sheet"], priority: 52, scope: "view", command: "math.command.insertEquation", keywords: "formula latex maths math equazione formula" },
	// 0.17 (#20): sticky notes. Insert from the quick slots and the sheet; Edit / Collapse / Open on the selection bar.
	{ id: "insert-sticky", label: "sticky.insert", icon: "sticky-note", group: "insert", surfaces: ["quick", "sheet"], priority: 58, scope: "view", command: "sticky.command.insert", enabled: pageOpen, keywords: "sticky note post-it memo reminder nota adesiva promemoria foglietto" },
	{ id: "sticky-edit", label: "sticky.edit", icon: "square-pen", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 91, scope: "view", when: (c) => (c.selection?.stickies ?? 0) === 1, enabled: pageOpen, keywords: "sticky note text colour nota adesiva testo colore" },
	{ id: "sticky-collapse", label: "sticky.collapse", icon: "minimize-2", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 90, scope: "view", when: (c) => (c.selection?.stickies ?? 0) > (c.selection?.stickiesCollapsed ?? 0), enabled: pageOpen, keywords: "sticky note collapse fold icon nota adesiva comprimi" },
	{ id: "sticky-expand", label: "sticky.expand", icon: "maximize-2", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 90, scope: "view", when: (c) => (c.selection?.stickiesCollapsed ?? 0) > 0, enabled: pageOpen, keywords: "sticky note open expand nota adesiva apri espandi" },
	// 0.19 (#103): handwritten checklists. A drawn square becomes a checkbox (view/checklist-tools.ts); insert one from the sheet, tick / label /
	// send to tasks from the selection bar. Tapping a checkbox with the pen or a finger ticks it without selecting it.
	{ id: "insert-checkbox", label: "checklist.insert", icon: "square-check", group: "insert", surfaces: ["sheet"], priority: 57, scope: "view", command: "checklist.command.insert", enabled: pageOpen, keywords: "checkbox checklist todo tick task list casella spunta elenco attivita lista" },
	{ id: "insert-axes", label: "axes.insert", icon: "axis-3d", group: "insert", surfaces: ["sheet"], priority: 56, scope: "view", command: "axes.command.insert", enabled: pageOpen, keywords: "axes axis graph cartesian plot ticks assi grafico cartesiano piano" },
	{ id: "checkbox-toggle", label: "checklist.toggle", icon: "square-check", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 93, scope: "view", when: (c) => (c.selection?.checkboxes ?? 0) > 0, enabled: pageOpen, keywords: "checkbox tick untick casella spunta" },
	{ id: "checkbox-select-label", label: "checklist.selectLabel", icon: "text-select", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 92, scope: "view", when: (c) => (c.selection?.checkboxes ?? 0) === 1, keywords: "checkbox label text select casella testo seleziona" },
	{ id: "checkbox-label", label: "checklist.editLabel", icon: "square-pen", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 89, scope: "view", when: (c) => (c.selection?.checkboxes ?? 0) === 1, enabled: pageOpen, keywords: "checkbox label name casella etichetta nome" },
	{ id: "checkbox-task", label: "checklist.sendTask", icon: "list-checks", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 88, scope: "view", when: (c) => (c.selection?.checkboxes ?? 0) === 1 && (c.selection?.checkboxesLinked ?? 0) === 0, enabled: pageOpen, keywords: "checkbox task todo tasks daily note casella attivita nota giornaliera" },
	{ id: "checkbox-unlink", label: "checklist.unlink", icon: "unlink", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 87, scope: "view", when: (c) => (c.selection?.checkboxesLinked ?? 0) > 0, enabled: pageOpen, keywords: "checkbox task unlink casella attivita scollega" },
	// 0.20 (#39): groups and locked elements. A group selects, moves, resizes and copies as one; a locked element is skipped by the lasso, a tap and the
	// eraser (a locked one is unlocked from the chip that a tap with the lasso offers, or from "Locked elements…" of the page menu).
	{ id: "selection-group", label: "groups.group", icon: "group", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 52, scope: "view", command: "groups.command.group", when: (c) => c.selection?.canGroup === true, enabled: pageOpen, keywords: "group together combine join one raggruppa unisci" },
	{ id: "selection-ungroup", label: "groups.ungroup", icon: "ungroup", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 51, scope: "view", command: "groups.command.ungroup", when: (c) => (c.selection?.grouped ?? 0) > 0, enabled: pageOpen, keywords: "ungroup split separate break group dividi separa gruppo" },
	{ id: "selection-lock", label: "groups.lock", icon: "lock", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 49, scope: "view", command: "groups.command.lock", when: (c) => (c.selection?.elements ?? 0) > 0, enabled: pageOpen, keywords: "lock fix pin freeze background anchor blocca fissa sfondo" },
	{ id: "insert-graph", label: "math.insertGraph", icon: "chart-spline", group: "insert", surfaces: ["sheet"], priority: 50, scope: "view", command: "math.command.insertGraph", keywords: "function plot chart curve grafico funzione" },
	// "add-page" is the Obsidian command (and its hotkey): it adds a page right away, same paper, as before 0.14. The on-screen "+" is
	// "add-page-suggest": it opens the Smart "+" strip (0.14, 410); the command of the same name opens that strip from the keyboard.
	{ id: "add-page", label: "tool.addPage", icon: "file-plus", group: "insert", surfaces: ["palette"], priority: 66, scope: "view", command: "command.addPage" },
	{ id: "add-page-suggest", label: "tool.addPage", icon: "file-plus", group: "insert", surfaces: ["quick", "sheet"], priority: 66, scope: "view", command: "command.addPageSuggest" },
	{ id: "insert-blank-page", label: "page.insertBlank", icon: "file-plus", group: "insert", surfaces: ["page"], priority: 60, scope: "view" },
	{ id: "exercise-page", label: "page.exercise", icon: "pencil-ruler", group: "insert", surfaces: ["context", "sheet", "page"], contexts: ["lecture"], priority: 45, scope: "view", command: "command.exercisePage" },
	{ id: "page-from-template", label: "page.newFromTemplate", icon: "file-plus-2", group: "insert", surfaces: ["sheet", "page"], priority: 40, scope: "view", keywords: "template" },
	{ id: "insert-pdf-pages", label: "page.insertPdf", icon: "file-input", group: "insert", surfaces: ["sheet", "page"], priority: 40, scope: "view" },
	{ id: "insert-image-page", label: "page.insertImage", icon: "image", group: "insert", surfaces: ["sheet", "page"], priority: 35, scope: "view" },
	{ id: "scan-into", label: "page.scanAfter", icon: "scan", group: "insert", surfaces: ["sheet", "page"], priority: 35, scope: "view", command: "command.scanInto", keywords: "camera document" },
	{ id: "scan-element", label: "page.scanInsert", icon: "scan-line", group: "insert", surfaces: ["sheet", "page"], priority: 30, scope: "view", keywords: "camera" },

	// --- page: the page sheet (and its section in the "All actions" sheet).
	// wave 0.8 (378): starts selecting pages in the page panel; its actions (move, duplicate, bookmark, tags, paper, size, PDF, delete) are
	// the bar of the panel itself (view/navigator.ts, view/page-ops-menu.ts), one undo step each.
	{ id: "pages-select", label: "pageOps.select", icon: "check-square", group: "page", surfaces: ["page", "sheet"], priority: 52, scope: "view", command: "command.selectPages", keywords: "several multiple move delete export" },
	{ id: "page-duplicate", label: "page.duplicate", icon: "copy", group: "page", surfaces: ["page"], priority: 50, scope: "view" },
	{ id: "page-move-up", label: "page.moveUp", icon: "arrow-up", group: "page", surfaces: ["page"], priority: 40, scope: "view", enabled: (c) => c.editable && (c.page?.index ?? 0) > 0 },
	{ id: "page-move-down", label: "page.moveDown", icon: "arrow-down", group: "page", surfaces: ["page"], priority: 40, scope: "view", enabled: (c) => c.editable && !!c.page && c.page.index < c.page.count - 1 },
	{ id: "page-bookmark", label: "page.bookmark", icon: "bookmark", group: "page", surfaces: ["page"], priority: 55, scope: "view", checked: (c) => !!c.page?.bookmarked },
	{ id: "page-edit-bookmark", label: "page.editBookmark", icon: "bookmark-plus", group: "page", surfaces: ["page"], priority: 40, scope: "view", when: (c) => !!c.page?.bookmarked },
	{ id: "page-tags", label: "page.tags", icon: "tag", group: "page", surfaces: ["page"], priority: 40, scope: "view" },
	{ id: "page-paper", label: "ui.paper", icon: "grid-3x3", group: "page", surfaces: ["page"], priority: 45, scope: "view", enabled: pageOpen, choices: "paper", keywords: "ruled grid dotted lined" },
	{ id: "page-size", label: "ui.size", icon: "ratio", group: "page", surfaces: ["page"], priority: 40, scope: "view", enabled: pageOpen, choices: "size", keywords: "a4 a5 letter" },
	{ id: "page-orientation", label: "ui.orientation", icon: "rotate-cw", group: "page", surfaces: ["page"], priority: 35, scope: "view", enabled: pageOpen, keywords: "landscape portrait" },
	{ id: "page-infinite", label: "page.infinite", icon: "infinity", group: "page", surfaces: ["page"], priority: 35, scope: "view", enabled: pageOpen, checked: (c) => !!c.page?.infinite },
	{ id: "move-pages", label: "page.moveToNotebook", icon: "folder-input", group: "page", surfaces: ["page"], priority: 30, scope: "view", enabled: pageOpen, command: "command.movePages" },
	// 0.18 (#186): copy pages to another notebook with a link chip back to the original.
	{ id: "copy-with-link", label: "page.copyToNotebook", icon: "copy-plus", group: "page", surfaces: ["page"], priority: 29, scope: "view", enabled: pageOpen, command: "command.copyToNotebook", keywords: "copy duplicate notebook link copia quaderno" },
	// 0.16 (#124): lock a finished page: it refuses every edit until it is unlocked. Two entries so the sheet says what a tap does;
	// the palette has one toggle for the page in view.
	{ id: "page-lock", label: "page.lock", icon: "lock", group: "page", surfaces: ["page", "sheet"], priority: 48, scope: "view", when: (c) => !c.page?.locked, keywords: "lock finish protect freeze read only blocca proteggi" },
	{ id: "page-unlock", label: "page.unlock", icon: "lock-open", group: "page", surfaces: ["page", "sheet"], priority: 49, scope: "view", when: (c) => !!c.page?.locked, keywords: "unlock edit sblocca" },
	{ id: "page-lock-toggle", label: "command.lockPage", icon: "lock", group: "page", surfaces: ["palette"], priority: 10, scope: "view", command: true },
	// 0.20 (#39): the elements locked on the page (a background picture that must not move): listed, shown and unlocked from here.
	{ id: "locked-elements", label: "groups.lockedElements", icon: "lock", group: "page", surfaces: ["page", "sheet"], priority: 47, scope: "view", command: "groups.command.lockedElements", when: (c) => (c.page?.lockedElements ?? 0) > 0, keywords: "locked lock fixed background element unlock bloccati sblocca sfondo" },
	// 0.18 (#227): quick tabs. Pinning does not edit the notebook (the pins are in _meta), so it works on a read-only or locked page too.
	{ id: "page-quick-tab", label: "quicktabs.pin", icon: "pin", group: "page", surfaces: ["page", "sheet"], priority: 47, scope: "view", command: true, checked: (c) => !!c.page?.quickTab, keywords: "quick tab pin pinned formula sheet fissa scheda rapida" },
	{ id: "page-quick-tab-other", label: "quicktabs.pinOther", icon: "book-open", group: "page", surfaces: ["page", "sheet"], priority: 46, scope: "view", command: true, keywords: "quick tab pin other notebook formula sheet fissa altro quaderno" },
	// 0.24 (#265): global bookmarks. The list is in _meta, never in a notebook, so toggling works on a read-only or locked page too.
	{ id: "page-global-bookmark", label: "gbm.toggle", icon: "bookmark-plus", group: "page", surfaces: ["page", "sheet"], priority: 45, scope: "view", command: true, checked: (c) => !!c.page?.globalBookmark, keywords: "global bookmark list all notebooks segnalibro globale elenco" },
	{ id: "page-save-template", label: "page.saveTemplate", icon: "layout-template", group: "page", surfaces: ["page"], priority: 25, scope: "view" },
	{ id: "page-restore-version", label: "page.restoreVersion", icon: "history", group: "page", surfaces: ["page"], priority: 20, scope: "view", enabled: pageOpen },
	{ id: "page-compare-version", label: "page.compareVersion", icon: "git-compare", group: "page", surfaces: ["page"], priority: 21, scope: "view", enabled: pageOpen },
	{ id: "page-deleted-pages", label: "page.deletedPages", icon: "archive-restore", group: "page", surfaces: ["page"], priority: 20, scope: "view", keywords: "trash restore" },
	// wave 0.9 (379): dates, ink, objects, files, tags, bookmark and markers of one page.
	{ id: "page-info", label: "page.info", icon: "info", group: "page", surfaces: ["page", "sheet"], priority: 42, scope: "view", command: true, readOnly: true, keywords: "properties details statistics strokes points size dates" },
	{ id: "page-split", label: "heavy.split", icon: "split", group: "page", surfaces: ["page", "banner"], priority: 45, scope: "view", enabled: pageOpen, when: (c) => !!c.page?.splittable, keywords: "heavy large slow" },
	// wave 0.9 (#303): practice copies of exercises (view/practice.ts). Only "redo" is in the page sheet: the strip over a
	// practice page has the other buttons, the commands are in the palette.
	{ id: "practice-redo", label: "page.redoExercise", icon: "rotate-ccw", group: "page", surfaces: ["page"], priority: 28, scope: "view", command: "command.practiceRedo", keywords: "practice attempt repeat hide solution exam" },
	{ id: "practice-peek", label: "command.practicePeek", icon: "eye", group: "page", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "practice-original", label: "command.practiceOriginal", icon: "corner-up-left", group: "page", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "practice-attempts", label: "command.practiceAttempts", icon: "list-ordered", group: "page", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "practice-timer", label: "command.practiceTimer", icon: "timer", group: "page", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "page-delete", label: "page.delete", icon: "trash-2", group: "page", surfaces: ["page"], priority: 10, scope: "view", danger: true, enabled: (c) => c.editable && !c.page?.locked && (c.page?.count ?? 0) > 1 },

	// --- PDF and reading: the contextual bar of a PDF page, and the sheet.
	{ id: "pdf-search", label: "reading.search", icon: "search", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 80, scope: "view", command: "command.pdfSearch", readOnly: true, when: (c) => c.notebook.pdfPages },
	// 0.14 (392): the highlighter follows the text lines of PDF pages (the same switch as the highlighter options and the settings).
	{ id: "toggle-snap-highlighter", label: "reading.snap", icon: "text-cursor", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 41, scope: "view", command: "command.snapHighlighter", readOnly: true, when: (c) => c.notebook.pdfPages, checked: (c) => !!c.reading.snap, keywords: "highlighter snap text lines evidenziatore testo righe" },
	// 0.25 (#99): the highlighter marks a rectangle (an area highlighter, drawn under the ink): ideal on scanned PDFs. The "highlighter-" prefix ranks it first while the highlighter is in hand; on a PDF page the reading group ranks it too.
	{ id: "highlighter-area", label: "highlighter.areaAction", icon: "highlighter", group: "reading", surfaces: ["sheet"], priority: 41, scope: "view", command: "command.highlighterArea", checked: (c) => !!c.toggles.highlighterArea, keywords: "highlighter area rectangle scan pdf block evidenziatore area rettangolo blocco scansione" },
	{ id: "pdf-select-text", label: "pdfText.selectText", icon: "text-cursor-input", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 72, scope: "view", command: "command.pdfSelectText", readOnly: true, when: (c) => c.notebook.pdfPages, checked: (c) => !!c.reading.selectText, keywords: "select copy text quote pdf seleziona copia testo citazione" },
	{ id: "pdf-search-next", label: "command.pdfSearchNext", icon: "chevron-down", group: "reading", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "pdf-search-previous", label: "command.pdfSearchPrev", icon: "chevron-up", group: "reading", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "toggle-annotations", label: "reading.annotations.hide", icon: "eye-off", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 60, scope: "view", command: "command.annotationsToggle", readOnly: true, when: (c) => c.notebook.pdfPages, checked: (c) => c.reading.annotationsHidden },
	{ id: "toggle-dim-background", label: "reading.dim", icon: "sun-dim", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf", "image"], priority: 50, scope: "view", command: "command.dimToggle", readOnly: true, when: (c) => c.notebook.backgrounds, checked: (c) => c.reading.dim },
	{ id: "pdf-margins", label: "pdf.margins.menu", icon: "move-horizontal", group: "reading", surfaces: ["context", "page"], contexts: ["pdf", "image"], priority: 40, scope: "view", enabled: pageOpen, command: "command.pdfMargins", when: backgroundPage },
	// wave 0.9 (376): the white margins of PDF pages fall off screen (view-only; the notebook, the ink and the exports are unchanged).
	{ id: "crop-margins", label: "display.crop", icon: "crop", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 42, scope: "view", command: "command.cropMargins", readOnly: true, when: (c) => c.notebook.pdfPages, checked: (c) => !!c.display?.crop, keywords: "margins zoom small screen phone content ritaglia margini" },
	{ id: "pdf-update", label: "pdf.update.menu", icon: "refresh-cw", group: "reading", surfaces: ["page", "sheet"], priority: 20, scope: "view", enabled: pageOpen, command: "command.pdfUpdate", when: pdfPage },
	{ id: "pdf-annotations", label: "pdf.annotations.menu", icon: "file-text", group: "reading", surfaces: ["sheet", "page"], priority: 20, scope: "view", command: "command.pdfAnnotations", readOnly: true, when: (c) => c.notebook.pdfPages },

	// --- PDF side by side: the contextual bar while the pane is open.
	{ id: "pdf-side-open", label: "command.pdfSideOpen", icon: "columns-2", group: "side", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 45, scope: "view", command: true, readOnly: true, when: (c) => c.sidePane.available && !c.sidePane.open },
	{ id: "pdf-side-link", label: "command.pdfSideLink", icon: "link", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 80, scope: "view", command: true, when: sideOpen },
	{ id: "pdf-side-show-slide", label: "pdfSide.menu.showSlide", icon: "file-search", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 70, scope: "view", readOnly: true, when: sideOpen },
	{ id: "pdf-side-add-page", label: "command.pdfSideAdd", icon: "file-plus", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 75, scope: "view", command: true, when: sideOpen },
	{ id: "pdf-side-close", label: "command.pdfSideClose", icon: "panel-right-close", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 30, scope: "view", command: true, readOnly: true, when: sideOpen },
	// 0.20 refwindow (#107): the floating reference window. Read only (the reference is never edited), so these work on a read-only notebook too.
	{ id: "ref-open", label: "refwin.open", icon: "picture-in-picture-2", group: "side", surfaces: ["sheet"], priority: 46, scope: "view", command: "refwin.command.open", readOnly: true, keywords: "reference window floating pdf note picture page finestra riferimento flottante" },
	{ id: "ref-page", label: "refwin.openPage", icon: "picture-in-picture-2", group: "page", surfaces: ["page", "sheet"], priority: 28, scope: "view", command: "refwin.command.openPage", readOnly: true, keywords: "reference window floating page finestra riferimento flottante" },
	{ id: "ref-close", label: "refwin.close", icon: "picture-in-picture", group: "side", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "selection-open-reference", label: "refwin.openLink", icon: "picture-in-picture-2", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 54, scope: "view", readOnly: true, when: (c) => (c.selection?.links ?? 0) > 0 },
	// 0.15 states (#241): the strip of the states of the page in view: switch, play, add, move the parts of a figure from state to state.
	{ id: "states-toggle", label: "states.open", icon: "layers", group: "page", surfaces: ["sheet", "page"], priority: 30, scope: "view", command: "command.states", readOnly: true, checked: (c) => !!c.states?.open, keywords: "states drawing figure physics animation parts stati disegno figura animazione parti" },
	// 0.14 slides (#417): every slide with its notes pages, exercise page, linked ink and questions (view/slide-strip-modal.ts).
	{ id: "slide-strip", label: "slides.strip.open", icon: "layout-list", group: "side", surfaces: ["sheet"], priority: 72, scope: "view", command: "command.slideStrip", readOnly: true, when: (c) => sideOpen(c) || c.notebook.pdfPages, keywords: "slides strip notes exercise questions diapositive striscia" },

	// --- lecture: the contextual bar while a class of the timetable is on.
	{ id: "new-lecture", label: "page.newLecture", icon: "graduation-cap", group: "lecture", surfaces: ["context", "sheet"], contexts: ["lecture"], priority: 70, scope: "view", command: "command.newLecture" },
	// 0.14 (401): switches lecture mode on or off by hand (the rule starts it from the timetable); the contextual bar follows it.
	// 0.21 slideback (#225): palette command only (assign a hotkey in Obsidian); it applies once something was written during a lecture.
	{ id: "slide-back", label: "command.slideBack", icon: "corner-up-left", group: "lecture", surfaces: ["palette"], priority: 40, scope: "view", command: true, readOnly: true, keywords: "lecture slide return current page lezione diapositiva torna" },
	// 0.22 lecthead (#210): writes the course, lecturer, room, date and time of the class on the page in view (the class in progress, else the nearest of today).
	{ id: "lecture-header", label: "command.lectureHeader", icon: "graduation-cap", group: "lecture", surfaces: ["palette", "sheet"], priority: 38, scope: "view", command: true, keywords: "lecture header course lecturer room date time class intestazione lezione corso docente aula orario" },
	{ id: "lecture-mode", label: "command.lectureMode", icon: "graduation-cap", group: "lecture", surfaces: ["sheet"], priority: 72, scope: "view", command: true, readOnly: true, checked: (c) => c.lecture, keywords: "class timetable lesson classe orario" },
	{ id: "exercise-paper", label: "page.exercisePaper", icon: "palette", group: "lecture", surfaces: ["sheet"], priority: 20, scope: "view", command: "command.exercisePaper", readOnly: true },
	// wave 0.8: markers (#201-#203, #209) and structured boxes (#204): the next tap or drag on a page places one. Also on the radial dial (shapes ring → Markers).
	...([
		["gap", "ellipsis", 44], ["question", "help-circle", 43], ["homework", "calendar-check", 41], ["important", "alert-circle", 40], ["critical", "alert-triangle", 25], ["star", "star", 25],
	] as const).map(([kind, icon, priority]): ActionDef => ({
		id: `marker-${kind}`, label: `markers.place.${kind}`, icon, group: "lecture", surfaces: ["context", "radial", "sheet"], contexts: ["lecture"],
		priority, scope: "view", command: true, keywords: "marker badge",
	})),
	{ id: "marker-box", label: "markers.menu.box", icon: "square-dashed", group: "lecture", surfaces: ["context", "radial", "sheet"], contexts: ["lecture"], priority: 38, scope: "view", command: true, keywords: "definition theorem example proof remark callout" },
	{ id: "end-of-lecture", label: "markers.menu.panel", icon: "list-checks", group: "lecture", surfaces: ["context", "sheet", "page"], contexts: ["lecture"], priority: 42, scope: "view", command: true, readOnly: true, keywords: "questions gaps homework markers" },
	// wave 0.8: invisible ink (#100): a pen mode, and the view-only "Show solutions".
	{ id: "invisible-ink", label: "markers.command.invisible", icon: "eye-off", group: "view", surfaces: ["sheet"], priority: 35, scope: "view", command: true, checked: (c) => !!c.markers?.invisibleInk, keywords: "hidden solutions self-test" },
	{ id: "show-solutions", label: "markers.command.solutions", icon: "eye", group: "view", surfaces: ["sheet"], priority: 30, scope: "view", command: true, readOnly: true, checked: (c) => !!c.markers?.solutions, keywords: "invisible ink hidden" },
	{ id: "show-page-solutions", label: "markers.menu.pageSolutions", icon: "eye", group: "page", surfaces: ["page"], priority: 30, scope: "view", command: true, readOnly: true, checked: (c) => !!c.markers?.pageSolutions, keywords: "invisible ink hidden" },

	// --- wave 0.10 (363): tabs of the open notebooks (the strip and the toolbar swipe call the same step).
	// Roadmap #19: a copy of this notebook in the templates folder (works on a read-only notebook too: it only reads).
	{ id: "notebook-save-template", label: "nbtemplate.save.action", icon: "book-copy", group: "app", surfaces: ["sheet", "notebook", "palette"], priority: 18, scope: "view", command: true, readOnly: true, keywords: "template save copy planner lab book notebook modello salva quaderno" },
	{ id: "notebook-next", label: "command.notebookNext", icon: "chevron-right", group: "navigate", surfaces: ["sheet"], priority: 22, scope: "view", command: true, readOnly: true, when: otherNotebooks, keywords: "tab switch next notebook quaderno successivo scheda" },
	{ id: "notebook-previous", label: "command.notebookPrevious", icon: "chevron-left", group: "navigate", surfaces: ["sheet"], priority: 21, scope: "view", command: true, readOnly: true, when: otherNotebooks, keywords: "tab switch previous notebook quaderno precedente scheda" },

	// --- view and input.
	{ id: "toggle-pages-panel", label: "tool.pages", icon: "panel-left", group: "view", surfaces: ["toolbar"], priority: 100, scope: "view", command: "command.toggleNavigator", readOnly: true, checked: (c) => c.toggles.navigator },
	{ id: "toggle-ruler", label: "tool.ruler", icon: "ruler", group: "view", surfaces: ["quick", "radial", "sheet"], priority: 50, scope: "view", command: "command.toggleRuler", checked: (c) => c.toggles.ruler },
	{ id: "pen-only", label: "pens.penOnly", icon: "pen-tool", group: "view", surfaces: ["quick", "sheet"], priority: 42, scope: "view", command: "command.penOnly", readOnly: true, checked: (c) => c.toggles.penOnly, keywords: "finger touch palm" },
	// wave 0.10 (51): read-only mode of this view. The toolbar shows a button while it is on (tap to switch it off); the sheet and the command toggle it.
	{ id: "toggle-read-only", label: "readonly.toggle", icon: "lock", group: "view", surfaces: ["sheet"], priority: 44, scope: "view", command: "command.readOnly", readOnly: true, checked: (c) => !!c.toggles.readOnly, keywords: "lock protect accidental marks reading view only sola lettura blocca proteggi" },
	// wave 0.8: pen gestures. The mode toggle is a quick slot (the "move to page" gesture starts
	// from a selection); the cheat sheet and the custom gestures live in the sheet only.
	{ id: "pen-gesture-mode", label: "toolbar.penGestures", icon: "wand-2", group: "view", surfaces: ["quick", "sheet"], priority: 41, scope: "view", command: "command.penGestureMode", checked: (c) => !!c.toggles.penGestures, keywords: "gesture pen shortcut circle scribble" },
	{ id: "pen-gesture-sheet", label: "gesture.cheatSheet", icon: "help-circle", group: "view", surfaces: ["sheet"], priority: 20, scope: "view", command: "command.penGestureSheet", readOnly: true, keywords: "gestures help" },
	{ id: "pen-gesture-custom", label: "settings.penGestureCustom", icon: "wand", group: "view", surfaces: ["sheet"], priority: 15, scope: "view", command: "command.penGestureCustom", readOnly: true, keywords: "gestures record bind command" },
	// wave 0.9 (367): night mode, a view setting (dark page, stored colours unchanged, exports unaffected).
	{ id: "night-mode", label: "display.night", icon: "moon", group: "view", surfaces: ["sheet"], priority: 36, scope: "view", command: "command.nightMode", readOnly: true, checked: (c) => !!c.display?.night, keywords: "dark black theme notte scuro" },
	// 0.16 (#87): presentation mode: full screen, one page at a time, laser pointer (sheet, command, notebook map button).
	{ id: "present", label: "present.title", icon: "presentation", group: "view", surfaces: ["sheet"], priority: 47, scope: "view", command: "command.present", readOnly: true, keywords: "slideshow full screen laser pointer present presentazione schermo intero" },
	{ id: "fit-width", label: "tool.fit", icon: "move-horizontal", group: "view", surfaces: ["quick", "sheet"], priority: 38, scope: "view", command: "command.fit", readOnly: true, keywords: "zoom" },
	{ id: "next-page", label: "command.nextPage", icon: "chevron-down", group: "view", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "previous-page", label: "command.prevPage", icon: "chevron-up", group: "view", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	// 0.23 (#264): saved views: a named page region with a zoom, recalled in one step. Saving needs an editable notebook; going to one works on a read-only one too.
	{ id: "saved-view-save", label: "views.save.menu", icon: "frame", group: "view", surfaces: ["sheet", "notebook"], priority: 33, scope: "view", command: "command.savedViewSave", keywords: "saved views place zoom region name save viste salvate zona salva" },
	{ id: "saved-view-go", label: "views.go.menu", icon: "scan-eye", group: "view", surfaces: ["sheet", "notebook"], priority: 32, scope: "view", command: "command.savedViewGo", readOnly: true, keywords: "saved views go recall place zoom region viste salvate vai richiama zona" },

	// --- export and share.
	{ id: "share-copy-link", label: "share.copyLink", icon: "link", group: "share", surfaces: ["page"], priority: 40, scope: "view", readOnly: true },
	// 0.18 (#190): a QR code of the page that another device with the same vault scans to open it.
	{ id: "share-qr", label: "qr.title", icon: "qr-code", group: "share", surfaces: ["page"], priority: 34, scope: "view", readOnly: true, keywords: "qr code scan phone codice" },
	{ id: "share-insert-link", label: "share.insertLink", icon: "file-symlink", group: "share", surfaces: ["page"], priority: 35, scope: "view", readOnly: true },
	{ id: "share-insert-embed", label: "share.insertEmbed", icon: "picture-in-picture", group: "share", surfaces: ["page"], priority: 35, scope: "view", readOnly: true },
	// wave 0.9 (385): Obsidian's own Bookmarks pane (core plugin, feature-detected in integration/obsidian-bookmarks.ts).
	{ id: "obsidian-bookmark-page", label: "bookmarks.add", icon: "bookmark-check", group: "share", surfaces: ["page", "sheet", "palette"], priority: 33, scope: "view", command: true, readOnly: true, keywords: "bookmarks pane obsidian star favourite" },
	// 0.20 (#30): the page, the selection or some pages as PNG or PDF through the system share sheet (a saved copy where the device cannot share files).
	{ id: "share-page", label: "share.menu", icon: "share-2", group: "share", surfaces: ["page", "sheet", "palette"], priority: 36, scope: "view", command: true, readOnly: true, keywords: "share send png pdf image page whatsapp mail condividi invia immagine" },
	{ id: "share-selection", label: "share.selectionMenu", icon: "share-2", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 40.3, scope: "view", command: true, readOnly: true, when: hasSelection, keywords: "share send selection png image condividi invia selezione immagine" },
	{ id: "export-page-pdf", label: "export.pagePdf", icon: "file-output", group: "share", surfaces: ["page"], priority: 30, scope: "view", readOnly: true },
	{ id: "export-page-svg", label: "export.pageSvg", icon: "image", group: "share", surfaces: ["page"], priority: 20, scope: "view", readOnly: true },
	{ id: "export-pdf", label: "export.notebookPdf", icon: "file-down", group: "share", surfaces: ["sheet", "notebook"], priority: 30, scope: "view", command: "command.exportPdf", readOnly: true },
	// wave 0.9 (381, 382): the export dialog (PDF or SVG, page or notebook, ink and/or background) and the Markdown export.
	// From a page's sheet the dialog starts on that page; from the sheet, the notebook menu and the palette on the notebook.
	{ id: "export-dialog", label: "export.dialog.menu", icon: "share", group: "share", surfaces: ["page", "sheet", "notebook"], priority: 32, scope: "view", command: "command.exportDialog", readOnly: true, keywords: "pdf svg ink background layers page notebook esporta" },
	{ id: "export-markdown", label: "export.markdown.menu", icon: "files", group: "share", surfaces: ["sheet", "notebook"], priority: 28, scope: "view", command: "command.exportMarkdown", readOnly: true, keywords: "md png images without obsidian share esporta" },
	// 0.16 (#90): every highlighted region collected in a Markdown note next to the notebook.
	{ id: "highlights-digest", label: "digest.menu", icon: "highlighter", group: "share", surfaces: ["sheet", "notebook"], priority: 25, scope: "view", command: "command.highlightsDigest", readOnly: true, keywords: "highlights digest summary note evidenziazioni riepilogo raccolta colours" },
	// 0.22 (#101): what each ink colour means: the legend, a view filter that shows one meaning, and a note that collects the ink of each.
	{ id: "meaning-filter", label: "meaning.filter.menu", icon: "filter", group: "view", surfaces: ["sheet", "notebook"], priority: 34, scope: "view", command: "command.meaningFilter", readOnly: true, keywords: "colour color meaning legend filter definition example significato colori filtra legenda" },
	{ id: "meaning-legend", label: "meaning.menu", icon: "tags", group: "view", surfaces: ["sheet", "notebook"], priority: 33, scope: "view", command: "command.meaningLegend", readOnly: true, keywords: "colour color meaning legend definition example significato colori legenda" },
	{ id: "meaning-digest", label: "meaning.digest.menu", icon: "tags", group: "share", surfaces: ["sheet", "notebook"], priority: 24.5, scope: "view", command: "command.meaningDigest", readOnly: true, keywords: "colour color meaning digest collect note definition example raccolta colori significato" },
	// 0.18 mentions (O7): the notes that link to the page in view (and to the notebook as a whole).
	{ id: "mentions", label: "mentions.menu", icon: "links-coming-in", group: "share", surfaces: ["page", "sheet", "notebook"], priority: 24, scope: "view", command: "command.mentions", readOnly: true, keywords: "mentions backlinks linked notes links menzioni collegamenti note" },
	// 0.19 (#228): every picture and figure cut-out of the section, the notebook or some pages, in one grid.
	{ id: "figures", label: "figures.menu", icon: "images", group: "share", surfaces: ["sheet", "notebook"], priority: 23, scope: "view", command: "command.figures", readOnly: true, keywords: "figures photos pictures images crops gallery section immagini foto figure galleria ritagli" },
	// wave 0.10 (81): the same dialog started on PNG images (a vault folder, a scale, a page range) or on Print (desktop only).
	{ id: "export-png", label: "export.png.menu", icon: "images", group: "share", surfaces: ["sheet", "notebook"], priority: 27, scope: "view", command: "command.exportPng", readOnly: true, keywords: "png images pictures pages folder scale range esporta immagini" },
	// 0.23 (#280): the written area of the page, or the selection, as a transparent PNG or SVG
	{ id: "export-area", label: "exportArea.menu", icon: "crop", group: "share", surfaces: ["sheet", "notebook"], priority: 26.5, scope: "view", command: "command.exportArea", readOnly: true, keywords: "export written area crop transparent png svg esporta area scritta ritaglia trasparente" },
	// 0.24 handin (#334): hand in chosen pages as a PDF with a cover, after a pre-flight check.
	{ id: "hand-in", label: "handIn.menu", icon: "graduation-cap", group: "share", surfaces: ["sheet", "notebook"], priority: 26.2, scope: "view", command: "command.handIn", readOnly: true, keywords: "hand in assignment submit cover pdf homework consegna compito copertina" },
	{ id: "selection-export-area", label: "exportArea.selection", icon: "crop", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 40.3, scope: "view", command: true, readOnly: true, when: hasSelection, keywords: "export selection transparent png svg esporta selezione trasparente" },
	{ id: "print", label: "export.print.menu", icon: "printer", group: "share", surfaces: ["sheet", "notebook"], priority: 26, scope: "view", command: "command.print", readOnly: true, when: (c) => !!c.canPrint, keywords: "paper printer stampa carta" },

	// --- notebooks: the library, the ribbon and the palette.
	global("open-library", "command.library", "library", "app", ["notebook", "palette"], 30),
	// 0.12: the Notebook home (Home surface of the library view); the ribbon opens it.
	global("open-home", "home.command", "home", "app", ["notebook", "palette"], 30),
	global("create", "command.new", "file-plus-2", "app", ["library", "palette"]),
	// wave 0.12: the creation dialog on its Notebook or Folder tab (view/create-dialog.ts). "create" stays the command (hotkeys);
	// `new-notebook` is the same dialog for the library and home surfaces, `new-folder` is also a command.
	{ id: "new-notebook", label: "command.new", icon: "file-plus-2", group: "app", surfaces: ["library"], priority: 20, scope: "global", readOnly: true, keywords: "create notebook cover nuovo quaderno copertina" },
	{ id: "new-folder", label: "command.newFolder", icon: "folder-plus", group: "app", surfaces: ["library", "palette"], priority: 19, scope: "global", command: true, readOnly: true, keywords: "create folder subject colour icon nuova cartella materia colore icona" },
	global("open", "command.open", "folder-open", "app", ["library", "palette"]),
	global("continue-last", "command.continue", "history", "app", ["palette"]),
	global("import-pdf", "command.importPdf", "file-input", "app", ["library", "palette"]),
	global("lecture-from-slides", "command.lectureFromSlides", "presentation", "app", ["library", "palette"]),
	global("scan-new", "command.scanNew", "scan", "app", ["library", "palette"]),
	global("loose-sheet", "command.looseSheet", "sticky-note", "app", ["palette"]),
	// 0.15 (O12): a dated page in the daily notebook, optionally linked from the daily note.
	global("todays-page", "command.todaysPage", "calendar-plus", "app", ["library", "palette"]),
	global("timetable", "command.timetable", "calendar-clock", "app", ["library", "palette"]),
	global("open-class", "command.openClass", "calendar-check", "app", ["library", "palette"]),
	// wave 0.7: safety checks of the whole notebooks folder (also from the settings tab).
	global("sync-check", "command.syncCheck", "refresh-cw", "app", ["sheet", "notebook", "palette"], 15),
	global("check-integrity", "command.checkIntegrity", "shield-check", "app", ["sheet", "notebook", "palette"], 15),
	// wave 0.10 (27): unreadable notebooks and unused attachment files; the library sidebar has the same entry.
	global("library-check", "command.libraryCheck", "hard-drive", "app", ["sheet", "notebook", "library", "palette"], 15),
	// 0.15 storage (128): size of each notebook, unused / duplicate / heavy files, old backups.
	global("storage-manager", "command.storage", "database", "app", ["notebook", "library", "palette"], 15),
	// 0.21 backups (#127): a zip of every notebook, its assets and sidecars in the backup folder.
	global("backup-now", "command.backupNow", "archive", "app", ["palette"], 15),
	// 0.22 synccore (#126): the optional cloud sync, on demand.
	global("cloud-sync-now", "command.cloudSyncNow", "cloud", "app", ["palette"], 15),

	// --- diagnostics: settings tab and palette.
	global("pen-button-test", "command.penTest", "pen-tool", "dev", ["palette"], 5),
	global("benchmark", "command.benchmark", "gauge", "dev", ["palette"], 5),
	global("create-stress-test", "command.stress", "flask-conical", "dev", ["palette"], 5),

	// --- registered by other modules (listed so that every command has a documented place).
	external("insert-embed", "command.embedInsert", "picture-in-picture", "integration", "integration/index.ts"),
	external("restore-version", "command.restore", "history", "integration", "integration/index.ts"),
	// wave 0.8 (388): lists the old #pN links of the notes, then rewrites the ones the user accepts.
	external("update-page-links", "command.updateLinks", "link-2", "integration", "integration/index.ts", ["notebook", "palette"]),
	// 0.18 pdfannot (O10)
	external("annotate-current-pdf", "command.annotatePdf", "pen-line", "integration", "library/annotate-pdf.ts"),
	external("edit-tags", "command.editTags", "tags", "integration", "integration/tags.ts", ["notebook", "palette"]),
	external("companion-update-all", "command.companionUpdateAll", "refresh-cw", "integration", "integration/companion.ts"),
	external("companion-open", "command.companionOpen", "file-text", "integration", "integration/companion.ts"),
	external("repair-damaged", "command.repair", "wrench", "integration", "integration/reliability.ts"),
	external("merge-conflicted-copies", "command.mergeConflicts", "git-merge", "integration", "integration/reliability.ts"),
	external("restore-page", "command.restorePage", "history", "integration", "integration/reliability.ts"),
	external("zettel-card-from-selection", "zettel.command.fromSelection", "square-dashed", "zettel", "zettel/index.ts", ["notebook", "palette"]),
	external("zettel-card-from-page", "zettel.command.fromPage", "id-card", "zettel", "zettel/index.ts", ["notebook", "palette"]),
	external("zettel-card-title", "zettel.command.title", "heading", "zettel", "zettel/index.ts", ["notebook", "palette"]),
	external("zettel-link-arrows", "zettel.command.linkArrows", "arrow-right-left", "zettel", "zettel/index.ts"),
	external("zettel-show-cards", "zettel.command.showCards", "layout-list", "zettel", "zettel/index.ts", ["notebook", "palette"]),
	external("zettel-toggle-slip-box", "zettel.command.toggleSlipBox", "archive", "zettel", "zettel/index.ts", ["notebook", "palette"]),
	external("zettel-new-slip-box", "zettel.command.newSlipBox", "archive", "zettel", "zettel/index.ts"),
	external("zettel-orphans", "zettel.command.orphans", "unlink", "zettel", "zettel/index.ts"),
	external("zettel-toggle-regions", "zettel.command.toggleRegions", "scan", "zettel", "zettel/index.ts"),
	// wave 0.8: processing flow (Z4): the Inbox view; quick textbook reference (208)
	global("zettel-inbox", "inbox.command.open", "inbox", "zettel", ["sheet", "palette"], 30),
	global("zettel-inbox-process", "inbox.command.process", "list-checks", "zettel", ["sheet", "palette"], 30),
	{ id: "textbook-set", label: "textbook.command.set", icon: "book-open-check", group: "reading", surfaces: ["sheet", "palette"], priority: 25, scope: "view", command: true, readOnly: true, keywords: "textbook book pdf reference course libro" },
	{ id: "textbook-open", label: "textbook.command.open", icon: "book-open", group: "reading", surfaces: ["sheet", "palette"], priority: 35, scope: "view", command: true, readOnly: true, keywords: "textbook book pdf page libro" },
	{ id: "textbook-remove", label: "textbook.command.remove", icon: "book-x", group: "reading", surfaces: ["sheet", "palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "textbook-insert", label: "textbook.command.insert", icon: "book-marked", group: "insert", surfaces: ["sheet", "palette"], priority: 45, scope: "view", command: true, keywords: "textbook reference page libro" },

	// wave 0.10: clipboard and stamps (356 date and time stamp, 362 clipboard shared between devices)
	{ id: "insert-date-stamp", label: "datestamp.action", icon: "calendar-clock", group: "insert", surfaces: ["sheet"], priority: 48, scope: "view", command: "datestamp.command", keywords: "date time stamp timestamp clock now data ora" },
	// 0.21 (154): reusable signature and date
	{ id: "sign-and-date", label: "sign.action", icon: "signature", group: "insert", surfaces: ["sheet", "palette"], priority: 49, scope: "view", command: "sign.command", keywords: "signature sign date stamp firma firmare data pdf document" },
	{ id: "selection-copy-devices", label: "clipshare.copy", icon: "monitor-smartphone", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 48, scope: "view", command: true, when: hasSelection, keywords: "clipboard tablet phone sync share vault appunti" },
	// 0.16 (78): move the selection to another page (one undo step), or copy it there.
	{ id: "selection-move-page", label: "movePage.move", icon: "arrow-right-to-line", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 43, scope: "view", command: true, when: hasSelection, keywords: "move send page another sposta pagina selezione" },
	{ id: "selection-copy-page", label: "movePage.copy", icon: "copy", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 42, scope: "view", command: true, when: hasSelection, keywords: "copy duplicate page another copia pagina selezione" },
	// 0.17 (#57): the selection becomes a task in a note (the daily note, a tasks note or a chosen one), linked back to the page.
	{ id: "selection-make-task", label: "task.action", icon: "list-checks", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 41, scope: "view", command: true, when: hasSelection, keywords: "task todo checkbox daily note attivita compito" },
	// 0.19 (#213): the circled word goes to the "Look up later" list, with its picture; the sheet lists this notebook's entries.
	{ id: "selection-look-up", label: "lookup.action", icon: "book-search", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 39, scope: "view", command: true, when: hasSelection, keywords: "look up later word dictionary list circle cerca dopo parola elenco" },
	{ id: "look-up-list", label: "lookup.sheet.menu", icon: "book-search", group: "share", surfaces: ["page", "sheet", "notebook"], priority: 23, scope: "view", command: "command.lookUpList", readOnly: true, keywords: "look up later list words dictionary cerca dopo elenco parole" },
	// 0.21 (#187): back-of-book index.
	{ id: "selection-add-to-index", label: "bookindex.action", icon: "book-a", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 38, scope: "view", command: true, when: hasSelection, keywords: "index back of book term glossary indice analitico termine" },
	{ id: "book-index", label: "bookindex.menu", icon: "book-a", group: "share", surfaces: ["sheet", "notebook"], priority: 22, scope: "view", command: "command.bookIndex", readOnly: true, keywords: "index back of book terms pages glossary indice analitico termini pagine" },
	{ id: "formula-sheet", label: "formulasheet.menu", icon: "sigma", group: "share", surfaces: ["sheet", "notebook"], priority: 21, scope: "view", command: "command.formulaSheet", readOnly: true, keywords: "formula sheet equations latex maths collect formulario formule equazioni raccolta" },
	// 0.18 (#86): margin comments: a comment anchored to the selection's region, or to a rectangle drawn on the page; the side panel lists them.
	{ id: "comment-selection", label: "comments.action", icon: "message-square-plus", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 40, scope: "view", command: "comments.command.selection", when: hasSelection, enabled: pageOpen, keywords: "comment note margin review annotation commento nota margine revisione" },
	{ id: "comment-region", label: "comments.region", icon: "square-dashed", group: "insert", surfaces: ["sheet", "palette"], priority: 46, scope: "view", command: true, enabled: pageOpen, keywords: "comment region rectangle margin note review commento regione rettangolo margine" },
	{ id: "comments-panel", label: "comments.panel.toggle", icon: "messages-square", group: "side", surfaces: ["sheet", "palette"], priority: 33, scope: "view", command: true, readOnly: true, checked: (c) => !!c.comments?.panel, keywords: "comments panel list review resolve thread commenti pannello elenco" },
	{ id: "comment-next", label: "comments.next", icon: "message-square-more", group: "side", surfaces: ["palette"], priority: 20, scope: "view", command: true, readOnly: true, keywords: "comment next open review commento successivo aperto" },
	// 0.18 (#59): the selection as a picture (and a link back) at the cursor of the Markdown note, or in a chosen note.
	{ id: "selection-insert-note", label: "noteInsert.action", icon: "image-plus", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection"], priority: 40.5, scope: "view", command: true, when: hasSelection, keywords: "insert note markdown image png picture embed inserisci nota immagine" },
	{ id: "selection-insert-note-svg", label: "noteInsert.actionSvg", icon: "file-image", group: "selection", surfaces: ["sheet"], contexts: ["selection"], priority: 40.4, scope: "view", command: true, when: hasSelection, keywords: "insert note markdown svg vector embed inserisci nota vettoriale" },
	{ id: "selection-paste-device", label: "clipshare.paste", icon: "monitor-down", group: "selection", surfaces: ["context", "sheet"], contexts: ["selection", "lasso"], priority: 47, scope: "view", command: true, when: (c) => c.tool === "lasso" || hasSelection(c), keywords: "clipboard tablet phone sync share vault appunti" },

	// --- status banners (wave 0.7): their buttons, listed so that every visible control has a documented place.
	banner("safe-open-normally", "safe.banner.openNormally", "shield-off", "notebook", "view/resilience.ts"),
	banner("safe-repair", "safe.banner.repair", "wrench", "notebook", "view/resilience.ts"),
	banner("safe-show-media", "safe.banner.showMedia", "image", "notebook", "view/resilience.ts"),
	banner("storage-retry", "storage.banner.retryNow", "refresh-cw", "notebook", "view/resilience.ts"),
	banner("integrity-restore-newer", "integrity.banner.restoreNewer", "history", "notebook", "view/resilience.ts"),
	banner("integrity-restore", "integrity.restore", "history", "notebook", "view/resilience.ts"),
	banner("integrity-keep", "integrity.keep", "check", "notebook", "view/resilience.ts"),
	banner("sync-open-read-only", "sync.other.readOnly", "lock", "notebook", "view/sync-safety.ts"),
	banner("sync-open-anyway", "sync.other.anyway", "lock-open", "notebook", "view/sync-safety.ts"),
	banner("sync-edit-anyway", "sync.other.edit", "pencil", "notebook", "view/sync-safety.ts"),
	banner("heavy-dismiss", "heavy.dismiss", "x", "page", "view/heavy-page-banner.ts"),
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function actionById(id: string): ActionDef | undefined {
	return BY_ID.get(id);
}

/** The action is meaningful in this context (otherwise it is not shown at all). */
export function isRelevant(a: ActionDef, c: UiContext): boolean {
	return a.when ? a.when(c) : true;
}

/** The action can be used now (shown disabled otherwise). */
export function isEnabled(a: ActionDef, c: UiContext): boolean {
	if (a.enabled) return a.enabled(c);
	if (a.scope !== "view") return true;
	return a.readOnly ? c.open : c.editable;
}

export function isChecked(a: ActionDef, c: UiContext): boolean {
	return a.checked ? a.checked(c) : false;
}

/** The contexts that apply, most specific first. */
export function activeContexts(c: UiContext): ContextKind[] {
	if (!c.open) return [];
	const on: Record<ContextKind, boolean> = {
		selection: !!c.selection && c.selection.strokes + c.selection.elements > 0,
		lasso: c.tool === "lasso",
		"side-pane": c.sidePane.available && c.sidePane.open,
		lecture: c.lecture,
		pdf: c.page?.background === "pdf",
		image: c.page?.background === "image",
	};
	return CONTEXT_ORDER.filter((k) => on[k]);
}

/** A context for tests and docs: an open, editable plain page with the pen. */
export function baseContext(patch: Partial<UiContext> = {}): UiContext {
	return {
		editable: true, open: true, tool: "pen", selection: null,
		page: { index: 0, count: 3, background: "none", infinite: false, bookmarked: false },
		notebook: { pdfPages: false, backgrounds: false }, lecture: false,
		sidePane: { available: true, open: false }, reading: { annotationsHidden: false, dim: false },
		toggles: { ruler: false, penOnly: false, navigator: false, pageMode: false }, narrow: false, canPrint: true,
		...patch,
	};
}
