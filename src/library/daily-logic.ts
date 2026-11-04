/**
 * Pure logic of "Today's page" (0.15, roadmap O12; no DOM, no 'obsidian'): where the daily notebook lives, which of its
 * pages is today's (found by the dated header, never by position), and how the link in the daily note is added without
 * ever touching the rest of the note.
 */
import { FILE_EXTENSION, type Page } from "../model/types";
import { isoDate } from "../view/lecture-logic";
import { looseSheetPath } from "./loose-sheet-logic";

export const DAILY_NAME = "Daily";

/** Default location: `<notebooks folder>/Daily.notebook`. */
export function defaultDailyPath(folder: string): string {
	const dir = folder.replace(/[\\]/g, "/").replace(/^\/+|\/+$/g, "");
	return `${dir ? `${dir}/` : ""}${DAILY_NAME}.${FILE_EXTENSION}`;
}

/** Vault path of the daily notebook: the one in the settings (made safe like the quick-notes path) or the default. */
export function dailyNotebookPath(folder: string, custom: string): string {
	return looseSheetPath(folder, custom, defaultDailyPath(folder));
}

/** Text of the date header of a page: the ISO date alone, or `<title> — <date>` as the lecture header writes it. */
export function dailyHeaderText(date: Date): string {
	return isoDate(date);
}

/** Does `text` (the first line of a text box) say it is the header of `iso`? */
function isHeaderOf(text: string, iso: string): boolean {
	const first = (text.split(/\r?\n/)[0] ?? "").trim();
	return first === iso || first.endsWith(` — ${iso}`);
}

/**
 * The 0-based index of the page whose header is `date`, or -1. Only a text box whose first line is the date (or ends with
 * ` — date`) counts, so a page that merely mentions the date in its text is not taken for today's. The first match wins.
 */
export function findDatedPage(pages: ReadonlyArray<Pick<Page, "elements">>, date: Date): number {
	const iso = isoDate(date);
	return pages.findIndex((p) => (p.elements ?? []).some((e) => e.type === "text" && isHeaderOf(e.text, iso)));
}

// ------------------------------------------------------------------------ the daily note

/** Folder and file-name format of the daily notes, as the Daily notes core plugin or Periodic Notes keep them. */
export interface DailyNoteConfig {
	folder: string;
	format: string;
}

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

/**
 * Reads the options object of Daily notes (`{ folder, format }`) leniently: anything that is not a string is ignored, an
 * empty format means the default one, the folder loses its surrounding slashes. Null when `raw` is not an object.
 */
export function parseDailyConfig(raw: unknown): DailyNoteConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const folder = typeof o.folder === "string" ? o.folder.replace(/[\\]/g, "/").replace(/^\/+|\/+$/g, "").trim() : "";
	const format = typeof o.format === "string" && o.format.trim() !== "" ? o.format.trim() : DEFAULT_DAILY_FORMAT;
	return { folder, format };
}

/** Vault path of the daily note of `date`; `format` turns a date and a moment.js format into text. */
export function dailyNotePath(cfg: DailyNoteConfig, date: Date, format: (date: Date, pattern: string) => string): string {
	const name = format(date, cfg.format).replace(/[\\]/g, "/").replace(/^\/+/, "");
	const withExt = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
	return cfg.folder ? `${cfg.folder}/${withExt}` : withExt;
}

/**
 * The note's text with `line` added at the end, or null when the note already links to the page (its id, or the very line,
 * is in the text): then nothing is written. The rest of the text is returned byte for byte.
 */
export function withTodayLink(text: string, line: string, pageId: string): string | null {
	if ((pageId !== "" && text.includes(pageId)) || text.split(/\r?\n/).some((l) => l.trim() === line.trim())) return null;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const sep = text === "" || text.endsWith("\n") ? "" : eol;
	return `${text}${sep}${line}${eol}`;
}
