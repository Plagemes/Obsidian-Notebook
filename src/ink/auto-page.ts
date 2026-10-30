/** Writing in the bottom tenth of the last page appends a page. */
export const AUTO_PAGE_MARGIN = 0.1;

export interface AutoPageTarget {
	height: number;
	infinite?: boolean;
	/** A PDF or scanned page: the next page would not continue its background, so none is added. */
	background?: unknown;
}

/**
 * Should a new page be appended after ink that reaches down to `maxY` (page coordinates) on `page`?
 * Only the last page of the document qualifies, and only when the setting is on. Infinite pages grow
 * instead (see infinite.ts), and pages with a PDF or image background are left alone. Pages in the middle
 * get an offer instead (needsPageOffer).
 */
export function needsNextPage(
	page: AutoPageTarget, isLast: boolean, maxY: number, enabled: boolean, margin = AUTO_PAGE_MARGIN,
): boolean {
	if (!enabled || !isLast) return false;
	return reachesBottom(page, maxY, margin);
}

/** Plain, finite page (no PDF or image background, not infinite) and ink down to its bottom margin. */
function reachesBottom(page: AutoPageTarget, maxY: number, margin: number): boolean {
	if (page.infinite || page.background) return false;
	return Number.isFinite(maxY) && maxY >= page.height * (1 - margin);
}

/**
 * Roadmap 389 (extends 95): ink reaches the bottom of a page that is NOT the last one. A page is never added by itself in
 * the middle of a notebook (that would shift every later page, links and bookmarks included): the view only offers to
 * insert one right after it. Same conditions and the same setting as needsNextPage.
 */
export function needsPageOffer(
	page: AutoPageTarget, isLast: boolean, maxY: number, enabled: boolean, margin = AUTO_PAGE_MARGIN,
): boolean {
	if (!enabled || isLast) return false;
	return reachesBottom(page, maxY, margin);
}

/**
 * Remembers the pages the offer was already made for (and answered or ignored), so writing on at the bottom of a page does
 * not bring the offer back for every stroke. Per view, forgotten when the document is replaced.
 */
export class OfferGate {
	private readonly settled = new Set<string>();

	/** The offer may be shown for this page. */
	allows(pageId: string): boolean {
		return !this.settled.has(pageId);
	}

	/** The offer for this page was taken, dismissed or timed out: do not show it again. */
	settle(pageId: string): void {
		this.settled.add(pageId);
	}

	reset(): void {
		this.settled.clear();
	}
}
