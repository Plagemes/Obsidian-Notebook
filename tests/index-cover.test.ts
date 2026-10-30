import { describe, expect, it } from "vitest";
import { createDocument } from "../src/model/document";
import { isIndexCoverArt } from "../src/library/index";
import { extractCoverArt, metaFromDocument } from "../src/library/scan";
import type { NotebookDocument } from "../src/model/types";

function doc(coverArt: unknown, assets?: NotebookDocument["assets"]): NotebookDocument {
	const d = createDocument();
	d.meta = { tags: [], favorite: false, cover: "#2F80F7", bookmarks: [], coverArt: coverArt as never };
	if (assets) d.assets = assets;
	return d;
}

describe("library index: v11 cover (wave 0.12)", () => {
	it("keeps a generated cover as stored", () => {
		expect(extractCoverArt(doc({ kind: "art", style: "waves", seed: "s1" }))).toEqual({ kind: "art", style: "waves", seed: "s1" });
		expect(metaFromDocument(doc({ kind: "art", style: "cells", seed: "s2" })).coverArt).toEqual({ kind: "art", style: "cells", seed: "s2" });
	});

	it("resolves an image cover to its asset's vault path", () => {
		const assets = { abc: { id: "abc", kind: "image", path: "Notebooks/_assets/abc.png", name: "cover.png" } } as unknown as NotebookDocument["assets"];
		expect(extractCoverArt(doc({ kind: "image", asset: "abc" }, assets))).toEqual({ kind: "image", path: "Notebooks/_assets/abc.png" });
		expect(extractCoverArt(doc({ kind: "image", asset: "missing" }, assets))).toBeNull();
	});

	it("ignores no cover and odd data", () => {
		expect(extractCoverArt(doc(undefined))).toBeNull();
		expect(extractCoverArt(doc({ kind: "art", style: "spirals", seed: "s" }))).toBeNull();
		expect(extractCoverArt(doc({ kind: "art", style: "waves", seed: "" }))).toBeNull();
		expect(metaFromDocument(doc(undefined))).not.toHaveProperty("coverArt");
	});

	it("validates index entries' covers", () => {
		expect(isIndexCoverArt({ kind: "art", style: "grid", seed: "x" })).toBe(true);
		expect(isIndexCoverArt({ kind: "image", path: "a.png" })).toBe(true);
		expect(isIndexCoverArt({ kind: "image", path: "" })).toBe(false);
		expect(isIndexCoverArt({ kind: "art", style: "nope", seed: "x" })).toBe(false);
		expect(isIndexCoverArt(null)).toBe(false);
	});
});
