// v16 (#86): the file form of the margin comments of a page: what the writer keeps (`normalizeComments`), the line it writes
// (`commentLine`) and the reader both the lenient parse and the strict check share (`readComments`). Pure, no 'obsidian',
// no import of serialize.ts (serialize.ts calls this). model/comments.ts holds the editing operations and the merge.
import {
	COMMENT_AUTHOR_MAX, COMMENT_ID_MAX, COMMENT_MIN_SIDE, COMMENT_SKETCH_H, COMMENT_SKETCH_POINTS, COMMENT_SKETCH_STROKES, COMMENT_SKETCH_TOTAL,
	COMMENT_SKETCH_W, COMMENT_TEXT_MAX, COMMENTS_MAX, type CommentRegion, type CommentReply, type CommentSketch, type PageComment, type PageCommentNote,
} from "./types";

const j = JSON.stringify;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Typed text as stored: line breaks normalised, no trailing blank space, at most COMMENT_TEXT_MAX characters. */
export function cleanCommentText(text: string): string {
	const normal = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
	return Array.from(normal).slice(0, COMMENT_TEXT_MAX).join("");
}

/** The name of the device that wrote a comment, as stored: trimmed, single line, at most COMMENT_AUTHOR_MAX characters. */
export function cleanCommentAuthor(name: string): string {
	return Array.from(name.replace(/\s+/g, " ").trim()).slice(0, COMMENT_AUTHOR_MAX).join("");
}

/**
 * A region kept on the page: sides at least COMMENT_MIN_SIDE and at most the page's, inside the page, rounded to a tenth of a
 * point (the file keeps no more). `page` smaller than the minimum side only shrinks the region to fit it.
 */
export function clampRegion(r: CommentRegion, page: { width: number; height: number }): CommentRegion {
	// Rounded down to a tenth where the page's edge is concerned, so a region never pokes out of a page of 595.28 pt by 0.02.
	const down = (v: number): number => Math.floor(v * 10 + 1e-6) / 10;
	const width = down(Math.min(page.width, Math.max(Math.min(COMMENT_MIN_SIDE, page.width), r.width)));
	const height = down(Math.min(page.height, Math.max(Math.min(COMMENT_MIN_SIDE, page.height), r.height)));
	const x = Math.min(down(Math.max(0, page.width - width)), Math.max(0, round1(r.x)));
	const y = Math.min(down(Math.max(0, page.height - height)), Math.max(0, round1(r.y)));
	return { x, y, width, height };
}

/** Whether `r` is exactly what `clampRegion` would keep (valid on a page of this size). */
export function regionFits(r: CommentRegion, page: { width: number; height: number }): boolean {
	const c = clampRegion(r, page);
	return c.x === r.x && c.y === r.y && c.width === r.width && c.height === r.height;
}

/** The region an orphan reply is promoted to: a small box at the top-left corner of the page. */
export function orphanRegion(page: { width: number; height: number }): CommentRegion {
	return clampRegion({ x: 0, y: 0, width: 80, height: 24 }, page);
}

/** A sketch as the file keeps it: integer points inside the frame, bounded in strokes and points; undefined when nothing is left. */
export function normalizeSketch(sketch: CommentSketch | undefined): CommentSketch | undefined {
	const read = readSketch(sketch, []);
	return read;
}

function readSketch(v: unknown, problems: string[]): CommentSketch | undefined {
	if (v === undefined) return undefined;
	if (!isObj(v) || !Array.isArray(v.strokes)) {
		problems.push("sketch: expected { strokes: [...] }");
		return undefined;
	}
	const out: number[][] = [];
	let total = 0;
	for (const raw of v.strokes as unknown[]) {
		if (out.length >= COMMENT_SKETCH_STROKES) {
			problems.push(`sketch: more than ${COMMENT_SKETCH_STROKES} strokes`);
			break;
		}
		if (!Array.isArray(raw) || raw.length < 4 || raw.length % 2 !== 0 || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
			problems.push("sketch: a stroke is not a list of at least two points");
			continue;
		}
		const maxNumbers = Math.min(COMMENT_SKETCH_POINTS * 2, (COMMENT_SKETCH_TOTAL - total) * 2);
		if (maxNumbers < 4) {
			problems.push("sketch: too many points");
			break;
		}
		let numbers = raw as number[];
		if (numbers.length > maxNumbers) {
			problems.push("sketch: a stroke has too many points");
			numbers = numbers.slice(0, maxNumbers);
		}
		const pts = numbers.map((n, i) => {
			const lim = i % 2 === 0 ? COMMENT_SKETCH_W : COMMENT_SKETCH_H;
			return Math.min(lim, Math.max(0, Math.round(n)));
		});
		if (pts.some((n, i) => n !== numbers[i])) problems.push("sketch: a point was rounded or moved into the frame");
		total += pts.length / 2;
		out.push(pts);
	}
	return out.length > 0 ? { strokes: out } : undefined;
}

/** The line a comment is written as (four tabs, like elements); fixed key order. Expects a normalised comment. */
export function commentLine(c: PageComment): string {
	if ("parent" in c) {
		const edited = c.edited !== undefined ? `,"edited":${j(c.edited)}` : "";
		return `\t\t\t\t{"id":${j(c.id)},"parent":${j(c.parent)},"text":${j(c.text)},"author":${j(c.author)},"created":${j(c.created)}${edited}}`;
	}
	const r = c.region;
	const sketch = c.sketch ? `,"sketch":{"strokes":${j(c.sketch.strokes)}}` : "";
	const edited = c.edited !== undefined ? `,"edited":${j(c.edited)}` : "";
	const resolved = c.resolved === true ? `,"resolved":true` : "";
	return `\t\t\t\t{"id":${j(c.id)},"region":{"x":${j(r.x)},"y":${j(r.y)},"width":${j(r.width)},"height":${j(r.height)}},"text":${j(c.text)}${sketch},"author":${j(c.author)},"created":${j(c.created)}${edited}${resolved}}`;
}

export interface ReadComments {
	comments: PageComment[];
	/**
	 * What was wrong with the input and was dropped or repaired to get `comments` (one message per thing). Empty when the input
	 * was already exactly what the writer keeps. A strict reader fails on the first; a lenient one counts them.
	 */
	problems: string[];
}

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= COMMENT_ID_MAX;
const validTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Reads the raw `comments` of a page of size `page`. Never throws. Per item: one that is not an object, has no valid id or a
 * repeated id, no valid time or a bad region (a note) or parent (a reply) is dropped; text and author are cut to their limits; a
 * region outside the page is moved and shrunk into it; a sketch keeps its valid strokes; a reply to a reply is attached to the
 * comment that reply belongs to; a reply whose comment is not there (an orphan) becomes a comment of its own in the corner of
 * the page, so that no typed text is lost. More than COMMENTS_MAX items are cut.
 */
export function readComments(raw: unknown, page: { width: number; height: number }): ReadComments {
	const problems: string[] = [];
	if (raw === undefined) return { comments: [], problems };
	if (!Array.isArray(raw)) return { comments: [], problems: ["comments: expected an array"] };
	const notes: PageCommentNote[] = [];
	const replies: CommentReply[] = [];
	const order: string[] = [];
	const ids = new Set<string>();
	const parents = new Map<string, string>();
	raw.forEach((item, i) => {
		const at = `comments[${i}]`;
		if (!isObj(item)) return void problems.push(`${at}: expected an object`);
		if (ids.size >= COMMENTS_MAX) return void problems.push(`${at}: more than ${COMMENTS_MAX} comments`);
		if (!validId(item.id)) return void problems.push(`${at}.id: expected 1 to ${COMMENT_ID_MAX} characters`);
		if (ids.has(item.id)) return void problems.push(`${at}.id: duplicate id`);
		if (typeof item.text !== "string") return void problems.push(`${at}.text: expected a string`);
		if (typeof item.author !== "string") return void problems.push(`${at}.author: expected a string`);
		if (!validTime(item.created)) return void problems.push(`${at}.created: expected a time`);
		if (item.edited !== undefined && !validTime(item.edited)) return void problems.push(`${at}.edited: expected a time`);
		const text = cleanCommentText(item.text);
		if (text !== item.text) problems.push(`${at}.text: not in stored form`);
		const author = cleanCommentAuthor(item.author);
		if (author !== item.author) problems.push(`${at}.author: not in stored form`);
		const edited = item.edited !== undefined ? { edited: item.edited } : {};
		if (item.parent !== undefined) {
			if (!validId(item.parent)) return void problems.push(`${at}.parent: expected 1 to ${COMMENT_ID_MAX} characters`);
			if (text === "") return void problems.push(`${at}.text: a reply needs text`);
			if (item.region !== undefined || item.resolved !== undefined || item.sketch !== undefined) problems.push(`${at}: a reply has no region, sketch or resolved flag`);
			ids.add(item.id);
			parents.set(item.id, item.parent);
			order.push(item.id);
			replies.push({ id: item.id, parent: item.parent, text, author, created: item.created, ...edited });
			return;
		}
		const region = item.region;
		if (!isObj(region) || ![region.x, region.y, region.width, region.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
			return void problems.push(`${at}.region: expected { x, y, width, height }`);
		}
		const r: CommentRegion = { x: round1(region.x as number), y: round1(region.y as number), width: round1(region.width as number), height: round1(region.height as number) };
		const fitted = clampRegion(r, page);
		if (!regionFits(r, page) || r.x !== region.x || r.y !== region.y || r.width !== region.width || r.height !== region.height) {
			problems.push(`${at}.region: outside the page or not in stored form`);
		}
		const sketch = readSketch(item.sketch, problems);
		if (item.resolved !== undefined && item.resolved !== true) problems.push(`${at}.resolved: expected true`);
		ids.add(item.id);
		order.push(item.id);
		notes.push({
			id: item.id, region: fitted, text, ...(sketch ? { sketch } : {}), author, created: item.created, ...edited,
			...(item.resolved === true ? { resolved: true as const } : {}),
		});
	});
	// Replies: attach each to a comment; flat thread, so a reply to a reply goes to the comment that reply belongs to.
	const noteIds = new Set(notes.map((n) => n.id));
	const attachTo = (reply: CommentReply): string | null => {
		let parent = reply.parent;
		for (let depth = 0; depth < 4; depth++) {
			if (noteIds.has(parent)) return parent;
			const up = parents.get(parent);
			if (up === undefined) return null;
			parent = up;
		}
		return null;
	};
	const byId = new Map<string, PageComment>();
	for (const n of notes) byId.set(n.id, n);
	for (const r of replies) {
		const to = attachTo(r);
		if (to !== null) {
			if (to !== r.parent) problems.push(`comments: reply ${r.id} was a reply to a reply`);
			byId.set(r.id, to === r.parent ? r : { ...r, parent: to });
			continue;
		}
		problems.push(`comments: reply ${r.id} has no comment`);
		const { parent: _p, ...base } = r;
		void _p;
		byId.set(r.id, { ...base, region: orphanRegion(page), text: r.text });
	}
	const comments = order.map((id) => byId.get(id)!).map((c) => Object.freeze(c));
	return { comments, problems };
}

/** The comments of a page as the writer keeps them (invalid items dropped, regions inside the page, orphans promoted); undefined when none is left. */
export function normalizeComments(list: readonly PageComment[] | undefined, page: { width: number; height: number }): PageComment[] | undefined {
	if (!list || list.length === 0) return undefined;
	const { comments } = readComments(list, page);
	return comments.length > 0 ? comments : undefined;
}
