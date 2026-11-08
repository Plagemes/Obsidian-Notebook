/**
 * 0.21 (roadmap #127): the scheduled zip backups, wired to Obsidian. The rules are in backup-logic.ts, one run in
 * backup-run.ts (both tested in Node); this file only supplies the vault, the timers, the notices and the per-device memory.
 *
 *  - While Obsidian is open the schedule is checked a little after start-up, every half hour, and when the app comes back to the
 *    foreground (a tablet is rarely left running). A backup is made only when `isDue` says so.
 *  - One run at a time: a second request while one runs does nothing (the manual one says so).
 *  - It waits for the pen to be off the screen, reads and zips in short slices, and shows one progress notice.
 *  - The time and result of the last run live on this device (Obsidian's local storage), not in the synced settings: each
 *    device decides for itself, and sees backups other devices made in the folder.
 *  - Every file it writes is announced to the shared-files record first, so the inbox never offers a backup.
 */
import { Platform, TFile, TFolder, normalizePath, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { formatBytes } from "./sync-state";
import { showErrorNotice, showNotice, type NoticeHandle } from "../view/notice";
import type { NotebookSettings } from "../settings";
import { whenIdle } from "./idle";
import { loadWritten, recordPluginWrite, writtenSet } from "./plugin-written";
import { ensureFolder } from "./vault-io";
import {
	BACKUP_MEMORY_KEY, isDue, nextDueAt, newestBackupAt, normaliseMemory, remember, type BackupMemory, type BackupResult, type FolderChild,
} from "./backup-logic";
import { runBackup, type BackupPorts } from "./backup-run";

/** First check this long after start-up (the vault is still indexing before that). */
const FIRST_CHECK_MS = 90_000;
/** Then every half hour. */
const CHECK_EVERY_MS = 30 * 60_000;
/**
 * Most the zip may hold in memory: a phone or tablet WebView has far less than a computer. The files and the finished archive
 * are in memory together (about twice the size), and Obsidian's mobile file bridge adds copies on top (review W21 D3).
 */
const MAX_BYTES_MOBILE = 64 * 1024 * 1024;
const MAX_BYTES_DESKTOP = 1024 * 1024 * 1024;
/** An old backup bigger than this is not read to check its marker, so it is never trashed. */
const MAX_VERIFY_BYTES = 512 * 1024 * 1024;
/** The progress notice is updated at most this often. */
const PROGRESS_EVERY_MS = 700;

export interface BackupServiceDeps {
	app: App;
	settings: () => NotebookSettings;
	/** Saves what the open notebooks hold unsaved (the views' own flush). */
	flush: () => Promise<unknown>;
}

/** Local date and time as a short text, for the settings and the notices. */
export function whenText(at: number): string {
	try {
		return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	} catch {
		return new Date(at).toISOString();
	}
}

export class BackupService {
	private memory: BackupMemory;
	private busy = false;
	private stopped = false;
	private lastCheck = 0;
	private readonly listeners = new Set<() => void>();
	private progressText = "";

	constructor(private readonly d: BackupServiceDeps) {
		this.memory = this.loadMemory();
	}

	register(plugin: Plugin): void {
		plugin.register(() => this.stop());
		this.d.app.workspace.onLayoutReady(() => {
			plugin.registerInterval(window.setTimeout(() => void this.check(), FIRST_CHECK_MS));
			plugin.registerInterval(window.setInterval(() => void this.check(), CHECK_EVERY_MS));
		});
		plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && Date.now() - this.lastCheck > 5 * 60_000) void this.check();
		});
	}

	stop(): void {
		this.stopped = true;
		this.listeners.clear();
	}

	// ----------------------------------------------------------------------------------------------- what the settings show

	running(): boolean {
		return this.busy;
	}

	/** Calls `fn` whenever the status changes (a run starts, ends, or makes progress); returns the way to stop. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** The line under "Back up now": the last run's time and result, and when the next one is due. */
	statusText(): string {
		if (this.busy) return this.progressText || t("backup.status.running");
		const last = this.memory.last;
		let text: string;
		if (!last) text = t("backup.status.never");
		else if (last.outcome === "failed") text = t("backup.status.failed", { time: whenText(last.at), error: last.error || "?" });
		else if (last.files === 0) text = t("backup.status.empty", { time: whenText(last.at) });
		else if (last.outcome === "partial") text = t("backup.status.partial", { time: whenText(last.at), files: String(last.files), skipped: String(last.skipped), size: formatBytes(last.bytes) });
		else text = t("backup.status.ok", { time: whenText(last.at), files: String(last.files), size: formatBytes(last.bytes) });
		const s = this.d.settings();
		const next = nextDueAt(s.zipBackupSchedule, this.memory, newestBackupAt(this.folderNames()));
		if (next !== null) text += " " + (next <= Date.now() ? t("backup.status.dueNow") : t("backup.status.next", { time: whenText(next) }));
		return text;
	}

	// ----------------------------------------------------------------------------------------------------------- running

	/** The schedule's turn: runs a backup when one is due. */
	async check(): Promise<void> {
		this.lastCheck = Date.now();
		if (this.stopped || this.busy) return;
		const s = this.d.settings();
		if (!isDue(s.zipBackupSchedule, this.memory, newestBackupAt(this.folderNames()), Date.now())) return;
		await whenIdle(0, 10_000);
		if (this.stopped || this.busy) return;
		await this.run(false);
	}

	/** "Back up now" (the command and the settings button). */
	async backUpNow(): Promise<void> {
		if (this.busy) {
			showNotice(t("backup.already"));
			return;
		}
		await this.run(true);
	}

	private async run(manual: boolean): Promise<BackupResult | null> {
		if (this.busy || this.stopped) return null;
		this.busy = true;
		this.progressText = t("backup.status.running");
		this.emit();
		const notice: NoticeHandle = showNotice(t("backup.running"), 0);
		let lastTick = 0;
		const s = this.d.settings();
		// runBackup never throws: a failure is in the result.
		const result: BackupResult = await runBackup(
			{
				notebooksFolder: s.folder, folder: normalizePath(s.zipBackupFolder), keep: s.zipBackupKeep, maxBytes: Platform.isMobile ? MAX_BYTES_MOBILE : MAX_BYTES_DESKTOP,
				templatesFolder: s.templatesFolder, notebookTemplatesFolder: s.notebookTemplatesFolder,
			},
			this.ports((done, total) => {
				const now = Date.now();
				if (now - lastTick < PROGRESS_EVERY_MS) return;
				lastTick = now;
				this.progressText = t("backup.progress", { done: String(done), total: String(total) });
				notice.setMessage(this.progressText);
				this.emit();
			}),
		);
		notice.hide();
		this.busy = false;
		this.progressText = "";
		this.memory = remember(this.memory, result);
		this.saveMemory();
		this.emit();
		this.announce(result, manual);
		return result;
	}

	private announce(r: BackupResult, manual: boolean): void {
		if (r.outcome === "failed") {
			showErrorNotice(t("backup.failed", { error: r.error }), 12_000);
		} else if (r.files === 0) {
			if (manual) showNotice(t("backup.nothing"));
		} else if (r.outcome === "partial") {
			showErrorNotice(t("backup.donePartial", { name: r.name, skipped: String(r.skipped) }), 12_000);
		} else {
			showNotice(t("backup.done", { name: r.name, files: String(r.files), size: formatBytes(r.bytes) }), 6000);
		}
	}

	// -------------------------------------------------------------------------------------------------------------- ports

	private folderChildren(): FolderChild[] {
		const folder = this.d.app.vault.getFolderByPath(normalizePath(this.d.settings().zipBackupFolder));
		return (folder?.children ?? []).map((c) => ({ name: c.name, path: c.path, file: c instanceof TFile }));
	}

	private folderNames(): string[] {
		try {
			return this.folderChildren().filter((c) => c.file).map((c) => c.name);
		} catch {
			return [];
		}
	}

	private ports(progress: (done: number, total: number) => void): BackupPorts {
		const { app } = this.d;
		const { vault } = app;
		const file = (path: string): TFile => {
			const f = vault.getAbstractFileByPath(normalizePath(path));
			if (!(f instanceof TFile)) throw new Error(`"${path}" is not a file`);
			return f;
		};
		return {
			now: () => Date.now(),
			files: () => vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
			read: async (path) => new Uint8Array(await vault.readBinary(file(path))),
			stat: async (path) => {
				const st = await vault.adapter.stat(normalizePath(path));
				return st ? { size: st.size, mtime: st.mtime } : null;
			},
			readOld: async (path) => {
				const f = file(path);
				if (f.stat.size > MAX_VERIFY_BYTES) throw new Error("too big to check");
				return new Uint8Array(await vault.readBinary(f));
			},
			writtenByPlugin: (path) => writtenSet(loadWritten(app)).has(normalizePath(path).toLowerCase()),
			flush: async () => {
				await this.d.flush();
			},
			children: () => this.folderChildren(),
			ensureFolder: () => ensureFolder(app, this.d.settings().zipBackupFolder),
			exists: (path) => vault.getAbstractFileByPath(normalizePath(path)) !== null,
			write: async (path, bytes) => {
				const p = normalizePath(path);
				// Announced before the write: the vault's "create" event fires while the write is still pending.
				recordPluginWrite(app, [p, p.endsWith(".tmp") ? p.slice(0, -4) : p]);
				const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				await vault.createBinary(p, exact as ArrayBuffer);
			},
			sizeOf: async (path) => {
				const stat = await vault.adapter.stat(normalizePath(path));
				return stat ? stat.size : null;
			},
			rename: async (from, to) => {
				await app.fileManager.renameFile(file(from), normalizePath(to));
			},
			trash: async (path) => {
				const f = vault.getAbstractFileByPath(normalizePath(path));
				if (f instanceof TFolder) throw new Error("refusing to trash a folder");
				if (f instanceof TFile) await app.fileManager.trashFile(f);
			},
			breathe: () => new Promise<void>((resolve) => void window.setTimeout(resolve, 0)),
			progress,
			cancelled: () => this.stopped,
		};
	}

	// -------------------------------------------------------------------------------------------------------------- memory

	private loadMemory(): BackupMemory {
		try {
			return normaliseMemory(this.d.app.loadLocalStorage(BACKUP_MEMORY_KEY));
		} catch {
			return normaliseMemory(null);
		}
	}

	private saveMemory(): void {
		try {
			this.d.app.saveLocalStorage(BACKUP_MEMORY_KEY, this.memory);
		} catch (e) {
			console.error("[notebook] could not store the backup status", e);
		}
	}

	private emit(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] backup status listener failed", e);
			}
		}
	}
}
