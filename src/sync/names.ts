/**
 * Review W22 S10: the names the cloud sync can carry between devices. Pure: no `obsidian` import.
 *
 * One rule for both sides: a path is synced only when every segment is a name that Windows, Android storage, OneDrive and Obsidian
 * all accept (src/storage/sync-state.ts `segmentIssue`: no `"*:<>?|\` or control characters, no leading or trailing space, no
 * trailing dot, no reserved device name such as CON or NUL, at most 255 characters). Anything else is skipped with a note, on
 * either side: never written (it would fail on every run) and never taken for a deletion.
 */
import { segmentIssue } from "../storage/sync-state";

/** True when `name` (one path segment) can exist on every device. */
export function syncableName(name: string): boolean {
	return name !== "" && name !== "." && name !== ".." && segmentIssue(name) === null;
}

/** True when every segment of a "/"-separated vault path is syncable. */
export function syncablePath(path: string): boolean {
	return path !== "" && path.split("/").every(syncableName);
}

/**
 * The key under which two paths are "the same file" on a case-insensitive or normalising file system: Unicode NFC, lower case.
 * Two paths with one key are never both written (they would land on one file on Windows, macOS or Android).
 */
export function foldKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}
