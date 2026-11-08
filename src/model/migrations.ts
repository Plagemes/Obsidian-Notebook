import { createId, quantizePoint } from "./document";
import { A4_HEIGHT, A4_WIDTH, DEFAULT_META, ELEMENT_TYPES_V8, ELEMENT_TYPES_V9, ELEMENT_TYPES_V10, ELEMENT_TYPES_V15, ELEMENT_TYPES_V17, FORMAT_ID, GRID_5MM, PAPER_KINDS_V7, RENDER_FREEHAND, TOOLS_V20 } from "./types";

export type RawObject = Record<string, unknown>;

/** Migrates a document from version N to N+1. Input is not validated yet: throw if it is not recognised. */
export type Migration = (raw: RawObject) => RawObject;

export class MigrationError extends Error {}

/**
 * v0: prototype format without a `version` field and a single implicit page.
 * `{ strokes: [{ points: [{ x, y, p? }], color, size }] }`
 */
function v0ToV1(raw: RawObject): RawObject {
	const strokes = raw.strokes;
	if (!Array.isArray(strokes)) throw new MigrationError("v0: missing 'strokes'");
	const now = new Date().toISOString();
	return {
		format: FORMAT_ID,
		version: 1,
		id: createId(),
		createdAt: now,
		modifiedAt: now,
		pages: [{
			id: createId(),
			width: A4_WIDTH,
			height: A4_HEIGHT,
			paper: { kind: "grid", spacing: GRID_5MM },
			strokes: strokes.map((s: unknown, i) => {
				if (typeof s !== "object" || s === null) throw new MigrationError(`v0: invalid stroke ${i}`);
				const { points, color, size } = s as RawObject;
				if (!Array.isArray(points)) throw new MigrationError(`v0: stroke ${i} has no points`);
				return {
					id: createId(),
					tool: "pen",
					color,
					width: size,
					points: points.map((pt: unknown) => {
						const { x, y, p } = (pt ?? {}) as RawObject;
						if (typeof x !== "number" || typeof y !== "number") throw new MigrationError(`v0: invalid point in stroke ${i}`);
						return quantizePoint(x, y, typeof p === "number" ? p : 0.5);
					}),
				};
			}),
		}],
	};
}

/** v2 only widens the set of tools: every valid v1 document is a valid v2 document. */
function v1ToV2(raw: RawObject): RawObject {
	return { ...raw, version: 2 };
}

/** v3 only widens the set of paper kinds (and page sizes): every valid v2 document is a valid v3 document. */
function v2ToV3(raw: RawObject): RawObject {
	return { ...raw, version: 3 };
}

/**
 * v4 adds `meta` and `assets` to the document, `background`/`elements`/`infinite` to pages (all
 * optional, so existing pages are untouched) and the "shape" tool. Every valid v3 document becomes a
 * valid v4 document with default metadata and no assets. "shape" did not exist before v4, so a
 * pre-v4 file that contains it was not written by any version of this plugin: it is rejected rather
 * than guessed at (the caller never overwrites a file it could not read).
 */
function v3ToV4(raw: RawObject): RawObject {
	if (Array.isArray(raw.pages)) {
		for (const page of raw.pages as unknown[]) {
			const strokes = (page as RawObject | null)?.strokes;
			if (!Array.isArray(strokes)) continue;
			for (const s of strokes as unknown[]) {
				if ((s as RawObject | null)?.tool === "shape") throw new MigrationError("v3: tool 'shape' exists only from v4");
			}
		}
	}
	return {
		...raw,
		version: 4,
		meta: { tags: [], favorite: DEFAULT_META.favorite, cover: DEFAULT_META.cover, bookmarks: [] },
		assets: {},
	};
}

/**
 * v5 adds the required per-stroke `render` field. Every stroke written before v5 was drawn with
 * perfect-freehand, so it becomes render 1 (RENDER_FREEHAND) and keeps rendering exactly as before.
 * Pages and strokes that are not objects are left alone: validation rejects them afterwards.
 */
function v4ToV5(raw: RawObject): RawObject {
	if (!Array.isArray(raw.pages)) return { ...raw, version: 5 };
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !Array.isArray(page.strokes)) return page;
		return { ...page, strokes: (page.strokes as unknown[]).map((s) => (isObj(s) ? { ...s, render: RENDER_FREEHAND } : s)) };
	});
	return { ...raw, version: 5, pages };
}

/**
 * v6 adds the optional page field `margins` (blank space around a PDF or scan background). Every valid
 * v5 document is a valid v6 document without margins. A v5 reader ignored unknown fields, so a
 * `margins` key in a v5 file was never ours and never had an effect: it is dropped, not interpreted.
 */
function v5ToV6(raw: RawObject): RawObject {
	if (!Array.isArray(raw.pages)) return { ...raw, version: 6 };
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !("margins" in page)) return page;
		const copy = { ...page };
		delete copy.margins;
		return copy;
	});
	return { ...raw, version: 6, pages };
}

/**
 * v7 adds bookmark details (`meta.bookmarkInfo`), page tags (`pages[i].tags`), the shared reading position
 * (`position`) and the paper kinds in PAPER_KINDS_V7. All new fields are optional, so every valid v6 document
 * is a valid v7 document without them. A v6 reader ignored unknown fields, so these keys in a v6 file were
 * never ours and never had an effect: they are dropped, not interpreted (as `margins` in v5 -> v6). A v6
 * reader rejected the new paper kinds, so a pre-v7 file that uses one was not written by any version of
 * this plugin: it is rejected rather than guessed at (like "shape" before v4).
 */
function v6ToV7(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const out: RawObject = { ...raw, version: 7 };
	delete out.position;
	if (isObj(raw.meta) && "bookmarkInfo" in raw.meta) {
		const meta = { ...raw.meta };
		delete meta.bookmarkInfo;
		out.meta = meta;
	}
	if (Array.isArray(raw.pages)) {
		out.pages = (raw.pages as unknown[]).map((page, i) => {
			if (!isObj(page)) return page;
			const kind = isObj(page.paper) ? page.paper.kind : undefined;
			if (typeof kind === "string" && (PAPER_KINDS_V7 as readonly string[]).includes(kind)) {
				throw new MigrationError(`v6: paper '${kind}' (page ${i + 1}) exists only from v7`);
			}
			if (!("tags" in page)) return page;
			const copy = { ...page };
			delete copy.tags;
			return copy;
		});
	}
	return out;
}

/**
 * v8 adds the element types "marker" and "box" and the optional stroke field `hidden` (invisible ink). Every
 * valid v7 document is a valid v8 document without them. A v7 reader rejected unknown element types, so a
 * pre-v8 file with a marker or box was not written by any version of this plugin: it is rejected rather than
 * guessed at (like "shape" before v4). A v7 reader ignored unknown stroke fields, so a `hidden` key in a v7
 * file was never ours and never hid anything: it is dropped, not interpreted (like `margins` in v5 -> v6).
 */
function v7ToV8(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!Array.isArray(raw.pages)) return { ...raw, version: 8 };
	const pages = (raw.pages as unknown[]).map((page, i) => {
		if (!isObj(page)) return page;
		if (Array.isArray(page.elements)) {
			for (const el of page.elements as unknown[]) {
				const type = isObj(el) ? el.type : undefined;
				if (typeof type === "string" && ELEMENT_TYPES_V8.includes(type)) {
					throw new MigrationError(`v7: element type '${type}' (page ${i + 1}) exists only from v8`);
				}
			}
		}
		if (!Array.isArray(page.strokes) || !(page.strokes as unknown[]).some((s) => isObj(s) && "hidden" in s)) return page;
		const strokes = (page.strokes as unknown[]).map((s) => {
			if (!isObj(s) || !("hidden" in s)) return s;
			const copy = { ...s };
			delete copy.hidden;
			return copy;
		});
		return { ...page, strokes };
	});
	return { ...raw, version: 8, pages };
}

/**
 * v9 adds the element types "equation" and "graph". Every valid v8 document is a valid v9 document. A v8 reader
 * rejected unknown element types, so a pre-v9 file with an equation or a graph was not written by any version of this
 * plugin: it is rejected rather than guessed at (like markers before v8). Nothing else changes.
 */
function v8ToV9(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	if (Array.isArray(raw.pages)) {
		(raw.pages as unknown[]).forEach((page, i) => {
			if (!isObj(page) || !Array.isArray(page.elements)) return;
			for (const el of page.elements as unknown[]) {
				const type = isObj(el) ? el.type : undefined;
				if (typeof type === "string" && ELEMENT_TYPES_V9.includes(type)) {
					throw new MigrationError(`v8: element type '${type}' (page ${i + 1}) exists only from v9`);
				}
			}
		});
	}
	return { ...raw, version: 9 };
}

/**
 * v10 adds the element type "excerpt" (anchored excerpts, #105). Every valid v9 document is a valid v10 document. A v9
 * reader rejected unknown element types, so a pre-v10 file with an excerpt was not written by any version of this
 * plugin: it is rejected rather than guessed at (like equations before v9). Nothing else changes.
 */
function v9ToV10(raw: RawObject): RawObject {
	if (Array.isArray(raw.pages)) {
		(raw.pages as unknown[]).forEach((page, i) => {
			const problem = v10OnlyElement(page, i);
			if (problem) throw new MigrationError(problem);
		});
	}
	return { ...raw, version: 10 };
}

/**
 * Why page `index` (0-based) of a v9 file cannot be read as v10 (it holds an element type that exists only from v10),
 * or null. Everything else of a v9 page is a valid v10 page, so staged loading reads large v9 files page by page with
 * this check instead of migrating them in one go.
 */
export function v10OnlyElement(page: unknown, index: number): string | null {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isObj(page) || !Array.isArray(page.elements)) return null;
	for (const el of page.elements as unknown[]) {
		const type = isObj(el) ? el.type : undefined;
		if (typeof type === "string" && ELEMENT_TYPES_V10.includes(type)) return `v9: element type '${type}' (page ${index + 1}) exists only from v10`;
	}
	return null;
}

/**
 * v11 adds two optional metadata fields: `meta.description` and `meta.coverArt` (a generated or image cover). Every valid
 * v10 document is a valid v11 document without them. A v10 reader ignored unknown metadata fields, so these keys in a v10
 * file were never ours and never had an effect: they are dropped, not interpreted (like `bookmarkInfo` in v6 -> v7).
 * Nothing else changes, so a large v10 file can still be read page by page (StagedParse) after `withoutV11Meta`.
 */
function v10ToV11(raw: RawObject): RawObject {
	return { ...withoutV11Meta(raw), version: 11 };
}

/** The metadata fields that exist only from v11. */
export const META_FIELDS_V11: readonly string[] = ["description", "coverArt"];

/** `raw` without the v11-only metadata fields (a copy when there is something to drop; `raw` itself otherwise). */
export function withoutV11Meta(raw: RawObject): RawObject {
	const meta = raw.meta;
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return raw;
	if (!META_FIELDS_V11.some((k) => k in meta)) return raw;
	const copy: RawObject = { ...(meta as RawObject) };
	for (const k of META_FIELDS_V11) delete copy[k];
	return { ...raw, meta: copy };
}

/**
 * v12 adds the optional document table `slides` and the optional stroke field `slide` (ink remembers the slide shown
 * beside the notes while it was written, #226). Every valid v11 document is a valid v12 document without them. A v11
 * reader ignored unknown document and stroke fields, so these keys in a v11 file were never ours and never had an effect:
 * they are dropped, not interpreted (like `hidden` in v7 -> v8). Nothing else changes, so a large v11 file can still be
 * read page by page (StagedParse) after `withoutV12Slides`, with the `slide` keys of its strokes ignored.
 */
function v11ToV12(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const out: RawObject = { ...withoutV12Slides(raw), version: 12 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !Array.isArray(page.strokes) || !(page.strokes as unknown[]).some((s) => isObj(s) && "slide" in s)) return page;
		const strokes = (page.strokes as unknown[]).map((s) => {
			if (!isObj(s) || !("slide" in s)) return s;
			const copy = { ...s };
			delete copy.slide;
			return copy;
		});
		return { ...page, strokes };
	});
	return out;
}

/** `raw` without the v12 document table `slides` (a copy when there is one; `raw` itself otherwise). */
export function withoutV12Slides(raw: RawObject): RawObject {
	if (!("slides" in raw)) return raw;
	const copy = { ...raw };
	delete copy.slides;
	return copy;
}

/**
 * v13 adds the optional page field `states` (drawings with states, #241). Every valid v12 document is a valid v13 document
 * without it. A v12 reader ignored unknown page fields, so a `states` key in a v12 file was never ours and never had an
 * effect: it is dropped, not interpreted (like `slides` in v11 -> v12). Nothing else changes, so a large v12 file can still
 * be read page by page (StagedParse), which ignores the `states` key of each page.
 */
function v12ToV13(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const out: RawObject = { ...raw, version: 13 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !("states" in page)) return page;
		const copy = { ...page };
		delete copy.states;
		return copy;
	});
	return out;
}

/**
 * v14 adds the optional page field `locked` (a finished page that refuses edits, #124). Every valid v13 document is a valid
 * v14 document without it. A v13 reader ignored unknown page fields, so a `locked` key in a v13 file was never ours and never
 * locked anything: it is dropped, not interpreted (like `states` in v12 -> v13). Nothing else changes, so a large v13 file can
 * still be read page by page (StagedParse), which ignores the `locked` key of each page.
 */
function v13ToV14(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const out: RawObject = { ...raw, version: 14 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !("locked" in page)) return page;
		const copy = { ...page };
		delete copy.locked;
		return copy;
	});
	return out;
}

/**
 * v15 adds the element type "sticky" (sticky notes, #20). Every valid v14 document is a valid v15 document. A v14 reader
 * rejected unknown element types, so a pre-v15 file with a sticky note was not written by any version of this plugin: it is
 * rejected rather than guessed at (like excerpts before v10). Nothing else changes.
 */
function v14ToV15(raw: RawObject): RawObject {
	if (Array.isArray(raw.pages)) {
		(raw.pages as unknown[]).forEach((page, i) => {
			const problem = v15OnlyElement(page, i);
			if (problem) throw new MigrationError(problem);
		});
	}
	return { ...raw, version: 15 };
}

/**
 * Why page `index` (0-based) of a v14 file cannot be read as v15 (it holds an element type that exists only from v15), or
 * null. Everything else of a v14 page is a valid v15 page, so staged loading reads large v14 files page by page with this check.
 */
export function v15OnlyElement(page: unknown, index: number): string | null {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isObj(page) || !Array.isArray(page.elements)) return null;
	for (const el of page.elements as unknown[]) {
		const type = isObj(el) ? el.type : undefined;
		if (typeof type === "string" && ELEMENT_TYPES_V15.includes(type)) return `v14: element type '${type}' (page ${index + 1}) exists only from v15`;
	}
	return null;
}

/**
 * v16 adds the optional page field `comments` (margin comments, #86). Every valid v15 document is a valid v16 document
 * without it. A v15 reader ignored unknown page fields, so a `comments` key in a v15 file was never ours and never meant
 * anything: it is dropped, not interpreted (like `states` in v12 -> v13 and `locked` in v13 -> v14). Nothing else changes, so a
 * large v15 file can still be read page by page (StagedParse), which ignores the `comments` key of each page.
 */
function v15ToV16(raw: RawObject): RawObject {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const out: RawObject = { ...raw, version: 16 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !("comments" in page)) return page;
		const copy = { ...page };
		delete copy.comments;
		return copy;
	});
	return out;
}

/**
 * v17 adds the element type "checkbox" (handwritten checklists, #103). Every valid v16 document is a valid v17 document. A v16
 * reader rejected unknown element types, so a pre-v17 file with a checkbox was not written by any version of this plugin: it is
 * rejected rather than guessed at (like sticky notes before v15). Nothing else changes.
 */
function v16ToV17(raw: RawObject): RawObject {
	if (Array.isArray(raw.pages)) {
		(raw.pages as unknown[]).forEach((page, i) => {
			const problem = v17OnlyElement(page, i);
			if (problem) throw new MigrationError(problem);
		});
	}
	return { ...raw, version: 17 };
}

/**
 * Why page `index` (0-based) of a v16 (or older) file cannot be read as v17 (it holds an element type that exists only from v17),
 * or null. Everything else of a v16 page is a valid v17 page, so staged loading reads large v16 files page by page with this check.
 */
export function v17OnlyElement(page: unknown, index: number): string | null {
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isObj(page) || !Array.isArray(page.elements)) return null;
	for (const el of page.elements as unknown[]) {
		const type = isObj(el) ? el.type : undefined;
		if (typeof type === "string" && ELEMENT_TYPES_V17.includes(type)) return `v16: element type '${type}' (page ${index + 1}) exists only from v17`;
	}
	return null;
}

/**
 * v18 adds the optional `group` of strokes and elements and the optional `locked` / `lockAt` of elements (groups and locked
 * elements, #39). Every valid v17 document is a valid v18 document without them. A v17 reader ignored unknown fields of strokes and
 * elements, so such a key in a v17 file was never ours and never meant anything: it is dropped, not interpreted (like `slide` in
 * v11 -> v12, `states` in v12 -> v13 and `comments` in v15 -> v16). Nothing else changes, so a large v17 file can still be read page
 * by page (StagedParse), which ignores these keys of each item.
 */
function v17ToV18(raw: RawObject): RawObject {
	const out: RawObject = { ...raw, version: 18 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => {
		if (!isRaw(page)) return page;
		let copy: RawObject | null = null;
		if (Array.isArray(page.strokes) && page.strokes.some((s) => isRaw(s) && "group" in s)) {
			copy = { ...page, strokes: page.strokes.map((s) => withoutKeys(s, ["group"])) };
		}
		if (Array.isArray(page.elements) && page.elements.some((e) => isRaw(e) && ("group" in e || "locked" in e || "lockAt" in e))) {
			copy = { ...(copy ?? page), elements: page.elements.map((e) => withoutKeys(e, ["group", "locked", "lockAt"])) };
		}
		return copy ?? page;
	});
	return out;
}

/**
 * v19 adds the optional page fields `startAt` and `endAt` (start and end time of a page, #217). Every valid v18 document is a valid v19
 * document without them. A v18 reader ignored unknown page fields, so such a key in a v18 file was never ours and never meant anything:
 * it is dropped, not interpreted (like `comments` in v15 -> v16 and the item flags in v17 -> v18). Nothing else changes, so a large v18
 * file can still be read page by page (StagedParse), which ignores these keys of each page.
 */
function v18ToV19(raw: RawObject): RawObject {
	const out: RawObject = { ...raw, version: 19 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page) => withoutKeys(page, ["startAt", "endAt"]));
	return out;
}

/**
 * v20 adds the tools "fountain", "brush" and "marker" and the optional stroke field `nib` (new pens, #35). Every valid v19 document is a
 * valid v20 document. The new tools did not exist before v20, so a v19 file that contains one was not written by any version of this
 * plugin: it is refused rather than guessed at (like "shape" in v3 -> v4; the caller never overwrites a file it could not read). A v19
 * reader ignored unknown stroke fields, so a `nib` key in a v19 file was never ours and never meant anything: it is dropped, not
 * interpreted (like `group` in v17 -> v18). The refusal is also made stroke by stroke as each page is read (StagedParse), so a large
 * v19 file can still be read page by page.
 */
function v19ToV20(raw: RawObject): RawObject {
	const out: RawObject = { ...raw, version: 20 };
	if (!Array.isArray(raw.pages)) return out;
	out.pages = (raw.pages as unknown[]).map((page, index) => {
		if (!isRaw(page) || !Array.isArray(page.strokes)) return page;
		for (const s of page.strokes as unknown[]) {
			const tool = isRaw(s) ? s.tool : undefined;
			if (typeof tool === "string" && (TOOLS_V20 as readonly string[]).includes(tool)) throw new MigrationError(`v19: tool '${tool}' (page ${index + 1}) exists only from v20`);
		}
		return (page.strokes as unknown[]).some((s) => isRaw(s) && "nib" in s) ? { ...page, strokes: (page.strokes as unknown[]).map((s) => withoutKeys(s, ["nib"])) } : page;
	});
	return out;
}

/**
 * v21 adds the optional notebook-level `views` list (saved views, #264). Every valid v20 document is a valid v21 document without it:
 * the migration is the identity apart from the version. A v20 reader ignored unknown document fields, so a `views` key in a v20 file
 * was never ours and never meant anything: it is dropped, not interpreted (like `slides` in v11 -> v12). Nothing else changes, so a
 * large v20 file can still be read page by page (StagedParse) after `withoutV21Views`.
 */
function v20ToV21(raw: RawObject): RawObject {
	return { ...withoutV21Views(raw), version: 21 };
}

/** `raw` without the v21 document list `views` (a copy when there is one; `raw` itself otherwise). */
export function withoutV21Views(raw: RawObject): RawObject {
	if (!("views" in raw)) return raw;
	const copy = { ...raw };
	delete copy.views;
	return copy;
}

/**
 * v22 adds the optional stroke fields `fill`, `fillTint` and `dash` (filled shapes and dashed or dotted lines, #37). Every valid v21
 * document is a valid v22 document: the migration is the identity apart from the version. A v21 reader ignored unknown stroke fields,
 * so such a key in a v21 file was never ours and never meant anything: it is dropped, not interpreted (like `nib` in v19 -> v20).
 * Nothing else changes, so a large v21 file can still be read page by page (StagedParse), which ignores these keys of each stroke.
 */
function v21ToV22(raw: RawObject): RawObject {
	const out: RawObject = { ...raw, version: 22 };
	if (!Array.isArray(raw.pages)) return out;
	const pages = (raw.pages as unknown[]).map((page) => {
		if (!isRaw(page) || !Array.isArray(page.strokes)) return page;
		return (page.strokes as unknown[]).some((s) => isRaw(s) && V22_STROKE_KEYS.some((k) => k in s))
			? { ...page, strokes: (page.strokes as unknown[]).map((s) => withoutKeys(s, V22_STROKE_KEYS)) }
			: page;
	});
	// A document with nothing to drop keeps its pages as they were (the migration is the identity but the version).
	if (pages.some((p, i) => p !== (raw.pages as unknown[])[i])) out.pages = pages;
	return out;
}

/** The stroke keys v22 added. */
const V22_STROKE_KEYS: readonly string[] = ["fill", "fillTint", "dash"];

function isRaw(v: unknown): v is RawObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `item` without the keys `keys` (the same object when it has none of them). */
function withoutKeys(item: unknown, keys: readonly string[]): unknown {
	if (!isRaw(item) || !keys.some((k) => k in item)) return item;
	const copy = { ...item };
	for (const k of keys) delete copy[k];
	return copy;
}

/** MIGRATIONS[n] takes a document from version n to n+1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
	0: v0ToV1,
	1: v1ToV2,
	2: v2ToV3,
	3: v3ToV4,
	4: v4ToV5,
	5: v5ToV6,
	6: v6ToV7,
	7: v7ToV8,
	8: v8ToV9,
	9: v9ToV10,
	10: v10ToV11,
	11: v11ToV12,
	12: v12ToV13,
	13: v13ToV14,
	14: v14ToV15,
	15: v15ToV16,
	16: v16ToV17,
	17: v17ToV18,
	18: v18ToV19,
	19: v19ToV20,
	20: v20ToV21,
	21: v21ToV22,
};

/** Version declared by the file; an object without `version` but with `strokes` is treated as v0. */
export function detectVersion(raw: RawObject): number | null {
	if (raw.version === undefined) return Array.isArray(raw.strokes) ? 0 : null;
	if (typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version >= 0) return raw.version;
	return null;
}

export function migrate(raw: RawObject, from: number, to: number): RawObject {
	let data = raw;
	for (let v = from; v < to; v++) {
		const step = MIGRATIONS[v];
		if (!step) throw new MigrationError(`no migration from v${v}`);
		data = step(data);
	}
	return data;
}
