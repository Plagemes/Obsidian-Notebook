/**
 * 0.17 (#23): keeps an optional PDF copy next to each notebook (sharing, NotebookLM). The rules are in pdf-copy-logic.ts, the
 * record of what was written in pdf-copy-store.ts; this file does the vault work.
 *
 *  - Opt-in: `pdfCopy` (global, off) with a per-notebook choice from the notebook menu.
 *  - After the notebook was saved and left alone for a while (desktop), when its view closes, and when the app goes to the
 *    background (`pdfCopyWhen` "close" is the cheap mode, the default on phones and tablets). Never while the pen is on the screen.
 *  - Skipped when the content fingerprint did not change. The build yields to the interface between pages.
 *  - Only a PDF the plugin itself wrote, and that is still byte for byte what it wrote, is ever replaced.
 *  - A renamed or moved notebook takes its copy along; a deleted one leaves the copy where it is and it is no longer updated.
 *  - A copy the user deleted is not made again until the notebook is edited (an unchanged fingerprint builds nothing).
 *  - Changing the copy folder only decides where the next new copy goes; copies already written stay where they are.
 *  - The record file is checked before a PDF is written (a copy whose record cannot be kept would be written again at every
 *    build); if the record cannot be written after the PDF was, the copy is remembered for this session, so it is replaced
 *    and not duplicated. Unloading stops a running build before it writes.
 */
import { TFile, TFolder, normalizePath, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import type { Page, NotebookDocument } from "../model/types";
import { sha256Hex } from "../pdf/hash";
import { NotebookMedia } from "../view/media";
import { buildPdfBytes, type ExportOptions } from "../view/export";
import { showErrorNotice, showNotice } from "../view/notice";
import type { NotebookSettings } from "../settings";
import { whenIdle, nextTask } from "./idle";
import { isInTrash } from "./trash-paths";
import { NOTEBOOK_EXTENSIONS } from "./format";
import { recordPluginWrite } from "./plugin-written";
import { ensureFolder } from "./vault-io";
import {
	chooseTarget, clockText, copyBasePath, copyEnabled, fingerprintText, isOurs, KeyedTimers, looksLikePdf, moveCopyFile, moveOverrides, moveRecords,
	movedPath, pageText, PDF_COPY_IDLE_MS, renamedCopyPath, resolveWhen, statusOf, stopRecord, withNotebookChoice, type CopiesFile, type CopyRecord, type CopyStatus, type Occupant,
} from "./pdf-copy-logic";
import type { PdfCopyStore } from "./pdf-copy-store";

/** What the open view hands over: a notebook as it is now, ready to be exported. */
export interface PdfCopySource {
	file: TFile;
	doc: NotebookDocument;
	/** The pages as an export draws them (a snapshot of the list). */
	pages: readonly Page[];
	/** Export options without the view-only parts (no hidden ink, no equation typesetting). */
	options: ExportOptions;
	/** Changes whenever the notebook is edited: a build that sees it change throws its result away. */
	stamp(): number;
	/** The notebook has changes that are not saved yet. */
	unsaved(): boolean;
}

export type PdfCopySourceFn = () => PdfCopySource | null;

/** What a notebook view uses. */
export interface PdfCopyPort {
	/** The notebook was saved (idle mode: its copy follows after a quiet moment). */
	saved(path: string, source: PdfCopySourceFn): void;
	/** The view is closing; `source` is the notebook as it was last saved. */
	closing(path: string, source: PdfCopySource | null): void;
	/** The app went to the background with everything saved. */
	hidden(path: string, source: PdfCopySourceFn): void;
	enabled(path: string): boolean;
	setEnabled(path: string, on: boolean, source: PdfCopySourceFn): Promise<void>;
	status(path: string): CopyStatus;
	/** The status line of the notebook menu. */
	statusText(path: string): string;
}

interface Deps {
	app: App;
	settings: () => NotebookSettings;
	saveSettings: () => Promise<void>;
	store: PdfCopyStore;
	mobile: boolean;
}

const enc = new TextEncoder();
const pause = (): Promise<void> => new Promise((resolve) => nextTask(resolve));

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class PdfCopyService implements PdfCopyPort {
	private readonly timers = new KeyedTimers({ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) });
	private readonly running = new Set<string>();
	private readonly again = new Map<string, PdfCopySourceFn>();
	private readonly failures = new Map<string, string>();
	private readonly told = new Set<string>();
	/** Copies the service itself is renaming (their rename events are not someone else moving the file). */
	private readonly moving = new Set<string>();
	/** Copies written this session whose record is not in the store (yet): still ours, per notebook. */
	private readonly remembered = new Map<string, CopyRecord>();
	/** Notebooks whose last copy did not read back the same: no more copies this session (each build would make another "(copy N)"). */
	private readonly halted = new Set<string>();
	private loaded: Promise<unknown> | null = null;
	private stopped = false;

	constructor(private readonly d: Deps) {}

	register(plugin: Plugin): void {
		const { vault } = this.d.app;
		plugin.registerEvent(vault.on("rename", (file, oldPath) => void this.onRename(file.path, oldPath, file instanceof TFolder).catch((e) => console.error("[notebook] PDF copy rename", e))));
		plugin.registerEvent(vault.on("delete", (file) => void this.onDelete(file.path, file instanceof TFolder).catch((e) => console.error("[notebook] PDF copy delete", e))));
		plugin.register(() => this.stop());
		this.d.app.workspace.onLayoutReady(() => void this.ensureLoaded());
	}

	stop(): void {
		this.stopped = true;
		this.timers.clearAll();
		this.again.clear();
	}

	// ------------------------------------------------------------------------------------------------------ what views use

	enabled(path: string): boolean {
		return copyEnabled(this.d.settings(), path) && !isInTrash(path);
	}

	status(path: string): CopyStatus {
		return statusOf(this.enabled(path), this.d.store.records()[path], this.failures.get(path) ?? null);
	}

	/** Human text of the status line of the notebook menu. */
	statusText(path: string): string {
		const s = this.status(path);
		switch (s.kind) {
			case "updated": return t("pdfCopy.status.updated", { time: clockText(s.at) });
			case "stopped": return t("pdfCopy.status.stopped", { time: clockText(s.at) });
			case "waiting": return t("pdfCopy.status.waiting");
			case "failed": return t("pdfCopy.status.failed", { error: s.message });
			case "off": return t("pdfCopy.status.off");
		}
	}

	saved(path: string, source: PdfCopySourceFn): void {
		if (this.stopped || !this.enabled(path) || resolveWhen(this.d.settings().pdfCopyWhen, this.d.mobile) !== "idle") return;
		this.timers.schedule(path, PDF_COPY_IDLE_MS, () => {
			void whenIdle(0, 10_000).then(() => this.run(path, source));
		});
	}

	closing(path: string, source: PdfCopySource | null): void {
		this.timers.cancel(path);
		if (this.stopped || !source || !this.enabled(path)) return;
		void this.run(path, () => source);
	}

	hidden(path: string, source: PdfCopySourceFn): void {
		if (this.stopped || !this.enabled(path)) return;
		this.timers.cancel(path);
		void this.run(path, source);
	}

	async setEnabled(path: string, on: boolean, source: PdfCopySourceFn): Promise<void> {
		const s = this.d.settings();
		s.pdfCopyNotebooks = withNotebookChoice(s, path, on);
		await this.d.saveSettings();
		this.failures.delete(path);
		this.halted.delete(path);
		if (on) void this.run(path, source);
		else this.timers.cancel(path);
	}

	// -------------------------------------------------------------------------------------------------------------- build

	private ensureLoaded(): Promise<unknown> {
		return (this.loaded ??= this.d.store.load().catch((e) => {
			console.warn("[notebook] PDF copy records not read", e);
		}));
	}

	/** Hash of each page, one after the other with a pause between (a long notebook never holds the interface), then of the lot. */
	private async fingerprint(src: PdfCopySource, pages: readonly Page[]): Promise<string> {
		const hashes: string[] = [];
		for (const page of pages) {
			if (this.stopped) throw new Error("stopped");
			hashes.push((await sha256Hex(exactBuffer(enc.encode(pageText(page))))).slice(0, 32));
			await pause();
		}
		const headers = src.options.header ? JSON.stringify(pages.map((p) => src.options.header?.(p) ?? null)) : "";
		return sha256Hex(exactBuffer(enc.encode(fingerprintText(hashes, { title: src.file.basename, headers, pageCount: pages.length }))));
	}

	private async run(path: string, source: PdfCopySourceFn): Promise<void> {
		if (this.stopped || !this.enabled(path) || this.halted.has(path)) return;
		if (this.running.has(path)) {
			this.again.set(path, source);
			return;
		}
		this.running.add(path);
		try {
			await this.ensureLoaded();
			await this.build(path, source);
		} catch (e) {
			if (this.stopped) return; // unloaded while it ran: nothing to report
			const message = e instanceof Error ? e.message : String(e);
			console.error("[notebook] PDF copy failed", path, e);
			this.failures.set(path, message);
			if (!this.told.has(path)) {
				this.told.add(path);
				showErrorNotice(t("pdfCopy.failed", { name: path.slice(path.lastIndexOf("/") + 1), error: message }), 8000);
			}
		} finally {
			this.running.delete(path);
			const next = this.again.get(path);
			if (next && !this.stopped) {
				this.again.delete(path);
				// Asked again while it ran (an edit after a save, a close after the app went to the background): once more, soon.
				this.timers.schedule(path, 1000, () => void this.run(path, next));
			}
		}
	}

	private async build(path: string, source: PdfCopySourceFn): Promise<void> {
		const src = source();
		if (this.stopped || !src || src.file.path !== path) return;
		if (src.unsaved()) {
			this.saved(path, source); // not at rest yet: wait for the save
			return;
		}
		const stamp = src.stamp();
		const pages = [...src.pages];
		const fingerprint = await this.fingerprint(src, pages);
		const before = this.d.store.records()[path];
		if (before && !before.stopped && before.fingerprint === fingerprint) return; // unchanged
		if (before?.stopped) this.failures.delete(path);
		// The record file first: if it cannot take the record, no PDF is written (it would be written again at every build).
		await this.d.store.ensureWritable();

		const media = new NotebookMedia(this.d.app, () => src.doc, () => this.d.settings().folder, () => undefined);
		let bytes: Uint8Array;
		try {
			({ bytes } = await buildPdfBytes(src.file.basename, pages, media, src.options, pause));
		} finally {
			media.destroy();
		}
		if (!looksLikePdf(bytes)) throw new Error("the PDF was not complete");
		if (this.stopped) return;
		if (src.stamp() !== stamp || src.unsaved()) {
			// Edited while it was being built: this copy would not match the saved notebook. The next save builds it again.
			return;
		}

		const hash = await sha256Hex(exactBuffer(bytes));
		const lastWritten = this.remembered.get(path);
		const records = [...this.d.store.allRecords().filter((r) => r.notebook === path), ...(lastWritten ? [lastWritten] : [])];
		const recorded = lastWritten?.pdf ?? this.d.store.records()[path]?.pdf ?? null;
		const base = copyBasePath(path, this.d.settings().pdfCopyFolder);
		const target = await chooseTarget(base, recorded, (p) => this.occupant(p, records));
		if (!target) throw new Error(t("pdfCopy.noFreeName"));

		if (this.stopped) return;
		if (!(await this.write(path, target.path, target.overwrite, bytes, hash, records))) return;
		const record: CopyRecord = { notebook: path, pdf: target.path, hash, size: bytes.length, fingerprint, at: Date.now() };
		// Written: if its record cannot be kept, it is still ours for the rest of the session.
		this.remembered.set(path, record);
		await this.d.store.update((own) => ({ ...own, copies: { ...own.copies, [path]: record } }));
		this.remembered.delete(path);
		this.failures.delete(path);
		this.told.delete(path);
		if (target.diverted && !this.told.has(`diverted:${target.path}`)) {
			this.told.add(`diverted:${target.path}`);
			showNotice(t("pdfCopy.diverted", { name: base.slice(base.lastIndexOf("/") + 1), path: target.path }), 8000);
		}
	}

	/** What is at `path`: nothing, a file the records describe exactly (ours), or something else (never touched). */
	private async occupant(path: string, records: readonly CopyRecord[]): Promise<Occupant> {
		const at = this.d.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!at) return "none";
		if (!(at instanceof TFile) || !records.some((r) => r.pdf === path && r.size === at.stat.size)) return "foreign";
		const hash = await sha256Hex(await this.d.app.vault.readBinary(at));
		return isOurs(records, path, at.stat.size, hash) ? "ours" : "foreign";
	}

	/** Writes the copy. False: nothing was written because the file at `path` is not ours any more (the next build diverts). */
	private async write(notebook: string, path: string, overwrite: boolean, bytes: Uint8Array, hash: string, records: readonly CopyRecord[]): Promise<boolean> {
		const { vault } = this.d.app;
		const p = normalizePath(path);
		const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
		if (dir !== "") await ensureFolder(this.d.app, dir);
		if (this.stopped) return false;
		recordPluginWrite(this.d.app, [p]); // before the write: the shared-files inbox must not offer a file the plugin is writing
		if (overwrite) {
			const file = vault.getFileByPath(p);
			if (!file) throw new Error("the copy disappeared while it was being replaced");
			// Looked at again right before the replacement (the build took a while): a file the user changed meanwhile is theirs.
			if ((await this.occupant(path, records)) !== "ours" || this.stopped) return false;
			await vault.modifyBinary(file, exactBuffer(bytes));
		} else {
			await vault.createBinary(p, exactBuffer(bytes));
		}
		const back = vault.getFileByPath(p);
		const seen = back ? await sha256Hex(await vault.readBinary(back)) : null;
		if (!back || seen !== hash) {
			// What is there is not what was written: it is not remembered as ours (a file that cannot be vouched for is not replaced),
			// and no more copies are made for this notebook until the user turns the copy off and on: one notice, not a new
			// "(copy N)" at every build. The failure shows in the notebook's status line.
			this.halted.add(notebook);
			this.timers.cancel(notebook);
			this.again.delete(notebook);
			throw new Error("the copy was written but did not read back the same; no more copies are made for this notebook until the copy is turned off and on");
		}
		return true;
	}

	// ----------------------------------------------------------------------------------------------- follows the notebook

	private async onRename(newPath: string, oldPath: string, folder: boolean): Promise<void> {
		if (this.stopped || this.moving.has(oldPath)) return;
		await this.ensureLoaded();
		const isNotebook = !folder && NOTEBOOK_EXTENSIONS.some((e) => newPath.toLowerCase().endsWith(`.${e}`));
		const s = this.d.settings();

		if (isInTrash(newPath)) {
			// Into the library trash: the copy stays where it is and is no longer updated.
			await this.stopUnder(oldPath);
			return;
		}
		if (Object.keys(s.pdfCopyNotebooks).some((k) => movedPath(k, oldPath, newPath) !== null)) {
			s.pdfCopyNotebooks = moveOverrides(s.pdfCopyNotebooks, oldPath, newPath);
			await this.d.saveSettings();
		}
		for (const key of [...Object.keys(this.d.store.records()), oldPath]) if (movedPath(key, oldPath, newPath) !== null) this.timers.cancel(key);

		const merged = this.d.store.records();
		const affected = Object.values(merged).some((r) => movedPath(r.notebook, oldPath, newPath) !== null || movedPath(r.pdf, oldPath, newPath) !== null);
		if (!affected) return;

		// A notebook that was renamed or moved takes its copy along, if the copy is still the plugin's own.
		const moves = new Map<string, string>();
		if (isNotebook) {
			const rec = merged[oldPath];
			if (rec) {
				const target = renamedCopyPath(oldPath, newPath, rec.pdf, s.pdfCopyFolder);
				if (target && target !== rec.pdf && (await this.moveCopy(rec, target))) moves.set(rec.pdf, target);
			}
		}
		await this.d.store.update((own, all) => {
			let data: CopiesFile = own;
			// Records that only another device's file holds are taken over, so the move is written in this device's file.
			const copies = { ...data.copies };
			for (const [k, r] of Object.entries(all)) {
				if (copies[k] === undefined && (movedPath(r.notebook, oldPath, newPath) !== null || movedPath(r.pdf, oldPath, newPath) !== null)) copies[k] = r;
			}
			data = { ...data, copies };
			data = moveRecords(data, oldPath, newPath);
			data = moveCopyFile(data, oldPath, newPath);
			for (const [from, to] of moves) data = moveCopyFile(data, from, to);
			return data;
		});
	}

	/** Renames the copy file with the notebook. False: it was left alone (not ours any more, missing, or the new name is taken). */
	private async moveCopy(rec: CopyRecord, target: string): Promise<boolean> {
		const { vault, fileManager } = this.d.app;
		const file = vault.getFileByPath(normalizePath(rec.pdf));
		if (!file || vault.getAbstractFileByPath(normalizePath(target))) return false;
		if (file.stat.size !== rec.size || (await sha256Hex(await vault.readBinary(file))) !== rec.hash) return false;
		const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
		if (dir !== "") await ensureFolder(this.d.app, dir);
		this.moving.add(rec.pdf);
		try {
			await fileManager.renameFile(file, normalizePath(target));
			return true;
		} catch (e) {
			console.warn("[notebook] the PDF copy was not renamed", e);
			return false;
		} finally {
			window.setTimeout(() => this.moving.delete(rec.pdf), 1000);
		}
	}

	private async onDelete(path: string, folder: boolean): Promise<void> {
		if (this.stopped) return;
		await this.ensureLoaded();
		if (!folder && !NOTEBOOK_EXTENSIONS.some((e) => path.toLowerCase().endsWith(`.${e}`))) return;
		await this.stopUnder(path);
	}

	/** The notebook (or every notebook in the folder) is gone: its copy stays and is no longer updated. */
	private async stopUnder(path: string): Promise<void> {
		const keys = Object.keys(this.d.store.records()).filter((k) => movedPath(k, path, path) !== null);
		for (const k of [...keys, path]) {
			this.timers.cancel(k);
			this.again.delete(k);
		}
		if (keys.length === 0) return;
		await this.d.store.update((own, all) => {
			let data: CopiesFile = own;
			for (const k of keys) {
				if (data.copies[k] === undefined && all[k] !== undefined) data = { ...data, copies: { ...data.copies, [k]: all[k] } };
				data = stopRecord(data, k);
			}
			return data;
		});
	}
}
