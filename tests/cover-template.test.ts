import { describe, expect, it } from "vitest";
import { COVER_TEMPLATES, isCoverTemplate, luminance, parseHex, readableOn, shade, wrapTitle } from "../src/model/cover-template";
import { createDocument } from "../src/model/document";
import { patchNotebookCover } from "../src/library/host-logic";
import { parse, serialize } from "../src/model/serialize";
import type { Asset } from "../src/model/types";

const mono = (s: string) => s.length * 10;

describe("cover templates", () => {
	it("knows its templates", () => {
		expect(COVER_TEMPLATES.length).toBeGreaterThanOrEqual(4);
		expect(isCoverTemplate("band")).toBe(true);
		expect(isCoverTemplate("nope")).toBe(false);
	});

	it("picks the text colour that reads", () => {
		expect(readableOn("#ffffff")).toBe("#16191f");
		expect(readableOn("#2f3a4a")).toBe("#f7f8fb");
		expect(luminance("#000000")).toBe(0);
		expect(luminance("garbage")).toBe(0);
		expect(parseHex("#3b82f6")).toEqual([59, 130, 246]);
		expect(parseHex("blue")).toBeNull();
	});

	it("shades towards black and white", () => {
		expect(shade("#808080", -1)).toBe("#000000");
		expect(shade("#808080", 1)).toBe("#ffffff");
		expect(shade("#808080", 0)).toBe("#808080");
		expect(shade("oops", 0.5)).toBe("oops");
	});

	it("wraps a title on word boundaries", () => {
		expect(wrapTitle("Organic chemistry notes", mono, 120, 3)).toEqual(["Organic", "chemistry", "notes"]);
		expect(wrapTitle("Maths", mono, 120, 3)).toEqual(["Maths"]);
		expect(wrapTitle("  ", mono, 120, 3)).toEqual([]);
	});

	it("ends the last line with an ellipsis when the title does not fit, and cuts a word that is too wide", () => {
		const lines = wrapTitle("one two three four five six seven", mono, 80, 2);
		expect(lines).toHaveLength(2);
		expect(lines[1]!.endsWith("…")).toBe(true);
		for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(80);
		const cut = wrapTitle("Supercalifragilistic", mono, 60, 4);
		expect(cut.join("")).toBe("Supercalifragilistic");
		for (const l of cut) expect(mono(l)).toBeLessThanOrEqual(60);
	});
});

describe("patchNotebookCover", () => {
	const asset: Asset = { id: "a".repeat(64), kind: "image", path: "Notebooks/_assets/aaa.jpg", name: "cover.jpg", bytes: 1234 };

	it("registers the picture and points the cover at it, keeping the rest", () => {
		const doc = createDocument(new Date("2026-01-01T00:00:00Z"));
		const json = serialize(doc);
		const r = patchNotebookCover(json, asset, { coverArt: { kind: "image", asset: asset.id } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const back = parse(r.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.doc.meta?.coverArt).toEqual({ kind: "image", asset: asset.id });
		expect(back.doc.assets?.[asset.id]).toMatchObject({ kind: "image", name: "cover.jpg" });
		expect(back.doc.id).toBe(doc.id);
		expect(back.doc.pages).toEqual(doc.pages);
	});

	it("can go back to generated art without touching assets", () => {
		const json = serialize(createDocument());
		const withImage = patchNotebookCover(json, asset, { coverArt: { kind: "image", asset: asset.id } });
		if (!withImage.ok) throw new Error("setup");
		const r = patchNotebookCover(withImage.text, null, { cover: "#d9534f", coverArt: { kind: "art", style: "waves", seed: "x" } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const back = parse(r.text);
		expect(back.ok && back.doc.meta?.coverArt).toEqual({ kind: "art", style: "waves", seed: "x" });
		expect(back.ok && back.doc.meta?.cover).toBe("#d9534f");
	});

	it("refuses an unreadable file and a cover that points at a missing picture", () => {
		expect(patchNotebookCover("{ nope", asset, {}).ok).toBe(false);
		const json = serialize(createDocument());
		expect(patchNotebookCover(json, null, { coverArt: { kind: "image", asset: "missing" } }).ok).toBe(false);
	});
});
