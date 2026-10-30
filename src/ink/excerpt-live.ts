/**
 * v10 anchored excerpts: the pure parts of the live pictures (NotebookMedia.excerpt draws them). What of the source page
 * a region needs (culled by bounds) and a fingerprint of it, so a picture is drawn again only when something in its
 * region changed; the scale of a picture; and a least-recently-used cache of pictures with a byte budget, so phones
 * never keep more than a few megabytes of them. No 'obsidian', no DOM.
 */
import type { ExcerptElement, Page, PageElement, Stroke } from "../model/types";
import { elementBounds } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";

/** Longest side of a live picture, px (a hard cap on top of the on-screen size). */
export const LIVE_MAX_SIDE = 2048;
/** Total pixels of live pictures kept at once, bytes (4 per pixel). */
export const LIVE_BUDGET_BYTES = 48 * 1024 * 1024;

export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Pixels per pt of the picture of `region` shown in `el` at `deviceScale` (device px per pt): steps of √2 rounded
 * down, so it never exceeds the size on screen and zooming does not draw it again on every frame; at most
 * LIVE_MAX_SIDE px a side.
 */
export function liveScale(deviceScale: number, el: Pick<ExcerptElement, "width">, region: Region): number {
	const exact = (deviceScale * el.width) / region.width;
	const stepped = Math.pow(2, Math.floor(Math.log2(Math.max(0.05, exact)) * 2) / 2);
	return Math.min(stepped, LIVE_MAX_SIDE / Math.max(region.width, region.height));
}

/** Small integers standing for objects (strokes and elements are immutable: a change is a new object). */
export class Tokens {
	private readonly ids = new WeakMap<object, number>();
	private next = 1;

	of(o: object): number {
		let id = this.ids.get(o);
		if (id === undefined) {
			id = this.next++;
			this.ids.set(o, id);
		}
		return id;
	}
}

/** Bounds of strokes, computed once per stroke (strokes are frozen). */
export class BoundsCache {
	private readonly cache = new WeakMap<Stroke, BBox>();

	of(s: Stroke): BBox {
		let b = this.cache.get(s);
		if (!b) {
			b = strokeBounds(s);
			this.cache.set(s, b);
		}
		return b;
	}
}

export interface RegionContent {
	strokes: Stroke[];
	elements: PageElement[];
	/** Changes when anything drawn in the region changes (an item added, removed, replaced or reordered). */
	fingerprint: string;
}

function meets(b: BBox, r: Region, pad: number): boolean {
	return b.maxX + pad >= r.x && b.minX - pad <= r.x + r.width && b.maxY + pad >= r.y && b.minY - pad <= r.y + r.height;
}

/**
 * The strokes and elements of `page` that can show in `region` (their bounds, padded for the ink width, meet it), in
 * page order, and a fingerprint of them. Ink and elements elsewhere on the page are left out of both, so writing outside
 * the region never draws the picture again.
 */
export function regionContent(page: Page, region: Region, tokens: Tokens, bounds: BoundsCache): RegionContent {
	const strokes: Stroke[] = [];
	const elements: PageElement[] = [];
	const parts: number[] = [];
	for (const s of page.strokes) {
		if (!meets(bounds.of(s), region, s.width + 1)) continue;
		strokes.push(s);
		parts.push(tokens.of(s));
	}
	parts.push(-1);
	for (const e of page.elements ?? []) {
		if (!meets(elementBounds(e), region, 2)) continue;
		elements.push(e);
		parts.push(tokens.of(e));
	}
	return { strokes, elements, fingerprint: parts.join(",") };
}

/**
 * Everything of the source page that changes how its region looks, apart from the scale: the region's content
 * fingerprint, the page size, paper, background and margins (they place the background), and the automatic numbers of
 * the numbered equations in the region (they depend on the whole notebook).
 */
export function liveContentKey(page: Page, content: RegionContent, numbers: ReadonlyMap<string, number>): string {
	const bg = page.background;
	const m = page.margins;
	const eq = content.elements.filter((e) => e.type === "equation" && e.numbered).map((e) => `${e.id}=${numbers.get(e.id) ?? ""}`);
	return [
		content.fingerprint, page.width, page.height, page.paper.kind, page.paper.spacing,
		bg ? `${bg.kind}:${bg.asset}:${bg.kind === "pdf" ? bg.page : 0}` : "", m ? `${m.left},${m.right},${m.bottom}` : "", eq.join(";"),
	].join("|");
}

/** A cached picture and what it was drawn from. */
export interface LiveEntry<T> {
	key: string;
	picture: T;
	bytes: number;
	/** When it was drawn (ms). */
	at: number;
	/** `liveContentKey` of what it shows (to tell, after an edit, whether it must be drawn again). */
	fingerprint: string;
	/** The excerpt's source, to find its region content again. */
	source: { page: string; region: Region };
}

/** Pictures by excerpt id, least recently used first out, within a byte budget. */
export class LiveCache<T> {
	private readonly entries = new Map<string, LiveEntry<T>>();
	private total = 0;

	constructor(readonly budget: number = LIVE_BUDGET_BYTES, private readonly release: (picture: T) => void = () => undefined) {}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.total;
	}

	/** The entry (marked as just used), or undefined. */
	get(id: string): LiveEntry<T> | undefined {
		const e = this.entries.get(id);
		if (e) {
			this.entries.delete(id);
			this.entries.set(id, e);
		}
		return e;
	}

	/** Stores an entry; the least recently used ones go until the total fits the budget (the new one always stays). */
	set(id: string, entry: LiveEntry<T>): void {
		const old = this.entries.get(id);
		if (old) {
			this.total -= old.bytes;
			this.entries.delete(id);
			if (old.picture !== entry.picture) this.release(old.picture);
		}
		this.entries.set(id, entry);
		this.total += entry.bytes;
		for (const [key, e] of this.entries) {
			if (this.total <= this.budget || key === id) break;
			this.drop(key, e);
		}
	}

	/** Keeps only the ids in `keep` (excerpts that are still in the document). */
	retain(keep: ReadonlySet<string>): void {
		for (const [key, e] of [...this.entries]) if (!keep.has(key)) this.drop(key, e);
	}

	values(): IterableIterator<[string, LiveEntry<T>]> {
		return this.entries.entries();
	}

	clear(): void {
		for (const [key, e] of [...this.entries]) this.drop(key, e);
	}

	private drop(key: string, e: LiveEntry<T>): void {
		this.entries.delete(key);
		this.total -= e.bytes;
		this.release(e.picture);
	}
}
