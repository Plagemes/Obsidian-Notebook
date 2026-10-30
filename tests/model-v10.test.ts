/**
 * Format v10: anchored excerpts (#105); the v9 -> v10 migration; lenient read and strict write; the history guard;
 * the paths that copy pages or elements keeping the excerpt and its snapshot asset; the pure helpers (region,
 * placement, source state, badge); geometry, merge and repair.
 */
import { describe, expect, it } from "vitest";
import { captureClip, clipAssetIds, instantiateClip } from "../src/ink/clipboard";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { scaleAbout, translate } from "../src/ink/transform";
import { pageLoad } from "../src/ink/heavy-page";
import { planPageMove } from "../src/library/page-move";
import { createDocument, createPage, referencedAssets } from "../src/model/document";
import {
	clampSourceRegion, createExcerpt, elementAssetId, excerptBadgeAt, excerptBadgeRect, excerptRegion, excerptSourceName,
	excerptSourceState, MIN_EXCERPT_SIDE, placeExcerpt, EXCERPT_PAGE_MARGIN,
} from "../src/model/excerpts";
import { AddElement, History } from "../src/model/history";
import { elementBand } from "../src/model/layers";
import { elementContentKey, mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { pageAssetIds, pageInfo } from "../src/model/page-info";
import { planPageRestore } from "../src/model/page-restore";
import { makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, FULL_CHECK_LIMIT, parse, serialize, serializeChecked, StagedParse } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { pageFromTemplate, templateDocument } from "../src/model/templates";
import { CURRENT_VERSION, FORMAT_ID, type Asset, type ExcerptElement, type NotebookDocument, type Page } from "../src/model/types";
import { pageSignature } from "../src/view/view-helpers";
import { regionFromState } from "../src/integration/links";
import { line } from "./helpers";

const stamp = "2026-10-30T10:00:00.000Z";
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function roundTrip(doc: NotebookDocument): NotebookDocument {
	return parsed(serialize(doc)).doc;
}

const snap: Asset = { id: "ab12", kind: "image", path: "Notebooks/_assets/ab12.png", name: "excerpt.png", bytes: 1234 };

const local: ExcerptElement = {
	id: "x1", type: "excerpt", x: 50, y: 60, width: 200, height: 100,
	source: { notebook: "Notebooks/Physics.notebook", doc: "doc", page: "p2", x: 10, y: 20, width: 400, height: 200 },
	asset: snap.id,
};
const remote: ExcerptElement = {
	id: "x2", type: "excerpt", x: 300, y: 400, width: 120, height: 90,
	source: { notebook: "Notebooks/Lecture 3.notebook", doc: "other-doc", page: "q7", x: 0, y: 0, width: 160, height: 120 },
};

/** Page p1 holding two excerpts (one of page p2 of this notebook with a snapshot, one of another notebook without). */
function v10Doc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.assets = { [snap.id]: snap };
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push({ ...line(60, 70, 120, 80), id: "s1" });
	p1.elements = [local, remote];
	const p2 = createPage();
	p2.id = "p2";
	doc.pages.push(p2);
	return doc;
}

function v9Doc(): Raw {
	return {
		format: FORMAT_ID, version: 9, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			elements: [{ id: "m1", type: "marker", kind: "star", x: 1, y: 2 }, { id: "e1", type: "equation", x: 1, y: 1, width: 10, height: 10, latex: "x", fontSize: 12, color: "#000000" }],
			strokes: [{ id: "s1", tool: "pen", color: "#112233", width: 2, render: 1, points: [[10, 20, 0.5]] }],
		}],
	};
}

function excerpts(page: Page): ExcerptElement[] {
	return (page.elements ?? []).filter((e): e is ExcerptElement => e.type === "excerpt");
}

/** The excerpt data of a page, ids left out (copies get new element ids). */
function content(page: Page): unknown {
	return excerpts(page).map((e) => {
		const { id: _id, ...rest } = e;
		void _id;
		return rest;
	});
}

describe("format v10", () => {
	it("is at version 10 with a v9 step", () => {
		expect(CURRENT_VERSION).toBe(10);
		expect(MIGRATIONS[9]).toBeTypeOf("function");
	});

	it("reads a v9 file unchanged apart from the version (migrated in memory)", () => {
		const raw = v9Doc();
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(9);
		expect(r.doc.version).toBe(10);
		expect(r.doc.pages[0]!.elements).toEqual(raw.pages[0].elements);
		expect(r.doc.pages[0]!.strokes).toEqual(raw.pages[0].strokes);
		expect(r.dropped).toBeUndefined();
		// Written back, it is the same content at version 10.
		const again = parsed(serialize(r.doc));
		expect(again.migratedFrom).toBeNull();
		expect(again.doc.pages).toEqual(r.doc.pages);
	});

	it("rejects a pre-v10 file with an excerpt (no version of the plugin wrote it)", () => {
		const raw = v9Doc();
		raw.pages[0].elements.push({ ...local, asset: undefined });
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toContain("exists only from v10");
		}
	});

	it("serializes an excerpt on one line, the source nested, the snapshot only when present", () => {
		const text = serialize(v10Doc());
		const lines = text.split("\n").filter((l) => l.includes('"type":"excerpt"'));
		expect(lines).toEqual([
			'\t\t\t\t{"id":"x1","type":"excerpt","x":50,"y":60,"width":200,"height":100,"source":{"notebook":"Notebooks/Physics.notebook","doc":"doc","page":"p2","x":10,"y":20,"width":400,"height":200},"asset":"ab12"},',
			'\t\t\t\t{"id":"x2","type":"excerpt","x":300,"y":400,"width":120,"height":90,"source":{"notebook":"Notebooks/Lecture 3.notebook","doc":"other-doc","page":"q7","x":0,"y":0,"width":160,"height":120}}',
		]);
		expect(serialize(parsed(text).doc)).toBe(text);
		expect(serializeChecked(v10Doc())).toEqual({ ok: true, text });
	});

	it("reads leniently: an invalid excerpt is dropped and counted, an invalid snapshot only loses the snapshot", () => {
		const raw = JSON.parse(serialize(v10Doc())) as Raw;
		raw.pages[0].elements.push(
			{ ...remote, id: "bad1", width: -1 },
			{ ...remote, id: "bad2", source: "nope" },
			{ ...remote, id: "bad3", source: { ...remote.source, page: "" } },
			{ ...remote, id: "bad4", source: { ...remote.source, height: Number.NaN } },
			{ ...remote, id: "bad5", source: { ...remote.source, notebook: "x".repeat(2000) } },
			{ ...remote, id: "snap1", asset: "missing" },
			{ ...remote, id: "snap2", asset: 7 },
		);
		const r = parsed(JSON.stringify(raw).replace("NaN", "null"));
		expect(r.dropped).toBe(7);
		const ids = r.doc.pages[0]!.elements!.map((e) => e.id);
		expect(ids).toEqual(["x1", "x2", "snap1", "snap2"]);
		expect(excerpts(r.doc.pages[0]!).find((e) => e.id === "snap1")!.asset).toBeUndefined();
		expect(serializeChecked(r.doc).ok).toBe(true);
	});

	it("a duplicate excerpt id still makes the file invalid", () => {
		const raw = JSON.parse(serialize(v10Doc())) as Raw;
		raw.pages[0].elements.push({ ...remote });
		expect(parse(JSON.stringify(raw)).ok).toBe(false);
	});

	it("never writes an invalid excerpt (strict write)", () => {
		const bad: ExcerptElement[] = [
			{ ...local, width: 0 },
			{ ...local, x: Number.POSITIVE_INFINITY },
			{ ...local, source: { ...local.source, notebook: "" } },
			{ ...local, source: { ...local.source, doc: "y".repeat(201) } },
			{ ...local, source: { ...local.source, width: -3 } },
			{ ...local, asset: "nope" },
		];
		for (const el of bad) {
			const doc = v10Doc();
			doc.pages[0]!.elements = [el];
			expect(serializeChecked(doc).ok, JSON.stringify(el).slice(0, 80)).toBe(false);
		}
	});

	it("checks excerpts on the incremental save path too", () => {
		const doc = stressDocument(6000, 4);
		doc.assets = { [snap.id]: snap };
		doc.pages[0]!.elements = [local, remote];
		const ok = serializeChecked(doc);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.text.length).toBeGreaterThan(FULL_CHECK_LIMIT);
		doc.pages[0]!.elements = [{ ...remote, asset: "gone" }];
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("the history guard accepts a valid excerpt and refuses an invalid one", () => {
		const doc = roundTrip(v10Doc());
		const refused: string[] = [];
		const history = new History(() => doc, 100, checkContent, (m) => refused.push(m));
		const good = createExcerpt(doc, "Notebooks/Physics.notebook", doc.pages[1]!, { x: 0, y: 0, width: 50, height: 40 }, { x: 10, y: 10, width: 50, height: 40 }, snap.id);
		expect(history.execute(new AddElement("p2", good, 0))).toBe(true);
		expect(doc.pages[1]!.elements).toHaveLength(1);
		const noAsset = createExcerpt(doc, "N.notebook", doc.pages[1]!, { x: 0, y: 0, width: 50, height: 40 }, { x: 10, y: 10, width: 50, height: 40 }, "not-an-asset");
		expect(history.execute(new AddElement("p2", noAsset, 1))).toBe(false);
		const flat = { ...createExcerpt(doc, "N.notebook", doc.pages[1]!, { x: 0, y: 0, width: 50, height: 40 }, { x: 10, y: 10, width: 50, height: 40 }), height: 0 };
		expect(history.execute(new AddElement("p2", flat, 1))).toBe(false);
		expect(refused).toHaveLength(2);
		expect(doc.pages[1]!.elements).toHaveLength(1);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("a file of a later version is a future version (opens read-only)", () => {
		const r = parse(serialize(v10Doc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("staged loading drops and counts exactly what the full lenient parse does", () => {
		const raw = JSON.parse(serialize(v10Doc())) as Raw;
		raw.pages[1].elements = [{ ...remote, id: "x9", asset: "missing" }, { ...remote, id: "x10", source: null }];
		const staged = StagedParse.create(raw, 0);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		const full = parsed(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dropped).toBe(2);
			expect(r.dropped).toBe(full.dropped);
			expect(serialize(r.doc)).toBe(serialize(full.doc));
		}
	});

	it("elements are frozen with their source", () => {
		const doc = roundTrip(v10Doc());
		const e = excerpts(doc.pages[0]!)[0]!;
		expect(Object.isFrozen(e)).toBe(true);
		expect(Object.isFrozen(e.source)).toBe(true);
	});
});

describe("a source that moved, was renamed or deleted degrades gracefully", () => {
	it("the excerpt is still read and written when its source page is gone", () => {
		const doc = roundTrip(v10Doc());
		doc.pages.splice(1, 1);
		const back = roundTrip(doc);
		expect(excerpts(back.pages[0]!).map((e) => e.id)).toEqual(["x1", "x2"]);
		expect(excerptSourceState(excerpts(back.pages[0]!)[0]!, back)).toEqual({ kind: "page-missing" });
	});

	it("tells this notebook (by document id, whatever its path) from another one, and finds a moved page", () => {
		const doc = roundTrip(v10Doc());
		expect(excerptSourceState(local, doc)).toEqual({ kind: "here", index: 1 });
		expect(excerptSourceState(remote, doc)).toEqual({ kind: "other" });
		const moved = roundTrip(doc);
		moved.pages.reverse();
		expect(excerptSourceState(local, moved)).toEqual({ kind: "here", index: 0 });
	});

	it("a source page made smaller keeps what is left of the region", () => {
		expect(clampSourceRegion(local.source, { width: 210, height: 1000 })).toEqual({ x: 10, y: 20, width: 200, height: 200 });
		expect(clampSourceRegion(local.source, { width: 5, height: 5 })).toBeNull();
	});

	it("names the source notebook from its stored path", () => {
		expect(excerptSourceName(remote.source)).toBe("Lecture 3");
		expect(excerptSourceName({ ...remote.source, notebook: "plain" })).toBe("plain");
	});
});

describe("the jump back", () => {
	it("reads the region to outline from a view state, and only a valid one", () => {
		expect(regionFromState({ pageId: "p", region: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
		expect(regionFromState({ region: { x: 1, y: 2, width: 0, height: 4 } })).toBeNull();
		expect(regionFromState({ region: { x: "1", y: 2, width: 3, height: 4 } })).toBeNull();
		expect(regionFromState({ region: null })).toBeNull();
		expect(regionFromState(null)).toBeNull();
	});
});

describe("making and placing excerpts", () => {
	it("pads a selection into a region inside the page; too small is null", () => {
		expect(excerptRegion({ minX: 10, minY: 10, maxX: 110, maxY: 60 }, { width: 600, height: 800 })).toEqual({ x: 6, y: 6, width: 108, height: 58 });
		expect(excerptRegion({ minX: -5, minY: 790, maxX: 50, maxY: 900 }, { width: 600, height: 800 })).toEqual({ x: 0, y: 786, width: 54, height: 14 });
		expect(excerptRegion({ minX: 10, minY: 10, maxX: 10, maxY: 10 }, { width: 600, height: 800 }, 0)).toBeNull();
		expect(excerptRegion({ minX: 0, minY: 0, maxX: MIN_EXCERPT_SIDE, maxY: MIN_EXCERPT_SIDE }, { width: 600, height: 800 }, 0)).not.toBeNull();
	});

	it("keeps the region's size when it fits, else scales it down with its aspect ratio, inside the page", () => {
		const page = { width: 600, height: 800 };
		expect(placeExcerpt({ width: 200, height: 100 }, page)).toEqual({ x: 200, y: 350, width: 200, height: 100 });
		const big = placeExcerpt({ width: 1200, height: 300 }, page);
		expect(big.width).toBeCloseTo(600 - 2 * EXCERPT_PAGE_MARGIN, 2);
		expect(big.height / big.width).toBeCloseTo(0.25, 2);
		const corner = placeExcerpt({ width: 200, height: 100 }, page, [590, 5]);
		expect(corner).toEqual({ x: 400, y: 0, width: 200, height: 100 });
	});

	it("creates an excerpt pointing at the source page by id", () => {
		const doc = v10Doc();
		const e = createExcerpt(doc, "N/a.notebook", doc.pages[1]!, { x: 1.234, y: 2, width: 3, height: 4 }, { x: 5, y: 6, width: 7, height: 8 }, "ab12");
		expect(e).toMatchObject({ type: "excerpt", x: 5, y: 6, width: 7, height: 8, asset: "ab12", source: { notebook: "N/a.notebook", doc: "doc", page: "p2", x: 1.23, y: 2, width: 3, height: 4 } });
		expect(createExcerpt(doc, "a", doc.pages[1]!, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }).asset).toBeUndefined();
	});

	it("finds the badge on the top-right corner, the topmost first", () => {
		const r = excerptBadgeRect(local);
		expect(r).toEqual({ x: 236, y: 60, width: 14, height: 14 });
		expect(excerptBadgeAt([local], 240, 65)?.id).toBe("x1");
		expect(excerptBadgeAt([local], 60, 65)).toBeNull();
		const above = { ...local, id: "x3" };
		expect(excerptBadgeAt([local, above], 240, 65)?.id).toBe("x3");
		expect(excerptBadgeRect({ ...local, width: 10, height: 10 }).width).toBe(5);
	});
});

describe("paths that copy pages and elements keep the excerpt and its snapshot", () => {
	const doc = () => roundTrip(v10Doc());

	it("the snapshot counts as an asset the page uses", () => {
		const d = doc();
		expect(elementAssetId(local)).toBe("ab12");
		expect(elementAssetId(remote)).toBeNull();
		expect(pageAssetIds(d.pages[0]!)).toEqual(["ab12"]);
		expect([...referencedAssets(d)]).toEqual(["ab12"]);
		expect(pageLoad(d.pages[0]!, d.assets).assetBytes).toBe(1234);
	});

	it("duplicatePage (new ids, same excerpts)", () => {
		const page = doc().pages[0]!;
		const copy = duplicatePage(page);
		expect(content(copy)).toEqual(content(page));
		expect(excerpts(copy).every((e, i) => e.id !== excerpts(page)[i]!.id)).toBe(true);
	});

	it("page restore, replace and insert", () => {
		const version = doc();
		const current = doc();
		current.pages[0]!.elements = [];
		for (const mode of ["replace", "insert"] as const) {
			const target = roundTrip(current);
			const plan = planPageRestore(target, version, 0, 0, mode)!;
			plan.command.apply(target);
			expect(content(target.pages[plan.pageIndex]!)).toEqual(content(version.pages[0]!));
			expect(serializeChecked(target).ok).toBe(true);
		}
	});

	it("page trash: the entry keeps the snapshot record and its restore", () => {
		const d = doc();
		const entry = makeEntry(d, d.pages[0]!, 0, Date.parse(stamp));
		const without = roundTrip(d);
		without.pages.splice(0, 1);
		without.assets = {};
		const plan = planPageTrashRestore(without, entry)!;
		plan.command.apply(without);
		expect(content(without.pages[plan.pageIndex]!)).toEqual(content(d.pages[0]!));
		expect(without.assets?.[snap.id]).toEqual(snap);
		expect(serializeChecked(without).ok).toBe(true);
	});

	it("move to notebook brings the snapshot asset record", () => {
		const source = doc();
		const target = createDocument(new Date(stamp));
		const plan = planPageMove(source, ["p1"], target);
		expect(plan.ok).toBe(true);
		if (plan.ok) {
			expect(content(plan.pages[0]!)).toEqual(content(source.pages[0]!));
			expect(plan.assets.map((a) => a.id)).toContain(snap.id);
		}
	});

	it("clipboard: copy and paste keep the source and the snapshot (renamed when stored again)", () => {
		const d = doc();
		const clip = captureClip([], d.pages[0]!.elements!, d.assets)!;
		expect(clip.assets.map((a) => a.id)).toEqual(["ab12"]);
		expect(clipAssetIds(clip)).toEqual(["ab12"]);
		const made = instantiateClip(clip, 10, 20, new Map([["ab12", "cd34"]]));
		const [a, b] = made.elements as ExcerptElement[];
		expect(a).toMatchObject({ x: 60, y: 80, width: 200, height: 100, asset: "cd34", source: local.source });
		expect(b!.asset).toBeUndefined();
		expect(b!.source).toEqual(remote.source);
	});

	it("templates keep excerpts and their snapshot", () => {
		const d = doc();
		const template = templateDocument(d, d.pages[0]!, new Date(stamp));
		expect(template.assets?.[snap.id]).toEqual(snap);
		const made = pageFromTemplate(roundTrip(template))!;
		expect(content(made.page)).toEqual(content(d.pages[0]!));
	});

	it("merge adds the copy's excerpts once; the snapshot is not content", () => {
		const main = doc();
		main.pages[0]!.elements = [];
		const other = doc();
		const plan = planMerge(main, other);
		expect(plan.summary.elementsAdded).toBe(2);
		plan.command!.apply(main);
		expect(mergeCovers(roundTrip(main), other)).toBe(true);
		expect(elementContentKey({ ...local, asset: "zz" })).toBe(elementContentKey(local));
		expect(elementContentKey({ ...local, source: { ...local.source, page: "p9" } })).not.toBe(elementContentKey(local));
	});

	it("repair keeps an excerpt, without a snapshot whose asset is gone", () => {
		const raw = JSON.parse(serialize(v10Doc())) as Raw;
		raw.pages[0].elements[0].asset = "lost";
		raw.pages[0].elements.push({ id: "x-bad", type: "excerpt", x: 1, y: 1, width: 10, height: 10 });
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const els = excerpts(r.doc.pages[0]!);
		expect(els.map((e) => e.id)).toEqual(["x1", "x2"]);
		expect(els[0]!.asset).toBeUndefined();
		expect(els[0]!.source).toEqual(local.source);
	});
});

describe("geometry, layers, page info and signatures", () => {
	it("bounds, hits and transforms (uniform scale, never rotated)", () => {
		expect(elementBounds(local)).toEqual({ minX: 50, minY: 60, maxX: 250, maxY: 160 });
		expect(hitElement([local], 100, 100, 0)?.id).toBe("x1");
		const moved = transformElement(local, translate(5, -10)) as ExcerptElement;
		expect(moved).toMatchObject({ x: 55, y: 50, width: 200, height: 100, source: local.source, asset: "ab12" });
		const scaled = transformElement(local, scaleAbout(2, 2, 50, 60)) as ExcerptElement;
		expect(scaled).toMatchObject({ x: 50, y: 60, width: 400, height: 200 });
		const rotated = transformElement(local, [0, 1, -1, 0, 0, 0]) as ExcerptElement;
		expect(rotated.width).toBe(200);
		expect(rotated.height).toBe(100);
	});

	it("stacks with images (as the renderer draws them)", () => {
		expect(elementBand(local)).toBe(elementBand({ id: "i", type: "image", asset: "a", x: 0, y: 0, width: 1, height: 1, rotation: 0 }));
	});

	it("page information counts excerpts", () => {
		const info = pageInfo(doc(), 0)!;
		expect(info.elements.excerpt).toBe(2);
		expect(info.assets.count).toBe(1);
	});

	it("the page signature changes when an excerpt moves or its source changes", () => {
		const page = doc().pages[0]!;
		const base = pageSignature(page);
		expect(pageSignature({ ...page, elements: [{ ...local, x: 51 }, remote] })).not.toBe(base);
		expect(pageSignature({ ...page, elements: [{ ...local, source: { ...local.source, y: 21 } }, remote] })).not.toBe(base);
	});
});

function doc(): NotebookDocument {
	return roundTrip(v10Doc());
}
