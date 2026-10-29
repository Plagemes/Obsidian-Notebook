/**
 * #235 Re-published slides: recognises the pages of a new version of a PDF that are already in the
 * notebook by their content, not by their number, and plans the update (new pages appended, changed
 * slides switched to their new version keeping the notes). Pure: no pdf.js, DOM or 'obsidian'.
 */
import { createPdfPages } from "../model/pages";
import { AddAsset, Batch, InsertPages, SetPageBackground, SetPageMargins, type Command } from "../model/history";
import { marginsOf } from "../model/margins";
import type { Asset, NotebookDocument, Page } from "../model/types";

/** What identifies a slide: its normalised text, and a small image hash when it has (almost) no text. */
export interface PageFingerprint {
	/** Text runs joined, whitespace collapsed, lower case. */
	text: string;
	/** Distinct words of `text` (letters and digits, 2+ characters). */
	tokens: string[];
	/** 64-bit difference hash of a small rendering, 16 hex chars; only for pages with little text. */
	image?: string;
}

/** Below this many characters of text a page is compared by its image hash (title-only, photo or blank slides). */
export const MIN_TEXT_CHARS = 24;
/** Image hashes at most this many bits apart are the same slide. */
export const SAME_IMAGE_BITS = 3;
/** Image hashes at most this many bits apart are the same slide, changed. */
export const UPDATED_IMAGE_BITS = 10;
/** Word overlap (Dice coefficient, common words removed) from which a slide counts as an updated version. */
export const UPDATED_TEXT_SIMILARITY = 0.5;
/**
 * An asset other than the anchor belongs to "that PDF" only if this many of its slides are unchanged in the new
 * version, or more than half of them: one shared "Thank you / Questions" slide does not pull in another lecture.
 */
export const FAMILY_MIN_PAGES = 3;

export function normalizePageText(parts: readonly string[]): string {
	return parts.join(" ").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function tokenize(text: string): string[] {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
	return [...new Set(words)];
}

/** Whether a page with this text needs an image hash to be told apart. */
export function needsImageHash(text: string): boolean {
	return text.length < MIN_TEXT_CHARS;
}

export function makeFingerprint(textParts: readonly string[], image?: string): PageFingerprint {
	const text = normalizePageText(textParts);
	const fp: PageFingerprint = { text, tokens: tokenize(text) };
	if (image !== undefined) fp.image = image;
	return fp;
}

/**
 * Difference hash (dHash) of an RGBA bitmap: the image is reduced to 9 × 8 grey cells (box average) and
 * each bit says whether a cell is brighter than its right neighbour. 16 lowercase hex chars.
 */
export function differenceHash(rgba: ArrayLike<number>, width: number, height: number): string {
	const W = 9;
	const H = 8;
	const grey: number[] = new Array<number>(W * H).fill(0);
	if (width > 0 && height > 0) {
		for (let cy = 0; cy < H; cy++) {
			const y0 = Math.floor((cy * height) / H);
			const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / H));
			for (let cx = 0; cx < W; cx++) {
				const x0 = Math.floor((cx * width) / W);
				const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / W));
				let sum = 0;
				let n = 0;
				for (let y = y0; y < Math.min(y1, height); y++) {
					for (let x = x0; x < Math.min(x1, width); x++) {
						const i = (y * width + x) * 4;
						const a = (rgba[i + 3] ?? 255) / 255;
						// Transparent pixels are white paper.
						const lum = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
						sum += lum * a + 255 * (1 - a);
						n++;
					}
				}
				grey[cy * W + cx] = n > 0 ? sum / n : 255;
			}
		}
	}
	let hex = "";
	for (let cy = 0; cy < H; cy++) {
		let byte = 0;
		for (let cx = 0; cx < 8; cx++) byte = (byte << 1) | (grey[cy * W + cx]! > grey[cy * W + cx + 1]! ? 1 : 0);
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/** Number of differing bits between two hex hashes of the same length (Infinity if they cannot be compared). */
export function hammingHex(a: string, b: string): number {
	if (a.length !== b.length || a.length === 0) return Infinity;
	let bits = 0;
	for (let i = 0; i < a.length; i++) {
		let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
		if (Number.isNaN(x)) return Infinity;
		while (x) {
			bits += x & 1;
			x >>= 1;
		}
	}
	return bits;
}

/** A PDF page already shown in the notebook (one per distinct asset + page, however many notebook pages show it). */
export interface OldSource {
	asset: string;
	page: number;
	fp: PageFingerprint;
}

export interface NewSource {
	/** 1-based page number in the new PDF. */
	page: number;
	fp: PageFingerprint;
}

export type MatchStatus = "unchanged" | "updated" | "new";

export interface PageMatch {
	/** Page of the new PDF. */
	page: number;
	status: MatchStatus;
	/** The notebook's version of this slide (unchanged and updated only). */
	source?: OldSource;
	/** 1 for unchanged, the similarity for updated, 0 for new. */
	similarity: number;
}

export interface MatchResult {
	/** One per page of the new PDF, in order. */
	matches: PageMatch[];
	/** Assets considered "that PDF": the anchor and every asset with enough unchanged pages (FAMILY_MIN_PAGES). */
	family: string[];
	/**
	 * The family's main asset: the anchor, else the asset with the most unchanged pages. Only its updated slides are
	 * proposed switched on by default.
	 */
	main: string | null;
	/** Slides of those assets that are not in the new version (left in the notebook as they are). */
	missing: OldSource[];
}

const keyOf = (s: { asset: string; page: number }) => `${s.asset}#${s.page}`;

function textRich(fp: PageFingerprint): boolean {
	return !needsImageHash(fp.text);
}

/** Same slide, unchanged: equal text, and for text-poor pages also a (nearly) equal image. */
function sameSlide(a: PageFingerprint, b: PageFingerprint): boolean {
	if (a.text !== b.text) return false;
	if (textRich(a)) return true;
	if (a.image === undefined || b.image === undefined) return false;
	return hammingHex(a.image, b.image) <= SAME_IMAGE_BITS;
}

/** Dice coefficient of two word sets, ignoring `common` words (footers, course name...). */
function dice(a: readonly string[], b: readonly string[], common: ReadonlySet<string>): number {
	const x = a.filter((w) => !common.has(w));
	const y = new Set(b.filter((w) => !common.has(w)));
	if (x.length === 0 || y.size === 0) return 0;
	let both = 0;
	for (const w of x) if (y.has(w)) both++;
	return (2 * both) / (x.length + y.size);
}

/** How likely `b` is a changed version of `a` (0 = not at all); below the thresholds it is 0. */
function updatedScore(a: PageFingerprint, b: PageFingerprint, common: ReadonlySet<string>): number {
	if (textRich(a) && textRich(b)) {
		const s = dice(a.tokens, b.tokens, common);
		return s >= UPDATED_TEXT_SIMILARITY ? s : 0;
	}
	if (!textRich(a) && !textRich(b) && a.image !== undefined && b.image !== undefined) {
		const d = hammingHex(a.image, b.image);
		return d <= UPDATED_IMAGE_BITS ? 1 - d / 64 : 0;
	}
	return 0;
}

/** Words on more than half of the pages (with 4 pages or more): headers and footers that say nothing about a slide. */
function commonWords(fps: readonly PageFingerprint[]): Set<string> {
	const out = new Set<string>();
	if (fps.length < 4) return out;
	const df = new Map<string, number>();
	for (const fp of fps) for (const w of fp.tokens) df.set(w, (df.get(w) ?? 0) + 1);
	for (const [w, n] of df) if (n > fps.length / 2) out.add(w);
	return out;
}

/** Step 1 of matchRepublished: unchanged slides, one notebook slide per new page. */
function matchUnchanged(old: readonly OldSource[], fresh: readonly NewSource[], anchorAsset: string | null, used: Set<string>): PageMatch[] {
	const matches: PageMatch[] = fresh.map((n) => ({ page: n.page, status: "new", similarity: 0 }));
	fresh.forEach((n, i) => {
		let best: OldSource | null = null;
		for (const o of old) {
			if (used.has(keyOf(o)) || !sameSlide(o.fp, n.fp)) continue;
			if (!best) {
				best = o;
				continue;
			}
			const d = Math.abs(o.page - n.page);
			const bd = Math.abs(best.page - n.page);
			if (d < bd || (d === bd && o.asset === anchorAsset && best.asset !== anchorAsset)) best = o;
		}
		if (best) {
			used.add(keyOf(best));
			matches[i] = { page: n.page, status: "unchanged", source: best, similarity: 1 };
		}
	});
	return matches;
}

/** Unchanged pages per asset, in order of first appearance. */
function unchangedPerAsset(matches: readonly PageMatch[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const m of matches) if (m.status === "unchanged" && m.source) out.set(m.source.asset, (out.get(m.source.asset) ?? 0) + 1);
	return out;
}

/**
 * Matches the pages of a new PDF version against the slides already in the notebook.
 *
 * 1. **Unchanged**: equal fingerprint, one notebook slide per new page; among equal candidates the one
 *    with the closest page number wins (then the anchor's asset). Order changes do not matter.
 * 2. "That PDF" (the family) is the anchor asset plus every asset with at least FAMILY_MIN_PAGES unchanged
 *    pages, or more than half of its slides unchanged. Step 1 is then repeated with the family's slides only,
 *    so a slide of an unrelated PDF never counts as "already in the notebook".
 * 3. **Updated**: remaining new pages are paired with remaining slides of the family whose text (or
 *    image, for text-poor slides) is similar enough, best pairs first.
 * 4. Everything else is **new**.
 */
export function matchRepublished(old: readonly OldSource[], fresh: readonly NewSource[], anchorAsset: string | null): MatchResult {
	const slidesPerAsset = new Map<string, number>();
	for (const o of old) slidesPerAsset.set(o.asset, (slidesPerAsset.get(o.asset) ?? 0) + 1);
	const provisional = unchangedPerAsset(matchUnchanged(old, fresh, anchorAsset, new Set()));
	const family = new Set<string>();
	if (anchorAsset) family.add(anchorAsset);
	for (const [asset, n] of provisional) {
		if (n >= FAMILY_MIN_PAGES || n * 2 > (slidesPerAsset.get(asset) ?? 0)) family.add(asset);
	}

	const used = new Set<string>();
	const matches = matchUnchanged(old.filter((o) => family.has(o.asset)), fresh, anchorAsset, used);
	let main = anchorAsset;
	if (main === null) {
		let most = 0;
		for (const [asset, n] of unchangedPerAsset(matches)) {
			if (n > most) {
				most = n;
				main = asset;
			}
		}
	}

	const candidates = old.filter((o) => family.has(o.asset) && !used.has(keyOf(o)));
	const common = commonWords([...old.filter((o) => family.has(o.asset)).map((o) => o.fp), ...fresh.map((n) => n.fp)]);
	const pairs: Array<{ i: number; o: OldSource; score: number }> = [];
	fresh.forEach((n, i) => {
		if (matches[i]!.status !== "new") return;
		for (const o of candidates) {
			const score = updatedScore(o.fp, n.fp, common);
			if (score > 0) pairs.push({ i, o, score });
		}
	});
	pairs.sort((a, b) => b.score - a.score
		|| Math.abs(a.o.page - fresh[a.i]!.page) - Math.abs(b.o.page - fresh[b.i]!.page)
		|| a.i - b.i);
	for (const p of pairs) {
		if (matches[p.i]!.status !== "new" || used.has(keyOf(p.o))) continue;
		used.add(keyOf(p.o));
		matches[p.i] = { page: fresh[p.i]!.page, status: "updated", source: p.o, similarity: p.score };
	}

	const missing = old.filter((o) => family.has(o.asset) && !used.has(keyOf(o)));
	return { matches, family: [...family], main, missing };
}

/** Distinct PDF pages shown by the notebook, in document order. */
export function pdfSources(doc: NotebookDocument): Array<{ asset: string; page: number }> {
	const seen = new Set<string>();
	const out: Array<{ asset: string; page: number }> = [];
	for (const p of doc.pages) {
		const bg = p.background;
		if (bg?.kind !== "pdf") continue;
		const k = keyOf(bg);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ asset: bg.asset, page: bg.page });
	}
	return out;
}

/**
 * Where new pages go: after the last notebook page that shows a PDF of the family, and after the blank
 * note pages (no background) that follow it; at the end when the notebook has no page of the family.
 */
export function insertionIndex(doc: NotebookDocument, family: readonly string[]): number {
	const fam = new Set(family);
	let last = -1;
	doc.pages.forEach((p, i) => {
		if (p.background?.kind === "pdf" && fam.has(p.background.asset)) last = i;
	});
	if (last < 0) return doc.pages.length;
	let at = last + 1;
	while (at < doc.pages.length && !doc.pages[at]!.background) at++;
	return at;
}

export interface RepublishCounts {
	added: number;
	updated: number;
	unchanged: number;
	missing: number;
}

export function countMatches(result: MatchResult): RepublishCounts {
	const n = (s: MatchStatus) => result.matches.filter((m) => m.status === s).length;
	return { added: n("new"), updated: n("updated"), unchanged: n("unchanged"), missing: result.missing.length };
}

export interface RepublishPlan {
	/** One undo step; null when there is nothing to change. */
	command: Command | null;
	/** Index of the first inserted page (when pages are added). */
	insertAt: number;
	added: number;
	switched: number;
}

/**
 * The update as one Batch: register the new asset, append the new pages (with the margins of the family's
 * last page, so the new slides look like the others) and switch each updated slide the user accepted
 * (`switchPages`: new-PDF page numbers) to its new version on every notebook page that shows it. Switched
 * pages keep their ink, elements and margins; their size follows the new PDF page, except that an infinite page
 * never gets shorter than it is (its ink may reach below the slide): the extra height goes into its bottom margin
 * when it has margins. Old assets stay in the document and in `_assets/`.
 */
export function planRepublish(
	doc: NotebookDocument,
	result: MatchResult,
	asset: Asset,
	sizes: ReadonlyArray<{ width: number; height: number }>,
	switchPages: ReadonlySet<number>,
): RepublishPlan {
	const insertAt = insertionIndex(doc, result.family);
	const fam = new Set(result.family);
	const like = [...doc.pages].reverse().find((p) => p.background?.kind === "pdf" && fam.has(p.background.asset));
	const margins = like?.margins ? marginsOf(like) : null;
	const sizeOf = (n: number) => {
		const s = sizes[n - 1];
		if (!s) throw new RangeError(`page ${n} of the new PDF has no size`);
		return s;
	};

	const newPages: Page[] = [];
	for (const m of result.matches) {
		if (m.status !== "new") continue;
		const [page] = createPdfPages(asset, [sizeOf(m.page)], m.page);
		if (margins && (margins.left > 0 || margins.right > 0 || margins.bottom > 0)) {
			page!.width = Math.round((page!.width + margins.left + margins.right) * 100) / 100;
			page!.height = Math.round((page!.height + margins.bottom) * 100) / 100;
			page!.margins = { ...margins };
		}
		newPages.push(page!);
	}

	const switches: Command[] = [];
	let switched = 0;
	for (const m of result.matches) {
		if (m.status !== "updated" || !m.source || !switchPages.has(m.page)) continue;
		const src = m.source;
		const size = sizeOf(m.page);
		for (const p of doc.pages) {
			const bg = p.background;
			if (bg?.kind !== "pdf" || bg.asset !== src.asset || bg.page !== src.page) continue;
			const mg = marginsOf(p);
			const width = Math.round((size.width + mg.left + mg.right) * 100) / 100;
			const height = Math.round((size.height + mg.bottom) * 100) / 100;
			const background = { kind: "pdf" as const, asset: asset.id, page: m.page };
			switched++;
			if (!p.infinite || p.height <= height) {
				switches.push(new SetPageBackground(p.id, background, { width, height }));
			} else if (p.margins) {
				// The slide keeps its size; what the page grew beyond it stays as blank space below it.
				const extra = Math.round((p.height - height) * 100) / 100;
				switches.push(new SetPageBackground(p.id, background, { width, height }));
				switches.push(new SetPageMargins(p.id, mg, { ...mg, bottom: Math.round((mg.bottom + extra) * 100) / 100 }));
			} else {
				switches.push(new SetPageBackground(p.id, background, { width, height: p.height }));
			}
		}
	}

	if (newPages.length === 0 && switches.length === 0) return { command: null, insertAt, added: 0, switched: 0 };
	const commands: Command[] = [new AddAsset(asset)];
	if (newPages.length > 0) commands.push(new InsertPages(newPages, insertAt));
	commands.push(...switches);
	return { command: new Batch("Update PDF", commands), insertAt, added: newPages.length, switched };
}
