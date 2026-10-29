import { detectVersion, migrate, MigrationError, type RawObject } from "./migrations";
import {
	CURRENT_VERSION, DEFAULT_META, FORMAT_ID, PAPER_KINDS, RENDER_VERSIONS, TOOLS,
	type Asset, type AssetKind, type ImageElement, type NotebookDocument, type NotebookMeta, type Page,
	type PageBackground, type PageElement, type PageMargins, type PaperKind, type Point, type RenderVersion, type Stroke, type TextElement, type Tool,
} from "./types";

export type ParseFailure =
	| "empty"
	| "json"
	| "not-notebook"
	| "future-version"
	| "invalid";

export type ParseResult =
	| { ok: true; doc: NotebookDocument; migratedFrom: number | null }
	| { ok: false; reason: ParseFailure; message: string; version?: number };

const j = JSON.stringify;

class ValidationError extends Error {}

function fail(path: string, what: string): never {
	throw new ValidationError(`${path}: ${what}`);
}

function strokeLine(s: Stroke): string {
	return `\t\t\t\t{"id":${j(s.id)},"tool":${j(s.tool)},"color":${j(s.color)},"width":${j(s.width)},"render":${j(s.render)},"points":${j(s.points)}}`;
}

function elementLine(e: PageElement): string {
	if (e.type === "text") {
		return `\t\t\t\t{"id":${j(e.id)},"type":"text","x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"text":${j(e.text)},"fontSize":${j(e.fontSize)},"color":${j(e.color)}}`;
	}
	if (e.type === "image") {
		return `\t\t\t\t{"id":${j(e.id)},"type":"image","asset":${j(e.asset)},"x":${j(e.x)},"y":${j(e.y)},"width":${j(e.width)},"height":${j(e.height)},"rotation":${j(e.rotation)}}`;
	}
	return fail("element", "unknown element type");
}

function assetLine(a: Asset): string {
	return `\t\t${j(a.id)}: {"id":${j(a.id)},"kind":${j(a.kind)},"path":${j(a.path)},"name":${j(a.name)},"bytes":${j(a.bytes)}}`;
}

/** Tags without duplicates; bookmarks without duplicates and without ids of pages that no longer exist. */
function normalizeMeta(meta: NotebookMeta, pageIds: ReadonlySet<string>): NotebookMeta {
	return {
		tags: [...new Set(meta.tags)],
		favorite: meta.favorite,
		cover: meta.cover,
		bookmarks: [...new Set(meta.bookmarks)].filter((id) => pageIds.has(id)),
	};
}

function metaLine(meta: NotebookMeta): string {
	return `{"tags":${j(meta.tags)},"favorite":${j(meta.favorite)},"cover":${j(meta.cover)},"bookmarks":${j(meta.bookmarks)}}`;
}

function assemble(
	doc: NotebookDocument,
	lineOf: (s: Stroke) => string,
	elementLineOf: (e: PageElement) => string = elementLine,
): string {
	const pages = doc.pages.map((page) => {
		const strokes = page.strokes.map(lineOf);
		const elements = (page.elements ?? []).map(elementLineOf);
		const out = [
			"\t\t{",
			`\t\t\t"id": ${j(page.id)},`,
			`\t\t\t"width": ${j(page.width)},`,
			`\t\t\t"height": ${j(page.height)},`,
			`\t\t\t"paper": {"kind":${j(page.paper.kind)},"spacing":${j(page.paper.spacing)}},`,
		];
		const b = page.background;
		if (b) {
			out.push(b.kind === "pdf"
				? `\t\t\t"background": {"kind":"pdf","asset":${j(b.asset)},"page":${j(b.page)}},`
				: `\t\t\t"background": {"kind":${j(b.kind)},"asset":${j(b.asset)}},`);
		}
		const m = page.margins;
		if (m) out.push(`\t\t\t"margins": {"left":${j(m.left)},"right":${j(m.right)},"bottom":${j(m.bottom)}},`);
		if (page.infinite !== undefined) out.push(`\t\t\t"infinite": ${j(page.infinite)},`);
		if (elements.length) out.push(`\t\t\t"elements": [\n${elements.join(",\n")}\n\t\t\t],`);
		out.push(strokes.length ? `\t\t\t"strokes": [\n${strokes.join(",\n")}\n\t\t\t]` : `\t\t\t"strokes": []`);
		out.push("\t\t}");
		return out.join("\n");
	});
	const pageIds = new Set(doc.pages.map((p) => p.id));
	const meta = normalizeMeta(doc.meta ?? DEFAULT_META, pageIds);
	const assets = Object.values(doc.assets ?? {}).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	return [
		"{",
		`\t"format": ${j(doc.format)},`,
		`\t"version": ${j(doc.version)},`,
		`\t"id": ${j(doc.id)},`,
		`\t"createdAt": ${j(doc.createdAt)},`,
		`\t"modifiedAt": ${j(doc.modifiedAt)},`,
		`\t"meta": ${metaLine(meta)},`,
		assets.length ? `\t"assets": {\n${assets.map(assetLine).join(",\n")}\n\t},` : `\t"assets": {},`,
		`\t"pages": [\n${pages.join(",\n")}\n\t]`,
		"}",
		"",
	].join("\n");
}

/**
 * Deterministic serialization: fixed key order, one stroke, element and asset per line.
 * `serialize(parse(s).doc) === s` for every `s` produced by this function.
 * Metadata is written normalised: tags without duplicates, bookmarks without duplicates and
 * without ids of pages that are not in the document (a deleted page may still be bookmarked in memory).
 */
export function serialize(doc: NotebookDocument): string {
	return assemble(doc, strokeLine);
}

function isObject(v: unknown): v is RawObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
	if (typeof v !== "string" || v.length === 0) fail(path, "expected a non-empty string");
	return v;
}

function positive(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(path, "expected a positive number");
	return v;
}

function finite(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "expected a finite number");
	return v;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_RE = /^[0-9a-f]+$/;

function colour(v: unknown, path: string): string {
	if (typeof v !== "string" || !COLOR_RE.test(v)) fail(path, "expected a #rrggbb colour");
	return v;
}

/** Smallest accepted paper spacing, pt (0.5 pt ≈ 0.18 mm; the finest preset is 1 mm). */
export const MIN_PAPER_SPACING = 0.5;
/** Largest accepted text size, pt. */
export const MAX_FONT_SIZE = 400;

function readPoint(v: unknown, path: string): Point {
	if (!Array.isArray(v) || v.length !== 3) fail(path, "expected a [x, y, pressure] point");
	const [x, y, p] = v as unknown[];
	if (typeof x !== "number" || !Number.isFinite(x)) fail(path, "invalid x");
	if (typeof y !== "number" || !Number.isFinite(y)) fail(path, "invalid y");
	if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) fail(path, "pressure outside [0, 1]");
	return [x, y, p];
}

function readStroke(v: unknown, path: string): Stroke {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (!TOOLS.includes(v.tool as Tool)) fail(`${path}.tool`, "unknown tool");
	if (typeof v.color !== "string" || !COLOR_RE.test(v.color)) fail(`${path}.color`, "expected a #rrggbb colour");
	const width = positive(v.width, `${path}.width`);
	if (!RENDER_VERSIONS.includes(v.render as RenderVersion)) fail(`${path}.render`, "expected render version 1 or 2");
	if (!Array.isArray(v.points) || v.points.length === 0) fail(`${path}.points`, "expected at least one point");
	const points = v.points.map((pt, i) => readPoint(pt, `${path}.points[${i}]`));
	return { id, tool: v.tool as Tool, color: v.color, width, render: v.render as RenderVersion, points };
}

type Assets = Readonly<Record<string, Asset>>;

function readAsset(v: unknown, key: string, path: string): Asset {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (!HEX_RE.test(id)) fail(`${path}.id`, "expected lowercase hexadecimal");
	if (id !== key) fail(path, "key does not match the asset id");
	if (v.kind !== "pdf" && v.kind !== "image") fail(`${path}.kind`, "unknown asset kind");
	const assetPath = str(v.path, `${path}.path`);
	if (typeof v.name !== "string") fail(`${path}.name`, "expected a string");
	if (typeof v.bytes !== "number" || !Number.isSafeInteger(v.bytes) || v.bytes < 0) {
		fail(`${path}.bytes`, "expected a non-negative integer");
	}
	return { id, kind: v.kind, path: assetPath, name: v.name, bytes: v.bytes };
}

function requireAsset(assets: Assets, id: string, kind: AssetKind, path: string): void {
	const a = Object.prototype.hasOwnProperty.call(assets, id) ? assets[id] : undefined;
	if (!a) fail(path, "refers to an asset that does not exist");
	if (a.kind !== kind) fail(path, `expected a ${kind} asset, found ${a.kind}`);
}

function readBackground(v: unknown, path: string, assets: Assets): PageBackground {
	if (!isObject(v)) fail(path, "expected an object");
	const asset = str(v.asset, `${path}.asset`);
	if (v.kind === "pdf") {
		if (typeof v.page !== "number" || !Number.isSafeInteger(v.page) || v.page < 1) {
			fail(`${path}.page`, "expected an integer >= 1");
		}
		requireAsset(assets, asset, "pdf", `${path}.asset`);
		return { kind: "pdf", asset, page: v.page };
	}
	if (v.kind === "image") {
		requireAsset(assets, asset, "image", `${path}.asset`);
		return { kind: "image", asset };
	}
	return fail(`${path}.kind`, "unknown background kind");
}

/** v6 margins: non-negative, and the background box they leave keeps a positive size. */
function readMargins(v: unknown, path: string, width: number, height: number): PageMargins {
	if (!isObject(v)) fail(path, "expected an object");
	const side = (x: unknown, name: string): number => {
		const n = finite(x, `${path}.${name}`);
		if (n < 0) fail(`${path}.${name}`, "must not be negative");
		return n;
	};
	const left = side(v.left, "left");
	const right = side(v.right, "right");
	const bottom = side(v.bottom, "bottom");
	if (left + right >= width) fail(path, "left + right must be smaller than the page width");
	if (bottom >= height) fail(`${path}.bottom`, "must be smaller than the page height");
	return { left, right, bottom };
}

function readElement(v: unknown, path: string, assets: Assets): PageElement {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (v.type === "text") {
		if (typeof v.text !== "string") fail(`${path}.text`, "expected a string");
		const fontSize = positive(v.fontSize, `${path}.fontSize`);
		if (fontSize > MAX_FONT_SIZE) fail(`${path}.fontSize`, `must be at most ${MAX_FONT_SIZE} pt`);
		const el: TextElement = {
			id, type: "text",
			x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
			width: positive(v.width, `${path}.width`),
			text: v.text, fontSize, color: colour(v.color, `${path}.color`),
		};
		return el;
	}
	if (v.type === "image") {
		const asset = str(v.asset, `${path}.asset`);
		requireAsset(assets, asset, "image", `${path}.asset`);
		const el: ImageElement = {
			id, type: "image", asset,
			x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`),
			width: positive(v.width, `${path}.width`), height: positive(v.height, `${path}.height`),
			rotation: finite(v.rotation, `${path}.rotation`),
		};
		return el;
	}
	return fail(`${path}.type`, "unknown element type");
}

function readMeta(v: unknown, pageIds: ReadonlySet<string>): NotebookMeta {
	if (v === undefined) return normalizeMeta(DEFAULT_META, pageIds);
	if (!isObject(v)) fail("meta", "expected an object");
	if (!Array.isArray(v.tags)) fail("meta.tags", "expected an array");
	const tags = v.tags.map((t, i) => str(t, `meta.tags[${i}]`));
	if (typeof v.favorite !== "boolean") fail("meta.favorite", "expected a boolean");
	const cover = colour(v.cover, "meta.cover");
	if (!Array.isArray(v.bookmarks)) fail("meta.bookmarks", "expected an array");
	const bookmarks = v.bookmarks.map((b, i) => str(b, `meta.bookmarks[${i}]`));
	return normalizeMeta({ tags, favorite: v.favorite, cover, bookmarks }, pageIds);
}

function readAssets(v: unknown): Record<string, Asset> {
	if (v === undefined) return {};
	if (!isObject(v)) fail("assets", "expected an object");
	const assets: Record<string, Asset> = {};
	for (const [key, a] of Object.entries(v)) assets[key] = readAsset(a, key, `assets.${key}`);
	return assets;
}

function readPage(v: unknown, path: string, ids: Set<string>, assets: Assets): Page {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	const paper = v.paper;
	if (!isObject(paper) || !PAPER_KINDS.includes(paper.kind as PaperKind)) fail(`${path}.paper`, "unknown paper");
	const spacing = positive(paper.spacing, `${path}.paper.spacing`);
	// Below this the pattern would have millions of lines (a hand-edited file could freeze the app).
	if (spacing < MIN_PAPER_SPACING) fail(`${path}.paper.spacing`, `must be at least ${MIN_PAPER_SPACING} pt`);
	if (!Array.isArray(v.strokes)) fail(`${path}.strokes`, "expected an array");
	const strokes = v.strokes.map((s, i) => {
		const stroke = readStroke(s, `${path}.strokes[${i}]`);
		if (ids.has(stroke.id)) fail(`${path}.strokes[${i}].id`, "duplicate id");
		ids.add(stroke.id);
		freezeStroke(stroke);
		validatedStrokes.add(stroke);
		return stroke;
	});
	const page: Page = { id, width, height, paper: { kind: paper.kind as PaperKind, spacing }, strokes };
	if (v.background !== undefined) page.background = readBackground(v.background, `${path}.background`, assets);
	if (v.margins !== undefined) page.margins = readMargins(v.margins, `${path}.margins`, width, height);
	if (v.infinite !== undefined) {
		if (typeof v.infinite !== "boolean") fail(`${path}.infinite`, "expected a boolean");
		page.infinite = v.infinite;
	}
	if (v.elements !== undefined) {
		if (!Array.isArray(v.elements)) fail(`${path}.elements`, "expected an array");
		const elements = v.elements.map((e, i) => {
			const el = readElement(e, `${path}.elements[${i}]`, assets);
			if (ids.has(el.id)) fail(`${path}.elements[${i}].id`, "duplicate id");
			ids.add(el.id);
			return freezeElement(el);
		});
		if (elements.length > 0) page.elements = elements;
	}
	return page;
}

/** Committed strokes are immutable: edits create new strokes. This makes per-stroke caches safe. */
export function freezeStroke(stroke: Stroke): Stroke {
	for (const p of stroke.points) Object.freeze(p);
	Object.freeze(stroke.points);
	return Object.freeze(stroke);
}

/** Elements are immutable like strokes: an edit replaces the object (ReplaceElement). */
export function freezeElement<T extends PageElement>(element: T): T {
	return Object.freeze(element);
}

/** Validates an object already at the current version and returns a copy with known fields only. */
export function validate(raw: unknown): NotebookDocument {
	return validateWith(raw, readPage, new Set<string>());
}

type PageReader = (v: unknown, path: string, ids: Set<string>, assets: Assets) => Page;

/** `validate` with the page reader and the set of ids injected: staged loading reads page shells first (see StagedParse). */
function validateWith(raw: unknown, readPageAt: PageReader, ids: Set<string>): NotebookDocument {
	if (!isObject(raw)) fail("document", "expected an object");
	if (raw.format !== FORMAT_ID) fail("format", `expected "${FORMAT_ID}"`);
	if (raw.version !== CURRENT_VERSION) fail("version", `expected ${CURRENT_VERSION}`);
	const id = str(raw.id, "id");
	const createdAt = str(raw.createdAt, "createdAt");
	const modifiedAt = str(raw.modifiedAt, "modifiedAt");
	if (!Array.isArray(raw.pages) || raw.pages.length === 0) fail("pages", "expected at least one page");
	const assets = readAssets(raw.assets);
	const pageIds = new Set<string>();
	const pages = raw.pages.map((p, i) => {
		const page = readPageAt(p, `pages[${i}]`, ids, assets);
		// Page ids key bookmarks, jumps and caches: two pages with one id would be confused with each other.
		if (pageIds.has(page.id)) fail(`pages[${i}].id`, "duplicate id");
		pageIds.add(page.id);
		return page;
	});
	const meta = readMeta(raw.meta, new Set(pages.map((p) => p.id)));
	return { format: FORMAT_ID, version: CURRENT_VERSION, id, createdAt, modifiedAt, pages, meta, assets };
}

type ParseFailureResult = ParseResult & { ok: false };

type Preflight = { ok: true; raw: RawObject; version: number } | { ok: false; failure: ParseFailureResult };

/** JSON syntax, "is it a notebook" and the version check: everything before the content is looked at. */
function preflight(text: string): Preflight {
	if (text.trim().length === 0) return { ok: false, failure: { ok: false, reason: "empty", message: "the file is empty" } };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, failure: { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` } };
	}
	const notNotebook: Preflight = { ok: false, failure: { ok: false, reason: "not-notebook", message: "not a Notebook document" } };
	if (!isObject(raw)) return notNotebook;
	const version = detectVersion(raw);
	if (version === null || (version >= 1 && raw.format !== FORMAT_ID)) return notNotebook;
	if (version > CURRENT_VERSION) {
		return {
			ok: false,
			failure: {
				ok: false, reason: "future-version", version,
				message: `created by a newer version of Notebook (format v${version}, this version reads up to v${CURRENT_VERSION})`,
			},
		};
	}
	return { ok: true, raw, version };
}

/** Migrates and validates a parsed file. */
function parseRaw(raw: RawObject, version: number): ParseResult {
	try {
		const migrated = version < CURRENT_VERSION ? migrate(raw, version, CURRENT_VERSION) : raw;
		return { ok: true, doc: validate(migrated), migratedFrom: version < CURRENT_VERSION ? version : null };
	} catch (e) {
		if (e instanceof ValidationError || e instanceof MigrationError) {
			return { ok: false, reason: "invalid", message: e.message, version };
		}
		throw e;
	}
}

export function parse(text: string): ParseResult {
	const pre = preflight(text);
	return pre.ok ? parseRaw(pre.raw, pre.version) : pre.failure;
}

/**
 * Texts shorter than this (characters, about 3,000 strokes) are always parsed in one go: that is tens of milliseconds
 * on a PC, and staging has a fixed cost of its own (slices, an extra paint before the end).
 */
export const STAGED_MIN_CHARS = 2_000_000;

/** A page that has not been read yet: right id, size and paper, no ink, nothing else. */
function readPageShell(v: unknown, path: string): Page {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	const paper = v.paper;
	if (!isObject(paper) || !PAPER_KINDS.includes(paper.kind as PaperKind)) fail(`${path}.paper`, "unknown paper");
	const spacing = positive(paper.spacing, `${path}.paper.spacing`);
	if (spacing < MIN_PAPER_SPACING) fail(`${path}.paper.spacing`, `must be at least ${MIN_PAPER_SPACING} pt`);
	return { id, width, height, paper: { kind: paper.kind as PaperKind, spacing }, strokes: [] };
}

export type StagedStep =
	| { ok: true; /** Indices of the pages read by this step. */ changed: number[]; done: boolean }
	| { ok: false; failure: ParseFailureResult };

/**
 * A file parsed in stages (#329). `parseStaged` runs the JSON parse and validates the header, the assets, the
 * metadata and the pages one level deep (every page's id, size and paper), and reads one page completely: the
 * one the reader wants. `doc` then has real content on that page and stand-ins (right size, no ink) elsewhere,
 * so the page can be painted at once. `step` reads the other pages, nearest first, in slices of time that leave
 * the input alone; `finish` reads whatever is left.
 *
 * `doc` is for DISPLAY ONLY until `done`: it is missing the ink of the unread pages, so saving it would erase
 * them. `DocumentSession` therefore keeps it out of `session.doc` and `mode` stays "loading" until the last page is
 * read and every page has passed exactly the validation `validate` applies (same readers, one shared set of
 * ids, so duplicate ids across pages are still found). A page that fails ends the load like a damaged file.
 */
export class StagedParse {
	private readonly queue: number[];
	private failure: ParseFailureResult | null = null;

	private constructor(
		readonly doc: NotebookDocument,
		private readonly rawPages: readonly unknown[],
		private readonly ids: Set<string>,
		first: number,
	) {
		// Nearest to the wanted page first: forward, then back (the next page is the likelier swipe).
		const order: number[] = [];
		for (let d = 1; d < rawPages.length; d++) {
			if (first + d < rawPages.length) order.push(first + d);
			if (first - d >= 0) order.push(first - d);
		}
		this.queue = order;
	}

	/** Prepares a staged parse of a file already at the current version, with page `first` (0-based) read in full. */
	static create(raw: RawObject, first: number): StagedParse | ParseFailureResult {
		try {
			const ids = new Set<string>();
			const doc = validateWith(raw, readPageShell, ids);
			const rawPages = raw.pages as unknown[];
			const at = Math.min(rawPages.length - 1, Math.max(0, first));
			const staged = new StagedParse(doc, rawPages, ids, at);
			staged.read(at);
			return staged;
		} catch (e) {
			if (e instanceof ValidationError) return { ok: false, reason: "invalid", message: e.message, version: CURRENT_VERSION };
			throw e;
		}
	}

	private read(i: number): void {
		this.doc.pages[i] = readPage(this.rawPages[i], `pages[${i}]`, this.ids, this.doc.assets ?? {});
	}

	get pending(): number {
		return this.queue.length;
	}

	get done(): boolean {
		return this.queue.length === 0 && this.failure === null;
	}

	/** Reads pages for about `budgetMs` (at least one page, if any is left). */
	step(budgetMs: number, now: () => number = () => performance.now()): StagedStep {
		if (this.failure) return { ok: false, failure: this.failure };
		const changed: number[] = [];
		const end = now() + budgetMs;
		try {
			while (this.queue.length > 0) {
				const i = this.queue.shift()!;
				this.read(i);
				changed.push(i);
				if (now() >= end) break;
			}
		} catch (e) {
			if (!(e instanceof ValidationError)) throw e;
			this.failure = { ok: false, reason: "invalid", message: e.message, version: CURRENT_VERSION };
			return { ok: false, failure: this.failure };
		}
		return { ok: true, changed, done: this.queue.length === 0 };
	}

	/** Reads every page that is left, at once. */
	finish(): ParseResult {
		const r = this.step(Infinity);
		return r.ok ? { ok: true, doc: this.doc, migratedFrom: null } : r.failure;
	}
}

/**
 * Like `parse`, but a large file at the current version comes back as a StagedParse. Everything else (small
 * files, older versions that need migrating, damaged files) is parsed completely and returned as a ParseResult.
 * `firstPage` is 1-based (the page the reader wants), or null.
 */
export function parseStaged(text: string, firstPage: number | null): StagedParse | ParseResult {
	if (text.length < STAGED_MIN_CHARS) return parse(text);
	const pre = preflight(text);
	if (!pre.ok) return pre.failure;
	if (pre.version !== CURRENT_VERSION) return parseRaw(pre.raw, pre.version);
	return StagedParse.create(pre.raw, firstPage === null ? 0 : firstPage - 1);
}

export type CheckedSerialization = { ok: true; text: string } | { ok: false; message: string };

/** Serialized line of each committed (frozen) stroke that already passed the round-trip check. */
const verifiedLines = new WeakMap<Stroke, string>();
/** Frozen strokes produced by readStroke() while parsing a file: already validated field by field. */
const validatedStrokes = new WeakSet<Stroke>();

/**
 * Caches the serialized line of already-validated strokes ahead of the first save, so that save
 * does not pay for the whole document at once. Returns how many strokes were processed.
 */
export function warmStrokeLines(strokes: readonly Stroke[]): number {
	let n = 0;
	for (const s of strokes) {
		if (verifiedLines.has(s) || !validatedStrokes.has(s)) continue;
		verifiedLines.set(s, strokeLine(s));
		n++;
	}
	return n;
}

/** Below this size the whole file is re-parsed on every save; above it, only new strokes are. */
export const FULL_CHECK_LIMIT = 1_000_000;

/**
 * Serializes and re-validates before writing (CLAUDE.md rule 4).
 *
 * Small documents are fully re-parsed. For large ones the check is incremental, so saving
 * a 10,000-stroke notebook does not re-parse megabytes each time: every stroke line is
 * parsed, validated and re-serialized once (strokes are frozen, so it cannot change later),
 * and the document skeleton (header, meta, assets, pages, backgrounds, elements) is validated
 * and round-trip checked on every save, which also catches dangling asset references.
 */
export function serializeChecked(doc: NotebookDocument, forceFull = false): CheckedSerialization {
	try {
		for (const [key, asset] of Object.entries(doc.assets ?? {})) {
			if (key !== asset.id) fail(`assets.${key}`, "key does not match the asset id");
		}
		const ids = new Set<string>();
		const text = assemble(doc, (s) => {
			if (ids.has(s.id)) fail(`stroke ${s.id}`, "duplicate id");
			ids.add(s.id);
			const cached = verifiedLines.get(s);
			if (cached !== undefined) return cached;
			if (validatedStrokes.has(s)) {
				// Read from a file and validated by readStroke(); frozen since, so it cannot have changed.
				const line = strokeLine(s);
				verifiedLines.set(s, line);
				return line;
			}
			const line = strokeLine(s);
			const back = readStroke(JSON.parse(line), `stroke ${s.id}`);
			if (strokeLine(back) !== line) fail(`stroke ${s.id}`, "round-trip mismatch");
			if (Object.isFrozen(s) && Object.isFrozen(s.points)) verifiedLines.set(s, line);
			return line;
		}, (e) => {
			// Ids are unique across strokes and elements; the content is validated by the parse below.
			if (ids.has(e.id)) fail(`element ${e.id}`, "duplicate id");
			ids.add(e.id);
			return elementLine(e);
		});
		if (forceFull || text.length < FULL_CHECK_LIMIT) {
			const check = parse(text);
			if (!check.ok) return { ok: false, message: check.message };
			if (serialize(check.doc) !== text) return { ok: false, message: "round-trip mismatch" };
		} else {
			const skeleton = { ...doc, pages: doc.pages.map((p) => ({ ...p, strokes: [] })) };
			const skeletonText = assemble(skeleton, strokeLine);
			const check = parse(skeletonText);
			if (!check.ok) return { ok: false, message: check.message };
			if (assemble(check.doc, strokeLine) !== skeletonText) return { ok: false, message: "round-trip mismatch" };
		}
		return { ok: true, text };
	} catch (e) {
		if (e instanceof ValidationError || e instanceof SyntaxError) return { ok: false, message: e.message };
		throw e;
	}
}
