/**
 * Where a notebook's companion note lives, and the companion settings. Pure: no 'obsidian'.
 *
 * Kept apart from the content generator (model/companion-content.ts) on purpose: when notebooks move
 * to a Markdown container (M4) the generated content becomes the notebook's own frontmatter and body,
 * and only this file-location logic goes away.
 */

export type CompanionLocation = "beside" | "folder";

export interface CompanionSettings {
	/** Keep a companion note for every notebook (O1). */
	companionNotes: boolean;
	/** `beside`: same folder as the notebook. `folder`: under `companionFolder`, mirroring the notebook's subfolders. */
	companionLocation: CompanionLocation;
	companionFolder: string;
	/** File name without `.md`; `{name}` is the notebook's name. */
	companionName: string;
}

export const NAME_TOKEN = "{name}";

export const DEFAULT_COMPANION_SETTINGS: Readonly<CompanionSettings> = {
	companionNotes: false,
	companionLocation: "beside",
	companionFolder: "Notebook notes",
	companionName: NAME_TOKEN,
};

/** Characters Obsidian (or one of the platforms it syncs to) does not accept in a file name, plus link syntax. */
const BAD_NAME = /[\\/:*?"<>|#^[\]]/;

/** A name template is usable when it contains `{name}` and gives a valid file name. */
export function validCompanionName(template: string): boolean {
	const name = template.trim();
	if (!name.includes(NAME_TOKEN)) return false;
	const sample = name.split(NAME_TOKEN).join("x");
	return !BAD_NAME.test(sample) && !sample.startsWith(".");
}

function cleanFolder(folder: string): string {
	return folder.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "." && s !== "..").join("/");
}

/** Reads the companion settings from saved plugin data, ignoring values of the wrong type. */
export function readCompanionSettings(d: Record<string, unknown>): CompanionSettings {
	const s: CompanionSettings = { ...DEFAULT_COMPANION_SETTINGS };
	if (typeof d.companionNotes === "boolean") s.companionNotes = d.companionNotes;
	if (d.companionLocation === "beside" || d.companionLocation === "folder") s.companionLocation = d.companionLocation;
	if (typeof d.companionFolder === "string" && cleanFolder(d.companionFolder)) s.companionFolder = cleanFolder(d.companionFolder);
	if (typeof d.companionName === "string" && validCompanionName(d.companionName)) s.companionName = d.companionName.trim();
	return s;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** File name without its last extension (`Physics.notebook` → `Physics`). */
export function notebookBaseName(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

function join(...parts: string[]): string {
	return parts.filter((p) => p.length > 0).join("/");
}

/**
 * Vault path of the companion note of the notebook at `notebookPath`.
 * In `folder` mode the notebook's folder relative to the notebooks folder is mirrored, so two
 * notebooks with the same name in different folders never share a companion.
 */
export function companionPath(notebookPath: string, settings: CompanionSettings, notebooksFolder: string): string {
	const path = notebookPath.replace(/^\/+/, "");
	const fileName = `${settings.companionName.split(NAME_TOKEN).join(notebookBaseName(path))}.md`;
	const dir = dirOf(path);
	if (settings.companionLocation === "beside") return join(dir, fileName);
	const root = cleanFolder(notebooksFolder);
	let rel = dir;
	if (root === "") rel = dir;
	else if (dir === root) rel = "";
	else if (dir.startsWith(`${root}/`)) rel = dir.slice(root.length + 1);
	return join(cleanFolder(settings.companionFolder), rel, fileName);
}

/**
 * Paths to try, in order: the configured one, then `<name> (notebook).md` for when a note of the user's
 * already has the configured name (that note is never taken over).
 */
export function companionCandidates(notebookPath: string, settings: CompanionSettings, notebooksFolder: string): string[] {
	const main = companionPath(notebookPath, settings, notebooksFolder);
	return [main, `${main.slice(0, -".md".length)} (notebook).md`];
}
