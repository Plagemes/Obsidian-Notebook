/**
 * Card ids (Z1): a timestamp (`20261029144207-k3f9`) or Luhmann numbering (`1`, `1a`, `1a1`, `1a2`, `1b`…).
 * Pure: no 'obsidian'. Ids are compared case-insensitively, since file names are on some platforms.
 *
 * Two devices that sync the vault only know their own cards until the other device's notes arrive, so an id
 * that is free here may be taken there. Timestamp ids therefore carry the seconds and a short random suffix;
 * Luhmann ids keep their numbering (the sequence is the point of it), and the file name of an untitled Luhmann
 * card carries the suffix instead (`2-k3f9.md`), so two devices never create the same file.
 */

export type ZettelIdScheme = "timestamp" | "luhmann";
export const ID_SCHEMES: readonly ZettelIdScheme[] = ["timestamp", "luhmann"];

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function has(taken: ReadonlySet<string>, id: string): boolean {
	return taken.has(id.toLowerCase());
}

/** Lower-cased set of ids, for the functions below. */
export function idSet(ids: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const id of ids) out.add(id.toLowerCase());
	return out;
}

export const SUFFIX_LENGTH = 4;
const SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short random suffix (`k3f9`: 36^4, about 1.7 million values), from `crypto` when the platform has it. */
export function randomSuffix(random: () => number = defaultRandom): string {
	let s = "";
	for (let i = 0; i < SUFFIX_LENGTH; i++) s += SUFFIX_CHARS[Math.floor(random() * SUFFIX_CHARS.length) % SUFFIX_CHARS.length]!;
	return s;
}

function defaultRandom(): number {
	const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
	if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
	return Math.random();
}

/**
 * `YYYYMMDDHHmmss-<suffix>` in local time (what the user sees on the clock, to the second), with a random suffix so
 * two devices that make a card in the same second (each not knowing the other's yet) still get different ids. When the
 * id is taken here anyway, `-2`, `-3`… are appended.
 */
export function timestampId(date: Date, taken: ReadonlySet<string>, suffix: string = randomSuffix()): string {
	const second = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const base = suffix ? `${second}-${suffix}` : second;
	if (!has(taken, base)) return base;
	for (let i = 2; ; i++) {
		const id = `${base}-${i}`;
		if (!has(taken, id)) return id;
	}
}

/** `1a2b` → [1, "a", 2, "b"]; null when the id is not Luhmann-style (digits and lower-case letters alternating, starting with a number). */
export function parseLuhmann(id: string): Array<number | string> | null {
	const s = id.trim().toLowerCase();
	if (!/^\d+([a-z]+\d+)*[a-z]*$/.test(s)) return null;
	return (s.match(/\d+|[a-z]+/g) ?? []).map((part) => (/^\d/.test(part) ? Number(part) : part));
}

/** a=1 … z=26, aa=27 (bijective base 26), so branches never run out. */
export function letterIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 96);
	return n;
}

export function indexLetters(n: number): string {
	let s = "";
	let k = Math.max(1, Math.floor(n));
	while (k > 0) {
		const r = (k - 1) % 26;
		s = String.fromCharCode(97 + r) + s;
		k = Math.floor((k - 1) / 26);
	}
	return s;
}

/** Next top-level number: one more than the largest top-level card (`1`, `2`, … `10`). */
export function nextLuhmannTop(taken: ReadonlySet<string>): string {
	let max = 0;
	for (const id of taken) {
		if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
	}
	return String(max + 1);
}

/**
 * Next branch under `parent`: letters under a number (`1` → `1a`, `1b`), numbers under a letter
 * (`1a` → `1a1`, `1a2`). One more than the last existing branch, so a deleted card's id is not reused
 * while later siblings exist. Null when `parent` is not a Luhmann id.
 */
export function nextLuhmannChild(parent: string, taken: ReadonlySet<string>): string | null {
	const p = parent.trim().toLowerCase();
	if (!parseLuhmann(p)) return null;
	const underNumber = /\d$/.test(p);
	let max = 0;
	for (const id of taken) {
		if (!id.startsWith(p) || id.length === p.length) continue;
		const tail = id.slice(p.length);
		if (underNumber ? /^[a-z]+$/.test(tail) : /^\d+$/.test(tail)) max = Math.max(max, underNumber ? letterIndex(tail) : Number(tail));
	}
	return p + (underNumber ? indexLetters(max + 1) : String(max + 1));
}

/** A new id for a card in `scheme`; `parent` (Luhmann only) makes it a branch of that card. */
export function nextCardId(scheme: ZettelIdScheme, date: Date, taken: ReadonlySet<string>, parent?: string | null, suffix: string = randomSuffix()): string {
	if (scheme === "timestamp") return timestampId(date, taken, suffix);
	const child = parent ? nextLuhmannChild(parent, taken) : null;
	if (child && !has(taken, child)) return child;
	return nextLuhmannTop(taken);
}

/** Characters not allowed in file names on some platform Obsidian syncs to, plus link syntax. */
const BAD_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
export const MAX_TITLE_IN_NAME = 80;

/**
 * File name (without `.md`) of a card: `<id> <title>`, cleaned; without a title just the id, or `<id>-<suffix>` when a
 * suffix is given (untitled Luhmann cards, whose ids may be taken on another device that has not synced yet).
 */
export function cardFileName(id: string, title: string, suffix?: string | null): string {
	const clean = (s: string) => s.replace(BAD_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
	let t = clean(title);
	if (t.length > MAX_TITLE_IN_NAME) t = t.slice(0, MAX_TITLE_IN_NAME).trimEnd();
	const tag = suffix ? clean(suffix) : "";
	const base = t ? `${clean(id)} ${t}` : tag ? `${clean(id)}-${tag}` : clean(id);
	return base.replace(/^\.+/, "") || "card";
}

/** Whether a note is still named as the plugin named it for a card without a title (`<id>` or `<id>-<suffix>`). */
export function isUntitledCardName(basename: string, id: string): boolean {
	const plain = cardFileName(id, "");
	if (basename === plain) return true;
	const rest = basename.startsWith(`${plain}-`) ? basename.slice(plain.length + 1) : null;
	return rest !== null && new RegExp(`^[a-z0-9]{${SUFFIX_LENGTH}}$`).test(rest);
}

/** Whether a new card in this scheme needs a suffix in its file name (see `cardFileName`). */
export function nameSuffixFor(scheme: ZettelIdScheme, title: string): string | null {
	return scheme === "luhmann" && cardFileName("x", title) === "x" ? randomSuffix() : null;
}

/** Local date `YYYY-MM-DD` (the `date` property). */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
