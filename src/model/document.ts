import { copyBookmarkInfoMap } from "./bookmarks";
import {
	CURRENT_VERSION, DEFAULT_META, FORMAT_ID, PAGE_SIZES, PAPER_SPACING, RENDER_FREEHAND,
	type NotebookDocument, type NotebookMeta, type Page, type Paper, type Point, type RenderVersion, type Stroke, type Tool,
} from "./types";

export function createId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	let id = "";
	for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
	return id;
}

export function createPage(
	size: { width: number; height: number } = PAGE_SIZES.a4,
	paper: Paper = { kind: "grid", spacing: PAPER_SPACING.grid },
): Page {
	return {
		id: createId(),
		width: size.width,
		height: size.height,
		paper: { kind: paper.kind, spacing: paper.spacing },
		strokes: [],
	};
}

export function createDocument(
	now: Date = new Date(),
	size: { width: number; height: number } = PAGE_SIZES.a4,
	paper: Paper = { kind: "grid", spacing: PAPER_SPACING.grid },
): NotebookDocument {
	const iso = now.toISOString();
	return {
		format: FORMAT_ID,
		version: CURRENT_VERSION,
		id: createId(),
		createdAt: iso,
		modifiedAt: iso,
		pages: [createPage(size, paper)],
		meta: cloneMeta(DEFAULT_META),
		assets: {},
	};
}

/** Deep copy of the metadata (arrays and v7 bookmark details are not shared). */
export function cloneMeta(meta: NotebookMeta): NotebookMeta {
	const out: NotebookMeta = { tags: [...meta.tags], favorite: meta.favorite, cover: meta.cover, bookmarks: [...meta.bookmarks] };
	const info = copyBookmarkInfoMap(meta.bookmarkInfo);
	if (info) out.bookmarkInfo = info;
	return out;
}

/** Ids of the assets used by a page background, an image element or (v10) an excerpt snapshot anywhere in the document. */
export function referencedAssets(doc: NotebookDocument): Set<string> {
	const used = new Set<string>();
	for (const page of doc.pages) {
		if (page.background) used.add(page.background.asset);
		for (const el of page.elements ?? []) {
			if (el.type === "image") used.add(el.asset);
			else if (el.type === "excerpt" && el.asset !== undefined) used.add(el.asset);
		}
	}
	return used;
}

/** Rounds like the file does: x/y to 0.01 pt, pressure to 0.001 within [0, 1]. */
export function quantizePoint(x: number, y: number, pressure: number): Point {
	const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
	return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000];
}

export function createStroke(
	color: string,
	width: number,
	points: Point[] = [],
	tool: Tool = "pen",
	render: RenderVersion = RENDER_FREEHAND,
): Stroke {
	return { id: createId(), tool, color, width, render, points };
}

export function findPage(doc: NotebookDocument, pageId: string): Page | undefined {
	return doc.pages.find((p) => p.id === pageId);
}
