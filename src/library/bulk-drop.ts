/**
 * Bulk import (0.16, roadmap #80): getting files into the library from outside the app, with a drop or the device's file
 * picker. DOM only (no 'obsidian'). The library's own card dragging (drag.ts) is pointer based and never carries `Files`,
 * so the two do not meet: this listens only to drags that carry files.
 */
import { DROP_ATTR, DROP_COLUMN_ATTR } from "./drag";
import type { BulkSource } from "./bulk-import-logic";

/** Most files taken from one drop (a dropped folder tree can be huge). */
export const MAX_DROPPED_FILES = 500;
/** How deep a dropped folder is searched. */
const MAX_DEPTH = 3;

/** A file (or Android content URI) as an import source: bytes are read only when asked for. */
export function fileSource(file: File): BulkSource {
	return {
		name: file.name,
		size: file.size,
		type: file.type,
		head: async () => {
			try {
				return new Uint8Array(await file.slice(0, 1024).arrayBuffer());
			} catch {
				return null;
			}
		},
		read: () => readWhole(file),
	};
}

/** Reads a file; falls back to FileReader (some Android content URIs reject `arrayBuffer`). */
function readWhole(file: File): Promise<ArrayBuffer> {
	return file.arrayBuffer().catch(() => new Promise<ArrayBuffer>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => (reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("unreadable")));
		reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
		reader.readAsArrayBuffer(file);
	}));
}

/** Whether a drag carries files (and not text, or a note dragged from Obsidian's own explorer). */
export function carriesFiles(dt: DataTransfer | null): boolean {
	return !!dt && Array.from(dt.types).includes("Files");
}

async function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
	return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

async function walk(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
	if (out.length >= MAX_DROPPED_FILES) return;
	if (entry.isFile) {
		const file = await entryFile(entry as FileSystemFileEntry);
		if (file) out.push(file);
		return;
	}
	if (!entry.isDirectory || depth >= MAX_DEPTH) return;
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	// readEntries returns the folder in batches until it gives an empty one.
	for (let guard = 0; guard < 50; guard++) {
		const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
		if (batch.length === 0) break;
		for (const child of batch) await walk(child, out, depth + 1);
	}
}

/**
 * The files of a drop. A dropped folder is searched (a few levels deep). The `DataTransfer` is only valid during the event,
 * so everything that needs it is read before the first `await`.
 */
export function filesFromDrop(dt: DataTransfer): Promise<File[]> {
	const plain = Array.from(dt.files);
	const entries: FileSystemEntry[] = [];
	try {
		for (const item of Array.from(dt.items)) {
			const entry = item.kind === "file" ? item.webkitGetAsEntry() : null;
			if (entry) entries.push(entry);
		}
	} catch {
		// No entry API: the plain file list is all there is.
	}
	if (!entries.some((e) => e.isDirectory)) return Promise.resolve(plain.slice(0, MAX_DROPPED_FILES));
	return (async () => {
		const out: File[] = [];
		for (const entry of entries) await walk(entry, out, 0);
		return out;
	})().catch(() => plain.slice(0, MAX_DROPPED_FILES));
}

/**
 * Opens the device file picker for several PDFs and images at once (a hidden `<input type=file multiple>`, which the
 * Android WebView supports). Resolves with no files when the picker is dismissed.
 */
export function pickManyFiles(): Promise<File[]> {
	return new Promise((resolve) => {
		const input = activeDocument.body.createEl("input", { type: "file", cls: "notebook-hidden", attr: { accept: "application/pdf,.pdf,image/*" } });
		input.multiple = true;
		let settled = false;
		const finish = (files: File[]) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
		// Some WebViews fire "cancel"; others never tell us. The input is removed on the next pick anyway.
		input.addEventListener("cancel", () => finish([]));
		input.click();
	});
}

/** Where a drop landed: a folder (tree row, folder card, breadcrumb), a Board column, or nowhere in particular. */
export interface FileDropTarget {
	folder: string | null;
	column: string | null;
}

export interface FileDropOptions {
	/** The element that shows the drop frame and label (default: the element itself). */
	mark?: HTMLElement;
	onFiles(files: File[], target: FileDropTarget): void;
	/** The label shown while files are dragged over `el` ("Drop to import into …"); `folder` is null over no folder in particular. */
	label?(target: FileDropTarget): string;
}

/** Makes `el` (and the folder rows, cards and Board columns inside it) accept files dropped from outside the app. */
export function attachFileDrop(el: HTMLElement, o: FileDropOptions): void {
	let hover: HTMLElement | null = null;
	const mark = o.mark ?? el;
	const resolve = (node: EventTarget | null): { target: FileDropTarget; where: HTMLElement | null } => {
		const from = node instanceof Element ? node : null;
		const column = from?.closest<HTMLElement>(`[${DROP_COLUMN_ATTR}]`) ?? null;
		const folder = from?.closest<HTMLElement>(`[${DROP_ATTR}]`) ?? null;
		// A folder row wins over the column it sits in; a column over the empty background.
		if (folder && el.contains(folder)) return { target: { folder: folder.getAttribute(DROP_ATTR), column: null }, where: folder };
		if (column && el.contains(column)) return { target: { folder: null, column: column.getAttribute(DROP_COLUMN_ATTR) }, where: column };
		return { target: { folder: null, column: null }, where: null };
	};
	const show = (where: HTMLElement | null, target: FileDropTarget) => {
		if (where !== hover) {
			hover?.removeClass("is-drop-target");
			hover = where;
			hover?.addClass("is-drop-target");
		}
		mark.addClass("is-file-drop");
		mark.dataset.dropLabel = o.label?.(target) ?? "";
	};
	const clear = () => {
		hover?.removeClass("is-drop-target");
		hover = null;
		mark.removeClass("is-file-drop");
		delete mark.dataset.dropLabel;
	};
	el.addEventListener("dragenter", (e) => {
		if (carriesFiles(e.dataTransfer)) e.preventDefault();
	});
	el.addEventListener("dragover", (e) => {
		if (!carriesFiles(e.dataTransfer)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		const { target, where } = resolve(e.target);
		show(where, target);
	});
	el.addEventListener("dragleave", (e) => {
		if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
		clear();
	});
	el.addEventListener("drop", (e) => {
		if (!e.dataTransfer || !carriesFiles(e.dataTransfer)) return;
		// Without this Obsidian would copy the files into the vault as attachments.
		e.preventDefault();
		e.stopPropagation();
		const { target } = resolve(e.target);
		clear();
		void filesFromDrop(e.dataTransfer).then((files) => {
			if (files.length > 0) o.onFiles(files, target);
		});
	});
}
