import type { Plugin } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { FAVOURITE_SLOTS } from "./favourites";
import type { NotebookView } from "./notebook-view";
import type { ToolName } from "./toolbar";
import type { ShapeKind } from "./view-helpers";

/** Runs `run` on the active notebook view; with `checking` only says whether one is active. */
export type WithView = (checking: boolean, run: (view: NotebookView) => void) => boolean;

export interface ToolCommand {
	id: string;
	name: MessageKey;
	run: (view: NotebookView) => void;
}

const TOOLS: Array<[ToolName, MessageKey]> = [
	["pen", "command.tool.pen"],
	["highlighter", "command.tool.highlighter"],
	["eraser", "command.tool.eraser"],
	["lasso", "command.tool.lasso"],
	["shape", "command.tool.shape"],
	["text", "command.tool.text"],
];

const SHAPES: Array<[ShapeKind, MessageKey]> = [
	["line", "command.tool.line"],
	["arrow", "command.tool.arrow"],
	["rectangle", "command.tool.rectangle"],
	["ellipse", "command.tool.ellipse"],
];

/**
 * Every tool and action that has a toolbar button, as a command (assign hotkeys in Settings > Hotkeys). Undo, redo, fit
 * and add page are registered in main.ts. No default hotkeys: they would clash with the user's own.
 */
export function toolCommands(): ToolCommand[] {
	const list: ToolCommand[] = [];
	for (const [tool, name] of TOOLS) list.push({ id: `tool-${tool}`, name, run: (v) => v.selectTool(tool) });
	for (const [kind, name] of SHAPES) list.push({ id: `shape-${kind}`, name, run: (v) => v.selectShape(kind) });
	list.push({ id: "eraser-stroke", name: "command.tool.eraserStroke", run: (v) => v.selectEraserMode("stroke") });
	list.push({ id: "eraser-segment", name: "command.tool.eraserSegment", run: (v) => v.selectEraserMode("segment") });
	list.push({ id: "eraser-larger", name: "command.eraserLarger", run: (v) => v.stepEraserSize(1) });
	list.push({ id: "eraser-smaller", name: "command.eraserSmaller", run: (v) => v.stepEraserSize(-1) });
	for (let i = 0; i < FAVOURITE_SLOTS; i++) {
		list.push({ id: `favourite-${i + 1}`, name: "command.favourite", run: (v) => v.selectFavourite(i) });
	}
	list.push({ id: "pen-only", name: "command.penOnly", run: (v) => v.togglePenOnly() });
	list.push({ id: "next-page", name: "command.nextPage", run: (v) => v.goToRelativePage(1) });
	list.push({ id: "previous-page", name: "command.prevPage", run: (v) => v.goToRelativePage(-1) });
	list.push({ id: "delete-selection", name: "command.deleteSelection", run: (v) => v.removeSelection() });
	list.push({ id: "link-selection", name: "command.linkSelection", run: (v) => v.linkSelection() });
	list.push({ id: "toggle-pages-panel", name: "command.toggleNavigator", run: (v) => v.toggleNavigator() });
	list.push({ id: "toggle-ruler", name: "command.toggleRuler", run: (v) => v.toggleRuler() });
	list.push({ id: "toggle-page-mode", name: "command.pageMode", run: (v) => v.togglePageMode() });
	return list;
}

/** Display name of a command; the favourite commands carry their slot number. */
export function commandName(cmd: ToolCommand): string {
	const m = /^favourite-(\d+)$/.exec(cmd.id);
	return m ? t(cmd.name, { n: m[1]! }) : t(cmd.name);
}

export function registerToolCommands(plugin: Plugin, withView: WithView): void {
	for (const cmd of toolCommands()) {
		plugin.addCommand({
			id: cmd.id,
			name: commandName(cmd),
			checkCallback: (checking) => withView(checking, cmd.run),
		});
	}
}
