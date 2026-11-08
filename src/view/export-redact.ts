// 0.26 redact (#285): how every writer applies the redaction boxes. A writer calls `withRedaction` on the pages it is given and draws what
// comes back; it never needs to know how a box works. The pure part (what is cut, what is dropped) is ink/redact.ts.
import { t } from "../i18n";
import { headerAfterRedaction, redactPages } from "../ink/redact";
import { boxesOf, countBoxes } from "../model/redact";
import type { Page } from "../model/types";
import type { ExportOptions } from "./export";
import { showNotice } from "./notice";

/**
 * The pages as an export draws them when redaction boxes are set (`options.redact`), and the options that go with them (the header or
 * footer of a covered page is left out). Pages without boxes are the same objects; a page already redacted is not done twice. Applied by
 * each writer on its own, so a path that forgets the dialog still covers what the reader chose.
 */
export function withRedaction(pages: readonly Page[], options: ExportOptions): { pages: readonly Page[]; options: ExportOptions } {
	const boxes = options.redact;
	if (!boxes || countBoxes(boxes) === 0 || !pages.some((p) => boxesOf(boxes, p.id).length > 0)) return { pages, options };
	const header = options.header;
	return {
		pages: redactPages(pages, boxes),
		options: { ...options, ...(header ? { header: (p: Page) => headerAfterRedaction(header(p), p) } : {}) },
	};
}

/** How many boxes the redaction of `pages` covers (0 when `options.redact` has none for them), to tell the reader it was applied. */
export function redactionCount(pages: readonly Page[], options: ExportOptions): number {
	const boxes = options.redact;
	if (!boxes) return 0;
	return pages.reduce((n, p) => n + boxesOf(boxes, p.id).length, 0);
}

/** One notice that says the redaction was applied to an export (nothing when no box touches the exported pages). */
export function announceRedaction(pages: readonly Page[], options: ExportOptions): void {
	const n = redactionCount(pages, options);
	if (n > 0) showNotice(t(n === 1 ? "redact.applied.one" : "redact.applied", { n: String(n) }), 7000);
}
