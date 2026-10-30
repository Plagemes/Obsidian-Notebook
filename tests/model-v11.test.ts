/**
 * Format v11: notebook description and generated or image cover (`meta.description`, `meta.coverArt`); the v10 -> v11
 * migration; lenient read and strict write; staged loading of large v10 files; metadata patching, merge and repair.
 */
import { describe, expect, it } from "vitest";
import { cloneMeta, createDocument, referencedAssets } from "../src/model/document";
import { mergeMeta as mergeCopyMeta } from "../src/model/merge";
import { MIGRATIONS, withoutV11Meta } from "../src/model/migrations";
import { repairNotebookText } from "../src/model/repair";
import { parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { COVER_ART_STYLES, CURRENT_VERSION, FORMAT_ID, META_DESCRIPTION_MAX, PAGE_SIZES, type Asset, type NotebookDocument } from "../src/model/types";
import { mergeMeta, patchNotebookMeta } from "../src/library/host-logic";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-10-30T10:00:00.000Z";
const img: Asset = { id: "aa11bb22cc33dd44ee55ff66", kind: "image", path: "Notebooks/_assets/aa11bb22cc33dd44ee55ff66.png", name: "cover.png", bytes: 99 };

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function v11Doc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.meta!.cover = "#16c2a3";
	doc.meta!.description = "Lectures of the first term";
	doc.meta!.coverArt = { kind: "art", style: "waves", seed: "abc" };
	return doc;
}

function v10Raw(meta: Raw = {}): Raw {
	return {
		format: FORMAT_ID, version: 10, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: ["a"], favorite: false, cover: "#3b82f6", bookmarks: [], ...meta },
		assets: {},
		pages: [{ id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 }, strokes: [] }],
	};
}

describe("format v11", () => {
	it("is at version 11 with a v10 step", () => {
		expect(CURRENT_VERSION).toBe(11);
		expect(MIGRATIONS[10]).toBeTypeOf("function");
	});

	it("reads a v10 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v10Raw()));
		expect(r.migratedFrom).toBe(10);
		expect(r.doc.version).toBe(11);
		expect(r.doc.meta).toEqual({ tags: ["a"], favorite: false, cover: "#3b82f6", bookmarks: [] });
		expect(r.dropped).toBeUndefined();
	});

	it("drops v11 fields found in a v10 file (never ours, never had an effect)", () => {
		const r = parsed(JSON.stringify(v10Raw({ description: "x", coverArt: { kind: "art", style: "waves", seed: "s" } })));
		expect(r.doc.meta?.description).toBeUndefined();
		expect(r.doc.meta?.coverArt).toBeUndefined();
		expect(r.dropped).toBeUndefined();
		const raw = v10Raw({ description: "x" });
		expect(withoutV11Meta(raw)).not.toBe(raw);
		expect(getAt(raw, ["meta", "description"])).toBe("x");
	});

	it("round-trips a description and an art cover, deterministically", () => {
		const text = serialize(v11Doc());
		expect(text).toContain(`"description":"Lectures of the first term","coverArt":{"kind":"art","style":"waves","seed":"abc"}`);
		const r = parsed(text);
		expect(r.migratedFrom).toBeNull();
		expect(r.doc.meta?.description).toBe("Lectures of the first term");
		expect(r.doc.meta?.coverArt).toEqual({ kind: "art", style: "waves", seed: "abc" });
		expect(serialize(r.doc)).toBe(text);
		expect(serializeChecked(r.doc)).toEqual({ ok: true, text });
	});

	it("writes nothing new for a notebook without the v11 fields", () => {
		const doc = createDocument(new Date(stamp));
		const text = serialize(doc);
		expect(text).not.toContain("description");
		expect(text).not.toContain("coverArt");
		// An empty description is no description.
		doc.meta!.description = "";
		expect(serialize(doc)).toBe(text);
	});

	it("accepts every art style and an image cover whose asset is in the notebook", () => {
		for (const style of COVER_ART_STYLES) {
			const doc = v11Doc();
			doc.meta!.coverArt = { kind: "art", style, seed: "s" };
			expect(serializeChecked(doc).ok).toBe(true);
		}
		const doc = v11Doc();
		doc.assets = { [img.id]: img };
		doc.meta!.coverArt = { kind: "image", asset: img.id };
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (out.ok) expect(parsed(out.text).doc.meta?.coverArt).toEqual({ kind: "image", asset: img.id });
		expect(referencedAssets(doc).has(img.id)).toBe(true);
	});

	it("is strict on write: an invalid cover or description is refused", () => {
		const missing = v11Doc();
		missing.meta!.coverArt = { kind: "image", asset: "nope" };
		expect(serializeChecked(missing).ok).toBe(false);
		const pdf = v11Doc();
		pdf.assets = { [img.id]: { ...img, kind: "pdf" } };
		pdf.meta!.coverArt = { kind: "image", asset: img.id };
		expect(serializeChecked(pdf).ok).toBe(false);
		const long = v11Doc();
		long.meta!.description = "x".repeat(META_DESCRIPTION_MAX + 1);
		expect(serializeChecked(long).ok).toBe(false);
		const style = v11Doc();
		(style.meta!.coverArt as { style: string }).style = "stars";
		expect(serializeChecked(style).ok).toBe(false);
	});

	it("is lenient on read: an invalid cover or description is dropped and counted, the rest stays", () => {
		const raw = JSON.parse(serialize(v11Doc())) as Raw;
		setAt(raw, ["meta", "coverArt"], { kind: "image", asset: "missing" });
		setAt(raw, ["meta", "description"], 42);
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(2);
		expect(r.doc.meta?.coverArt).toBeUndefined();
		expect(r.doc.meta?.description).toBeUndefined();
		expect(r.doc.meta?.cover).toBe("#16c2a3");
	});

	it("stages a large v10 file and drops the v11 fields there too", () => {
		const doc = stressDocument(6000, 3, 7);
		const v10 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 10`)
			.replace(`"bookmarks":[]`, `"bookmarks":[],"description":"never ours"`);
		expect(v10.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v10, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(10);
			expect(r.doc.version).toBe(11);
			expect(r.doc.meta?.description).toBeUndefined();
		}
	});

	it("copies the fields in cloneMeta (not shared) and patches them in the library", () => {
		const meta = v11Doc().meta!;
		const copy = cloneMeta(meta);
		expect(copy).toEqual(meta);
		expect(copy.coverArt).not.toBe(meta.coverArt);
		const cleared = mergeMeta(meta, { description: undefined, coverArt: undefined });
		expect(cleared.description).toBeUndefined();
		expect(cleared.coverArt).toBeUndefined();
		const set = mergeMeta(cleared, { description: "New", coverArt: { kind: "art", style: "cells", seed: "z" } });
		expect(set.description).toBe("New");
		const patched = patchNotebookMeta(serialize(createDocument(new Date(stamp))), { description: "D" });
		expect(patched.ok && parsed(patched.text).doc.meta?.description).toBe("D");
	});

	it("merges a conflicted copy: the main notebook's fields win, an image cover of the copy is not taken", () => {
		const main = cloneMeta(createDocument().meta!);
		const other = cloneMeta(v11Doc().meta!);
		const m = mergeCopyMeta(main, other, new Set());
		expect(m.description).toBe(other.description);
		expect(m.coverArt).toEqual(other.coverArt);
		const m2 = mergeCopyMeta(main, { ...other, coverArt: { kind: "image", asset: img.id } }, new Set());
		expect(m2.coverArt).toBeUndefined();
	});

	it("repair keeps a valid description and cover", () => {
		const doc = v11Doc();
		const text = serialize(doc).replace(`"strokes": []`, `"strokes": [{"id":"bad"}]`);
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const back = parsed(r.text).doc;
			expect(back.meta?.description).toBe(doc.meta!.description);
			expect(back.meta?.coverArt).toEqual(doc.meta!.coverArt);
		}
	});

	it("repair keeps the description when the image cover's asset was lost, and drops only that cover (counted)", () => {
		const doc = v11Doc();
		doc.meta!.coverArt = { kind: "image", asset: img.id };
		doc.assets = { [img.id]: img };
		const raw = JSON.parse(serialize(doc)) as Raw;
		setAt(raw, ["assets"], {});
		setAt(raw, ["pages", 0, "strokes"], [{ id: "bad" }]);
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.summary.fieldsReset).toBe(1);
			const back = parsed(r.text).doc;
			expect(back.meta?.description).toBe(doc.meta!.description);
			expect(back.meta?.cover).toBe("#16c2a3");
			expect(back.meta?.coverArt).toBeUndefined();
		}
	});

	it("repair keeps a valid art cover and drops only an invalid description", () => {
		const raw = JSON.parse(serialize(v11Doc())) as Raw;
		setAt(raw, ["meta", "description"], 42);
		setAt(raw, ["pages", 0, "strokes"], [{ id: "bad" }]);
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.summary.fieldsReset).toBe(1);
			const back = parsed(r.text).doc;
			expect(back.meta?.description).toBeUndefined();
			expect(back.meta?.coverArt).toEqual({ kind: "art", style: "waves", seed: "abc" });
		}
	});

	it("repair keeps an image cover whose asset survived, and the v11 fields when another meta field is damaged", () => {
		const doc = v11Doc();
		doc.meta!.coverArt = { kind: "image", asset: img.id };
		doc.assets = { [img.id]: img };
		const raw = JSON.parse(serialize(doc)) as Raw;
		setAt(raw, ["meta", "favorite"], "yes");
		setAt(raw, ["pages", 0, "strokes"], [{ id: "bad" }]);
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (r.ok) {
			const back = parsed(r.text).doc;
			expect(back.meta?.description).toBe(doc.meta!.description);
			expect(back.meta?.coverArt).toEqual({ kind: "image", asset: img.id });
			expect(back.assets?.[img.id]).toBeDefined();
		}
	});

	it("has the B5 page size preset (176 × 250 mm)", () => {
		expect(PAGE_SIZES.b5.width / 2.8346).toBeCloseTo(176, 0);
		expect(PAGE_SIZES.b5.height / 2.8346).toBeCloseTo(250, 0);
	});
});
