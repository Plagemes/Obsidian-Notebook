import { FILE_EXTENSION } from "../model/types";

/**
 * The only place that knows how a notebook is stored in a vault file (the "container").
 *
 * Today a notebook is a `.notebook` file whose whole content is the document JSON. M4 may move to
 * Markdown (`.md` with the JSON in a block, or a companion `.md`); when that happens only this
 * module changes. Library, index, links, embeds, history, scanner and import must use these
 * helpers instead of testing the extension or reading the raw text themselves.
 */

/** Extensions Obsidian should open with the notebook view. */
export const NOTEBOOK_EXTENSIONS: readonly string[] = [FILE_EXTENSION];

/** Extension used for new notebooks. */
export const NEW_NOTEBOOK_EXTENSION = FILE_EXTENSION;

export function isNotebookFile(file: { extension?: string } | null | undefined): boolean {
	return !!file && typeof file.extension === "string" && NOTEBOOK_EXTENSIONS.includes(file.extension);
}

/** Document JSON contained in a file's raw text. */
export function readNotebookText(extension: string, raw: string): string {
	void extension; // .notebook: the whole file is the document.
	return raw;
}

/** Raw file text that stores `json`, keeping whatever else `previousRaw` contained around it. */
export function writeNotebookText(extension: string, json: string, previousRaw: string): string {
	void extension;
	void previousRaw; // .notebook: nothing to preserve.
	return json;
}
