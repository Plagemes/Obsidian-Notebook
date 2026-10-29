/**
 * Card ids (Z1): a timestamp (`202610291442`) or Luhmann numbering (`1`, `1a`, `1a1`, `1a2`, `1b`…).
 * Pure: no 'obsidian'. Ids are compared case-insensitively, since file names are on some platforms.
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

/**
 * `YYYYMMDDHHmm` in local time (what the user sees on the clock); when that is taken, with seconds,
 * then with `-2`, `-3`… so two cards made in the same second still get different ids.
 */
export function timestampId(date: Date, taken: ReadonlySet<string>): string {
	const minute = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
	if (!has(taken, minute)) return minute;
	const second = `${minute}${pad(date.getSeconds())}`;
	if (!has(taken, second)) return second;
	for (let i = 2; ; i++) {
		const id = `${second}-${i}`;
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
export function nextCardId(scheme: ZettelIdScheme, date: Date, taken: ReadonlySet<string>, parent?: string | null): string {
	if (scheme === "timestamp") return timestampId(date, taken);
	const child = parent ? nextLuhmannChild(parent, taken) : null;
	if (child && !has(taken, child)) return child;
	return nextLuhmannTop(taken);
}

/** Characters not allowed in file names on some platform Obsidian syncs to, plus link syntax. */
const BAD_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
export const MAX_TITLE_IN_NAME = 80;

/** File name (without `.md`) of a card: `<id> <title>`, cleaned; just the id without a title. */
export function cardFileName(id: string, title: string): string {
	const clean = (s: string) => s.replace(BAD_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
	let t = clean(title);
	if (t.length > MAX_TITLE_IN_NAME) t = t.slice(0, MAX_TITLE_IN_NAME).trimEnd();
	const base = t ? `${clean(id)} ${t}` : clean(id);
	return base.replace(/^\.+/, "") || "card";
}

/** Local date `YYYY-MM-DD` (the `date` property). */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
