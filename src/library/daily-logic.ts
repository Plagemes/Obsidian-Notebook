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
	/** Vault path of the configured template (as the plugins keep it, usually without `.md`); absent when there is none. */
	template?: string;
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
	const template = typeof o.template === "string" ? o.template.replace(/[\\]/g, "/").replace(/^\/+/, "").trim() : "";
	return template ? { folder, format, template } : { folder, format };
}

type Bag = Record<string, unknown>;
const asBag = (v: unknown): Bag | null => (typeof v === "object" && v !== null ? (v as Bag) : null);

/**
 * Folder, format and template of the daily notes. Periodic Notes (when its daily notes are on) wins over the core plugin.
 * Both are read through Obsidian's internals (`app.plugins`, `app.internalPlugins`), leniently: anything unexpected gives null.
 * The core plugin is read as `getPluginById(id)` (`{ enabled, instance }`, the shape the Bookmarks integration relies on):
 * `getEnabledPluginById` returns the instance itself, which has no `.instance`.
 */
export function readDailyConfigFrom(app: unknown): DailyNoteConfig | null {
	const bag = asBag(app);
	const community = asBag(bag?.plugins);
	const getPlugin = community?.getPlugin;
	if (typeof getPlugin === "function") {
		const periodic = asBag((getPlugin as (id: string) => unknown).call(community, "periodic-notes"));
		const daily = asBag(asBag(periodic?.settings)?.daily);
		if (daily?.enabled === true) return parseDailyConfig(daily);
	}
	const internal = asBag(bag?.internalPlugins);
	const getById = internal?.getPluginById;
	if (typeof getById === "function") {
		const core = asBag((getById as (id: string) => unknown).call(internal, "daily-notes"));
		// Only a plugin that says it is on.
		if (core?.enabled === true) return parseDailyConfig(asBag(core.instance)?.options);
	}
	return null;
}

/** Vault path of the template file: the configured path with `.md` added when missing. */
export function dailyTemplatePath(template: string): string {
	return template.toLowerCase().endsWith(".md") ? template : `${template}.md`;
}

/** The ways to reach the Daily notes template file (the vault, in the app). */
export interface DailyTemplateHost<F> {
	/** Resolves a link path the way a link does (`metadataCache.getFirstLinkpathDest(link, "")`). */
	resolveLink(link: string): F | null;
	byPath(path: string): F | null;
	read(file: F): Promise<string>;
	normalize(path: string): string;
}

/**
 * The raw text of the Daily notes template, found like the core plugin does (as a link path, so a name without its folder or
 * its `.md` works), else by path with `.md` added. Null when there is no such file, it cannot be read, or its text is empty
 * or only NUL characters (a file a sync has not downloaded yet): then no note is made from it.
 */
export async function loadDailyTemplate<F>(host: DailyTemplateHost<F>, template: string): Promise<string | null> {
	try {
		const file = host.resolveLink(host.normalize(template)) ?? host.byPath(host.normalize(dailyTemplatePath(template))) ?? host.byPath(host.normalize(template));
		if (!file) return null;
		const text = await host.read(file);
		return text.split(String.fromCharCode(0)).join("").trim() === "" ? null : text;
	} catch {
		return null;
	}
}

/**
 * The template with the placeholders the core Daily notes plugin knows filled in: `{{date}}`, `{{time}}`, `{{title}}`
 * (`{{date:FORMAT}}` and `{{time:FORMAT}}` take a moment.js format). `format` turns a date and a pattern into text.
 */
export function applyDailyTemplate(
	template: string,
	title: string,
	date: Date,
	dateFormat: string,
	format: (date: Date, pattern: string) => string,
): string {
	return template
		.replace(/{{\s*date\s*(?::([^}]*?))?\s*}}/gi, (_m, f: string | undefined) => format(date, f?.trim() ? f.trim() : dateFormat))
		.replace(/{{\s*time\s*(?::([^}]*?))?\s*}}/gi, (_m, f: string | undefined) => format(date, f?.trim() ? f.trim() : "HH:mm"))
		.replace(/{{\s*title\s*}}/gi, title);
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
