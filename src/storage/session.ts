import { parse, serialize, type ParseFailure } from "../model/serialize";
import type { NotebookDocument } from "../model/types";

/** File access for one notebook. Implemented over the Vault API in vault-io.ts and by fakes in tests. */
export interface DocumentIO {
	read(): Promise<string>;
	/** Atomic read-modify-write: `fn` receives the current content and returns the new one. */
	process(fn: (current: string) => string): Promise<void>;
	/** Keeps a copy of `content`. Returns the backup path, or null if an identical backup already exists. */
	backup(content: string, reason: BackupReason): Promise<string | null>;
}

export type BackupReason = "unreadable" | "future-version" | "conflict";

/**
 * - `ok`: the document is editable and saved automatically.
 * - `readonly`: written by a newer format version; never written.
 * - `broken`: unreadable (invalid JSON or schema, empty); never written.
 */
export type SessionMode = "loading" | "ok" | "readonly" | "broken";

export type SaveState = "saved" | "pending" | "saving" | "error";

export interface SessionEvents {
	/** The document was (re)loaded: drop undo history and caches. */
	onLoaded?(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void;
	onSaveState?(state: SaveState): void;
	onBackup?(path: string, reason: BackupReason): void;
	onError?(message: string): void;
}

export interface SessionOptions {
	debounceMs?: number;
	maxWaitMs?: number;
	retryMs?: number;
	now?: () => Date;
}

/**
 * Lifecycle of an open notebook: load, change tracking, debounced save, flush and conflicts.
 * Invariant: an unreadable file is never overwritten.
 */
export class DocumentSession {
	mode: SessionMode = "loading";
	doc: NotebookDocument | null = null;
	problem: string | null = null;
	problemReason: ParseFailure | null = null;

	private revision = 0;
	private savedRevision = 0;
	/** Last content read from or written to disk by this session. */
	private diskContent: string | null = null;
	/** Content of a write in progress, to recognise its echo. */
	private writing: string | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<boolean> = Promise.resolve(true);
	private disposed = false;

	private readonly debounceMs: number;
	private readonly maxWaitMs: number;
	private readonly retryMs: number;
	private readonly now: () => Date;

	constructor(private readonly io: DocumentIO, private readonly events: SessionEvents = {}, options: SessionOptions = {}) {
		this.debounceMs = options.debounceMs ?? 1500;
		this.maxWaitMs = options.maxWaitMs ?? 10000;
		this.retryMs = options.retryMs ?? 5000;
		this.now = options.now ?? (() => new Date());
	}

	get dirty(): boolean {
		return this.revision !== this.savedRevision;
	}

	async load(): Promise<void> {
		const content = await this.io.read();
		await this.applyDiskContent(content);
	}

	/** Call after every change to `doc`. */
	markChanged(): void {
		if (this.mode !== "ok" || this.disposed) return;
		this.revision++;
		this.events.onSaveState?.("pending");
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
		if (!this.maxWaitTimer) this.maxWaitTimer = setTimeout(() => void this.flush(), this.maxWaitMs);
	}

	/** Writes pending changes now. Flushes are serialised; resolves to false if the write did not happen. */
	flush(): Promise<boolean> {
		this.clearTimers();
		this.chain = this.chain.then(() => this.doFlush(), () => this.doFlush());
		return this.chain;
	}

	/** The file changed on disk (Sync, another device, another app). */
	async handleExternalChange(): Promise<"echo" | "reloaded" | "kept-local"> {
		if (this.mode === "loading" || this.disposed) return "echo";
		const content = await this.io.read();
		if (content === this.diskContent || content === this.writing) return "echo";
		// Local changes win; the external version is backed up by the next flush.
		if (this.mode === "ok" && this.dirty) return "kept-local";
		await this.applyDiskContent(content);
		return "reloaded";
	}

	/** Stops timers. Call flush() first if pending changes must be written. */
	dispose(): void {
		this.disposed = true;
		this.clearTimers();
	}

	private async applyDiskContent(content: string): Promise<void> {
		this.diskContent = content;
		this.revision = 0;
		this.savedRevision = 0;
		const result = parse(content);
		if (result.ok) {
			this.doc = result.doc;
			this.mode = "ok";
			this.problem = null;
			this.problemReason = null;
		} else {
			this.doc = null;
			this.mode = result.reason === "future-version" ? "readonly" : "broken";
			this.problem = result.message;
			this.problemReason = result.reason;
			if (content.length > 0) {
				const reason: BackupReason = this.mode === "readonly" ? "future-version" : "unreadable";
				try {
					const path = await this.io.backup(content, reason);
					if (path) this.events.onBackup?.(path, reason);
				} catch (e) {
					this.events.onError?.(`Could not create a backup: ${(e as Error).message}`);
				}
			}
		}
		this.events.onLoaded?.(this.doc, this.mode, this.problem);
		this.events.onSaveState?.("saved");
	}

	private async doFlush(): Promise<boolean> {
		if (this.mode !== "ok" || !this.doc || !this.dirty) return true;
		const revision = this.revision;
		this.events.onSaveState?.("saving");

		const doc = this.doc;
		const previousModifiedAt = doc.modifiedAt;
		doc.modifiedAt = this.now().toISOString();
		const next = serialize(doc);
		const check = parse(next);
		if (!check.ok || serialize(check.doc) !== next) {
			doc.modifiedAt = previousModifiedAt;
			this.events.onSaveState?.("error");
			this.events.onError?.(`Save cancelled: the serialized document did not pass validation (${check.ok ? "round-trip mismatch" : check.message}). Changes are kept in memory.`);
			return false;
		}

		try {
			// Back up an externally modified file *before* overwriting it.
			const current = await this.io.read();
			if (current !== this.diskContent && current.trim().length > 0) await this.backupConflict(current);

			let changedMeanwhile: string | null = null;
			this.writing = next;
			await this.io.process((latest) => {
				if (latest !== current && latest !== this.diskContent && latest.trim().length > 0) changedMeanwhile = latest;
				return next;
			});
			this.diskContent = next;
			this.savedRevision = Math.max(this.savedRevision, revision);
			if (changedMeanwhile !== null) await this.backupConflict(changedMeanwhile);
		} catch (e) {
			this.events.onSaveState?.("error");
			this.events.onError?.(`Save failed: ${(e as Error).message}. Retrying.`);
			if (!this.disposed) this.debounceTimer = setTimeout(() => void this.flush(), this.retryMs);
			return false;
		} finally {
			this.writing = null;
		}

		if (this.dirty) {
			if (!this.disposed) this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
			this.events.onSaveState?.("pending");
		} else {
			this.events.onSaveState?.("saved");
		}
		return true;
	}

	private async backupConflict(content: string): Promise<void> {
		try {
			const path = await this.io.backup(content, "conflict");
			if (path) this.events.onBackup?.(path, "conflict");
		} catch (e) {
			this.events.onError?.(`Could not back up the external version: ${(e as Error).message}`);
			throw e;
		}
	}

	private clearTimers(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
		this.debounceTimer = null;
		this.maxWaitTimer = null;
	}
}
