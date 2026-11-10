// 0.26 redact (#285): how every writer applies the redaction boxes. A writer calls `withRedaction` on the pages it is given and draws what
// comes back; it never needs to know how a box works. The pure part (what is cut, what is dropped) is ink/redact.ts.
//
// Review fixes: the redaction FAILS CLOSED. When the boxes of a notebook cannot be read on this device (`options.redactBlocked`), every
// writer that goes through here refuses to write (`RedactionUnavailableError`, with a message the reader can act on) instead of writing the
// pages as they are. An excerpt of a region covered on another page is left out too (ink/redact.ts `coveredExcerpt`).
import { t } from "../i18n";
import { withFigureScope } from "../ink/figure-text";
import { hasRedactions, headerAfterRedaction, redactPages } from "../ink/redact";
import { boxesOf, countBoxes, staleRedactionPages } from "../model/redact";
import type { Page } from "../model/types";
import type { ExportOptions } from "./export";
import { showNotice } from "./notice";

/** Thrown by `withRedaction` when the boxes of the notebook cannot be read: nothing must be written. Its message is shown as it is. */
export class RedactionUnavailableError extends Error {
	constructor(stale = false) {
		super(t(stale ? "redact.stale" : "redact.unreadable"));
		this.name = "RedactionUnavailableError";
	}
}

/** 0.28 (#76): the message of a refusal: the boxes cannot be read, or they were drawn on another turn or crop of a PDF page than the one it shows now. */
export function redactBlockedMessage(options: Pick<ExportOptions, "redactStale">): string {
	return t(options.redactStale === true ? "redact.stale" : "redact.unreadable");
}

/**
 * True, after a notice that says why, when an export must not start because the boxes of the notebook cannot be read: the writers that
 * do work before `withRedaction` (or outside a try) ask this first. `withRedaction` refuses on its own anyway.
 */
export function redactionRefused(options: ExportOptions): boolean {
	if (options.redactBlocked !== true) return false;
	showNotice(redactBlockedMessage(options), 10000);
	return true;
}

/** Throws `RedactionUnavailableError` when the options say the boxes of the notebook could not be read (or are stale, see `withRedaction`). */
export function assertRedactionReadable(options: ExportOptions): void {
	if (options.redactBlocked === true) throw new RedactionUnavailableError(options.redactStale === true);
}

/**
 * The pages as an export draws them when redaction boxes are set (`options.redact`), and the options that go with them (the header or
 * footer of a covered page is left out). Pages without boxes are the same objects; a page already redacted is not done twice. Applied by
 * each writer on its own, so a path that forgets the dialog still covers what the reader chose. Throws `RedactionUnavailableError` when
 * the boxes are on but could not be read.
 */
export function withRedaction(pages: readonly Page[], options: ExportOptions): { pages: readonly Page[]; options: ExportOptions } {
	assertRedactionReadable(options);
	const boxes = options.redact;
	// 0.28 (#76), fail closed: a page turned or cropped after its boxes were drawn is never written (its boxes are where the old page was).
	if (boxes && staleRedactionPages(pages, boxes).length > 0) throw new RedactionUnavailableError(true);
	if (!boxes || countBoxes(boxes) === 0) return { pages, options };
	// Review fix (F4): the boxes are worked out on the text as the file will show it ("Fig. 12", not "Fig. ?"): the same figure scope as the writer.
	const covered = withFigureScope(options.figures, () => (hasRedactions(pages, boxes) ? redactPages(pages, boxes) : null));
	if (!covered) return { pages, options };
	const header = options.header;
	return {
		pages: covered,
		options: { ...options, ...(header ? { header: (p: Page) => headerAfterRedaction(header(p), p) } : {}) },
	};
}

/** How many boxes the redaction of `pages` covers (0 when `options.redact` has none for them), to tell the reader it was applied. */
export function redactionCount(pages: readonly Page[], options: ExportOptions): number {
	const boxes = options.redact;
	if (!boxes) return 0;
	return pages.reduce((n, p) => n + boxesOf(boxes, p.id).length, 0);
}

/**
 * One notice that says the redaction was applied to an export (nothing when no box touches the exported pages). Review fix (P10): when the
 * notebook has boxes that are switched off (`options.redactOff`), one quiet hint says so instead.
 */
export function announceRedaction(pages: readonly Page[], options: ExportOptions): void {
	const n = redactionCount(pages, options);
	if (n > 0) showNotice(t(n === 1 ? "redact.applied.one" : "redact.applied", { n: String(n) }), 7000);
	else announceRedactionOff(options);
}

/** Review fix (P10): the quiet hint of an export that a notebook with switched-off boxes made (nothing otherwise). */
export function announceRedactionOff(options: ExportOptions): void {
	if ((options.redactOff ?? 0) > 0 && !options.redact) showNotice(t("redact.offHint"), 4000);
}
