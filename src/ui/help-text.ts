// 0.24 iconhelp (#429): which one-line explanation belongs to which control. The name always comes from the action registry
// label (src/ui/actions.ts) or the control's own label; only the description lives here. Pure data: no 'obsidian' import.
import type { MessageKey } from "../i18n/en";

/** Explanation of a registry action, by action id. An action missing here still gets its bubble, with the name alone. */
export const ACTION_HELP: Readonly<Record<string, MessageKey>> = {
	undo: "help.undo",
	redo: "help.redo",
	"paint-bucket": "help.paintBucket",
	"nav-back": "help.navBack",
	"nav-forward": "help.navForward",
	"box-index": "help.boxIndex",
	"figure-caption": "help.figureCaption",
	"figure-ref": "help.figureRef",
	"toggle-page-mode": "help.pageMode",
	"toggle-spread": "help.spread",
	"insert-image": "help.insertImage",
	stamps: "help.stamps",
	"board-shot": "help.boardShot",
	"insert-sticky": "help.insertSticky",
	"add-page-suggest": "help.addPage",
	"toggle-ruler": "help.ruler",
	"pen-only": "help.penOnly",
	"workspace-presets": "help.workspacePresets",
	"workspace-lecture": "help.workspaceLecture",
	"profile-lecture": "help.profileLecture",
	"profile-study": "help.profileStudy",
	"profile-next": "help.profileNext",
	"pen-gesture-mode": "help.penGestures",
	"fit-width": "help.fitWidth",
	"toggle-pages-panel": "help.pagesPanel",
	"selection-copy": "help.copy",
	"selection-cut": "help.cut",
	"selection-duplicate": "help.duplicate",
	"selection-paste": "help.paste",
	"layer-front": "help.layerFront",
	"layer-back": "help.layerBack",
	"layer-forward": "help.layerForward",
	"layer-backward": "help.layerBackward",
	"select-rectangle": "help.selectRectangle",
	"select-by-style": "help.selectByStyle",
	"selection-similar": "help.selectSimilar",
	"selection-align-menu": "help.align",
	"selection-transform-menu": "help.transform",
	"selection-group": "help.group",
	"selection-ungroup": "help.ungroup",
	"selection-lock": "help.lock",
	"delete-selection": "help.deleteSelection",
	"snap-toggle": "help.snap",
	"share-selection": "help.shareSelection",
	"selection-export-area": "help.exportSelection",
	"selection-copy-image": "help.clipImageSelection",
	"page-copy-image": "help.clipImagePage",
	"selection-look-up": "help.lookUp",
	"selection-make-task": "help.makeTask",
	"comment-selection": "help.comment",
	"math-edit": "help.mathEdit",
	"pdf-search": "help.pdfSearch",
	// 0.28 (#76): turn and crop the PDF page
	"pdf-rotate-right": "help.pdfRotateRight",
	"pdf-rotate-left": "help.pdfRotateLeft",
	"pdf-crop": "help.pdfCrop",
	// 0.24 review: the actions added later in the wave
	"page-global-bookmark": "help.globalBookmark",
	"bookmarks-open": "help.openBookmarks",
	"hand-in": "help.handIn",
	"selection-join": "help.joinStrokes",
	// 0.27 macros (#170): the manager; a macro's own button says "help.macro" (long-press-help.ts)
	"macros-open": "help.macros",
	// 0.25 areahl
	"highlighter-area": "help.highlighterArea",
	// 0.25 histpanel (#84)
	"history-panel": "help.historyPanel",
	// 0.25
	"selection-baseline": "help.alignBaseline",
	// 0.26 opacity (#358)
	"opacity": "help.opacity",
	// 0.26 tidy
	"selection-tidy": "help.tidy",
	"page-tidy": "help.tidy",
	// 0.28 linehandle (#256)
	"page-reorder-lines": "help.reorderLines",
	// 0.29 strikedelete (#96)
	"toggle-hide-struck": "help.hideStruck",
	// 0.26 smooth (#66)
	"selection-smooth": "help.smooth",
	"selection-straighten": "help.straighten",
	// 0.28 geosuggest (#403)
	"selection-highlight": "help.geoHighlight",
	"selection-insert-note": "help.geoNote",
	"link-selection": "help.geoLink",
	// 0.26 related (#422)
	"related-pages": "help.relatedPanel",
	// 0.28 tables (#41)
	"insert-table": "help.table.insert",
	"table-add-row": "help.table.addRow",
	"table-add-col": "help.table.addCol",
	"table-remove-row": "help.table.removeRow",
	"table-remove-col": "help.table.removeCol",
	"table-even": "help.table.even",
	// 0.29 studytape (#10)
	"study-tape": "tape.help.draw",
	"tapes-reveal-all": "tape.help.revealAll",
	"tapes-hide-all": "tape.help.hideAll",
	// 0.29 charts (#244)
	"chart-from-table": "help.chart.fromTable",
	"chart-update": "help.chart.update",
	// 0.29 stats (#295)
	"table-stats": "help.table.stats",
};

/** The id of the tool-button explanation (set as `data-help` on the toolbar's tool buttons). */
export const TOOL_HELP: Readonly<Record<string, MessageKey>> = {
	pen: "help.tool.pen",
	highlighter: "help.tool.highlighter",
	eraser: "help.tool.eraser",
	lasso: "help.tool.lasso",
	shape: "help.tool.shape",
	text: "help.tool.text",
	space: "help.tool.space",
};

/** The explanation of each segment of the shape style row (fill and line style), shown in the toolbar options and in the selection bar. */
export const FILL_HELP: Readonly<Record<"none" | "solid" | "tint", MessageKey>> = { none: "help.shape.fillNone", solid: "help.shape.fillSolid", tint: "help.shape.fillTint" };
export const LINE_HELP: Readonly<Record<"solid" | "dashed" | "dotted", MessageKey>> = { solid: "help.shape.lineSolid", dashed: "help.shape.lineDashed", dotted: "help.shape.lineDotted" };
