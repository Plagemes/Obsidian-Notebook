/**
 * The `notebook-new` placeholder (wave 0.19, roadmap O13). Pure: no 'obsidian'.
 *
 * A fenced code block that core Templates and Templater leave alone (they only expand `{{title}}` / `<% %>`), so a note
 * template can carry "a notebook to be made for this note":
 *
 *     ```notebook-new
 *     name="{{title}} sketches"
 *     template="Lecture"
 *     ```
 *
 * Rendering shows a "Create notebook" button; only a click creates it, and then ONLY this block is replaced by an embed.
 */

export interface NewBlockSpec {
	name: string;
	template?: string;
	folder?: string;
	/** With a template: keep its ink and elements (default true) or only its pages. */
	content?: boolean;
	open?: boolean;
}

export type NewBlockParse = { ok: true; spec: NewBlockSpec } | { ok: false; error: "empty" | "syntax" | "unknown-key" | "no-name" | "unexpanded" | "bad-value"; detail: string };

export const NEW_BLOCK_LANG = "notebook-new";

const KEYS = ["name", "template", "folder", "content", "open"] as const;
type Key = (typeof KEYS)[number];

/** Template syntax that was not expanded: creating a notebook called "<% tp.file.title %>" would be a surprise. */
const UNEXPANDED = /\{\{[^}]*\}\}|<%[\s\S]*?%>/;

/** Reads `key="value"` lines (also `key: value` and bare values). Quotes may be double or single. */
export function parseNewBlock(source: string): NewBlockParse {
	const raw: Partial<Record<Key, string>> = {};
	let any = false;
	for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		any = true;
		const m = /^([A-Za-z]+)\s*[=:]\s*(.*)$/.exec(text);
		if (!m) return { ok: false, error: "syntax", detail: text };
		const key = m[1]!.toLowerCase();
		if (!(KEYS as readonly string[]).includes(key)) return { ok: false, error: "unknown-key", detail: m[1]! };
		let value = m[2]!.trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
		else if (q === '"' || q === "'") return { ok: false, error: "syntax", detail: text };
		raw[key as Key] = value.trim();
	}
	if (!any) return { ok: false, error: "empty", detail: "" };
	if (!raw.name) return { ok: false, error: "no-name", detail: "" };
	for (const k of KEYS) {
		const v = raw[k];
		if (v !== undefined && UNEXPANDED.test(v)) return { ok: false, error: "unexpanded", detail: v };
	}
	const spec: NewBlockSpec = { name: raw.name };
	if (raw.template) spec.template = raw.template;
	if (raw.folder) spec.folder = raw.folder;
	for (const k of ["content", "open"] as const) {
		const v = raw[k];
		if (v === undefined) continue;
		const b = /^(true|yes|on|1)$/i.test(v) ? true : /^(false|no|off|0)$/i.test(v) ? false : null;
		if (b === null) return { ok: false, error: "bad-value", detail: `${k}=${v}` };
		spec[k] = b;
	}
	return { ok: true, spec };
}

/** The block as text, for the docs and tests: what a template file contains. */
export function formatNewBlock(spec: NewBlockSpec): string {
	const lines = [`name="${spec.name}"`];
	if (spec.template) lines.push(`template="${spec.template}"`);
	if (spec.folder) lines.push(`folder="${spec.folder}"`);
	if (spec.content !== undefined) lines.push(`content=${String(spec.content)}`);
	if (spec.open !== undefined) lines.push(`open=${String(spec.open)}`);
	return `\`\`\`${NEW_BLOCK_LANG}\n${lines.join("\n")}\n\`\`\``;
}

export interface FoundBlock {
	/** Offsets in the text: from the first character of the opening fence to the end of the closing fence. */
	start: number;
	end: number;
	/** 0-based line of the opening fence. */
	line: number;
	/** The text between the fences, lines joined with "\n". */
	source: string;
}

/** Every fenced `notebook-new` block of a note. Other fences are skipped whole, so an example inside a longer fence is not found. */
export function findNewBlocks(text: string): FoundBlock[] {
	const out: FoundBlock[] = [];
	const lines: Array<{ text: string; offset: number }> = [];
	let offset = 0;
	for (const part of text.split("\n")) {
		lines.push({ text: part.endsWith("\r") ? part.slice(0, -1) : part, offset });
		offset += part.length + 1;
	}
	for (let i = 0; i < lines.length; i++) {
		const open = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(lines[i]!.text);
		if (!open) continue;
		const fence = open[1]!;
		let close = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!.text);
			if (c && c[1]![0] === fence[0] && c[1]!.length >= fence.length) {
				close = j;
				break;
			}
		}
		if (close < 0) break; // an unclosed fence runs to the end of the note
		if (open[2] === NEW_BLOCK_LANG && /^ {0,3}\S/.test(lines[i]!.text)) {
			out.push({
				start: lines[i]!.offset,
				end: lines[close]!.offset + lines[close]!.text.length,
				line: i,
				source: lines.slice(i + 1, close).map((l) => l.text).join("\n"),
			});
		}
		i = close;
	}
	return out;
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/** Which of several identical blocks a button belongs to: its place among them, and how many there were. Survives lines typed above it. */
export interface BlockSlot {
	index: number;
	count: number;
}

function pickBlock(matches: readonly FoundBlock[], lineHint?: number, slot?: BlockSlot): FoundBlock | undefined {
	if (slot && matches.length === slot.count) return matches[slot.index];
	if (!slot && lineHint !== undefined) {
		const at = matches.find((b) => b.line === lineHint);
		if (at) return at;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

/** The slot of the block with content `source` at `lineHint` (see `replaceNewBlock`); null when no block can be picked. */
export function newBlockSlot(text: string, source: string, lineHint?: number): BlockSlot | null {
	const wanted = norm(source);
	const matches = findNewBlocks(text).filter((b) => norm(b.source) === wanted);
	const pick = pickBlock(matches, lineHint);
	return pick ? { index: matches.indexOf(pick), count: matches.length } : null;
}

/**
 * Replaces the one block whose content is `source` with `replacement`. `lineHint` (the section's first line from Obsidian)
 * picks between identical blocks; without it the block must be unique. `slot` (taken before anything was made, see
 * `newBlockSlot`) wins over the hint: lines typed above the block meanwhile do not move it onto another identical block, and if
 * the number of identical blocks changed the block must be unique. Returns null (nothing to change) when no block matches, or
 * when several match and none can be told apart: never a guess.
 */
export function replaceNewBlock(text: string, source: string, replacement: string, lineHint?: number, slot?: BlockSlot): string | null {
	const wanted = norm(source);
	const matches = findNewBlocks(text).filter((b) => norm(b.source) === wanted);
	if (matches.length === 0) return null;
	const pick = pickBlock(matches, lineHint, slot);
	if (!pick) return null;
	return text.slice(0, pick.start) + replacement + text.slice(pick.end);
}

function bag(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** The folders of the core Templates plugin and of Templater, as configured (read leniently from Obsidian's internals; empty when none). */
export function templateFoldersFrom(app: unknown): string[] {
	const out: string[] = [];
	const add = (v: unknown): void => {
		if (typeof v !== "string") return;
		const folder = v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (folder !== "") out.push(folder);
	};
	try {
		const root = bag(app);
		const internal = bag(root?.internalPlugins);
		const getById = internal?.getPluginById;
		if (typeof getById === "function") {
			const core = bag((getById as (id: string) => unknown).call(internal, "templates"));
			if (core?.enabled === true) add(bag(bag(core.instance)?.options)?.folder);
		}
		const community = bag(bag(root?.plugins)?.plugins);
		add(bag(bag(community?.["templater-obsidian"])?.settings)?.templates_folder);
	} catch {
		// Unknown internals read as no template folder.
	}
	return out;
}

/** Is the note at `path` inside one of the template folders? There a `notebook-new` block is the template's own text, not a button. */
export function isTemplateNote(path: string, folders: readonly string[]): boolean {
	const p = path.replace(/\\/g, "/");
	return folders.some((f) => p === f || p.startsWith(`${f}/`));
}
