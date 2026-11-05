/**
 * 0.20 reference window (#107): pure decisions of the floating reference window: what kind of reference a file is, which page
 * a link names, how the page stepper moves. No Obsidian imports: testable in Node.
 */
import { resolvePageTarget, type PageTarget } from "../integration/page-links";

export type ReferenceKind = "notebook" | "pdf" | "image" | "markdown";

/** Pictures the window can show (what the webview decodes everywhere). */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/** The kind of reference a file extension is, or null when the window cannot show it. */
export function referenceKind(extension: string, notebookExtensions: readonly string[]): ReferenceKind | null {
	const ext = extension.trim().toLowerCase();
	if (!ext) return null;
	if (notebookExtensions.some((e) => e.toLowerCase() === ext)) return "notebook";
	if (ext === "pdf") return "pdf";
	if (ext === "md") return "markdown";
	return IMAGE_EXTENSIONS.includes(ext) ? "image" : null;
}

/** Which file to show, and where. `page` is 1-based; `pageId` wins over it for a notebook link written by the plugin. */
export interface ReferenceRequest {
	path: string;
	page: number | null;
	pageId: string | null;
}

/** The 0-based page a request names in a source of `ids` (page ids; null for a source without ids, such as a PDF). Out of range: the last/first page. */
export function requestedIndex(count: number, ids: ReadonlyArray<string> | null, request: Pick<ReferenceRequest, "page" | "pageId">): number {
	if (count <= 0) return 0;
	if (ids) {
		const target: PageTarget = { page: request.page, pageId: request.pageId };
		const found = resolvePageTarget(ids.map((id) => ({ id })), target);
		if ("index" in found) return found.index;
		return 0; // the page was deleted: show the first one
	}
	const page = request.page ?? 1;
	return Math.min(count - 1, Math.max(0, Math.floor(page) - 1));
}

/** The page after stepping by `delta` (stays within the source). */
export function stepIndex(index: number, delta: number, count: number): number {
	return Math.min(Math.max(0, count - 1), Math.max(0, index + delta));
}

/** "3 / 12" for the stepper (1-based). */
export function pageLabel(index: number, count: number): string {
	return `${index + 1} / ${Math.max(1, count)}`;
}

/** Whether the pointer type may move the content (a pen does nothing inside the window: it never draws on the reference). */
export function movesContent(pointerType: string): boolean {
	return pointerType === "touch" || pointerType === "mouse";
}

/** Whether the pointer type may use the window's own controls (header drag, resize, buttons): everything, the pen included. */
export function usesChrome(_pointerType: string): boolean {
	return true;
}

/**
 * 0.21 (R4): the page to draw when the source has `count` pages. An empty or unknown count (the lending pane went away and the
 * file is not read yet, or could not be read) keeps the index: the window never jumps to page 1 because it knows nothing.
 */
export function keepIndex(index: number, count: number): number {
	if (count <= 0) return Math.max(0, index);
	return Math.min(Math.max(0, index), count - 1);
}
