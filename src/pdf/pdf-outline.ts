/**
 * The outline and the links of a PDF (0.16, roadmap #46), from what pdf.js reports. Pure over a structural `PdfDoc`, so it
 * is tested in Node with fakes: no pdf.js, DOM or 'obsidian' import.
 *
 * - `readPdfOutline` flattens `getOutline()` into entries with a level and the 1-based page of the PDF they point at
 *   (destinations are resolved through `getDestination` / `getPageIndex`).
 * - `readPageLinks` reads the Link annotations of one page: their boxes (PDF viewport, scale 1) and where each goes
 *   (a page of the same PDF, or a URL).
 * - `linkAt` finds the link under a point of the PDF viewport.
 */
import type { PdfDoc, PdfPage } from "./pdfjs-types";
import type { Point } from "./text-select";

/** One line of the outline of a PDF. */
export interface PdfOutlineEntry {
	title: string;
	/** Depth in the outline, 1 for the top level. */
	level: number;
	/** 1-based page of the PDF the entry points at; 0 when the destination could not be resolved. */
	page: number;
}

/** At most this many entries are read (a hostile or huge outline must not stall the view). */
export const MAX_OUTLINE_ENTRIES = 2000;
/** Nesting deeper than this is flattened into the last level. */
export const MAX_OUTLINE_LEVEL = 8;
const MAX_TITLE = 160;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The 0-based page index a destination (a name, or an explicit `[ref, /Fit…]` array) points at; null when unknown. */
export async function pageIndexOfDest(doc: Pick<PdfDoc, "getDestination" | "getPageIndex" | "numPages">, dest: unknown): Promise<number | null> {
	try {
		let explicit = dest;
		if (typeof dest === "string") explicit = typeof doc.getDestination === "function" ? await doc.getDestination(dest) : null;
		if (!Array.isArray(explicit) || explicit.length === 0) return null;
		const target: unknown = explicit[0];
		let index: unknown = null;
		if (typeof target === "number") index = target;
		else if (isRecord(target) && typeof doc.getPageIndex === "function") index = await doc.getPageIndex(target);
		return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < doc.numPages ? index : null;
	} catch {
		return null;
	}
}

/**
 * The outline of a PDF as a flat list in reading order. A PDF without an outline gives an empty list; one that cannot be
 * read throws (so the caller does not remember "no outline" for a file it could not parse).
 */
export async function readPdfOutline(doc: PdfDoc): Promise<PdfOutlineEntry[]> {
	if (typeof doc.getOutline !== "function") return [];
	const raw = await doc.getOutline();
	if (!Array.isArray(raw)) return [];
	const out: PdfOutlineEntry[] = [];
	const names = new Map<string, number | null>();
	const walk = async (nodes: unknown[], level: number): Promise<void> => {
		for (const node of nodes) {
			if (out.length >= MAX_OUTLINE_ENTRIES) return;
			if (!isRecord(node)) continue;
			const title = typeof node.title === "string" ? node.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
			let index: number | null = null;
			const dest = node.dest;
			if (typeof dest === "string") {
				if (!names.has(dest)) names.set(dest, await pageIndexOfDest(doc, dest));
				index = names.get(dest) ?? null;
			} else if (dest !== undefined && dest !== null) index = await pageIndexOfDest(doc, dest);
			if (title.length > 0) out.push({ title, level: Math.min(level, MAX_OUTLINE_LEVEL), page: index === null ? 0 : index + 1 });
			if (Array.isArray(node.items)) await walk(node.items, level + 1);
		}
	};
	await walk(raw, 1);
	return out;
}

/** A link of a PDF page: its box in the PDF viewport (pt, scale 1) and where it goes. */
export interface PdfPageLink {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Another page of the same PDF (1-based). */
	page?: number;
	/** An address outside the PDF. */
	url?: string;
}

/** The links of a page with the size of the PDF page (scale 1, pt) their boxes are in. */
export interface PdfPageLinks {
	width: number;
	height: number;
	links: PdfPageLink[];
}

const NAMED_ACTIONS = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage"]);

function numbers4(v: unknown): [number, number, number, number] | null {
	if (!Array.isArray(v) || v.length < 4) return null;
	const [a, b, c, d] = v as unknown[];
	return [a, b, c, d].every((n) => typeof n === "number" && Number.isFinite(n)) ? [a as number, b as number, c as number, d as number] : null;
}

/**
 * The links of one page. `transform` maps PDF user space to the viewport (y down) like `PdfViewport.transform`; without one
 * the usual `[1, 0, 0, -1, 0, height]` is used. Annotations that are not links, or have neither a destination nor an
 * address, are left out.
 */
export async function readPageLinks(doc: PdfDoc, page: PdfPage, pageNumber: number, transform?: readonly number[]): Promise<PdfPageLink[]> {
	if (typeof page.getAnnotations !== "function") return [];
	const annotations = await page.getAnnotations({ intent: "display" });
	if (!Array.isArray(annotations)) return [];
	const vt = transform && transform.length >= 6 && transform.slice(0, 6).every((n) => Number.isFinite(n)) ? transform : [1, 0, 0, -1, 0, page.getViewport({ scale: 1 }).height];
	const map = (x: number, y: number): Point => ({ x: vt[0]! * x + vt[2]! * y + vt[4]!, y: vt[1]! * x + vt[3]! * y + vt[5]! });
	const links: PdfPageLink[] = [];
	for (const a of annotations) {
		if (!isRecord(a) || a.subtype !== "Link") continue;
		const rect = numbers4(a.rect);
		if (!rect) continue;
		const p = map(rect[0], rect[1]);
		const q = map(rect[2], rect[3]);
		const box = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y) };
		if (!(box.width > 0 && box.height > 0)) continue;
		if (a.dest !== undefined && a.dest !== null) {
			const index = await pageIndexOfDest(doc, a.dest);
			if (index !== null) links.push({ ...box, page: index + 1 });
			continue;
		}
		if (typeof a.action === "string" && NAMED_ACTIONS.has(a.action)) {
			const target = a.action === "NextPage" ? pageNumber + 1 : a.action === "PrevPage" ? pageNumber - 1 : a.action === "FirstPage" ? 1 : doc.numPages;
			if (target >= 1 && target <= doc.numPages) links.push({ ...box, page: target });
			continue;
		}
		const url = typeof a.url === "string" ? a.url : typeof a.unsafeUrl === "string" ? a.unsafeUrl : "";
		if (url.length > 0) links.push({ ...box, url: url.slice(0, 2000) });
	}
	return links;
}

/** The link under a point of the PDF viewport (the smallest one when several overlap); `tolerance` widens every box, pt. */
export function linkAt(links: readonly PdfPageLink[], p: Point, tolerance = 0): PdfPageLink | null {
	let best: PdfPageLink | null = null;
	for (const l of links) {
		if (p.x < l.x - tolerance || p.x > l.x + l.width + tolerance || p.y < l.y - tolerance || p.y > l.y + l.height + tolerance) continue;
		if (!best || l.width * l.height < best.width * best.height) best = l;
	}
	return best;
}

/** What may be opened outside Obsidian from a PDF: web addresses and mail links. Anything else (file:, javascript:) is refused. */
export function safeExternalUrl(raw: string): string | null {
	const text = raw.trim();
	if (!/^(https?:\/\/|mailto:)/i.test(text)) return null;
	try {
		const u = new URL(text);
		return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
	} catch {
		return null;
	}
}
