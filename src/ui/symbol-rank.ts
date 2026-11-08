// 0.21 symbols (#212): which symbols the quick strip shows. Pure. Use counts live in the device's local storage (the
// same pattern as ui/usage-store.ts: bounded, never synced); a use counts half as much after two weeks.
import { normaliseUsage, recordUse, type UsageEntry, type UsageMap } from "./usage";

/** Local storage key of the symbol use counts (per device). */
export const SYMBOL_USAGE_KEY = "notebook-symbol-usage";
/** Symbols remembered (the least recently used are forgotten first). */
export const MAX_SYMBOL_USAGE = 80;
/** A use counts half as much after this long. */
export const SYMBOL_HALF_LIFE_MS = 14 * 24 * 3600 * 1000;

/** Typographic symbols offered out of the box, in the order shown before anything has been used. */
export const TYPO_SYMBOLS: readonly string[] = [
	"∀", "∃", "∫", "→", "⇒", "≠", "≤", "≥", "≈", "∞", "∈", "∑", "√", "±", "π", "Δ", "∂", "θ", "λ", "°",
];

/** Id of a typographic symbol: `g-` and the hex code points. */
export function glyphId(glyph: string): string {
	return `g-${[...glyph].map((c) => c.codePointAt(0)!.toString(16)).join("-")}`.slice(0, 64);
}

/** Id of a personal symbol (a stamp): `s-` and a hash of its name, stable and safe for the usage store. */
export function personalId(name: string): string {
	let h = 0x811c9dc5;
	for (const c of name.normalize("NFC").toLowerCase()) {
		h ^= c.codePointAt(0)!;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `s-${h.toString(16).padStart(8, "0")}`;
}

/** Decayed use count: n uses, halved for every half-life since the last one. */
export function symbolScore(entry: UsageEntry | undefined, now: number): number {
	if (!entry || entry.n <= 0) return 0;
	return entry.n * Math.pow(0.5, Math.max(0, now - entry.last) / SYMBOL_HALF_LIFE_MS);
}

export interface SymbolCandidate {
	id: string;
	/** "personal": a saved symbol; "glyph": a typographic one. */
	kind: "personal" | "glyph";
	/** Name (personal) or the character (glyph). */
	label: string;
}

/**
 * The symbols to show: the ones that were used, best score first; then the saved ones never used (by name), then the
 * typographic defaults in their designed order. At most `limit`.
 */
export function rankSymbols(candidates: readonly SymbolCandidate[], usage: UsageMap, now: number, limit: number): SymbolCandidate[] {
	const scored = candidates.map((c, i) => ({ c, i, s: symbolScore(usage[c.id], now) }));
	const used = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
	const unusedPersonal = scored.filter((x) => x.s <= 0 && x.c.kind === "personal").sort((a, b) => a.c.label.localeCompare(b.c.label, undefined, { sensitivity: "base" }));
	const unusedGlyph = scored.filter((x) => x.s <= 0 && x.c.kind === "glyph");
	return [...used, ...unusedPersonal, ...unusedGlyph].slice(0, Math.max(0, limit)).map((x) => x.c);
}

/** The counts after one more use of `id` (a new object; bounded). */
export function recordSymbolUse(map: UsageMap, id: string, now: number): UsageMap {
	return normaliseUsage(recordUse(map, id, now), MAX_SYMBOL_USAGE);
}

/** Whatever was stored, as a valid bounded map. */
export function normaliseSymbolUsage(data: unknown): UsageMap {
	return normaliseUsage(data, MAX_SYMBOL_USAGE);
}

/** Smallest and largest number of buttons the strip can show. */
export const SYMBOL_COUNT_MIN = 3;
export const SYMBOL_COUNT_MAX = 12;
export const SYMBOL_COUNT_DEFAULT = 6;

export function clampSymbolCount(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? Math.min(SYMBOL_COUNT_MAX, Math.max(SYMBOL_COUNT_MIN, Math.round(n))) : SYMBOL_COUNT_DEFAULT;
}
