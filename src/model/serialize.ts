import { normalizeBookmarkInfoMap } from "./bookmarks";
import { cleanMarkerText, isBoxKind, isIsoDate, isMarkerKind } from "./markers";
import {
	cleanGraphLabel, deepFreezeGraph, EQUATION_LATEX_MAX, GRAPH_MAX_SIDE, EQUATION_OUTLINE_MAX, GRAPH_EXPR_MAX, GRAPH_ID_MAX, GRAPH_MAX_FUNCTIONS,
	GRAPH_MAX_LINE_WIDTH, GRAPH_MAX_PARAMS, GRAPH_MAX_PIECES, GRAPH_TABLE_MAX_ROWS, isGraphFunctionKind, isParamName, isViewport,
} from "./math-elements";
import { parseOutline } from "../math/outline";
import { EXCERPT_ID_MAX, EXCERPT_PATH_MAX } from "./excerpts";
import { detectVersion, migrate, MigrationError, v10OnlyElement, v15OnlyElement, v17OnlyElement, v23OnlyElement, v27OnlyElement, withoutV11Meta, withoutV12Slides, withoutV21Views, type RawObject } from "./migrations";
import { isStoredViewName, normalizeViewName, validRegion } from "./views";
import { CHECKBOX_BLOCK_MAX, CHECKBOX_LABEL_MAX, CHECKBOX_MAX_SIZE, CHECKBOX_MIN_SIZE, CHECKBOX_PATH_MAX, cleanCheckboxLabel, isOurBlockId } from "./checklist";
import { AREA_MAX_SIDE, AREA_MIN_SIDE } from "./area";
import { TAPE_MAX_SIDE, TAPE_MIN_SIDE } from "./tape";
import { isOpacity, normaliseOpacity, OPACITY_MAX, OPACITY_MIN } from "./opacity";
import { canTaper, isTaper, TAPER_MAX, TAPER_MIN } from "./taper";
import { isPdfCrop, isPdfRotation, PDF_CROP_MAX, PDF_CROP_MIN_SIDE } from "./pdf-view-format";
import { commentLine, normalizeComments, readComments } from "./comments-format";
import { normalizePageStates, STATE_COLOR_RE, statesLine } from "./states-format";
import { normalizePageTags } from "./page-tags";
import { STICKY_INK_MAX, STICKY_MAX_FONT, STICKY_MAX_SIZE, STICKY_MIN_FONT, STICKY_MIN_SIZE, STICKY_TEXT_MAX } from "./sticky";
import { normalizePosition } from "./position";
import { pageTimesProblem } from "./page-times";
import {
	COVER_ART_STYLES, CURRENT_VERSION, DEFAULT_META, ELEMENT_TYPES_V8, ELEMENT_TYPES_V9, ELEMENT_TYPES_V10, ELEMENT_TYPES_V15, ELEMENT_TYPES_V17, ELEMENT_TYPES_V23, ELEMENT_TYPES_V27, FORMAT_ID, GROUP_ID_MAX, isNewPen, isNibAngle, isNibPen, isShapeDash, isShapeTool, META_DESCRIPTION_MAX, PAPER_KINDS, RENDER_INK, RENDER_VERSIONS, TOOLS,
	SLIDE_ID_MAX, SLIDE_PATH_MAX, SLIDE_SOURCE_MAX, type SlideRef,
	STATES_ID_MAX, STATES_MAX_ITEMS, STATES_MAX_PARTS, STATES_MAX_ROT, STATES_MAX_SCALE, STATES_MAX_SHIFT, STATES_MAX_STATES, STATES_MIN_SCALE, STATES_NAME_MAX,
	type PageState, type PageStates, type PartPose, type StatePart,
	type Asset, type AreaElement, type CheckboxElement, type ElementFlags, type CoverArt, type CoverArtStyle, type AssetKind, type BookmarkInfo, type BoxElement, type EquationElement, type ExcerptElement, type ExcerptSource, type GraphElement, type GraphFunction, type GraphParam,
	type GraphPiece, type GraphTable, type GraphViewport, type ImageElement, type MarkerElement, type NotebookDocument, type NotebookMeta, type Page,
	type PageBackground, type PageComment, type PageElement, type PageMargins, type PaperKind, type Point, type ReadingPosition, type RenderVersion, type StickyElement, type Stroke,
	type TapeElement, type TextElement, type Tool,
	VIEWS_MAX, VIEW_ID_MAX, VIEW_PAGE_ID_MAX, type SavedView,
} from "./types";

export type ParseFailure =
	| "empty"
	| "json"
	| "not-notebook"
	| "future-version"
	| "invalid";

export type ParseResult =
	/**
	 * `dropped` (v7, only when > 0): optional details that were invalid and left out on read (a bookmark detail
	 * field such as a bad colour, the reading position or its y; v8: a marker or box, one of their optional fields,
	 * or a stroke's `hidden` flag; v9: an equation or graph or one of their parts; v10: an excerpt or its snapshot asset) instead of making the whole notebook unreadable.
	 * Saving writes the document without them, so callers keep a backup of the original text first.
	 */
	| { ok: true; doc: NotebookDocument; migratedFrom: number | null; dropped?: number }
	| { ok: false; reason: ParseFailure; message: string; version?: number };

class ValidationError extends Error {}

/**
 * `JSON.stringify` for the hand-built lines of the writer. `JSON.stringify(undefined)` is `undefined`, which a template literal
 * would write as the bare word `undefined` (not JSON): a missing value is refused here, before any text is built, so the save is
 * stopped with a clear message instead of producing text that cannot be read back.
 */
function j(v: unknown): string {
	const text = JSON.stringify(v);
	if (text === undefined) {
		if (lenientWrite) return "null";
		fail("value", "a required field is missing (undefined)");
	}
	return text;
}

/** The colour of a stroke or element as JSON text; a colour that is not even a string is refused with the owner named. */
function jc(owner: { id: string; type?: string; color: unknown }): string {
	if (typeof owner.color !== "string") {
		if (lenientWrite) return "null";
		fail(`${owner.type ?? "stroke"} ${String(owner.id)}.color`, "expected a #rrggbb colour (it is missing)");
	}
	return JSON.stringify(owner.color);
}

/** Review fix (U2): set only while `serializeLenient` runs (the writer is synchronous). */
let lenientWrite = false;

/**
 * Review fix (U2): the text of `doc` for a BACKUP only, never for the notebook file: a missing required value is written as `null`
 * instead of stopping the writer, so the line that holds it is invalid (the repair's line scan leaves it out) and every other line is
 * kept. No cache is filled (`serialize` fills none).
 */
export function serializeLenient(doc: NotebookDocument): string {
	lenientWrite = true;
	try {
		return serialize(doc);
	} finally {
		lenientWrite = false;
	}
}

/**
 * Lenient read of optional v7 details: invalid ones are counted here and left out instead of failing the
 * document. Null: strict (every invalid value fails), used to check what is about to be written.
 */
export interface Dropped {
	count: number;
}

function fail(path: string, what: string): never {
	throw new ValidationError(`${path}: ${what}`);
}

function strokeLine(s: Stroke): string {
	// v8: `hidden` only when set, between render and points; v12: `slide` only when set, after `hidden`; v18: `group` only when set, after `slide`.
	const hidden = s.hidden !== undefined ? `,"hidden":${j(s.hidden)}` : "";
	const slide = s.slide !== undefined ? `,"slide":${j(s.slide)}` : "";
	const group = s.group !== undefined ? `,"group":${j(s.group)}` : "";
	// v20: `nib` only when set, after `group`.
	const nib = s.nib !== undefined ? `,"nib":${j(s.nib)}` : "";
	// v22: `fill`, `fillTint` (only with a fill) and `dash`, each only when set, after `nib`.
	const fill = (s.fill !== undefined ? `,"fill":${j(s.fill)}` : "") + (s.fillTint !== undefined ? `,"fillTint":${j(s.fillTint)}` : "") + (s.dash !== undefined ? `,"dash":${j(s.dash)}` : "");
	// v24: `opacity` only when set, after the shape style.
	const opacity = s.opacity !== undefined ? `,"opacity":${j(s.opacity)}` : "";
	// v25: `taperStart` and `taperEnd`, each only when set, after `opacity`.
	const taper = (s.taperStart !== undefined ? `,"taperStart":${j(s.taperStart)}` : "") + (s.taperEnd !== undefined ? `,"taperEnd":${j(s.taperEnd)}` : "");
	return `\t\t\t\t{"id":${j(s.id)},"tool":${j(s.tool)},"color":${jc(s)},"width":${j(s.width)},"render":${j(s.render)}${hidden}${slide}${group}${nib}${fill}${opacity}${taper},"points":${j(s.points)}}`;
}

/**
 * v18: the optional flags every element carries (`ElementFlags`) written at the end of the element's line: the group, the lock
 * and the time of the last lock decision, in that order. `line` is the element's line without them (it ends with `}`).
 */
function withFlags(line: string, e: ElementFlags): string {
	let extra = "";
	if (e.group !== undefined) extra += `,"group":${j(e.group)}`;
	if (e.locked === true) extra += `,"locked":true`;
	if (e.lockAt !== undefined) extra += `,"lockAt":${j(e.lockAt)}`;
	return extra === "" ? line : `${line.slice(0, -1)}${extra}}`;
}

/** v18: a copy of `item` without its group (the same object when it has none). */
function withoutGroup<T extends Stroke | PageElement>(item: T): T {
	if (item.group === undefined) return item;
	const copy = { ...item };
	delete copy.group;
	return copy;
}

/**
 * v18: the ids of the groups of `page` that have at least two members (strokes and elements together). The writer leaves out the
 * group of a member of any other group (a group of one is nothing), so an erased member never makes a notebook unsavable.
 * Null when the page has no group at all (the usual case costs one pass).
 */
export function liveGroups(page: Pick<Page, "strokes" | "elements">): ReadonlySet<string> | null {
	let counts: Map<string, number> | null = null;
	const count = (g: string | undefined) => {
		if (g === undefined) return;
		counts ??= new Map();
		counts.set(g, (counts.get(g) ?? 0) + 1);
	};
	for (const s of page.strokes) count(s.group);
	for (const e of page.elements ?? []) count(e.group);
	if (counts === null) return null;
	const live = new Set<string>();
	for (const [g, n] of counts as Map<string, number>) if (n >= 2) live.add(g);
	return live;
}

/** v12 slide reference: id, source, page, then the path when present. */
function slideRefLine(r: SlideRef): string {
	const path = r.path !== undefined ? `,"path":${j(r.path)}` : "";
	return `\t\t{"id":${j(r.id)},"source":${j(r.source)},"page":${j(r.page)}${path}}`;
}

/** v12: copies of strokes written without their `slide` (it names no entry of the document's table), one per stroke. */
const withoutSlideCopies = new WeakMap<Stroke, Stroke>();

function withoutSlide(s: Stroke): Stroke {
	let copy = withoutSlideCopies.get(s);
	if (!copy) {
		const c: Stroke = { ...s };
		delete c.slide;
		copy = Object.isFrozen(s) ? Object.freeze(c) : c;
		withoutSlideCopies.set(s, copy);
	}
	return copy;
}

/**
 * v12: the slide references that are written (those a stroke refers to, in table order, each id once) and how each stroke
 * is written (without its `slide` when that names no entry of the table: ink pasted from another notebook).
 */
function slidesInUse(doc: NotebookDocument): { refs: SlideRef[]; stroke: (s: Stroke) => Stroke } {
	const table = doc.slides ?? [];
	if (table.length === 0) return { refs: [], stroke: (s) => (s.slide === undefined ? s : withoutSlide(s)) };
	const known = new Set(table.map((r) => r.id));
	const used = new Set<string>();
	for (const page of doc.pages) for (const s of page.strokes) if (s.slide !== undefined && known.has(s.slide)) used.add(s.slide);
	const refs: SlideRef[] = [];
	for (const r of table) {
		if (!used.has(r.id)) continue;
		used.delete(r.id);
		refs.push(r);
	}
	return { refs, stroke: (s) => (s.slide === undefined || known.has(s.slide) ? s : withoutSlide(s)) };
}

/** v13: the states of `page` as the writer keeps them (only parts whose strokes are on the page, no identity poses, ...). */
function statesToWrite(page: Page): PageStates | undefined {
	if (!page.states) return undefined;
	return normalizePageStates(page.states, new Set(page.strokes.map((s) => s.id)));
}

/** v8 marker: required fields, then the optional ones in a fixed order, each only when present (the label normalised). */
function markerLine(e: MarkerElement): string {
	let out = `{"id":${j(e.id)},"type":"marker","kind":${j(e.kind)},"x":${j(e.x)},"y":${j(e.y)}`;
	if (e.width !== undefined) out += `,"width":${j(e.width)}`;
	if (e.height !== undefined) out += `,"height":${j(e.height)}`;
	if (e.at !== undefined) out += `,"at":${j(e.at)}`;
	if (e.done !== undefined) out += `,"done":${j(e.done)}`;
	if (e.slide !== undefined) out += `,"slide":${j(e.slide)}`;
	if (e.due !== undefined) out += `,"due":${j(e.due)}`;
	const text = cleanMarkerText(e.text);
	if (text !== undefined) out += `,"text":${j(text)}`;
	return `\t\t\t\t${out}}`;
}

/** v8 structured box: kind and frame, then the title when present (normalised). */
function boxLine(e: BoxElement): string {
	const title = cleanMarkerText(e.title);
	const t = title !== undefined ? `,"title":${j(title)}` : "";
	return `\t\t\t\t{"id":${j(e.id)},"type":"box","kind":${j(e.kind)},"x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)}${t}}`;
}

/** v9 equation: frame, source, size and colour, then the optional style flags and the cached outline. */
function equationLine(e: EquationElement): string {
	let out = `{"id":${j(e.id)},"type":"equation","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"latex":${j(e.latex)},"fontSize":${j(e.fontSize)},"color":${jc(e)}`;
	if (e.inline !== undefined) out += `,"inline":${j(e.inline)}`;
	if (e.numbered !== undefined) out += `,"numbered":${j(e.numbered)}`;
	if (e.outline !== undefined) out += `,"outline":${j(e.outline)}`;
	return `\t\t\t\t${out}}`;
}

/** A graphed function with its fields in a fixed order, the ones of its kind only, labels normalised. */
function canonicalFunction(f: GraphFunction): Record<string, unknown> {
	const o: Record<string, unknown> = { id: f.id, kind: f.kind, color: f.color };
	if (f.kind === "parametric") {
		o.x = f.x;
		o.y = f.y;
	} else if (f.kind === "piecewise") {
		o.pieces = (f.pieces ?? []).map((p) => (p.when !== undefined ? { expr: p.expr, when: p.when } : { expr: p.expr }));
	} else o.expr = f.expr;
	if (f.min !== undefined) o.min = f.min;
	if (f.max !== undefined) o.max = f.max;
	if (f.width !== undefined) o.width = f.width;
	if (f.hidden !== undefined) o.hidden = f.hidden;
	if (f.roots !== undefined) o.roots = f.roots;
	if (f.extrema !== undefined) o.extrema = f.extrema;
	if (f.intersections !== undefined) o.intersections = f.intersections;
	if (f.tangent !== undefined) o.tangent = f.tangent;
	if (f.area !== undefined) o.area = { from: f.area.from, to: f.area.to };
	const label = cleanGraphLabel(f.label);
	if (label !== undefined) o.label = label;
	return o;
}

/** v9 graph: frame, viewport and functions, then the optional settings in a fixed order (one line). */
function graphLine(e: GraphElement): string {
	const o: Record<string, unknown> = {
		id: e.id, type: "graph", x: e.x, y: e.y, width: e.width, height: e.height,
		view: { xMin: e.view.xMin, xMax: e.view.xMax, yMin: e.view.yMin, yMax: e.view.yMax },
		functions: e.functions.map(canonicalFunction),
	};
	if (e.params !== undefined) {
		o.params = e.params.map((p) => (p.step !== undefined
			? { name: p.name, value: p.value, min: p.min, max: p.max, step: p.step }
			: { name: p.name, value: p.value, min: p.min, max: p.max }));
	}
	if (e.axes !== undefined) o.axes = e.axes;
	if (e.grid !== undefined) o.grid = e.grid;
	if (e.xStep !== undefined) o.xStep = e.xStep;
	if (e.yStep !== undefined) o.yStep = e.yStep;
	const xLabel = cleanGraphLabel(e.xLabel);
	if (xLabel !== undefined) o.xLabel = xLabel;
	const yLabel = cleanGraphLabel(e.yLabel);
	if (yLabel !== undefined) o.yLabel = yLabel;
	if (e.degrees !== undefined) o.degrees = e.degrees;
	// A table whose function was removed is left out (it could not be shown).
	if (e.table !== undefined && e.functions.some((f) => f.id === e.table!.fn)) o.table = { fn: e.table.fn, from: e.table.from, step: e.table.step, rows: e.table.rows };
	return `\t\t\t\t${j(o)}`;
}

/** v10 excerpt: target frame, then the source (notebook path, document id, page id, region), then the snapshot asset when present. */
function excerptLine(e: ExcerptElement): string {
	const s = e.source;
	const source = `{"notebook":${j(s.notebook)},"doc":${j(s.doc)},"page":${j(s.page)},"x":${j(s.x)},"y":${j(s.y)},"width":${j(s.width)},"height":${j(s.height)}}`;
	const asset = e.asset !== undefined ? `,"asset":${j(e.asset)}` : "";
	return `				{"id":${j(e.id)},"type":"excerpt","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"source":${source}${asset}}`;
}

/**
 * v15 sticky note: frame, colour and size, then the optional text, the collapsed flag and (collapsed only) the ids of the
 * strokes it keeps hidden, in that order (one line).
 */
function stickyLine(e: StickyElement): string {
	let line = `				{"id":${j(e.id)},"type":"sticky","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"color":${jc(e)},"fontSize":${j(e.fontSize)}`;
	if (e.text !== undefined && e.text !== "") line += `,"text":${j(e.text)}`;
	if (e.collapsed === true) {
		line += `,"collapsed":true`;
		if (e.ink !== undefined && e.ink.length > 0) line += `,"ink":${j(e.ink)}`;
	}
	return line + "}";
}

/**
 * v17 checkbox: frame and colour, then the optional tick (`checked`), the time of the last toggle (`at`), the time of the last
 * change of the link (`taskAt`), the typed label and the task link, in that order (one line).
 */
function checkboxLine(e: CheckboxElement): string {
	let line = `				{"id":${j(e.id)},"type":"checkbox","x":${j(e.x)},"y":${j(e.y)},"size":${j(e.size)},"color":${jc(e)}`;
	if (e.checked === true) line += `,"checked":true`;
	if (e.at !== undefined) line += `,"at":${j(e.at)}`;
	if (e.taskAt !== undefined) line += `,"taskAt":${j(e.taskAt)}`;
	if (e.label !== undefined && e.label !== "") line += `,"label":${j(e.label)}`;
	if (e.task !== undefined) line += `,"task":{"path":${j(e.task.path)},"block":${j(e.task.block)}}`;
	return line + "}";
}

/** v23 area highlighter: the rectangle, then the colour (one line). */
function areaLine(e: AreaElement): string {
	// v24: `opacity` only when set, after the colour.
	const opacity = e.opacity !== undefined ? `,"opacity":${j(e.opacity)}` : "";
	return `				{"id":${j(e.id)},"type":"area","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"color":${jc(e)}${opacity}}`;
}

/** v27 study tape: the rectangle, then the colour (one line). Whether it is revealed is view-only: never written. */
function tapeLine(e: TapeElement): string {
	return `				{"id":${j(e.id)},"type":"tape","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"color":${jc(e)}}`;
}

function elementLine(e: PageElement): string {
	return withFlags(typedElementLine(e), e);
}

function typedElementLine(e: PageElement): string {
	if (e.type === "text") {
		return `\t\t\t\t{"id":${j(e.id)},"type":"text","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"text":${j(e.text)},"fontSize":${j(e.fontSize)},"color":${jc(e)}}`;
	}
	if (e.type === "image") {
		// v24: `opacity` only when set, after the rotation.
		const opacity = e.opacity !== undefined ? `,"opacity":${j(e.opacity)}` : "";
		return `\t\t\t\t{"id":${j(e.id)},"type":"image","asset":${j(e.asset)},"x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"rotation":${j(e.rotation)}${opacity}}`;
	}
	if (e.type === "marker") return markerLine(e);
	if (e.type === "box") return boxLine(e);
	if (e.type === "equation") return equationLine(e);
	if (e.type === "graph") return graphLine(e);
	if (e.type === "excerpt") return excerptLine(e);
	if (e.type === "sticky") return stickyLine(e);
	if (e.type === "checkbox") return checkboxLine(e);
	if (e.type === "area") return areaLine(e);
	if (e.type === "tape") return tapeLine(e);
	return fail("element", "unknown element type");
}

function assetLine(a: Asset): string {
	return `\t\t${j(a.id)}: {"id":${j(a.id)},"kind":${j(a.kind)},"path":${j(a.path)},"name":${j(a.name)},"bytes":${j(a.bytes)}}`;
}

/**
 * Tags without duplicates; bookmarks without duplicates and without ids of pages that no longer exist;
 * v7 bookmark details only for bookmarked pages, normalised, in bookmark order (absent when there are none).
 */
function normalizeMeta(meta: NotebookMeta, pageIds: ReadonlySet<string>): NotebookMeta {
	const bookmarks = [...new Set(meta.bookmarks)].filter((id) => pageIds.has(id));
	const out: NotebookMeta = { tags: [...new Set(meta.tags)], favorite: meta.favorite, cover: meta.cover, bookmarks };
	const info = normalizeBookmarkInfoMap(meta.bookmarkInfo, bookmarks);
	if (info) out.bookmarkInfo = info;
	// v11: an empty description is no description; both fields are written only when present (strict on write, see readMeta).
	if (meta.description !== undefined && meta.description !== "") out.description = meta.description;
	if (meta.coverArt) out.coverArt = meta.coverArt.kind === "art"
		? { kind: "art", style: meta.coverArt.style, seed: meta.coverArt.seed }
		: { kind: "image", asset: meta.coverArt.asset };
	return out;
}

/** v11 cover, fixed key order. */
function coverArtLine(c: CoverArt): string {
	return c.kind === "art"
		? `{"kind":"art","style":${j(c.style)},"seed":${j(c.seed)}}`
		: `{"kind":"image","asset":${j(c.asset)}}`;
}

function bookmarkInfoLine(info: BookmarkInfo): string {
	const parts: string[] = [];
	if (info.title !== undefined) parts.push(`"title":${j(info.title)}`);
	if (info.color !== undefined) parts.push(`"color":${j(info.color)}`);
	if (info.category !== undefined) parts.push(`"category":${j(info.category)}`);
	return `{${parts.join(",")}}`;
}

function metaLine(meta: NotebookMeta): string {
	const base = `"tags":${j(meta.tags)},"favorite":${j(meta.favorite)},"cover":${j(meta.cover)},"bookmarks":${j(meta.bookmarks)}`;
	const info = meta.bookmarkInfo;
	// In bookmark order (normalizeMeta), so the line does not depend on the order keys were added in memory.
	const entries = info ? meta.bookmarks.filter((id) => Object.prototype.hasOwnProperty.call(info, id)).map((id) => `${j(id)}:${bookmarkInfoLine(info[id]!)}`) : null;
	const v11 = `${meta.description !== undefined ? `,"description":${j(meta.description)}` : ""}${meta.coverArt ? `,"coverArt":${coverArtLine(meta.coverArt)}` : ""}`;
	return `{${base}${entries ? `,"bookmarkInfo":{${entries.join(",")}}` : ""}${v11}}`;
}

/** v21 saved view: id, name, page, then the region and the zoom, in a fixed order. */
function viewLine(v: SavedView): string {
	return `\t\t{"id":${j(v.id)},"name":${j(v.name)},"page":${j(v.page)},"x":${j(v.x)},"y":${j(v.y)},"width":${j(v.width)},"height":${j(v.height)},"zoom":${j(v.zoom)}}`;
}

function positionLine(p: ReadingPosition): string {
	return p.y !== undefined
		? `{"page":${j(p.page)},"y":${j(p.y)},"at":${j(p.at)}}`
		: `{"page":${j(p.page)},"at":${j(p.at)}}`;
}

function assemble(
	doc: NotebookDocument,
	lineOf: (s: Stroke) => string,
	elementLineOf: (e: PageElement) => string = elementLine,
	/** v13: the states a page is written with (default: the live ones, see `statesToWrite`). */
	statesOf: (page: Page) => PageStates | undefined = statesToWrite,
): string {
	const slides = slidesInUse(doc);
	const pages = doc.pages.map((page) => {
		// v18: a group of fewer than two members is not written (it is a nothing: the member is written without it).
		const live = liveGroups(page);
		const strokes = page.strokes.map((s) => lineOf(live !== null && s.group !== undefined && !live.has(s.group) ? withoutGroup(slides.stroke(s)) : slides.stroke(s)));
		// v15: a collapsed note names only strokes that are on its page (ids of strokes that are gone are not written).
		const elements = (page.elements ?? []).map((e) => {
			const shown = live !== null && e.group !== undefined && !live.has(e.group) ? withoutGroup(e) : e;
			return elementLineOf(shown.type === "sticky" && shown.ink ? withLiveInk(shown, page.strokes) : shown);
		});
		const out = [
			"\t\t{",
			`\t\t\t"id": ${j(page.id)},`,
			`\t\t\t"width": ${j(page.width)},`,
			`\t\t\t"height": ${j(page.height)},`,
			`\t\t\t"paper": {"kind":${j(page.paper.kind)},"spacing":${j(page.paper.spacing)}},`,
		];
		const tags = normalizePageTags(page.tags);
		if (tags) out.push(`\t\t\t"tags": ${j(tags)},`);
		const b = page.background;
		if (b) {
			// v26 (#76): the turn and the crop of a PDF page, each only when set, after `page`.
			const pdfView = b.kind === "pdf"
				? (b.rotate !== undefined ? `,"rotate":${j(b.rotate)}` : "")
					+ (b.crop !== undefined ? `,"crop":{"x":${j(b.crop.x)},"y":${j(b.crop.y)},"width":${j(b.crop.width)},"height":${j(b.crop.height)}}` : "")
				: "";
			out.push(b.kind === "pdf"
				? `\t\t\t"background": {"kind":"pdf","asset":${j(b.asset)},"page":${j(b.page)}${pdfView}},`
				: `\t\t\t"background": {"kind":${j(b.kind)},"asset":${j(b.asset)}},`);
		}
		const m = page.margins;
		if (m) out.push(`\t\t\t"margins": {"left":${j(m.left)},"right":${j(m.right)},"bottom":${j(m.bottom)}},`);
		if (page.infinite !== undefined) out.push(`\t\t\t"infinite": ${j(page.infinite)},`);
		// v14: a locked page (false is never written: absent = unlocked).
		if (page.locked === true) out.push(`\t\t\t"locked": true,`);
		// v19: the start and end time, together or not at all (a lone or inverted value is written as it is, so the strict check refuses
		// it rather than the writer inventing the other one: the history's guard keeps such a page from ever being saved).
		if (page.startAt !== undefined) out.push(`\t\t\t"startAt": ${j(page.startAt)},`);
		if (page.endAt !== undefined) out.push(`\t\t\t"endAt": ${j(page.endAt)},`);
		const states = statesOf(page);
		if (states) out.push(`\t\t\t"states": ${statesLine(states)},`);
		// v16: the comments, one per line, as the writer keeps them (see comments-format.ts); nothing is written when none is left.
		const comments = normalizeComments(page.comments, page);
		if (comments) out.push(`\t\t\t"comments": [\n${comments.map(commentLine).join(",\n")}\n\t\t\t],`);
		if (elements.length) out.push(`\t\t\t"elements": [\n${elements.join(",\n")}\n\t\t\t],`);
		out.push(strokes.length ? `\t\t\t"strokes": [\n${strokes.join(",\n")}\n\t\t\t]` : `\t\t\t"strokes": []`);
		out.push("\t\t}");
		return out.join("\n");
	});
	const pageIds = new Set(doc.pages.map((p) => p.id));
	const meta = normalizeMeta(doc.meta ?? DEFAULT_META, pageIds);
	const position = normalizePosition(doc.position, pageIds);
	const assets = Object.values(doc.assets ?? {}).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	return [
		"{",
		`\t"format": ${j(doc.format)},`,
		`\t"version": ${j(doc.version)},`,
		`\t"id": ${j(doc.id)},`,
		`\t"createdAt": ${j(doc.createdAt)},`,
		`\t"modifiedAt": ${j(doc.modifiedAt)},`,
		`\t"meta": ${metaLine(meta)},`,
		...(position ? [`\t"position": ${positionLine(position)},`] : []),
		...(slides.refs.length ? [`\t"slides": [\n${slides.refs.map(slideRefLine).join(",\n")}\n\t],`] : []),
		// v21: the saved views, as they are (a malformed one is written as it is, so the strict check refuses it: the history's guard keeps such a notebook from being saved).
		...(doc.views && doc.views.length > 0 ? [`\t"views": [\n${doc.views.map(viewLine).join(",\n")}\n\t],`] : []),
		assets.length ? `\t"assets": {\n${assets.map(assetLine).join(",\n")}\n\t},` : `\t"assets": {},`,
		`\t"pages": [\n${pages.join(",\n")}\n\t]`,
		"}",
		"",
	].join("\n");
}

/**
 * Deterministic serialization: fixed key order, one stroke, element and asset per line.
 * `serialize(parse(s).doc) === s` for every `s` produced by this function.
 * Metadata is written normalised: tags without duplicates, bookmarks without duplicates and
 * without ids of pages that are not in the document (a deleted page may still be bookmarked in memory).
 */
export function serialize(doc: NotebookDocument): string {
	return assemble(doc, strokeLine);
}

function isObject(v: unknown): v is RawObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
	if (typeof v !== "string" || v.length === 0) fail(path, "expected a non-empty string");
	return v;
}

function positive(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(path, "expected a positive number");
	return v;
}

function finite(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "expected a finite number");
	return v;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_RE = /^[0-9a-f]+$/;

function colour(v: unknown, path: string): string {
	if (typeof v !== "string" || !COLOR_RE.test(v)) fail(path, "expected a #rrggbb colour");
	return v;
}

/** Smallest accepted paper spacing, pt (0.5 pt ≈ 0.18 mm; the finest preset is 1 mm). */
export const MIN_PAPER_SPACING = 0.5;
/** Largest accepted text size, pt. */
export const MAX_FONT_SIZE = 400;

function readPoint(v: unknown, path: string): Point {
	if (!Array.isArray(v) || v.length !== 3) fail(path, "expected a [x, y, pressure] point");
	const [x, y, p] = v as unknown[];
	if (typeof x !== "number" || !Number.isFinite(x)) fail(path, "invalid x");
	if (typeof y !== "number" || !Number.isFinite(y)) fail(path, "invalid y");
	if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) fail(path, "pressure outside [0, 1]");
	return [x, y, p];
}

/**
 * How the v12 `slide` of a stroke is read: a set — it must name an entry of the document's table (reading a file);
 * `"any"` — any well-formed id (checking a stroke on its own: the writer leaves out a `slide` that names no entry);
 * `"ignore"` — not ours (a stroke of an older file read page by page): left out without counting, as the migration does.
 */
type SlideIds = ReadonlySet<string> | "any" | "ignore";

function readStroke(v: unknown, path: string, drop: Dropped | null = null, slides: SlideIds = "any", groups = true, pens = true, shapeStyle = true, withOpacity = true, withTaper = true): Stroke {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	// v20: a tool name this version does not know is a detail of the stroke when reading leniently (the stroke is read as a "pen" and
	// counted, so the ink is kept); strictly it fails. In a file of an older format (`pens` false) the new pens did not exist: such a
	// stroke was not written by any version of this plugin and fails, as the migration refuses it.
	const known = TOOLS.includes(v.tool as Tool);
	let tool: Tool;
	if (known && (pens || !isNewPen(v.tool as Tool))) tool = v.tool as Tool;
	else if (known) fail(`${path}.tool`, `tool '${String(v.tool)}' exists only from v20`);
	else if (drop) {
		drop.count++;
		tool = "pen";
	} else fail(`${path}.tool`, "unknown tool");
	if (typeof v.color !== "string" || !COLOR_RE.test(v.color)) fail(`${path}.color`, "expected a #rrggbb colour");
	const width = positive(v.width, `${path}.width`);
	if (!RENDER_VERSIONS.includes(v.render as RenderVersion)) fail(`${path}.render`, "expected render version 1 or 2");
	if (!Array.isArray(v.points) || v.points.length === 0) fail(`${path}.points`, "expected at least one point");
	const points = v.points.map((pt, i) => readPoint(pt, `${path}.points[${i}]`));
	let render = v.render as RenderVersion;
	// v20: the new pens have no outline of the old geometry. Read leniently the stroke is drawn with the geometry it needs (counted).
	if (isNewPen(tool) && render !== RENDER_INK) {
		if (!drop) fail(`${path}.render`, `tool '${tool}' needs render version 2`);
		drop.count++;
		render = RENDER_INK;
	}
	let hidden: true | undefined;
	if (v.hidden !== undefined) {
		// v8 invisible ink. Anything but `true` is invalid: dropped and counted when reading leniently (the stroke shows).
		hidden = orDrop(drop, () => (v.hidden === true ? true : fail(`${path}.hidden`, "expected true")));
	}
	let slide: string | undefined;
	if (v.slide !== undefined && slides !== "ignore") {
		// v12: an invalid slide, or one that names no entry of the table, is dropped and counted when reading leniently (the ink stays).
		slide = orDrop(drop, () => {
			const ref = boundedId(v.slide, `${path}.slide`, SLIDE_ID_MAX);
			if (slides !== "any" && !slides.has(ref)) fail(`${path}.slide`, "names no entry of 'slides'");
			return ref;
		});
	}
	const stroke: Stroke = { id, tool, color: v.color, width, render, points };
	if (hidden) stroke.hidden = hidden;
	if (slide !== undefined) stroke.slide = slide;
	// v18: the group (a file of an older format has none of ours: an odd `group` key is ignored, as the migration drops it). A detail:
	// an invalid id is dropped and counted when reading leniently (the stroke is then simply not grouped).
	if (groups && v.group !== undefined) {
		const group = orDrop(drop, () => boundedId(v.group, `${path}.group`, GROUP_ID_MAX));
		if (group !== undefined) stroke.group = group;
	}
	// v20: the nib angle of a fountain pen or a marker (a file of an older format has none of ours: an odd `nib` key is ignored, as the
	// migration drops it). A detail: an invalid angle, or one on a tool that has no nib, is dropped and counted when reading leniently.
	if (pens && v.nib !== undefined) {
		const nib = orDrop(drop, () => {
			if (!isNibPen(tool)) fail(`${path}.nib`, `tool '${tool}' has no nib`);
			if (!isNibAngle(v.nib)) fail(`${path}.nib`, "expected a whole number of degrees in [0, 179]");
			return v.nib;
		});
		if (nib !== undefined) stroke.nib = nib;
	}
	// v22 (#37): the fill and the line style of a shape (a file of an older format has none of ours: odd keys are ignored, as the migration
	// drops them). Details: an invalid one, or one on a tool that is not the shape tool, is dropped and counted when reading leniently
	// (the shape is then drawn plain); strictly it fails, so a malformed one is never written.
	if (shapeStyle) {
		if (v.fill !== undefined) {
			const fill = orDrop(drop, () => {
				if (!isShapeTool(tool)) fail(`${path}.fill`, `tool '${tool}' cannot be filled`);
				if (typeof v.fill !== "string" || !COLOR_RE.test(v.fill)) fail(`${path}.fill`, "expected a #rrggbb colour");
				return v.fill;
			});
			if (fill !== undefined) stroke.fill = fill;
		}
		if (v.fillTint !== undefined) {
			const tint = orDrop(drop, () => {
				if (v.fillTint !== true) fail(`${path}.fillTint`, "expected true");
				if (stroke.fill === undefined) fail(`${path}.fillTint`, "needs a fill");
				return true as const;
			});
			if (tint) stroke.fillTint = tint;
		}
		if (v.dash !== undefined) {
			const dash = orDrop(drop, () => {
				if (!isShapeTool(tool)) fail(`${path}.dash`, `tool '${tool}' has no line style`);
				if (!isShapeDash(v.dash)) fail(`${path}.dash`, "expected 'dashed' or 'dotted'");
				return v.dash;
			});
			if (dash !== undefined) stroke.dash = dash;
		}
	}
	// v24 (#358): the opacity (a file of an older format has none of ours: an odd key is ignored, as the migration drops it).
	if (withOpacity) {
		const opacity = readOpacity(v, path, drop);
		if (opacity !== undefined) stroke.opacity = opacity;
	}
	// v25 (#351): the taper of the two ends (a file of an older format has none of ours: odd keys are ignored, as the migration drops them).
	if (withTaper) {
		for (const key of ["taperStart", "taperEnd"] as const) {
			if (v[key] === undefined) continue;
			// Details: a value outside [TAPER_MIN, TAPER_MAX], one that is not a number, or one on a stroke that cannot taper (not a line pen, or not
			// drawn by the wet-ink geometry) is dropped and counted when reading leniently (the end is then not tapered); strictly it fails.
			const value = orDrop(drop, () => {
				if (!canTaper(tool, render)) fail(`${path}.${key}`, `a stroke of tool '${tool}' with render ${render} cannot taper`);
				const raw = v[key];
				if (!isTaper(raw)) fail(`${path}.${key}`, `expected a number from ${TAPER_MIN} to ${TAPER_MAX}`);
				return raw;
			});
			if (value !== undefined) stroke[key] = value;
		}
	}
	return stroke;
}

/**
 * v24 (#358): the optional `opacity` of a stroke, an image or an area. Details: read leniently a number outside [OPACITY_MIN, OPACITY_MAX] is
 * clamped to it and a value that is not a number is dropped, each counted (the item is drawn as strongly as the file asked at most, or in full);
 * strictly either fails, so a malformed one is never written.
 */
function readOpacity(v: RawObject, path: string, drop: Dropped | null): number | undefined {
	if (v.opacity === undefined) return undefined;
	if (isOpacity(v.opacity)) return v.opacity;
	if (!drop) fail(`${path}.opacity`, `expected a number from ${OPACITY_MIN} to ${OPACITY_MAX}`);
	drop.count++;
	// Above 1 clamps to full strength, which is no key at all (the app never writes an opacity of 1; an exact 1 in a file stays valid and is read as it is).
	return normaliseOpacity(v.opacity);
}

/**
 * v18: the flags of an element (`ElementFlags`): the group, the lock and the time of the last lock decision. Details: an invalid one
 * is dropped and counted when reading leniently (the element is then not grouped, not locked, or has no time). A file of an older
 * format has none of ours (the migration drops odd keys), which `groups` false stands for when a page is read on its own.
 */
function readFlags(v: RawObject, el: PageElement, path: string, drop: Dropped | null, groups: boolean): PageElement {
	if (!groups) return el;
	if (v.group !== undefined) {
		const group = orDrop(drop, () => boundedId(v.group, `${path}.group`, GROUP_ID_MAX));
		if (group !== undefined) el.group = group;
	}
	if (readTrue(v.locked, `${path}.locked`, drop)) el.locked = true;
	const lockAt = orDrop(drop, () => {
		if (v.lockAt === undefined) return undefined;
		if (typeof v.lockAt !== "number" || !Number.isSafeInteger(v.lockAt) || v.lockAt < 0) fail(`${path}.lockAt`, "expected a time in ms");
		return v.lockAt;
	});
	if (lockAt !== undefined) el.lockAt = lockAt;
	return el;
}

/**
 * v12 slide references: an array of { id, source, page, path? }. Read leniently, an invalid entry (or one whose id is
 * already taken) is dropped and counted; strokes that refer to it then lose their `slide` (counted too).
 */
export function readSlides(v: unknown, drop: Dropped | null): SlideRef[] {
	if (v === undefined) return [];
	const all = orDrop(drop, () => (Array.isArray(v) ? (v as unknown[]) : fail("slides", "expected an array")));
	if (!all) return [];
	const out: SlideRef[] = [];
	const ids = new Set<string>();
	all.forEach((r, i) => {
		const ref = orDrop(drop, () => {
			const at = `slides[${i}]`;
			const read = readSlideRef(r, at);
			if (ids.has(read.id)) fail(`${at}.id`, "duplicate id");
			return read;
		});
		if (!ref) return;
		ids.add(ref.id);
		out.push(Object.freeze(ref));
	});
	return out;
}

function readSlideRef(v: unknown, path: string): SlideRef {
	if (!isObject(v)) fail(path, "expected an object");
	const id = boundedId(v.id, `${path}.id`, SLIDE_ID_MAX);
	const source = boundedId(v.source, `${path}.source`, SLIDE_SOURCE_MAX);
	if (typeof v.page !== "number" || !Number.isSafeInteger(v.page) || v.page < 1) fail(`${path}.page`, "expected an integer >= 1");
	const ref: SlideRef = { id, source, page: v.page };
	if (v.path !== undefined) ref.path = boundedId(v.path, `${path}.path`, SLIDE_PATH_MAX);
	return ref;
}

/**
 * v21 saved views: an array of { id, name, page, x, y, width, height, zoom }. Read leniently, an invalid entry (a repeated id, an
 * unusable region or zoom, an entry past the limit) is dropped and counted, and a name that is not in its stored form (untrimmed, with a
 * line break) is kept in that form and counted; the other views stay. A view that names a page the notebook does not have is valid (it
 * is shown as missing). Strict (`drop` null): any of those fails.
 */
export function readViews(v: unknown, drop: Dropped | null): SavedView[] {
	if (v === undefined) return [];
	const all = orDrop(drop, () => (Array.isArray(v) ? (v as unknown[]) : fail("views", "expected an array")));
	if (!all) return [];
	const out: SavedView[] = [];
	const ids = new Set<string>();
	all.forEach((r, i) => {
		const at = `views[${i}]`;
		if (out.length >= VIEWS_MAX) {
			if (!drop) fail("views", `more than ${VIEWS_MAX} views`);
			drop.count++;
			return;
		}
		const view = orDrop(drop, () => {
			const read = readView(r, at, drop);
			if (ids.has(read.id)) fail(`${at}.id`, "duplicate id");
			return read;
		});
		if (!view) return;
		ids.add(view.id);
		out.push(view);
	});
	return out;
}

function readView(v: unknown, path: string, drop: Dropped | null): SavedView {
	if (!isObject(v)) fail(path, "expected an object");
	const id = boundedId(v.id, `${path}.id`, VIEW_ID_MAX);
	if (typeof v.name !== "string") fail(`${path}.name`, "expected a string");
	let name = v.name;
	if (!isStoredViewName(name)) {
		const kept = drop ? normalizeViewName(name) : "";
		if (kept === "") fail(`${path}.name`, "expected a name of 1 to 80 characters, trimmed, on one line");
		name = kept;
		if (drop) drop.count++;
	}
	const page = boundedId(v.page, `${path}.page`, VIEW_PAGE_ID_MAX);
	const region = { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), width: finite(v.width, `${path}.width`), height: finite(v.height, `${path}.height`), zoom: finite(v.zoom, `${path}.zoom`) };
	if (!validRegion(region)) fail(path, "region or zoom out of range");
	return Object.freeze({ id, name, page, ...region });
}

/** v13: a number of a pose, finite and within `[lo, hi]`. */
function poseNumber(v: unknown, path: string, lo: number, hi: number): number {
	const n = finite(v, path);
	if (n < lo || n > hi) fail(path, `expected a number from ${lo} to ${hi}`);
	return n;
}

/**
 * v13 states of one page (#241): { parts: [{ id, name?, pivot, items }], list: [{ id, name, poses }], active? }. `strokeIds`:
 * the ids of the strokes read on the page, which the items must name. Read leniently (`drop` set), whatever is invalid is
 * dropped and counted on its own: an item that names no stroke of the page or one already in another part, a part
 * left without items, a pose of an unknown part or with a bad number, an invalid state, an `active` that names no
 * state; the drawing and the rest of the states stay. Strict (`drop` null): any of those fails. Undefined when nothing is left.
 */
export function readPageStates(v: unknown, path: string, strokeIds: ReadonlySet<string>, drop: Dropped | null): PageStates | undefined {
	if (v === undefined) return undefined;
	const root = orDrop(drop, () => (isObject(v) ? v : fail(path, "expected an object")));
	if (!root) return undefined;
	const listOf = (x: unknown, at: string): unknown[] => orDrop(drop, () => (Array.isArray(x) ? (x as unknown[]) : fail(at, "expected an array"))) ?? [];
	const parts: StatePart[] = [];
	const partIds = new Set<string>();
	const claimed = new Set<string>();
	listOf(root.parts, `${path}.parts`).forEach((raw, i) => {
		const at = `${path}.parts[${i}]`;
		const part = orDrop(drop, () => {
			if (!isObject(raw)) fail(at, "expected an object");
			if (parts.length >= STATES_MAX_PARTS) fail(at, `more than ${STATES_MAX_PARTS} parts`);
			const id = boundedId(raw.id, `${at}.id`, STATES_ID_MAX);
			if (partIds.has(id)) fail(`${at}.id`, "duplicate id");
			const out: StatePart = { id, pivot: [0, 0], items: [] };
			if (raw.name !== undefined) {
				if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > STATES_NAME_MAX) fail(`${at}.name`, `expected 1 to ${STATES_NAME_MAX} characters`);
				out.name = raw.name;
			}
			const pivot = raw.pivot;
			if (!Array.isArray(pivot) || pivot.length !== 2) fail(`${at}.pivot`, "expected [x, y]");
			out.pivot = [poseNumber(pivot[0], `${at}.pivot[0]`, -1e6, 1e6), poseNumber(pivot[1], `${at}.pivot[1]`, -1e6, 1e6)];
			if (!Array.isArray(raw.items)) fail(`${at}.items`, "expected an array");
			raw.items.forEach((item, k) => {
				const kept = orDrop(drop, () => {
					const sid = str(item, `${at}.items[${k}]`);
					if (!strokeIds.has(sid)) fail(`${at}.items[${k}]`, "names no stroke of the page");
					if (claimed.has(sid)) fail(`${at}.items[${k}]`, "already in a part");
					if (out.items.length >= STATES_MAX_ITEMS) fail(`${at}.items[${k}]`, `more than ${STATES_MAX_ITEMS} items`);
					return sid;
				});
				if (kept === undefined) return;
				claimed.add(kept);
				out.items.push(kept);
			});
			if (out.items.length === 0) fail(`${at}.items`, "a part needs at least one stroke");
			return out;
		});
		if (!part) return;
		partIds.add(part.id);
		parts.push(part);
	});
	const list: PageState[] = [];
	const stateIds = new Set<string>();
	listOf(root.list, `${path}.list`).forEach((raw, i) => {
		const at = `${path}.list[${i}]`;
		const state = orDrop(drop, () => {
			if (!isObject(raw)) fail(at, "expected an object");
			if (list.length >= STATES_MAX_STATES) fail(at, `more than ${STATES_MAX_STATES} states`);
			const id = boundedId(raw.id, `${at}.id`, STATES_ID_MAX);
			if (stateIds.has(id)) fail(`${at}.id`, "duplicate id");
			if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > STATES_NAME_MAX) fail(`${at}.name`, `expected 1 to ${STATES_NAME_MAX} characters`);
			const poses: PartPose[] = [];
			const seen = new Set<string>();
			listOf(raw.poses, `${at}.poses`).forEach((p, k) => {
				const pose = orDrop(drop, () => {
					const pat = `${at}.poses[${k}]`;
					if (!isObject(p)) fail(pat, "expected an object");
					const part = str(p.part, `${pat}.part`);
					if (!partIds.has(part)) fail(`${pat}.part`, "names no part");
					if (seen.has(part)) fail(`${pat}.part`, "two poses for one part");
					const out: PartPose = { part };
					if (p.dx !== undefined) out.dx = poseNumber(p.dx, `${pat}.dx`, -STATES_MAX_SHIFT, STATES_MAX_SHIFT);
					if (p.dy !== undefined) out.dy = poseNumber(p.dy, `${pat}.dy`, -STATES_MAX_SHIFT, STATES_MAX_SHIFT);
					if (p.rot !== undefined) out.rot = poseNumber(p.rot, `${pat}.rot`, -STATES_MAX_ROT, STATES_MAX_ROT);
					if (p.scale !== undefined) out.scale = poseNumber(p.scale, `${pat}.scale`, STATES_MIN_SCALE, STATES_MAX_SCALE);
					if (p.hidden !== undefined) {
						if (p.hidden !== true) fail(`${pat}.hidden`, "expected true");
						out.hidden = true;
					}
					if (p.color !== undefined) {
						if (typeof p.color !== "string" || !STATE_COLOR_RE.test(p.color)) fail(`${pat}.color`, "expected a #rrggbb colour");
						out.color = p.color;
					}
					return out;
				});
				if (!pose) return;
				seen.add(pose.part);
				poses.push(Object.freeze(pose));
			});
			return { id, name: raw.name, poses: Object.freeze(poses) as PartPose[] };
		});
		if (!state) return;
		stateIds.add(state.id);
		list.push(Object.freeze(state));
	});
	let active: string | undefined;
	if (root.active !== undefined) {
		active = orDrop(drop, () => {
			const id = str(root.active, `${path}.active`);
			if (!stateIds.has(id)) fail(`${path}.active`, "names no state");
			return id;
		});
	}
	if (parts.length === 0 && list.length === 0) return undefined;
	const states: PageStates = { parts: parts.map((p) => Object.freeze({ ...p, pivot: Object.freeze([...p.pivot]) as [number, number], items: Object.freeze([...p.items]) as string[] })), list: Object.freeze(list) as PageState[] };
	if (active !== undefined) states.active = active;
	return Object.freeze(states);
}

type Assets = Readonly<Record<string, Asset>>;

function readAsset(v: unknown, key: string, path: string): Asset {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (!HEX_RE.test(id)) fail(`${path}.id`, "expected lowercase hexadecimal");
	if (id !== key) fail(path, "key does not match the asset id");
	if (v.kind !== "pdf" && v.kind !== "image") fail(`${path}.kind`, "unknown asset kind");
	const assetPath = str(v.path, `${path}.path`);
	if (typeof v.name !== "string") fail(`${path}.name`, "expected a string");
	if (typeof v.bytes !== "number" || !Number.isSafeInteger(v.bytes) || v.bytes < 0) {
		fail(`${path}.bytes`, "expected a non-negative integer");
	}
	return { id, kind: v.kind, path: assetPath, name: v.name, bytes: v.bytes };
}

function requireAsset(assets: Assets, id: string, kind: AssetKind, path: string): void {
	const a = Object.prototype.hasOwnProperty.call(assets, id) ? assets[id] : undefined;
	if (!a) fail(path, "refers to an asset that does not exist");
	if (a.kind !== kind) fail(path, `expected a ${kind} asset, found ${a.kind}`);
}

function readBackground(v: unknown, path: string, assets: Assets, drop: Dropped | null = null, withPdfView = true): PageBackground {
	if (!isObject(v)) fail(path, "expected an object");
	const asset = str(v.asset, `${path}.asset`);
	if (v.kind === "pdf") {
		if (typeof v.page !== "number" || !Number.isSafeInteger(v.page) || v.page < 1) {
			fail(`${path}.page`, "expected an integer >= 1");
		}
		requireAsset(assets, asset, "pdf", `${path}.asset`);
		const bg: PageBackground = { kind: "pdf", asset, page: v.page };
		// v26 (#76): the turn and the crop (a file of an older format has none of ours: odd keys are ignored, as the migration drops them).
		// Details: read leniently, an invalid one (a turn that is not 90, 180 or 270; a crop that is not four finite numbers, with sides of at least
		// PDF_CROP_MIN_SIDE pt and nothing negative or beyond PDF_CROP_MAX) is dropped and counted (the page shows that much of the PDF as before);
		// strictly it fails, so a malformed one is never written. A crop is NOT checked against the PDF page (its size is not in the file): the
		// renderers clamp it (see `effectiveCrop`).
		if (withPdfView) {
			if (v.rotate !== undefined) {
				const rotate = orDrop(drop, () => {
					if (!isPdfRotation(v.rotate)) fail(`${path}.rotate`, "expected 90, 180 or 270");
					return v.rotate;
				});
				if (rotate !== undefined) bg.rotate = rotate;
			}
			if (v.crop !== undefined) {
				const crop = orDrop(drop, () => {
					if (!isPdfCrop(v.crop)) fail(`${path}.crop`, `expected {x, y, width, height} in pt (x, y from 0; sides from ${PDF_CROP_MIN_SIDE}; at most ${PDF_CROP_MAX})`);
					return { x: v.crop.x, y: v.crop.y, width: v.crop.width, height: v.crop.height };
				});
				if (crop !== undefined) bg.crop = crop;
			}
		}
		return bg;
	}
	if (v.kind === "image") {
		requireAsset(assets, asset, "image", `${path}.asset`);
		return { kind: "image", asset };
	}
	return fail(`${path}.kind`, "unknown background kind");
}

/** v6 margins: non-negative, and the background box they leave keeps a positive size. */
function readMargins(v: unknown, path: string, width: number, height: number): PageMargins {
	if (!isObject(v)) fail(path, "expected an object");
	const side = (x: unknown, name: string): number => {
		const n = finite(x, `${path}.${name}`);
		if (n < 0) fail(`${path}.${name}`, "must not be negative");
		return n;
	};
	const left = side(v.left, "left");
	const right = side(v.right, "right");
	const bottom = side(v.bottom, "bottom");
	if (left + right >= width) fail(path, "left + right must be smaller than the page width");
	if (bottom >= height) fail(`${path}.bottom`, "must be smaller than the page height");
	return { left, right, bottom };
}

function readElement(v: unknown, path: string, assets: Assets, drop: Dropped | null = null, groups = true, withOpacity = true): PageElement {
	const el = readTypedElement(v, path, assets, drop, withOpacity);
	return isObject(v) ? readFlags(v, el, path, drop, groups) : el;
}

function readTypedElement(v: unknown, path: string, assets: Assets, drop: Dropped | null, withOpacity = true): PageElement {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (v.type === "text") {
		if (typeof v.text !== "string") fail(`${path}.text`, "expected a string");
		const fontSize = positive(v.fontSize, `${path}.fontSize`);
		if (fontSize > MAX_FONT_SIZE) fail(`${path}.fontSize`, `must be at most ${MAX_FONT_SIZE} pt`);
		const el: TextElement = {
			id, type: "text",
			x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
			width: positive(v.width, `${path}.width`),
			text: v.text, fontSize, color: colour(v.color, `${path}.color`),
		};
		return el;
	}
	if (v.type === "image") {
		const asset = str(v.asset, `${path}.asset`);
		requireAsset(assets, asset, "image", `${path}.asset`);
		const el: ImageElement = {
			id, type: "image", asset,
			x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
			width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`),
			rotation: finite(v.rotation, `${path}.rotation`),
		};
		// v24 (#358): how strongly the picture is drawn (a file of an older format has none of ours).
		const opacity = withOpacity ? readOpacity(v, path, drop) : undefined;
		if (opacity !== undefined) el.opacity = opacity;
		return el;
	}
	if (v.type === "marker") return readMarker(v, id, path, drop);
	if (v.type === "box") return readBox(v, id, path, drop);
	if (v.type === "equation") return readEquation(v, id, path, drop);
	if (v.type === "graph") return readGraph(v, id, path, drop);
	if (v.type === "excerpt") return readExcerpt(v, id, path, assets, drop);
	if (v.type === "sticky") return readSticky(v, id, path, drop);
	if (v.type === "checkbox") return readCheckbox(v, id, path, drop);
	if (v.type === "area") return readArea(v, id, path, drop, withOpacity);
	if (v.type === "tape") return readTape(v, id, path);
	return fail(`${path}.type`, "unknown element type");
}

/**
 * v27 study tape. The rectangle (finite corner, each side within TAPE_MIN_SIDE..TAPE_MAX_SIDE) and the colour are required: a tape with an
 * invalid one cannot hide anything, so it fails as a whole (the caller drops and counts it when reading leniently, see ELEMENT_TYPES_V27).
 * Nothing else is read: a stray `revealed` or `opacity` key is ignored (the reveal is view-only, a tape is always opaque).
 */
function readTape(v: RawObject, id: string, path: string): TapeElement {
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	if (width < TAPE_MIN_SIDE || width > TAPE_MAX_SIDE) fail(`${path}.width`, `expected ${TAPE_MIN_SIDE} to ${TAPE_MAX_SIDE} pt`);
	if (height < TAPE_MIN_SIDE || height > TAPE_MAX_SIDE) fail(`${path}.height`, `expected ${TAPE_MIN_SIDE} to ${TAPE_MAX_SIDE} pt`);
	return { id, type: "tape", x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), width, height, color: colour(v.color, `${path}.color`) };
}

/**
 * One line of text (a marker label, a box title): any string, normalised; an invalid one is dropped and counted when
 * lenient. A label that normalising changes (extra spaces, line breaks, longer than the limit, blank) is not what this
 * plugin writes: read leniently it is kept normalised and counted as dropped (so the repair notice tells the user that
 * something changed); read strictly it fails.
 */
function readLabel(v: unknown, path: string, drop: Dropped | null): string | undefined {
	return orDrop(drop, () => {
		if (v === undefined) return undefined;
		if (typeof v !== "string") fail(path, "expected a string");
		const clean = cleanMarkerText(v);
		if (clean !== v) {
			if (!drop) fail(path, "not a normalised label");
			drop.count++;
		}
		return clean;
	});
}

/**
 * v8 marker. Kind and position are required (an invalid one fails the marker); the region, time, state, slide,
 * due date and label are optional details, each dropped and counted on its own when invalid and reading leniently.
 */
function readMarker(v: RawObject, id: string, path: string, drop: Dropped | null): MarkerElement {
	if (!isMarkerKind(v.kind)) fail(`${path}.kind`, "unknown marker kind");
	const el: MarkerElement = { id, type: "marker", kind: v.kind, x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`) };
	if (v.width !== undefined || v.height !== undefined) {
		const r = orDrop(drop, () => ({ width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`) }));
		if (r) {
			el.width = r.width;
			el.height = r.height;
		}
	}
	const at = orDrop(drop, () => (v.at === undefined ? undefined : str(v.at, `${path}.at`)));
	if (at !== undefined) el.at = at;
	const done = orDrop(drop, () => (v.done === undefined ? undefined : v.done === true ? true : fail(`${path}.done`, "expected true")));
	if (done) el.done = done;
	const slide = orDrop(drop, () => {
		if (v.slide === undefined) return undefined;
		if (typeof v.slide !== "number" || !Number.isSafeInteger(v.slide) || v.slide < 1) fail(`${path}.slide`, "expected an integer >= 1");
		return v.slide;
	});
	if (slide !== undefined) el.slide = slide;
	const due = orDrop(drop, () => {
		if (v.due === undefined) return undefined;
		if (!isIsoDate(v.due)) fail(`${path}.due`, "expected a YYYY-MM-DD date");
		return v.due;
	});
	if (due !== undefined) el.due = due;
	const text = readLabel(v.text, `${path}.text`, drop);
	if (text !== undefined) el.text = text;
	return el;
}

/** v8 structured box: kind and frame are required, the title is optional. */
function readBox(v: RawObject, id: string, path: string, drop: Dropped | null): BoxElement {
	if (!isBoxKind(v.kind)) fail(`${path}.kind`, "unknown box kind");
	const el: BoxElement = {
		id, type: "box", kind: v.kind,
		x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
		width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`),
	};
	const title = readLabel(v.title, `${path}.title`, drop);
	if (title !== undefined) el.title = title;
	return el;
}

/** `true` or absent; anything else is invalid (dropped and counted when lenient). */
function readTrue(v: unknown, path: string, drop: Dropped | null): true | undefined {
	return orDrop(drop, () => (v === undefined ? undefined : v === true ? true : fail(path, "expected true")));
}

/** A string of at most `max` characters (an expression may be empty while it is being written). */
function boundedString(v: unknown, path: string, max: number): string {
	if (typeof v !== "string") fail(path, "expected a string");
	if (v.length > max) fail(path, `longer than ${max} characters`);
	return v;
}

/**
 * v9 equation. Frame, source, size and colour are required (an invalid one fails the equation); the style flags and
 * the cached outline are optional details, each dropped and counted on its own when invalid and reading leniently.
 */
function readEquation(v: RawObject, id: string, path: string, drop: Dropped | null): EquationElement {
	const latex = boundedString(v.latex, `${path}.latex`, EQUATION_LATEX_MAX);
	if (latex.trim().length === 0) fail(`${path}.latex`, "expected some LaTeX");
	const fontSize = positive(v.fontSize, `${path}.fontSize`);
	if (fontSize > MAX_FONT_SIZE) fail(`${path}.fontSize`, `must be at most ${MAX_FONT_SIZE} pt`);
	const el: EquationElement = {
		id, type: "equation",
		x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
		width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`),
		latex, fontSize, color: colour(v.color, `${path}.color`),
	};
	const inline = readTrue(v.inline, `${path}.inline`, drop);
	if (inline) el.inline = inline;
	const numbered = readTrue(v.numbered, `${path}.numbered`, drop);
	if (numbered) el.numbered = numbered;
	const outline = orDrop(drop, () => {
		if (v.outline === undefined) return undefined;
		const d = boundedString(v.outline, `${path}.outline`, EQUATION_OUTLINE_MAX);
		if (parseOutline(d) === null) fail(`${path}.outline`, "expected an outline path (M, L, Z)");
		return d;
	});
	if (outline !== undefined) el.outline = outline;
	return el;
}

/** A non-empty string of at most `max` characters. */
function boundedId(v: unknown, path: string, max: number): string {
	const s = str(v, path);
	if (s.length > max) fail(path, `longer than ${max} characters`);
	return s;
}

/**
 * v10 excerpt. The target frame and the source (notebook path, document id, page id, region) are required (an invalid
 * one fails the excerpt); the snapshot asset is optional, dropped and counted on its own when invalid and reading
 * leniently (the excerpt then draws live or as a placeholder). The source region is not checked against any page: its
 * page may be in another notebook, or have been resized since.
 */
function readExcerpt(v: RawObject, id: string, path: string, assets: Assets, drop: Dropped | null): ExcerptElement {
	const raw = v.source;
	if (!isObject(raw)) fail(`${path}.source`, "expected an object");
	const at = `${path}.source`;
	const source: ExcerptSource = {
		notebook: boundedId(raw.notebook, `${at}.notebook`, EXCERPT_PATH_MAX),
		doc: boundedId(raw.doc, `${at}.doc`, EXCERPT_ID_MAX),
		page: boundedId(raw.page, `${at}.page`, EXCERPT_ID_MAX),
		x: finite(raw.x, `${at}.x`), y: finite(raw.y, `${at}.y`),
		width: positive(raw.width, `${at}.width`), height: positive(raw.height, `${at}.height`),
	};
	const el: ExcerptElement = {
		id, type: "excerpt",
		x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
		width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`),
		source,
	};
	const asset = orDrop(drop, () => {
		if (v.asset === undefined) return undefined;
		const a = str(v.asset, `${path}.asset`);
		requireAsset(assets, a, "image", `${path}.asset`);
		return a;
	});
	if (asset !== undefined) el.asset = asset;
	return el;
}

/**
 * v15 sticky note. Frame (within STICKY_MIN_SIZE..STICKY_MAX_SIZE), colour and size are required (an invalid one fails the
 * note); the text, the collapsed flag and the hidden-ink list are details, each dropped and counted on its own when invalid and
 * reading leniently (the note then has no text, is open, or keeps no ink hidden). The ink list only means something while collapsed.
 */
function readSticky(v: RawObject, id: string, path: string, drop: Dropped | null): StickyElement {
	const side = (x: unknown, name: string): number => {
		const n = positive(x, `${path}.${name}`);
		if (n < STICKY_MIN_SIZE || n > STICKY_MAX_SIZE) fail(`${path}.${name}`, `expected ${STICKY_MIN_SIZE} to ${STICKY_MAX_SIZE} pt`);
		return n;
	};
	const fontSize = positive(v.fontSize, `${path}.fontSize`);
	if (fontSize < STICKY_MIN_FONT || fontSize > STICKY_MAX_FONT) fail(`${path}.fontSize`, `expected ${STICKY_MIN_FONT} to ${STICKY_MAX_FONT} pt`);
	const el: StickyElement = {
		id, type: "sticky",
		x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
		width: side(v.width, "width"), height: side(v.height, "height"),
		color: colour(v.color, `${path}.color`), fontSize,
	};
	const text = orDrop(drop, () => {
		if (v.text === undefined) return undefined;
		const s = boundedString(v.text, `${path}.text`, STICKY_TEXT_MAX * 2);
		if (Array.from(s).length > STICKY_TEXT_MAX) fail(`${path}.text`, `longer than ${STICKY_TEXT_MAX} characters`);
		return s;
	});
	if (text !== undefined && text !== "") el.text = text;
	const collapsed = readTrue(v.collapsed, `${path}.collapsed`, drop);
	if (collapsed) {
		el.collapsed = true;
		const ink = orDrop(drop, () => {
			if (v.ink === undefined) return undefined;
			if (!Array.isArray(v.ink) || v.ink.length > STICKY_INK_MAX) fail(`${path}.ink`, `expected a list of at most ${STICKY_INK_MAX} stroke ids`);
			return v.ink.map((s, i) => str(s, `${path}.ink[${i}]`));
		});
		if (ink !== undefined && ink.length > 0) el.ink = [...new Set(ink)];
	} else if (v.ink !== undefined) {
		// An open note keeps no list (a stray one is ignored; leniently it is counted so the notice says something changed).
		if (!drop) fail(`${path}.ink`, "only a collapsed note has an ink list");
		drop.count++;
	}
	return el;
}

/**
 * v17 checkbox. Position, size (within CHECKBOX_MIN_SIZE..CHECKBOX_MAX_SIZE) and colour are required (an invalid one fails the
 * checkbox); the tick, the time of the toggle, the label and the task link are details, each dropped and counted on its own when
 * invalid and reading leniently (the checkbox is then open, was never toggled, has no label, or is not linked). A label that
 * normalising changes is not what this plugin writes: leniently it is kept normalised and counted, strictly it fails.
 */
function readCheckbox(v: RawObject, id: string, path: string, drop: Dropped | null): CheckboxElement {
	const size = positive(v.size, `${path}.size`);
	if (size < CHECKBOX_MIN_SIZE || size > CHECKBOX_MAX_SIZE) fail(`${path}.size`, `expected ${CHECKBOX_MIN_SIZE} to ${CHECKBOX_MAX_SIZE} pt`);
	const el: CheckboxElement = { id, type: "checkbox", x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), size, color: colour(v.color, `${path}.color`) };
	if (readTrue(v.checked, `${path}.checked`, drop)) el.checked = true;
	const at = orDrop(drop, () => {
		if (v.at === undefined) return undefined;
		if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0) fail(`${path}.at`, "expected a time in ms");
		return v.at;
	});
	if (at !== undefined) el.at = at;
	const taskAt = orDrop(drop, () => {
		if (v.taskAt === undefined) return undefined;
		if (typeof v.taskAt !== "number" || !Number.isSafeInteger(v.taskAt) || v.taskAt < 0) fail(`${path}.taskAt`, "expected a time in ms");
		return v.taskAt;
	});
	if (taskAt !== undefined) el.taskAt = taskAt;
	const label = orDrop(drop, () => {
		if (v.label === undefined) return undefined;
		const s = boundedString(v.label, `${path}.label`, CHECKBOX_LABEL_MAX * 4);
		const clean = cleanCheckboxLabel(s);
		if (clean !== s) {
			if (!drop) fail(`${path}.label`, "not a normalised label");
			drop.count++;
		}
		return clean;
	});
	if (label !== undefined && label !== "") el.label = label;
	const task = orDrop(drop, () => {
		if (v.task === undefined) return undefined;
		if (!isObject(v.task)) fail(`${path}.task`, "expected an object");
		const taskPath = boundedString(v.task.path, `${path}.task.path`, CHECKBOX_PATH_MAX);
		if (taskPath === "" || Array.from(taskPath).some((ch) => ch.charCodeAt(0) < 32)) fail(`${path}.task.path`, "expected a note path");
		const block = boundedString(v.task.block, `${path}.task.block`, CHECKBOX_BLOCK_MAX);
		if (!isOurBlockId(block)) fail(`${path}.task.block`, "expected a block id written by this plugin (nb-…)");
		return { path: taskPath, block };
	});
	if (task !== undefined) el.task = task;
	return el;
}

/**
 * v23 area highlighter. The rectangle (each side within AREA_MIN_SIDE..AREA_MAX_SIDE) and the colour are required: an area with an invalid one
 * is not drawn at all, so it fails as a whole (the caller drops and counts it when reading leniently, see ELEMENT_TYPES_V23).
 */
function readArea(v: RawObject, id: string, path: string, drop: Dropped | null = null, withOpacity = true): AreaElement {
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	if (width < AREA_MIN_SIDE || width > AREA_MAX_SIDE) fail(`${path}.width`, `expected ${AREA_MIN_SIDE} to ${AREA_MAX_SIDE} pt`);
	if (height < AREA_MIN_SIDE || height > AREA_MAX_SIDE) fail(`${path}.height`, `expected ${AREA_MIN_SIDE} to ${AREA_MAX_SIDE} pt`);
	const el: AreaElement = { id, type: "area", x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), width, height, color: colour(v.color, `${path}.color`) };
	// v24 (#358): the opacity is a detail of the area (read leniently it is clamped or dropped and counted; the area stays).
	const opacity = withOpacity ? readOpacity(v, path, drop) : undefined;
	if (opacity !== undefined) el.opacity = opacity;
	return el;
}

function readViewport(v: unknown, path: string): GraphViewport {
	if (!isObject(v)) fail(path, "expected an object");
	const view: GraphViewport = {
		xMin: finite(v.xMin, `${path}.xMin`), xMax: finite(v.xMax, `${path}.xMax`),
		yMin: finite(v.yMin, `${path}.yMin`), yMax: finite(v.yMax, `${path}.yMax`),
	};
	if (!isViewport(view)) fail(path, "expected xMin < xMax and yMin < yMax within the supported range");
	return view;
}

/** One graphed function: kind, colour and the expressions of its kind are required; options are details. */
function readGraphFunction(v: unknown, path: string, drop: Dropped | null): GraphFunction {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (id.length > GRAPH_ID_MAX) fail(`${path}.id`, `longer than ${GRAPH_ID_MAX} characters`);
	if (!isGraphFunctionKind(v.kind)) fail(`${path}.kind`, "unknown function kind");
	const f: GraphFunction = { id, kind: v.kind, color: colour(v.color, `${path}.color`) };
	if (v.kind === "parametric") {
		f.x = boundedString(v.x, `${path}.x`, GRAPH_EXPR_MAX);
		f.y = boundedString(v.y, `${path}.y`, GRAPH_EXPR_MAX);
	} else if (v.kind === "piecewise") {
		if (!Array.isArray(v.pieces) || v.pieces.length === 0 || v.pieces.length > GRAPH_MAX_PIECES) {
			fail(`${path}.pieces`, `expected 1 to ${GRAPH_MAX_PIECES} pieces`);
		}
		f.pieces = v.pieces.map((p, i): GraphPiece => {
			const at = `${path}.pieces[${i}]`;
			if (!isObject(p)) fail(at, "expected an object");
			const piece: GraphPiece = { expr: boundedString(p.expr, `${at}.expr`, GRAPH_EXPR_MAX) };
			if (p.when !== undefined) piece.when = boundedString(p.when, `${at}.when`, GRAPH_EXPR_MAX);
			return piece;
		});
	} else f.expr = boundedString(v.expr, `${path}.expr`, GRAPH_EXPR_MAX);
	if (v.min !== undefined || v.max !== undefined) {
		const r = orDrop(drop, () => {
			const min = finite(v.min, `${path}.min`);
			const max = finite(v.max, `${path}.max`);
			if (!(min < max)) fail(`${path}.max`, "must be greater than min");
			return { min, max };
		});
		if (r) {
			f.min = r.min;
			f.max = r.max;
		}
	}
	const width = orDrop(drop, () => {
		if (v.width === undefined) return undefined;
		const w = positive(v.width, `${path}.width`);
		if (w > GRAPH_MAX_LINE_WIDTH) fail(`${path}.width`, `must be at most ${GRAPH_MAX_LINE_WIDTH} pt`);
		return w;
	});
	if (width !== undefined) f.width = width;
	for (const key of ["hidden", "roots", "extrema", "intersections"] as const) {
		const flag = readTrue(v[key], `${path}.${key}`, drop);
		if (flag) f[key] = flag;
	}
	const tangent = orDrop(drop, () => (v.tangent === undefined ? undefined : finite(v.tangent, `${path}.tangent`)));
	if (tangent !== undefined) f.tangent = tangent;
	const area = orDrop(drop, () => {
		if (v.area === undefined) return undefined;
		const a = v.area;
		if (!isObject(a)) fail(`${path}.area`, "expected an object");
		const from = finite(a.from, `${path}.area.from`);
		const to = finite(a.to, `${path}.area.to`);
		if (from === to) fail(`${path}.area`, "expected two different ends");
		return { from, to };
	});
	if (area !== undefined) f.area = area;
	const label = orDrop(drop, () => {
		if (v.label === undefined) return undefined;
		if (typeof v.label !== "string") fail(`${path}.label`, "expected a string");
		return cleanGraphLabel(v.label);
	});
	if (label !== undefined) f.label = label;
	return f;
}

function readGraphParam(v: unknown, path: string, drop: Dropped | null): GraphParam {
	if (!isObject(v)) fail(path, "expected an object");
	if (!isParamName(v.name)) fail(`${path}.name`, "expected a parameter name that is not a function or a variable");
	const p: GraphParam = { name: v.name, value: finite(v.value, `${path}.value`), min: finite(v.min, `${path}.min`), max: finite(v.max, `${path}.max`) };
	if (!(p.min < p.max)) fail(`${path}.max`, "must be greater than min");
	const step = orDrop(drop, () => (v.step === undefined ? undefined : positive(v.step, `${path}.step`)));
	if (step !== undefined) p.step = step;
	return p;
}

/**
 * A side of a graph's frame: positive, at most GRAPH_MAX_SIDE. A larger one is clamped and counted when reading
 * leniently (it would make the sampling unbounded), refused when strict.
 */
function graphSide(v: unknown, path: string, drop: Dropped | null): number {
	const n = positive(v, path);
	if (n <= GRAPH_MAX_SIDE) return n;
	if (!drop) fail(path, `must be at most ${GRAPH_MAX_SIDE} pt`);
	drop.count++;
	return GRAPH_MAX_SIDE;
}

/**
 * v9 graph. Frame, viewport and the function list are required (an invalid one fails the graph); each function,
 * parameter and setting is a detail, dropped and counted on its own when invalid and reading leniently. An expression
 * that does not parse is not a format error (the graph shows the message).
 */
function readGraph(v: RawObject, id: string, path: string, drop: Dropped | null): GraphElement {
	const g: GraphElement = {
		id, type: "graph",
		x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
		width: graphSide(v.width, `${path}.width`, drop), height: graphSide(v.height, `${path}.height`, drop),
		view: readViewport(v.view, `${path}.view`),
		functions: [],
	};
	if (!Array.isArray(v.functions)) fail(`${path}.functions`, "expected an array");
	const fnIds = new Set<string>();
	v.functions.forEach((raw, i) => {
		const at = `${path}.functions[${i}]`;
		const f = orDrop(drop, () => {
			if (i >= GRAPH_MAX_FUNCTIONS) fail(at, `at most ${GRAPH_MAX_FUNCTIONS} functions`);
			const fn = readGraphFunction(raw, at, drop);
			if (fnIds.has(fn.id)) fail(`${at}.id`, "duplicate function id");
			return fn;
		});
		if (!f) return;
		fnIds.add(f.id);
		g.functions.push(f);
	});
	if (v.params !== undefined) {
		const list = v.params;
		const params = orDrop(drop, () => {
			if (!Array.isArray(list)) fail(`${path}.params`, "expected an array");
			const out: GraphParam[] = [];
			const names = new Set<string>();
			list.forEach((raw, i) => {
				const at = `${path}.params[${i}]`;
				const p = orDrop(drop, () => {
					if (i >= GRAPH_MAX_PARAMS) fail(at, `at most ${GRAPH_MAX_PARAMS} parameters`);
					const param = readGraphParam(raw, at, drop);
					if (names.has(param.name)) fail(`${at}.name`, "duplicate parameter");
					return param;
				});
				if (!p) return;
				names.add(p.name);
				out.push(p);
			});
			return out;
		});
		if (params) g.params = params;
	}
	for (const key of ["axes", "grid"] as const) {
		const off = orDrop(drop, () => (v[key] === undefined ? undefined : v[key] === false ? false as const : fail(`${path}.${key}`, "expected false")));
		if (off === false) g[key] = false;
	}
	for (const key of ["xStep", "yStep"] as const) {
		const step = orDrop(drop, () => (v[key] === undefined ? undefined : positive(v[key], `${path}.${key}`)));
		if (step !== undefined) g[key] = step;
	}
	for (const key of ["xLabel", "yLabel"] as const) {
		const label = orDrop(drop, () => {
			const raw = v[key];
			if (raw === undefined) return undefined;
			if (typeof raw !== "string") fail(`${path}.${key}`, "expected a string");
			return cleanGraphLabel(raw);
		});
		if (label !== undefined) g[key] = label;
	}
	const degrees = readTrue(v.degrees, `${path}.degrees`, drop);
	if (degrees) g.degrees = degrees;
	const table = orDrop(drop, (): GraphTable | undefined => {
		const t = v.table;
		if (t === undefined) return undefined;
		if (!isObject(t)) fail(`${path}.table`, "expected an object");
		const fn = str(t.fn, `${path}.table.fn`);
		if (!fnIds.has(fn)) fail(`${path}.table.fn`, "refers to a function that does not exist");
		const step = finite(t.step, `${path}.table.step`);
		if (step === 0) fail(`${path}.table.step`, "must not be 0");
		const rows = t.rows;
		if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1 || rows > GRAPH_TABLE_MAX_ROWS) {
			fail(`${path}.table.rows`, `expected an integer from 1 to ${GRAPH_TABLE_MAX_ROWS}`);
		}
		return { fn, from: finite(t.from, `${path}.table.from`), step, rows };
	});
	if (table) g.table = table;
	return g;
}

function readMeta(v: unknown, pageIds: ReadonlySet<string>, drop: Dropped | null, assets: Assets = {}): NotebookMeta {
	if (v === undefined) return normalizeMeta(DEFAULT_META, pageIds);
	if (!isObject(v)) fail("meta", "expected an object");
	if (!Array.isArray(v.tags)) fail("meta.tags", "expected an array");
	const tags = v.tags.map((t, i) => str(t, `meta.tags[${i}]`));
	if (typeof v.favorite !== "boolean") fail("meta.favorite", "expected a boolean");
	const cover = colour(v.cover, "meta.cover");
	if (!Array.isArray(v.bookmarks)) fail("meta.bookmarks", "expected an array");
	const bookmarks = v.bookmarks.map((b, i) => str(b, `meta.bookmarks[${i}]`));
	const meta: NotebookMeta = { tags, favorite: v.favorite, cover, bookmarks };
	if (v.bookmarkInfo !== undefined) {
		const info = readBookmarkInfo(v.bookmarkInfo, drop);
		if (info) meta.bookmarkInfo = info;
	}
	// v11: optional details, dropped and counted when invalid on a lenient read; strict (on write) they fail.
	const description = orDrop(drop, () => {
		if (v.description === undefined) return undefined;
		if (typeof v.description !== "string" || v.description === "") fail("meta.description", "expected a non-empty string");
		if (v.description.length > META_DESCRIPTION_MAX) fail("meta.description", `longer than ${META_DESCRIPTION_MAX} characters`);
		return v.description;
	});
	if (description !== undefined) meta.description = description;
	const coverArt = orDrop(drop, () => (v.coverArt === undefined ? undefined : readCoverArt(v.coverArt, assets)));
	if (coverArt) meta.coverArt = coverArt;
	return normalizeMeta(meta, pageIds);
}

/** v11 cover: generated art (a known style and a seed) or an image asset of the document. */
function readCoverArt(v: unknown, assets: Assets): CoverArt {
	if (!isObject(v)) fail("meta.coverArt", "expected an object");
	if (v.kind === "art") {
		if (!COVER_ART_STYLES.includes(v.style as CoverArtStyle)) fail("meta.coverArt.style", "unknown style");
		if (typeof v.seed !== "string" || v.seed.length === 0 || v.seed.length > 200) fail("meta.coverArt.seed", "expected a non-empty string of at most 200 characters");
		return { kind: "art", style: v.style as CoverArtStyle, seed: v.seed };
	}
	if (v.kind === "image") {
		const asset = str(v.asset, "meta.coverArt.asset");
		if (assets[asset]?.kind !== "image") fail("meta.coverArt.asset", "not an image asset of this notebook");
		return { kind: "image", asset };
	}
	return fail("meta.coverArt.kind", "expected \"art\" or \"image\"");
}

/**
 * Runs `read`; on a validation error, strict mode (`drop` null) fails, lenient mode counts the value as
 * dropped and returns undefined.
 */
function orDrop<T>(drop: Dropped | null, read: () => T): T | undefined {
	if (!drop) return read();
	try {
		return read();
	} catch (e) {
		if (!(e instanceof ValidationError)) throw e;
		drop.count++;
		return undefined;
	}
}

/**
 * v7 bookmark details: an object of objects; text fields are strings, the colour #rrggbb. Read leniently,
 * an invalid field (or entry, or the whole map) is dropped and counted; the other details stay.
 */
function readBookmarkInfo(v: unknown, drop: Dropped | null): Record<string, BookmarkInfo> | undefined {
	return orDrop(drop, () => {
		if (!isObject(v)) fail("meta.bookmarkInfo", "expected an object");
		const out: Record<string, BookmarkInfo> = {};
		for (const [id, raw] of Object.entries(v)) {
			const path = `meta.bookmarkInfo.${id}`;
			const info = orDrop(drop, () => {
				if (!isObject(raw)) fail(path, "expected an object");
				const info: BookmarkInfo = {};
				const title = orDrop(drop, () => {
					if (raw.title !== undefined && typeof raw.title !== "string") fail(`${path}.title`, "expected a string");
					return raw.title;
				});
				if (title !== undefined) info.title = title;
				const color = orDrop(drop, () => (raw.color === undefined ? undefined : colour(raw.color, `${path}.color`)));
				if (color !== undefined) info.color = color;
				const category = orDrop(drop, () => {
					if (raw.category !== undefined && typeof raw.category !== "string") fail(`${path}.category`, "expected a string");
					return raw.category;
				});
				if (category !== undefined) info.category = category;
				return info;
			});
			// A key that would change the object's prototype instead of adding an entry is not kept.
			if (info && id !== "__proto__") out[id] = info;
		}
		return out;
	});
}

/**
 * v7 reading position; dropped (not rejected) when its page is not in the document. Read leniently, an
 * invalid position (or only its invalid y) is dropped and counted.
 */
function readPosition(v: unknown, pageIds: ReadonlySet<string>, drop: Dropped | null): ReadingPosition | undefined {
	if (v === undefined) return undefined;
	const p = orDrop(drop, () => {
		if (!isObject(v)) fail("position", "expected an object");
		const page = str(v.page, "position.page");
		const at = str(v.at, "position.at");
		const p: ReadingPosition = { page, at };
		const y = orDrop(drop, () => (v.y === undefined ? undefined : finite(v.y, "position.y")));
		if (y !== undefined) p.y = y;
		return p;
	});
	return p ? normalizePosition(p, pageIds) : undefined;
}

/** v7 page tags: an array of strings, normalised (no "#", no duplicates); absent when empty. */
function readPageTags(v: unknown, path: string): string[] | undefined {
	if (!Array.isArray(v)) fail(path, "expected an array");
	v.forEach((t, i) => {
		if (typeof t !== "string") fail(`${path}[${i}]`, "expected a string");
	});
	return normalizePageTags(v);
}

function readAssets(v: unknown): Record<string, Asset> {
	if (v === undefined) return {};
	if (!isObject(v)) fail("assets", "expected an object");
	const assets: Record<string, Asset> = {};
	for (const [key, a] of Object.entries(v)) assets[key] = readAsset(a, key, `assets.${key}`);
	return assets;
}

/**
 * v18: releases the members of every group of `page` that has fewer than two (strokes and elements together), counting each such
 * group once in `drop`; with no `drop` (strict) it fails instead. The page is edited in place (its lists are the reader's own).
 */
function dissolveSmallGroups(page: Page, path: string, drop: Dropped | null): void {
	const live = liveGroups(page);
	if (live === null) return;
	const dead = new Set<string>();
	for (const s of page.strokes) if (s.group !== undefined && !live.has(s.group)) dead.add(s.group);
	for (const e of page.elements ?? []) if (e.group !== undefined && !live.has(e.group)) dead.add(e.group);
	if (dead.size === 0) return;
	if (!drop) fail(path, "a group has fewer than two members");
	drop.count += dead.size;
	page.strokes.forEach((s, i) => {
		if (s.group !== undefined && dead.has(s.group)) page.strokes[i] = freezeStroke(withoutGroup(s));
	});
	const els = page.elements;
	els?.forEach((e, i) => {
		if (e.group !== undefined && dead.has(e.group)) els[i] = freezeElement(withoutGroup(e));
	});
}

function readPage(v: unknown, path: string, ids: Set<string>, assets: Assets, drop: Dropped | null = null, slides: SlideIds = new Set<string>(), withStates = true, withLocked = true, withComments = true, withGroups = true, withTimes = true, withPens = true, withShapeStyle = true, withOpacity = true, withTaper = true, withPdfView = true): Page {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	const paper = v.paper;
	if (!isObject(paper) || !PAPER_KINDS.includes(paper.kind as PaperKind)) fail(`${path}.paper`, "unknown paper");
	const spacing = positive(paper.spacing, `${path}.paper.spacing`);
	// Below this the pattern would have millions of lines (a hand-edited file could freeze the app).
	if (spacing < MIN_PAPER_SPACING) fail(`${path}.paper.spacing`, `must be at least ${MIN_PAPER_SPACING} pt`);
	if (!Array.isArray(v.strokes)) fail(`${path}.strokes`, "expected an array");
	const strokes = v.strokes.map((s, i) => {
		const stroke = readStroke(s, `${path}.strokes[${i}]`, drop, slides, withGroups, withPens, withShapeStyle, withOpacity, withTaper);
		if (ids.has(stroke.id)) fail(`${path}.strokes[${i}].id`, "duplicate id");
		ids.add(stroke.id);
		freezeStroke(stroke);
		validatedStrokes.add(stroke);
		return stroke;
	});
	const page: Page = { id, width, height, paper: { kind: paper.kind as PaperKind, spacing }, strokes };
	if (v.tags !== undefined) {
		const tags = readPageTags(v.tags, `${path}.tags`);
		if (tags) page.tags = tags;
	}
	if (v.background !== undefined) page.background = readBackground(v.background, `${path}.background`, assets, drop, withPdfView);
	if (v.margins !== undefined) page.margins = readMargins(v.margins, `${path}.margins`, width, height);
	if (v.infinite !== undefined) {
		if (typeof v.infinite !== "boolean") fail(`${path}.infinite`, "expected a boolean");
		page.infinite = v.infinite;
	}
	if (v.elements !== undefined) {
		if (!Array.isArray(v.elements)) fail(`${path}.elements`, "expected an array");
		const elements: PageElement[] = [];
		v.elements.forEach((e, i) => {
			const at = `${path}.elements[${i}]`;
			// v8 markers and boxes, v9 equations and graphs, v10 excerpts are details: an invalid one is dropped and counted when
			// reading leniently.
			const v8 = isObject(e) && typeof e.type === "string"
				&& (ELEMENT_TYPES_V8.includes(e.type) || ELEMENT_TYPES_V9.includes(e.type) || ELEMENT_TYPES_V10.includes(e.type) || ELEMENT_TYPES_V15.includes(e.type) || ELEMENT_TYPES_V17.includes(e.type) || ELEMENT_TYPES_V23.includes(e.type) || ELEMENT_TYPES_V27.includes(e.type));
			const el = v8 ? orDrop(drop, () => readElement(e, at, assets, drop, withGroups, withOpacity)) : readElement(e, at, assets, drop, withGroups, withOpacity);
			if (!el) return;
			if (ids.has(el.id)) fail(`${at}.id`, "duplicate id");
			ids.add(el.id);
			elements.push(freezeElement(el.type === "sticky" ? withLiveInk(el, strokes) : el));
		});
		if (elements.length > 0) page.elements = elements;
	}
	// v18: a group needs at least two members on the page (strokes and elements together). Leniently a lone member is released and
	// counted (a merge, or a hand edit, can leave one); strictly it fails (the writer never writes one).
	if (withGroups) dissolveSmallGroups(page, path, drop);
	// v14: the lock. A file of an older format has none of ours (an odd `locked` key is ignored, as the migration drops it). It is a
	// detail: read leniently, an invalid value is dropped and counted (the page is then simply unlocked); `false` is the same as absent.
	if (withLocked && v.locked !== undefined) {
		const locked = orDrop(drop, () => {
			if (typeof v.locked !== "boolean") fail(`${path}.locked`, "expected a boolean");
			return v.locked;
		});
		if (locked === true) page.locked = true;
	}
	// v13: the states name strokes of this page, so they are read after the ink. A file of an older format has none of ours.
	if (withStates && v.states !== undefined) {
		const states = readPageStates(v.states, `${path}.states`, new Set(strokes.map((s) => s.id)), drop);
		if (states) page.states = states;
	}
	// v16: the margin comments. A file of an older format has none of ours (an odd `comments` key is ignored, as the migration drops it).
	if (withComments && v.comments !== undefined) {
		const comments = readPageComments(v.comments, `${path}.comments`, page, drop);
		if (comments) page.comments = comments;
	}
	// v19: the start and end time. A file of an older format has none of ours (an odd key is ignored, as the migration drops it). It is a
	// detail: read leniently, an invalid or lone value, or an end before the start, is dropped (both) and counted; strictly it fails.
	if (withTimes && (v.startAt !== undefined || v.endAt !== undefined)) {
		const times = orDrop(drop, () => {
			const problem = pageTimesProblem(v.startAt, v.endAt);
			if (problem) fail(`${path}.startAt`, problem);
			return { startAt: v.startAt as number, endAt: v.endAt as number };
		});
		if (times) {
			page.startAt = times.startAt;
			page.endAt = times.endAt;
		}
	}
	return page;
}

/**
 * v16 (#86): the comments of one page, against the page's size. Lenient (`drop` set): whatever is invalid is dropped, moved
 * into the page or promoted and counted, the rest stays (a comment is a detail, never a reason to refuse a notebook).
 * Strict (`drop` null): any of those fails. Undefined when nothing is left. The items come back frozen.
 */
export function readPageComments(v: unknown, path: string, page: { width: number; height: number }, drop: Dropped | null): PageComment[] | undefined {
	const { comments, problems } = readComments(v, page);
	if (problems.length > 0) {
		if (!drop) fail(path, problems[0]!);
		drop.count += problems.length;
	}
	return comments.length > 0 ? comments : undefined;
}

/** v15: a collapsed note without the ids of strokes that are not on the page (a stroke erased since); the list goes when it empties. */
function withLiveInk(el: StickyElement, strokes: readonly Stroke[]): StickyElement {
	if (!el.ink) return el;
	const alive = new Set(strokes.map((s) => s.id));
	const ink = el.ink.filter((id) => alive.has(id));
	if (ink.length === el.ink.length) return el;
	const out: StickyElement = { ...el };
	if (ink.length > 0) out.ink = ink;
	else delete out.ink;
	return out;
}

/** Committed strokes are immutable: edits create new strokes. This makes per-stroke caches safe. */
export function freezeStroke(stroke: Stroke): Stroke {
	for (const p of stroke.points) Object.freeze(p);
	Object.freeze(stroke.points);
	return Object.freeze(stroke);
}

/** Elements are immutable like strokes: an edit replaces the object (ReplaceElement). v9 graphs and v10 excerpts freeze their nested data too. */
export function freezeElement<T extends PageElement>(element: T): T {
	if (element.type === "graph" && !Object.isFrozen(element)) deepFreezeGraph(element);
	if (element.type === "excerpt") Object.freeze(element.source);
	if (element.type === "sticky" && element.ink) Object.freeze(element.ink);
	if (element.type === "checkbox" && element.task) Object.freeze(element.task);
	return Object.freeze(element);
}

/**
 * Validates an object already at the current version and returns a copy with known fields only. With
 * `drop`, invalid optional v7 details are left out and counted there instead of failing (see `Dropped`).
 */
export function validate(raw: unknown, drop: Dropped | null = null): NotebookDocument {
	return validateWith(raw, readPage, new Set<string>(), drop);
}

type PageReader = (v: unknown, path: string, ids: Set<string>, assets: Assets, drop: Dropped | null, slides: SlideIds, withStates: boolean, withLocked: boolean, withComments: boolean, withGroups: boolean) => Page;

/** `validate` with the page reader and the set of ids injected: staged loading reads page shells first (see StagedParse). */
function validateWith(raw: unknown, readPageAt: PageReader, ids: Set<string>, drop: Dropped | null): NotebookDocument {
	if (!isObject(raw)) fail("document", "expected an object");
	if (raw.format !== FORMAT_ID) fail("format", `expected "${FORMAT_ID}"`);
	if (raw.version !== CURRENT_VERSION) fail("version", `expected ${CURRENT_VERSION}`);
	const id = str(raw.id, "id");
	const createdAt = str(raw.createdAt, "createdAt");
	const modifiedAt = str(raw.modifiedAt, "modifiedAt");
	if (!Array.isArray(raw.pages) || raw.pages.length === 0) fail("pages", "expected at least one page");
	const assets = readAssets(raw.assets);
	const slides = readSlides(raw.slides, drop);
	const slideIds = new Set(slides.map((r) => r.id));
	const pageIds = new Set<string>();
	const pages = raw.pages.map((p, i) => {
		const page = readPageAt(p, `pages[${i}]`, ids, assets, drop, slideIds, true, true, true, true);
		// Page ids key bookmarks, jumps and caches: two pages with one id would be confused with each other.
		if (pageIds.has(page.id)) fail(`pages[${i}].id`, "duplicate id");
		pageIds.add(page.id);
		return page;
	});
	const meta = readMeta(raw.meta, pageIds, drop, assets);
	const doc: NotebookDocument = { format: FORMAT_ID, version: CURRENT_VERSION, id, createdAt, modifiedAt, pages, meta, assets };
	const position = readPosition(raw.position, pageIds, drop);
	if (position) doc.position = position;
	if (slides.length > 0) doc.slides = slides;
	// v21: the saved views (not tied to the pages read above: a view of a page that is gone stays, shown as missing).
	const views = readViews(raw.views, drop);
	if (views.length > 0) doc.views = views;
	return doc;
}

type ParseFailureResult = ParseResult & { ok: false };

type Preflight = { ok: true; raw: RawObject; version: number } | { ok: false; failure: ParseFailureResult };

/** JSON syntax, "is it a notebook" and the version check: everything before the content is looked at. */
function preflight(text: string): Preflight {
	if (text.trim().length === 0) return { ok: false, failure: { ok: false, reason: "empty", message: "the file is empty" } };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, failure: { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` } };
	}
	const notNotebook: Preflight = { ok: false, failure: { ok: false, reason: "not-notebook", message: "not a Notebook document" } };
	if (!isObject(raw)) return notNotebook;
	const version = detectVersion(raw);
	if (version === null || (version >= 1 && raw.format !== FORMAT_ID)) return notNotebook;
	if (version > CURRENT_VERSION) {
		return {
			ok: false,
			failure: {
				ok: false, reason: "future-version", version,
				message: `created by a newer version of Notebook (format v${version}, this version reads up to v${CURRENT_VERSION})`,
			},
		};
	}
	return { ok: true, raw, version };
}

/** Migrates and validates a parsed file. `lenient`: invalid optional v7 details are dropped and counted. */
function parseRaw(raw: RawObject, version: number, lenient: boolean): ParseResult {
	try {
		const migrated = version < CURRENT_VERSION ? migrate(raw, version, CURRENT_VERSION) : raw;
		const drop: Dropped | null = lenient ? { count: 0 } : null;
		const doc = validate(migrated, drop);
		const migratedFrom = version < CURRENT_VERSION ? version : null;
		return drop && drop.count > 0 ? { ok: true, doc, migratedFrom, dropped: drop.count } : { ok: true, doc, migratedFrom };
	} catch (e) {
		if (e instanceof ValidationError || e instanceof MigrationError) {
			return { ok: false, reason: "invalid", message: e.message, version };
		}
		throw e;
	}
}

/** Parses a notebook file (any supported version). Invalid optional v7 details are dropped, see `ParseResult`. */
export function parse(text: string): ParseResult {
	return parseText(text, true);
}

function parseText(text: string, lenient: boolean): ParseResult {
	const pre = preflight(text);
	return pre.ok ? parseRaw(pre.raw, pre.version, lenient) : pre.failure;
}

/**
 * Texts shorter than this (characters, about 3,000 strokes) are always parsed in one go: that is tens of milliseconds
 * on a PC, and staging has a fixed cost of its own (slices, an extra paint before the end).
 */
export const STAGED_MIN_CHARS = 2_000_000;

/** A page that has not been read yet: right id, size and paper, no ink, nothing else. */
function readPageShell(v: unknown, path: string): Page {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	const paper = v.paper;
	if (!isObject(paper) || !PAPER_KINDS.includes(paper.kind as PaperKind)) fail(`${path}.paper`, "unknown paper");
	const spacing = positive(paper.spacing, `${path}.paper.spacing`);
	if (spacing < MIN_PAPER_SPACING) fail(`${path}.paper.spacing`, `must be at least ${MIN_PAPER_SPACING} pt`);
	return { id, width, height, paper: { kind: paper.kind as PaperKind, spacing }, strokes: [] };
}

export type StagedStep =
	| { ok: true; /** Indices of the pages read by this step. */ changed: number[]; done: boolean }
	| { ok: false; failure: ParseFailureResult };

/**
 * A file parsed in stages (#329). `parseStaged` runs the JSON parse and validates the header, the assets, the
 * metadata and the pages one level deep (every page's id, size and paper), and reads one page completely: the
 * one the reader wants. `doc` then has real content on that page and stand-ins (right size, no ink) elsewhere,
 * so the page can be painted at once. `step` reads the other pages, nearest first, in slices of time that leave
 * the input alone; `finish` reads whatever is left.
 *
 * `doc` is for DISPLAY ONLY until `done`: it is missing the ink of the unread pages, so saving it would erase
 * them. `DocumentSession` therefore keeps it out of `session.doc` and `mode` stays "loading" until the last page is
 * read and every page has passed exactly the validation `validate` applies (same readers, one shared set of
 * ids, so duplicate ids across pages are still found). A page that fails ends the load like a damaged file.
 */
export class StagedParse {
	private readonly queue: number[];
	private failure: ParseFailureResult | null = null;

	private constructor(
		readonly doc: NotebookDocument,
		private readonly rawPages: readonly unknown[],
		private readonly ids: Set<string>,
		first: number,
		/** Invalid optional details dropped so far: the document-level ones up front, page details as the pages are read. */
		private readonly drop: Dropped,
		/** The version of the file (9: each page is checked for v10-only elements as it is read; 9 and 10: v11 metadata is dropped). */
		private readonly from: number = CURRENT_VERSION,
	) {
		// Nearest to the wanted page first: forward, then back (the next page is the likelier swipe).
		const order: number[] = [];
		for (let d = 1; d < rawPages.length; d++) {
			if (first + d < rawPages.length) order.push(first + d);
			if (first - d >= 0) order.push(first - d);
		}
		this.queue = order;
	}

	/**
	 * Prepares a staged parse of a file at the current version, or at version 9 to 17, whose migrations only refuse
	 * excerpts (v9: checked page by page as they are read) and drop the v11 metadata fields, with page `first` (0-based) read in full.
	 */
	static create(raw: RawObject, first: number, from: number = CURRENT_VERSION): StagedParse | ParseFailureResult {
		try {
			const ids = new Set<string>();
			// Lenient like `parse`: invalid optional v7 details are dropped and counted; everything else still fails.
			const drop: Dropped = { count: 0 };
			// v12 -> v13 only drops the `states` keys of pages, which `read` ignores page by page; the document-level drops are older.
			// v20 -> v21 only drops a stray `views` key (a v20 file has none of ours); v21 -> v22 only drops stray stroke keys, ignored page by page.
			const current = from === CURRENT_VERSION ? raw : { ...(from < 21 ? withoutV21Views(from < 12 ? withoutV12Slides(from < 11 ? withoutV11Meta(raw) : raw) : raw) : raw), version: CURRENT_VERSION };
			const doc = validateWith(current, readPageShell, ids, drop);
			const rawPages = raw.pages as unknown[];
			const at = Math.min(rawPages.length - 1, Math.max(0, first));
			const staged = new StagedParse(doc, rawPages, ids, at, drop, from);
			staged.read(at);
			return staged;
		} catch (e) {
			if (e instanceof ValidationError) return { ok: false, reason: "invalid", message: e.message, version: from };
			throw e;
		}
	}

	private read(i: number): void {
		if (this.from < 10) {
			const problem = v10OnlyElement(this.rawPages[i], i);
			if (problem) fail(`pages[${i}]`, problem);
		}
		// v15: a sticky note in a file of an older format was not written by any version of this plugin (the migration refuses it).
		if (this.from < 15) {
			const problem = v15OnlyElement(this.rawPages[i], i);
			if (problem) fail(`pages[${i}]`, problem);
		}
		// v17: the same for a checkbox (the v16 -> v17 migration refuses it).
		if (this.from < 17) {
			const problem = v17OnlyElement(this.rawPages[i], i);
			if (problem) fail(`pages[${i}]`, problem);
		}
		// v23: the same for an area (the v22 -> v23 migration refuses it).
		if (this.from < 23) {
			const problem = v23OnlyElement(this.rawPages[i], i);
			if (problem) fail(`pages[${i}]`, problem);
		}
		// v27: the same for a study tape (the v26 -> v27 migration refuses it).
		if (this.from < 27) {
			const problem = v27OnlyElement(this.rawPages[i], i);
			if (problem) fail(`pages[${i}]`, problem);
		}
		// v12: the strokes of an older file have no slide of ours (an odd `slide` key is ignored, as the migration drops it).
		const slides: SlideIds = this.from < 12 ? "ignore" : new Set((this.doc.slides ?? []).map((r) => r.id));
		// v13: the same for the `states` of a page of an older file.
		this.doc.pages[i] = readPage(this.rawPages[i], `pages[${i}]`, this.ids, this.doc.assets ?? {}, this.drop, slides, this.from >= 13, this.from >= 14, this.from >= 16, this.from >= 18, this.from >= 19, this.from >= 20, this.from >= 22, this.from >= 24, this.from >= 25, this.from >= 26);
	}

	get pending(): number {
		return this.queue.length;
	}

	get done(): boolean {
		return this.queue.length === 0 && this.failure === null;
	}

	/** Reads pages for about `budgetMs` (at least one page, if any is left). */
	step(budgetMs: number, now: () => number = () => performance.now()): StagedStep {
		if (this.failure) return { ok: false, failure: this.failure };
		const changed: number[] = [];
		const end = now() + budgetMs;
		try {
			while (this.queue.length > 0) {
				const i = this.queue.shift()!;
				this.read(i);
				changed.push(i);
				if (now() >= end) break;
			}
		} catch (e) {
			if (!(e instanceof ValidationError)) throw e;
			this.failure = { ok: false, reason: "invalid", message: e.message, version: this.from };
			return { ok: false, failure: this.failure };
		}
		return { ok: true, changed, done: this.queue.length === 0 };
	}

	/** Reads every page that is left, at once. */
	finish(): ParseResult {
		const r = this.step(Infinity);
		return r.ok ? this.result() : r.failure;
	}

	/** The result once every page has been read (same shape as `parse`: `dropped` only when > 0). */
	result(): ParseResult {
		const dropped = this.drop.count;
		const migratedFrom = this.from === CURRENT_VERSION ? null : this.from;
		return dropped > 0 ? { ok: true, doc: this.doc, migratedFrom, dropped } : { ok: true, doc: this.doc, migratedFrom };
	}
}

/**
 * Like `parse`, but a large file at the current version comes back as a StagedParse. Everything else (small
 * files, older versions that need migrating, damaged files) is parsed completely and returned as a ParseResult.
 * `firstPage` is 1-based (the page the reader wants), or null.
 */
export function parseStaged(text: string, firstPage: number | null): StagedParse | ParseResult {
	if (text.length < STAGED_MIN_CHARS) return parse(text);
	const pre = preflight(text);
	if (!pre.ok) return pre.failure;
	const first = firstPage === null ? 0 : firstPage - 1;
	// The v9 → v10 migration only refuses excerpts and v10 → v11 only drops two metadata fields, so large v9 and v10 files are staged too.
	// v11 → v12 only drops the slide table and the strokes' `slide` keys (ignored page by page), so large v11 files are staged too.
	// v12 → v13 only drops the pages' `states` keys (ignored page by page), so large v12 files are staged too.
	// v13 → v14 only drops the pages' `locked` keys (ignored page by page), so large v13 files are staged too.
	// v14 → v15 only refuses sticky notes (checked page by page as they are read), so large v14 files are staged too.
	// v15 → v16 only drops the pages' `comments` keys (ignored page by page), so large v15 files are staged too.
	// v16 → v17 only refuses checkboxes (checked page by page as they are read), so large v16 files are staged too.
	// v17 → v18 only drops the `group`, `locked` and `lockAt` keys of strokes and elements (ignored page by page), so large v17 files are staged too.
	// v18 → v19 only drops the pages' `startAt` and `endAt` keys (ignored page by page), so large v18 files are staged too.
	// v19 → v20 only refuses the new pens (checked stroke by stroke as each page is read) and drops the strokes' `nib` keys (ignored), so large v19 files are staged too.
	// v20 → v21 only drops a stray `views` key (applied by `StagedParse.create`), so large v20 files are staged too.
	// v21 → v22 only drops the strokes' `fill`, `fillTint` and `dash` keys (ignored page by page), so large v21 files are staged too.
	// v22 → v23 is the identity apart from the version (the area element is new and nothing is dropped), so large v22 files are staged too.
	// v23 → v24 only drops the `opacity` keys of strokes, images and areas (ignored page by page), so large v23 files are staged too.
	// v24 → v25 only drops the `taperStart` and `taperEnd` keys of strokes (ignored page by page), so large v24 files are staged too.
	// v25 → v26 only drops the `rotate` and `crop` keys of PDF backgrounds (ignored page by page), so large v25 files are staged too.
	// v26 → v27 only refuses study tapes (checked page by page as they are read), so large v26 files are staged too.
	if (pre.version === 26 || pre.version === 25 ||pre.version === 9 || pre.version === 10|| pre.version === 11 || pre.version === 12 || pre.version === 13 || pre.version === 14 || pre.version === 15 || pre.version === 16 || pre.version === 17 || pre.version === 18 || pre.version === 19 || pre.version === 20 || pre.version === 21 || pre.version === 22 || pre.version === 23 || pre.version === 24) return StagedParse.create(pre.raw, first, pre.version);
	if (pre.version !== CURRENT_VERSION) return parseRaw(pre.raw, pre.version, true);
	return StagedParse.create(pre.raw, first);
}

export type CheckedSerialization = { ok: true; text: string } | { ok: false; message: string };

/** v13: states objects that already passed `checkStates` (they are frozen once committed). */
const checkedStates = new WeakSet<PageStates>();

/**
 * v13: the states of `page` as the writer would write them, read back strictly (against the strokes of the page) and
 * written again: they must come back the same. Throws a ValidationError otherwise.
 */
function checkStates(page: Page, path: string): void {
	if (!page.states || checkedStates.has(page.states)) return;
	const states = statesToWrite(page);
	if (states) {
		const line = statesLine(states);
		const back = readPageStates(JSON.parse(line), path, new Set(page.strokes.map((s) => s.id)), null);
		if (!back || statesLine(back) !== line) fail(path, "round-trip mismatch");
	}
	if (Object.isFrozen(page.states)) checkedStates.add(page.states);
}

/** v16: comment lists that already passed `checkComments` (they are frozen once committed). */
const checkedComments = new WeakSet<readonly PageComment[]>();

/**
 * v16: the comments of `page` as the writer would write them, read back strictly (against the size of the page) and written
 * again: they must come back the same. Throws a ValidationError otherwise.
 */
function checkComments(page: Page, path: string): void {
	if (!page.comments || checkedComments.has(page.comments)) return;
	const written = normalizeComments(page.comments, page);
	if (written) {
		const lines = written.map(commentLine);
		const back = readPageComments(JSON.parse(`[${lines.join(",")}]`), path, page, null);
		if (!back || back.map(commentLine).join("\n") !== lines.join("\n")) fail(path, "round-trip mismatch");
	}
	if (Object.isFrozen(page.comments)) checkedComments.add(page.comments);
}

/** Slide table entries that already passed `checkContent` (frozen). */
const checkedSlideRefs = new WeakSet<SlideRef>();
/** v21: frozen saved views that already passed the writer's round-trip check. */
const checkedViews = new WeakSet<SavedView>();

/** Elements that already passed `checkContent` (they are frozen, so they cannot change afterwards). */
const checkedElements = new WeakSet<PageElement>();

/**
 * Strict check of one element exactly as the writer checks it (its line is read back without dropping anything and
 * must write the same line): null when it is valid, else the message. `assets`: the document's assets (images).
 */
export function checkElement(el: PageElement, assets: Readonly<Record<string, Asset>> = {}): string | null {
	try {
		const line = elementLine(el);
		const back = readElement(JSON.parse(line), `element ${el.id}`, assets, null);
		if (elementLine(back) !== line) return `element ${el.id}: round-trip mismatch`;
		return null;
	} catch (e) {
		if (e instanceof ValidationError || e instanceof SyntaxError) return e.message;
		throw e;
	}
}

/**
 * Cheap guard for the history (every edit): the strokes and elements of `doc` that were not checked yet are checked
 * strictly, as `serializeChecked` would before writing, so an edit that would make every later save fail can be refused
 * at once. Checked strokes and elements are remembered (they are immutable). Null when everything is valid.
 */
export function checkContent(doc: NotebookDocument): string | null {
	try {
		const assets = doc.assets ?? {};
		// v12: the slide table is checked as the writer would (an over-long source or path would fail every save).
		for (const r of doc.slides ?? []) {
			if (checkedSlideRefs.has(r)) continue;
			const line = slideRefLine(r);
			if (slideRefLine(readSlideRef(JSON.parse(line), `slide ${r.id}`)) !== line) return `slide ${r.id}: round-trip mismatch`;
			if (Object.isFrozen(r)) checkedSlideRefs.add(r);
		}
		// v21: the saved views are checked as the writer would (a bad name or region, a repeated id or too many would fail every save).
		const views = doc.views ?? [];
		if (views.length > VIEWS_MAX) return `views: more than ${VIEWS_MAX} views`;
		const viewIds = new Set<string>();
		for (const v of views) {
			if (viewIds.has(v.id)) return `view ${v.id}: duplicate id`;
			viewIds.add(v.id);
			if (checkedViews.has(v)) continue;
			const line = viewLine(v);
			if (viewLine(readView(JSON.parse(line), `view ${v.id}`, null)) !== line) return `view ${v.id}: round-trip mismatch`;
			if (Object.isFrozen(v)) checkedViews.add(v);
		}
		// 0.28 review (#98): the references into the notebook's shared tables are checked on EVERY call, not cached with the element: an out-of-order
		// step must never leave a picture, a background or the cover pointing at a file record that is no longer there. (Ink whose slide is not in
		// the table is accepted on purpose, see tests/model-v12: the writer drops the link; per-page undo never removes a slide entry out of order.)
		const asset = (id: string, kind: AssetKind): boolean => Object.prototype.hasOwnProperty.call(assets, id) && assets[id]!.kind === kind;
		const cover = doc.meta?.coverArt;
		if (cover?.kind === "image" && !asset(cover.asset, "image")) return "meta.coverArt.asset: not an image asset of this notebook";
		// 0.19: ids are unique across strokes and elements, as `serializeChecked` requires (two copies of one element would fail every save).
		const ids = new Set<string>();
		for (const page of doc.pages) {
			const bg = page.background;
			if (bg && !asset(bg.asset, bg.kind === "pdf" ? "pdf" : "image")) return `page ${page.id} background: refers to an asset that does not exist`;
			// v19: a start and an end time that go together (the writer writes what it has, the strict reader refuses anything else).
			const times = pageTimesProblem(page.startAt, page.endAt);
			if (times) return `page ${page.id}: ${times}`;
			checkStates(page, `page ${page.id} states`);
			checkComments(page, `page ${page.id} comments`);
			for (const s of page.strokes) {
				if (ids.has(s.id)) return `stroke ${s.id}: duplicate id`;
				ids.add(s.id);
			}
			for (const el of page.elements ?? []) {
				if (ids.has(el.id)) return `element ${el.id}: duplicate id`;
				ids.add(el.id);
				const ref = el.type === "image" || el.type === "excerpt" ? el.asset : undefined;
				if (ref !== undefined && !asset(ref, "image")) return `element ${el.id}: refers to an asset that does not exist`;
			}
			for (const s of page.strokes) {
				if (verifiedLines.has(s) || validatedStrokes.has(s)) continue;
				const line = strokeLine(s);
				const back = readStroke(JSON.parse(line), `stroke ${s.id}`);
				if (strokeLine(back) !== line) return `stroke ${s.id}: round-trip mismatch`;
				if (Object.isFrozen(s) && Object.isFrozen(s.points)) verifiedLines.set(s, line);
			}
			for (const el of page.elements ?? []) {
				if (checkedElements.has(el)) continue;
				const problem = checkElement(el, assets);
				if (problem) return problem;
				if (Object.isFrozen(el)) checkedElements.add(el);
			}
		}
		return null;
	} catch (e) {
		if (e instanceof ValidationError || e instanceof SyntaxError) return e.message;
		throw e;
	}
}

/** Serialized line of each committed (frozen) stroke that already passed the round-trip check. */
const verifiedLines = new WeakMap<Stroke, string>();
/** Frozen strokes produced by readStroke() while parsing a file: already validated field by field. */
const validatedStrokes = new WeakSet<Stroke>();

/**
 * Caches the serialized line of already-validated strokes ahead of the first save, so that save
 * does not pay for the whole document at once. Returns how many strokes were processed.
 */
export function warmStrokeLines(strokes: readonly Stroke[]): number {
	let n = 0;
	for (const s of strokes) {
		if (verifiedLines.has(s) || !validatedStrokes.has(s)) continue;
		verifiedLines.set(s, strokeLine(s));
		n++;
	}
	return n;
}

/** Below this size the whole file is re-parsed on every save; above it, only new strokes are. */
export const FULL_CHECK_LIMIT = 1_000_000;

/**
 * Serializes and re-validates before writing (CLAUDE.md rule 4).
 *
 * Small documents are fully re-parsed. For large ones the check is incremental, so saving
 * a 10,000-stroke notebook does not re-parse megabytes each time: every stroke line is
 * parsed, validated and re-serialized once (strokes are frozen, so it cannot change later),
 * and the document skeleton (header, meta, assets, pages, backgrounds, elements) is validated
 * and round-trip checked on every save, which also catches dangling asset references.
 */
export function serializeChecked(doc: NotebookDocument, forceFull = false): CheckedSerialization {
	try {
		for (const [key, asset] of Object.entries(doc.assets ?? {})) {
			if (key !== asset.id) fail(`assets.${key}`, "key does not match the asset id");
		}
		const ids = new Set<string>();
		const text = assemble(doc, (s) => {
			if (ids.has(s.id)) fail(`stroke ${s.id}`, "duplicate id");
			ids.add(s.id);
			const cached = verifiedLines.get(s);
			if (cached !== undefined) return cached;
			if (validatedStrokes.has(s)) {
				// Read from a file and validated by readStroke(); frozen since, so it cannot have changed.
				const line = strokeLine(s);
				verifiedLines.set(s, line);
				return line;
			}
			const line = strokeLine(s);
			const back = readStroke(JSON.parse(line), `stroke ${s.id}`);
			if (strokeLine(back) !== line) fail(`stroke ${s.id}`, "round-trip mismatch");
			if (Object.isFrozen(s) && Object.isFrozen(s.points)) verifiedLines.set(s, line);
			return line;
		}, (e) => {
			// Ids are unique across strokes and elements; the content is validated by the parse below.
			if (ids.has(e.id)) fail(`element ${e.id}`, "duplicate id");
			ids.add(e.id);
			return elementLine(e);
		});
		if (forceFull || text.length < FULL_CHECK_LIMIT) {
			// Strict: what is written must be valid as a whole, nothing may be dropped on the next read.
			const check = parseText(text, false);
			if (!check.ok) return { ok: false, message: check.message };
			if (serialize(check.doc) !== text) return { ok: false, message: "round-trip mismatch" };
		} else {
			// v12: the skeleton has no strokes, so it writes no slide references: those that are written are checked on their own.
			for (const r of slidesInUse(doc).refs) {
				const line = slideRefLine(r);
				if (slideRefLine(readSlideRef(JSON.parse(line), `slide ${r.id}`)) !== line) fail(`slide ${r.id}`, "round-trip mismatch");
			}
			// v13: nor does it have the strokes the states name: they are written and checked per page, on their own.
			doc.pages.forEach((p, i) => checkStates(p, `pages[${i}].states`));
			doc.pages.forEach((p, i) => checkComments(p, `pages[${i}].comments`));
			const skeleton = { ...doc, pages: doc.pages.map((p) => ({ ...p, strokes: [] })) };
			const noStates = () => undefined;
			const skeletonText = assemble(skeleton, strokeLine, elementLine, noStates);
			const check = parseText(skeletonText, false);
			if (!check.ok) return { ok: false, message: check.message };
			if (assemble(check.doc, strokeLine, elementLine, noStates) !== skeletonText) return { ok: false, message: "round-trip mismatch" };
		}
		return { ok: true, text };
	} catch (e) {
		if (e instanceof ValidationError || e instanceof SyntaxError) return { ok: false, message: e.message };
		throw e;
	}
}
