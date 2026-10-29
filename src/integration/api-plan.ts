/**
 * Pure part of the public API (docs/api.md): argument validation, the documents and edits the calls produce, and the
 * plan of a write to a notebook that is not open. No 'obsidian': testable in Node.
 *
 * An edit is described once, as model commands (`Prepare`). An open notebook runs them through its session (one undo
 * step, normal save path); a closed one gets them applied to the parsed file, re-validated and written
 * (`planClosedEdit`), the same way "Move to notebook…" writes a closed destination.
 */
import { createDocument, createId, createPage } from "../model/document";
import { AddAsset, AddElement, InsertPages, type Command } from "../model/history";
import { parse, serializeChecked } from "../model/serialize";
import { normalizeTagList } from "../model/tags";
import {
	PAGE_SIZES, PAPER_KINDS, PAPER_SPACING,
	type Asset, type ImageElement, type NotebookDocument, type Page, type PageSizeName, type PaperKind,
} from "../model/types";
import { sniffImage } from "../scan/image-bytes";
import { centredPosition, imageElementSize } from "../view/view-helpers";
import { invalid, NotebookApiError } from "./api-errors";

/** Version of the public API (semver): a new method or option raises the minor number, a breaking change the major one. */
export const API_VERSION = "1.0.0";
/** Names of the methods of the API (`NotebookApi` in api.ts), for the check that docs/api.md describes all of them. */
export const API_METHODS = ["createNotebook", "addPages", "insertImage", "exportPdf", "getNotebookInfo", "openNotebook", "listNotebooks"] as const;
/** Pages one call may create. */
export const MAX_PAGES_PER_CALL = 500;
/** Largest image `insertImage` accepts, bytes. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const FILE_EXT = /\.notebook$/i;

// ------------------------------------------------------------------- arguments

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The options object of a call: undefined/null = none; anything but a plain object, or a field not in `known`, is refused. */
function checkOptions(argument: string, v: unknown, known: readonly string[]): Record<string, unknown> {
	if (v === undefined || v === null) return {};
	if (!isRecord(v)) throw invalid(argument, "expected an object");
	for (const key of Object.keys(v)) {
		if (!known.includes(key)) throw invalid(argument, `unknown option "${key}" (known: ${known.join(", ")})`, { option: key });
	}
	return v;
}

function optBoolean(argument: string, v: unknown): boolean | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw invalid(argument, "expected true or false");
	return v;
}

function optNumber(argument: string, v: unknown, min: number, max: number): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw invalid(argument, `expected a number from ${min} to ${max}`);
	return v;
}

function checkInteger(argument: string, v: unknown, min: number, max: number): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(argument, `expected a whole number from ${min} to ${max}`, { value: v });
	return v;
}

function optPaper(argument: string, v: unknown): PaperKind | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !(PAPER_KINDS as readonly string[]).includes(v)) throw invalid(argument, `expected one of ${PAPER_KINDS.join(", ")}`, { value: v });
	return v as PaperKind;
}

function optSize(argument: string, v: unknown): PageSizeName | undefined {
	if (v === undefined) return undefined;
	const names = Object.keys(PAGE_SIZES);
	if (typeof v !== "string" || !names.includes(v)) throw invalid(argument, `expected one of ${names.join(", ")}`, { value: v });
	return v as PageSizeName;
}

/**
 * A folder of the vault: forward slashes, no `.`/`..`/hidden segments, none of `:*?"<>|`. "" or "/" is the vault root.
 * Returns the normalised path without leading or trailing slash.
 */
export function checkFolder(v: unknown): string {
	if (typeof v !== "string") throw invalid("folder", "expected a vault folder path (use \"\" or \"/\" for the vault root)");
	const parts = v.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p.length > 0);
	for (const part of parts) {
		if (part.startsWith(".") || /[:*?"<>|]/.test(part) || [...part].some((c) => c.charCodeAt(0) < 32)) throw invalid("folder", `"${part}" is not allowed in a folder path`, { value: v });
	}
	return parts.join("/");
}

/** A notebook name: a non-empty string; a trailing `.notebook` is dropped. The caller still sanitises it for the file system. */
export function checkName(v: unknown): string {
	if (typeof v !== "string") throw invalid("name", "expected a notebook name");
	const name = v.trim().replace(FILE_EXT, "").trim();
	if (name.length === 0) throw invalid("name", "must not be empty");
	if (name.length > 200) throw invalid("name", "must be at most 200 characters", { length: name.length });
	return name;
}

/** A 1-based page number of a notebook with `pageCount` pages. */
export function checkPageNumber(argument: string, v: unknown, pageCount: number): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > pageCount) {
		throw invalid(argument, `expected a page number from 1 to ${pageCount}`, { value: v, pageCount });
	}
	return v;
}

/** `after` of `addPages`: 0 inserts at the start, `pageCount` (or omitted) at the end. */
export function checkAfter(v: unknown, pageCount: number): number {
	if (v === undefined || v === null) return pageCount;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > pageCount) {
		throw invalid("after", `expected a page number from 0 (at the start) to ${pageCount} (at the end)`, { value: v, pageCount });
	}
	return v;
}

// ------------------------------------------------------------------- new notebook

export interface CreateNotebookOptions {
	/** `"a4"` (default: the plugin setting), `"a5"` or `"letter"`. */
	pageSize?: PageSizeName;
	landscape?: boolean;
	/** `"blank"`, `"ruled"`, `"grid"`, `"dotted"` or `"millimetre"`. */
	paper?: PaperKind;
	/** Pages in the new notebook, 1 to 500 (default 1). */
	pages?: number;
	/** Tags; written like Obsidian tags (no `#`, spaces become `-`). */
	tags?: string[];
	favorite?: boolean;
	/** Cover colour, `#rrggbb`. */
	cover?: string;
	/** Open the notebook after creating it (default false). */
	open?: boolean;
}

export interface ParsedCreate {
	pageSize?: PageSizeName;
	landscape?: boolean;
	paper?: PaperKind;
	pages: number;
	tags: string[];
	favorite?: boolean;
	cover?: string;
	open: boolean;
}

const CREATE_KEYS = ["pageSize", "landscape", "paper", "pages", "tags", "favorite", "cover", "open"] as const;

export function parseCreateOptions(v: unknown): ParsedCreate {
	const o = checkOptions("options", v, CREATE_KEYS);
	const out: ParsedCreate = { pages: 1, tags: [], open: false };
	const size = optSize("options.pageSize", o.pageSize);
	if (size !== undefined) out.pageSize = size;
	const landscape = optBoolean("options.landscape", o.landscape);
	if (landscape !== undefined) out.landscape = landscape;
	const paper = optPaper("options.paper", o.paper);
	if (paper !== undefined) out.paper = paper;
	if (o.pages !== undefined) out.pages = checkInteger("options.pages", o.pages, 1, MAX_PAGES_PER_CALL);
	if (o.tags !== undefined) {
		if (!Array.isArray(o.tags) || !o.tags.every((x) => typeof x === "string")) throw invalid("options.tags", "expected an array of strings");
		const { tags, rejected } = normalizeTagList(o.tags);
		if (rejected.length > 0) throw invalid("options.tags", `not valid tags (only digits or only symbols): ${rejected.join(", ")}`, { rejected });
		out.tags = tags;
	}
	const favorite = optBoolean("options.favorite", o.favorite);
	if (favorite !== undefined) out.favorite = favorite;
	if (o.cover !== undefined) {
		if (typeof o.cover !== "string" || !/^#[0-9a-fA-F]{6}$/.test(o.cover)) throw invalid("options.cover", "expected a colour like #3b82f6", { value: o.cover });
		out.cover = o.cover.toLowerCase();
	}
	const open = optBoolean("options.open", o.open);
	if (open !== undefined) out.open = open;
	return out;
}

export interface NewDocumentDefaults {
	pageSize: PageSizeName;
	landscape: boolean;
	paper: PaperKind;
}

/** The document `createNotebook` writes: the plugin's defaults for what the options leave out. */
export function buildNewDocument(opts: ParsedCreate, defaults: NewDocumentDefaults, now: Date): NotebookDocument {
	const base = PAGE_SIZES[opts.pageSize ?? defaults.pageSize];
	const landscape = opts.landscape ?? defaults.landscape;
	const size = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
	const kind = opts.paper ?? defaults.paper;
	const paper = { kind, spacing: PAPER_SPACING[kind] };
	const doc = createDocument(now, size, paper);
	for (let i = 1; i < opts.pages; i++) doc.pages.push(createPage(size, { ...paper }));
	doc.meta = {
		tags: [...opts.tags],
		favorite: opts.favorite ?? doc.meta!.favorite,
		cover: opts.cover ?? doc.meta!.cover,
		bookmarks: [],
	};
	return doc;
}

// ------------------------------------------------------------------- pages

/** What `addPages` creates besides a count: anything left out is copied from the page next to the insertion point. */
export interface PageTemplate {
	/** How many pages (default 1). */
	count?: number;
	pageSize?: PageSizeName;
	landscape?: boolean;
	paper?: PaperKind;
	/** Paper spacing in pt; default: the paper's own. */
	spacing?: number;
	/** An infinite page grows downwards while writing. */
	infinite?: boolean;
}

export interface PageSpec {
	count: number;
	pageSize?: PageSizeName;
	landscape?: boolean;
	paper?: PaperKind;
	spacing?: number;
	infinite?: boolean;
}

const TEMPLATE_KEYS = ["count", "pageSize", "landscape", "paper", "spacing", "infinite"] as const;

/** `addPages`' second argument: a count, or a template. */
export function parsePageSpec(v: unknown): PageSpec {
	if (typeof v === "number") return { count: checkInteger("pages", v, 1, MAX_PAGES_PER_CALL) };
	if (!isRecord(v)) throw invalid("pages", "expected a number of pages or a template object");
	const o = checkOptions("pages", v, TEMPLATE_KEYS);
	const spec: PageSpec = { count: o.count === undefined ? 1 : checkInteger("pages.count", o.count, 1, MAX_PAGES_PER_CALL) };
	const size = optSize("pages.pageSize", o.pageSize);
	if (size !== undefined) spec.pageSize = size;
	const landscape = optBoolean("pages.landscape", o.landscape);
	if (landscape !== undefined) spec.landscape = landscape;
	const paper = optPaper("pages.paper", o.paper);
	if (paper !== undefined) spec.paper = paper;
	const spacing = optNumber("pages.spacing", o.spacing, 1, 500);
	if (spacing !== undefined) spec.spacing = spacing;
	const infinite = optBoolean("pages.infinite", o.infinite);
	if (infinite !== undefined) spec.infinite = infinite;
	return spec;
}

/**
 * The new pages. `like` is the page next to the insertion point: size and paper come from it unless the template says
 * otherwise (as the *Add page* button does); like the button, no background and no content are copied.
 */
export function buildPages(spec: PageSpec, like: Page | undefined): Page[] {
	let width = like?.width ?? PAGE_SIZES.a4.width;
	let height = like?.height ?? PAGE_SIZES.a4.height;
	if (spec.pageSize) {
		width = PAGE_SIZES[spec.pageSize].width;
		height = PAGE_SIZES[spec.pageSize].height;
	}
	if (spec.landscape !== undefined && (width > height) !== spec.landscape) [width, height] = [height, width];
	const kind: PaperKind = spec.paper ?? like?.paper.kind ?? "grid";
	const spacing = spec.spacing ?? (spec.paper ? PAPER_SPACING[spec.paper] : (like?.paper.spacing ?? PAPER_SPACING[kind]));
	const pages: Page[] = [];
	for (let i = 0; i < spec.count; i++) {
		const page = createPage({ width, height }, { kind, spacing });
		if (spec.infinite === true) page.infinite = true;
		pages.push(page);
	}
	return pages;
}

// ------------------------------------------------------------------- edits

/** What an edit does, built once for the live document (open notebook) or the parsed file (closed one). */
export interface EditPlan<R> {
	/** Model commands, run in order as one undo step (open notebook) or applied to the parsed file (closed one). */
	commands: Command[];
	result: R;
	/** True when the document read back from the file contains the change. */
	verify(doc: NotebookDocument): boolean;
}

/** Validates the call against `doc` (page numbers…) and returns the edit; throws `NotebookApiError`. */
export type Prepare<R> = (doc: NotebookDocument) => EditPlan<R>;

export interface AddPagesResult {
	/** Pages created. */
	added: number;
	/** Number of the first new page (1-based). */
	firstPage: number;
	/** Pages in the notebook after the call. */
	pageCount: number;
}

/** `addPages`: new pages after page `after` (0 = at the start; omitted = at the end). */
export function prepareAddPages(spec: PageSpec, after: unknown): Prepare<AddPagesResult> {
	return (doc) => {
		const at = checkAfter(after, doc.pages.length);
		const like = doc.pages[Math.max(0, at - 1)];
		const pages = buildPages(spec, like);
		const ids = pages.map((p) => p.id);
		return {
			commands: [new InsertPages(pages, at)],
			result: { added: pages.length, firstPage: at + 1, pageCount: doc.pages.length + pages.length },
			verify: (back) => ids.every((id) => back.pages.some((p) => p.id === id)),
		};
	};
}


export interface InsertImageOptions {
	/** Left edge on the page, pt. Default: centred. */
	x?: number;
	/** Top edge on the page, pt. Default: centred. */
	y?: number;
	/** Width on the page, pt. Default: the image at 96 dpi, at most 60 % of the page. */
	width?: number;
	/** Height on the page, pt. Default: keeps the image's proportions. */
	height?: number;
}

export type ParsedImageOptions = InsertImageOptions;

const IMAGE_KEYS = ["x", "y", "width", "height"] as const;

export function parseImageOptions(v: unknown): ParsedImageOptions {
	const o = checkOptions("options", v, IMAGE_KEYS);
	const out: ParsedImageOptions = {};
	const x = optNumber("options.x", o.x, -100_000, 100_000);
	if (x !== undefined) out.x = x;
	const y = optNumber("options.y", o.y, -100_000, 100_000);
	if (y !== undefined) out.y = y;
	for (const key of ["width", "height"] as const) {
		const n = o[key];
		if (n === undefined) continue;
		if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 20_000) throw invalid(`options.${key}`, "expected a size in pt greater than 0 and at most 20000", { value: n });
		out[key] = n;
	}
	return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The image element: sized and placed as the options say, otherwise as the toolbar's *Insert image* does on this page. */
export function buildImageElement(page: Page, dims: { width: number; height: number }, assetId: string, opts: ParsedImageOptions, id = createId()): ImageElement {
	if (!(dims.width > 0 && dims.height > 0)) throw new NotebookApiError("unsupported-image", "The image has no size.");
	const aspect = dims.width / dims.height;
	let size = imageElementSize(dims.width, dims.height, page.width, page.height);
	if (opts.width !== undefined && opts.height !== undefined) size = { width: opts.width, height: opts.height };
	else if (opts.width !== undefined) size = { width: opts.width, height: opts.width / aspect };
	else if (opts.height !== undefined) size = { width: opts.height * aspect, height: opts.height };
	size = { width: round2(size.width), height: round2(size.height) };
	const [cx, cy] = centredPosition(page.width / 2, page.height / 2, size, page);
	return { id, type: "image", asset: assetId, x: round2(opts.x ?? cx), y: round2(opts.y ?? cy), width: size.width, height: size.height, rotation: 0 };
}

export interface InsertImageResult {
	/** Id of the image element on the page. */
	elementId: string;
	/** Id (content hash) of the stored file in `_assets/`. */
	assetId: string;
	/** The page it went to (1-based). */
	page: number;
}

/** `insertImage`: an image element on page `pageNumber`, the stored file registered in the notebook. */
export function prepareInsertImage(
	pageNumber: unknown, asset: Asset, dims: { width: number; height: number }, opts: ParsedImageOptions,
): Prepare<InsertImageResult> {
	return (doc) => {
		const number = checkPageNumber("page", pageNumber, doc.pages.length);
		const page = doc.pages[number - 1]!;
		const element = buildImageElement(page, dims, asset.id, opts);
		return {
			commands: [new AddAsset(asset), new AddElement(page.id, element, page.elements?.length ?? 0)],
			result: { elementId: element.id, assetId: asset.id, page: number },
			verify: (back) => back.pages.some((p) => p.id === page.id && (p.elements ?? []).some((e) => e.id === element.id && e.type === "image"))
				&& back.assets?.[asset.id] !== undefined,
		};
	};
}

/** Image formats `insertImage` accepts (by the file's first bytes, not its name). */
export const IMAGE_FORMATS = { jpeg: "jpg", png: "png", gif: "gif", webp: "webp" } as const;

/** File extension for the bytes, or null when they are not a PNG, JPEG, GIF or WebP image. */
export function imageExtension(bytes: ArrayBuffer | Uint8Array): string | null {
	const kind = sniffImage(bytes);
	return kind in IMAGE_FORMATS ? IMAGE_FORMATS[kind as keyof typeof IMAGE_FORMATS] : null;
}

// ------------------------------------------------------------------- reading

export interface PageInfo {
	/** 1-based. */
	number: number;
	id: string;
	width: number;
	height: number;
	paper: { kind: PaperKind; spacing: number };
	infinite: boolean;
	strokes: number;
	textBoxes: number;
	images: number;
	/** What is drawn under the paper: a PDF page, an image, or nothing. */
	background: "pdf" | "image" | null;
	bookmarked: boolean;
}

export interface NotebookInfo {
	path: string;
	/** File name without extension. */
	name: string;
	/** Document id (also the `notebook-id` property of the companion note). */
	id: string;
	/** Format version of the document in the file. */
	formatVersion: number;
	createdAt: string;
	modifiedAt: string;
	pageCount: number;
	pages: PageInfo[];
	/** The notebook's tags as stored (no `#`). */
	tags: string[];
	meta: { favorite: boolean; cover: string; /** Bookmarked page numbers (1-based). */ bookmarks: number[] };
	/** True when the notebook is open in a tab (the numbers then include unsaved changes). */
	open: boolean;
}

export function describeNotebook(doc: NotebookDocument, file: { path: string; basename: string }, open: boolean): NotebookInfo {
	const marked = new Set(doc.meta?.bookmarks ?? []);
	const pages: PageInfo[] = doc.pages.map((p, i) => ({
		number: i + 1,
		id: p.id,
		width: p.width,
		height: p.height,
		paper: { kind: p.paper.kind, spacing: p.paper.spacing },
		infinite: p.infinite === true,
		strokes: p.strokes.length,
		textBoxes: (p.elements ?? []).filter((e) => e.type === "text").length,
		images: (p.elements ?? []).filter((e) => e.type === "image").length,
		background: p.background ? p.background.kind : null,
		bookmarked: marked.has(p.id),
	}));
	return {
		path: file.path,
		name: file.basename,
		id: doc.id,
		formatVersion: doc.version,
		createdAt: doc.createdAt,
		modifiedAt: doc.modifiedAt,
		pageCount: pages.length,
		pages,
		tags: [...(doc.meta?.tags ?? [])],
		meta: {
			favorite: doc.meta?.favorite ?? false,
			cover: doc.meta?.cover ?? "",
			bookmarks: pages.filter((p) => p.bookmarked).map((p) => p.number),
		},
		open,
	};
}

// ------------------------------------------------------------------- closed notebook

export type ClosedPlan<R> =
	| { ok: true; text: string; result: R; migrated: boolean; verify(text: string): boolean }
	| { ok: false; error: NotebookApiError };

/**
 * Plan of an edit to a notebook that is not open, from the document text read from the file. Never produces text unless
 * the file parses, the edit applies, the result passes the full round-trip check (`serializeChecked`) and the change is
 * visible when that text is parsed again. The caller keeps a backup of `before`, writes only if the file still holds
 * `before`, reads the file back and runs `verify` on it.
 * `Prepare` errors (`NotebookApiError`) are thrown, so a bad argument is reported as such.
 */
export function planClosedEdit<R>(before: string, prepare: Prepare<R>, now: Date): ClosedPlan<R> {
	const parsed = parse(before);
	if (!parsed.ok) {
		const message = parsed.reason === "future-version"
			? "This notebook was written by a newer version of the plugin and is not edited."
			: `This notebook cannot be read (${parsed.message}). It was not changed.`;
		return { ok: false, error: new NotebookApiError("unreadable", message, { reason: parsed.reason }) };
	}
	const doc = parsed.doc;
	const plan = prepare(doc);
	for (const command of plan.commands) command.apply(doc);
	doc.modifiedAt = now.toISOString();
	const checked = serializeChecked(doc, true);
	if (!checked.ok) return { ok: false, error: new NotebookApiError("write-failed", `The result did not pass validation, so nothing was written: ${checked.message}`) };
	const verify = (text: string): boolean => {
		const back = parse(text);
		return back.ok && plan.verify(back.doc);
	};
	if (!verify(checked.text)) return { ok: false, error: new NotebookApiError("write-failed", "The change was not found in the validated result, so nothing was written.") };
	return { ok: true, text: checked.text, result: plan.result, migrated: parsed.migratedFrom !== null, verify };
}

/** Runs async jobs one after the other per key (a notebook path), so two calls never race on one file. */
export class KeyedQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, job: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(job);
		const tail = result.then(() => undefined, () => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}
}
