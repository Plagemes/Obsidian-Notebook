/**
 * v7 reading position shared across devices (roadmap #125). Pure, no Obsidian.
 *
 * The notebook stores where it was last read (`doc.position`: page id, y at the top of the view, time), so
 * another device that opens it can start there. To avoid sync churn the position is never written on its
 * own: the session copies the current position into the document only when it serializes a revision it is
 * saving anyway (a content change, also the flush when the view closes). Two devices then never write just
 * because they look at different pages; when both edit, the last writer wins.
 */
import type { NotebookDocument, ReadingPosition } from "./types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Position with `y` rounded to 0.01 pt (absent when not > 0), or undefined when its page is not in `pageIds`. */
export function normalizePosition(p: ReadingPosition | undefined, pageIds: ReadonlySet<string>): ReadingPosition | undefined {
	if (!p || typeof p.page !== "string" || !pageIds.has(p.page) || typeof p.at !== "string" || p.at.length === 0) return undefined;
	const out: ReadingPosition = { page: p.page, at: p.at };
	if (typeof p.y === "number" && Number.isFinite(p.y)) {
		const y = round2(p.y);
		if (y > 0) out.y = y;
	}
	return out;
}

/** The position `{ page, y }` of page `index` at time `at`, or undefined when there is no such page. */
export function positionAt(doc: NotebookDocument, index: number, y: number, at: Date): ReadingPosition | undefined {
	const page = doc.pages[index];
	if (!page) return undefined;
	return normalizePosition({ page: page.id, y: Math.min(Math.max(0, y), page.height), at: at.toISOString() }, new Set([page.id]));
}

export function samePlace(a: ReadingPosition | undefined, b: ReadingPosition | undefined): boolean {
	return (a?.page ?? null) === (b?.page ?? null) && (a?.y ?? 0) === (b?.y ?? 0);
}

/**
 * Puts `next` into `doc.position` (called only for a revision that is being saved anyway, so the time is
 * the time of that save). A missing `next` (no page in view) keeps the stored position.
 */
export function updatePosition(doc: NotebookDocument, next: ReadingPosition | undefined): void {
	if (next) doc.position = { ...next };
}

/** Page index (0-based) and y of the stored position, or null when the notebook has none (or its page is gone). */
export function resolvePosition(doc: NotebookDocument): { index: number; y: number } | null {
	const p = doc.position;
	if (!p) return null;
	const index = doc.pages.findIndex((page) => page.id === p.page);
	if (index < 0) return null;
	return { index, y: p.y ?? 0 };
}

function time(iso: string | null | undefined): number {
	const ms = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Where to start reading when a notebook opens.
 * - `link`: a page asked for explicitly (a `#p3` link, a search hit): always wins.
 * - `restored`: the page this device was on (workspace layout, "Continue last notebook"), recorded at `localAt`.
 * - the notebook's stored position, written by whichever device saved last.
 * The stored position wins over `restored` only when it is newer, i.e. another device was there later.
 * Returns null to keep the default (top of the first page).
 */
export function chooseStart(
	doc: NotebookDocument,
	request: { link?: number | null; restored?: number | null; localAt?: string | null },
): { index: number; y: number } | null {
	const clamp = (page: number) => Math.min(doc.pages.length, Math.max(1, page)) - 1;
	if (request.link != null) return { index: clamp(request.link), y: 0 };
	const stored = resolvePosition(doc);
	if (request.restored != null) {
		if (stored && time(doc.position?.at) > time(request.localAt)) return stored;
		return { index: clamp(request.restored), y: 0 };
	}
	return stored;
}
