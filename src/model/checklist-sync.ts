import { renamedPath } from "./checklist";
import type { CheckboxTask } from "./types";

/**
 * Keeping the task lines of linked checkboxes up to date (0.19, #103, v17): the bookkeeping of what was written and what is still
 * to be written, without 'obsidian' and without a DOM (the view gives it a way to write a line, to unlink a checkbox and to tell the
 * user; view/checklist-tools.ts). Ticks go from the notebook to the note only.
 *
 * A tick is noted the moment the document changes (`collect`), not when the delayed write runs, so it is never lost on the way: a
 * view that closes, a document that is reloaded or a note that is not there yet (the notebook synced before the note did) leaves the
 * entry in place and the write is retried, a few times, later. A note that is missing keeps the link; only a note that exists and
 * was read without the block id unlinks the checkbox.
 */

/** What a try to write a task line came to. */
export type SyncResult =
	/** The line now shows the wanted state (or already did). */
	| "ok"
	/** The note exists and was read, and no task line ends with the block id: the task was deleted from the note. */
	| "gone"
	/** The note is not in the vault (yet): nothing was written, the link stays. */
	| "missing"
	/** More than one task line ends with the block id: none was changed. */
	| "ambiguous";

/** Milliseconds to wait after the 1st, 2nd, ... failed try before the next one; its length is how many failed tries there are before giving up. */
export const RETRY_DELAYS = [4000, 15000, 60000, 300000] as const;

/** A linked checkbox as the sync sees it. */
export interface LinkedBox {
	id: string;
	checked: boolean;
	task: CheckboxTask;
}

export interface SyncSnapshot {
	docId: string;
	/** The checkboxes that have a task link, in any order. */
	boxes: readonly LinkedBox[];
}

/** A tick that is to be written into a task line. */
export interface SyncEntry {
	id: string;
	docId: string;
	task: CheckboxTask;
	want: boolean;
	/** Failed tries so far; at RETRY_DELAYS.length the entry is given up (until the checkbox is toggled again). */
	tries: number;
	/** Not before this time (ms), after a failed try. */
	notBefore: number;
}

export type SyncNotice = "gone" | "ambiguous" | "missing" | "failed";

export interface SyncDeps {
	/** The linked checkboxes of the open document, or null when none is open. */
	snapshot(): SyncSnapshot | null;
	/** Sets the tick of the task line. Resolves with what came of it; rejects when the note could not be read or written. */
	write(task: CheckboxTask, checked: boolean): Promise<SyncResult>;
	/** The line is gone: unlinks the checkbox. False when that is not possible now (a locked page, a read-only notebook, another document). */
	unlink(entry: SyncEntry): boolean;
	/** Tells the user. `detail`: the error message for "failed". */
	notify(kind: SyncNotice, entry: SyncEntry, detail?: string): void;
	/** Milliseconds; Date.now by default. */
	now?: () => number;
}

export class ChecklistSync {
	/** The tick last written to (or found in) the task line of each linked checkbox, by element id. */
	private readonly synced = new Map<string, boolean>();
	private readonly pending = new Map<string, SyncEntry>();
	private running = false;
	private again = false;

	constructor(private readonly deps: SyncDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/**
	 * A document was opened or reloaded: the ticks it holds are taken as already written, except those that a tick still waiting to
	 * be written (noted before the reload) agrees with, which stay to be written. Entries of another document stay too.
	 */
	baseline(snap: SyncSnapshot | null): void {
		const old = new Map(this.pending);
		this.synced.clear();
		this.pending.clear();
		for (const box of snap?.boxes ?? []) {
			const prev = old.get(box.id);
			if (prev && prev.docId === snap!.docId && prev.want === box.checked && prev.task.block === box.task.block) {
				this.synced.set(box.id, !box.checked);
				this.pending.set(box.id, prev);
			} else this.synced.set(box.id, box.checked);
		}
		for (const [id, entry] of old) if (entry.docId !== snap?.docId && !this.pending.has(id)) this.pending.set(id, entry);
	}

	/** The document changed: notes every tick that differs from what was written. Cheap and synchronous. */
	collect(): void {
		const snap = this.deps.snapshot();
		if (!snap) return;
		const seen = new Set<string>();
		for (const box of snap.boxes) {
			seen.add(box.id);
			const had = this.synced.get(box.id);
			if (had === undefined) {
				// Linked after the document was opened (a merge, an undo): what the line says is not known, so it is left alone.
				this.synced.set(box.id, box.checked);
				this.pending.delete(box.id);
				continue;
			}
			if (had === box.checked) {
				this.pending.delete(box.id);
				continue;
			}
			const prev = this.pending.get(box.id);
			if (prev && prev.want === box.checked && prev.task.block === box.task.block) continue;
			this.pending.set(box.id, { id: box.id, docId: snap.docId, task: { path: box.task.path, block: box.task.block }, want: box.checked, tries: 0, notBefore: 0 });
		}
		// A checkbox that is gone from this document (deleted, unlinked) has nothing to write.
		for (const [id, entry] of this.pending) if (entry.docId === snap.docId && !seen.has(id)) this.pending.delete(id);
	}

	/** The checkbox was just linked to a task line written unticked (`checked` false), or its link was removed (null). */
	linked(id: string, checked: boolean | null): void {
		this.pending.delete(id);
		if (checked === null) this.synced.delete(id);
		else this.synced.set(id, checked);
	}

	/** A note was renamed: the entries that name it (or a note inside a renamed folder) follow. */
	renamed(oldPath: string, newPath: string): void {
		for (const entry of this.pending.values()) {
			const next = renamedPath(entry.task.path, oldPath, newPath);
			if (next !== null) entry.task = { path: next, block: entry.task.block };
		}
	}

	/** Ticks waiting to be written. */
	pendingCount(): number {
		return this.pending.size;
	}

	/** The entries still waiting (a copy). */
	entries(): SyncEntry[] {
		return [...this.pending.values()].map((e) => ({ ...e, task: { ...e.task } }));
	}

	/** Milliseconds until the first failed entry may be tried again; null when none will be. */
	nextRetryIn(): number | null {
		let soon: number | null = null;
		for (const e of this.pending.values()) {
			if (e.tries === 0 || e.tries >= RETRY_DELAYS.length) continue;
			const wait = Math.max(0, e.notBefore - this.now());
			if (soon === null || wait < soon) soon = wait;
		}
		return soon;
	}

	private fail(entry: SyncEntry): void {
		entry.tries++;
		entry.notBefore = this.now() + RETRY_DELAYS[Math.min(entry.tries, RETRY_DELAYS.length) - 1]!;
	}

	/**
	 * Writes the ticks that wait, one note at a time. Never throws. A call while another is running makes it go round once more
	 * (what changed meanwhile is picked up). `collect` runs first, so a tick noted but not yet collected is written too.
	 */
	async run(): Promise<void> {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			do {
				this.again = false;
				this.collect();
				for (const entry of [...this.pending.values()]) {
					if (this.pending.get(entry.id) !== entry || entry.tries >= RETRY_DELAYS.length || entry.notBefore > this.now()) continue;
					await this.attempt(entry);
				}
			} while (this.again);
		} catch (e) {
			console.error("[notebook] checklist sync", e);
		} finally {
			this.running = false;
		}
	}

	private async attempt(entry: SyncEntry): Promise<void> {
		let result: SyncResult;
		try {
			result = await this.deps.write(entry.task, entry.want);
		} catch (e) {
			const first = entry.tries === 0;
			this.fail(entry);
			if (first) this.deps.notify("failed", entry, e instanceof Error ? e.message : String(e));
			return;
		}
		if (result === "ok") {
			this.synced.set(entry.id, entry.want);
			if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
		} else if (result === "gone") {
			if (this.deps.unlink(entry)) {
				this.synced.delete(entry.id);
				if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
				this.deps.notify("gone", entry);
			} else this.fail(entry);
		} else if (result === "ambiguous") {
			entry.tries = RETRY_DELAYS.length;
			this.deps.notify("ambiguous", entry);
		} else {
			this.fail(entry);
			if (entry.tries >= RETRY_DELAYS.length) this.deps.notify("missing", entry);
		}
	}
}
