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
 * instead (see infinite.ts), and pages with a PDF or image background are left alone.
 */
export function needsNextPage(
	page: AutoPageTarget, isLast: boolean, maxY: number, enabled: boolean, margin = AUTO_PAGE_MARGIN,
): boolean {
	if (!enabled || !isLast || page.infinite || page.background) return false;
	return Number.isFinite(maxY) && maxY >= page.height * (1 - margin);
}
