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

/** Text that does not parse and changed less than this long ago is taken as still being written (by the sync client). */
export const RECENT_WRITE_MS = 30_000;
/** Repair asks for a confirmation when the file changed less than this long ago: it may still be arriving. */
export const RECENT_CHANGE_MS = 3 * 60_000;

/**
 * Whether `text` is valid JSON up to its end but cut off before the end of the value (a download or a write that stopped
 * part-way): every token read is well formed and the text ends inside a value. Trailing whitespace is ignored. A complete
 * value, an empty text or a syntax error before the end give false.
 */
export function isTruncatedJson(text: string): boolean {
	const n = text.length;
	const stack: number[] = [];
	const OBJ = 1;
	const ARR = 2;
	type State = "value" | "valueOrEnd" | "key" | "keyOrEnd" | "colon" | "after";
	let state: State = "value";
	let i = 0;
	let seen = false;
	const ws = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
	/** Reads a string from the quote at `i`: the index after it, -1 when the text ends inside it, -2 on a bad string. */
	const str = (): number => {
		let j = i + 1;
		while (j < n) {
			const c = text.charCodeAt(j);
			if (c === 0x22) return j + 1;
			if (c < 0x20) return -2;
			if (c === 0x5c) {
				if (j + 1 >= n) return -1;
				const e = text[j + 1]!;
				if (e === "u") {
					const hex = text.slice(j + 2, j + 6);
					if (!/^[0-9a-fA-F]*$/.test(hex)) return -2;
					if (hex.length < 4) return -1;
					j += 6;
					continue;
				}
				if (!'"\\/bfnrt'.includes(e)) return -2;
				j += 2;
				continue;
			}
			j++;
		}
		return -1;
	};
	const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	const NUMBER_START = /-?\d*\.?\d*(?:[eE][+-]?\d*)?/y;
	for (;;) {
		while (i < n && ws(text.charCodeAt(i))) i++;
		if (i >= n) return seen && !(state === "after" && stack.length === 0);
		seen = true;
		const c = text[i]!;
		if (state === "after") {
			if (stack.length === 0) return false; // garbage after a complete value
			const top = stack[stack.length - 1];
			if (c === ",") {
				state = top === OBJ ? "key" : "value";
				i++;
			} else if ((c === "}" && top === OBJ) || (c === "]" && top === ARR)) {
				stack.pop();
				i++;
			} else return false;
			continue;
		}
		if (state === "colon") {
			if (c !== ":") return false;
			state = "value";
			i++;
			continue;
		}
		if (state === "key" || state === "keyOrEnd") {
			if (state === "keyOrEnd" && c === "}") {
				stack.pop();
				state = "after";
				i++;
				continue;
			}
			if (c !== '"') return false;
			const end = str();
			if (end === -1) return true;
			if (end < 0) return false;
			i = end;
			state = "colon";
			continue;
		}
		// state "value" or "valueOrEnd"
		if (state === "valueOrEnd" && c === "]") {
			stack.pop();
			state = "after";
			i++;
			continue;
		}
		if (c === "{" || c === "[") {
			stack.push(c === "{" ? OBJ : ARR);
			state = c === "{" ? "keyOrEnd" : "valueOrEnd";
			i++;
			continue;
		}
		if (c === '"') {
			const end = str();
			if (end === -1) return true;
			if (end < 0) return false;
			i = end;
			state = "after";
			continue;
		}
		if (c === "-" || (c >= "0" && c <= "9")) {
			NUMBER_START.lastIndex = i;
			const partial = NUMBER_START.exec(text);
			const partialEnd = i + (partial?.[0].length ?? 0);
			NUMBER.lastIndex = i;
			const full = NUMBER.exec(text);
			const fullEnd = full ? i + full[0].length : -1;
			// Cut inside a number ("72.", "1e", "-"): valid so far, the text ends there.
			if (partialEnd >= n && fullEnd < n) return true;
			if (fullEnd < 0) return false;
			i = fullEnd;
			state = "after";
			continue;
		}
		let matched = false;
		for (const word of ["true", "false", "null"]) {
			const rest = text.slice(i, i + word.length);
			if (rest === word) {
				i += word.length;
				state = "after";
				matched = true;
				break;
			}
			if (i + rest.length >= n && word.startsWith(rest)) return true;
		}
		if (!matched) return false;
	}
}

/** See `downloadState`. */
export type DownloadState = "empty" | "partial";

/**
 * #344: for document text that does not parse, whether it is still arriving from the sync client rather than damaged:
 * - `empty`: nothing yet (see `isAwaitingDownload`);
 * - `partial`: a NUL tail (space reserved by a download that has not got there yet), JSON cut off at the end, or, for a
 *   JSON syntax error only (`jsonError`), a file changed less than RECENT_WRITE_MS ago (`changedAgoMs`);
 * - null: damage (the caller treats it as an unreadable file).
 */
export function downloadState(text: string, options: { jsonError?: boolean; changedAgoMs?: number | null } = {}): DownloadState | null {
	if (isAwaitingDownload(text)) return "empty";
	if (text.endsWith("\0")) return "partial";
	if (options.jsonError === false) return null;
	if (isTruncatedJson(text)) return "partial";
	const ago = options.changedAgoMs;
	if (options.jsonError === true && ago !== null && ago !== undefined && ago >= 0 && ago < RECENT_WRITE_MS) return "partial";
	return null;
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
