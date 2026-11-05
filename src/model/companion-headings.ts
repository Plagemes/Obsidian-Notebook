/**
 * 0.20 (#102): headings found in the handwriting, as pictures in the companion note. Pure: no DOM, no 'obsidian', no format
 * change. The note gets, under the heading of a page that has some, one line per heading,
 * `- heading: ![[Notebook (Headings)/p3-h1.png|220]]`; the line is only the embed the plugin made itself, so the region of the
 * note stays plain Markdown (no text of the handwriting exists: there is no OCR). The pictures are written by the companion
 * service (src/integration/companion.ts), named by page and position so a changed heading rewrites its picture instead of
 * adding another.
 */
import type { PageHeading } from "../ink/headings";
import type { PageHeadingList } from "./heading-index";

/** Most headings written for one page. */
export const COMPANION_HEADINGS_PER_PAGE = 4;
/** Most pictures kept for one notebook (a very large notebook must not fill the vault with small pictures). */
export const COMPANION_HEADINGS_MAX = 60;
/** Width the pictures are shown at in the note, px. */
export const COMPANION_HEADING_WIDTH = 220;
/** Widest picture drawn, px (the note shows it smaller; this keeps the files small). */
export const COMPANION_HEADING_PIXELS = 520;

export interface HeadingPick {
	pageId: string;
	/** 0-based page index. */
	index: number;
	/** 0-based position among the page's picks. */
	n: number;
	heading: PageHeading;
}

/** The headings that get a picture: the first few of each page, in page order, within the notebook's bound. */
export function pickCompanionHeadings(lists: readonly PageHeadingList[]): HeadingPick[] {
	const out: HeadingPick[] = [];
	for (const list of lists) {
		list.headings.slice(0, COMPANION_HEADINGS_PER_PAGE).forEach((heading, n) => {
			if (out.length < COMPANION_HEADINGS_MAX) out.push({ pageId: list.pageId, index: list.index, n, heading });
		});
	}
	return out;
}

/** File name of a heading's picture: `p3-h1.png` (1-based page and position). */
export function headingPictureName(pick: Pick<HeadingPick, "index" | "n">): string {
	return `p${pick.index + 1}-h${pick.n + 1}.png`;
}

/** An embed the plugin made (a wiki embed or a Markdown image), on one line, with nothing that could end the generated region or open a block. */
export function safeEmbed(embed: string): string | null {
	if (/[\r\n]/.test(embed) || embed.includes("%%") || embed.includes("<")) return null;
	if (/^!\[\[[^\]|]+(\|\d+)?\]\]$/.test(embed)) return embed;
	if (/^!\[[^\]]*\]\((<[^>\n]+>|[^)\s]+)\)$/.test(embed)) return embed;
	return null;
}

/** The note lines of one page's headings, from the embeds the service made (`null` for a picture that could not be made is simply left out). */
export function headingLines(embeds: readonly (string | null)[]): string[] {
	const out: string[] = [];
	for (const embed of embeds) {
		const ok = embed === null ? null : safeEmbed(embed);
		if (ok) out.push(`- heading: ${ok}`);
	}
	return out;
}
