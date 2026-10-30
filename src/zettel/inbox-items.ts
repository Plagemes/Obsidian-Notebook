/**
 * Processing flow (M15 Z4), items: what the Inbox lists, and the adapter interface that lets other parts of the plugin
 * (the marker elements of a later format version) add their own. Pure: no 'obsidian', no DOM.
 *
 * An item is a piece of a notebook that still has to be dealt with: a block of writing on a page of the loose sheet, or a
 * highlight / comment on a PDF page (a candidate for a literature note). Items are found by `InboxSource`s; each has a
 * stable `key` so that "processed" can be remembered without touching the notebook (see `inbox-state.ts`).
 */
import type { NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import type { CardType } from "./card-content";
import type { Region } from "./subpath";
import { clampRegion } from "./subpath";

export type InboxItemKind = "block" | "pdf-highlight" | "pdf-comment" | "marker";
/** Marker elements (format v8, added by another part of the plugin) the Inbox expects: question, placeholder, importance. */
export type InboxMarkerKind = "question" | "placeholder" | "importance";

export interface InboxItem {
	/** Stable across sessions and devices: `<prefix>|<notebook id>|<page id>|<what>`. */
	key: string;
	/** `InboxSource.id` that found it. */
	source: string;
	kind: InboxItemKind;
	markerKind?: InboxMarkerKind;
	notebookPath: string;
	notebookName: string;
	notebookId: string;
	pageId: string;
	/** 0-based index of the page when the item was found (the page id is what counts). */
	pageIndex: number;
	/** Size of the page (pt), to compare regions. */
	pageSize: { width: number; height: number };
	/** The part of the page; null: the whole page. */
	region: Region | null;
	/** Text found in the item (typed text, a comment); "" when there is none. Highlights get theirs when shown. */
	text: string;
	/** How much content the item had, to tell new writing from what was already processed (page blocks only). */
	sig: number;
	/** Where the item comes from, for a literature note: the PDF and its page. */
	origin?: { pdfName: string; pdfPage: number };
	/** Type suggested for the card made from it. */
	cardType: CardType;
	/** Reading order inside the notebook: page index, then top-to-bottom. */
	order: number;
}

/** A notebook the sources may read. `read` returns null when the file cannot be parsed or `prefilter` rejects its text. */
export interface InboxNotebook {
	path: string;
	name: string;
	/** The loose sheet. */
	looseSheet: boolean;
	read(prefilter?: (rawText: string) => boolean): Promise<NotebookDocument | null>;
}

export interface InboxEnv {
	notebooks(): InboxNotebook[];
	/** Called between notebooks with the number done, so a long scan can show progress and let the UI breathe. */
	progress?(done: number, total: number): Promise<void> | void;
}

/**
 * The adapter interface. A source returns every item it finds *now* (processed or not: the service filters). Sources are
 * independent and must not write anything. The marker elements of format v8 plug in with `registerInboxSource` (see
 * `markerKinds` below for the kinds the Inbox shows); nothing in the Inbox depends on them being there.
 */
export interface InboxSource {
	readonly id: string;
	collect(env: InboxEnv): Promise<InboxItem[]>;
}

const registered: InboxSource[] = [];

/** Adds a source to the Inbox (e.g. the marker elements). Returns the function that removes it. */
export function registerInboxSource(source: InboxSource): () => void {
	if (!registered.includes(source)) registered.push(source);
	return () => {
		const i = registered.indexOf(source);
		if (i >= 0) registered.splice(i, 1);
	};
}

/** Sources added with `registerInboxSource`, in registration order. */
export function registeredInboxSources(): readonly InboxSource[] {
	return registered;
}

// ---------------------------------------------------------------------------------------------------- geometry

interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function strokeBox(s: Stroke): Box | null {
	if (s.points.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of s.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const r = Math.max(0, s.width / 2);
	return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
}

/** Text box bounds with a measure-free estimate (a fixed pitch per character): good enough to group and to preview. */
export function elementBox(el: PageElement): Box {
	if (el.type === "text") {
		const lines = Math.max(1, el.text.split("\n").length);
		const perLine = Math.max(1, Math.floor(el.width / (el.fontSize * 0.55)));
		const wrapped = el.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
		const h = Math.max(lines, wrapped) * el.fontSize * 1.25;
		return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + h };
	}
	// Markers (format v8) may be point-sized: no width or height.
	return { minX: el.x, minY: el.y, maxX: el.x + (el.width ?? 0), maxY: el.y + (el.height ?? 0) };
}

// ---------------------------------------------------------------------------------------------------- blocks

/** Vertical gap (pt) that separates two blocks of writing on a page (about 1.3 cm). */
export const BLOCK_GAP = 36;
/** Space (pt) added around a block when it becomes the region of a card. */
const BLOCK_PAD = 10;
/** A block this much of the page (area share) is the whole page. */
const WHOLE_PAGE_SHARE = 0.7;

interface Member {
	/** Position in the page's strokes-then-elements order: the first member names the block. */
	order: number;
	id: string;
	box: Box;
	text: string;
}

export interface Block {
	/** Id of the first stroke (else element) of the block: the block's name while it exists. */
	id: string;
	box: Box;
	/** Strokes and elements in it. */
	count: number;
	/** Typed text in it, top to bottom. */
	text: string;
}

/**
 * Splits the writing of a page into blocks at vertical gaps wider than `gap`: separate jots of a loose sheet. A block is
 * named by its first stroke (else element), so it keeps its name while it grows. Empty pages have no blocks.
 */
export function pageBlocks(page: Pick<Page, "strokes" | "elements">, gap = BLOCK_GAP): Block[] {
	const members: Member[] = [];
	let order = 0;
	for (const s of page.strokes) {
		const box = strokeBox(s);
		if (box) members.push({ order, id: s.id, box, text: "" });
		order++;
	}
	for (const el of page.elements ?? []) {
		if (el.type === "text" && el.text.trim() === "") {
			order++;
			continue;
		}
		members.push({ order, id: el.id, box: elementBox(el), text: el.type === "text" ? el.text.trim() : "" });
		order++;
	}
	if (members.length === 0) return [];
	const byTop = [...members].sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX);
	const groups: Member[][] = [];
	let bottom = -Infinity;
	for (const m of byTop) {
		const last = groups[groups.length - 1];
		if (!last || m.box.minY > bottom + gap) {
			groups.push([m]);
			bottom = m.box.maxY;
		} else {
			last.push(m);
			bottom = Math.max(bottom, m.box.maxY);
		}
	}
	return groups.map((g) => {
		const first = g.reduce((a, b) => (b.order < a.order ? b : a));
		const box = g.reduce<Box>((acc, m) => ({
			minX: Math.min(acc.minX, m.box.minX), minY: Math.min(acc.minY, m.box.minY),
			maxX: Math.max(acc.maxX, m.box.maxX), maxY: Math.max(acc.maxY, m.box.maxY),
		}), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
		const text = g.filter((m) => m.text !== "").sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX).map((m) => m.text).join("\n\n");
		return { id: first.id, box, count: g.length, text };
	});
}

/** The region a block becomes in a card: its box with some margin, or null (the whole page) when it fills most of the page. */
export function blockRegion(box: Box, page: { width: number; height: number }): Region | null {
	const region = clampRegion({ x: box.minX - BLOCK_PAD, y: box.minY - BLOCK_PAD, width: box.maxX - box.minX + 2 * BLOCK_PAD, height: box.maxY - box.minY + 2 * BLOCK_PAD }, page);
	if (!region) return null;
	return (region.width * region.height) / Math.max(1, page.width * page.height) >= WHOLE_PAGE_SHARE ? null : region;
}

/** A title proposed for a card: the first line of the text, shortened at a word. */
export function suggestTitle(text: string, max = 60): string {
	const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
	const flat = line.replace(/\s+/g, " ").replace(/^[#>\-*\s]+/, "");
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

// ---------------------------------------------------------------------------------------------------- keys

const part = (s: string) => s.replace(/\|/g, "/");

export function blockKey(notebookId: string, pageId: string, blockId: string): string {
	return `blk|${part(notebookId)}|${part(pageId)}|${part(blockId)}`;
}

export function pdfKey(kind: "pdf-highlight" | "pdf-comment", notebookId: string, pageId: string, itemId: string): string {
	return `${kind === "pdf-highlight" ? "hl" : "cm"}|${part(notebookId)}|${part(pageId)}|${part(itemId)}`;
}

/** The last part of a key: the id of the stroke, text box or marker the item stands for. */
export function itemIdOf(key: string): string {
	return key.split("|")[3] ?? "";
}

/** Key a marker source should use, so markers of all kinds share one scheme. */
export function markerKey(notebookId: string, pageId: string, markerId: string): string {
	return `mk|${part(notebookId)}|${part(pageId)}|${part(markerId)}`;
}

// ---------------------------------------------------------------------------------------------------- built-in collectors

/** Loose-sheet items: one per block of writing on each page. */
export function collectBlockItems(doc: NotebookDocument, nb: { path: string; name: string }, source = "loose-sheet"): InboxItem[] {
	const out: InboxItem[] = [];
	doc.pages.forEach((page, pageIndex) => {
		for (const block of pageBlocks(page)) {
			out.push({
				key: blockKey(doc.id, page.id, block.id), source, kind: "block",
				notebookPath: nb.path, notebookName: nb.name, notebookId: doc.id, pageId: page.id, pageIndex, pageSize: { width: page.width, height: page.height },
				region: blockRegion(block.box, page), text: block.text, sig: block.count, cardType: "permanent",
				order: pageIndex * 1e6 + Math.round(block.box.minY),
			});
		}
	});
	return out;
}

/** Highlights and comments on PDF pages: candidates for literature notes, with the PDF and page they come from. */
export function collectPdfItems(doc: NotebookDocument, nb: { path: string; name: string }, source = "pdf"): InboxItem[] {
	const out: InboxItem[] = [];
	doc.pages.forEach((page, pageIndex) => {
		const bg = page.background;
		if (bg?.kind !== "pdf") return;
		const origin = { pdfName: doc.assets?.[bg.asset]?.name ?? bg.asset, pdfPage: bg.page };
		for (const s of page.strokes) {
			if (s.tool !== "highlighter") continue;
			const box = strokeBox(s);
			if (!box) continue;
			out.push({
				key: pdfKey("pdf-highlight", doc.id, page.id, s.id), source, kind: "pdf-highlight",
				notebookPath: nb.path, notebookName: nb.name, notebookId: doc.id, pageId: page.id, pageIndex, pageSize: { width: page.width, height: page.height },
				region: clampRegion({ x: box.minX - BLOCK_PAD, y: box.minY - BLOCK_PAD, width: box.maxX - box.minX + 2 * BLOCK_PAD, height: box.maxY - box.minY + 2 * BLOCK_PAD }, page),
				text: "", sig: 0, origin, cardType: "literature", order: pageIndex * 1e6 + Math.round(box.minY),
			});
		}
		for (const el of page.elements ?? []) {
			if (el.type !== "text" || el.text.trim() === "") continue;
			const box = elementBox(el);
			out.push({
				key: pdfKey("pdf-comment", doc.id, page.id, el.id), source, kind: "pdf-comment",
				notebookPath: nb.path, notebookName: nb.name, notebookId: doc.id, pageId: page.id, pageIndex, pageSize: { width: page.width, height: page.height },
				region: clampRegion({ x: box.minX - BLOCK_PAD, y: box.minY - BLOCK_PAD, width: box.maxX - box.minX + 2 * BLOCK_PAD, height: box.maxY - box.minY + 2 * BLOCK_PAD }, page),
				text: el.text.trim(), sig: 0, origin, cardType: "literature", order: pageIndex * 1e6 + Math.round(box.minY),
			});
		}
	});
	return out;
}

/** True when a notebook's raw text may hold PDF pages (a cheap test before parsing every notebook of the vault). */
export function mayHavePdfPages(rawText: string): boolean {
	if (!/"kind"\s*:\s*"pdf"/.test(rawText)) return false;
	return rawText.includes("highlighter") || /"type"\s*:\s*"text"/.test(rawText);
}

/** Loose-sheet source: blocks of writing on the pages of the loose sheet. */
export const looseSheetSource: InboxSource = {
	id: "loose-sheet",
	async collect(env) {
		const out: InboxItem[] = [];
		for (const nb of env.notebooks()) {
			if (!nb.looseSheet) continue;
			const doc = await nb.read();
			if (doc) out.push(...collectBlockItems(doc, nb));
		}
		return out;
	},
};

/** PDF source: highlights and comments of every notebook that has PDF pages. */
export const pdfAnnotationSource: InboxSource = {
	id: "pdf",
	async collect(env) {
		const out: InboxItem[] = [];
		const list = env.notebooks().filter((n) => !n.looseSheet);
		let done = 0;
		for (const nb of list) {
			const doc = await nb.read(mayHavePdfPages);
			if (doc) out.push(...collectPdfItems(doc, nb));
			await env.progress?.(++done, list.length);
		}
		return out;
	},
};

// ---------------------------------------------------------------------------------------------------- ordering and cards

/** Items in reading order: loose sheet first, then notebooks by name, then page and position. */
export function sortItems(items: readonly InboxItem[], sourceOrder: readonly string[] = ["loose-sheet", "pdf"]): InboxItem[] {
	const rank = (s: string) => {
		const i = sourceOrder.indexOf(s);
		return i < 0 ? sourceOrder.length : i;
	};
	return [...items].sort((a, b) =>
		rank(a.source) - rank(b.source) || a.notebookName.localeCompare(b.notebookName, undefined, { numeric: true })
		|| a.notebookPath.localeCompare(b.notebookPath) || a.order - b.order || a.key.localeCompare(b.key));
}

/** Whether a card's region (null: the whole page) covers at least half of the item's region. */
export function coveredBy(item: Pick<InboxItem, "region" | "pageSize">, cardRegion: Region | null): boolean {
	if (cardRegion === null) return true;
	const r = item.region ?? { x: 0, y: 0, width: item.pageSize.width, height: item.pageSize.height };
	const w = Math.min(r.x + r.width, cardRegion.x + cardRegion.width) - Math.max(r.x, cardRegion.x);
	const h = Math.min(r.y + r.height, cardRegion.y + cardRegion.height) - Math.max(r.y, cardRegion.y);
	if (w <= 0 || h <= 0) return false;
	return (w * h) / Math.max(1, r.width * r.height) >= 0.5;
}

/** Markdown for the Transcription section of a card made from an item: a quote for text taken from a PDF, else the text as typed. */
export function transcriptionText(item: Pick<InboxItem, "kind" | "text">, text = item.text): string {
	const clean = text.replace(/%%/g, "% %").trim();
	if (!clean) return "";
	if (item.kind === "pdf-highlight") return clean.split(/\r?\n/).map((l) => (l.trim() === "" ? ">" : `> ${l}`)).join("\n");
	return clean;
}

/** The source line of a literature card: `Book.pdf, p. 12`. */
export function sourceLabel(item: Pick<InboxItem, "origin" | "notebookName">): string {
	return item.origin ? `${item.origin.pdfName}, p. ${item.origin.pdfPage}` : "";
}
