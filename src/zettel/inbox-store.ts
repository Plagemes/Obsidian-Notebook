/**
 * Processing flow (M15 Z4): the files of the Inbox state (`<notebooks folder>/_meta/inbox-<device>.json`, see
 * `inbox-state.ts`). No 'obsidian' import: the vault is reached through an adapter, so this is testable in Node.
 *
 * - Written only by `update`, which the explicit actions (discard, card, link, reopen) call; never by looking at the Inbox.
 * - Only the device's own file is ever written. `update` reads it again first (an older copy of it may have been synced
 *   in), applies the operations, serialises, re-validates the text and writes only if it differs.
 * - A file that cannot be read is never overwritten: one copy named by its content is kept next to it, and (for the
 *   device's own file) `update` refuses with `InboxBlockedError`. Other devices' unreadable files are skipped and reported.
 */
import { linksFolder } from "../storage/pdf-links-store";
import {
	applyInboxOp, deviceOfFileName, emptyInbox, inboxFileName, mergeInboxFiles, parseInbox, serializeInbox,
	type InboxEntry, type InboxFile, type InboxOp,
} from "./inbox-state";

export interface InboxFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Paths of the files directly inside `folder` (empty when it does not exist). */
	list(folder: string): Promise<string[]>;
}

export class InboxBlockedError extends Error {
	constructor(message: string, readonly reason: "json" | "format" | "future") {
		super(message);
		this.name = "InboxBlockedError";
	}
}

function textHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export class InboxStore {
	private queue: Promise<unknown> = Promise.resolve();
	private cache = new Map<string, InboxEntry>();
	/** Files of other devices (or this one) that could not be read at the last load. */
	unreadable: string[] = [];

	constructor(private readonly adapter: InboxFileAdapter, private readonly notebooksFolder: () => string, readonly device: string) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	get ownPath(): string {
		return `${this.folder}/${inboxFileName(this.device)}`;
	}

	/** The merged state as last read or written. */
	snapshot(): ReadonlyMap<string, InboxEntry> {
		return this.cache;
	}

	/** Reads every device's file and merges them. Nothing is written. */
	load(): Promise<ReadonlyMap<string, InboxEntry>> {
		return this.enqueue(() => this.readAll());
	}

	/** Applies operations to this device's file as it is now, writes it, and returns the merged state. */
	update(ops: InboxOp | InboxOp[]): Promise<ReadonlyMap<string, InboxEntry>> {
		const list = Array.isArray(ops) ? ops : [ops];
		return this.enqueue(async () => {
			const before = await this.readOwn();
			const after = list.reduce(applyInboxOp, before);
			const text = serializeInbox(after);
			if (text !== serializeInbox(before) || !(await this.adapter.exists(this.ownPath))) {
				const check = parseInbox(text, this.device);
				if (!check.ok) throw new Error(`inbox did not validate: ${check.message}`);
				await this.ensureFolder();
				await this.adapter.write(this.ownPath, text);
			}
			return this.readAll();
		});
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readOwn(): Promise<InboxFile> {
		if (!(await this.adapter.exists(this.ownPath))) return emptyInbox(this.device);
		const text = await this.adapter.read(this.ownPath);
		const parsed = parseInbox(text, this.device);
		if (!parsed.ok) {
			await this.keepCopy(text);
			throw new InboxBlockedError(parsed.message, parsed.reason);
		}
		return { ...parsed.data, device: this.device };
	}

	private async readAll(): Promise<ReadonlyMap<string, InboxEntry>> {
		const files: InboxFile[] = [];
		const bad: string[] = [];
		for (const path of await this.adapter.list(this.folder)) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			const device = deviceOfFileName(name);
			if (!device) continue;
			let text: string;
			try {
				text = await this.adapter.read(path);
			} catch {
				bad.push(path);
				continue;
			}
			const parsed = parseInbox(text, device);
			if (parsed.ok) files.push({ ...parsed.data, device });
			else bad.push(path); // looking never writes: the copy is kept only by `update`
		}
		this.unreadable = bad;
		this.cache = mergeInboxFiles(files);
		return this.cache;
	}

	/** One copy of an unreadable file, named by its content, so repeated failures do not pile up files. */
	private async keepCopy(text: string): Promise<void> {
		const copy = `${this.folder}/inbox.unreadable-${textHash(text)}.json`;
		try {
			if (!(await this.adapter.exists(copy))) await this.adapter.write(copy, text);
		} catch {
			/* the original is untouched either way */
		}
	}

	private async ensureFolder(): Promise<void> {
		let current = "";
		for (const part of this.folder.split("/").filter(Boolean)) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
		}
	}
}
