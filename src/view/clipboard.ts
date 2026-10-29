import type { ClipContent } from "../ink/clipboard";
import type { SystemClipboardState } from "./paste-logic";

/**
 * The plugin's own clipboard (a module-level singleton, so it survives switching notebooks for the whole session:
 * every notebook view shares this one module) and the thin wrappers around the system clipboard.
 */

export interface InternalClip {
	content: ClipContent;
	/** Bytes of the images the content uses, by asset id; filled in right after the copy (images are read asynchronously). */
	bytes: Map<string, ArrayBuffer>;
	/** Text written to the system clipboard by the copy; seeing it again there means nothing newer was copied elsewhere. */
	marker: string;
	/** How many times it was pasted: each paste moves a little further so copies do not hide each other. */
	pastes: number;
}

let current: InternalClip | null = null;

export const internalClip = {
	get(): InternalClip | null {
		return current;
	},
	set(content: ClipContent, marker: string): InternalClip {
		current = { content, bytes: new Map(), marker, pastes: 0 };
		return current;
	},
	clear(): void {
		current = null;
	},
};

export interface SystemImage {
	bytes: ArrayBuffer;
	mime: string;
}

/** What was found on the system clipboard (or in a paste event). */
export interface SystemClip {
	state: SystemClipboardState;
	image: SystemImage | null;
}

const UNREADABLE: SystemClip = { state: { readable: false, hasImage: false, text: "" }, image: null };

async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
	if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
	return new Promise<ArrayBuffer>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => (reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("unreadable")));
		reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
		reader.readAsArrayBuffer(blob);
	});
}

/**
 * Reads the system clipboard through `navigator.clipboard` (needs a user gesture and, in some WebViews, a permission
 * that is not granted: then the result says `readable: false` and the caller offers the paste box instead).
 */
export async function readSystemClipboard(): Promise<SystemClip> {
	const cb = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
	if (!cb) return UNREADABLE;
	if (typeof cb.read === "function") {
		try {
			const items = await cb.read();
			let image: SystemImage | null = null;
			let text = "";
			for (const item of items) {
				const imageType = item.types.find((ty) => ty.startsWith("image/"));
				if (imageType && !image) {
					const blob = await item.getType(imageType);
					image = { bytes: await blobBytes(blob), mime: imageType };
				}
				if (item.types.includes("text/plain") && !text) text = await (await item.getType("text/plain")).text();
			}
			return { state: { readable: true, hasImage: image !== null, text }, image };
		} catch {
			// Permission denied or not supported for this content: try plain text.
		}
	}
	if (typeof cb.readText === "function") {
		try {
			return { state: { readable: true, hasImage: false, text: await cb.readText() }, image: null };
		} catch {
			return UNREADABLE;
		}
	}
	return UNREADABLE;
}

/**
 * Takes the first image and the plain text out of a paste event. The event data is only valid while it is being
 * dispatched, so everything synchronous happens before the first await.
 */
export async function systemClipFromEvent(e: ClipboardEvent): Promise<SystemClip> {
	const data = e.clipboardData;
	if (!data) return UNREADABLE;
	const text = data.getData("text/plain");
	let file: File | null = null;
	for (const item of Array.from(data.items ?? [])) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			file = item.getAsFile();
			if (file) break;
		}
	}
	file ??= Array.from(data.files ?? []).find((f) => f.type.startsWith("image/")) ?? null;
	if (!file) return { state: { readable: true, hasImage: false, text }, image: null };
	const mime = file.type || "image/png";
	return { state: { readable: true, hasImage: true, text }, image: { bytes: await blobBytes(file), mime } };
}

/** Best-effort write of plain text to the system clipboard (the caller does not depend on it succeeding). */
export async function writeSystemText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
