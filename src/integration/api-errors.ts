/**
 * Typed errors of the public API (docs/api.md). Pure: no 'obsidian'.
 *
 * Every failure of an API call is a `NotebookApiError` with a stable `code`: nothing is ignored silently and a failed
 * call leaves the notebook as it was (or, for an open notebook, says that the change could not be saved yet).
 */

export const API_ERROR_CODES = [
	/** An argument is missing, has the wrong type, is out of range or has an unknown field. `details` names it. */
	"invalid-argument",
	/** The notebook, or the image file given by path, does not exist. */
	"not-found",
	/** The file exists but is not a notebook. */
	"not-a-notebook",
	/** The notebook cannot be read (damaged, or written by a newer version). It is never overwritten. */
	"unreadable",
	/** The image is not a PNG, JPEG, GIF or WebP, or cannot be decoded. */
	"unsupported-image",
	/** The notebook is open but cannot be edited right now (still loading, read-only, a pen is down). Retry later. */
	"busy",
	/** The notebook file changed while the call was writing it; nothing was written. Retry. */
	"changed-elsewhere",
	/** The change could not be written, saved or verified. The notebook file was not replaced by a partial result. */
	"write-failed",
	/** The notebook could not be opened in a tab. */
	"open-failed",
	/** The PDF could not be produced. */
	"export-failed",
	/** `exportPdf` with `strict: true` and some images could not be loaded; no file was written. */
	"export-incomplete",
] as const;

export type NotebookApiErrorCode = (typeof API_ERROR_CODES)[number];

export class NotebookApiError extends Error {
	readonly code: NotebookApiErrorCode;
	/** Machine-readable context (argument name, path, limits…). */
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: NotebookApiErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "NotebookApiError";
		this.code = code;
		this.details = details;
	}
}

/** Shorthand for the most common failure. */
export function invalid(argument: string, message: string, details: Record<string, unknown> = {}): NotebookApiError {
	return new NotebookApiError("invalid-argument", `${argument}: ${message}`, { argument, ...details });
}
