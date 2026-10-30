import { normalizePageTag, unionPageTags } from "../model/page-tags";
import type { Page } from "../model/types";

/**
 * Tags a new lecture page with its course (roadmap 115, "new pages are tagged with the course in progress"), using the
 * v7 page tags (`page.tags`, model/page-tags.ts).
 *
 * Called for every page created by "New lecture" (with a course known from the timetable) and by the timetable's
 * "open the current class" flow, before the page is added to the document: the tag is part of the page that the
 * `AddPage` command inserts, so it is in the same undo step. The page is never modified in place (a copy is returned);
 * a course that normalises to nothing leaves the page as it is.
 */
export const PAGE_TAG_HOOK_ACTIVE = true;

export function applyCourseTag(page: Page, course: string): Page {
	const tag = normalizePageTag(course);
	if (tag === null) return page;
	const tags = unionPageTags(page.tags, [tag]);
	return tags ? { ...page, tags } : page;
}
