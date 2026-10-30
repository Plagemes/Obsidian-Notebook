/**
 * Quick textbook reference (roadmap 208), the pure part: finding "p. 134" in typed text, the textbook configuration
 * (which PDF belongs to which notebook or folder) and where a reference sits inside its text box. No 'obsidian', no DOM.
 *
 * The configuration is a vault file, `<notebooks folder>/_meta/textbooks.json`, not the plugin's `data.json`: it holds
 * settings the user chose on purpose, `data.json` is rewritten all the time by unrelated things (last page read…), and a
 * vault file is read the same on every device. It is written only by the explicit *Set textbook* / *Remove textbook*
 * actions, after reading it again (see `textbook-store.ts`). The notebook format is not touched.
 */
import { layoutText, type MeasureText } from "../ink/text-layout";

// ---------------------------------------------------------------------------------------------------- references

export interface PageRef {
	/** Offsets of the whole match in the text. */
	start: number;
	end: number;
	/** The printed page number (the first one of a range such as "pp. 134-136"). */
	page: number;
}

const WORDS = "pagina|page|pagg|pag|pp|p";
/**
 * "p. 134", "p.134", "p134", "pag. 134", "pag 134", "pagg. 12-14", "page 7", "pagina 9": the word, an optional dot, then
 * the number. A bare "p" needs the dot or no space ("p 5" is not a reference), and the word must not be the end of a longer
 * one ("step. 3", "up 4").
 */
const REF = new RegExp(
	`(?<![\\p{L}\\p{N}_])(?:(?:${WORDS})\\.\\s*|(?:pagina|page|pagg|pag|pp)\\s+|(?:${WORDS}))(\\d{1,4})(?:\\s*[-\\u2013]\\s*\\d{1,4})?(?![\\p{L}\\p{N}])`,
	"giu",
);

/** Page references in a text, in order. */
export function findPageRefs(text: string): PageRef[] {
	const out: PageRef[] = [];
	for (const m of text.matchAll(REF)) {
		const page = Number(m[1]);
		if (page >= 1 && m.index !== undefined) out.push({ start: m.index, end: m.index + m[0].length, page });
	}
	return out;
}

/** The text written by *Insert textbook reference*: "p. 134". Returns null for anything that is not a page number. */
export function referenceText(input: string): string | null {
	const refs = findPageRefs(input.trim());
	const first = refs[0];
	if (first && first.start === 0 && first.end === input.trim().length) return `p. ${first.page}`;
	const n = /^\d{1,4}$/.test(input.trim()) ? Number(input.trim()) : 0;
	return n >= 1 ? `p. ${n}` : null;
}

// ---------------------------------------------------------------------------------------------------- geometry

export interface TextRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlacedRef extends PageRef {
	/** Where the reference is drawn, in page coordinates (the line it ends on). */
	rect: TextRect;
}

/**
 * Where each page reference of a text box is drawn. The box is laid out with the same function that draws it
 * (`layoutText`); a reference is found on the line where it ends, from the width of the text before it, and when it was
 * wrapped across two lines only the part on its last line counts.
 */
export function placeRefs(
	el: { x: number; y: number; width: number; fontSize: number; text: string },
	measure: (s: string) => number,
): PlacedRef[] {
	const text = el.text.replace(/\r\n?/g, "\n");
	const refs = findPageRefs(text);
	if (refs.length === 0) return [];
	const out: PlacedRef[] = [];
	for (const ref of refs) {
		// The layout up to the end of the word the reference ends in: greedy wrapping of the words before it is unchanged.
		let wordEnd = ref.end;
		while (wordEnd < text.length && !/\s/.test(text[wordEnd]!)) wordEnd++;
		const layout = layoutText(text.slice(0, wordEnd), el.fontSize, el.width, measure);
		const line = layout.lines[layout.lines.length - 1] ?? "";
		const upto = line.slice(0, Math.max(0, line.length - (wordEnd - ref.end)));
		const length = ref.end - ref.start;
		const before = upto.length >= length ? upto.slice(0, upto.length - length) : "";
		const x0 = el.x + measure(before);
		const x1 = el.x + measure(upto);
		out.push({
			...ref,
			rect: { x: x0, y: el.y + (layout.lines.length - 1) * layout.lineHeight, width: Math.max(1, x1 - x0), height: layout.lineHeight },
		});
	}
	return out;
}

export type { MeasureText };

// ---------------------------------------------------------------------------------------------------- configuration

export const TEXTBOOKS_FORMAT = "obsidian-notebook-textbooks";
export const TEXTBOOKS_VERSION = 1;
export const TEXTBOOKS_FILE = "textbooks.json";

export type TextbookScope = "notebook" | "folder" | "all";

/** One textbook of a notebook, a folder (a course) or everything. */
export interface Textbook {
	scope: TextbookScope;
	/** `notebook`: the notebook's document id; `folder`: the vault path of the folder; `all`: unused. */
	target: string;
	/** Vault path of the PDF. */
	pdf: string;
	/** Name shown in the menu when several textbooks apply (default: the file name). */
	label?: string;
	/** Added to the printed page number to get the PDF page (front matter: a book whose "p. 1" is PDF page 12 has offset 11). */
	offset: number;
}

export interface TextbookData {
	version: number;
	books: Textbook[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type TextbookParse =
	| { ok: true; data: TextbookData }
	| { ok: false; reason: "json" | "format" | "future"; message: string };

export function emptyTextbooks(): TextbookData {
	return { version: TEXTBOOKS_VERSION, books: [], unknown: [] };
}

const MAX_OFFSET = 5000;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readBook(v: unknown): Textbook | null {
	if (!isObject(v)) return null;
	const { scope, target, pdf, label, offset } = v;
	if (scope !== "notebook" && scope !== "folder" && scope !== "all") return null;
	if (typeof pdf !== "string" || pdf === "") return null;
	const t = typeof target === "string" ? target : "";
	if (scope !== "all" && t === "") return null;
	let off = 0;
	if (offset !== undefined) {
		if (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET) return null;
		off = offset;
	}
	const book: Textbook = { scope, target: scope === "all" ? "" : t, pdf, offset: off };
	if (typeof label === "string" && label.trim() !== "") book.label = label.trim();
	return book;
}

export function parseTextbooks(text: string): TextbookParse {
	if (text.trim() === "") return { ok: true, data: emptyTextbooks() };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== TEXTBOOKS_FORMAT) return { ok: false, reason: "format", message: "not a textbooks file" };
	if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "format", message: "bad version" };
	if (raw.version > TEXTBOOKS_VERSION) return { ok: false, reason: "future", message: `version ${raw.version} is newer than this plugin understands` };
	if (!Array.isArray(raw.textbooks)) return { ok: false, reason: "format", message: "textbooks is not a list" };
	const books: Textbook[] = [];
	const unknown: unknown[] = [];
	for (const v of raw.textbooks) {
		const b = readBook(v);
		if (b) books.push(b);
		else unknown.push(v);
	}
	return { ok: true, data: { version: TEXTBOOKS_VERSION, books, unknown } };
}

function sameBook(a: Textbook, b: Pick<Textbook, "scope" | "target" | "pdf">): boolean {
	return a.scope === b.scope && a.target === b.target && a.pdf === b.pdf;
}

/** One textbook per line, in the order set, so a change touches one line. */
export function serializeTextbooks(data: TextbookData): string {
	const head = `{"format":${JSON.stringify(TEXTBOOKS_FORMAT)},"version":${TEXTBOOKS_VERSION},"textbooks":[`;
	const lines = [...data.books.map((b) => JSON.stringify(b)), ...data.unknown.map((u) => JSON.stringify(u))];
	return `${head}${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

export type TextbookOp = { type: "set"; book: Textbook } | { type: "remove"; book: Pick<Textbook, "scope" | "target" | "pdf"> };

export function applyTextbookOp(data: TextbookData, op: TextbookOp): TextbookData {
	if (op.type === "remove") return { ...data, books: data.books.filter((b) => !sameBook(b, op.book)) };
	const at = data.books.findIndex((b) => sameBook(b, op.book));
	if (at < 0) return { ...data, books: [...data.books, op.book] };
	const books = data.books.slice();
	books[at] = op.book;
	return { ...data, books };
}

/**
 * The textbooks that apply to a notebook, most specific first: those set for the notebook itself, then for its folders
 * (the nearest folder first, a course folder before the library root), then the ones for everything. A reference opens
 * the first; with several, a menu offers all of them.
 */
export function textbooksFor(data: TextbookData, notebookId: string, notebookPath: string): Textbook[] {
	const folder = notebookPath.includes("/") ? notebookPath.slice(0, notebookPath.lastIndexOf("/")) : "";
	const depth = (b: Textbook) => {
		if (b.scope === "notebook") return Infinity;
		if (b.scope === "all") return -1;
		return b.target === "" ? 0 : b.target.split("/").length;
	};
	const applies = (b: Textbook) =>
		b.scope === "all"
		|| (b.scope === "notebook" && b.target === notebookId)
		|| (b.scope === "folder" && (b.target === "" || folder === b.target || folder.startsWith(`${b.target}/`)));
	return data.books
		.map((b, i) => ({ b, i }))
		.filter(({ b }) => applies(b))
		.sort((x, y) => depth(y.b) - depth(x.b) || x.i - y.i)
		.map(({ b }) => b);
}

/** The PDF page for a printed page number (never below 1). */
export function pdfPageFor(book: Pick<Textbook, "offset">, printed: number): number {
	return Math.max(1, printed + book.offset);
}

/** Name of a textbook in a menu. */
export function textbookName(book: Pick<Textbook, "label" | "pdf">): string {
	if (book.label) return book.label;
	const name = book.pdf.slice(book.pdf.lastIndexOf("/") + 1);
	return name.replace(/\.pdf$/i, "");
}

/** `#page=N` link text of a textbook page, for Obsidian's PDF viewer. */
export function pdfLinkText(path: string, pdfPage: number): string {
	return `${path}#page=${Math.max(1, Math.floor(pdfPage))}`;
}
