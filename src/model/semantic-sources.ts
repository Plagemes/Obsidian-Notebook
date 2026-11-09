/**
 * The label sources of the semantic zoom (roadmap #130), worked out from the document and its generated outline (#407). A
 * label is shown for: a heading found in the handwriting (as a picture of the ink, there is no recognised text), a titled
 * bookmark, a PDF's name and the entries of its outline, an excerpt (named after its source notebook) and a large picture
 * (named after its file). Nothing is stored and nothing is changed: the sources are rebuilt from the document when it changes.
 * Pure: no DOM, no 'obsidian'.
 */
import type { SemanticSource } from "../ink/semantic-zoom";
import { excerptSourceName } from "./excerpts";
import type { OutlineItem } from "./outline-builder";
import type { Asset, ExcerptElement, ImageElement, Page } from "./types";

/** The outline sources that label the overview (markers and slide changes are too many and too small to name a place). */
export const SEMANTIC_OUTLINE_SOURCES = { bookmarks: true, slides: true, headings: true, markers: false, pdf: true } as const;

/** Longest label text, characters. */
export const LABEL_TEXT_MAX = 48;
/** An excerpt or a picture narrower than this (pt), or covering less than this share of its page, is not labelled. */
export const MIN_OBJECT_WIDTH = 90;
export const MIN_OBJECT_SHARE = 0.03;
/** Where the labels of a whole page (bookmark, PDF name, PDF outline) sit: near the top left corner (pt). */
const PAGE_LABEL_X = 16;
const PAGE_LABEL_Y = 12;
const PAGE_LABEL_HEIGHT = 14;

/** A file name without its folder and extension, shortened to `LABEL_TEXT_MAX` characters. */
export function shortName(name: string): string {
	const file = name.split(/[\\/]/).pop() ?? name;
	const dot = file.lastIndexOf(".");
	const base = (dot > 0 ? file.slice(0, dot) : file).replace(/[_]+/g, " ").trim();
	return base.length > LABEL_TEXT_MAX ? `${base.slice(0, LABEL_TEXT_MAX - 1).trimEnd()}…` : base;
}

function clip(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > LABEL_TEXT_MAX ? `${t.slice(0, LABEL_TEXT_MAX - 1).trimEnd()}…` : t;
}

export interface SemanticSourceInput {
	pages: readonly Page[];
	/** The generated outline of the document with the sources of `SEMANTIC_OUTLINE_SOURCES`. */
	outline: readonly OutlineItem[];
	assets?: Readonly<Record<string, Asset>> | undefined;
}

export function buildSemanticSources(input: SemanticSourceInput): SemanticSource[] {
	const out: SemanticSource[] = [];
	const pageLabels = new Map<number, number>();
	// The labels of a whole page are stacked down from the top so that they do not start on top of each other.
	const pageSlot = (index: number): number => {
		const n = pageLabels.get(index) ?? 0;
		pageLabels.set(index, n + 1);
		return PAGE_LABEL_Y + n * (PAGE_LABEL_HEIGHT + 8);
	};
	for (const item of input.outline) {
		const page = input.pages[item.index];
		if (!page || page.id !== item.pageId) continue;
		if (item.kind === "heading" && item.heading) {
			const r = item.heading.rect;
			if (!(r.width > 0) || !(r.height > 0)) continue;
			out.push({ key: item.key, kind: "heading", level: item.heading.level, pageIndex: item.index, x: r.x, y: r.y, width: r.width, height: r.height, aspect: r.width / r.height, ink: item.heading.strokeIds });
		} else if (item.kind === "bookmark" || item.kind === "document" || item.kind === "pdf") {
			const text = clip(item.kind === "document" ? shortName(item.title) : item.title);
			if (!text) continue;
			// A PDF outline entry below the second level is detail.
			if (item.kind === "pdf" && item.depth > 2) continue;
			const kind = item.kind === "bookmark" ? "bookmark" : item.kind === "document" ? "document" : "section";
			out.push({
				key: item.key, kind, level: item.kind === "pdf" && item.depth > 1 ? 2 : 1, pageIndex: item.index,
				x: PAGE_LABEL_X, y: pageSlot(item.index), width: 0, height: PAGE_LABEL_HEIGHT, text,
			});
		}
	}
	input.pages.forEach((page, index) => {
		const area = Math.max(1, page.width * page.height);
		for (const el of page.elements ?? []) {
			if (el.type === "excerpt") {
				const text = excerptLabel(el, area);
				if (text) out.push({ key: `x:${el.id}`, kind: "excerpt", level: 3, pageIndex: index, x: el.x, y: el.y, width: el.width, height: Math.min(el.height, PAGE_LABEL_HEIGHT * 2), text });
			} else if (el.type === "image") {
				const text = imageLabel(el, area, input.assets);
				if (text) out.push({ key: `i:${el.id}`, kind: "image", level: 3, pageIndex: index, x: el.x, y: el.y, width: el.width, height: Math.min(el.height, PAGE_LABEL_HEIGHT * 2), text });
			}
		}
	});
	return out;
}

function big(el: { width: number; height: number }, area: number): boolean {
	return el.width >= MIN_OBJECT_WIDTH && (el.width * el.height) / area >= MIN_OBJECT_SHARE;
}

function excerptLabel(el: ExcerptElement, area: number): string {
	if (!big(el, area)) return "";
	return clip(excerptSourceName(el.source));
}

function imageLabel(el: ImageElement, area: number, assets: SemanticSourceInput["assets"]): string {
	if (!big(el, area)) return "";
	const name = assets?.[el.asset]?.name;
	return name ? shortName(name) : "";
}
