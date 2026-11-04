/**
 * 0.16 review (C2, C5): which notes link to or embed a file. Obsidian keeps this in `metadataCache.resolvedLinks`
 * (source note -> target path -> number of links); these helpers read it without any Node module.
 */
import type { App } from "obsidian";

export type ResolvedLinks = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The notes (paths, sorted) that link to or embed `target`. */
export function linkingNotes(resolved: ResolvedLinks, target: string): string[] {
	const out: string[] = [];
	for (const [source, links] of Object.entries(resolved)) {
		if (source === target) continue;
		const n = links[target];
		if (typeof n === "number" && n > 0) out.push(source);
	}
	return out.sort();
}

/** The notes that link to or embed the file at `path`, per Obsidian's link index (empty when it is not available). */
export function backlinksOf(app: App, path: string): string[] {
	try {
		return linkingNotes(app.metadataCache.resolvedLinks, path);
	} catch {
		return [];
	}
}
