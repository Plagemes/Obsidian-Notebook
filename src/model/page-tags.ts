/**
 * v7 page tags (roadmap #119): tags on single pages, filterable in the navigator and searchable in the
 * library. Pure, no Obsidian. Stored as `page.tags` (written only when not empty).
 */
import type { Command } from "./history";
import type { NotebookDocument, Page } from "./types";

/** Longest page tag kept (characters) and most tags per page. */
export const MAX_PAGE_TAG = 64;
export const MAX_PAGE_TAGS = 50;

/** A tag as stored: leading "#" removed, whitespace collapsed, trimmed, capped; null when nothing is left. */
export function normalizePageTag(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const tag = raw.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").trim().slice(0, MAX_PAGE_TAG).trim();
	return tag.length > 0 ? tag : null;
}

/** Normalised tags without case-insensitive duplicates (the first spelling wins), in order; undefined when empty. */
export function normalizePageTags(tags: readonly unknown[] | undefined): string[] | undefined {
	if (!tags) return undefined;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const tag = normalizePageTag(raw);
		if (tag === null) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
		if (out.length >= MAX_PAGE_TAGS) break;
	}
	return out.length > 0 ? out : undefined;
}

/** Tags typed by the user, separated by commas, semicolons, new lines or spaces before a "#". */
export function parsePageTagInput(input: string): string[] {
	return normalizePageTags(input.split(/[,;\n]|\s+(?=#)/)) ?? [];
}

export function pageHasTag(page: Page, tag: string): boolean {
	const key = tag.toLowerCase();
	return (page.tags ?? []).some((t) => t.toLowerCase() === key);
}

/** Tags used on the pages, with the number of pages, most used first (ties alphabetically). Case-insensitive. */
export function pageTagCounts(pages: readonly Page[]): Array<{ tag: string; count: number }> {
	const counts = new Map<string, { tag: string; count: number }>();
	for (const page of pages) {
		for (const tag of page.tags ?? []) {
			const key = tag.toLowerCase();
			const c = counts.get(key);
			if (c) c.count++;
			else counts.set(key, { tag, count: 1 });
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function sameTags(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((t, i) => t === y[i]);
}

/** Tags of both lists (`main` first), case-insensitive duplicates removed; undefined when empty. */
export function unionPageTags(main: readonly string[] | undefined, other: readonly string[] | undefined): string[] | undefined {
	return normalizePageTags([...(main ?? []), ...(other ?? [])]);
}

/** Replaces the tags of a page. A missing page is a no-op both ways. */
export class SetPageTags implements Command {
	readonly label = "Change page tags";
	private readonly before: string[] | undefined;
	private readonly after: string[] | undefined;
	constructor(readonly pageId: string, before: readonly string[] | undefined, after: readonly string[] | undefined) {
		this.before = normalizePageTags(before);
		this.after = normalizePageTags(after);
	}

	private set(doc: NotebookDocument, tags: string[] | undefined): void {
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		if (tags) page.tags = [...tags];
		else delete page.tags;
	}

	apply(doc: NotebookDocument): void {
		this.set(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		this.set(doc, this.before);
	}
}
