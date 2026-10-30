import { elementAssetId } from "../model/excerpts";
import { createDocument, createStroke } from "../model/document";
import type { Batch } from "../model/history";
import { freezeStroke, parse, serializeChecked } from "../model/serialize";
import type { Asset, NotebookDocument, Page, PageElement, Point, Stroke } from "../model/types";
import { captureClip, instantiateClip, pasteCommand, pasteOffset, type ClipContent } from "./clipboard";
import { elementBounds, transformElement } from "./elements";
import { transformStroke } from "./lasso";
import { arrowPoints, polygonPoints, type Vec } from "./shapes";
import { estimateMeasure, type MeasureText } from "./text-layout";
import { translate } from "./transform";

/**
 * Personal stamps (roadmap 142): a lasso selection saved under a name and placed again on any page.
 *
 * A stamp is stored in its own vault file `<notebooks folder>/_stamps/<name>.stamp` (so it syncs with the
 * vault, not with the plugin settings). The file is an ordinary notebook document with one page that holds
 * the stamp's strokes and elements, moved so that the stamp starts at the page origin; images are referenced by
 * content-addressed asset id exactly as in a notebook, and the asset records travel with the stamp. Reusing the
 * document format means validation and future migrations come for free and no format change is needed.
 * A stamp is an immutable `ClipContent`: placing it makes fresh ids, like a paste.
 */

export const STAMP_EXTENSION = "stamp";
/** Name of the stamps folder inside the notebooks folder. */
export const STAMPS_DIRNAME = "_stamps";

/** `<notebooks folder>/_stamps`. */
export function stampsFolder(notebooksFolder: string): string {
	const base = notebooksFolder.replace(/^\/+|\/+$/g, "");
	return base ? `${base}/${STAMPS_DIRNAME}` : STAMPS_DIRNAME;
}

const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** A file-name-safe stamp name ("" when nothing usable is left). */
export function cleanStampName(name: string): string {
	return name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60).trim();
}

/** `name`, or `name 2`, `name 3`… when the (case-insensitive) name is taken. */
export function uniqueStampName(name: string, taken: Iterable<string>): string {
	const used = new Set<string>();
	for (const n of taken) used.add(n.toLowerCase());
	const base = cleanStampName(name) || "Stamp";
	if (!used.has(base.toLowerCase())) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base} ${i}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
}

/** Biggest side (pt) of a stamp that is saved: a whole page of handwriting is not a stamp. */
export const MAX_STAMP_SIDE = 2000;

/** The clip moved so that its box starts at the origin, ids kept (they are replaced on placement). */
export function normalizeStamp(clip: ClipContent, measure: MeasureText = estimateMeasure): ClipContent {
	const m = translate(-clip.bounds.minX, -clip.bounds.minY);
	return {
		strokes: clip.strokes.map((s) => freezeStroke(transformStroke(s, m))),
		elements: clip.elements.map((e) => transformElement(e, m, measure)),
		assets: clip.assets.map((a) => ({ ...a })),
		bounds: { minX: 0, minY: 0, maxX: clip.bounds.maxX - clip.bounds.minX, maxY: clip.bounds.maxY - clip.bounds.minY },
	};
}

export type StampText = { ok: true; text: string } | { ok: false; message: string };

/** The text of a stamp file for `clip`, serialized and validated again before it is returned (nothing invalid is ever written). */
export function serializeStamp(clip: ClipContent, now: Date = new Date(), maxSide: number = MAX_STAMP_SIDE): StampText {
	const stamp = normalizeStamp(clip);
	const w = stamp.bounds.maxX;
	const h = stamp.bounds.maxY;
	if (w > maxSide || h > maxSide) return { ok: false, message: "the selection is too large for a stamp" };
	const doc = createDocument(now, { width: Math.max(1, Math.ceil(w) + 1), height: Math.max(1, Math.ceil(h) + 1) });
	const page = doc.pages[0]!;
	page.strokes.push(...stamp.strokes);
	if (stamp.elements.length > 0) page.elements = [...stamp.elements];
	const assets: Record<string, Asset> = {};
	for (const a of stamp.assets) assets[a.id] = a;
	doc.assets = assets;
	return serializeChecked(doc, true);
}

export type StampRead = { ok: true; clip: ClipContent } | { ok: false; message: string };

/** The content of a stamp file, or why it cannot be used (damaged, newer version, empty). */
export function readStamp(text: string, measure: MeasureText = estimateMeasure): StampRead {
	const parsed = parse(text);
	if (!parsed.ok) return { ok: false, message: parsed.message };
	const page = parsed.doc.pages[0];
	if (!page) return { ok: false, message: "no content" };
	const clip = captureClip(page.strokes, page.elements ?? [], parsed.doc.assets, measure);
	if (!clip) return { ok: false, message: "the stamp is empty" };
	return { ok: true, clip };
}

// --- built-in stamps ---

export const BUILTIN_STAMPS = ["check", "star", "arrow"] as const;
export type BuiltinStamp = (typeof BUILTIN_STAMPS)[number];

function starVertices(): Vec[] {
	const out: Vec[] = [];
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? 13 : 5.4;
		const a = -Math.PI / 2 + (i * Math.PI) / 5;
		out.push([14 + r * Math.cos(a), 14 + r * Math.sin(a)]);
	}
	return out;
}

/**
 * A built-in stamp drawn with the shape tool's constant-width ink in the given colour and width (code-generated,
 * so it follows the current pen). Roughly 30 pt wide.
 */
export function builtinStamp(kind: BuiltinStamp, color: string, width: number, measure: MeasureText = estimateMeasure): ClipContent {
	let points: Point[];
	switch (kind) {
		case "check":
			points = polygonPoints([[2, 14], [10, 23], [26, 3]], false);
			break;
		case "star":
			points = polygonPoints(starVertices(), true);
			break;
		case "arrow":
			points = arrowPoints([2, 12], [36, 12], 11);
			break;
	}
	const stroke = freezeStroke(createStroke(color, width, points, "shape"));
	const clip = captureClip([stroke], [], undefined, measure);
	if (!clip) throw new Error("empty built-in stamp");
	return normalizeStamp(clip, measure);
}

// --- placing ---

export interface StampPlacement {
	/** The single undo step that adds the stamp to the page. */
	command: Batch;
	strokes: Stroke[];
	elements: PageElement[];
}

/**
 * Places `clip` on `page` with its centre at `centre` (page coordinates; kept inside the page when it fits): fresh ids,
 * one undo step, plus the asset records the document does not know yet. Image elements whose asset is not in
 * `usable` (when given) are left out and counted in `skipped`.
 */
export function planStampPlacement(
	clip: ClipContent, doc: Readonly<NotebookDocument>, page: Page, centre: readonly [number, number],
	options: { usable?: (assetId: string) => boolean; measure?: MeasureText } = {},
): (StampPlacement & { skipped: number }) | null {
	const measure = options.measure ?? estimateMeasure;
	const keep = (e: PageElement) => e.type !== "image" || !options.usable || options.usable(e.asset);
	// v10: an excerpt whose snapshot cannot be used keeps its anchor without the snapshot.
	const elements = clip.elements.filter(keep).map((e) => {
		if (e.type !== "excerpt" || e.asset === undefined || !options.usable || options.usable(e.asset)) return e;
		const { asset: _a, ...rest } = e;
		void _a;
		return rest;
	});
	const skipped = clip.elements.length - elements.length;
	if (clip.strokes.length === 0 && elements.length === 0) return null;
	const content: ClipContent = { ...clip, elements };
	const [dx, dy] = pasteOffset(content.bounds, page, centre, 0);
	const made = instantiateClip(content, dx, dy, undefined, measure);
	const wanted = new Set(made.elements.flatMap((e) => {
		const id = elementAssetId(e);
		return id !== null ? [id] : [];
	}));
	const newAssets = clip.assets.filter((a) => wanted.has(a.id) && !doc.assets?.[a.id]);
	const command = pasteCommand(page, made.strokes, made.elements, newAssets, "Place stamp");
	return { command, strokes: made.strokes, elements: made.elements, skipped };
}

// --- previews ---

export interface StampPreview {
	/** viewBox of the stamp's box, pt. */
	box: { x: number; y: number; w: number; h: number };
	strokes: Array<{ d: string; color: string; width: number; highlighter: boolean }>;
	/** Images and text boxes, shown as outlined rectangles (rotation in degrees about the centre). */
	boxes: Array<{ x: number; y: number; w: number; h: number; rotation: number; kind: "image" | "text" }>;
}

const MAX_PREVIEW_POINTS = 48;

/** Vector description of a stamp for its palette tile (no canvas: the view draws it as inline SVG). */
export function stampPreview(clip: ClipContent, measure: MeasureText = estimateMeasure): StampPreview {
	const pad = 2;
	const b = clip.bounds;
	const w = Math.max(1, b.maxX - b.minX);
	const h = Math.max(1, b.maxY - b.minY);
	const floor = Math.max(w, h) / 60;
	const strokes = clip.strokes.map((s) => {
		const n = s.points.length;
		const step = Math.max(1, Math.ceil(n / MAX_PREVIEW_POINTS));
		const pts: string[] = [];
		for (let i = 0; i < n; i += step) pts.push(`${s.points[i]![0]},${s.points[i]![1]}`);
		const last = s.points[n - 1]!;
		if ((n - 1) % step !== 0) pts.push(`${last[0]},${last[1]}`);
		if (pts.length === 1) pts.push(pts[0]!);
		return {
			d: `M${pts.join("L")}`, color: s.color, width: Math.max(s.width, floor), highlighter: s.tool === "highlighter",
		};
	});
	const boxes = clip.elements.map((e) => {
		const eb = elementBounds(e, measure);
		return {
			x: eb.minX, y: eb.minY, w: eb.maxX - eb.minX, h: eb.maxY - eb.minY,
			rotation: e.type === "image" ? (e.rotation * 180) / Math.PI : 0,
			kind: e.type === "image" ? "image" as const : "text" as const,
		};
	});
	return { box: { x: b.minX - pad, y: b.minY - pad, w: w + pad * 2, h: h + pad * 2 }, strokes, boxes };
}

/** Bounds of strokes (used by tests and the view to size a drop ghost). */
export function stampSize(clip: ClipContent): { width: number; height: number } {
	return { width: clip.bounds.maxX - clip.bounds.minX, height: clip.bounds.maxY - clip.bounds.minY };
}
