/** Pure helpers to decide what to read and to turn a document into index fields. No 'obsidian'. */
import { normalizePageTags } from "../model/page-tags";
import { DEFAULT_META, type NotebookDocument } from "../model/types";
import { folderOf, nameOf, type LibraryEntry, type LibraryIndex } from "./index";

export interface NotebookFileInfo {
	path: string;
	mtime: number;
	size: number;
}

/** Cover colours offered in the library; the first is the default. */
export const COVER_COLORS = [
	"#3b82f6", "#3fa7a0", "#5aa469", "#c9a227", "#e08a3c",
	"#d9534f", "#c2569b", "#8a63d2", "#6b7280", "#2f3a4a",
] as const;
/** Same default as new documents (DEFAULT_META), so library cards match the files. */
export const DEFAULT_COVER: string = DEFAULT_META.cover;

const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(v: unknown): v is string {
	return typeof v === "string" && HEX.test(v);
}

/** Files that are new or changed since they were indexed. */
export function filesToRead(files: readonly NotebookFileInfo[], index: LibraryIndex): NotebookFileInfo[] {
	return files.filter((f) => index.isStale(f.path, f.mtime, f.size));
}

/** Most text indexed per notebook (characters). */
export const TEXT_CAP = 20_000;

/** Text of the text boxes of all pages, whitespace collapsed, capped; with the offset where each page's text begins. */
export function extractText(doc: NotebookDocument, cap = TEXT_CAP): { text: string; textPages: number[] } {
	let text = "";
	const textPages: number[] = [];
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	for (let p = 0; p < pages.length && text.length < cap; p++) {
		const parts: string[] = [];
		for (const el of pages[p]?.elements ?? []) {
			if (el.type !== "text" || typeof el.text !== "string") continue;
			const t = el.text.replace(/\s+/g, " ").trim();
			if (t) parts.push(t);
		}
		if (parts.length === 0) continue;
		const sep = text.length > 0 ? "\n" : "";
		textPages.push(p, text.length + sep.length);
		text = (text + sep + parts.join(" ")).slice(0, cap);
	}
	return { text, textPages };
}

export type DocumentFields = Pick<LibraryEntry, "pages" | "tags" | "favorite" | "cover" | "created" | "modified" | "text" | "textPages" | "pageTags">;

/** v7 page tags for the index: the pages that have tags (0-based), with their tags. */
export function extractPageTags(doc: NotebookDocument): Array<{ page: number; tags: string[] }> {
	const out: Array<{ page: number; tags: string[] }> = [];
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	pages.forEach((p, page) => {
		const tags = normalizePageTags(Array.isArray(p?.tags) ? p.tags : undefined);
		if (tags) out.push({ page, tags });
	});
	return out;
}

function time(v: unknown, fallback: number): number {
	const ms = typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(ms) ? ms : fallback;
}

/** Index fields from a parsed document. Tolerates documents without v4 `meta` and partial or odd meta. */
export function metaFromDocument(doc: NotebookDocument, fallbackTime = 0): DocumentFields {
	const meta: Partial<NonNullable<NotebookDocument["meta"]>> = doc.meta ?? {};
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const raw of Array.isArray(meta.tags) ? (meta.tags as unknown[]) : []) {
		const tag = typeof raw === "string" ? raw.trim() : "";
		const key = tag.toLowerCase();
		if (tag && !seen.has(key)) {
			seen.add(key);
			tags.push(tag);
		}
	}
	const created = time(doc.createdAt, fallbackTime);
	const { text, textPages } = extractText(doc);
	const pageTags = extractPageTags(doc);
	return {
		...(text ? { text, textPages } : {}),
		...(pageTags.length > 0 ? { pageTags } : {}),
		pages: Array.isArray(doc.pages) ? doc.pages.length : 0,
		tags,
		favorite: meta.favorite === true,
		cover: isHexColor(meta.cover) ? meta.cover : DEFAULT_COVER,
		created,
		modified: time(doc.modifiedAt, created || fallbackTime),
	};
}

/**
 * Index entry for a file. `doc` is null when the file could not be read: the entry is kept (pages = 0)
 * so the file is not read again until it changes. The previous thumbnail is kept until a new one is rendered.
 */
export function entryFromFile(file: NotebookFileInfo, doc: NotebookDocument | null, previous?: LibraryEntry): LibraryEntry {
	const base = {
		path: file.path,
		folder: folderOf(file.path),
		name: nameOf(file.path),
		mtime: file.mtime,
		size: file.size,
	};
	const thumb = previous?.thumb === undefined ? {} : { thumb: previous.thumb, thumbMtime: previous.thumbMtime ?? -1 };
	if (!doc) {
		return { ...base, created: file.mtime, modified: file.mtime, pages: 0, tags: [], favorite: false, cover: DEFAULT_COVER, ...thumb };
	}
	return { ...base, ...metaFromDocument(doc, file.mtime), ...thumb };
}

/** Normalises a user-typed tag list: strips a leading "#", trims, drops empties and case-insensitive duplicates. */
export function parseTags(input: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const part of input.split(/[,\n;]/)) {
		const tag = part.trim().replace(/^#+\s*/, "").trim();
		const key = tag.toLowerCase();
		if (tag && !seen.has(key)) {
			seen.add(key);
			out.push(tag);
		}
	}
	return out;
}
