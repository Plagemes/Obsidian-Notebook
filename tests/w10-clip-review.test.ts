import { describe, expect, it } from "vitest";
import { BOUND_SEPARATOR, boundGraphId } from "../src/ink/attach";
import { BitmapCache } from "../src/ink/bitmap-cache";
import { captureClip, instantiateClip, MIN_PASTE_SCALE, pasteOffset, pasteScale } from "../src/ink/clipboard";
import { inkFollowers, planCrossPageTransform } from "../src/ink/cross-page";
import { layoutPages, PAGE_GAP } from "../src/ink/layout";
import {
	addSharedEntry, bytesMatchAssetId, MAX_SHARED_IMAGE_BYTES, parseSharedClip, planSharedAsset, serializeSharedClip, sharedAssetPath,
	type SharedClipEntry,
} from "../src/ink/shared-clip";
import { strokeBounds } from "../src/ink/hit-test";
import { translate } from "../src/ink/transform";
import { createDocument, createId, createPage } from "../src/model/document";
import { MAX_PRINT_PAGES, planPrint } from "../src/model/export-pages";
import { History } from "../src/model/history";
import { createGraph } from "../src/model/math-elements";
import { serializeChecked } from "../src/model/serialize";
import type { Asset, ImageElement, NotebookDocument } from "../src/model/types";
import { sha256Hex } from "../src/pdf/hash";
import { assetIdFromHash } from "../src/pdf/hash";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import { SharedClipStore } from "../src/storage/shared-clip-store";
import { line } from "./helpers";
import { CONFIG_DIR } from "./node-env";

function twoPages(): { doc: NotebookDocument; boxes: ReturnType<typeof layoutPages>["boxes"] } {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"), { width: 200, height: 300 });
	doc.pages.push(createPage({ width: 200, height: 300 }));
	return { doc, boxes: layoutPages(doc.pages).boxes };
}

const bound = (graphId: string, x0: number, y0: number, x1: number, y1: number) => ({ ...line(x0, y0, x1, y1), id: `${graphId}${BOUND_SEPARATOR}${createId()}` });
const DOWN = 300 + PAGE_GAP;

describe("shared paste: the picture record is not trusted (1)", () => {
	const id = "ab".repeat(12);
	const record = (over: Partial<Asset> = {}): Asset => ({ id, kind: "image", path: `Notebooks/_assets/${id}.png`, name: "p.png", bytes: 1000, ...over });

	it("reads only the content-addressed name in this vault's own assets folder, whatever path the record claims", () => {
		expect(sharedAssetPath(record(), "Notes")).toBe(`Notes/_assets/${id}.png`);
		expect(sharedAssetPath(record({ path: `Other/_assets/${id}.JPG` }), "Notes")).toBe(`Notes/_assets/${id}.jpg`);
	});

	it("refuses records that are not an image in the shape _assets/<id>.<ext>", () => {
		for (const bad of [
			record({ path: `${CONFIG_DIR}/plugins/x/data.json` }),
			record({ path: "../../secret.png" }),
			record({ path: `Notebooks/_assets/${"cd".repeat(12)}.png` }),
			record({ path: `Notebooks/${id}.png` }),
			record({ path: `Notebooks/_assets/${id}.pdf` }),
			record({ kind: "pdf" }),
			record({ id: "short", path: "Notebooks/_assets/short.png" }),
			record({ id: "Z".repeat(24), path: `Notebooks/_assets/${"Z".repeat(24)}.png` }),
		]) {
			expect(sharedAssetPath(bad, "Notebooks")).toBeNull();
			expect(planSharedAsset(bad, "Notebooks", 1000)).toEqual({ ok: false, reason: "invalid" });
		}
	});

	it("a placeholder, a partly downloaded file or a missing one is not used; an oversize one is never read", () => {
		expect(planSharedAsset(record(), "N", null)).toEqual({ ok: false, reason: "missing" });
		expect(planSharedAsset(record(), "N", 0)).toEqual({ ok: false, reason: "waiting" });
		expect(planSharedAsset(record(), "N", 400)).toEqual({ ok: false, reason: "waiting" });
		expect(planSharedAsset(record(), "N", 1000)).toEqual({ ok: true, path: `N/_assets/${id}.png` });
		expect(planSharedAsset(record(), "N", 5000)).toMatchObject({ ok: true });
		expect(planSharedAsset(record(), "N", MAX_SHARED_IMAGE_BYTES + 1)).toEqual({ ok: false, reason: "too-large" });
		expect(planSharedAsset(record({ bytes: MAX_SHARED_IMAGE_BYTES + 1 }), "N", 10)).toEqual({ ok: false, reason: "too-large" });
		// A record without a size cannot tell a partial file from a whole one by size alone: the hash decides.
		expect(planSharedAsset(record({ bytes: 0 }), "N", 3)).toMatchObject({ ok: true });
	});

	it("the bytes must hash to the id: junk read from a half-synced file is not stored under a new id", async () => {
		const good = new Uint8Array([1, 2, 3, 4, 5]).buffer;
		const goodId = assetIdFromHash(await sha256Hex(good));
		expect(await bytesMatchAssetId(good, goodId)).toBe(true);
		expect(await bytesMatchAssetId(new Uint8Array([1, 2, 3]).buffer, goodId)).toBe(false);
		expect(await bytesMatchAssetId(new ArrayBuffer(0), goodId)).toBe(false);
	});
});

describe("ink follows its object across pages (2)", () => {
	function withGraph() {
		const { doc, boxes } = twoPages();
		const graph = createGraph(20, 200, 120, 80);
		const ink = bound(graph.id, 40, 220, 100, 260);
		doc.pages[0]!.elements = [graph];
		doc.pages[0]!.strokes.push(ink);
		return { doc, boxes, graph, ink };
	}

	it("finds the ink bound to a selected graph, selected or not, and the ink written on an object only with the setting", () => {
		const { doc, graph, ink } = withGraph();
		const pic: ImageElement = { id: createId(), type: "image", asset: "a".repeat(24), x: 20, y: 20, width: 100, height: 60, rotation: 0 };
		const written = line(30, 30, 100, 60);
		doc.pages[0]!.elements!.push(pic);
		doc.pages[0]!.strokes.push(written);
		const part = { pageIndex: 0, strokes: [], elements: [graph, pic] };
		expect(inkFollowers(doc.pages[0]!, part, false).map((f) => f.stroke)).toEqual([ink]);
		expect(inkFollowers(doc.pages[0]!, part, true).map((f) => f.stroke).sort()).toEqual([ink, written].sort());
		// A bound stroke that is selected with its graph is still a follower; any other selected stroke moves on its own.
		const both = { pageIndex: 0, strokes: [ink, written], elements: [graph, pic] };
		expect(inkFollowers(doc.pages[0]!, both, true).map((f) => f.stroke)).toEqual([ink]);
		expect(inkFollowers(doc.pages[0]!, { pageIndex: 0, strokes: [], elements: [] }, true)).toEqual([]);
	});

	it("moves a graph to the next page with its bound ink, even when the ink is not selected and its own centre stays", () => {
		const { doc, boxes, graph, ink } = withGraph();
		// The graph's centre ends on page 1; the stroke alone (centre y = 240) would stay on page 0 for a move of 60 only.
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts: [{ pageIndex: 0, strokes: [], elements: [graph] }], matrix: translate(0, 140 + PAGE_GAP) })!;
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(doc.pages[0]!.elements).toEqual([]);
		expect(doc.pages[1]!.elements!.map((e) => e.id)).toEqual([graph.id]);
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		expect(doc.pages[1]!.strokes).toHaveLength(1);
		const moved = doc.pages[1]!.strokes[0]!;
		expect(boundGraphId(moved)).toBe(graph.id);
		expect(moved.id).toBe(ink.id);
		// The ink keeps its place on the graph: same offset from the graph's corner.
		const g = doc.pages[1]!.elements![0]! as typeof graph;
		expect(strokeBounds(moved).minY - g.y).toBeCloseTo(strokeBounds(ink).minY - graph.y, 1);
		// Followers are not selected, so they are not part of the new selection.
		expect(plan.parts.flatMap((p) => p.strokes)).toEqual([]);
		expect(serializeChecked(doc, true).ok).toBe(true);
		hist.undo();
		expect(doc.pages[0]!.strokes).toEqual([ink]);
		expect(doc.pages[1]!.strokes).toHaveLength(0);
		expect(doc.pages[0]!.elements).toEqual([graph]);
	});

	it("a selected bound stroke goes with its graph instead of by its own centre", () => {
		const { doc, boxes, graph, ink } = withGraph();
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts: [{ pageIndex: 0, strokes: [ink], elements: [graph] }], matrix: translate(0, 140 + PAGE_GAP) })!;
		expect(plan.parts).toHaveLength(1);
		expect(plan.parts[0]!.pageIndex).toBe(1);
		expect(plan.parts[0]!.strokes).toHaveLength(1);
		expect(plan.parts[0]!.elements).toHaveLength(1);
	});

	it("ink written on an object follows it across pages only with the setting; bound ink always does", () => {
		const { doc, boxes } = twoPages();
		const pic: ImageElement = { id: createId(), type: "image", asset: "a".repeat(24), x: 20, y: 20, width: 100, height: 60, rotation: 0 };
		const written = line(30, 30, 100, 60);
		doc.pages[0]!.elements = [pic];
		doc.pages[0]!.strokes.push(written);
		const parts = [{ pageIndex: 0, strokes: [], elements: [pic] }];
		const matrix = translate(0, DOWN);
		const off = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix })!;
		const on = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix, followInk: true })!;
		const h1 = new History(() => doc);
		h1.execute(on.command);
		expect(doc.pages[1]!.strokes).toHaveLength(1);
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		h1.undo();
		h1.execute(off.command);
		expect(doc.pages[0]!.strokes).toHaveLength(1);
		expect(doc.pages[1]!.strokes).toHaveLength(0);
	});
});

describe("a clip bigger than the page (3)", () => {
	const page = { width: 595, height: 842 };
	const b = (w: number, h: number) => ({ minX: 50, minY: 70, maxX: 50 + w, maxY: 70 + h });

	it("scales uniformly to fit, leaves a clip that fits alone, and ignores the height of an infinite page", () => {
		expect(pasteScale(b(100, 100), page)).toBe(1);
		expect(pasteScale(b(595, 842), page)).toBe(1);
		expect(pasteScale(b(1190, 100), page)).toBe(0.5);
		expect(pasteScale(b(100, 2526), page)).toBe(0.3333);
		expect(pasteScale(b(1190, 2526), page)).toBe(0.3333);
		expect(pasteScale(b(100, 5000), { ...page, infinite: true })).toBe(1);
		expect(pasteScale(b(1190, 5000), { ...page, infinite: true })).toBe(0.5);
		expect(pasteScale(b(20_000, 10), page)).toBeLessThan(MIN_PASTE_SCALE);
	});

	it("pastes inside the page: centred, scaled about the corner, strokes thinner by the same factor", () => {
		const long = line(0, 0, 1190, 600, 30, 4);
		const clip = captureClip([long], [], undefined)!;
		const k = pasteScale(clip.bounds, page);
		expect(k).toBeLessThan(1);
		const [dx, dy] = pasteOffset(clip.bounds, page, [300, 400], 0, k);
		const made = instantiateClip(clip, dx, dy, undefined, undefined, k);
		const box = strokeBounds(made.strokes[0]!);
		expect(box.minX).toBeGreaterThanOrEqual(-0.5);
		expect(box.maxX).toBeLessThanOrEqual(page.width + 0.5);
		expect(box.minY).toBeGreaterThanOrEqual(0);
		expect(box.maxY).toBeLessThanOrEqual(page.height);
		expect(made.strokes[0]!.width).toBeCloseTo(4 * k, 1);
		// Without a scale nothing changes.
		const [ux, uy] = pasteOffset(clip.bounds, page, [300, 400], 0);
		expect(instantiateClip(clip, ux, uy).strokes[0]!.points[0]![0]).toBeCloseTo(long.points[0]![0] + ux, 1);
	});
});

describe("graph ink in a pasted clip (4)", () => {
	it("binds the ink to the copy of its graph, not to the original", () => {
		const graph = createGraph(20, 20, 120, 80);
		const ink = bound(graph.id, 40, 40, 80, 60);
		const plain = line(10, 10, 20, 20);
		const clip = captureClip([ink, plain], [graph], undefined)!;
		const a = instantiateClip(clip, 5, 5);
		const copyGraph = a.elements[0]!;
		expect(copyGraph.id).not.toBe(graph.id);
		expect(boundGraphId(a.strokes[0]!)).toBe(copyGraph.id);
		expect(a.strokes[0]!.id).not.toBe(ink.id);
		expect(boundGraphId(a.strokes[1]!)).toBeNull();
		// Pasted twice: each copy owns its own ink.
		const b = instantiateClip(clip, 50, 50);
		expect(boundGraphId(b.strokes[0]!)).toBe(b.elements[0]!.id);
		expect(b.elements[0]!.id).not.toBe(copyGraph.id);
	});

	it("ink bound to a graph that is not in the clip just gets a plain new id", () => {
		const ink = bound(createId(), 40, 40, 80, 60);
		const clip = captureClip([ink], [], undefined)!;
		const made = instantiateClip(clip, 0, 0);
		expect(boundGraphId(made.strokes[0]!)).toBeNull();
	});
});

describe("picture bitmaps kept between pages (5)", () => {
	it("evicts the least recently used beyond the limits, frees them, and never frees what the page needs", () => {
		const freed: string[] = [];
		const cache = new BitmapCache<string>((v) => freed.push(v));
		for (const k of ["a", "b", "c", "d", "e"]) cache.set(k, k.toUpperCase(), 10);
		cache.get("a");
		expect(cache.trim(3, 1000, new Set(["b"]))).toBe(2);
		// b is kept although it is the oldest; c and d (the next oldest) go.
		expect(freed).toEqual(["C", "D"]);
		expect(cache.size).toBe(3);
		expect(cache.has("b") && cache.has("a") && cache.has("e")).toBe(true);
	});

	it("is also bounded by the decoded size, and everything kept may exceed the limit", () => {
		const freed: string[] = [];
		const cache = new BitmapCache<string>((v) => freed.push(v));
		cache.set("a", "A", 60);
		cache.set("b", "B", 60);
		cache.set("c", "C", 60);
		cache.trim(8, 100, new Set(["a", "b", "c"]));
		expect(freed).toEqual([]);
		cache.trim(8, 100, new Set(["c"]));
		expect(freed).toEqual(["A", "B"]);
		expect(cache.cost).toBe(60);
		cache.clear();
		expect(freed).toEqual(["A", "B", "C"]);
		expect(cache.size).toBe(0);
	});

	it("frees a value that is replaced", () => {
		const freed: string[] = [];
		const cache = new BitmapCache<string>((v) => freed.push(v));
		cache.set("a", "A1", 1);
		cache.set("a", "A2", 1);
		cache.set("a", "A2", 1);
		expect(freed).toEqual(["A1"]);
	});
});

describe("print job size (6)", () => {
	it("caps the pages and lowers the resolution of a long job", () => {
		const pages = (n: number) => Array.from({ length: n }, (_, i) => i);
		expect(planPrint(pages(5))).toEqual({ indices: pages(5), left: 0, dpi: 150 });
		expect(planPrint(pages(10)).dpi).toBe(150);
		expect(planPrint(pages(30)).dpi).toBe(113);
		expect(planPrint(pages(60)).dpi).toBe(75);
		const big = planPrint(pages(250));
		expect(big.indices).toHaveLength(MAX_PRINT_PAGES);
		expect(big.indices[99]).toBe(99);
		expect(big.left).toBe(150);
		expect(planPrint([]).indices).toEqual([]);
	});
});

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	reads: string[] = [];
	async exists(p: string) { return this.files.has(p); }
	async read(p: string) {
		this.reads.push(p);
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir() { /* folders are implicit */ }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`)); }
	async size(p: string) { const v = this.files.get(p); return v === undefined ? null : v.length; }
}

describe("shared clipboard file limits (8)", () => {
	const entry = (at: number, text = "x"): SharedClipEntry => ({ id: createId(), at, strokes: 1, images: 0, texts: 0, text });

	it("an entry a newer version wrote is dropped (oldest first) only when it alone makes the file too big, and never otherwise", () => {
		const future = [{ shape: "future", pad: "p".repeat(600) }, { shape: "future2", pad: "q".repeat(300) }];
		const roomy = addSharedEntry({ entries: [], unknown: future }, entry(1), 5_000);
		expect(roomy.ok && roomy.data.unknown).toEqual(future);
		const tight = addSharedEntry({ entries: [], unknown: future }, entry(1), 700);
		expect(tight.ok).toBe(true);
		if (tight.ok) {
			expect(tight.data.entries).toHaveLength(1);
			expect(tight.data.unknown).toEqual([future[1]]);
			expect(serializeSharedClip(tight.data).length).toBeLessThanOrEqual(700);
		}
		// Known entries go before the unknown ones.
		const old = entry(0, "o".repeat(300));
		const mixed = addSharedEntry({ entries: [old], unknown: future }, entry(1), 1_300);
		expect(mixed.ok && mixed.data.entries.map((e) => e.at)).toEqual([1]);
		expect(mixed.ok && mixed.data.unknown).toEqual(future);
		// An entry that does not fit even alone is still refused, and the input is untouched.
		const input = { entries: [], unknown: [...future] };
		expect(addSharedEntry(input, entry(1, "z".repeat(5_000)), 700).ok).toBe(false);
		expect(input.unknown).toEqual(future);
	});

	it("does not read another device's file that is far too big", async () => {
		const ad = new MemoryAdapter();
		const other = "Notebooks/_meta/clipboard-bbbbbbbb.json";
		ad.files.set(other, "x".repeat(9 * 1024 * 1024));
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		const seen = await store.listOthers();
		expect(seen.items).toEqual([]);
		expect(seen.unreadable).toHaveLength(1);
		expect(seen.unreadable[0]).toContain("too large");
		expect(ad.reads).not.toContain(other);
		// A normal file is still read.
		ad.files.set(other, serializeSharedClip({ entries: [entry(5)], unknown: [] }));
		expect((await store.listOthers()).items).toHaveLength(1);
		expect(parseSharedClip(ad.files.get(other)!).ok).toBe(true);
	});

	it("two copies at once through one store lose nothing (one write queue)", async () => {
		const ad = new MemoryAdapter();
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		const clipOf = (n: number) => captureClip([line(0, 0, 100, 10 + n)], [], undefined)!;
		await Promise.all([store.publish(clipOf(1), 1), store.publish(clipOf(2), 2)]);
		const parsed = parseSharedClip(ad.files.get(store.ownPath)!);
		expect(parsed.ok && parsed.data.entries.map((e) => e.at)).toEqual([2, 1]);
	});
});
