/**
 * 0.16 (#90) Highlights digest: every highlighted region of a notebook collected in a Markdown note. Pure: no 'obsidian'
 * import, so it runs in Node tests. The view side (view/highlight-digest.ts) renders the crops and writes the note.
 *
 * - `highlightRegions` finds the highlighter strokes of each page and joins the ones that are close together and of the
 *   same colour into a region (a highlighted paragraph is many strokes, one per line).
 * - `buildDigestSection` writes the Markdown between the two marker comments; `replaceDigestSection` puts it into the
 *   note, replacing only what is between the markers and never touching the text outside them. The same input always
 *   gives the same note, so running the digest twice changes nothing.
 * The document format is not touched: the digest is derived data, written to a separate note.
 */
import { uniqueFileName } from "./export-markdown";
import type { Page, Stroke } from "./types";
import type { TextBand } from "../pdf/region-text";

export const DIGEST_START = "<!-- notebook-digest:start -->";
export const DIGEST_END = "<!-- notebook-digest:end -->";

/** Highlighter strokes closer than this (pt) and of one colour belong to one region. */
export const REGION_GAP = 14;
/** The picture of a region shows this much around it (pt), inside the page. */
export const CROP_PAD_X = 14;
export const CROP_PAD_Y = 10;
/** The smallest crop (pt), so a tiny mark still shows its surroundings. */
export const CROP_MIN = { width: 80, height: 40 };

export interface DigestRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HighlightRegion {
	pageIndex: number;
	pageId: string;
	/** `#rrggbb`, lower case. */
	colour: string;
	/** What the strokes cover (page coordinates, pt). */
	rect: DigestRect;
	strokeIds: string[];
	/** Horizontal bands the strokes cover, for the text under them. */
	bands: TextBand[];
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function inflate(r: Box, d: number): Box {
	return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d };
}

/** Bounding box of a stroke's points, grown by half its width. Null for a stroke with no finite point. */
export function strokeBox(stroke: Pick<Stroke, "points" | "width">): Box | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of stroke.points) {
		const x = p[0], y = p[1];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
	}
	if (x0 > x1 || y0 > y1) return null;
	return inflate({ x0, y0, x1, y1 }, Math.max(0.5, stroke.width / 2));
}

/**
 * The horizontal bands a stroke covers: one box for a straight-ish stroke, several for one that wanders over lines (the
 * points are cut into runs that stay within about one stroke width in height), so the text under it is the text it crosses.
 */
export function strokeBands(stroke: Pick<Stroke, "points" | "width">): TextBand[] {
	const half = Math.max(0.5, stroke.width / 2);
	const limit = Math.max(1, stroke.width) * 1.5;
	const out: TextBand[] = [];
	let cur: Box | null = null;
	let last: readonly number[] | null = null;
	for (const p of stroke.points) {
		const x = p[0], y = p[1];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		if (cur && Math.max(cur.y1, y) - Math.min(cur.y0, y) > limit) {
			out.push(inflate(cur, half));
			cur = last ? { x0: last[0]!, y0: last[1]!, x1: last[0]!, y1: last[1]! } : null;
		}
		if (!cur) cur = { x0: x, y0: y, x1: x, y1: y };
		else {
			cur.x0 = Math.min(cur.x0, x);
			cur.x1 = Math.max(cur.x1, x);
			cur.y0 = Math.min(cur.y0, y);
			cur.y1 = Math.max(cur.y1, y);
		}
		last = p;
	}
	if (cur) out.push(inflate(cur, half));
	return out;
}

const normColour = (c: string): string => c.trim().toLowerCase();

/**
 * The highlighted regions of `pages` (the pages as shown: pass the live state views), page by page, top to bottom then left to
 * right. Hidden (invisible-ink) strokes are left out. Strokes of one colour whose boxes are within `gap` of each other are one region.
 */
export function highlightRegions(pages: readonly Page[], gap = REGION_GAP): HighlightRegion[] {
	const out: HighlightRegion[] = [];
	pages.forEach((page, pageIndex) => {
		const items: Array<{ stroke: Stroke; box: Box; colour: string }> = [];
		for (const stroke of page.strokes) {
			if (stroke.tool !== "highlighter" || stroke.hidden) continue;
			const box = strokeBox(stroke);
			if (box) items.push({ stroke, box, colour: normColour(stroke.color) });
		}
		const parent = items.map((_, i) => i);
		const find = (i: number): number => {
			while (parent[i] !== i) {
				parent[i] = parent[parent[i]!]!;
				i = parent[i]!;
			}
			return i;
		};
		const near = gap / 2;
		for (let i = 0; i < items.length; i++) {
			const a = inflate(items[i]!.box, near);
			for (let j = i + 1; j < items.length; j++) {
				if (items[i]!.colour !== items[j]!.colour) continue;
				const b = inflate(items[j]!.box, near);
				if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) parent[find(j)] = find(i);
			}
		}
		const groups = new Map<number, number[]>();
		items.forEach((_, i) => {
			const r = find(i);
			const list = groups.get(r);
			if (list) list.push(i);
			else groups.set(r, [i]);
		});
		const regions: HighlightRegion[] = [];
		for (const members of groups.values()) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			const bands: TextBand[] = [];
			for (const i of members) {
				const b = items[i]!.box;
				x0 = Math.min(x0, b.x0);
				y0 = Math.min(y0, b.y0);
				x1 = Math.max(x1, b.x1);
				y1 = Math.max(y1, b.y1);
				bands.push(...strokeBands(items[i]!.stroke));
			}
			regions.push({
				pageIndex, pageId: page.id, colour: items[members[0]!]!.colour,
				rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
				strokeIds: members.map((i) => items[i]!.stroke.id), bands,
			});
		}
		regions.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
		out.push(...regions);
	});
	return out;
}

/** The part of the page to draw for a region: the region with a margin, inside the page, at least `CROP_MIN`. */
export function cropRect(region: HighlightRegion, page: Pick<Page, "width" | "height">): DigestRect {
	let x0 = region.rect.x - CROP_PAD_X;
	let y0 = region.rect.y - CROP_PAD_Y;
	let x1 = region.rect.x + region.rect.width + CROP_PAD_X;
	let y1 = region.rect.y + region.rect.height + CROP_PAD_Y;
	if (x1 - x0 < CROP_MIN.width) {
		const c = (x0 + x1) / 2;
		x0 = c - CROP_MIN.width / 2;
		x1 = c + CROP_MIN.width / 2;
	}
	if (y1 - y0 < CROP_MIN.height) {
		const c = (y0 + y1) / 2;
		y0 = c - CROP_MIN.height / 2;
		y1 = c + CROP_MIN.height / 2;
	}
	x0 = Math.max(0, x0);
	y0 = Math.max(0, y0);
	x1 = Math.min(page.width, x1);
	y1 = Math.min(page.height, y1);
	return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

// ---------------------------------------------------------------------------------------------------- colours

export const COLOUR_FAMILIES = ["yellow", "green", "blue", "pink", "orange", "red", "purple", "grey"] as const;
export type ColourFamily = typeof COLOUR_FAMILIES[number];

/** The name of the family of a `#rrggbb` colour (by hue), for grouping and labels. */
export function colourFamily(hex: string): ColourFamily {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
	if (!m) return "grey";
	const r = parseInt(m[1]!, 16) / 255, g = parseInt(m[2]!, 16) / 255, b = parseInt(m[3]!, 16) / 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	if (s < 0.2 || l < 0.12 || l > 0.95) return "grey";
	let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h = (h * 60 + 360) % 360;
	if (h < 15 || h >= 345) return "red";
	if (h < 40) return "orange";
	if (h < 70) return "yellow";
	if (h < 170) return "green";
	if (h < 260) return "blue";
	if (h < 300) return "purple";
	return "pink";
}

// ------------------------------------------------------------------------------------------------- the Markdown

export interface DigestItem {
	region: HighlightRegion;
	/** 1-based page number. */
	pageNumber: number;
	/** The Markdown that shows the picture of the region (already a link or embed); null when it could not be made. */
	image: string | null;
	/** The PDF text under the highlight ("" when none). */
	text: string;
}

export interface DigestBuild {
	items: readonly DigestItem[];
	group: "page" | "colour";
	/** A link back to a page, e.g. `[[Maths.notebook#p3&id=...|Page 3]]`. */
	pageLink: (pageNumber: number, pageId: string) => string;
	/** Text of a page group's heading (it may hold the link). */
	pageHeading: (pageNumber: number, pageId: string) => string;
	/** Name of a colour family, in the user's language. */
	colourName: (family: ColourFamily) => string;
	/** The line under the opening marker: where the digest comes from and how much it holds. */
	intro: string;
	/** Shown when the notebook has no highlight. */
	none: string;
}

/** A quotation of PDF text: every line starts with `> `. */
function quote(text: string): string {
	return text.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
}

/** One highlight: the picture, the quoted PDF text and one line saying where it is or which colour it is. */
function itemBlock(item: DigestItem, line: string): string {
	const parts: string[] = [];
	if (item.image) parts.push(item.image);
	if (item.text) parts.push(quote(item.text));
	parts.push(line);
	return parts.join("\n\n");
}

/** The Markdown between (and including) the two marker comments. */
export function buildDigestSection(b: DigestBuild): string {
	const lines: string[] = [DIGEST_START, "", b.intro, ""];
	if (b.items.length === 0) lines.push(b.none, "");
	else if (b.group === "colour") {
		const byFamily = new Map<ColourFamily, DigestItem[]>();
		for (const item of b.items) {
			const f = colourFamily(item.region.colour);
			const list = byFamily.get(f);
			if (list) list.push(item);
			else byFamily.set(f, [item]);
		}
		const families = [...byFamily.keys()].sort((a, c) => COLOUR_FAMILIES.indexOf(a) - COLOUR_FAMILIES.indexOf(c));
		for (const f of families) {
			lines.push(`## ${b.colourName(f)}`, "");
			for (const item of byFamily.get(f)!) lines.push(itemBlock(item, b.pageLink(item.pageNumber, item.region.pageId)), "");
		}
	} else {
		let page = -1;
		for (const item of b.items) {
			if (item.pageNumber !== page) {
				page = item.pageNumber;
				lines.push(`## ${b.pageHeading(item.pageNumber, item.region.pageId)}`, "");
			}
			lines.push(itemBlock(item, b.colourName(colourFamily(item.region.colour))), "");
		}
	}
	lines.push(DIGEST_END);
	return lines.join("\n");
}

export type ReplaceOutcome = "created" | "replaced" | "appended" | "unsafe";

/**
 * `existing` (the note's text) with the section between the markers replaced by `section`. A note without markers gets the
 * section appended after its text; text outside the markers is never changed. A note with a start marker but no end marker
 * after it (or an end marker alone) is "unsafe": its text is returned unchanged and the caller must not write it.
 */
export function replaceDigestSection(existing: string, section: string): { text: string; outcome: ReplaceOutcome } {
	const start = existing.indexOf(DIGEST_START);
	const end = start >= 0 ? existing.indexOf(DIGEST_END, start + DIGEST_START.length) : existing.indexOf(DIGEST_END);
	if (start >= 0 && end >= 0) {
		return { text: existing.slice(0, start) + section + existing.slice(end + DIGEST_END.length), outcome: "replaced" };
	}
	if (start >= 0 || end >= 0) return { text: existing, outcome: "unsafe" };
	if (existing.trim() === "") return { text: `${section}\n`, outcome: "created" };
	return { text: `${existing.replace(/\s+$/u, "")}\n\n${section}\n`, outcome: "appended" };
}

/**
 * Whether writing the section into `existing` would add it to a note that has none yet (the note is the user's own: same name,
 * no digest markers, some text). That needs a confirmation. A note with a start marker but no end (or the reverse) is "unsafe"
 * and handled elsewhere.
 */
export function wouldAppendToUserNote(existing: string): boolean {
	return replaceDigestSection(existing, "x").outcome === "appended";
}

/** The name of a second digest note when the first is a user note: `<Notebook> — Highlights 2.md`, then `3`... (never an existing one). */
export function alternativeDigestName(name: string, exists: (candidate: string) => boolean): string {
	return uniqueFileName(name, exists);
}

/** The text of a brand-new digest note: a title line, then the section. */
export function newDigestNote(title: string, section: string): string {
	return `# ${title}\n\n${section}\n`;
}

/** The part of a note between the markers (markers included), or "" when it has none. */
export function digestSectionOf(text: string): string {
	const start = text.indexOf(DIGEST_START);
	if (start < 0) return "";
	const end = text.indexOf(DIGEST_END, start + DIGEST_START.length);
	return end < 0 ? "" : text.slice(start, end + DIGEST_END.length);
}

/**
 * The pictures an earlier digest embedded, from `![[link]]` and `![alt](path)`: file name (lower case, folders dropped) -> the
 * link target as written (decoded, without `#` and `|` parts), so the exact file can be resolved from the digest note.
 */
export function sectionImageLinks(section: string): Map<string, string> {
	const out = new Map<string, string>();
	const add = (raw: string) => {
		let name = raw.split("|")[0]!.split("#")[0]!.trim();
		try {
			name = decodeURIComponent(name);
		} catch {
			/* keep the raw text */
		}
		const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
		if (base && !out.has(base)) out.set(base, name);
	};
	for (const m of section.matchAll(/!\[\[([^\]]+)\]\]/gu)) add(m[1]!);
	for (const m of section.matchAll(/!\[[^\]]*\]\(<?([^)>]+)>?\)/gu)) add(m[1]!);
	return out;
}

/**
 * File names (lower case, folders and `#`/`|` parts dropped) of the pictures an earlier digest embedded: the pictures this
 * plugin made, which a new run may write again instead of making new copies.
 */
export function sectionImageNames(section: string): Set<string> {
	return new Set(sectionImageLinks(section).keys());
}

/** Folder part of a vault path ("" at the root). */
function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** What `canRewritePicture` needs to know about the file an old digest embed resolves to. */
export interface PictureRewriteCheck {
	/** Vault path of the file the old embed resolves to from the digest note. */
	foundPath: string;
	/** Name the new picture would have. */
	name: string;
	/** Folder where Obsidian keeps attachments of the digest note (the parent of `getAvailablePathForAttachment`). */
	expectedDir: string;
	notePath: string;
	/** Paths of the notes that link to or embed `foundPath` (the digest note itself may be among them). */
	linkedFrom: readonly string[];
}

/**
 * Whether an earlier digest picture may be written again in place: it has the digest's own file name, sits where attachments of
 * the digest note go, and nothing but the digest note uses it. Anything else (another notebook's picture of the same name, a file
 * a user note embeds) is left alone and the picture goes to a new file.
 */
export function canRewritePicture(c: PictureRewriteCheck): boolean {
	const base = c.foundPath.slice(c.foundPath.lastIndexOf("/") + 1);
	if (base.toLowerCase() !== c.name.toLowerCase()) return false;
	if (dirOf(c.foundPath).toLowerCase() !== c.expectedDir.toLowerCase()) return false;
	return c.linkedFrom.every((p) => p === c.notePath);
}

/** The file name of the picture of the `n`-th (1-based) region of a page: stable, so a new run writes the same names. */
export function digestImageName(notebook: string, pageNumber: number, n: number): string {
	return `${notebook} highlight p${pageNumber}-${n}.png`;
}
