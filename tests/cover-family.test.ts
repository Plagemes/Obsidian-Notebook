import { describe, expect, it } from "vitest";
import { COVER_FAMILIES, decodeCoverArt, encodeCoverArt } from "../src/model/cover-family";
import { COVER_ART_STYLES } from "../src/model/types";
import { motifFor } from "../src/ui/art/keywords";
import { validFolderValue } from "../src/library/folder-meta";

describe("cover families (veins)", () => {
	it("offers veins on top of the seven stored styles", () => {
		expect(COVER_FAMILIES).toEqual([...COVER_ART_STYLES, "veins"]);
	});
	it("stores a veins cover as a style older versions accept, and reads it back", () => {
		const stored = encodeCoverArt("veins", "abc");
		expect(COVER_ART_STYLES).toContain(stored.style);
		expect(decodeCoverArt(stored)).toEqual({ family: "veins", seed: "abc" });
		expect(decodeCoverArt(encodeCoverArt("veins", stored.seed))).toEqual({ family: "veins", seed: "abc" });
	});
	it("leaves the other families and plain branches untouched", () => {
		expect(encodeCoverArt("waves", "s")).toEqual({ style: "waves", seed: "s" });
		expect(decodeCoverArt({ style: "branches", seed: "s" })).toEqual({ family: "branches", seed: "s" });
	});
	it("folder metadata accepts veins; a biology title picks it among its motifs", () => {
		expect(validFolderValue("art", "veins")).toBe(true);
		expect(validFolderValue("art", "nope")).toBe(false);
		const picks = new Set(["Biologia", "Anatomia", "Biology 101", "Botanica", "Fisiologia"].map((t) => motifFor(t, COVER_FAMILIES)));
		expect(picks.has("veins")).toBe(true);
	});
});
