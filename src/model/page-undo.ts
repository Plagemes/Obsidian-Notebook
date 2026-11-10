/**
 * 0.28 (#98): per-page undo. Pure, no Obsidian. The global `History` stays the single source of truth: this file only says, for every
 * recorded step, which pages it touched and whether it can be undone on its own page. `History.undoOnPage` / `redoOnPage` then take the
 * newest step of one page out of the middle of the stack and run the command's own `revert` / `apply` (never a snapshot).
 *
 * The rule that makes that safe: the step picked is the newest one that touches the page at all, so no later step touches the same page
 * (the same strokes, elements, paper or layer order). Steps on other pages cannot depend on it, and it cannot depend on them. A step that
 * touches several pages, adds / deletes / moves / reorders pages, or changes the whole notebook (properties, saved views, files) is
 * "global": per-page undo never undoes it out of order. When the newest step of a page is global, nothing is undone and the person is told.
 *
 * The shared tables (files, slide entries, the cover) are not covered by that rule, because every page's content points into them: a step that
 * ADDED an entry is never undone out of order, a step is never redone past an undone step that registers one or is global, and `RemoveAsset`
 * (the storage manager's repoint) blocks every page. `checkContent` also checks those references without its cache, as a backstop.
 *
 * A command class this file does not know is global and blocks every page (fail closed); tests/page-undo.test.ts scans the source for `implements Command`
 * classes and fails on one that is not classified, so a new command is decided on purpose.
 */
import { RemoveAsset } from "./asset-ops";
import { UpdateCheckbox } from "./checklist-commands";
import { SetPageComments } from "./comments";
import { UpdateItems } from "./groups";
import {
	AddAsset, AddElement, AddPage, AddStroke, Batch, DeletePage, EraseStrokes, InsertPages, MovePage, RemoveElement, ReorderLayer, ReplaceElement, ReplaceStroke,
	SetMeta, SetPageBackground, SetPageInfinite, SetPageMargins, SetPaper, SetPageSize,
	type Command,
} from "./history";
import { SetMarkerDone } from "./marker-commands";
import { SetPageContent } from "./page-content";
import { SetPageLocked } from "./page-lock";
import { ReorderPages } from "./page-ops";
import { SetPdfView } from "./pdf-view-command";
import { ReplacePage } from "./page-restore";
import { SetPageTags } from "./page-tags";
import { SetPageTimes } from "./page-times";
import { AddSlideRef } from "./slide-links";
import { SetPageStates } from "./states";
import { SetViews } from "./views";
import type { PageRules, Registered, ScopeFn, StepScope } from "./page-scope";

export { redoSurvives, touchesPage, type PageRules, type PageStepResult, type ScopeFn, type StepScope } from "./page-scope";

/** Commands that only change the content or the settings of ONE page, found by its id. */
type PageLeaf =
	| AddStroke | EraseStrokes | ReplaceStroke | AddElement | RemoveElement | ReplaceElement | ReorderLayer | SetPaper | SetPageSize | SetPageMargins
	| SetPageBackground | SetPageInfinite | SetPageLocked | SetPageTags | SetPageTimes | SetPageComments | SetPageStates | UpdateCheckbox | SetMarkerDone | UpdateItems;

function isPageLeaf(cmd: Command): cmd is PageLeaf {
	return cmd instanceof AddStroke || cmd instanceof EraseStrokes || cmd instanceof ReplaceStroke || cmd instanceof AddElement || cmd instanceof RemoveElement
		|| cmd instanceof ReplaceElement || cmd instanceof ReorderLayer || cmd instanceof SetPaper || cmd instanceof SetPageSize || cmd instanceof SetPageMargins
		|| cmd instanceof SetPageBackground || cmd instanceof SetPageInfinite || cmd instanceof SetPageLocked || cmd instanceof SetPageTags || cmd instanceof SetPageTimes
		|| cmd instanceof SetPageComments || cmd instanceof SetPageStates || cmd instanceof UpdateCheckbox || cmd instanceof SetMarkerDone || cmd instanceof UpdateItems;
}

/** The commands a step is made of: batches and the lock-exempt wrapper opened up. */
function leaves(cmd: Command): Command[] {
	if (cmd instanceof Batch) return cmd.commands.flatMap(leaves);
	const inner = (cmd as { inner?: unknown }).inner;
	if (typeof inner === "object" && inner !== null && "apply" in inner && "revert" in inner) return leaves(inner as Command);
	return [cmd];
}

function ids(list: readonly { id?: unknown }[]): string[] {
	return list.flatMap((p) => (typeof p.id === "string" ? [p.id] : []));
}

/** Computes the scope of `cmd` (not memoised: use `pageScope`). */
export function computeScope(cmd: Command): StepScope {
	const pages = new Set<string>();
	const registers: Registered[] = [];
	let all = false;
	let global = false;
	for (const leaf of leaves(cmd)) {
		if (isPageLeaf(leaf)) {
			pages.add(leaf.pageId);
		} else if (leaf instanceof SetPageContent) {
			pages.add(leaf.change.pageId);
		} else if (leaf instanceof ReplacePage) {
			pages.add(leaf.before.id);
			pages.add(leaf.after.id);
		} else if (leaf instanceof AddAsset) {
			// names no page and does not make the step global, but it is a shared table: see `Registered`
			registers.push({ kind: "asset", id: leaf.asset.id, adds: () => leaf.adds });
		} else if (leaf instanceof AddSlideRef) {
			registers.push({ kind: "slide", id: leaf.ref.id, adds: () => leaf.adds });
		} else if (leaf instanceof AddPage || leaf instanceof DeletePage) {
			pages.add(leaf.page.id);
			global = true;
		} else if (leaf instanceof MovePage) {
			pages.add(leaf.pageId);
			global = true;
		} else if (leaf instanceof InsertPages) {
			for (const id of ids(leaf.pages)) pages.add(id);
			global = true;
		} else if (leaf instanceof ReorderPages) {
			all = true;
			global = true;
		} else if (leaf instanceof SetPdfView) {
			// 0.28 (#76): turning / cropping a PDF page changes the geometry of the page (size, margins, every item) and, in its step, the excerpts
			// and saved views of other pages that point into it; it is never undone out of order, whatever else the step holds (when in doubt: global).
			pages.add(leaf.pageId);
			global = true;
		} else if (leaf instanceof SetMeta || leaf instanceof SetViews) {
			global = true;
		} else if (leaf instanceof RemoveAsset) {
			// Drops a record every page's pictures may point at (the storage manager's repoint): no page is undone or redone past it.
			global = true;
			all = true;
		} else {
			// A class nobody has classified: it may do anything, so it is never undone out of order and it blocks every page.
			global = true;
			all = true;
			const any = leaf as unknown as { pageId?: unknown };
			if (typeof any.pageId === "string") pages.add(any.pageId);
		}
	}
	return { pages, all, local: !global && !all && pages.size === 1, registers };
}

/** The rules the view gives the History when per-page undo is available. */
export const pageRules: PageRules = { scope: (cmd) => pageScope(cmd) };

const memo = new WeakMap<Command, StepScope>();

/** The scope of a recorded step (memoised: the parts of a step never change once it is recorded). Never throws: a failure is "global". */
export const pageScope: ScopeFn = (cmd) => {
	const known = memo.get(cmd);
	if (known) return known;
	let scope: StepScope;
	try {
		scope = computeScope(cmd);
	} catch {
		scope = { pages: new Set(), all: true, local: false, registers: [] };
	}
	memo.set(cmd, scope);
	return scope;
};

/** Every command class the scope rules know (page-local, companion, page structure, notebook-wide): the test checks the source against it. */
export const CLASSIFIED = [
	"AddStroke", "EraseStrokes", "ReplaceStroke", "AddElement", "RemoveElement", "ReplaceElement", "ReorderLayer", "SetPaper", "SetPageSize", "SetPageMargins",
	"SetPageBackground", "SetPageInfinite", "SetPageLocked", "SetPageTags", "SetPageTimes", "SetPageComments", "SetPageStates", "UpdateCheckbox", "SetMarkerDone",
	"UpdateItems", "SetPageContent", "ReplacePage", "AddAsset", "AddSlideRef", "AddPage", "DeletePage", "MovePage", "InsertPages", "ReorderPages",
	"SetMeta", "SetViews", "RemoveAsset", "Batch", "SetPdfView",
] as const;
