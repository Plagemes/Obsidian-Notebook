// Coloured sections (0.30, #52): the pure parts of the view side (no 'obsidian'), tested in Node.
import { resolveSections, sectionAtIndex, sectionsOf, type ResolvedSection } from "../model/sections";
import type { NotebookDocument, Section } from "../model/types";
import { SUBJECT_COLORS } from "../ui/palette";

/** The UI context of the sections for page `index` (ui/actions.ts `UiContext.sections`). */
export function sectionsContext(doc: NotebookDocument | null, index: number): { count: number; here: boolean; starts: boolean } {
	if (!doc) return { count: 0, here: false, starts: false };
	const resolved = resolveSections(doc.pages, sectionsOf(doc));
	const at = sectionAtIndex(resolved, index);
	return { count: resolved.length, here: !!at, starts: !!at && at.start === index };
}

/** A palette colour (`#rrggbb`, lower case) that no section uses yet; the next one in palette order when all are used. */
export function nextSectionColor(sections: readonly Section[]): string {
	const used = new Set(sections.map((s) => s.color.toLowerCase()));
	const free = SUBJECT_COLORS.find((c) => !used.has(c.base.toLowerCase()));
	return (free ?? SUBJECT_COLORS[sections.length % SUBJECT_COLORS.length]!).base.toLowerCase();
}

/**
 * Where "next section" (+1) or "previous section" (-1) goes from page `index`: the start of the next section; backwards, the start of the
 * section the page is in when the page is past it, else the start of the section before. Null when there is none that way.
 */
export function stepTarget(all: readonly ResolvedSection[], index: number, by: 1 | -1): ResolvedSection | null {
	if (by > 0) return all.find((r) => r.start > index) ?? null;
	const here = sectionAtIndex(all, index);
	if (here && here.start < index) return here;
	for (let i = all.length - 1; i >= 0; i--) if (all[i]!.start < index) return all[i]!;
	return null;
}

/** "Pages 3–7" or "Page 3" parts for a section row: the first and last page numbers (1-based) and the count. */
export function sectionSpan(r: ResolvedSection): { first: number; last: number; count: number } {
	return { first: r.start + 1, last: r.end + 1, count: r.count };
}
