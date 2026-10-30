/** Pure helper for "open the current class": do not add a second page for the same lecture. */
import type { Page } from "../model/types";
import { lectureHeaderText } from "../view/lecture-logic";

/** Index of the page that already carries this lecture's header (course and date), or -1. */
export function findLecturePage(pages: readonly Page[], course: string, date: Date): number {
	const header = lectureHeaderText(course, date);
	return pages.findIndex((p) => (p.elements ?? []).some((el) => el.type === "text" && el.text === header));
}
