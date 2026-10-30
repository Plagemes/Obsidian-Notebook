/**
 * Notebook tags as Obsidian tags (O2). Pure: no 'obsidian'.
 *
 * - `normalizeTag` turns what a person types into a tag Obsidian accepts (no `#`, no spaces, nested `a/b`).
 * - `suggestTags` ranks the tags of the vault (from `metadataCache.getTags()`) for the tag editor.
 * - `computeSharedTags` is the merge rule for the `tags` property of a companion note, which is shared between the
 *   notebook and the person writing in the note: a tag the person added by hand is never removed.
 */

/** Characters Obsidian does not accept in a tag are dropped; letters, digits, marks, emoji, `_`, `-` and `/` stay. */
const INVALID_TAG_CHARS = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}‍_\-/]/gu;

/**
 * A tag the way Obsidian writes it: no leading `#`, spaces become `-`, characters Obsidian does not allow in tags are
 * dropped, nested tags are `a/b` (empty levels such as `a//b` or a trailing `/` disappear). Null when nothing is left
 * or when the tag is only digits (Obsidian does not treat `#2026` as a tag).
 */
export function normalizeTag(raw: string): string | null {
	const flat = raw.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(INVALID_TAG_CHARS, "");
	const tag = flat.split("/").filter((level) => level.length > 0).join("/");
	if (!tag || /^[\d/]+$/.test(tag)) return null;
	return tag;
}

/** Case-insensitive identity of a tag (Obsidian treats `Physics` and `physics` as the same tag). */
export function tagKey(tag: string): string {
	return tag.toLowerCase();
}

/** Tags without case-insensitive duplicates; the first spelling wins. */
export function uniqueTags(tags: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const key = tagKey(tag);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(tag);
		}
	}
	return out;
}

export interface NormalizedTags {
	tags: string[];
	/** Entries that are not tags at all (only digits, only forbidden characters), as the person wrote them. */
	rejected: string[];
}

/** Normalises a list of typed tags: duplicates (ignoring case) are merged, entries that cannot be tags are reported. */
export function normalizeTagList(raw: readonly string[]): NormalizedTags {
	const tags: string[] = [];
	const rejected: string[] = [];
	for (const entry of raw) {
		if (entry.trim().replace(/^#+/, "").trim() === "") continue;
		const tag = normalizeTag(entry);
		if (tag === null) rejected.push(entry);
		else tags.push(tag);
	}
	return { tags: uniqueTags(tags), rejected };
}

/**
 * Whether a tag already on a notebook is one Obsidian takes as it is (`normalizeTag` would not change it). The tag
 * editor shows the others as written, flagged, and never renames or drops them by itself (`2026`, `C++`).
 */
export function isObsidianTag(tag: string): boolean {
	return normalizeTag(tag) === tag;
}

/**
 * The tag list after the person adds `typed` (already normalised) to `current`, which stays exactly as it is (same
 * spellings, same order, also tags Obsidian would not accept). A typed tag that is already there (ignoring case, also
 * as the normalised form of an existing tag) is not added again.
 */
export function addTypedTags(current: readonly string[], typed: readonly string[]): string[] {
	const keys = new Set<string>();
	for (const tag of current) {
		keys.add(tagKey(tag));
		const normal = normalizeTag(tag);
		if (normal !== null) keys.add(tagKey(normal));
	}
	const out = [...current];
	for (const tag of typed) {
		if (keys.has(tagKey(tag))) continue;
		keys.add(tagKey(tag));
		out.push(tag);
	}
	return out;
}

/** Splits text typed in the tag field: commas, semicolons, new lines, and spaces before a `#` separate tags. */
export function parseTagInput(text: string): string[] {
	return text.split(/[,;\n]|\s+(?=#)/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A tag with the number of notes that use it. */
export interface TagCount {
	tag: string;
	count: number;
}

/** `metadataCache.getTags()` (`{ "#physics": 3 }`) as normalised tags, most used first (ties alphabetically). */
export function tagsFromVault(record: Readonly<Record<string, number>> | null | undefined): TagCount[] {
	const merged = new Map<string, TagCount>();
	for (const [raw, count] of Object.entries(record ?? {})) {
		const tag = normalizeTag(raw);
		if (tag === null) continue;
		const n = Number.isFinite(count) ? count : 0;
		const known = merged.get(tagKey(tag));
		if (known) known.count += n;
		else merged.set(tagKey(tag), { tag, count: n });
	}
	return [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Parents of a nested tag: `a/b/c` gives `a` and `a/b`. */
export function tagAncestors(tag: string): string[] {
	const levels = tag.split("/");
	return levels.slice(0, -1).map((_, i) => levels.slice(0, i + 1).join("/"));
}

/** Whether `tag` is `wanted` or nested below it, as Obsidian's tag search does (`#a` finds `a/b`). Case-insensitive. */
export function tagIsWithin(tag: string, wanted: string): boolean {
	const a = tagKey(tag);
	const b = tagKey(wanted);
	return a === b || a.startsWith(`${b}/`);
}

export interface SuggestOptions {
	/** Tags already chosen: never suggested again. */
	exclude?: readonly string[];
	limit?: number;
}

/**
 * Tags to suggest for what has been typed so far. Candidates come most-used first and keep that order inside each
 * rank: a tag that starts with the text, then a nested level that starts with it (`b` finds `a/b`), then any tag that
 * contains it. An empty query suggests the most used tags.
 */
export function suggestTags(query: string, candidates: readonly TagCount[], options: SuggestOptions = {}): string[] {
	const limit = options.limit ?? 8;
	const q = tagKey(query.trim().replace(/^#+/, "").replace(/\s+/g, "-"));
	const taken = new Set((options.exclude ?? []).map(tagKey));
	const ranked: Array<{ tag: string; rank: number; index: number }> = [];
	candidates.forEach(({ tag }, index) => {
		const key = tagKey(tag);
		if (taken.has(key)) return;
		const levels = key.split("/");
		let rank: number;
		if (q === "" || key.startsWith(q)) rank = 0;
		else if (levels.slice(1).some((_, i) => levels.slice(i + 1).join("/").startsWith(q))) rank = 1;
		else if (key.includes(q)) rank = 2;
		else return;
		ranked.push({ tag, rank, index });
	});
	ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
	return ranked.slice(0, limit).map((r) => r.tag);
}

export interface SharedTags {
	/** The `tags` property after the update. */
	tags: string[];
	/** The tags the plugin added (what the next update may remove again). */
	owned: string[];
}

/**
 * Merge rule for the `tags` property of a companion note.
 *
 * - `notebook`: the notebook's tags (already normalised). They are always present in the note.
 * - `current`: the tags in the note now, as written by anyone (without `#`).
 * - `previousOwned`: the tags the plugin added at its last update (null when unknown).
 *
 * Rules:
 * 1. Every notebook tag is in the result.
 * 2. A tag in the note that the plugin did not add is the person's: it stays, whatever the notebook does, including
 *    when the notebook later gets or loses a tag with the same name (the person's spelling is kept).
 * 3. A tag the plugin added earlier and the notebook no longer has is removed. Only those are ever removed.
 * 4. A tag is owned by the plugin only if it was not already in the note when the plugin first needed it
 *    (`owned` = notebook tags that were absent from the note, or were already owned).
 * 5. Notebook tags come first, then the person's own, in the order they have in the note. No duplicates (ignoring case).
 *
 * The notebook is the source of truth for the tags it has: if the person deletes one of them from the note by hand
 * it comes back at the next update (delete it in the notebook instead).
 */
export function computeSharedTags(notebook: readonly string[], current: readonly string[], previousOwned: readonly string[] | null): SharedTags {
	const nb = uniqueTags(notebook);
	const nbKeys = new Set(nb.map(tagKey));
	const before = new Set((previousOwned ?? []).map(tagKey));
	const inNote = new Map<string, string>();
	for (const tag of current) if (!inNote.has(tagKey(tag))) inNote.set(tagKey(tag), tag);

	const out: string[] = [];
	const owned: string[] = [];
	for (const tag of nb) {
		const key = tagKey(tag);
		const mine = !inNote.has(key) || before.has(key);
		if (mine) owned.push(tag);
		out.push(mine ? tag : inNote.get(key)!);
	}
	for (const [key, tag] of inNote) {
		if (nbKeys.has(key)) continue; // already placed above
		if (before.has(key)) continue; // added by the plugin earlier and the notebook dropped it
		out.push(tag);
	}
	return { tags: uniqueTags(out), owned };
}
