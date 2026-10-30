/**
 * Page information (roadmap 379): what the file knows about one page, computed from the document. Pure. Nothing is
 * stored for it, so there is no format change: the dates are the ones the file has (the notebook's), and a page's own
 * last edit is known only on this device (the recent-pages log), which the caller passes in when it has it.
 */
import { elementAssetId } from "./excerpts";
import { MARKER_KINDS, PAGE_SIZES, type MarkerKind, type NotebookDocument, type Page, type PageSizeName, type Tool } from "./types";

export interface PageInfo {
	/** 1-based position and the number of pages. */
	number: number;
	total: number;
	width: number;
	height: number;
	/** The size preset the page has (either orientation), or null for a custom size. */
	preset: PageSizeName | null;
	infinite: boolean;
	paper: string;
	background: "none" | "pdf" | "image";
	strokes: { total: number; byTool: Record<Tool, number>; /** Invisible-ink strokes (they are in the total). */ hidden: number };
	/** Points of all strokes. */
	points: number;
	elements: { total: number; text: number; image: number; marker: number; box: number; /** v9 */ equation: number; graph: number; /** v10 */ excerpt: number };
	/** Distinct files the page uses (its PDF or image background and its images), and their size when known. */
	assets: { count: number; bytes: number; /** Files the document has no record of. */ unknown: number };
	tags: string[];
	bookmark: { title?: string; category?: string } | null;
	markers: { total: number; open: number; byKind: Partial<Record<MarkerKind, number>> };
	dates: {
		/** The notebook's: a page has no creation date of its own in the file. */
		notebookCreated: string | null;
		notebookSaved: string | null;
		/** Last edit of this page on this device (ms since epoch), when the device knows it. */
		pageEditedHere: number | null;
	};
}

/** The id of every file a page draws: its background and its images, each once. */
export function pageAssetIds(page: Page): string[] {
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) {
		const id = elementAssetId(el);
		if (id !== null) ids.add(id);
	}
	return [...ids];
}

function sizePreset(page: Page): PageSizeName | null {
	const short = Math.min(page.width, page.height), long = Math.max(page.width, page.height);
	return (Object.keys(PAGE_SIZES) as PageSizeName[]).find((n) => PAGE_SIZES[n].width === short && PAGE_SIZES[n].height === long) ?? null;
}

function validDate(iso: string | undefined): string | null {
	return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** What is known about page `index` (0-based). `editedHere`: when this device last edited it (ms), if recorded. */
export function pageInfo(doc: NotebookDocument, index: number, editedHere: number | null = null): PageInfo | null {
	const page = doc.pages[index];
	if (!page) return null;
	const byTool: Record<Tool, number> = { pen: 0, highlighter: 0, shape: 0 };
	let points = 0;
	let hidden = 0;
	for (const s of page.strokes) {
		byTool[s.tool]++;
		points += s.points.length;
		if (s.hidden) hidden++;
	}
	const elements = { total: 0, text: 0, image: 0, marker: 0, box: 0, equation: 0, graph: 0, excerpt: 0 };
	const byKind: Partial<Record<MarkerKind, number>> = {};
	let markers = 0;
	let open = 0;
	for (const el of page.elements ?? []) {
		elements.total++;
		elements[el.type]++;
		if (el.type === "marker") {
			markers++;
			if (!el.done) open++;
			byKind[el.kind] = (byKind[el.kind] ?? 0) + 1;
		}
	}
	let bytes = 0;
	let unknown = 0;
	const ids = pageAssetIds(page);
	for (const id of ids) {
		const asset = doc.assets && Object.prototype.hasOwnProperty.call(doc.assets, id) ? doc.assets[id] : undefined;
		if (asset) bytes += asset.bytes;
		else unknown++;
	}
	const marked = doc.meta?.bookmarks.includes(page.id) ?? false;
	const detail = marked ? doc.meta?.bookmarkInfo?.[page.id] : undefined;
	return {
		number: index + 1,
		total: doc.pages.length,
		width: page.width,
		height: page.height,
		preset: sizePreset(page),
		infinite: !!page.infinite,
		paper: page.paper.kind,
		background: page.background?.kind ?? "none",
		strokes: { total: page.strokes.length, byTool, hidden },
		points,
		elements,
		assets: { count: ids.length, bytes, unknown },
		tags: [...(page.tags ?? [])],
		bookmark: marked ? { ...(detail?.title ? { title: detail.title } : {}), ...(detail?.category ? { category: detail.category } : {}) } : null,
		markers: { total: markers, open, byKind },
		dates: { notebookCreated: validDate(doc.createdAt), notebookSaved: validDate(doc.modifiedAt), pageEditedHere: editedHere !== null && Number.isFinite(editedHere) ? editedHere : null },
	};
}

/** The marker kinds present on the page, in the canonical order of MARKER_KINDS. */
export function markerKindsPresent(info: PageInfo): MarkerKind[] {
	return MARKER_KINDS.filter((k) => (info.markers.byKind[k] ?? 0) > 0);
}
