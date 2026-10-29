/** Pure decisions and element builders for pasting (no DOM, no 'obsidian'): testable in Node. */
import { createId } from "../model/document";
import type { ImageElement, Page, TextElement } from "../model/types";
import { centredPosition, imageElementSize, newTextBox } from "./view-helpers";

/** Longest text pasted into one text box; the rest is dropped and the user is told. */
export const MAX_PASTED_TEXT = 20000;

/** What the system clipboard holds, as far as deciding goes. `readable` is false when it could not be read at all. */
export interface SystemClipboardState {
	readable: boolean;
	hasImage: boolean;
	text: string;
}

export type PasteDecision = "internal" | "image" | "text" | "empty" | "unreadable";

/**
 * What a paste should do. The in-plugin clipboard wins only while the system clipboard still holds the marker text
 * that copying wrote there (or cannot be read): anything the user copied elsewhere since is newer.
 */
export function decidePaste(sys: SystemClipboardState, internalMarker: string | null): PasteDecision {
	const hasInternal = internalMarker !== null;
	if (!sys.readable) return hasInternal ? "internal" : "unreadable";
	if (sys.hasImage) return "image";
	const text = sys.text.trim();
	if (text !== "") {
		if (hasInternal && text === internalMarker.trim()) return "internal";
		return "text";
	}
	return hasInternal ? "internal" : "empty";
}

/** Text written to the system clipboard when a selection is copied inside the plugin. */
export function clipMarker(strokes: number, images: number, texts: number): string {
	const parts: string[] = [];
	if (strokes > 0) parts.push(`${strokes} stroke${strokes === 1 ? "" : "s"}`);
	if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
	if (texts > 0) parts.push(`${texts} text box${texts === 1 ? "" : "es"}`);
	return `[Notebook selection: ${parts.join(", ")}]`;
}

/** True for the control characters that have no place in a text box (everything below 32 except tab and line feed, and DEL). */
function isStrayControl(code: number): boolean {
	return (code < 32 && code !== 9 && code !== 10) || code === 127;
}

/** Line breaks unified, control characters removed, trailing blanks trimmed, length capped. */
export function normalizePastedText(raw: string): { text: string; truncated: boolean } {
	const unified = raw.replace(/\r\n?/g, "\n");
	let kept = "";
	for (let i = 0; i < unified.length; i++) if (!isStrayControl(unified.charCodeAt(i))) kept += unified[i];
	const text = kept.replace(/\s+$/, "").replace(/^\n+/, "");
	if (text.length <= MAX_PASTED_TEXT) return { text, truncated: false };
	return { text: text.slice(0, MAX_PASTED_TEXT), truncated: true };
}

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** File name for pasted image bytes (the extension must be one the assets accept; unknown types become png). */
export function pastedImageName(mime: string, now: Date = new Date()): string {
	const ext = EXT_BY_MIME[mime.toLowerCase()] ?? "png";
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `pasted-image-${stamp}.${ext}`;
}

/** An image element for a pasted picture of `dims` pixels, centred on (cx, cy) of `page`, sized like an inserted image. */
export function pastedImageElement(
	asset: string, dims: { width: number; height: number }, page: Pick<Page, "width" | "height">, cx: number, cy: number,
): ImageElement {
	const size = imageElementSize(dims.width, dims.height, page.width, page.height);
	const [x, y] = centredPosition(cx, cy, size, page);
	return { id: createId(), type: "image", asset, x, y, width: size.width, height: size.height, rotation: 0 };
}

/** A text box for pasted text, its top edge near (cx, cy), about 60 % of the page wide and kept on the page. */
export function pastedTextElement(
	text: string, page: Pick<Page, "width" | "height">, cx: number, cy: number, fontSize: number, color: string,
): TextElement {
	const wanted = Math.max(0, cx - page.width * 0.3);
	const box = newTextBox(page.width, wanted, Math.max(0, Math.min(cy, page.height - fontSize * 2)));
	return { id: createId(), type: "text", x: box.x, y: box.y, width: box.width, text, fontSize, color };
}
