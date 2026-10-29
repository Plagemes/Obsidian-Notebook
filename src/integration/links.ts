/**
 * Pure parsing and building for embeds (`notebook` code blocks) and `obsidian://notebook` links.
 * No Obsidian imports: testable in Node.
 */
import { parseSubpathParams, type Region } from "../zettel/subpath";

export interface EmbedTarget {
	/** `path`: a vault path (extension optional). `link`: a wikilink target, resolved by name. */
	kind: "path" | "link";
	value: string;
}

export type EmbedParse =
	| {
		ok: true; target: EmbedTarget; page: number;
		/** Z1 card subpath (`#p3&id=<page id>&r=x,y,w,h`): present only when given. */
		pageId?: string;
		region?: Region;
	}
	| { ok: false; error: "empty" | "badPage"; detail: string };

interface ParsedTarget {
	target: EmbedTarget;
	/** Page from a `#3`, `#p3` or `#page=3` suffix. */
	page: number | null;
	badFragment: string | null;
	pageId: string | null;
	region: Region | null;
}

function unquote(s: string): string {
	const m = /^(["'])(.*)\1$/.exec(s);
	return m ? (m[2] ?? "") : s;
}

/** `page` from the text after `#`: `3`, `p3`, `p-3`, `page=3`, `page 3`. */
export function parsePageFragment(fragment: string): number | null {
	const m = /^(?:p|page)?\s*[=-]?\s*(\d{1,6})$/i.exec(fragment.trim());
	if (!m) return null;
	const n = Number(m[1]);
	return n >= 1 ? n : null;
}

function parseTarget(raw: string): ParsedTarget | null {
	let s = unquote(raw.trim());
	if (s.startsWith("!")) s = s.slice(1);
	let kind: EmbedTarget["kind"] = "path";
	const wiki = /^\[\[(.*)\]\]$/.exec(s);
	if (wiki) {
		kind = "link";
		s = (wiki[1] ?? "").split("|")[0] ?? "";
	}
	const hash = s.indexOf("#");
	let page: number | null = null;
	let badFragment: string | null = null;
	let pageId: string | null = null;
	let region: Region | null = null;
	if (hash >= 0) {
		const fragment = s.slice(hash + 1);
		s = s.slice(0, hash);
		// `p3&id=…&r=…` (Z1 cards): the page part, then the card parameters.
		const params = parseSubpathParams(fragment);
		page = parsePageFragment(params.head);
		pageId = params.pageId;
		region = params.region;
		if (params.bad !== null || (page === null && !(params.head === "" && pageId !== null))) badFragment = fragment;
	}
	s = s.trim();
	if (!s) return null;
	return { target: { kind, value: s }, page, badFragment, pageId, region };
}

/**
 * Reads the text of a `notebook` code block. Accepted forms:
 *
 *     path: Notebooks/Physics.notebook          Notebooks/Physics.notebook#3
 *     page: 3                                   [[Physics#p3]]
 *
 * An explicit `page:` line wins over a `#` suffix. The page defaults to 1.
 */
export function parseEmbedSource(source: string): EmbedParse {
	const lines = source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	let targetText: string | null = null;
	let pageText: string | null = null;
	for (const line of lines) {
		const key = /^(path|notebook|file|link)\s*:\s*(.*)$/i.exec(line);
		const pg = /^page\s*:\s*(.*)$/i.exec(line);
		if (key) targetText ??= key[2] ?? "";
		else if (pg) pageText ??= pg[1] ?? "";
		else targetText ??= line;
	}
	const parsed = targetText === null ? null : parseTarget(targetText);
	if (!parsed) return { ok: false, error: "empty", detail: "" };
	let page = parsed.page;
	if (pageText !== null) {
		const t = unquote(pageText.trim());
		if (!/^\d{1,6}$/.test(t) || Number(t) < 1) return { ok: false, error: "badPage", detail: t };
		page = Number(t);
	} else if (parsed.badFragment !== null) {
		return { ok: false, error: "badPage", detail: parsed.badFragment };
	}
	const card = { ...(parsed.pageId !== null ? { pageId: parsed.pageId } : {}), ...(parsed.region !== null ? { region: parsed.region } : {}) };
	return { ok: true, target: parsed.target, page: page ?? 1, ...card };
}

/** Text of a `notebook` code block for the given notebook and page. */
export function buildEmbedBlock(path: string, page: number): string {
	return "```notebook\npath: " + path + "\npage: " + String(Math.max(1, Math.floor(page))) + "\n```\n";
}

/** Text to insert at the cursor: the block starts on its own line. */
export function embedInsertText(path: string, page: number, atLineStart: boolean): string {
	return (atLineStart ? "" : "\n") + buildEmbedBlock(path, page);
}

/** Paths to try for a user-written path: as given, then with each notebook extension appended. */
export function candidatePaths(path: string, extensions: readonly string[]): string[] {
	const clean = path.trim().replace(/^\/+/, "");
	const out = [clean];
	for (const ext of extensions) {
		if (!clean.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) out.push(`${clean}.${ext}`);
	}
	return out;
}

/** Canvas width in device pixels for a preview that is `cssWidth` CSS pixels wide. */
export function embedPixelWidth(cssWidth: number, devicePixelRatio: number, maxPx = 2048): number {
	const css = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 600;
	const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 3) : 1;
	return Math.max(64, Math.min(maxPx, Math.round(css * dpr)));
}

// ------------------------------------------------------------------- obsidian:// links

/**
 * `obsidian://notebook?vault=<name>&path=<vault path>&page=<n>` (page omitted when not a positive integer).
 * An empty `vaultName` leaves `vault` out: Obsidian then opens the link in the current vault. Generated
 * notes use that form so their text does not depend on what the vault is called on each device.
 */
export function notebookUri(vaultName: string, path: string, page?: number): string {
	const vault = vaultName ? `vault=${encodeURIComponent(vaultName)}&` : "";
	let uri = `obsidian://notebook?${vault}path=${encodeURIComponent(path)}`;
	if (page !== undefined && Number.isInteger(page) && page >= 1) uri += `&page=${page}`;
	return uri;
}

export type ProtocolTarget =
	| { ok: true; path: string; page: number | null }
	| { ok: false };

/** Reads the parameters Obsidian passes to the `notebook` protocol handler. */
export function parseProtocolParams(params: Record<string, string | undefined>): ProtocolTarget {
	const path = (params.path ?? params.file ?? "").trim().replace(/^\/+/, "");
	if (!path) return { ok: false };
	const raw = (params.page ?? "").trim();
	const page = /^\d{1,6}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
	return { ok: true, path, page };
}

/** Page number from a view state (`{ page }`), as a 1-based integer or null. */
export function pageFromState(state: unknown): number | null {
	if (typeof state !== "object" || state === null) return null;
	const page = (state as { page?: unknown }).page;
	return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : null;
}
