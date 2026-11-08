// 0.24 iconhelp (#429): which one-line explanation belongs to which control. The name always comes from the action registry
// label (src/ui/actions.ts) or the control's own label; only the description lives here. Pure data: no 'obsidian' import.
import type { MessageKey } from "../i18n/en";

/** Explanation of a registry action, by action id. An action missing here still gets its bubble, with the name alone. */
export const ACTION_HELP: Readonly<Record<string, MessageKey>> = {
	undo: "help.undo",
	redo: "help.redo",
	"nav-back": "help.navBack",
	"nav-forward": "help.navForward",
	"toggle-page-mode": "help.pageMode",
	"insert-image": "help.insertImage",
	stamps: "help.stamps",
	"board-shot": "help.boardShot",
	"insert-sticky": "help.insertSticky",
	"add-page-suggest": "help.addPage",
	"toggle-ruler": "help.ruler",
	"pen-only": "help.penOnly",
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
	"selection-look-up": "help.lookUp",
	"selection-make-task": "help.makeTask",
	"comment-selection": "help.comment",
	"math-edit": "help.mathEdit",
	"pdf-search": "help.pdfSearch",
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
