import { parse, parseStaged, serialize, serializeChecked, StagedParse, warmStrokeLines, type ParseFailure, type ParseResult } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { buildEntry, fullWriteGapMs, inspectJournal, journalKey, splitLines, type JournalStore } from "./journal";

/** File access for one notebook. Implemented over the Vault API in vault-io.ts and by fakes in tests. */
export interface DocumentIO {
	read(): Promise<string>;
	/** Atomic read-modify-write: `fn` receives the current content and returns the new one. */
	process(fn: (current: string) => string): Promise<void>;
	/** Keeps a copy of `content`. Returns the backup path, or null if an identical backup already exists. */
	backup(content: string, reason: BackupReason): Promise<string | null>;
	/** Current vault path of the file (follows renames). Part of the journal's file identity. */
	path?(): string;
}

export type BackupReason =
	| "unreadable" | "future-version" | "conflict" | "unsaved" | "journal" | "before-restore" | "before-move" | "before-api"
	/** v7: the file opened, but invalid details were dropped on read; the next save writes it without them. */
	| "dropped-details";

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
	/**
	 * Staged load (#329): a large notebook can be shown before it is fully read. `doc` has the page asked for in full and
	 * stand-ins (right size, no ink) for the others. It is for DISPLAY ONLY: it is not `session.doc`, nothing can be
	 * edited or saved, and `onLoaded` follows when every page has been read and validated (or reports the failure).
	 */
	onPartial?(doc: NotebookDocument): void;
	/** Staged load: these pages (0-based) were read in full just now. */
	onPartialProgress?(pages: number[]): void;
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
	/** Name of this session's journal files; unique among the sessions open at the same time. */
	journalOwner?: string;
	/**
	 * Timed work (debounced and max-wait saves, journal entries) waits until the pen has been up
	 * this long after a gesture (gestureEnded()), so serializing never delays the next stroke's
	 * first samples. Default 350 ms.
	 */
	quietMs?: number;
	/** ...but never longer than this after it was first due (default 4 s)... */
	maxQuietDeferMs?: number;
	/** ...and while busy() (pen down) at most this long (default 8 s): a very long gesture cannot hold back saving forever. */
	maxBusyDeferMs?: number;
	/**
	 * The journal entry is small and cheap, the save is not, so it waits much less (default 120 ms of pen-up gap):
	 * during continuous writing it lands in the first short gap instead of seconds later.
	 */
	journalQuietMs?: number;
	/** Journal: longest wait after a gesture (default 1 s)... */
	journalMaxQuietDeferMs?: number;
	/** ...and while the pen is down (default 1.5 s): bounds how much ink a kill without a visibility change can lose. */
	journalMaxBusyDeferMs?: number;
	/**
	 * Runs a function in a new task, after queued input and painting (staged load slices). `first` is the first slice,
	 * which should wait until the page just announced has been painted. Default: a 0 ms timer.
	 */
	yieldTask?: (fn: () => void, first: boolean) => void;
	/**
	 * v7: called just before a changed revision is serialized for the first time (by the journal or by the save),
	 * never for a revision that is not being written anyway. The view stores the reading position here, so it
	 * travels with content saves only and never causes a write of its own. Errors are ignored.
	 */
	beforeSerialize?: (doc: NotebookDocument) => void;
}

/** The stroke-line warm-up waits this long after a load, so the page is painted first. */
export const WARM_UP_DELAY_MS = 400;

/** Staged load: pages are read in slices of about this many ms, with the event loop free in between (input, painting). */
export const STAGED_SLICE_MS = 10;

/** `load` options. */
export interface LoadOptions {
	/** Read a large notebook in stages (see `SessionEvents.onPartial`); `page` (1-based) is read first. */
	staged?: boolean;
	page?: number | null;
}

let ownerCounter = 0;
/** A short unique id for a session's journal files (letters and digits only). */
function newOwnerId(): string {
	ownerCounter++;
	return `${Date.now().toString(36)}${ownerCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** How often deferred timed work checks again, ms. */
const DEFER_POLL_MS = 100;
/** The journal looks for a pen-up gap more often, so a short gap between strokes is not missed. */
const JOURNAL_POLL_MS = 40;

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
	/** Staged load in progress: the document being read, for display only. Never saved. Null otherwise. */
	partialDoc: NotebookDocument | null = null;
	/** The staged load must stop at its next slice (the session is closing). */
	private stagedAborted = false;
	problem: string | null = null;
	problemReason: ParseFailure | null = null;

	private revision = 0;
	private savedRevision = 0;
	/** Last content read from or written to disk by this session. */
	private diskContent: string | null = null;
	/** Last content this session itself wrote, and the one being written right now (see isOwnWrite). */
	private lastWritten: string | null = null;
	private writing: string | null = null;
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
	/** Name of this session's journal files. */
	private readonly journalOwner: string;
	/** Journal keys (file identity at the time) under which this session has written files. */
	private readonly ownedKeys = new Set<string>();
	/** Files of earlier sessions whose content was recovered here: deleted once a save covers it. */
	private inherited: Array<{ key: string; owner: string }> = [];
	/** Revision whose text was last serialized for the journal (its modifiedAt is reused by the save). */
	private journaledRevision = -1;
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
	private readonly beforeSerialize: ((doc: NotebookDocument) => void) | null;
	private readonly quietMs: number;
	private readonly maxQuietDeferMs: number;
	private readonly maxBusyDeferMs: number;
	private readonly journalQuietMs: number;
	private readonly journalMaxQuietDeferMs: number;
	private readonly journalMaxBusyDeferMs: number;
	private readonly yieldTask: (fn: () => void, first: boolean) => void;
	/** Revision a flush is currently serializing and writing, or null: the journal must not touch that document meanwhile. */
	private flushingRevision: number | null = null;
	/** When the last gesture ended (ms since epoch), or -Infinity. */
	private lastGestureEnd = -Infinity;
	/** When the deferred save / journal entry first became due, or null (separate clocks). */
	private flushDeferredSince: number | null = null;
	private journalDeferredSince: number | null = null;
	/** Poll of a timed save that is waiting for the pen; the due time is kept while it runs. */
	private deferTimer: number | null = null;

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
		this.beforeSerialize = options.beforeSerialize ?? null;
		this.journal = options.journal ?? null;
		this.journalDelayMs = options.journalDelayMs ?? 200;
		this.journalOwner = options.journalOwner ?? newOwnerId();
		this.quietMs = options.quietMs ?? 350;
		this.maxQuietDeferMs = options.maxQuietDeferMs ?? 4000;
		this.maxBusyDeferMs = options.maxBusyDeferMs ?? 8000;
		this.journalQuietMs = options.journalQuietMs ?? 120;
		this.journalMaxQuietDeferMs = options.journalMaxQuietDeferMs ?? 1000;
		this.journalMaxBusyDeferMs = options.journalMaxBusyDeferMs ?? 1500;
		this.yieldTask = options.yieldTask ?? ((fn) => void this.timers.set(fn, 0));
	}

	/**
	 * Should timed work wait for the input to settle? True while a gesture is in progress or within
	 * `quietMs` after one, up to the caps; explicit flushes (flush(), flushForClose()) never wait.
	 */
	private deferForInput(kind: "flush" | "journal"): boolean {
		const now = this.now().getTime();
		const busy = this.busy();
		const isFlush = kind === "flush";
		const quiet = now - this.lastGestureEnd < (isFlush ? this.quietMs : this.journalQuietMs);
		const since = isFlush ? this.flushDeferredSince : this.journalDeferredSince;
		const cap = isFlush
			? (busy ? this.maxBusyDeferMs : this.maxQuietDeferMs)
			: (busy ? this.journalMaxBusyDeferMs : this.journalMaxQuietDeferMs);
		let defer = busy || quiet;
		if (defer && since !== null && now - since >= cap) defer = false;
		const next = defer ? (since ?? now) : null;
		if (kind === "flush") this.flushDeferredSince = next;
		else this.journalDeferredSince = next;
		return defer;
	}

	/**
	 * Debounced and max-wait saves: deferred while the pen is writing. The wait has its own poll
	 * timer and keeps its due time, so new strokes (markChanged) cannot push the save further back.
	 */
	private timedFlush(): void {
		if (this.disposed) return;
		if (this.deferForInput("flush")) {
			this.deferTimer ??= this.timers.set(() => {
				this.deferTimer = null;
				this.timedFlush();
			}, DEFER_POLL_MS);
			return;
		}
		void this.flush();
	}

	get dirty(): boolean {
		return this.revision !== this.savedRevision;
	}

	/**
	 * True when the document is editable and everything in it is on disk. Unlike flush()'s result (also true when a
	 * deleted, read-only or disposed session had nothing it could write), this says the file really holds the document.
	 */
	isSaved(): boolean {
		return this.mode === "ok" && !this.disposed && !this.dirty;
	}

	/**
	 * Whether `content` (document text found in the file) is what this session itself wrote: the echo of its own
	 * save, as opposed to a change made by sync, another device or another app. Content only read from disk
	 * (load, reload) is never "own".
	 */
	isOwnWrite(content: string): boolean {
		return content === this.lastWritten || content === this.writing;
	}

	load(options: LoadOptions = {}): Promise<void> {
		// Set here, not when the slices start: a close that comes while the file is still being read must not be forgotten.
		this.stagedAborted = false;
		return this.enqueue(async () => {
			const content = await this.io.read();
			await this.applyDiskContent(content, true, options);
		});
	}

	/** Call after every change to `doc`. */
	markChanged(): void {
		if (this.mode !== "ok" || this.disposed) return;
		this.revision++;
		this.events.onSaveState?.("pending");
		if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
		this.debounceTimer = this.timers.set(() => this.timedFlush(), this.debounceMs);
		if (this.maxWaitTimer === null) this.maxWaitTimer = this.timers.set(() => this.timedFlush(), this.maxWaitMs);
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
		// A staged load still reading pages has nothing to save: let it stop instead of waiting for it.
		this.stagedAborted = true;
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
		this.lastGestureEnd = this.now().getTime();
		if (!this.deferredExternal) return;
		this.deferredExternal = false;
		void this.handleExternalChange();
	}

	/** The file was deleted: never write it again, but keep unsaved changes as a backup. */
	async markDeleted(): Promise<void> {
		this.clearTimers();
		const hadUnsaved = this.mode === "ok" && this.dirty;
		this.mode = "deleted";
		const backedUp = hadUnsaved ? await this.backupUnsaved() : true;
		this.dispose();
		// The journal may hold the only copy of unsaved edits: delete it only when they are safe elsewhere.
		if (backedUp) this.enqueueJournal(() => this.removeJournal());
		await this.jchain;
	}

	/** Stops timers and callbacks. Call flushForClose() first if pending changes must be written. */
	dispose(): void {
		this.disposed = true;
		this.clearTimers();
		this.clearJournalTimer();
		// Files left behind (unsaved edits) become recoverable by the next session once queued I/O is done.
		const journal = this.journal;
		if (journal) void this.jchain.then(() => journal.release(this.journalOwner));
	}

	/** Is there a journal entry for this notebook (by document id and current path)? An unreadable journal counts as yes. */
	private async hasJournalFor(docId: string): Promise<boolean> {
		const journal = this.journal;
		if (!journal) return false;
		try {
			const files = await journal.read(journalKey(docId, this.io.path?.() ?? ""));
			return files.length > 0;
		} catch {
			return true;
		}
	}

	/**
	 * Reads the pages left in `staged` in time slices, announcing the partial document first and the pages as they
	 * are read. Resolves with the complete result, or null if the session was closed. `mode` stays "loading" and
	 * `doc` stays null throughout: nothing can be edited or saved from the partial document.
	 */
	private runStaged(staged: StagedParse): Promise<ParseResult | null> {
		this.partialDoc = staged.doc;
		return new Promise((resolve) => {
			const done = (r: ParseResult | null): void => {
				this.partialDoc = null;
				resolve(r);
			};
			// A view callback that throws must not leave the load hanging (the whole session queue waits behind it).
			const notify = (fn: () => void): void => {
				try {
					fn();
				} catch (e) {
					this.events.onError?.(`Showing the notebook while it loads failed: ${(e as Error).message}`);
				}
			};
			const tick = (): void => {
				if (this.disposed || this.stagedAborted) {
					done(null);
					return;
				}
				try {
					const r = staged.step(STAGED_SLICE_MS);
					if (!r.ok) {
						done(r.failure);
						return;
					}
					if (r.changed.length > 0) notify(() => this.events.onPartialProgress?.(r.changed));
					if (r.done) done(staged.result());
					else this.yieldTask(tick, false);
				} catch (e) {
					done({ ok: false, reason: "invalid", message: `unexpected error while reading the notebook: ${(e as Error).message}` });
				}
			};
			notify(() => this.events.onPartial?.(staged.doc));
			this.yieldTask(tick, true);
		});
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

	private async applyDiskContent(content: string, initialLoad = false, options: LoadOptions = {}): Promise<void> {
		if (this.disposed) return;
		// A file that could not be used until now (broken or read-only) is recovered like a first load: its
		// journal may hold edits made before the file was damaged or overwritten.
		const recover = initialLoad || this.mode !== "ok";
		this.diskContent = content;
		this.revision = 0;
		this.savedRevision = 0;
		this.journaledRevision = -1;
		let recoveredAt: string | null = null;
		let result: ParseResult;
		const parsed = initialLoad && options.staged && this.mode === "loading" ? parseStaged(content, options.page ?? null) : parse(content);
		if (parsed instanceof StagedParse) {
			// Edits left in the journal are merged into the complete document, so those loads are not staged.
			const staged = (await this.hasJournalFor(parsed.doc.id)) ? null : parsed;
			if (this.disposed || this.stagedAborted) return;
			const finished = staged ? await this.runStaged(staged) : parsed.finish();
			if (finished === null) return; // the session was closed meanwhile
			result = finished;
		} else {
			result = parsed;
		}
		if (result.ok) {
			let doc = result.doc;
			if (result.dropped) await this.backupDropped(content);
			if (this.disposed) return;
			if (this.journal) {
				if (recover) {
					const recovered = await this.recoverFromJournal(content, doc);
					if (this.disposed) return;
					if (recovered) {
						doc = recovered.doc;
						recoveredAt = recovered.savedAt;
					}
				} else {
					// The file was reloaded with no local changes: whatever this session journaled is obsolete.
					this.enqueueJournal(() => this.removeJournal());
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
				this.debounceTimer = this.timers.set(() => this.timedFlush(), this.debounceMs);
				this.maxWaitTimer = this.timers.set(() => this.timedFlush(), this.maxWaitMs);
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

	/** The `beforeSerialize` hook; a failing hook never stops a save. */
	private runBeforeSerialize(doc: NotebookDocument): void {
		if (!this.beforeSerialize) return;
		try {
			this.beforeSerialize(doc);
		} catch (e) {
			console.error("[notebook] beforeSerialize failed", e);
		}
	}

	private async doFlush(): Promise<boolean> {
		if (this.mode !== "ok" || !this.doc || !this.dirty) return true;
		const revision = this.revision;
		// The journal stays out of this revision until the save is done: writing it would change doc.modifiedAt
		// after the save serialized, and a crash before the cleanup would turn a "merged" entry into a stale one.
		this.flushingRevision = revision;
		try {
			return await this.flushRevision(this.doc, revision);
		} finally {
			this.flushingRevision = null;
		}
	}

	private async flushRevision(doc: NotebookDocument, revision: number): Promise<boolean> {
		this.events.onSaveState?.("saving");

		const previousModifiedAt = doc.modifiedAt;
		// If the journal already serialized this revision, keep its modifiedAt: the saved text is then identical
		// to the journal entry's result, so a crash between the save and the cleanup is recognised as "merged".
		if (this.journaledRevision !== revision) {
			this.runBeforeSerialize(doc);
			doc.modifiedAt = this.now().toISOString();
		}
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
				// Known before the write lands, so the `modify` event it fires is recognised as ours.
				this.writing = next;
				try {
					await this.io.process((latest) => {
						if (latest !== current) {
							// Changed again since our read: leave it as is, back it up on the next attempt.
							raced = true;
							return latest;
						}
						return next;
					});
				} finally {
					this.writing = null;
				}
				written = !raced;
				if (written) this.lastWritten = next;
			}
			if (!written) throw new Error("the file keeps changing on disk");
			this.diskContent = next;
			this.savedRevision = Math.max(this.savedRevision, revision);
			this.afterSave();
		} catch (e) {
			this.events.onSaveState?.("error");
			this.events.onError?.(`Save failed: ${(e as Error).message}. Retrying.`);
			// A journal entry skipped during this attempt is still needed while the save keeps failing.
			if (this.dirty && this.journaledRevision !== this.revision) this.scheduleJournal(this.journalDelayMs);
			if (!this.disposed) this.debounceTimer = this.timers.set(() => void this.flush(), this.retryMs);
			return false;
		}

		if (this.dirty) {
			if (!this.disposed) this.debounceTimer = this.timers.set(() => this.timedFlush(), this.debounceMs);
			this.events.onSaveState?.("pending");
		} else {
			this.events.onSaveState?.("saved");
		}
		return true;
	}

	/** The file now holds our changes: the journal is obsolete, or must be rebased if newer changes exist. */
	private afterSave(): void {
		if (!this.journal) return;
		this.baseLinesFor = null;
		this.enqueueJournal(async () => {
			// Whatever an earlier session left and this session recovered is in the file now.
			await this.removeInherited();
			if (this.dirty) await this.writeJournal();
			else await this.removeJournal();
		});
	}

	private scheduleJournal(delayMs: number): void {
		if (!this.journal || this.journalSuspended || this.disposed || this.mode !== "ok" || this.journalTimer !== null) return;
		this.journalTimer = this.timers.set(() => {
			this.journalTimer = null;
			// Never serialize in the middle of a gesture or right after it (the next stroke may be starting).
			if (this.deferForInput("journal")) return this.scheduleJournal(JOURNAL_POLL_MS);
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
		// A save of this very revision is in flight: it covers these edits, and its success (or its failure
		// handler) decides what the journal does next.
		if (this.flushingRevision === this.revision) return;
		const nowMs = this.now().getTime();
		const wait = this.journalNextAt - nowMs;
		if (wait > 0) {
			this.scheduleJournal(wait);
			return;
		}
		// The entry carries the modifiedAt the next save will reuse (see doFlush), so that a crash between the
		// save and the cleanup leaves an entry whose result equals the file.
		const revision = this.revision;
		const previousModifiedAt = doc.modifiedAt;
		this.runBeforeSerialize(doc);
		doc.modifiedAt = this.now().toISOString();
		const checked = serializeChecked(doc);
		if (!checked.ok) {
			doc.modifiedAt = previousModifiedAt;
			return; // the regular save reports it
		}
		this.journaledRevision = revision;
		if (this.baseLinesFor !== base) {
			this.baseLines = splitLines(base);
			this.baseLinesFor = base;
		}
		const seq = Math.max(this.journalSeq + 1, nowMs);
		const path = this.io.path?.() ?? "";
		const key = journalKey(doc.id, path);
		const built = buildEntry(doc.id, seq, this.now().toISOString(), base, this.baseLines, checked.text, path);
		if (!built) return; // too big to journal: only the regular save protects it
		const slot: 0 | 1 = this.journalSlot === 0 ? 1 : 0;
		this.ownedKeys.add(key);
		await journal.write(key, this.journalOwner, slot, built.text);
		this.journalSeq = seq;
		this.journalSlot = slot;
		this.journalErrorShown = false;
		// Renamed since the last entry: the new key now holds a complete entry, so the old files can go.
		for (const old of [...this.ownedKeys]) {
			if (old === key) continue;
			await journal.remove(old, this.journalOwner);
			this.ownedKeys.delete(old);
		}
		if (built.full) this.journalNextAt = nowMs + fullWriteGapMs(checked.text.length);
	}

	/** Deletes the files this session wrote (under any key it has used). Never touches another session's files. */
	private async removeJournal(): Promise<void> {
		if (!this.journal || this.journalSuspended) return;
		for (const key of [...this.ownedKeys]) {
			await this.journal.remove(key, this.journalOwner);
			this.ownedKeys.delete(key);
		}
	}

	/** Deletes the files of earlier sessions that this session recovered and has now saved. */
	private async removeInherited(): Promise<void> {
		if (!this.journal || this.journalSuspended) return;
		while (this.inherited.length > 0) {
			const { key, owner } = this.inherited[0]!;
			await this.journal.remove(key, owner);
			this.inherited.shift();
		}
	}

	/**
	 * Looks for edits that were journaled but never saved. Returns the restored document, or null.
	 * A journal that cannot be applied is copied to the backup folder before it is deleted. Never throws.
	 */
	private async recoverFromJournal(diskText: string, diskDoc: NotebookDocument): Promise<{ doc: NotebookDocument; savedAt: string } | null> {
		const journal = this.journal;
		if (!journal) return null;
		try {
			const path = this.io.path?.() ?? "";
			const key = journalKey(diskDoc.id, path);
			const files = await journal.read(key);
			if (files.length === 0) return null;
			const found = inspectJournal(files, diskDoc.id, diskText, path);
			this.journalSeq = Math.max(this.journalSeq, found.maxSeq);
			const owners = [...new Set(files.map((f) => f.owner))];
			const removeAll = async () => {
				for (const owner of owners) await journal.remove(key, owner);
			};
			const r = found.recovery;
			if (r.kind === "none") return null;
			if (r.kind === "merged") {
				if (r.backupText !== undefined) {
					// A newer entry that did not fit: keep a copy first; if that fails the journal stays untouched.
					this.journalSuspended = true;
					await this.backupJournalCopy(r.backupText);
					this.journalSuspended = false;
				}
				await removeAll();
				return null;
			}
			if (r.kind === "apply") {
				const check = parse(r.text);
				if (!check.ok) return null;
				this.inherited = owners.map((owner) => ({ key, owner }));
				if (r.backupText !== undefined) {
					// A newer entry that did not fit: keep a copy. If that fails the files are never deleted (not inherited).
					try {
						await this.backupJournalCopy(r.backupText);
					} catch (e) {
						this.inherited = [];
						this.events.onError?.(`The instant save journal could not be backed up: ${(e as Error).message}`);
					}
				}
				return { doc: check.doc, savedAt: r.savedAt };
			}
			// Stale: keep a copy first, and delete the journal only if that worked.
			this.journalSuspended = true;
			await this.backupJournalCopy(r.backupText);
			this.journalSuspended = false;
			await removeAll();
			return null;
		} catch (e) {
			this.events.onError?.(`The instant save journal could not be read: ${(e as Error).message}`);
			return null;
		}
	}

	/** Copies journal text to the backup folder (throws if that fails). */
	private async backupJournalCopy(text: string): Promise<void> {
		const path = await this.io.backup(text, "journal");
		if (path && !this.disposed) this.events.onBackup?.(path, "journal");
	}

	/**
	 * v7: the file was read with invalid details left out (`ParseResult.dropped`): keep its text before a save
	 * rewrites it without them. Only invalid optional details are at stake, so a failed backup is reported
	 * and the notebook still opens.
	 */
	private async backupDropped(content: string): Promise<void> {
		try {
			const path = await this.io.backup(content, "dropped-details");
			if (path && !this.disposed) this.events.onBackup?.(path, "dropped-details");
		} catch (e) {
			this.events.onError?.(`Could not create a backup: ${(e as Error).message}`);
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

	/**
	 * Pre-computes stroke lines a page at a time in idle ticks, so the first save of a big notebook is quick.
	 * It starts a moment after the load (WARM_UP_DELAY_MS) so the first paint of the page comes first; a save
	 * that happens before it is done computes the lines it needs itself.
	 */
	private warmUp(doc: NotebookDocument): void {
		const pages = [...doc.pages];
		const step = () => {
			if (this.disposed || this.doc !== doc) return;
			const page = pages.shift();
			if (!page) return;
			warmStrokeLines(page.strokes);
			this.timers.set(step, 0);
		};
		this.timers.set(step, WARM_UP_DELAY_MS);
	}

	private clearTimers(): void {
		if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
		if (this.maxWaitTimer !== null) this.timers.clear(this.maxWaitTimer);
		if (this.deferTimer !== null) this.timers.clear(this.deferTimer);
		this.debounceTimer = null;
		this.maxWaitTimer = null;
		this.deferTimer = null;
		this.flushDeferredSince = null;
	}
}
