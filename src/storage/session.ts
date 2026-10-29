import { parse, serialize, serializeChecked, warmStrokeLines, type ParseFailure } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { buildEntry, fullWriteGapMs, inspectJournal, splitLines, type JournalStore } from "./journal";

/** File access for one notebook. Implemented over the Vault API in vault-io.ts and by fakes in tests. */
export interface DocumentIO {
	read(): Promise<string>;
	/** Atomic read-modify-write: `fn` receives the current content and returns the new one. */
	process(fn: (current: string) => string): Promise<void>;
	/** Keeps a copy of `content`. Returns the backup path, or null if an identical backup already exists. */
	backup(content: string, reason: BackupReason): Promise<string | null>;
}

export type BackupReason = "unreadable" | "future-version" | "conflict" | "unsaved" | "journal" | "before-restore";

/**
 * - `ok`: the document is editable and saved automatically.
 * - `readonly`: written by a newer format version; never written.
 * - `broken`: unreadable (invalid JSON or schema, empty); never written.
 * - `deleted`: the file was deleted; never written.
 */
export type SessionMode = "loading" | "ok" | "readonly" | "broken" | "deleted";

export type SaveState = "saved" | "pending" | "saving" | "error";

export interface SessionEvents {
	/** The document was (re)loaded: drop undo history and caches. */
	onLoaded?(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void;
	onSaveState?(state: SaveState): void;
	onBackup?(path: string, reason: BackupReason): void;
	/** The app died before the last save: edits found in the journal were restored and are being saved. */
	onRecovered?(info: { savedAt: string }): void;
	onError?(message: string): void;
}

/** Timer functions, injected so the view can use its window's timers and tests can use Node's. */
export interface Timers {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

export interface SessionOptions {
	debounceMs?: number;
	maxWaitMs?: number;
	retryMs?: number;
	now?: () => Date;
	/** True while the user is in the middle of a stroke or erase gesture that is not in `doc` yet. */
	busy?: () => boolean;
	/** Instant save journal (see journal.ts). Without it only the debounced save protects the edits. */
	journal?: JournalStore;
	/** Delay between a change and its journal entry. */
	journalDelayMs?: number;
}

/** Attempts per flush when another writer keeps changing the file between our read and our write. */
const RACE_ATTEMPTS = 3;
/** Flush attempts when the view closes, before falling back to an "unsaved" backup. */
const CLOSE_ATTEMPTS = 3;

/**
 * Lifecycle of an open notebook: load, change tracking, debounced save, flush and conflicts.
 *
 * Invariants:
 * - an unreadable (or newer-version, or deleted) file is never written;
 * - content found on disk that we did not write is backed up *before* it is overwritten;
 * - disk operations (flushes and external-change checks) run one at a time, in order.
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
	private debounceTimer: number | null = null;
	private maxWaitTimer: number | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	private disposed = false;
	/** An external change arrived during a gesture and was not looked at yet. */
	private deferredExternal = false;

	// Instant save journal. Its I/O runs on its own queue and can never fail a save.
	private readonly journal: JournalStore | null;
	private readonly journalDelayMs: number;
	private journalTimer: number | null = null;
	private jchain: Promise<unknown> = Promise.resolve();
	private journalSeq = 0;
	private journalSlot: 0 | 1 = 0;
	/** A journal file may exist for this notebook. */
	private journalOnDisk = false;
	private journalNextAt = 0;
	private journalErrorShown = false;
	/** A journal that could not be backed up is left untouched for the next open: no writes, no deletion. */
	private journalSuspended = false;
	private baseLinesFor: string | null = null;
	private baseLines: string[] = [];

	private readonly debounceMs: number;
	private readonly maxWaitMs: number;
	private readonly retryMs: number;
	private readonly now: () => Date;
	private readonly busy: () => boolean;

	constructor(
		private readonly io: DocumentIO,
		private readonly timers: Timers,
		private readonly events: SessionEvents = {},
		options: SessionOptions = {},
	) {
		this.debounceMs = options.debounceMs ?? 1500;
		this.maxWaitMs = options.maxWaitMs ?? 10000;
		this.retryMs = options.retryMs ?? 5000;
		this.now = options.now ?? (() => new Date());
		this.busy = options.busy ?? (() => false);
		this.journal = options.journal ?? null;
		this.journalDelayMs = options.journalDelayMs ?? 200;
	}

	get dirty(): boolean {
		return this.revision !== this.savedRevision;
	}

	load(): Promise<void> {
		return this.enqueue(async () => {
			const content = await this.io.read();
			await this.applyDiskContent(content, true);
		});
	}

	/** Call after every change to `doc`. */
	markChanged(): void {
		if (this.mode !== "ok" || this.disposed) return;
		this.revision++;
		this.events.onSaveState?.("pending");
		if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
		this.debounceTimer = this.timers.set(() => void this.flush(), this.debounceMs);
		if (this.maxWaitTimer === null) this.maxWaitTimer = this.timers.set(() => void this.flush(), this.maxWaitMs);
		this.scheduleJournal(this.journalDelayMs);
	}

	/** Writes pending changes now. Resolves to false if they could not be written. */
	flush(): Promise<boolean> {
		this.clearTimers();
		return this.enqueue(() => this.doFlush());
	}

	/**
	 * Flush for a closing view: retries a few times and, if the changes still cannot be written,
	 * keeps them as an "unsaved" backup. Resolves to true if nothing was left only in memory.
	 */
	async flushForClose(): Promise<boolean> {
		for (let i = 0; i < CLOSE_ATTEMPTS; i++) {
			await this.flush();
			if (this.mode !== "ok" || !this.dirty) {
				await this.jchain;
				return true;
			}
		}
		return this.backupUnsaved();
	}

	/** The file changed on disk (Sync, another device, another app). Runs after any flush in progress. */
	handleExternalChange(): Promise<"echo" | "reloaded" | "kept-local" | "ignored"> {
		return this.enqueue(async () => {
			if (this.disposed || this.mode === "loading" || this.mode === "deleted") return "ignored" as const;
			const content = await this.io.read();
			if (content === this.diskContent) return "echo" as const;
			// Local changes win; the next flush backs up the external version before overwriting it.
			if (this.mode === "ok" && this.busy()) {
				this.deferredExternal = true;
				return "kept-local" as const;
			}
			if (this.mode === "ok" && this.dirty) return "kept-local" as const;
			await this.applyDiskContent(content);
			return "reloaded" as const;
		});
	}

	/** Call when a gesture ends: re-checks an external change that arrived while it was in progress. */
	gestureEnded(): void {
		if (!this.deferredExternal) return;
		this.deferredExternal = false;
		void this.handleExternalChange();
	}

	/** The file was deleted: never write it again, but keep unsaved changes as a backup. */
	async markDeleted(): Promise<void> {
		this.clearTimers();
		const hadUnsaved = this.mode === "ok" && this.dirty;
		this.mode = "deleted";
		if (hadUnsaved) await this.backupUnsaved();
		this.dispose();
		const docId = this.doc?.id;
		if (docId) this.enqueueJournal(() => this.removeJournal(docId));
		await this.jchain;
	}

	/** Stops timers and callbacks. Call flushForClose() first if pending changes must be written. */
	dispose(): void {
		this.disposed = true;
		this.clearTimers();
		this.clearJournalTimer();
	}

	/** Resolves when the journal operations queued so far are done. For tests and orderly shutdown. */
	journalIdle(): Promise<void> {
		return this.jchain.then(() => undefined);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async applyDiskContent(content: string, initialLoad = false): Promise<void> {
		if (this.disposed) return;
		this.diskContent = content;
		this.revision = 0;
		this.savedRevision = 0;
		let recoveredAt: string | null = null;
		const result = parse(content);
		if (result.ok) {
			let doc = result.doc;
			if (this.journal) {
				if (initialLoad) {
					const recovered = await this.recoverFromJournal(content, doc);
					if (this.disposed) return;
					if (recovered) {
						doc = recovered.doc;
						recoveredAt = recovered.savedAt;
					}
				} else {
					// The file was reloaded with no local changes: whatever the journal holds is obsolete.
					const docId = doc.id;
					this.enqueueJournal(() => this.removeJournal(docId));
				}
			}
			this.doc = doc;
			this.mode = "ok";
			this.problem = null;
			this.problemReason = null;
			this.warmUp(doc);
			if (recoveredAt !== null) {
				// The restored edits are not in the file yet: the regular save writes them.
				this.revision = 1;
				this.debounceTimer = this.timers.set(() => void this.flush(), this.debounceMs);
				this.maxWaitTimer = this.timers.set(() => void this.flush(), this.maxWaitMs);
			}
		} else {
			this.doc = null;
			this.mode = result.reason === "future-version" ? "readonly" : "broken";
			this.problem = result.message;
			this.problemReason = result.reason;
			if (content.length > 0) {
				const reason: BackupReason = this.mode === "readonly" ? "future-version" : "unreadable";
				try {
					const path = await this.io.backup(content, reason);
					if (path && !this.disposed) this.events.onBackup?.(path, reason);
				} catch (e) {
					this.events.onError?.(`Could not create a backup: ${(e as Error).message}`);
				}
			}
		}
		if (this.disposed) return;
		this.events.onLoaded?.(this.doc, this.mode, this.problem);
		if (recoveredAt !== null) {
			this.events.onSaveState?.("pending");
			this.events.onRecovered?.({ savedAt: recoveredAt });
		} else {
			this.events.onSaveState?.("saved");
		}
	}

	private async doFlush(): Promise<boolean> {
		if (this.mode !== "ok" || !this.doc || !this.dirty) return true;
		const revision = this.revision;
		this.events.onSaveState?.("saving");

		const doc = this.doc;
		const previousModifiedAt = doc.modifiedAt;
		doc.modifiedAt = this.now().toISOString();
		const checked = serializeChecked(doc);
		if (!checked.ok) {
			doc.modifiedAt = previousModifiedAt;
			this.events.onSaveState?.("error");
			this.events.onError?.(`Save cancelled: the serialized document did not pass validation (${checked.message}). Changes are kept in memory.`);
			return false;
		}
		const next = checked.text;

		try {
			let written = false;
			for (let attempt = 0; attempt < RACE_ATTEMPTS && !written; attempt++) {
				const current = await this.io.read();
				// Someone else wrote the file: keep their version before replacing it.
				if (current !== this.diskContent && current.trim().length > 0) await this.backupConflict(current);
				// Deleted or disposed meanwhile: never touch the file again.
				if (this.mode !== "ok" || this.disposed) return true;
				let raced = false;
				await this.io.process((latest) => {
					if (latest !== current) {
						// Changed again since our read: leave it as is, back it up on the next attempt.
						raced = true;
						return latest;
					}
					return next;
				});
				written = !raced;
			}
			if (!written) throw new Error("the file keeps changing on disk");
			this.diskContent = next;
			this.savedRevision = Math.max(this.savedRevision, revision);
			this.afterSave();
		} catch (e) {
			this.events.onSaveState?.("error");
			this.events.onError?.(`Save failed: ${(e as Error).message}. Retrying.`);
			if (!this.disposed) this.debounceTimer = this.timers.set(() => void this.flush(), this.retryMs);
			return false;
		}

		if (this.dirty) {
			if (!this.disposed) this.debounceTimer = this.timers.set(() => void this.flush(), this.debounceMs);
			this.events.onSaveState?.("pending");
		} else {
			this.events.onSaveState?.("saved");
		}
		return true;
	}

	/** The file now holds our changes: the journal is obsolete, or must be rebased if newer changes exist. */
	private afterSave(): void {
		if (!this.journal) return;
		const docId = this.doc?.id;
		if (!docId) return;
		this.baseLinesFor = null;
		this.enqueueJournal(() => (this.dirty ? this.writeJournal() : this.removeJournal(docId)));
	}

	private scheduleJournal(delayMs: number): void {
		if (!this.journal || this.journalSuspended || this.disposed || this.mode !== "ok" || this.journalTimer !== null) return;
		this.journalTimer = this.timers.set(() => {
			this.journalTimer = null;
			// Never serialize in the middle of a gesture: the pen-up commit schedules the entry anyway.
			if (this.busy()) return this.scheduleJournal(100);
			this.enqueueJournal(() => this.writeJournal());
		}, delayMs);
	}

	private clearJournalTimer(): void {
		if (this.journalTimer !== null) this.timers.clear(this.journalTimer);
		this.journalTimer = null;
	}

	private enqueueJournal(task: () => Promise<void>): void {
		this.jchain = this.jchain.then(task).catch((e: unknown) => {
			if (!this.journalErrorShown && !this.disposed) {
				this.journalErrorShown = true;
				this.events.onError?.(`The instant save journal failed: ${(e as Error).message}. Regular saving continues.`);
			}
			// Try again later while there are still unsaved changes.
			if (this.dirty) this.scheduleJournal(this.retryMs);
		});
	}

	/** Records the current document in the journal. Runs on the journal queue. */
	private async writeJournal(): Promise<void> {
		const journal = this.journal;
		const doc = this.doc;
		const base = this.diskContent;
		if (!journal || this.journalSuspended || !doc || base === null || this.disposed || this.mode !== "ok" || !this.dirty) return;
		const nowMs = this.now().getTime();
		const wait = this.journalNextAt - nowMs;
		if (wait > 0) {
			this.scheduleJournal(wait);
			return;
		}
		const checked = serializeChecked(doc);
		if (!checked.ok) return; // the regular save reports it
		if (this.baseLinesFor !== base) {
			this.baseLines = splitLines(base);
			this.baseLinesFor = base;
		}
		const seq = Math.max(this.journalSeq + 1, nowMs);
		const built = buildEntry(doc.id, seq, this.now().toISOString(), base, this.baseLines, checked.text);
		if (!built) return; // too big to journal: only the regular save protects it
		const slot: 0 | 1 = this.journalSlot === 0 ? 1 : 0;
		this.journalOnDisk = true;
		await journal.write(doc.id, slot, built.text);
		this.journalSeq = seq;
		this.journalSlot = slot;
		this.journalErrorShown = false;
		if (built.full) this.journalNextAt = nowMs + fullWriteGapMs(checked.text.length);
	}

	private async removeJournal(docId: string): Promise<void> {
		if (!this.journal || this.journalSuspended || !this.journalOnDisk) return;
		await this.journal.remove(docId);
		this.journalOnDisk = false;
	}

	/**
	 * Looks for edits that were journaled but never saved. Returns the restored document, or null.
	 * A journal that cannot be applied is copied to the backup folder before it is deleted. Never throws.
	 */
	private async recoverFromJournal(diskText: string, diskDoc: NotebookDocument): Promise<{ doc: NotebookDocument; savedAt: string } | null> {
		const journal = this.journal;
		if (!journal) return null;
		try {
			const files = await journal.read(diskDoc.id);
			if (files.length === 0) return null;
			this.journalOnDisk = true;
			const found = inspectJournal(files, diskDoc.id, diskText);
			this.journalSeq = found.maxSeq;
			if (found.newestSlot !== null) this.journalSlot = found.newestSlot;
			const r = found.recovery;
			if (r.kind === "none") return null;
			if (r.kind === "merged") {
				await this.removeJournal(diskDoc.id);
				return null;
			}
			if (r.kind === "apply") {
				const check = parse(r.text);
				return check.ok ? { doc: check.doc, savedAt: r.savedAt } : null;
			}
			// Stale: keep a copy first, and delete the journal only if that worked.
			this.journalSuspended = true;
			const path = await this.io.backup(r.backupText, "journal");
			this.journalSuspended = false;
			if (path && !this.disposed) this.events.onBackup?.(path, "journal");
			await this.removeJournal(diskDoc.id);
			return null;
		} catch (e) {
			this.events.onError?.(`The instant save journal could not be read: ${(e as Error).message}`);
			return null;
		}
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

	private async backupUnsaved(): Promise<boolean> {
		if (!this.doc) return false;
		try {
			const path = await this.io.backup(serialize(this.doc), "unsaved");
			if (path) this.events.onBackup?.(path, "unsaved");
			return true;
		} catch (e) {
			this.events.onError?.(`Unsaved changes could not be written or backed up: ${(e as Error).message}`);
			return false;
		}
	}

	/** Pre-computes stroke lines a page at a time in idle ticks, so the first save of a big notebook is quick. */
	private warmUp(doc: NotebookDocument): void {
		const pages = [...doc.pages];
		const step = () => {
			if (this.disposed || this.doc !== doc) return;
			const page = pages.shift();
			if (!page) return;
			warmStrokeLines(page.strokes);
			this.timers.set(step, 0);
		};
		this.timers.set(step, 0);
	}

	private clearTimers(): void {
		if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
		if (this.maxWaitTimer !== null) this.timers.clear(this.maxWaitTimer);
		this.debounceTimer = null;
		this.maxWaitTimer = null;
	}
}
