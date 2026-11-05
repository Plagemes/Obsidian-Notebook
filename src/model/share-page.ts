/**
 * 0.20 (#30) Quick share of a page as PNG or PDF through the system share sheet. The pure side: what is shared, the file names, the
 * decision between the share sheet and saving a copy, the size warning, how a failed or cancelled share is read, and the per-device
 * memory of the last choice. No 'obsidian', no DOM. Nothing here touches the document or its format.
 */
import { formatPageRange } from "./page-range";

export type ShareFormat = "png" | "pdf";
export type ShareScope = "page" | "selection" | "range";

export const SHARE_FORMATS: readonly ShareFormat[] = ["png", "pdf"];
export const SHARE_SCOPES: readonly ShareScope[] = ["page", "selection", "range"];

/** What the share dialog remembers on this device. */
export interface ShareChoice {
	format: ShareFormat;
	scope: ShareScope;
	/** Share a clean copy (without the study and working layers, see clean-export.ts). */
	clean: boolean;
}

export const DEFAULT_SHARE_CHOICE: ShareChoice = { format: "png", scope: "page", clean: false };

/** Local storage key of the last choice (per device, never synced). */
export const SHARE_CHOICE_KEY = "notebook-share-choice";
/** PNG images are one file per page: more than this many pages are shared as a PDF instead. */
export const MAX_SHARE_PNG_PAGES = 10;
/** A shared file above this size gets a warning (many apps refuse or choke on very large attachments). */
export const SHARE_WARN_BYTES = 25 * 1024 * 1024;

/** Whatever was stored, as a valid choice: anything unknown falls back to the default. */
export function normaliseShareChoice(raw: unknown): ShareChoice {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_SHARE_CHOICE };
	const o = raw as Record<string, unknown>;
	return {
		format: SHARE_FORMATS.find((f) => f === o.format) ?? DEFAULT_SHARE_CHOICE.format,
		scope: SHARE_SCOPES.find((s) => s === o.scope) ?? DEFAULT_SHARE_CHOICE.scope,
		clean: o.clean === true,
	};
}

/** The part of Obsidian's App that holds per-device values. */
export interface ShareStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

/** The last choice on this device; a missing, corrupt or unreadable value gives the default. */
export function loadShareChoice(store: ShareStore): ShareChoice {
	try {
		return normaliseShareChoice(store.loadLocalStorage(SHARE_CHOICE_KEY));
	} catch {
		return { ...DEFAULT_SHARE_CHOICE };
	}
}

/** Remembers the choice on this device; a storage that throws is ignored (the dialog just starts from the default next time). */
export function saveShareChoice(store: ShareStore, choice: ShareChoice): void {
	try {
		store.saveLocalStorage(SHARE_CHOICE_KEY, normaliseShareChoice(choice));
	} catch {
		// nothing to do: the choice is a convenience
	}
}

export type ShareProblem = "no-pages" | "no-selection" | "too-many-png";

export interface ShareInput {
	choice: ShareChoice;
	pageCount: number;
	/** 0-based page in view (the page of the page menu). */
	pageIndex: number;
	/** The 0-based pages of a typed range (scope "range"). */
	range?: readonly number[];
	hasSelection: boolean;
}

export type SharePlan = { ok: true; format: ShareFormat; scope: ShareScope; pages: number[] } | { ok: false; problem: ShareProblem };

/** The scope the dialog offers: a remembered "selection" without a selection becomes "page", a "range" of a one-page notebook too. */
export function usableScope(scope: ShareScope, hasSelection: boolean, pageCount: number): ShareScope {
	if (scope === "selection") return hasSelection ? "selection" : "page";
	if (scope === "range") return pageCount > 1 ? "range" : "page";
	return "page";
}

/**
 * What is shared. A selection is always one PNG of its region; a page or a range is the format asked for, except that a PNG of more than
 * `MAX_SHARE_PNG_PAGES` pages is refused (the dialog says to use a PDF).
 */
export function planShare(input: ShareInput): SharePlan {
	const { choice, pageCount, pageIndex } = input;
	const scope = usableScope(choice.scope, input.hasSelection, pageCount);
	if (choice.scope === "selection" && !input.hasSelection) return { ok: false, problem: "no-selection" };
	if (scope === "selection") {
		if (pageIndex < 0 || pageIndex >= pageCount) return { ok: false, problem: "no-pages" };
		return { ok: true, format: "png", scope, pages: [pageIndex] };
	}
	const pages = scope === "range"
		? [...new Set((input.range ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < pageCount))].sort((a, b) => a - b)
		: pageIndex >= 0 && pageIndex < pageCount ? [pageIndex] : [];
	if (pages.length === 0) return { ok: false, problem: "no-pages" };
	if (choice.format === "png" && pages.length > MAX_SHARE_PNG_PAGES) return { ok: false, problem: "too-many-png" };
	return { ok: true, format: choice.format, scope, pages };
}

/** A notebook name safe to use in a file name: no path or reserved characters, bounded. */
export function safeShareStem(name: string): string {
	// eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not hold
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
	const stem = cleaned.slice(0, 80).trim();
	return stem === "" ? "Notebook" : stem;
}

/**
 * The names of the files handed to the share sheet: `Maths p3.png`, `Maths p2.png` + `Maths p3.png` for a PNG range,
 * `Maths p2-5.pdf` for a PDF range, `Maths p3 selection.png` for a selection.
 */
export function shareFileNames(base: string, format: ShareFormat, scope: ShareScope, pages: readonly number[]): string[] {
	const stem = safeShareStem(base);
	if (scope === "selection") return [`${stem}${shareSuffix(scope, pages)}.png`];
	if (format === "pdf") return [`${stem}${shareSuffix(scope, pages)}.pdf`];
	return pages.map((i) => `${stem} p${i + 1}.png`);
}

/** Longest spelled-out page range kept in a file name (a scattered range of a big notebook would pass the 255-byte limit). */
export const MAX_SHARE_RANGE_CHARS = 40;

/**
 * The part of a one-file name after the notebook name: ` p3`, ` p2-5+8`, ` p3 selection`. A range too long to spell out
 * (every other page of a long notebook) becomes ` p1-199 (100 pages)`.
 */
export function shareSuffix(scope: ShareScope, pages: readonly number[]): string {
	if (scope === "selection") return ` p${(pages[0] ?? 0) + 1} selection`;
	const spelled = formatPageRange(pages).replace(/, /g, "+");
	if (spelled.length <= MAX_SHARE_RANGE_CHARS || pages.length === 0) return ` p${spelled}`;
	return ` p${pages[0]! + 1}-${pages[pages.length - 1]! + 1} (${pages.length} pages)`;
}

export function shareMime(format: ShareFormat): string {
	return format === "pdf" ? "application/pdf" : "image/png";
}

/** The share sheet or a copy saved in the vault. */
export type ShareMode = "share" | "save";

/** The slice of `navigator` the decision reads. */
export interface ShareNavigator {
	canShare?: (data: { files: File[] }) => boolean;
	share?: (data: { files: File[]; title?: string }) => Promise<void>;
}

/** Whether this device can hand these files to the system share sheet. Never throws. */
export function canShareFiles(nav: ShareNavigator | undefined, files: readonly File[]): boolean {
	if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function" || files.length === 0) return false;
	try {
		return nav.canShare({ files: [...files] }) === true;
	} catch {
		return false;
	}
}

/** The share sheet when the device takes these files, otherwise a saved copy. */
export function decideShare(sheetAvailable: boolean): ShareMode {
	return sheetAvailable ? "share" : "save";
}

/** "ok", or "warn" above `SHARE_WARN_BYTES`. */
export function sizeVerdict(bytes: number): "ok" | "warn" {
	return bytes > SHARE_WARN_BYTES ? "warn" : "ok";
}

/** A size for a sentence: `3.4 MB`, `820 KB`. */
export function formatShareSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type ShareOutcome = "cancelled" | "needs-tap" | "unsupported" | "failed";

/**
 * How a rejected `navigator.share` is read. AbortError is the user closing the sheet: not an error, nothing is written.
 * NotAllowedError is a share that came too long after the tap (the browser wants a fresh one): the files are kept and offered again.
 * TypeError and NotSupportedError mean the device cannot take these files after all: a copy is saved instead.
 */
export function classifyShareError(e: unknown): ShareOutcome {
	const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
	if (name === "AbortError") return "cancelled";
	if (name === "NotAllowedError") return "needs-tap";
	if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
	return "failed";
}
