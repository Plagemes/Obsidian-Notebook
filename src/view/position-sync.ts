/**
 * v7 reading position shared across devices (roadmap #125): the glue between the notebook view's state and
 * model/position.ts. Pure, no 'obsidian'.
 *
 * - The workspace layout stores the page this device was on (`page`, as before) and, new, when it was there
 *   (`pageAt`). On a layout restore the notebook's stored position wins only when it is newer, i.e. another
 *   device read (and saved) the notebook later.
 * - A page asked for explicitly (a `#p3` link, a search hit, "Continue last notebook") has no `pageAt` and
 *   always wins.
 * - Opening a notebook without a page starts at its stored position.
 */
import { chooseStart } from "../model/position";
import type { NotebookDocument } from "../model/types";

/** Key of the view state that says when the reader was on the stored `page` (ISO time). */
export const PAGE_AT_KEY = "pageAt";

/** The `pageAt` of a view state, or null (an explicit page request). */
export function pageAtFromState(state: unknown): string | null {
	if (typeof state !== "object" || state === null) return null;
	const v = (state as Record<string, unknown>)[PAGE_AT_KEY];
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** What a view state adds for a page in view at `now`. */
export function pageState(page: number, now: Date): Record<string, unknown> {
	return { page, [PAGE_AT_KEY]: now.toISOString() };
}

/**
 * Where a freshly loaded notebook starts: `requested` is the page asked for (1-based) or null, `requestedAt`
 * its `pageAt` (null when it was an explicit request). Null keeps the default (the top of the first page).
 */
export function startPosition(doc: NotebookDocument, requested: number | null, requestedAt: string | null): { index: number; y: number } | null {
	if (requested === null) return chooseStart(doc, {});
	return requestedAt === null ? chooseStart(doc, { link: requested }) : chooseStart(doc, { restored: requested, localAt: requestedAt });
}
