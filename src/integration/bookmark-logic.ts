// wave 0.9 (385): the testable part of bookmarking a notebook page in Obsidian's Bookmarks pane (no 'obsidian' runtime
// import). The core Bookmarks plugin has no published API, so `bookmarksInstance` feature-detects it
// (`app.internalPlugins`): the one place that touches the internals.
import type { App } from "obsidian";
import { stablePageSubpath } from "./page-links";

/** A bookmark of the "file" type, as the Bookmarks plugin stores it (`subpath` includes the `#`). */
export interface FileBookmark {
	type: "file";
	path: string;
	subpath: string;
	title: string;
	/** Creation time (ms), as the Bookmarks plugin stores it for its own entries. */
	ctime: number;
}

/** The part of the Bookmarks plugin instance this uses. */
export interface BookmarksInstance {
	addItem(item: FileBookmark): void;
	items?: unknown;
}

export function pageBookmark(path: string, page: number, pageId: string | null | undefined, title: string, now: number = Date.now()): FileBookmark {
	return { type: "file", ctime: now, path, subpath: stablePageSubpath(page, pageId), title };
}

/** Looks for a bookmark of the same path and subpath, also inside bookmark groups. */
export function hasBookmark(items: unknown, path: string, subpath: string): boolean {
	if (!Array.isArray(items)) return false;
	for (const item of items as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const b = item as { type?: unknown; path?: unknown; subpath?: unknown; items?: unknown };
		if (b.type === "file" && b.path === path && (typeof b.subpath === "string" ? b.subpath : "") === subpath) return true;
		if (b.type === "group" && hasBookmark(b.items, path, subpath)) return true;
	}
	return false;
}

/** True when `x` looks like the instance of the Bookmarks plugin. */
export function isBookmarksInstance(x: unknown): x is BookmarksInstance {
	return typeof x === "object" && x !== null && typeof (x as { addItem?: unknown }).addItem === "function";
}

/** The enabled core Bookmarks plugin's instance, or null (plugin off, or Obsidian without this internal API). */
export function bookmarksInstance(app: App): BookmarksInstance | null {
	try {
		const internal = (app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: unknown } | undefined } }).internalPlugins;
		const plugin = internal?.getPluginById?.("bookmarks");
		// Only a plugin that says it is on (`enabled` missing or anything but true: treated as off).
		if (!plugin || plugin.enabled !== true) return null;
		return isBookmarksInstance(plugin.instance) ? plugin.instance : null;
	} catch {
		return null;
	}
}

