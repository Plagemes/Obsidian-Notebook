import { FuzzySuggestModal, Modal, normalizePath, Setting, TFile, type App, type FuzzyMatch, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { parse } from "../model/serialize";
import { backupFolder, type NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText, writeNotebookText } from "../storage/format";
import {
	checkRestoreTarget, extractDocId, formatSnapshotDate, shouldSnapshot, snapshotFileName, snapshotFolder,
	restoredText, snapshotsToPrune, sortSnapshots,
} from "../storage/history";
import {
	contentFingerprint, courseOf, decideLectureSnapshot, isLectureSnapshotName, lectureSnapshotFileName, lectureSnapshotsToPrune,
	LECTURE_LABELS_FILE, ordinarySnapshotNames, readLectureLabels, withLectureLabel, type LectureLabels,
} from "../storage/lecture-snapshot";
import { PathLock } from "../storage/path-lock";
import { ensureFolder, VaultDocumentIO } from "../storage/vault-io";
import { viewsOf } from "./open";
import { NotebookPickerModal } from "./picker";

import { showErrorNotice, showNotice } from "../view/notice";
import { createLectureFilter, renderSnapshotRow, snapshotLabel } from "../view/history-ui";

export interface HistoryHost {
	app: App;
	settings: NotebookSettings;
}

interface SnapshotItem {
	file: TFile;
	date: Date;
	/** 0.19: taken automatically at the end of a lecture. */
	lecture: boolean;
	/** Course recorded for a lecture snapshot, or null. */
	course: string | null;
}

/** Automatic snapshots of notebooks and the restore flow. */
export class HistoryService {
	/** When each notebook was last found up to date (ms), so a save does not re-read the file every time. */
	private readonly checked = new Map<string, number>();
	private readonly busy = new PathLock();

	constructor(private readonly host: HistoryHost) {}

	private get app(): App {
		return this.host.app;
	}

	private folderFor(docId: string): string {
		return normalizePath(snapshotFolder(backupFolder(this.host.settings), docId));
	}

	/** Snapshot files of a document, newest first. */
	private snapshotFiles(docId: string): Array<{ file: TFile; date: Date }> {
		const folder = this.app.vault.getFolderByPath(this.folderFor(docId));
		if (!folder) return [];
		const files = folder.children.filter((f): f is TFile => f instanceof TFile);
		const byName = new Map(files.map((f) => [f.name, f]));
		const out: Array<{ file: TFile; date: Date }> = [];
		for (const s of sortSnapshots(files.map((f) => f.name))) {
			const file = byName.get(s.name);
			if (file) out.push({ file, date: s.date });
		}
		return out;
	}

	/**
	 * Takes a snapshot of `file` if one is due: at most one per notebook per interval, only for
	 * content that parses, and not when it is identical to the latest snapshot. Never throws.
	 * Returns the snapshot path, or null when nothing was written.
	 *
	 * `settle` (instant start): the file is read at once, so the snapshot holds the content as it was when this
	 * was called, but parsing it (the expensive part, a second full parse of the notebook) waits until `settle`
	 * resolves, so it does not compete with the first paint of the notebook that was just opened.
	 */
	async maybeSnapshot(file: TFile, now = new Date(), settle?: () => Promise<void>): Promise<string | null> {
		const hours = this.host.settings.snapshotIntervalHours;
		if (!(hours > 0) || !isNotebookFile(file) || this.busy.has(file.path)) return null;
		const known = this.checked.get(file.path);
		if (known !== undefined && !shouldSnapshot(new Date(known), now, hours)) return null;
		const release = this.busy.acquire(file.path);
		try {
			const text = await this.app.vault.read(file);
			if (settle) await settle();
			const json = readNotebookText(file.extension, text);
			const parsed = parse(json);
			if (!parsed.ok) {
				// Only parseable content is worth keeping; look again after the interval.
				this.checked.set(file.path, now.getTime());
				return null;
			}
			// The interval rule looks at the ordinary snapshots only: a lecture snapshot never delays or stands in for one.
			const existing = this.snapshotFiles(parsed.doc.id).filter((s) => !isLectureSnapshotName(s.file.name));
			const latest = existing[0];
			if (latest && !shouldSnapshot(latest.date, now, hours)) {
				this.checked.set(file.path, latest.date.getTime());
				return null;
			}
			if (latest && (await this.app.vault.read(latest.file)) === json) {
				this.checked.set(file.path, now.getTime());
				return null;
			}
			const folder = this.folderFor(parsed.doc.id);
			const path = normalizePath(`${folder}/${snapshotFileName(now)}`);
			this.checked.set(file.path, now.getTime());
			if (this.app.vault.getAbstractFileByPath(path)) return null;
			await ensureFolder(this.app, folder);
			await this.app.vault.create(path, json);
			await this.prune(parsed.doc.id);
			return path;
		} catch (e) {
			console.error("[notebook] snapshot failed", file.path, e);
			return null;
		} finally {
			release();
		}
	}

	private async prune(docId: string): Promise<void> {
		const files = this.snapshotFiles(docId);
		// 0.19: the interval retention never touches lecture snapshots (they have their own count).
		const drop = new Set(snapshotsToPrune(ordinarySnapshotNames(files.map((f) => f.file.name)), this.host.settings.snapshotsToKeep));
		for (const { file } of files) {
			if (drop.has(file.name)) await this.app.fileManager.trashFile(file);
		}
	}

	// ------------------------------------------------------- lecture snapshots (0.19, roadmap 222)

	/**
	 * Takes the snapshot at the end of a lecture. The caller flushed the view first and says whether that saved everything
	 * (`saved`); the snapshot is made from the file on disk, never from the view's memory. Skipped when the setting is off,
	 * nothing was written, the file does not parse, or it holds what the newest snapshot already holds. It goes through the
	 * same folder as every snapshot; only this feature's own lecture snapshots beyond the setting are trashed (through the
	 * file manager). Never throws; returns the path or null.
	 */
	async lectureSnapshot(file: TFile, course: string, opts: { wrote: boolean; saved: boolean }, now = new Date()): Promise<string | null> {
		if (!this.host.settings.lectureSnapshots || !isNotebookFile(file)) return null;
		// A snapshot of the interval or another lecture end may be running on this file: wait for it, never drop the lecture one.
		const release = await this.busy.acquireWhenFree(file.path);
		try {
			const json = readNotebookText(file.extension, await this.app.vault.read(file));
			const parsed = parse(json);
			if (!parsed.ok) return null;
			const docId = parsed.doc.id;
			const all = this.snapshotFiles(docId);
			const newest = all[0];
			const name = lectureSnapshotFileName(now);
			const folder = this.folderFor(docId);
			const path = normalizePath(`${folder}/${name}`);
			const decision = decideLectureSnapshot({
				enabled: true, wrote: opts.wrote, saved: opts.saved, fingerprint: contentFingerprint(json),
				latestFingerprint: newest ? contentFingerprint(await this.app.vault.read(newest.file)) : null,
				nameTaken: this.app.vault.getAbstractFileByPath(path) !== null,
			});
			if (!decision.take) return null;
			await ensureFolder(this.app, folder);
			await this.app.vault.create(path, json);
			await this.pruneLecture(docId, name, course);
			return path;
		} catch (e) {
			console.error("[notebook] lecture snapshot failed", file.path, e);
			return null;
		} finally {
			release();
		}
	}

	/** Trashes this feature's snapshots beyond the setting and records the course of the new one (sidecar). */
	private async pruneLecture(docId: string, newName: string, course: string): Promise<void> {
		const files = this.snapshotFiles(docId);
		const names = files.map((f) => f.file.name);
		const drop = new Set(lectureSnapshotsToPrune(names, this.host.settings.lectureSnapshotsKeep));
		for (const { file } of files) {
			if (drop.has(file.name)) await this.app.fileManager.trashFile(file);
		}
		const remaining = names.filter((n) => !drop.has(n));
		const labelsPath = normalizePath(`${this.folderFor(docId)}/${LECTURE_LABELS_FILE}`);
		const existing = this.app.vault.getAbstractFileByPath(labelsPath);
		try {
			if (existing instanceof TFile) {
				const labels = readLectureLabels(await this.app.vault.read(existing));
				// Unreadable: left exactly as it is (the label falls back to the date).
				if (labels) await this.app.vault.modify(existing, JSON.stringify(withLectureLabel(labels, newName, course, remaining), null, 1));
			} else if (!existing) {
				await this.app.vault.create(labelsPath, JSON.stringify(withLectureLabel({}, newName, course, remaining), null, 1));
			}
		} catch (e) {
			console.error("[notebook] lecture snapshot label not saved", e);
		}
	}

	/** Course of each lecture snapshot of a document (empty when the sidecar is missing or unreadable). */
	private async lectureLabels(docId: string): Promise<LectureLabels | null> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folderFor(docId)}/${LECTURE_LABELS_FILE}`));
		if (!(f instanceof TFile)) return {};
		try {
			return readLectureLabels(await this.app.vault.read(f));
		} catch {
			return null;
		}
	}

	// ----------------------------------------------------------------- restore

	/** Command entry: the active notebook, or a picker. */
	start(): void {
		const active = this.app.workspace.getActiveFile();
		if (active && isNotebookFile(active)) {
			void this.chooseVersion(active);
			return;
		}
		new NotebookPickerModal(this.app, this.host.settings.folder, (file) => void this.chooseVersion(file)).open();
	}

	/** Lists the snapshots of `file` and restores the chosen one (public for the integrity check, wave 0.7). */
	async chooseVersion(file: TFile): Promise<void> {
		try {
			const docId = extractDocId(readNotebookText(file.extension, await this.app.vault.read(file)));
			if (!docId) {
				showNotice(t("history.noId"));
				return;
			}
			const found = this.snapshotFiles(docId);
			if (found.length === 0) {
				showNotice(t("history.empty"));
				return;
			}
			const labels = found.some((s) => isLectureSnapshotName(s.file.name)) ? await this.lectureLabels(docId) : {};
			const items: SnapshotItem[] = [];
			for (const { file: snap, date } of found) {
				// Names and sizes only: reading and parsing every copy would freeze a large notebook's list (the chosen one is checked on restore).
				items.push({ file: snap, date, lecture: isLectureSnapshotName(snap.name), course: courseOf(labels, snap.name) });
			}
			new SnapshotModal(this.app, items, (item) => {
				new ConfirmRestoreModal(this.app, item.date, () => void this.restore(file, item)).open();
			}).open();
		} catch (e) {
			showNotice(t("history.failed", { error: (e as Error).message }));
		}
	}

	/**
	 * Restores a snapshot. Safe order: a notebook open in a tab is saved and that tab is emptied
	 * first (so no editor can write over the restored text); then the current content is backed up
	 * ("before-restore"); then the snapshot is written; finally the tab is reopened.
	 */
	private async restore(file: TFile, item: SnapshotItem): Promise<void> {
		const when = formatSnapshotDate(item.date);
		const open = viewsOf(this.app, file);
		const states: Array<{ leaf: WorkspaceLeaf; state: ReturnType<WorkspaceLeaf["getViewState"]> }> = [];
		try {
			const snapshot = await this.app.vault.read(item.file);
			if (!parse(snapshot).ok) throw new Error(t("history.unreadable"));

			for (const { view } of open) {
				let saved = false;
				try {
					saved = await view.flushNow();
				} catch (e) {
					console.error("[notebook] flush before restore failed", e);
				}
				// Anything left only in memory would be lost when the tab is emptied: do not restore.
				if (!saved) {
					showErrorNotice(t("history.flushFailed"));
					return;
				}
			}

			// The file may have changed since the version was chosen (Sync, another leaf): it must still be this notebook.
			const check = checkRestoreTarget(readNotebookText(file.extension, await this.app.vault.read(file)), snapshot);
			if (check === "other-notebook") {
				showNotice(t("history.otherNotebook"));
				return;
			}
			if (check === "unreadable" && !(await confirmOverUnreadable(this.app, item.date))) return;
			for (const { leaf } of open) {
				states.push({ leaf, state: leaf.getViewState() });
				await leaf.setViewState({ type: "empty" });
			}

			const backup = await this.writeSnapshot(file, snapshot);
			showNotice(backup ? t("history.done", { date: when, backup }) : t("history.doneNoBackup", { date: when }), 8000);
		} catch (e) {
			console.error("[notebook] restore failed", e);
			showNotice(t("history.failed", { error: (e as Error).message }));
		} finally {
			for (const { leaf, state } of states) {
				try {
					await leaf.setViewState(state);
				} catch (e) {
					console.error("[notebook] could not reopen the notebook", e);
				}
			}
		}
	}

	/** Backs up the current content, then writes `snapshotJson` if the file still holds what was backed up. */
	private async writeSnapshot(file: TFile, snapshotJson: string): Promise<string | null> {
		const ext = file.extension;
		const io = new VaultDocumentIO(this.app, file, () => backupFolder(this.host.settings));
		// A new edit time: other devices see a restore, not a rollback of their own older version (review).
		const restored = restoredText(snapshotJson, new Date());
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await this.app.vault.read(file);
			const current = readNotebookText(ext, raw);
			let backup: string | null = null;
			if (current.trim().length > 0) backup = await io.backup(current, "before-restore");
			let stale = false;
			await this.app.vault.process(file, (now) => {
				if (now !== raw) {
					stale = true;
					return now;
				}
				return writeNotebookText(ext, restored, now);
			});
			if (!stale) return backup;
		}
		throw new Error(t("host.changedElsewhere"));
	}
}

class SnapshotModal extends FuzzySuggestModal<SnapshotItem> {
	/** 0.19: only the snapshots taken at the end of a lecture. */
	private onlyLecture = false;

	constructor(app: App, private readonly items: SnapshotItem[], private readonly onChoose: (item: SnapshotItem) => void) {
		super(app);
		this.setPlaceholder(t("history.placeholder"));
		this.emptyStateText = t("history.empty");
		if (items.some((i) => i.lecture)) {
			// The "Lecture snapshots" filter sits between the search box and the list.
			const bar = createLectureFilter((on) => {
				this.onlyLecture = on;
				this.emptyStateText = on ? t("history.filter.none") : t("history.empty");
				// Re-run the search so the list is built again with the filter.
				this.inputEl.dispatchEvent(new Event("input"));
			});
			this.inputEl.parentElement?.insertAdjacentElement("afterend", bar);
		}
	}

	getItems(): SnapshotItem[] {
		return this.onlyLecture ? this.items.filter((i) => i.lecture) : this.items;
	}

	getItemText(item: SnapshotItem): string {
		return snapshotLabel({ ...item, size: item.file.stat.size });
	}

	renderSuggestion(match: FuzzyMatch<SnapshotItem>, el: HTMLElement): void {
		renderSnapshotRow(el, { ...match.item, size: match.item.file.stat.size });
	}

	onChooseItem(item: SnapshotItem): void {
		this.onChoose(item);
	}
}

class ConfirmRestoreModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly date: Date,
		private readonly onConfirm: () => void,
		private readonly bodyKey: "history.confirm.body" | "history.confirm.unreadableBody" = "history.confirm.body",
		private readonly onCancel: () => void = () => undefined,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("history.confirm.title"));
		this.contentEl.createEl("p", { text: t(this.bodyKey, { date: formatSnapshotDate(this.date) }) });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("history.confirm.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("history.confirm.restore")).setCta().onClick(() => {
				this.confirmed = true;
				this.close();
				this.onConfirm();
			}));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

/** Asks for explicit confirmation to restore over a file that cannot be read. */
function confirmOverUnreadable(app: App, date: Date): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmRestoreModal(app, date, () => resolve(true), "history.confirm.unreadableBody", () => resolve(false)).open();
	});
}
