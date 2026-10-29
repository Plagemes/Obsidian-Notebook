import type { Page } from "../model/types";

/**
 * HOOK: tag a new lecture page with its course (roadmap 115, "new pages are tagged with the course in progress").
 *
 * Page tags do not exist in the document format yet (another change adds them), and this feature must not change
 * the format. Until then this returns the page unchanged. When page tags exist, implement this function ONLY: make
 * the page's tags include `course` (using the model's own helper and freezing rules) and set `PAGE_TAG_HOOK_ACTIVE`
 * to true. It is called for every page created by "New lecture" (with a course known from the timetable) and by the
 * timetable's "open the current class" flow, before the page is added to the document.
 */
export const PAGE_TAG_HOOK_ACTIVE = false;

export function applyCourseTag(page: Page, course: string): Page {
	void course;
	return page;
}
