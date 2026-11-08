/**
 * 0.24 tagsuggest (#411): gathers the context the tag suggestions are ranked from (model/tag-suggest.ts). Pure: no 'obsidian'.
 * Reads only what is already in the document, the library index and the timetable.
 */
import { linkCovers, type ClassEntry, type Timetable } from "../timetable/schedule";
import { suggestFromContext, type TagStyle } from "./tag-suggest";
import type { NotebookDocument, Page } from "./types";

/** Most text taken from one notebook (characters): suggestions never need more, and a long notebook stays cheap. */
const MAX_TEXT = 20_000;

/** Course of the class linked to the notebook: a link to the notebook itself beats a folder, a deeper folder beats a shallower one. */
export function courseForTags(tt: Timetable | null | undefined, notebookPath: string | null | undefined): string | null {
	if (!tt || !notebookPath) return null;
	let best: { entry: ClassEntry; depth: number } | null = null;
	for (const e of tt.entries) {
		if (!e.course.trim() || !linkCovers(e.notebook, notebookPath)) continue;
		const link = (e.notebook ?? "").replace(/\/+$/, "");
		const depth = link === notebookPath ? Infinity : link.split("/").length;
		if (!best || depth > best.depth) best = { entry: e, depth };
	}
	return best?.entry.course.trim() ?? null;
}

/** Parent folder of a vault path ("" at the root). */
function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** Tags of the other notebooks in the folder of `path`. */
export function siblingTagLists(entries: Iterable<{ path: string; tags: readonly string[] }>, path: string): string[][] {
	const folder = folderOf(path);
	const out: string[][] = [];
	for (const e of entries) if (e.path !== path && folderOf(e.path) === folder && e.tags.length > 0) out.push([...e.tags]);
	return out;
}

export interface PageSignals {
	text: string[];
	headings: string[];
	kinds: string[];
}

/** Typed text, box titles and kinds of the markers and boxes on a page. */
export function pageSignals(page: Page | undefined): PageSignals {
	const out: PageSignals = { text: [], headings: [], kinds: [] };
	for (const el of page?.elements ?? []) {
		if (el.type === "text" && typeof el.text === "string") out.text.push(el.text);
		else if (el.type === "marker") out.kinds.push(el.kind);
		else if (el.type === "box") {
			out.kinds.push(el.kind);
			if (typeof el.title === "string") out.headings.push(el.title);
		}
	}
	return out;
}

/** Signals of a whole notebook: bookmark titles count as headings. Capped. */
export function documentSignals(doc: Pick<NotebookDocument, "pages" | "meta"> | null | undefined): PageSignals {
	const out: PageSignals = { text: [], headings: [], kinds: [] };
	if (!doc) return out;
	let size = 0;
	for (const page of doc.pages ?? []) {
		const s = pageSignals(page);
		for (const text of s.text) {
			if (size >= MAX_TEXT) break;
			out.text.push(text);
			size += text.length;
		}
		out.headings.push(...s.headings);
		out.kinds.push(...s.kinds);
	}
	for (const info of Object.values(doc.meta?.bookmarkInfo ?? {})) if (typeof info?.title === "string" && info.title) out.headings.push(info.title);
	return out;
}

export interface TagContextInput {
	enabled: boolean;
	timetable?: Timetable | null;
	notebookPath?: string | null;
	siblings?: ReadonlyArray<readonly string[]>;
	signals?: PageSignals;
	existing?: readonly string[];
	style?: TagStyle;
}

/** The chips to show in a tag editor; empty when the setting is off. */
export function tagSuggestionsFor(input: TagContextInput): string[] {
	if (!input.enabled) return [];
	const s = input.signals;
	return suggestFromContext({
		course: courseForTags(input.timetable, input.notebookPath),
		siblingTags: input.siblings,
		headings: s?.headings,
		text: s?.text,
		kinds: s?.kinds,
		existing: input.existing,
		style: input.style,
	});
}
