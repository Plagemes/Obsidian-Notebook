/**
 * Cloud sync provider contract (#126). Pure types: no `obsidian` import, so the
 * sync engine in `src/sync/` stays testable in Node with a fake provider.
 *
 * Ownership in wave 0.22: the sync-core agent owns the engine and may extend
 * this file only by ADDING optional members; the providers agent implements it
 * for Google Drive and OneDrive. Any other change goes through integration.
 */

/** Stable id of a provider implementation. */
export type ProviderId = "gdrive" | "onedrive";

/** One file (never a folder) under the sync root on the remote side. */
export interface RemoteEntry {
	/** Provider's own id of the file. */
	id: string;
	/** Path relative to the sync root, "/"-separated, no leading slash. */
	path: string;
	/** Size in bytes. */
	size: number;
	/** Last modification time on the remote, ms since 1970. */
	mtime: number;
	/** Opaque revision tag that changes on every content change (etag / version / headRevisionId). */
	rev: string;
	/** Content hash when the provider gives one (md5 for Drive, sha1/quickXor for OneDrive), lower-case hex or base64 as given; undefined if none. */
	hash?: string;
	/** Name of the hash algorithm of `hash` ("md5", "sha1", "quickXor", "sha256"). */
	hashAlg?: string;
}

/**
 * Review W22 S3: a revision another device wrote between the provider's check and its write, which the write replaced (Google
 * Drive has no conditional write). The engine keeps it as a conflicted copy, so nothing is overwritten silently.
 */
export interface DisplacedRevision {
	rev: string;
	/** The bytes; absent when the revision is above the caller's `maxBytes` (review round 2 R2-7: left in the version history). */
	data?: ArrayBuffer;
	size?: number;
}

/** What `upload` returns: the new entry, plus any revision the write replaced without being able to refuse it. */
export interface UploadedEntry extends RemoteEntry {
	displaced?: DisplacedRevision[];
	/**
	 * Review round 2 (R2-3): the write succeeded, but whether it replaced another device's version could not be checked (the
	 * revision list or a download failed). The engine reports it; the version stays in the provider's history.
	 */
	displacedUnknown?: boolean;
}

/** Limits of one upload call. */
export interface UploadLimits {
	/** Displaced revisions larger than this are not downloaded (0 or absent: no limit). */
	maxBytes?: number;
}

/** Result of a delta listing: everything that changed since `cursor`, or a full listing when `cursor` was undefined. */
export interface RemoteChanges {
	/**
	 * Files present or changed. A full listing returns every file under the root.
	 * Review W22: two files with one path (Google Drive allows it) are BOTH listed, whenever either appears, so the engine can keep
	 * both; a name the contract cannot carry (a "/" inside a Drive name) comes with "\" in its place, and the engine skips it.
	 */
	upserts: RemoteEntry[];
	/** Paths (relative to the root) of files deleted or moved away since the cursor. Empty on a full listing. */
	deletions: string[];
	/** Cursor to pass next time. */
	cursor: string;
	/** True when `upserts` is the complete listing (the engine then treats any known path not listed as deleted). */
	full: boolean;
}

/** Thrown by a provider when the remote revision is not the expected one (conditional upload refused). */
export class RemoteConflictError extends Error {
	constructor(readonly path: string, readonly currentRev?: string) {
		super(`Remote file changed: ${path}`);
		this.name = "RemoteConflictError";
	}
}

/** Thrown when the user must sign in again (token revoked or expired beyond refresh). */
export class AuthRequiredError extends Error {
	constructor(readonly provider: ProviderId) {
		super(`Sign-in required: ${provider}`);
		this.name = "AuthRequiredError";
	}
}

/** Thrown for a transient failure (network, 429, 5xx) after the provider's own retries; the engine retries later. */
export class TransientRemoteError extends Error {
	constructor(message: string, readonly retryAfterMs?: number) {
		super(message);
		this.name = "TransientRemoteError";
	}
}

/**
 * A signed-in provider bound to one sync root folder on the remote.
 * Every method may throw the three errors above; anything else is a bug.
 * Implementations must never delete permanently: `remove` moves to the remote trash/recycle bin.
 */
export interface CloudProvider {
	readonly id: ProviderId;
	/** Human-readable account label (e-mail or display name) for the settings UI. */
	account(): Promise<string>;
	/** Changes since `cursor` (or a full listing when undefined). Paginates internally. */
	changes(cursor: string | undefined, signal?: AbortSignal): Promise<RemoteChanges>;
	/** Downloads a file's bytes by remote id. */
	download(id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
	/**
	 * Creates or replaces the file at `path` (folders created as needed).
	 * With `ifRev`, replaces only if the remote revision still equals it, otherwise throws RemoteConflictError.
	 * With `ifRev === null`, creates only if no file exists at `path`, otherwise throws RemoteConflictError.
	 */
	upload(path: string, data: ArrayBuffer, ifRev: string | null | undefined, signal?: AbortSignal, limits?: UploadLimits): Promise<UploadedEntry>;
	/** Moves the file to the remote trash. With `ifRev`, only if unchanged (else RemoteConflictError). */
	remove(id: string, ifRev?: string, signal?: AbortSignal): Promise<void>;
}

/** Sign-in state a provider keeps on this device only (never synced, never in the vault). */
export interface StoredAuth {
	provider: ProviderId;
	/** User-supplied OAuth client id (the plugin ships none). */
	clientId: string;
	refreshToken: string;
	accessToken?: string;
	/** ms since 1970 when `accessToken` expires. */
	expiresAt?: number;
	/** Remote id of the chosen sync root folder. */
	rootId?: string;
	/** Display path of the root folder, for the UI. */
	rootLabel?: string;
}
