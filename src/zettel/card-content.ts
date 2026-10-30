/**
 * Zettel card notes (Z1, Z2, Z3, Z11): the Markdown text of a new card, how a card is read back from
 * its frontmatter, and the frontmatter-only edits the plugin makes later (orphaned flag, drawn links).
 * Pure: no 'obsidian' (YAML goes through the injected deps, as for companion notes).
 *
 * Card identity and data live only in the note: `zettel-notebook-id` + `page-id` (never the page index, so a
 * card survives page moves) and `region`. The notebook file is never written for a card.
 *
 * Cards have their own keys for the notebook (`zettel-notebook`, `zettel-notebook-id`), not the companion note's
 * `notebook` / `notebook-id`: a device on an older version (0.5.1) with companion notes on would otherwise take a
 * synced card for a companion note and write its generated region into it. Cards made before the rename (only by
 * unreleased builds) still have the companion keys; those are read only from notes that also have `zettel-id`.
 *
 * Ownership: the body is written once, when the card is created, and never touched again; afterwards
 * the plugin only sets or removes `orphaned` and appends to `links`. Every other property is the user's.
 */
import { COMPANION_ID_KEY, COMPANION_LINK_KEY, sameProperties, type CompanionTextDeps } from "../model/companion-content";
import { cardSubpath, formatRegion, parseRegion, type Region } from "./subpath";

export const CARD_ID_KEY = "zettel-id";
export const CARD_TITLE_KEY = "title";
export const CARD_ALIASES_KEY = "aliases";
export const CARD_TYPE_KEY = "type";
export const CARD_SOURCE_KEY = "source";
export const CARD_DATE_KEY = "date";
export const CARD_TAGS_KEY = "tags";
export const CARD_NOTEBOOK_KEY = "zettel-notebook";
export const CARD_NOTEBOOK_ID_KEY = "zettel-notebook-id";
/** Keys of cards made by unreleased builds (the companion note's): read as a fallback, never written. */
export const LEGACY_CARD_NOTEBOOK_KEY = COMPANION_LINK_KEY;
export const LEGACY_CARD_NOTEBOOK_ID_KEY = COMPANION_ID_KEY;
export const CARD_PAGE_ID_KEY = "page-id";
export const CARD_REGION_KEY = "region";
/** Drawn links (Z3): wikilinks to other cards, a list. */
export const CARD_LINKS_KEY = "links";
/** Set to true when the card's page is no longer in its notebook. */
export const CARD_ORPHANED_KEY = "orphaned";

export const CARD_TYPES = ["permanent", "literature", "fleeting"] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Heading of the transcription section (language-neutral, so recognition can find it later). */
export const TRANSCRIPTION_HEADING = "## Transcription";

export interface NewCard {
	id: string;
	/** Typed title (Z11); may be empty (slip-box pages get one later). */
	title: string;
	type: CardType;
	source: string;
	tags: readonly string[];
	/** `YYYY-MM-DD` */
	date: string;
	notebookPath: string;
	notebookId: string;
	pageId: string;
	/** 1-based page number when the card is made: only a fallback in the embed, the page id decides. */
	page: number;
	/** Null: the whole page is the card. */
	region: Region | null;
	/** Text for the Transcription section (Z4: the typed text or PDF quote of an Inbox item); written once, at creation. */
	transcription?: string;
}

/** A card as found in the metadata cache. */
export interface CardRecord {
	path: string;
	id: string;
	title: string;
	notebookId: string;
	/** Raw `zettel-notebook` property (a wikilink). */
	notebookLink: string;
	pageId: string;
	region: Region | null;
	orphaned: boolean;
	links: string[];
}

/** Tags as Obsidian wants them in properties: no `#`, no spaces. */
export function cleanTags(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const t of raw) {
		const tag = t.trim().replace(/^#+/, "").replace(/\s+/g, "-");
		if (tag && !/^\d+$/.test(tag) && !out.some((o) => o.toLowerCase() === tag.toLowerCase())) out.push(tag);
	}
	return out;
}

/** Tags typed in a text field: separated by commas or spaces. */
export function parseTagInput(text: string): string[] {
	return cleanTags(text.split(/[,\s]+/));
}

function notebookName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
}

/** Frontmatter of a new card, in display order. */
export function cardProperties(card: NewCard): Record<string, unknown> {
	const props: Record<string, unknown> = { [CARD_ID_KEY]: card.id };
	const title = card.title.trim();
	props[CARD_TITLE_KEY] = title;
	if (title) props[CARD_ALIASES_KEY] = [title];
	props[CARD_TYPE_KEY] = card.type;
	props[CARD_SOURCE_KEY] = card.source.trim();
	props[CARD_DATE_KEY] = card.date;
	const tags = cleanTags(card.tags);
	if (tags.length > 0) props[CARD_TAGS_KEY] = tags;
	props[CARD_NOTEBOOK_KEY] = `[[${card.notebookPath}|${notebookName(card.notebookPath)}]]`;
	props[CARD_NOTEBOOK_ID_KEY] = card.notebookId;
	props[CARD_PAGE_ID_KEY] = card.pageId;
	if (card.region) props[CARD_REGION_KEY] = formatRegion(card.region);
	return props;
}

/** The live embed of a card's ink: the notebook path, page and region in the subpath. */
export function cardEmbed(card: Pick<NewCard, "notebookPath" | "page" | "pageId" | "region">): string {
	return `![[${card.notebookPath}${cardSubpath(card.page, card.pageId, card.region)}]]`;
}

/** Whole text of a new card note: properties, the live ink, and an empty transcription section. */
export function newCardText(card: NewCard, stringify: CompanionTextDeps["stringify"]): string {
	const yaml = stringify(cardProperties(card));
	const fm = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
	const body = card.transcription?.trim();
	return `---\n${fm}---\n${cardEmbed(card)}\n\n${TRANSCRIPTION_HEADING}\n\n${body ? `${body}\n` : ""}`;
}

function str(v: unknown): string | null {
	if (typeof v === "string") return v.trim() || null;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return null;
}

/** Links as written in a list (or a single string) property. */
export function readLinks(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/**
 * A card from a note's frontmatter; null when the note is not a card (no `zettel-id`, `zettel-notebook-id` and
 * `page-id`). The companion keys `notebook-id` / `notebook` are a fallback, and only because `zettel-id` is required.
 */
export function readCard(path: string, fm: Readonly<Record<string, unknown>> | null | undefined): CardRecord | null {
	if (!fm) return null;
	const id = str(fm[CARD_ID_KEY]);
	if (!id) return null;
	const own = str(fm[CARD_NOTEBOOK_ID_KEY]);
	const notebookId = own ?? str(fm[LEGACY_CARD_NOTEBOOK_ID_KEY]);
	const pageId = str(fm[CARD_PAGE_ID_KEY]);
	if (!notebookId || !pageId) return null;
	const linkValue = own ? fm[CARD_NOTEBOOK_KEY] : fm[CARD_NOTEBOOK_KEY] ?? fm[LEGACY_CARD_NOTEBOOK_KEY];
	const regionText = str(fm[CARD_REGION_KEY]);
	return {
		path,
		id,
		title: str(fm[CARD_TITLE_KEY]) ?? "",
		notebookId,
		notebookLink: typeof linkValue === "string" ? linkValue : "",
		pageId,
		region: regionText ? parseRegion(regionText) : null,
		orphaned: fm[CARD_ORPHANED_KEY] === true,
		links: readLinks(fm[CARD_LINKS_KEY]),
	};
}

/** Whether a frontmatter object belongs to a card (companion notes must never claim one). */
export function isCardFrontmatter(fm: Readonly<Record<string, unknown>> | null | undefined): boolean {
	return !!fm && str(fm[CARD_ID_KEY]) !== null;
}

/** Link target of `[[target|alias]]` / `[[target#sub]]`, lower case, without `.md`; null for anything else. */
export function linkTarget(link: string): string | null {
	const m = /^\[\[([^\]|#^]+)/.exec(link.trim());
	return m ? m[1]!.trim().replace(/\.md$/i, "").toLowerCase() : null;
}

/** `links` after adding `add` (wikilinks); null when every one is already there (by target). */
export function addLinks(current: unknown, add: readonly string[]): string[] | null {
	const links = readLinks(current);
	const targets = new Set(links.map((l) => linkTarget(l) ?? l.toLowerCase()));
	let changed = !Array.isArray(current) && links.length > 0;
	for (const link of add) {
		const target = linkTarget(link) ?? link.toLowerCase();
		if (targets.has(target)) continue;
		targets.add(target);
		links.push(link);
		changed = true;
	}
	return changed ? links : null;
}

export type FrontmatterEdit =
	| { kind: "unchanged" }
	| { kind: "changed"; text: string }
	/** The frontmatter is not valid YAML: the note is left alone. */
	| { kind: "yaml" };

/** Top-level key of a YAML line (`key:`, `"key":`, `'key':`), or null for anything else (items, comments, continuations). */
function yamlKey(line: string): string | null {
	const m = /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_][^:#]*?))\s*:(?:\s|$)/.exec(line);
	if (!m) return null;
	return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** Whether a line continues the value of the key above it (indented, or a `- item` of a block list). */
function continues(line: string): boolean {
	return /^[ \t]+\S/.test(line) || /^-(?:\s|$)/.test(line);
}

/**
 * The frontmatter block with only the changed keys rewritten: each changed key's lines (the key and its indented or
 * `- item` continuation lines) are replaced by `stringify({ key: value })`, removed for `undefined`, or appended at the
 * end for a new key. Every other line (other properties as written, comments, quoting, blank lines) stays byte for byte.
 * The result ends with a line break unless it is empty.
 */
function editYamlLines(block: string, changes: Readonly<Record<string, unknown>>, eol: string, stringify: CompanionTextDeps["stringify"]): string {
	const body = block.replace(/\r?\n$/, "");
	const lines = body === "" ? [] : body.split(/\r?\n/);
	for (const [key, value] of Object.entries(changes)) {
		const start = lines.findIndex((l) => yamlKey(l) === key);
		let end = start + 1;
		if (start >= 0) {
			// Blank lines inside the value belong to it only when the value goes on after them.
			for (let i = end; i < lines.length; i++) {
				if (continues(lines[i]!)) end = i + 1;
				else if (lines[i]!.trim() !== "") break;
			}
		}
		const replacement = value === undefined ? [] : stringify({ [key]: value }).replace(/(\r?\n)+$/, "").split(/\r?\n/);
		if (start >= 0) lines.splice(start, end - start, ...replacement);
		else lines.push(...replacement);
	}
	return lines.length > 0 ? `${lines.join(eol)}${eol}` : "";
}

/**
 * The note with some properties set (`undefined` removes one), only when a value really changes; the body is kept byte
 * for byte. Only the lines of the changed keys are rewritten, so the rest of the frontmatter (the user's properties,
 * comments, quoting) stays as written; new keys go last. If the edited block would not read back as exactly the wanted
 * properties (unusual YAML: anchors, flow mappings over several keys…), the block is re-serialized as a whole instead,
 * as `processFrontMatter` does.
 */
export function editProperties(text: string, changes: Readonly<Record<string, unknown>>, deps: CompanionTextDeps): FrontmatterEdit {
	const info = deps.frontmatterInfo(text);
	const current = info.exists ? deps.parseFrontmatter(text.slice(info.from, info.to)) : {};
	if (current === null) return { kind: "yaml" };
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	if (sameProperties(current, next)) return { kind: "unchanged" };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	if (!info.exists) {
		const yaml = deps.stringify(next).replace(/\r?\n/g, eol).replace(/(\r?\n)+$/, "");
		return { kind: "changed", text: `---${eol}${yaml}${eol}---${eol}${text}` };
	}
	const head = text.slice(0, info.from);
	const tail = text.slice(info.to);
	// The block may end before or after the line break that precedes the closing `---`.
	const breakInTail = /^\r?\n/.test(tail);
	const edited = editYamlLines(text.slice(info.from, info.to), changes, eol, (data) => deps.stringify(data).replace(/\r?\n/g, eol));
	const reread = deps.parseFrontmatter(edited);
	if (reread !== null && sameProperties(reread, next)) {
		return { kind: "changed", text: `${head}${breakInTail ? edited.replace(/\r?\n$/, "") : edited}${tail}` };
	}
	const yaml = deps.stringify(next).replace(/\r?\n/g, eol).replace(/(\r?\n)+$/, "");
	return { kind: "changed", text: `${head}${yaml}${breakInTail ? "" : eol}${tail}` };
}

/** Z11: a new typed title, also added to `aliases` (earlier titles stay there, so old links keep working). */
export function titleChanges(current: Readonly<Record<string, unknown>>, title: string): Record<string, unknown> | null {
	const clean = title.trim();
	if (!clean) return null;
	const aliases = readLinks(current[CARD_ALIASES_KEY]);
	if (!aliases.some((a) => a.toLowerCase() === clean.toLowerCase())) aliases.push(clean);
	const changes = { [CARD_TITLE_KEY]: clean, [CARD_ALIASES_KEY]: aliases };
	return current[CARD_TITLE_KEY] === clean && JSON.stringify(current[CARD_ALIASES_KEY]) === JSON.stringify(aliases) ? null : changes;
}

/** Whether a card's page is gone from its notebook (the `orphaned` value it should have). */
export function orphanChanges(card: CardRecord, pageIds: ReadonlySet<string>): Record<string, unknown> | null {
	const gone = !pageIds.has(card.pageId);
	if (gone === card.orphaned) return null;
	return { [CARD_ORPHANED_KEY]: gone ? true : undefined };
}
