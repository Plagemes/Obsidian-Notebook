/**
 * 0.25 (#84): what each undo step is called in the action history panel. Pure, no Obsidian: the panel (view/history-panel.ts) turns the
 * result into a title, a detail line and an icon with `t()`.
 *
 * Every command class has a title here (`leafInfo`), and a `Batch` or an `UpdateItems` is named by the label its maker gave it
 * (`LABELS`, the English labels that exist in the code) or, failing that, by what its parts are. A command nobody has described, from
 * a class added later, falls back to the generic "Change": the panel never shows an empty row, and a new command needs no change here
 * to work (it only reads as "Change" until it gets a title). Nothing here changes what a command does.
 */
import type { MessageKey } from "../i18n/en";
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
import { ReplacePage } from "./page-restore";
import { SetPdfView } from "./pdf-view-command";
import { SetPageTags } from "./page-tags";
import { SetPageTimes } from "./page-times";
import { AddSlideRef } from "./slide-links";
import { SetPageStates } from "./states";
import type { PageElement, Stroke } from "./types";
import { SetViews } from "./views";
import { SetSections } from "./sections";

/** What the panel shows for one step. */
export interface Described {
	/** The title (a message of the form `histpanel.t.*`; `{thing}` is filled with `thing`). */
	key: MessageKey;
	/** The kind of element a "Added / Removed / Edited: {thing}" title names. */
	thing?: MessageKey;
	/** How many strokes and elements the step touches (0 when that is not a useful thing to say). */
	count: number;
	/** The pages it touches, in order, without repeats (the page ids; a page that is gone has no number). */
	pageIds: string[];
	/** A Lucide icon name. */
	icon: string;
}

type Title = readonly [key: MessageKey, icon: string];

const GENERIC: Title = ["histpanel.t.change", "history"];
const SEVERAL: Title = ["histpanel.t.several", "layers"];

/** The element types that have a noun. */
const THINGS: Readonly<Record<PageElement["type"], MessageKey>> = {
	text: "histpanel.thing.text",
	image: "histpanel.thing.image",
	marker: "histpanel.thing.marker",
	box: "histpanel.thing.box",
	equation: "histpanel.thing.equation",
	graph: "histpanel.thing.graph",
	excerpt: "histpanel.thing.excerpt",
	sticky: "histpanel.thing.sticky",
	checkbox: "histpanel.thing.checkbox",
	area: "histpanel.thing.area",
	tape: "histpanel.thing.tape",
};

/**
 * The English labels the code gives its steps (`Command.label`, the first argument of `new Batch(...)`, the label of `UpdateItems`,
 * `SetPageComments` ...) and the title each one has. A label that is not here still gets a title from what the step is made of.
 * tests/history-describe.test.ts reads the source for the labels in use and fails on one that is missing, so a new one is not forgotten.
 */
export const LABELS: Readonly<Record<string, Title>> = {
	// ink
	"Draw": ["histpanel.t.draw", "pencil"],
	"Erase": ["histpanel.t.erased", "eraser"],
	"Erase area": ["histpanel.t.erased", "eraser"],
	"Erase strokes": ["histpanel.t.erased", "eraser"],
	"Add stroke": ["histpanel.t.stroke", "pencil"],
	// (an element step is named by its class, with the kind of element; these only serve a step whose class is not known)
	"Add element": ["histpanel.t.items", "plus"],
	"Edit element": ["histpanel.t.items", "pencil"],
	"Remove element": ["histpanel.t.items", "trash-2"],
	"Edit stroke": ["histpanel.t.strokeChanged", "pencil"],
	"Clean up strokes": ["histpanel.t.cleanUp", "sparkles"],
	"Join broken strokes": ["histpanel.t.join", "link"],
	"Fill area": ["histpanel.t.fillArea", "paint-bucket"],
	"Align to baseline": ["histpanel.t.baseline", "baseline"],
	"Tidy up page": ["histpanel.t.tidy", "align-left"],
	"Move line": ["histpanel.t.moveLine", "arrow-up-down"],
	"Smooth strokes": ["histpanel.t.smooth", "sparkles"],
	"Straighten strokes": ["histpanel.t.straighten", "minus"],
	"Tidy flowchart": ["histpanel.t.flowchart", "workflow"],
	"Make axes": ["histpanel.t.axes", "activity"],
	"Insert table": ["histpanel.t.tableInsert", "table"],
	"Edit table": ["histpanel.t.tableEdit", "table"],
	"Insert chart": ["histpanel.t.chartInsert", "bar-chart-3"],
	"Update chart": ["histpanel.t.chartUpdate", "refresh-cw"],
	"Compute table": ["histpanel.t.tableCompute", "calculator"],
	"Add marker": ["histpanel.t.markerAdd", "map-pin"],
	"Renumber markers": ["histpanel.t.markerRenumber", "list-ordered"],
	"Insert timeline": ["histpanel.t.timelineInsert", "move-horizontal"], // 0.30 timeline
	"Update timeline": ["histpanel.t.timelineUpdate", "pencil-ruler"], // 0.30 timeline
	"Convert equation to ink": ["histpanel.t.eqInk", "pencil"],
	"Balance reaction": ["histpanel.t.balance", "flask-conical"],
	"Edit graph": ["histpanel.t.graph", "activity"],
	"Sign and date": ["histpanel.t.stamp", "stamp"],
	"Place stamp": ["histpanel.t.stamp", "stamp"],
	"Place symbol": ["histpanel.t.stamp", "stamp"],
	// selection
	"Restyle selection": ["histpanel.t.restyle", "palette"],
	"Shape style": ["histpanel.t.shapeRestyled", "shapes"],
	"Opacity": ["histpanel.t.opacity", "droplet"],
	"Transform selection": ["histpanel.t.transform", "move"],
	"Move selection": ["histpanel.t.transform", "move"],
	"Delete selection": ["histpanel.t.deleteSelection", "trash-2"],
	"Delete ink on deleted objects": ["histpanel.t.deleteSelection", "trash-2"],
	"Duplicate selection": ["histpanel.t.duplicate", "copy"],
	// 0.27 (#170): everything one macro run changed, as one step (History.group)
	"Run macro": ["histpanel.t.macro", "workflow"],
	"Paste": ["histpanel.t.paste", "clipboard-paste"],
	"Paste image": ["histpanel.t.picture", "image"],
	"Move selection to page": ["histpanel.t.toPage", "arrow-right-left"],
	"Copy selection to page": ["histpanel.t.copyToPage", "copy-plus"],
	"Make white transparent": ["histpanel.t.whiteTransparent", "eraser"],
	"Change layer order": ["histpanel.t.layerOrder", "layers"],
	"Group": ["histpanel.t.group", "group"],
	"Ungroup": ["histpanel.t.ungroup", "ungroup"],
	"Lock": ["histpanel.t.lock", "lock"],
	"Unlock": ["histpanel.t.unlock", "lock-open"],
	"Replace all": ["histpanel.t.replaceAll", "replace"],
	"Collapse notes": ["histpanel.t.stickies", "sticky-note"],
	"Open notes": ["histpanel.t.stickies", "sticky-note"],
	// pages
	"Add page": ["histpanel.t.pageAdded", "file-plus"],
	"Add practice page": ["histpanel.t.practice", "file-plus"],
	"New page from template": ["histpanel.t.pageFromTemplate", "file-plus"],
	"Delete page": ["histpanel.t.pageDeleted", "file-minus"],
	"Delete pages": ["histpanel.t.pagesDeleted", "file-minus"],
	"Move page": ["histpanel.t.pageMoved", "arrow-up-down"],
	"Move pages": ["histpanel.t.pagesReordered", "arrow-up-down"],
	"Move content": ["histpanel.t.content", "move"],
	"Insert pages": ["histpanel.t.pagesInserted", "file-plus"],
	"Insert scan": ["histpanel.t.scan", "scan"],
	"Insert image": ["histpanel.t.picture", "image"],
	"Insert image page": ["histpanel.t.picture", "image"],
	"Insert PDF": ["histpanel.t.pdf", "file-text"],
	"Update PDF": ["histpanel.t.pdf", "file-text"],
	"Drop files": ["histpanel.t.dropFiles", "paperclip"],
	"Drop PDF as images": ["histpanel.t.dropFiles", "paperclip"],
	"Replace picture": ["histpanel.t.pictureReplaced", "image"],
	"Restore page": ["histpanel.t.pageRestored", "history"],
	"Restore page as new page": ["histpanel.t.pageRestored", "history"],
	"Restore deleted page": ["histpanel.t.pageRestored", "history"],
	"Add pages from another notebook": ["histpanel.t.pageTransfer", "arrow-right-left"],
	"Move pages in": ["histpanel.t.pageTransfer", "arrow-right-left"],
	"Move pages out": ["histpanel.t.pageTransfer", "arrow-right-left"],
	"Take pages out": ["histpanel.t.pageTransfer", "arrow-right-left"],
	"Change paper": ["histpanel.t.paper", "file"],
	"Change page size": ["histpanel.t.pageSize", "expand"],
	"Change page margins": ["histpanel.t.margins", "frame"],
	"Change page background": ["histpanel.t.background", "image"],
	"Change infinite page": ["histpanel.t.infinite", "infinity"],
	"Rotate or crop PDF page": ["histpanel.t.pdfRotate", "rotate-cw"],
	"Change page tags": ["histpanel.t.pageTags", "tag"],
	"Page times": ["histpanel.t.pageTimes", "clock"],
	"Lock page": ["histpanel.t.pageLocked", "lock"],
	"Unlock page": ["histpanel.t.pageLocked", "lock-open"],
	"Lock pages": ["histpanel.t.pageLocked", "lock"],
	"Unlock pages": ["histpanel.t.pageLocked", "lock-open"],
	"Lecture header": ["histpanel.t.lectureHeader", "graduation-cap"],
	"Board shot": ["histpanel.t.boardShot", "camera"],
	"Merge conflicted copy": ["histpanel.t.merged", "git-merge"],
	"Follow renamed note": ["histpanel.t.followed", "link"],
	"Add copy links": ["histpanel.t.copyLinks", "link"],
	"Excerpt": ["histpanel.t.excerpt", "quote"],
	"Update excerpt source": ["histpanel.t.excerpt", "quote"],
	"Link ink to slide": ["histpanel.t.slideLink", "presentation"],
	// notebook
	"Change notebook properties": ["histpanel.t.meta", "settings"],
	"Change cover": ["histpanel.t.cover", "image"],
	"Add file": ["histpanel.t.fileAdded", "paperclip"],
	"Remove file": ["histpanel.t.fileRemoved", "paperclip"],
	"Change saved views": ["histpanel.t.views", "scan-eye"],
	"Save view": ["histpanel.t.views", "scan-eye"],
	"Rename view": ["histpanel.t.views", "scan-eye"],
	"Update view": ["histpanel.t.views", "scan-eye"],
	"Move view": ["histpanel.t.views", "scan-eye"],
	"Delete view": ["histpanel.t.views", "scan-eye"],
	"Merge saved views": ["histpanel.t.views", "scan-eye"],
	// 0.30 sections (#52)
	"Change sections": ["histpanel.t.sections", "layers"],
	"New section": ["histpanel.t.sections", "layers"],
	"Rename section": ["histpanel.t.sections", "layers"],
	"Recolour section": ["histpanel.t.sections", "layers"],
	"Delete section": ["histpanel.t.sections", "layers"],
	"Merge sections": ["histpanel.t.sections", "layers"],
	"Change states": ["histpanel.t.states", "toggle-left"],
	"Keep parts": ["histpanel.t.states", "toggle-left"],
	"Merge states": ["histpanel.t.states", "toggle-left"],
	// checkboxes, markers, comments
	"Edit checkbox": ["histpanel.t.checkbox", "square-check"],
	"Edit checkbox label": ["histpanel.t.checkbox", "square-check"],
	"Tick checkbox": ["histpanel.t.checkbox", "square-check"],
	"Untick checkbox": ["histpanel.t.checkbox", "square-check"],
	"Toggle checkbox": ["histpanel.t.checkbox", "square-check"],
	"Merge checkbox": ["histpanel.t.checkbox", "square-check"],
	"Make checkbox": ["histpanel.t.checkbox", "square-check"],
	"Toggle checkboxes": ["histpanel.t.checkboxes", "square-check"],
	"Link checkbox to task": ["histpanel.t.linkBox", "link"],
	"Unlink checkboxes": ["histpanel.t.linkBox", "link"],
	"Homework done in the companion note": ["histpanel.t.homework", "square-check"],
	"Resolve marker": ["histpanel.t.marker", "bookmark-check"],
	"Reopen marker": ["histpanel.t.marker", "bookmark-check"],
	"Change comments": ["histpanel.t.comments", "message-square"],
	"Add comment": ["histpanel.t.commentAdded", "message-square"],
	"Reply to comment": ["histpanel.t.commentAdded", "message-square"],
	"Delete comment": ["histpanel.t.comments", "message-square"],
	"Delete reply": ["histpanel.t.comments", "message-square"],
	"Merge comments": ["histpanel.t.comments", "message-square"],
};

/** Looks the label up; null when it is not one the code is known to use. */
export function titleForLabel(label: string): Title | null {
	return Object.prototype.hasOwnProperty.call(LABELS, label) ? LABELS[label]! : null;
}

/** The commands a step is made of, a `Batch` and the lock-exempt wrapper opened up, in order. */
export function leavesOf(cmd: Command): Command[] {
	if (cmd instanceof Batch) return cmd.commands.flatMap(leavesOf);
	const inner = innerOf(cmd);
	return inner ? leavesOf(inner) : [cmd];
}

/** The command a wrapper (`exemptFromLocks`) holds, or null. */
function innerOf(cmd: Command): Command | null {
	const inner = (cmd as { inner?: unknown }).inner;
	return typeof inner === "object" && inner !== null && "apply" in inner && "revert" in inner ? (inner as Command) : null;
}

/** The ids of the pages a single command names. */
function pagesOfLeaf(cmd: Command): string[] {
	const any = cmd as unknown as { pageId?: unknown; page?: { id?: unknown }; pages?: readonly { id?: unknown }[] };
	if (typeof any.pageId === "string") return [any.pageId];
	if (any.page && typeof any.page.id === "string") return [any.page.id];
	if (Array.isArray(any.pages)) return (any.pages as readonly { id?: unknown }[]).flatMap((p) => (typeof p.id === "string" ? [p.id] : []));
	if (cmd instanceof ReplacePage) return [cmd.after.id];
	return [];
}

/** How many strokes and elements a single command touches. */
function itemsOfLeaf(cmd: Command): number {
	if (cmd instanceof EraseStrokes) return cmd.items.length;
	if (cmd instanceof AddStroke || cmd instanceof ReplaceStroke || cmd instanceof AddElement || cmd instanceof RemoveElement || cmd instanceof ReplaceElement) return 1;
	return 0;
}

function samePoints(a: Stroke, b: Stroke): boolean {
	if (a.points === b.points) return true;
	if (a.points.length !== b.points.length) return false;
	for (let i = 0; i < a.points.length; i++) {
		const p = a.points[i]!;
		const q = b.points[i]!;
		if (p[0] !== q[0] || p[1] !== q[1]) return false;
	}
	return true;
}

/** A replaced stroke: erased, cut in parts, restyled (same shape of line, other look) or changed (moved, reshaped). */
function replaceStrokeTitle(cmd: ReplaceStroke): Title {
	if (cmd.after.length === 0) return ["histpanel.t.erased", "eraser"];
	if (cmd.after.length > 1) return ["histpanel.t.cut", "scissors"];
	const next = cmd.after[0]!;
	if (samePoints(cmd.before, next)) return cmd.before.tool === "shape" ? ["histpanel.t.shapeRestyled", "shapes"] : ["histpanel.t.strokeRestyled", "palette"];
	return ["histpanel.t.strokeChanged", "pencil"];
}

function thingOf(el: PageElement): MessageKey {
	return THINGS[el.type] ?? "histpanel.thing.text";
}

/** The title of a command that is not a batch: its class decides, its label only when the class is not one of those below. */
function leafInfo(cmd: Command): { title: Title; thing?: MessageKey } {
	if (cmd instanceof AddStroke) return { title: ["histpanel.t.stroke", "pencil"] };
	if (cmd instanceof EraseStrokes) return { title: ["histpanel.t.erased", "eraser"] };
	if (cmd instanceof ReplaceStroke) return { title: replaceStrokeTitle(cmd) };
	if (cmd instanceof AddElement) return { title: ["histpanel.t.added", "plus"], thing: thingOf(cmd.element) };
	if (cmd instanceof RemoveElement) return { title: ["histpanel.t.removed", "trash-2"], thing: thingOf(cmd.element) };
	if (cmd instanceof ReplaceElement) return { title: ["histpanel.t.edited", "pencil"], thing: thingOf(cmd.after) };
	if (cmd instanceof AddPage) return { title: ["histpanel.t.pageAdded", "file-plus"] };
	if (cmd instanceof DeletePage) return { title: ["histpanel.t.pageDeleted", "file-minus"] };
	if (cmd instanceof MovePage) return { title: ["histpanel.t.pageMoved", "arrow-up-down"] };
	if (cmd instanceof InsertPages) return { title: ["histpanel.t.pagesInserted", "file-plus"] };
	if (cmd instanceof ReorderPages) return { title: ["histpanel.t.pagesReordered", "arrow-up-down"] };
	if (cmd instanceof ReplacePage) return { title: ["histpanel.t.pageRestored", "history"] };
	if (cmd instanceof SetPaper) return { title: ["histpanel.t.paper", "file"] };
	if (cmd instanceof SetPageSize) return { title: ["histpanel.t.pageSize", "expand"] };
	if (cmd instanceof SetPageMargins) return { title: ["histpanel.t.margins", "frame"] };
	if (cmd instanceof SetPageBackground) return { title: ["histpanel.t.background", "image"] };
	// 0.28 (#76): turning or cropping a PDF page.
	if (cmd instanceof SetPdfView) return { title: [cmd.kind === "crop" ? "histpanel.t.pdfCrop" : "histpanel.t.pdfRotate", cmd.kind === "crop" ? "crop" : "rotate-cw"] };
	if (cmd instanceof SetPageInfinite) return { title: ["histpanel.t.infinite", "infinity"] };
	if (cmd instanceof SetPageContent) return { title: ["histpanel.t.content", "move"] };
	if (cmd instanceof SetPageLocked) return { title: ["histpanel.t.pageLocked", cmd.value ? "lock" : "lock-open"] };
	if (cmd instanceof SetPageTags) return { title: ["histpanel.t.pageTags", "tag"] };
	if (cmd instanceof SetPageTimes) return { title: ["histpanel.t.pageTimes", "clock"] };
	if (cmd instanceof ReorderLayer) return { title: ["histpanel.t.layerOrder", "layers"] };
	if (cmd instanceof SetMeta) return { title: ["histpanel.t.meta", "settings"] };
	if (cmd instanceof AddAsset) return { title: ["histpanel.t.fileAdded", "paperclip"] };
	if (cmd instanceof RemoveAsset) return { title: ["histpanel.t.fileRemoved", "paperclip"] };
	if (cmd instanceof AddSlideRef) return { title: ["histpanel.t.slideLink", "presentation"] };
	if (cmd instanceof SetPageComments) return { title: titleForLabel(cmd.label) ?? ["histpanel.t.comments", "message-square"] };
	if (cmd instanceof UpdateCheckbox) return { title: ["histpanel.t.checkbox", "square-check"] };
	if (cmd instanceof SetMarkerDone) return { title: ["histpanel.t.marker", "bookmark-check"] };
	if (cmd instanceof SetPageStates) return { title: ["histpanel.t.states", "toggle-left"] };
	if (cmd instanceof SetViews) return { title: ["histpanel.t.views", "scan-eye"] };
	if (cmd instanceof SetSections) return { title: ["histpanel.t.sections", "layers"] };
	if (cmd instanceof UpdateItems) return { title: titleForLabel(cmd.label) ?? ["histpanel.t.items", "layers"] };
	// A class this file does not know: its own label if the code is known to use it, else the generic title.
	return { title: titleForLabel(cmd.label) ?? GENERIC };
}

/** The same class for every part of a step (or null): a step of strokes only reads as "Strokes added", not as "Several changes". */
function commonClass(leaves: readonly Command[]): Command | null {
	const first = leaves[0];
	if (!first) return null;
	return leaves.every((c) => c.constructor === first.constructor) ? first : null;
}

const cache = new WeakMap<Command, Described>();

/**
 * What the panel shows for `cmd`. Never throws and always gives a title: an unknown command is "Change". Memoised per command (the
 * parts of a step never change once it is recorded).
 */
export function describeCommand(cmd: Command): Described {
	const known = cache.get(cmd);
	if (known) return known;
	let out: Described;
	try {
		out = describeNow(cmd);
	} catch {
		out = { key: GENERIC[0], count: 0, pageIds: [], icon: GENERIC[1] };
	}
	cache.set(cmd, out);
	return out;
}

function describeNow(cmd: Command): Described {
	const leaves = leavesOf(cmd);
	const pageIds = [...new Set(leaves.flatMap(pagesOfLeaf))];
	const count = leaves.reduce((n, c) => n + itemsOfLeaf(c), 0);
	// A batch the code gave a name (its label is one the code is known to use) is called by that name; any other step of one command is
	// called by that command's class, and a batch of several by what its parts have in common.
	const top = innerOf(cmd) ?? cmd;
	const named = top instanceof Batch ? titleForLabel(top.label) : null;
	if (named) return { key: named[0], count, pageIds, icon: named[1] };
	const whole = leaves.length === 1 ? leaves[0]! : null;
	if (whole) {
		const { title, thing } = leafInfo(whole);
		return { key: title[0], ...(thing ? { thing } : {}), count: 0, pageIds, icon: title[1] };
	}
	const same = commonClass(leaves);
	if (same instanceof AddStroke) return { key: "histpanel.t.strokes", count, pageIds, icon: "pencil" };
	if (same) {
		const { title, thing } = leafInfo(same);
		return { key: title[0], ...(thing ? { thing } : {}), count, pageIds, icon: title[1] };
	}
	return { key: SEVERAL[0], count, pageIds, icon: SEVERAL[1] };
}
