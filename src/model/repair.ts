/**
 * Guided repair of damaged notebooks (roadmap #140). Pure, no Obsidian imports.
 *
 * `repairNotebookText(text)` recovers every valid page, stroke, element and asset it can from the
 * raw text of a notebook that `parse()` rejects, and returns a complete, validated document plus a
 * summary of what was recovered and what was lost. The original text is only read; the caller writes
 * the result into a NEW notebook.
 *
 * How the text is read:
 * 1. `parseLenient` reads the JSON up to the first damage (truncation, garbage): what was read in
 *    full is kept, open objects and arrays are closed there, a value read only in part is dropped.
 * 2. When the JSON is not complete, a line scan reads the layout `serialize()` writes (one stroke,
 *    element and asset per line, page fields on their own lines), so strokes AFTER a damaged region
 *    in the middle of the file are recovered too. Its items are added to those of step 1 by id; a
 *    stroke cut off in step 1 is replaced by its intact line from step 2.
 * 3. The result goes through the regular migrations (so a file of an older version, and of any
 *    version added later, is upgraded the same way as on open). If the whole document does not
 *    migrate, pages and then single strokes are migrated one at a time and the ones that fail are lost.
 * 4. Every item is checked by the regular validator (`validate`, on a one-item document), so the rules
 *    stay in one place. An item that fails gets simple, conservative fixes (invalid points dropped,
 *    pressure clamped, unknown tool -> pen, bad colour -> black, missing render -> 1, duplicate id ->
 *    new id) and is kept if it then validates; otherwise it is counted as lost.
 *
 * Unknown fields (for example from a newer version) cannot be carried into the repaired notebook: the
 * document model and the serializer only know the current fields. They are counted, and they remain
 * in the original file, which is never modified.
 */
import { createId } from "./document";
import { parseLenient } from "./lenient-json";
import { detectVersion, migrate, type RawObject } from "./migrations";
import { parse, serializeChecked, validate, MAX_FONT_SIZE } from "./serialize";
import {
	A4_HEIGHT, A4_WIDTH, CURRENT_VERSION, DEFAULT_META, FORMAT_ID, PAPER_SPACING, RENDER_FREEHAND, RENDER_VERSIONS, TOOLS,
	type Asset, type NotebookDocument, type NotebookMeta, type Page, type PageElement, type Stroke,
} from "./types";

export interface Counts {
	/** Items kept exactly as they were. */
	recovered: number;
	/** Items kept after a fix (some points dropped, a field reset, a new id). */
	repaired: number;
	/** Items found in the text that could not be kept. */
	lost: number;
}

export interface RepairSummary {
	pages: Counts;
	strokes: Counts;
	elements: Counts;
	assets: Counts;
	/** Page backgrounds that could not be kept (their page is kept). */
	backgroundsLost: number;
	/** Fields that were reset to a default (page size, paper, metadata, timestamps). */
	fieldsReset: number;
	/** Fields not known to this version, not carried into the repaired notebook (they stay in the original). */
	unknownFields: number;
	/** Items found twice (same id, same content) and kept once. */
	duplicates: number;
	/** The text is not complete JSON: anything after `damageAt` that the line scan could not read is unknown. */
	damaged: boolean;
	/** Character offset of the first damage, or null. */
	damageAt: number | null;
	/** Format version declared by the text, or null when unknown. */
	sourceVersion: number | null;
	/** The text already parses as a notebook (nothing to repair). */
	alreadyReadable: boolean;
}

export type RepairFailure = "empty" | "not-notebook" | "future-version" | "nothing";

export type RepairResult =
	| { ok: true; doc: NotebookDocument; text: string; summary: RepairSummary }
	| { ok: false; reason: RepairFailure; message: string; summary?: RepairSummary };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Page fields of the current format (a field dropped by the repair is not "unknown"). */
const PAGE_FIELDS = { id: 1, width: 1, height: 1, paper: 1, strokes: 1, elements: 1, background: 1, infinite: 1 };
const HEX_RE = /^[0-9a-f]+$/;

function isObj(v: unknown): v is RawObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function counts(): Counts {
	return { recovered: 0, repaired: 0, lost: 0 };
}

function emptySummary(): RepairSummary {
	return {
		pages: counts(), strokes: counts(), elements: counts(), assets: counts(),
		backgroundsLost: 0, fieldsReset: 0, unknownFields: 0, duplicates: 0,
		damaged: false, damageAt: null, sourceVersion: null, alreadyReadable: false,
	};
}

/** Total of items kept (recovered or repaired): strokes, elements and pages. Used to rank sources. */
export function recoveredItems(s: RepairSummary): number {
	const kept = (c: Counts) => c.recovered + c.repaired;
	return kept(s.strokes) + kept(s.elements) + kept(s.pages);
}

// ------------------------------------------------------------------ line scan

interface ScannedPage {
	raw: RawObject;
	strokes: unknown[];
	elements: unknown[];
}

interface Scanned {
	header: RawObject;
	assets: RawObject;
	pages: ScannedPage[];
	/** Stroke and element lines found before any page start. */
	orphans: { strokes: unknown[]; elements: unknown[] };
}

function jsonOrUndefined(text: string): unknown {
	const t = text.endsWith(",") ? text.slice(0, -1) : text;
	try {
		return JSON.parse(t) as unknown;
	} catch {
		return undefined;
	}
}

const HEADER_LINE = /^\t"(format|version|id|createdAt|modifiedAt|meta)": (.*)$/;
const ASSET_LINE = /^\t\t("[0-9a-f]+"): (\{.*\}),?$/;
const PAGE_FIELD_LINE = /^\t\t\t"(id|width|height|paper|background|infinite)": (.*)$/;
const ITEM_LINE = /^\t\t\t\t(\{.*\}),?$/;

/** Reads the line layout of `serialize()`; lines that are damaged are skipped. */
function scanLines(text: string): Scanned {
	const out: Scanned = { header: {}, assets: {}, pages: [], orphans: { strokes: [], elements: [] } };
	let page: ScannedPage | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "\t\t{") {
			page = { raw: {}, strokes: [], elements: [] };
			out.pages.push(page);
			continue;
		}
		let m = ITEM_LINE.exec(line);
		if (m) {
			const v = jsonOrUndefined(m[1]!);
			if (!isObj(v)) continue;
			const target = page ?? out.orphans;
			if (Array.isArray(v.points)) target.strokes.push(v);
			else if (typeof v.type === "string") target.elements.push(v);
			continue;
		}
		m = PAGE_FIELD_LINE.exec(line);
		if (m && page) {
			const v = jsonOrUndefined(m[2]!);
			if (v !== undefined && !(m[1]! in page.raw)) page.raw[m[1]!] = v;
			continue;
		}
		m = ASSET_LINE.exec(line);
		if (m) {
			const key = jsonOrUndefined(m[1]!);
			const v = jsonOrUndefined(m[2]!);
			if (typeof key === "string" && isObj(v) && !(key in out.assets)) out.assets[key] = v;
			continue;
		}
		m = HEADER_LINE.exec(line);
		if (m) {
			const v = jsonOrUndefined(m[2]!);
			if (v !== undefined && !(m[1]! in out.header)) out.header[m[1]!] = v;
		}
	}
	return out;
}

function idOf(v: unknown): string | null {
	return isObj(v) && typeof v.id === "string" && v.id.length > 0 ? v.id : null;
}

/**
 * Adds the items of the line scan to the lenient reading: items are matched by id; an item that was
 * cut off in the lenient reading is replaced by its intact line.
 */
function combine(primary: unknown, scan: Scanned, incomplete: WeakSet<object>): RawObject {
	const doc: RawObject = isObj(primary) ? { ...primary } : {};
	for (const [k, v] of Object.entries(scan.header)) if (!(k in doc) || (isObj(doc[k]) && incomplete.has(doc[k]))) doc[k] = v;
	const assets: RawObject = isObj(doc.assets) ? { ...doc.assets } : {};
	for (const [k, v] of Object.entries(scan.assets)) {
		const cur = assets[k];
		if (cur === undefined || (isObj(cur) && incomplete.has(cur))) assets[k] = v;
	}
	doc.assets = assets;

	const pages: unknown[] = Array.isArray(doc.pages) ? [...(doc.pages as unknown[])] : [];
	const pageIndex = new Map<string, number>();
	pages.forEach((p, i) => {
		const id = idOf(p);
		if (id !== null && !pageIndex.has(id)) pageIndex.set(id, i);
	});
	const mergeItems = (into: unknown[], extra: unknown[]): unknown[] => {
		const out = [...into];
		const at = new Map<string, number>();
		out.forEach((s, i) => {
			const id = idOf(s);
			if (id !== null && !at.has(id)) at.set(id, i);
		});
		for (const s of extra) {
			const id = idOf(s);
			if (id === null) continue;
			const i = at.get(id);
			if (i === undefined) {
				at.set(id, out.length);
				out.push(s);
			} else {
				const cur = out[i];
				const cut = isObj(cur) && (incomplete.has(cur) || (Array.isArray(cur.points) && incomplete.has(cur.points)));
				if (cut) out[i] = s;
			}
		}
		return out;
	};
	for (const sp of scan.pages) {
		const id = idOf(sp.raw);
		const i = id !== null ? pageIndex.get(id) : undefined;
		if (i === undefined) {
			// A page the lenient reading did not reach.
			if (sp.strokes.length === 0 && sp.elements.length === 0 && id === null) continue;
			pages.push({ ...sp.raw, strokes: sp.strokes, elements: sp.elements });
			if (id !== null) pageIndex.set(id, pages.length - 1);
			continue;
		}
		const cur = pages[i];
		const base: RawObject = isObj(cur) ? { ...cur } : {};
		for (const [k, v] of Object.entries(sp.raw)) if (!(k in base)) base[k] = v;
		base.strokes = mergeItems(Array.isArray(base.strokes) ? (base.strokes as unknown[]) : [], sp.strokes);
		base.elements = mergeItems(Array.isArray(base.elements) ? (base.elements as unknown[]) : [], sp.elements);
		pages[i] = base;
	}
	if (scan.orphans.strokes.length > 0 || scan.orphans.elements.length > 0) {
		pages.push({ strokes: scan.orphans.strokes, elements: scan.orphans.elements });
	}
	doc.pages = pages;
	return doc;
}

// ------------------------------------------------------------------ migration

/** Header and pages, migrated to CURRENT_VERSION one piece at a time when the whole fails. */
function migrateTolerant(raw: RawObject, version: number, summary: RepairSummary): RawObject {
	if (version === CURRENT_VERSION) return raw;
	try {
		return migrate(raw, version, CURRENT_VERSION);
	} catch {
		// migrate piece by piece below
	}
	const tryMigrate = (r: RawObject): RawObject | null => {
		try {
			return migrate(r, version, CURRENT_VERSION);
		} catch {
			return null;
		}
	};
	if (version === 0) {
		// v0: one implicit page, strokes at the top level.
		const skeleton = tryMigrate({ ...raw, strokes: [] }) ?? tryMigrate({ strokes: [] });
		if (!skeleton) return raw;
		const page = (skeleton.pages as RawObject[])[0]!;
		const strokes: unknown[] = [];
		for (const s of Array.isArray(raw.strokes) ? (raw.strokes as unknown[]) : []) {
			const one = tryMigrate({ strokes: [s] });
			const got = one ? ((one.pages as RawObject[])[0]!.strokes as unknown[])[0] : undefined;
			if (got !== undefined) strokes.push(got);
			else summary.strokes.lost++;
		}
		return { ...skeleton, pages: [{ ...page, strokes }] };
	}
	const header = tryMigrate({ ...raw, pages: [] });
	if (!header) return { ...raw, version: CURRENT_VERSION };
	const pages: unknown[] = [];
	for (const p of Array.isArray(raw.pages) ? (raw.pages as unknown[]) : []) {
		const whole = tryMigrate({ ...raw, pages: [p] });
		if (whole) {
			pages.push((whole.pages as unknown[])[0]);
			continue;
		}
		if (!isObj(p)) {
			summary.pages.lost++;
			continue;
		}
		const skeleton = tryMigrate({ ...raw, pages: [{ ...p, strokes: [] }] });
		if (!skeleton) {
			summary.pages.lost++;
			summary.strokes.lost += Array.isArray(p.strokes) ? p.strokes.length : 0;
			continue;
		}
		const migratedPage = (skeleton.pages as RawObject[])[0]!;
		const strokes: unknown[] = [];
		for (const s of Array.isArray(p.strokes) ? (p.strokes as unknown[]) : []) {
			const one = tryMigrate({ ...raw, pages: [{ ...p, strokes: [s] }] });
			const got = one ? ((one.pages as RawObject[])[0]!.strokes as unknown[])[0] : undefined;
			if (got !== undefined) strokes.push(got);
			else summary.strokes.lost++;
		}
		pages.push({ ...migratedPage, strokes });
	}
	return { ...header, pages };
}

// ------------------------------------------------------------------ salvage

/** Validates a one-page document; null if the validator rejects it. */
function tryDoc(pages: unknown[], assets: Record<string, Asset> = {}, meta?: unknown): NotebookDocument | null {
	try {
		return validate({
			format: FORMAT_ID, version: CURRENT_VERSION, id: "repair", createdAt: "x", modifiedAt: "x",
			...(meta !== undefined ? { meta } : {}), assets, pages,
		});
	} catch {
		return null;
	}
}

function unknownKeys(raw: unknown, known: object): number {
	if (!isObj(raw)) return 0;
	let n = 0;
	for (const k of Object.keys(raw)) if (!(k in known)) n++;
	return n;
}

function positiveOr(v: unknown, fallback: number): { value: number; fixed: boolean } {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? { value: v, fixed: false } : { value: fallback, fixed: true };
}

/** Points that can be kept: finite x and y; pressure clamped to [0, 1] (0.5 when missing). */
function fixPoints(v: unknown): Array<[number, number, number]> {
	if (!Array.isArray(v)) return [];
	const out: Array<[number, number, number]> = [];
	for (const pt of v as unknown[]) {
		if (!Array.isArray(pt) || pt.length < 2) continue;
		const [x, y, p] = pt as unknown[];
		if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) continue;
		const pressure = typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5;
		out.push([x, y, pressure]);
	}
	return out;
}

function fixStroke(v: unknown): RawObject | null {
	if (!isObj(v)) return null;
	const points = fixPoints(v.points);
	if (points.length === 0) return null;
	return {
		id: typeof v.id === "string" && v.id.length > 0 ? v.id : createId(),
		tool: TOOLS.includes(v.tool as never) ? v.tool : "pen",
		color: typeof v.color === "string" && COLOR_RE.test(v.color) ? v.color : "#000000",
		width: positiveOr(v.width, 2).value,
		render: RENDER_VERSIONS.includes(v.render as never) ? v.render : RENDER_FREEHAND,
		points,
	};
}

function fixElement(v: unknown, assets: Record<string, Asset>): RawObject | null {
	if (!isObj(v) || typeof v.id !== "string" || v.id.length === 0) return null;
	const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
	if (!finite(v.x) || !finite(v.y)) return null;
	if (v.type === "text") {
		if (typeof v.text !== "string") return null;
		const size = positiveOr(v.fontSize, 16).value;
		return {
			id: v.id, type: "text", x: v.x, y: v.y, width: positiveOr(v.width, 200).value, text: v.text,
			fontSize: Math.min(size, MAX_FONT_SIZE), color: typeof v.color === "string" && COLOR_RE.test(v.color) ? v.color : "#000000",
		};
	}
	if (v.type === "image") {
		// An image whose file is not in the asset list cannot be drawn: lost (it stays in the original).
		if (typeof v.asset !== "string" || assets[v.asset]?.kind !== "image") return null;
		if (!(typeof v.width === "number" && v.width > 0 && typeof v.height === "number" && v.height > 0)) return null;
		return { id: v.id, type: "image", asset: v.asset, x: v.x, y: v.y, width: v.width, height: v.height, rotation: finite(v.rotation) ? v.rotation : 0 };
	}
	return null;
}

function strokeKey(s: Stroke): string {
	return JSON.stringify([s.tool, s.color, s.width, s.render, s.points]);
}

function elementKey(e: PageElement): string {
	const { id: _id, ...rest } = e;
	void _id;
	return JSON.stringify(rest);
}

interface SalvageContext {
	summary: RepairSummary;
	assets: Record<string, Asset>;
	/** Ids of strokes and elements kept so far (unique across the document). */
	ids: Map<string, string>;
	pageIds: Set<string>;
	/** Objects and arrays the lenient reader closed early (cut off by the damage). */
	cut: WeakSet<object>;
}

function salvageAssets(raw: unknown, summary: RepairSummary): Record<string, Asset> {
	const out: Record<string, Asset> = {};
	if (!isObj(raw)) return out;
	for (const [key, a] of Object.entries(raw)) {
		const blank = [{ id: "p", width: 1, height: 1, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes: [] }];
		const asIs = tryDoc(blank, { [key]: a } as Record<string, Asset>);
		if (asIs) {
			out[key] = asIs.assets![key]!;
			summary.assets.recovered++;
			continue;
		}
		const id = isObj(a) && typeof a.id === "string" && HEX_RE.test(a.id) ? a.id : null;
		const byId = id !== null && !(id in out) ? tryDoc(blank, { [id]: a } as Record<string, Asset>) : null;
		if (byId && id !== null) {
			out[id] = byId.assets![id]!;
			summary.assets.repaired++;
		} else {
			summary.assets.lost++;
		}
	}
	return out;
}

/** Page fields without content: what the validator accepts, with defaults for what it does not. */
function salvageSkeleton(p: RawObject, ctx: SalvageContext): { page: RawObject; fixed: boolean } {
	let fixed = false;
	let id = typeof p.id === "string" && p.id.length > 0 ? p.id : null;
	if (id === null || ctx.pageIds.has(id)) {
		id = createId();
		fixed = true;
	}
	const w = positiveOr(p.width, A4_WIDTH);
	const h = positiveOr(p.height, A4_HEIGHT);
	if (w.fixed || h.fixed) ctx.summary.fieldsReset++;
	const page: RawObject = { id, width: w.value, height: h.value, paper: p.paper, strokes: [] };
	if (!tryDoc([page])) {
		page.paper = { kind: "grid", spacing: PAPER_SPACING.grid };
		ctx.summary.fieldsReset++;
	}
	if (p.infinite !== undefined) {
		if (typeof p.infinite === "boolean") page.infinite = p.infinite;
		else ctx.summary.fieldsReset++;
	}
	if (p.background !== undefined) {
		const withBg = { ...page, background: p.background };
		if (tryDoc([withBg], ctx.assets)) page.background = p.background;
		else ctx.summary.backgroundsLost++;
	}
	if (!tryDoc([page], ctx.assets)) {
		// A rule this code does not know about: fall back to a plain page with the same id.
		for (const k of Object.keys(page)) if (!["id", "width", "height", "paper", "strokes"].includes(k)) delete page[k];
		page.width = A4_WIDTH;
		page.height = A4_HEIGHT;
		page.paper = { kind: "grid", spacing: PAPER_SPACING.grid };
		ctx.summary.fieldsReset++;
	}
	return { page, fixed: fixed || w.fixed || h.fixed };
}

/** Claims `id` for an item with content key `key`. Returns "new", "duplicate" (same id, same content) or "taken". */
function claim(ctx: SalvageContext, id: string, key: string): "new" | "duplicate" | "taken" {
	const cur = ctx.ids.get(id);
	if (cur === undefined) {
		ctx.ids.set(id, key);
		return "new";
	}
	return cur === key ? "duplicate" : "taken";
}

function salvageStrokes(raw: unknown, skeleton: RawObject, ctx: SalvageContext): Stroke[] {
	const list = Array.isArray(raw) ? (raw as unknown[]) : [];
	const s = ctx.summary;
	const out: Stroke[] = [];
	const accept = (stroke: Stroke, repaired: boolean) => {
		const key = strokeKey(stroke);
		const r = claim(ctx, stroke.id, key);
		if (r === "duplicate") {
			s.duplicates++;
			return;
		}
		if (r === "taken") {
			const copy = tryDoc([{ ...skeleton, strokes: [{ ...stroke, id: createId() }] }]);
			const fresh = copy?.pages[0]?.strokes[0];
			if (!fresh) {
				s.strokes.lost++;
				return;
			}
			ctx.ids.set(fresh.id, key);
			out.push(fresh);
			s.strokes.repaired++;
			return;
		}
		out.push(stroke);
		if (repaired) s.strokes.repaired++;
		else s.strokes.recovered++;
	};
	for (const item of list) {
		const asIs = tryDoc([{ ...skeleton, strokes: [item] }])?.pages[0]?.strokes[0];
		if (asIs) {
			s.unknownFields += unknownKeys(item, asIs);
			// A stroke cut off by the damage keeps the points before it: kept, but not "as it was".
			const cut = isObj(item) && (ctx.cut.has(item) || (Array.isArray(item.points) && ctx.cut.has(item.points)));
			accept(asIs, cut);
			continue;
		}
		const fixed = fixStroke(item);
		const repaired = fixed ? tryDoc([{ ...skeleton, strokes: [fixed] }])?.pages[0]?.strokes[0] : undefined;
		if (repaired) accept(repaired, true);
		else s.strokes.lost++;
	}
	return out;
}

function salvageElements(raw: unknown, skeleton: RawObject, ctx: SalvageContext): PageElement[] {
	const list = Array.isArray(raw) ? (raw as unknown[]) : [];
	const s = ctx.summary;
	const out: PageElement[] = [];
	for (const item of list) {
		let el = tryDoc([{ ...skeleton, elements: [item] }], ctx.assets)?.pages[0]?.elements?.[0];
		let repaired = false;
		if (el) {
			s.unknownFields += unknownKeys(item, el);
		} else {
			const fixed = fixElement(item, ctx.assets);
			el = fixed ? tryDoc([{ ...skeleton, elements: [fixed] }], ctx.assets)?.pages[0]?.elements?.[0] : undefined;
			repaired = true;
		}
		if (!el) {
			s.elements.lost++;
			continue;
		}
		const key = elementKey(el);
		const r = claim(ctx, el.id, key);
		if (r === "duplicate") {
			s.duplicates++;
			continue;
		}
		if (r === "taken") {
			const fresh = tryDoc([{ ...skeleton, elements: [{ ...el, id: createId() }] }], ctx.assets)?.pages[0]?.elements?.[0];
			if (!fresh) {
				s.elements.lost++;
				continue;
			}
			ctx.ids.set(fresh.id, key);
			el = fresh;
			repaired = true;
		}
		out.push(el);
		if (repaired) s.elements.repaired++;
		else s.elements.recovered++;
	}
	return out;
}

function salvageMeta(raw: unknown, pageIds: Set<string>, summary: RepairSummary): NotebookMeta {
	const blank = [{ id: "p", width: 1, height: 1, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes: [] }];
	if (raw === undefined) return { ...DEFAULT_META, tags: [], bookmarks: [] };
	const asIs = isObj(raw) ? tryDoc(blank, {}, { ...raw, bookmarks: [] }) : null;
	if (asIs && isObj(raw)) {
		const bookmarks = Array.isArray(raw.bookmarks) ? (raw.bookmarks as unknown[]).filter((b): b is string => typeof b === "string" && pageIds.has(b)) : [];
		return { ...asIs.meta!, bookmarks: [...new Set(bookmarks)] };
	}
	summary.fieldsReset++;
	const m = isObj(raw) ? raw : {};
	const strings = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0) : []);
	return {
		tags: [...new Set(strings(m.tags))],
		favorite: typeof m.favorite === "boolean" ? m.favorite : DEFAULT_META.favorite,
		cover: typeof m.cover === "string" && COLOR_RE.test(m.cover) ? m.cover : DEFAULT_META.cover,
		bookmarks: [...new Set(strings(m.bookmarks).filter((b) => pageIds.has(b)))],
	};
}

function salvage(raw: RawObject, summary: RepairSummary, now: Date, cut: WeakSet<object>): NotebookDocument {
	const assets = salvageAssets(raw.assets, summary);
	const ctx: SalvageContext = { summary, assets, ids: new Map(), pageIds: new Set(), cut };
	const pages: Page[] = [];
	for (const p of Array.isArray(raw.pages) ? (raw.pages as unknown[]) : []) {
		if (!isObj(p)) {
			summary.pages.lost++;
			continue;
		}
		const { page: skeleton, fixed } = salvageSkeleton(p, ctx);
		const strokes = salvageStrokes(p.strokes, skeleton, ctx);
		const elements = salvageElements(p.elements, skeleton, ctx);
		const page = tryDoc([skeleton], assets)!.pages[0]!;
		page.strokes = strokes;
		if (elements.length > 0) page.elements = elements;
		summary.unknownFields += unknownKeys(p, { ...PAGE_FIELDS, ...page });
		ctx.pageIds.add(page.id);
		pages.push(page);
		if (fixed) summary.pages.repaired++;
		else summary.pages.recovered++;
	}
	const iso = now.toISOString();
	const str = (v: unknown, fallback: () => string): string => {
		if (typeof v === "string" && v.length > 0) return v;
		summary.fieldsReset++;
		return fallback();
	};
	const id = str(raw.id, createId);
	const createdAt = str(raw.createdAt, () => iso);
	const meta = salvageMeta(raw.meta, ctx.pageIds, summary);
	summary.unknownFields += unknownKeys(raw, { format: 1, version: 1, id: 1, createdAt: 1, modifiedAt: 1, pages: 1, meta: 1, assets: 1 });
	if (pages.length === 0) {
		// A notebook has at least one page.
		pages.push({ id: createId(), width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "grid", spacing: PAPER_SPACING.grid }, strokes: [] });
	}
	return { format: FORMAT_ID, version: CURRENT_VERSION, id, createdAt, modifiedAt: iso, pages, meta, assets };
}

/**
 * Recovers what it can from the text of a notebook file. Never throws. The result's `text` is the
 * repaired document serialized and checked like a save (`serializeChecked`).
 */
export function repairNotebookText(text: string, now: Date = new Date()): RepairResult {
	const summary = emptySummary();
	if (text.trim().length === 0) return { ok: false, reason: "empty", message: "the file is empty" };
	const parsed = parse(text);
	if (parsed.ok) {
		summary.alreadyReadable = true;
		summary.sourceVersion = parsed.migratedFrom ?? CURRENT_VERSION;
		for (const p of parsed.doc.pages) {
			summary.pages.recovered++;
			summary.strokes.recovered += p.strokes.length;
			summary.elements.recovered += p.elements?.length ?? 0;
		}
		summary.assets.recovered = Object.keys(parsed.doc.assets ?? {}).length;
		const checked = serializeChecked(parsed.doc);
		if (checked.ok) return { ok: true, doc: parsed.doc, text: checked.text, summary };
	}
	if (!parsed.ok && parsed.reason === "future-version") {
		return { ok: false, reason: "future-version", message: parsed.message };
	}

	const lenient = parseLenient(text);
	summary.damaged = !lenient.complete;
	summary.damageAt = lenient.stoppedAt;
	let raw: RawObject = isObj(lenient.value) ? lenient.value : {};
	if (!lenient.complete) raw = combine(lenient.value, scanLines(text), lenient.incomplete);

	let version = detectVersion(raw);
	if (version === null && Array.isArray(raw.pages)) {
		// The header is damaged but the body has pages: read it as the current version.
		version = CURRENT_VERSION;
		summary.fieldsReset++;
	}
	if (version === null || (version >= 1 && raw.format !== undefined && raw.format !== FORMAT_ID)) {
		return { ok: false, reason: "not-notebook", message: "not a Notebook document" };
	}
	if (version > CURRENT_VERSION) {
		return {
			ok: false, reason: "future-version",
			message: `created by a newer version of Notebook (format v${version}, this version reads up to v${CURRENT_VERSION})`,
		};
	}
	summary.sourceVersion = version;
	const migrated = migrateTolerant({ ...raw, format: FORMAT_ID, version }, version, summary);
	const doc = salvage(migrated, summary, now, lenient.incomplete);
	if (recoveredItems(summary) === 0 && summary.assets.recovered + summary.assets.repaired === 0) {
		return { ok: false, reason: "nothing", message: "nothing could be recovered", summary };
	}
	const checked = serializeChecked(doc, true);
	if (!checked.ok) return { ok: false, reason: "nothing", message: `the repaired notebook did not pass validation (${checked.message})`, summary };
	const again = parse(checked.text);
	if (!again.ok) return { ok: false, reason: "nothing", message: again.message, summary };
	return { ok: true, doc: again.doc, text: checked.text, summary };
}
