// ui redesign: the action registry. One entry per user-facing action of the plugin: where it may appear, when it is
// relevant, how important it is and which command (hotkey) it is. Pure data and predicates: no 'obsidian' import, so the
// layout engine and the coverage tests run in Node. The behaviour lives elsewhere: view actions in view/view-actions.ts,
// global ones in main.ts, external ones in the module named by `owner`.
import type { MessageKey } from "../i18n";

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
	selection: { strokes: number; elements: number; images: number } | null;
	/** The page in view (index of the page sheet when it was opened from a thumbnail). */
	page: {
		index: number; count: number; background: "none" | "pdf" | "image"; infinite: boolean; bookmarked: boolean;
		/** wave 0.7: the page is flagged as heavy and can be split. Optional (false when absent). */
		splittable?: boolean;
	} | null;
	notebook: { pdfPages: boolean; backgrounds: boolean };
	/** A class of the timetable is on now. */
	lecture: boolean;
	sidePane: { available: boolean; open: boolean };
	reading: { annotationsHidden: boolean; dim: boolean };
	toggles: { ruler: boolean; penOnly: boolean; navigator: boolean; /** One page at a time (wave 0.7). */ pageMode?: boolean };
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
	/** An inline row of choices in the sheets instead of a single row. */
	readonly choices?: "paper" | "size";
	/** Extra search words (any language). */
	readonly keywords?: string;
}

const pdfPage = (c: UiContext) => c.page?.background === "pdf";
const backgroundPage = (c: UiContext) => !!c.page && c.page.background !== "none";
const hasSelection = (c: UiContext) => !!c.selection && c.selection.strokes + c.selection.elements > 0;
const sideOpen = (c: UiContext) => c.sidePane.available && c.sidePane.open;

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
	...[1, 2, 3, 4, 5, 6].map(favourite),

	// --- history: fixed in the toolbar, also in the radial menu and as gestures.
	{ id: "undo", label: "tool.undo", icon: "undo", group: "history", surfaces: ["toolbar", "radial"], priority: 100, scope: "view", command: "command.undo" },
	{ id: "redo", label: "tool.redo", icon: "redo", group: "history", surfaces: ["toolbar", "radial"], priority: 99, scope: "view", command: "command.redo" },

	// --- selection: the contextual bar of the lasso.
	{ id: "selection-copy", label: "selection.copy", icon: "copy", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 90, scope: "view", when: hasSelection },
	{ id: "selection-cut", label: "selection.cut", icon: "scissors", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 85, scope: "view", when: hasSelection },
	{ id: "selection-duplicate", label: "selection.duplicate", icon: "copy-plus", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 80, scope: "view", when: hasSelection },
	{ id: "selection-paste", label: "selection.paste", icon: "clipboard-paste", group: "selection", surfaces: ["context"], contexts: ["selection", "lasso"], priority: 75, scope: "view", when: (c) => c.tool === "lasso" || hasSelection(c) },
	{ id: "selection-white-transparent", label: "selection.whiteTransparent", icon: "eraser", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 60, scope: "view", when: (c) => (c.selection?.images ?? 0) > 0 },
	{ id: "stamps-save-selection", label: "stamps.save", icon: "stamp", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 50, scope: "view", when: hasSelection },
	{ id: "delete-selection", label: "tool.deleteSelection", icon: "trash-2", group: "selection", surfaces: ["context"], contexts: ["selection"], priority: 70, scope: "view", command: "command.deleteSelection", when: hasSelection, danger: true },

	// --- navigation (wave 0.7): the first section of the page sheet (the page indicator opens it) and of the sheet.
	{ id: "goto-page-number", label: "command.gotoPageNumber", icon: "hash", group: "navigate", surfaces: ["page", "sheet"], priority: 85, scope: "view", command: true, readOnly: true, keywords: "jump number bookmark" },
	{ id: "recent-pages", label: "command.recentPages", icon: "history", group: "navigate", surfaces: ["page", "sheet", "library"], priority: 60, scope: "global", command: true, readOnly: true, keywords: "edited last" },
	{ id: "go-to-page", label: "command.goToPage", icon: "file-search", group: "navigate", surfaces: ["sheet", "library"], priority: 55, scope: "global", command: true, readOnly: true, keywords: "switcher find notebook" },
	{ id: "toggle-page-mode", label: "toolbar.pageMode", icon: "book-open", group: "navigate", surfaces: ["quick", "page", "sheet"], priority: 46, scope: "view", command: "command.pageMode", readOnly: true, checked: (c) => !!c.toggles.pageMode, keywords: "swipe paged continuous scroll" },

	// --- insert: quick slots (ranked) and the sheet.
	{ id: "insert-image", label: "tool.image", icon: "image-plus", group: "insert", surfaces: ["quick", "sheet"], priority: 70, scope: "view", keywords: "picture photo" },
	{ id: "stamps", label: "stamps.menu", icon: "stamp", group: "insert", surfaces: ["quick", "sheet"], priority: 62, scope: "view", keywords: "sticker" },
	{ id: "board-shot", label: "tool.boardShot", icon: "camera", group: "insert", surfaces: ["quick", "context", "sheet"], contexts: ["lecture"], priority: 55, scope: "view", command: "command.boardShot", keywords: "photo camera blackboard" },
	{ id: "add-page", label: "tool.addPage", icon: "file-plus", group: "insert", surfaces: ["quick", "sheet"], priority: 66, scope: "view", command: "command.addPage" },
	{ id: "insert-blank-page", label: "page.insertBlank", icon: "file-plus", group: "insert", surfaces: ["page"], priority: 60, scope: "view" },
	{ id: "exercise-page", label: "page.exercise", icon: "pencil-ruler", group: "insert", surfaces: ["context", "sheet", "page"], contexts: ["lecture"], priority: 45, scope: "view", command: "command.exercisePage" },
	{ id: "page-from-template", label: "page.newFromTemplate", icon: "file-plus-2", group: "insert", surfaces: ["sheet", "page"], priority: 40, scope: "view", keywords: "template" },
	{ id: "insert-pdf-pages", label: "page.insertPdf", icon: "file-input", group: "insert", surfaces: ["sheet", "page"], priority: 40, scope: "view" },
	{ id: "insert-image-page", label: "page.insertImage", icon: "image", group: "insert", surfaces: ["sheet", "page"], priority: 35, scope: "view" },
	{ id: "scan-into", label: "page.scanAfter", icon: "scan", group: "insert", surfaces: ["sheet", "page"], priority: 35, scope: "view", command: "command.scanInto", keywords: "camera document" },
	{ id: "scan-element", label: "page.scanInsert", icon: "scan-line", group: "insert", surfaces: ["sheet", "page"], priority: 30, scope: "view", keywords: "camera" },

	// --- page: the page sheet (and its section in the "All actions" sheet).
	{ id: "page-duplicate", label: "page.duplicate", icon: "copy", group: "page", surfaces: ["page"], priority: 50, scope: "view" },
	{ id: "page-move-up", label: "page.moveUp", icon: "arrow-up", group: "page", surfaces: ["page"], priority: 40, scope: "view", enabled: (c) => c.editable && (c.page?.index ?? 0) > 0 },
	{ id: "page-move-down", label: "page.moveDown", icon: "arrow-down", group: "page", surfaces: ["page"], priority: 40, scope: "view", enabled: (c) => c.editable && !!c.page && c.page.index < c.page.count - 1 },
	{ id: "page-bookmark", label: "page.bookmark", icon: "bookmark", group: "page", surfaces: ["page"], priority: 55, scope: "view", checked: (c) => !!c.page?.bookmarked },
	{ id: "page-edit-bookmark", label: "page.editBookmark", icon: "bookmark-plus", group: "page", surfaces: ["page"], priority: 40, scope: "view", when: (c) => !!c.page?.bookmarked },
	{ id: "page-tags", label: "page.tags", icon: "tag", group: "page", surfaces: ["page"], priority: 40, scope: "view" },
	{ id: "page-paper", label: "ui.paper", icon: "grid-3x3", group: "page", surfaces: ["page"], priority: 45, scope: "view", choices: "paper", keywords: "ruled grid dotted lined" },
	{ id: "page-size", label: "ui.size", icon: "ratio", group: "page", surfaces: ["page"], priority: 40, scope: "view", choices: "size", keywords: "a4 a5 letter" },
	{ id: "page-orientation", label: "ui.orientation", icon: "rotate-cw", group: "page", surfaces: ["page"], priority: 35, scope: "view", keywords: "landscape portrait" },
	{ id: "page-infinite", label: "page.infinite", icon: "infinity", group: "page", surfaces: ["page"], priority: 35, scope: "view", checked: (c) => !!c.page?.infinite },
	{ id: "move-pages", label: "page.moveToNotebook", icon: "folder-input", group: "page", surfaces: ["page"], priority: 30, scope: "view", command: "command.movePages" },
	{ id: "page-save-template", label: "page.saveTemplate", icon: "layout-template", group: "page", surfaces: ["page"], priority: 25, scope: "view" },
	{ id: "page-restore-version", label: "page.restoreVersion", icon: "history", group: "page", surfaces: ["page"], priority: 20, scope: "view" },
	{ id: "page-deleted-pages", label: "page.deletedPages", icon: "archive-restore", group: "page", surfaces: ["page"], priority: 20, scope: "view", keywords: "trash restore" },
	{ id: "page-split", label: "heavy.split", icon: "split", group: "page", surfaces: ["page", "banner"], priority: 45, scope: "view", when: (c) => !!c.page?.splittable, keywords: "heavy large slow" },
	{ id: "page-delete", label: "page.delete", icon: "trash-2", group: "page", surfaces: ["page"], priority: 10, scope: "view", danger: true, enabled: (c) => c.editable && (c.page?.count ?? 0) > 1 },

	// --- PDF and reading: the contextual bar of a PDF page, and the sheet.
	{ id: "pdf-search", label: "reading.search", icon: "search", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 80, scope: "view", command: "command.pdfSearch", readOnly: true, when: (c) => c.notebook.pdfPages },
	{ id: "pdf-search-next", label: "command.pdfSearchNext", icon: "chevron-down", group: "reading", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "pdf-search-previous", label: "command.pdfSearchPrev", icon: "chevron-up", group: "reading", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "toggle-annotations", label: "reading.annotations.hide", icon: "eye-off", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 60, scope: "view", command: "command.annotationsToggle", readOnly: true, when: (c) => c.notebook.pdfPages, checked: (c) => c.reading.annotationsHidden },
	{ id: "toggle-dim-background", label: "reading.dim", icon: "sun-dim", group: "reading", surfaces: ["context", "sheet"], contexts: ["pdf", "image"], priority: 50, scope: "view", command: "command.dimToggle", readOnly: true, when: (c) => c.notebook.backgrounds, checked: (c) => c.reading.dim },
	{ id: "pdf-margins", label: "pdf.margins.menu", icon: "move-horizontal", group: "reading", surfaces: ["context", "page"], contexts: ["pdf", "image"], priority: 40, scope: "view", command: "command.pdfMargins", when: backgroundPage },
	{ id: "pdf-update", label: "pdf.update.menu", icon: "refresh-cw", group: "reading", surfaces: ["page", "sheet"], priority: 20, scope: "view", command: "command.pdfUpdate", when: pdfPage },
	{ id: "pdf-annotations", label: "pdf.annotations.menu", icon: "file-text", group: "reading", surfaces: ["sheet", "page"], priority: 20, scope: "view", command: "command.pdfAnnotations", readOnly: true, when: (c) => c.notebook.pdfPages },

	// --- PDF side by side: the contextual bar while the pane is open.
	{ id: "pdf-side-open", label: "command.pdfSideOpen", icon: "columns-2", group: "side", surfaces: ["context", "sheet"], contexts: ["pdf"], priority: 45, scope: "view", command: true, readOnly: true, when: (c) => c.sidePane.available && !c.sidePane.open },
	{ id: "pdf-side-link", label: "command.pdfSideLink", icon: "link", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 80, scope: "view", command: true, when: sideOpen },
	{ id: "pdf-side-show-slide", label: "pdfSide.menu.showSlide", icon: "file-search", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 70, scope: "view", readOnly: true, when: sideOpen },
	{ id: "pdf-side-add-page", label: "command.pdfSideAdd", icon: "file-plus", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 75, scope: "view", command: true, when: sideOpen },
	{ id: "pdf-side-close", label: "command.pdfSideClose", icon: "panel-right-close", group: "side", surfaces: ["context", "sheet"], contexts: ["side-pane"], priority: 30, scope: "view", command: true, readOnly: true, when: sideOpen },

	// --- lecture: the contextual bar while a class of the timetable is on.
	{ id: "new-lecture", label: "page.newLecture", icon: "graduation-cap", group: "lecture", surfaces: ["context", "sheet"], contexts: ["lecture"], priority: 70, scope: "view", command: "command.newLecture" },
	{ id: "exercise-paper", label: "page.exercisePaper", icon: "palette", group: "lecture", surfaces: ["sheet"], priority: 20, scope: "view", command: "command.exercisePaper", readOnly: true },

	// --- view and input.
	{ id: "toggle-pages-panel", label: "tool.pages", icon: "panel-left", group: "view", surfaces: ["toolbar"], priority: 100, scope: "view", command: "command.toggleNavigator", readOnly: true, checked: (c) => c.toggles.navigator },
	{ id: "toggle-ruler", label: "tool.ruler", icon: "ruler", group: "view", surfaces: ["quick", "radial", "sheet"], priority: 50, scope: "view", command: "command.toggleRuler", checked: (c) => c.toggles.ruler },
	{ id: "pen-only", label: "pens.penOnly", icon: "pen-tool", group: "view", surfaces: ["quick", "sheet"], priority: 42, scope: "view", command: "command.penOnly", readOnly: true, checked: (c) => c.toggles.penOnly, keywords: "finger touch palm" },
	{ id: "fit-width", label: "tool.fit", icon: "move-horizontal", group: "view", surfaces: ["quick", "sheet"], priority: 38, scope: "view", command: "command.fit", readOnly: true, keywords: "zoom" },
	{ id: "next-page", label: "command.nextPage", icon: "chevron-down", group: "view", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },
	{ id: "previous-page", label: "command.prevPage", icon: "chevron-up", group: "view", surfaces: ["palette"], priority: 10, scope: "view", command: true, readOnly: true },

	// --- export and share.
	{ id: "share-copy-link", label: "share.copyLink", icon: "link", group: "share", surfaces: ["page"], priority: 40, scope: "view", readOnly: true },
	{ id: "share-insert-link", label: "share.insertLink", icon: "file-symlink", group: "share", surfaces: ["page"], priority: 35, scope: "view", readOnly: true },
	{ id: "share-insert-embed", label: "share.insertEmbed", icon: "picture-in-picture", group: "share", surfaces: ["page"], priority: 35, scope: "view", readOnly: true },
	{ id: "export-page-pdf", label: "export.pagePdf", icon: "file-output", group: "share", surfaces: ["page"], priority: 30, scope: "view", readOnly: true },
	{ id: "export-page-svg", label: "export.pageSvg", icon: "image", group: "share", surfaces: ["page"], priority: 20, scope: "view", readOnly: true },
	{ id: "export-pdf", label: "export.notebookPdf", icon: "file-down", group: "share", surfaces: ["sheet", "notebook"], priority: 30, scope: "view", command: "command.exportPdf", readOnly: true },

	// --- notebooks: the library, the ribbon and the palette.
	global("open-library", "command.library", "library", "app", ["notebook", "palette"], 30),
	global("create", "command.new", "file-plus-2", "app", ["library", "palette"]),
	global("open", "command.open", "folder-open", "app", ["library", "palette"]),
	global("continue-last", "command.continue", "history", "app", ["palette"]),
	global("import-pdf", "command.importPdf", "file-input", "app", ["library", "palette"]),
	global("lecture-from-slides", "command.lectureFromSlides", "presentation", "app", ["library", "palette"]),
	global("scan-new", "command.scanNew", "scan", "app", ["library", "palette"]),
	global("loose-sheet", "command.looseSheet", "sticky-note", "app", ["palette"]),
	global("timetable", "command.timetable", "calendar-clock", "app", ["library", "palette"]),
	global("open-class", "command.openClass", "calendar-check", "app", ["library", "palette"]),
	// wave 0.7: safety checks of the whole notebooks folder (also from the settings tab).
	global("sync-check", "command.syncCheck", "refresh-cw", "app", ["sheet", "notebook", "palette"], 15),
	global("check-integrity", "command.checkIntegrity", "shield-check", "app", ["sheet", "notebook", "palette"], 15),

	// --- diagnostics: settings tab and palette.
	global("pen-button-test", "command.penTest", "pen-tool", "dev", ["palette"], 5),
	global("benchmark", "command.benchmark", "gauge", "dev", ["palette"], 5),
	global("create-stress-test", "command.stress", "flask-conical", "dev", ["palette"], 5),

	// --- registered by other modules (listed so that every command has a documented place).
	external("insert-embed", "command.embedInsert", "picture-in-picture", "integration", "integration/index.ts"),
	external("restore-version", "command.restore", "history", "integration", "integration/index.ts"),
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
		toggles: { ruler: false, penOnly: false, navigator: false, pageMode: false }, narrow: false,
		...patch,
	};
}
