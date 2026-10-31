// Cover art families, including `veins` (0.13). The document format (v11) stores one of seven styles and rejects any other
// value, so older plugin versions could not open a notebook whose cover said "veins". A veins cover is therefore stored as
// the nearest legacy style plus a marked seed: older versions draw branches from the seed (graceful), this one draws veins.
// Pure logic: no Obsidian, no DOM.
import { COVER_ART_STYLES, type CoverArtStyle } from "./types";

/** The families a person can choose for a folder or a notebook cover. */
export const COVER_FAMILIES = [...COVER_ART_STYLES, "veins"] as const;
export type CoverFamily = (typeof COVER_FAMILIES)[number];

/** Marks the seed of a veins cover (stored under the `branches` style). */
export const VEINS_SEED_PREFIX = "veins~";
const LEGACY_STYLE_OF_VEINS: CoverArtStyle = "branches";

export function isCoverFamily(v: unknown): v is CoverFamily {
	return typeof v === "string" && (COVER_FAMILIES as readonly string[]).includes(v);
}

/** What goes into `meta.coverArt` for a chosen family: always one of the seven styles the format accepts. */
export function encodeCoverArt(family: CoverFamily, seed: string): { style: CoverArtStyle; seed: string } {
	const plain = seed.startsWith(VEINS_SEED_PREFIX) ? seed.slice(VEINS_SEED_PREFIX.length) : seed;
	if (family === "veins") return { style: LEGACY_STYLE_OF_VEINS, seed: `${VEINS_SEED_PREFIX}${plain}`.slice(0, 200) };
	return { style: family, seed: plain };
}

/** The family and the real seed of a stored cover (the inverse of `encodeCoverArt`; any stored cover decodes). */
export function decodeCoverArt(art: { style: CoverArtStyle; seed: string }): { family: CoverFamily; seed: string } {
	if (art.style === LEGACY_STYLE_OF_VEINS && art.seed.startsWith(VEINS_SEED_PREFIX)) return { family: "veins", seed: art.seed.slice(VEINS_SEED_PREFIX.length) };
	return { family: art.style, seed: art.seed };
}
