/**
 * Sync and data safety (roadmap #343, #344, #345): pure checks, no Obsidian imports.
 *
 * The vault is synced by an app outside Obsidian (Google Drive or OneDrive through a folder-sync app). The
 * plugin cannot ask that app anything; what it can see is the files themselves. See docs/architecture.md,
 * "Sync and data safety", for what can and cannot be detected.
 */

/**
 * #344: whether a notebook file's text is what a sync client leaves before the content arrives: nothing
 * (a 0-byte placeholder), only whitespace, or only NUL bytes (space reserved by a download in progress).
 * Such a file is "not downloaded yet": never damaged, never backed up, never repaired.
 */
export function isAwaitingDownload(text: string): boolean {
	return /^[\s\0]*$/.test(text);
}

/** #343: the state of an asset file. `waiting`: not in the vault yet, or smaller than the asset (still arriving). */
export type AssetAvailability = "present" | "waiting";

/**
 * `size` is the size of the asset's file in the vault (null when there is no file), `expectedBytes` the size
 * recorded in the document (0 when unknown).
 */
export function assetAvailability(size: number | null, expectedBytes: number): AssetAvailability {
	if (size === null || size === 0) return "waiting";
	if (expectedBytes > 0 && size < expectedBytes) return "waiting";
	return "present";
}

// ------------------------------------------------------------------------------- #345

export type SyncIssueKind =
	/** The notebooks folder is inside Obsidian's config folder (often not synced, never indexed). */
	| "config-folder"
	/** A folder on the way starts with "." (hidden: skipped by many sync apps, never indexed by Obsidian). */
	| "hidden-folder"
	/** A folder named `*.nosync` (excluded from iCloud, and by convention by some sync apps). */
	| "nosync-folder"
	/** A name with `" * : < > ? | \` or control characters: rejected by OneDrive, Windows and Android shared storage. */
	| "bad-chars"
	/** A name that starts or ends with a space, or ends with a dot: OneDrive and Windows refuse or change it. */
	| "edge-space-dot"
	/** A reserved name (CON, NUL, COM1, desktop.ini, `~$…`, `_vti_`): OneDrive and Windows refuse it. */
	| "reserved-name"
	/** A long path: with the folder the vault is in it may pass Windows' 260 or OneDrive's 400 characters. */
	| "long-path"
	/** A name longer than 255 characters: too long for most file systems. */
	| "long-name"
	/** Two names that differ only in upper/lower case: Windows, macOS and OneDrive keep only one. */
	| "case-clash"
	/** At least LARGE_FILE_BYTES: some sync apps skip such files (e.g. in a free version) and they sync slowly. */
	| "large-file"
	/** At least VERY_LARGE_FILE_BYTES: e.g. above GitHub's limit for Obsidian Git users. */
	| "very-large-file";

export interface SyncIssue {
	kind: SyncIssueKind;
	/** Vault path of the file or folder concerned. */
	path: string;
	/** Size in bytes (size issues), or the other path (case clashes). */
	size?: number;
	other?: string;
}

export const LARGE_FILE_BYTES = 10 * 1024 * 1024;
export const VERY_LARGE_FILE_BYTES = 100 * 1024 * 1024;
/** Vault-relative path length that is reported as long (the vault's own location adds to it). */
export const LONG_PATH_CHARS = 200;
export const LONG_NAME_CHARS = 255;

// eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for
const BAD_CHARS = /["*:<>?|\\\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** The issue of one path segment (a file or folder name), or null. */
export function segmentIssue(name: string): SyncIssueKind | null {
	if (BAD_CHARS.test(name)) return "bad-chars";
	if (/^\s|\s$|\.$/.test(name)) return "edge-space-dot";
	if (RESERVED.test(name) || name.toLowerCase() === "desktop.ini" || name.startsWith("~$") || name.toLowerCase().includes("_vti_")) return "reserved-name";
	if (name.length > LONG_NAME_CHARS) return "long-name";
	return null;
}

/** Issues of the notebooks folder itself (`folder` vault-relative, "" = vault root; `configDir` usually ".obsidian"). */
export function folderIssues(folder: string, configDir: string): SyncIssue[] {
	const path = folder.replace(/^\/+|\/+$/g, "");
	const out: SyncIssue[] = [];
	if (path === "") return out;
	const config = configDir.replace(/^\/+|\/+$/g, "");
	if (config && (path === config || path.startsWith(`${config}/`))) out.push({ kind: "config-folder", path });
	else if (path.split("/").some((s) => s.startsWith("."))) out.push({ kind: "hidden-folder", path });
	if (path.split("/").some((s) => s.toLowerCase().endsWith(".nosync"))) out.push({ kind: "nosync-folder", path });
	return out;
}

export function sizeIssue(path: string, size: number): SyncIssue | null {
	if (size >= VERY_LARGE_FILE_BYTES) return { kind: "very-large-file", path, size };
	if (size >= LARGE_FILE_BYTES) return { kind: "large-file", path, size };
	return null;
}

/**
 * Every issue under the notebooks folder: the folder itself, then names (each bad folder reported once, not for
 * every file in it), case clashes and sizes. `files` are vault-relative paths with their sizes.
 */
export function scanForSyncIssues(folder: string, configDir: string, files: ReadonlyArray<{ path: string; size: number }>): SyncIssue[] {
	const out = folderIssues(folder, configDir);
	const reported = new Set<string>();
	const byLower = new Map<string, string>();
	const clash = (path: string) => {
		const lower = path.toLowerCase();
		const have = byLower.get(lower);
		if (have === undefined) byLower.set(lower, path);
		else if (have !== path && !reported.has(`case:${lower}`)) {
			reported.add(`case:${lower}`);
			out.push({ kind: "case-clash", path, other: have });
		}
	};
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const segments = f.path.split("/");
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix ? `${prefix}/${segment}` : segment;
			clash(prefix);
			if (reported.has(prefix)) break;
			const kind = segmentIssue(segment);
			if (kind) {
				reported.add(prefix);
				out.push({ kind, path: prefix });
				break;
			}
		}
		if (f.path.length > LONG_PATH_CHARS) out.push({ kind: "long-path", path: f.path });
		const big = sizeIssue(f.path, f.size);
		if (big) out.push(big);
	}
	return out;
}

/** A short stable text for a set of issues: the startup notice is shown again only when it changes. */
export function issueSignature(issues: readonly SyncIssue[]): string {
	return issues.map((i) => `${i.kind}:${i.path}`).sort().join("\n");
}

/** Human-readable size: "12.3 MB". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
