/**
 * The Obsidian side of the library check (roadmap 27): the vault as a `CheckSource`, the report dialog and the confirmation
 * that lists the files before they are moved to the recoverable folder `<notebooks folder>/_trash/assets/`. The decisions
 * live in library/library-check.ts.
 */
import { Modal, normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { backupFolder, type NotebookSettings } from "../settings";
import { ensureFolder, sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { showErrorNotice, showNotice } from "../view/notice";
import {
	assetsDir, assetTrashDir, formatBytes, moveOrphans, runLibraryCheck, type AssetFile, type CheckConfig, type CheckSource,
	type LibraryCheckReport, type LiveReferences, type Mover, type RunOptions, type ScanCache,
} from "./library-check";
import { liveAssetIds, type JournalReader } from "./library-check-live";
import { LibraryCheckSeenStore } from "./library-check-seen";

/** Unchanged notebooks are not read again when the check is repeated (keyed by path, modification time and size). */
const sessionCache: ScanCache = new Map();

/** The vault as the check reads it. */
export function vaultCheckSource(app: App): CheckSource {
	return {
		files: () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
		read: async (path) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`"${path}" does not exist`);
			return app.vault.read(file);
		},
	};
}

/**
 * Files are moved with a plain rename to `<notebooks folder>/_trash/assets/`: they stay in the vault, so a sync service sees a
 * move and not a delete, and putting one back is a move back into `_assets/`. Deliberately not `vault.trash` or
 * `fileManager.trashFile`: both are deletions as far as the vault (and so the other devices) is concerned, and the second
 * follows the *Deleted files* setting, which can be "permanently delete". A plain rename rewrites no links.
 */
function vaultMover(app: App): Mover {
	return {
		move: async (from, to) => {
			const file = app.vault.getFileByPath(from);
			if (!file) throw new Error(`"${from}" does not exist`);
			await ensureFolder(app, to.slice(0, to.lastIndexOf("/")));
			await app.vault.rename(file, to);
		},
	};
}

/** What the check needs besides the vault: where the instant-save journal is, and what the open notebooks hold in memory. */
export interface LibraryCheckLive {
	/** The journal folder in the plugin's config folder. */
	journalFolder: string;
	/** For every open notebook view: its document, its undo and redo history and its pending media (NotebookView.libraryCheckRoots). */
	openRoots(): readonly unknown[];
}

function journalReader(app: App): JournalReader {
	const adapter = app.vault.adapter;
	return {
		exists: (path) => adapter.exists(path),
		list: async (folder) => (await adapter.list(folder)).files,
		read: (path) => adapter.read(path),
	};
}

function configFor(settings: NotebookSettings): CheckConfig {
	const root = normalizePath(settings.folder || "/");
	return { root: root === "/" ? "" : root, backup: normalizePath(backupFolder(settings)), now: Date.now() };
}

const breathe = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** What the check is given besides the vault: the open notebooks and the journal, and this device's record of first sightings. */
function checkOptions(app: App, settings: () => NotebookSettings, live: LibraryCheckLive): Pick<RunOptions, "cache" | "live" | "seen"> {
	return {
		cache: sessionCache,
		live: (): Promise<LiveReferences> => liveAssetIds(() => live.openRoots(), journalReader(app), live.journalFolder),
		seen: new LibraryCheckSeenStore(vaultDeviceFileAdapter(app), () => settings().folder, sidecarDeviceId(app)),
	};
}

/** Opens the library check. */
export function openLibraryCheck(app: App, settings: () => NotebookSettings, live: LibraryCheckLive): void {
	new LibraryCheckModal(app, settings, live).open();
}

class LibraryCheckModal extends Modal {
	private cancelled = false;
	private busy = false;
	private report: LibraryCheckReport | null = null;

	constructor(app: App, private readonly settings: () => NotebookSettings, private readonly live: LibraryCheckLive) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-libcheck-modal");
		this.setTitle(t("libcheck.title"));
		void this.run();
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}

	private async run(): Promise<void> {
		this.cancelled = false;
		const el = this.contentEl;
		el.empty();
		const status = el.createEl("p", { text: t("libcheck.checking", { done: "0", total: "…" }) });
		const config = configFor(this.settings());
		try {
			this.report = await runLibraryCheck(vaultCheckSource(this.app), config, {
				...checkOptions(this.app, this.settings, this.live),
				progress: (done, total) => status.setText(t("libcheck.checking", { done: String(done), total: String(total) })),
				cancelled: () => this.cancelled,
				breathe,
			});
		} catch (e) {
			console.error("[notebook] library check failed", e);
			if (!this.cancelled) {
				el.empty();
				el.createEl("p", { text: t("libcheck.failed", { error: e instanceof Error ? e.message : String(e) }) });
			}
			return;
		}
		if (!this.cancelled) this.render(this.report);
	}

	private section(title: string): HTMLElement {
		const box = this.contentEl.createDiv({ cls: "notebook-libcheck-section" });
		box.createEl("h4", { text: title });
		return box;
	}

	private render(r: LibraryCheckReport): void {
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { text: t("libcheck.summary", { n: String(r.notebooks), files: String(r.assets.count), size: formatBytes(r.assets.bytes) }) });

		// Notebooks that cannot be read: only listed.
		const bad = this.section(t("libcheck.unreadable.title", { n: String(r.unreadable.length) }));
		if (r.unreadable.length === 0) bad.createEl("p", { cls: "setting-item-description", text: t("libcheck.unreadable.none") });
		else {
			bad.createEl("p", { cls: "setting-item-description", text: t("libcheck.unreadable.note") });
			const list = bad.createDiv({ cls: "notebook-libcheck-list" });
			for (const u of r.unreadable) {
				const row = list.createDiv({ cls: "notebook-libcheck-row" });
				const text = row.createDiv({ cls: "notebook-libcheck-text" });
				text.createDiv({ cls: "notebook-libcheck-name", text: u.path });
				text.createDiv({ cls: "notebook-libcheck-detail", text: `${u.detail} · ${formatBytes(u.size)}` });
				row.createEl("button", { text: t("libcheck.open") }).addEventListener("click", () => {
					const file = this.app.vault.getFileByPath(u.path);
					if (!file) return;
					this.close();
					void openNotebookAtPage(this.app, file, null);
				});
			}
		}
		this.pathList(r.futureVersion, "libcheck.future.title", "libcheck.future.note");
		this.pathList(r.notDownloaded, "libcheck.notDownloaded.title", "libcheck.notDownloaded.note");

		// Unused files.
		const orphans = this.section(t("libcheck.orphans.title", { n: String(r.orphans.length), size: formatBytes(r.orphanBytes) }));
		if (!r.complete) {
			if (r.unavailable > 0) orphans.createEl("p", { cls: "setting-item-description", text: t("libcheck.incomplete", { n: String(r.unavailable) }) });
			if (r.openIncomplete) orphans.createEl("p", { cls: "setting-item-description", text: t("libcheck.openIncomplete") });
			if (r.unjudged.count > 0) orphans.createEl("p", { cls: "setting-item-description", text: t("libcheck.unjudged", { n: String(r.unjudged.count), size: formatBytes(r.unjudged.bytes) }) });
		} else if (r.orphans.length === 0) {
			orphans.createEl("p", { cls: "setting-item-description", text: t("libcheck.orphans.none") });
		} else {
			const root = configFor(this.settings()).root;
			orphans.createEl("p", { cls: "setting-item-description", text: t("libcheck.orphans.note", { folder: assetsDir(root), target: assetTrashDir(root) }) });
			const review = orphans.createEl("button", { cls: "mod-warning", text: t("libcheck.orphans.review") });
			review.addEventListener("click", () => this.review(r.orphans));
		}

		const facts = this.section(t("libcheck.facts"));
		const line = (key: Parameters<typeof t>[0], c: { count: number; bytes: number }) => {
			if (c.count > 0) facts.createEl("p", { cls: "setting-item-description", text: t(key, { n: String(c.count), size: formatBytes(c.bytes) }) });
		};
		line("libcheck.inUse", r.inUse);
		line("libcheck.kept", r.kept);
		line("libcheck.recent", r.recent);
		line("libcheck.waiting", r.waiting);

		const row = el.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: t("libcheck.again") }).addEventListener("click", () => void this.run());
		row.createEl("button", { cls: "mod-cta", text: t("libcheck.close") }).addEventListener("click", () => this.close());
	}

	private pathList(paths: readonly string[], title: Parameters<typeof t>[0], note: Parameters<typeof t>[0]): void {
		if (paths.length === 0) return;
		const box = this.section(t(title, { n: String(paths.length) }));
		box.createEl("p", { cls: "setting-item-description", text: t(note) });
		const ul = box.createEl("ul", { cls: "notebook-libcheck-paths" });
		for (const p of paths) ul.createEl("li", { text: p });
	}

	private review(orphans: readonly AssetFile[]): void {
		const root = configFor(this.settings()).root;
		new OrphanReviewModal(this.app, orphans, assetsDir(root), assetTrashDir(root), () => void this.moveToTrash(orphans)).open();
	}

	private async moveToTrash(confirmed: readonly AssetFile[]): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const result = await moveOrphans(vaultCheckSource(this.app), configFor(this.settings()), confirmed, vaultMover(this.app), {
				...checkOptions(this.app, this.settings, this.live),
				breathe,
			});
			if (result.incomplete) showNotice(t("libcheck.incompleteNow"));
			else {
				const bytes = result.moved.reduce((n, f) => n + f.size, 0);
				showNotice(t("libcheck.moved", { n: String(result.moved.length), size: formatBytes(bytes), target: result.folder }));
				if (result.skipped.length > 0) showNotice(t("libcheck.skipped", { n: String(result.skipped.length) }));
				if (result.failed.length > 0) showErrorNotice(t("libcheck.moveFailed", { n: String(result.failed.length), error: result.failed[0]!.error }));
			}
		} catch (e) {
			showErrorNotice(t("libcheck.failed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			this.busy = false;
		}
		if (this.modalEl.isConnected) await this.run();
	}
}

/** The confirmation: every file that would be moved is listed, with its size. Nothing happens before the button. */
class OrphanReviewModal extends Modal {
	constructor(
		app: App, private readonly files: readonly AssetFile[], private readonly source: string, private readonly target: string,
		private readonly confirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-libcheck-modal");
		this.setTitle(t("libcheck.confirm.title"));
		const el = this.contentEl;
		const bytes = this.files.reduce((n, f) => n + f.size, 0);
		el.createEl("p", { text: t("libcheck.confirm.body", { n: String(this.files.length), size: formatBytes(bytes), target: this.target, source: this.source }) });
		const list = el.createDiv({ cls: "notebook-libcheck-list" });
		for (const f of this.files) {
			const row = list.createDiv({ cls: "notebook-libcheck-row" });
			row.createDiv({ cls: "notebook-libcheck-name", text: f.path });
			row.createDiv({ cls: "notebook-libcheck-detail", text: formatBytes(f.size) });
		}
		const buttons = el.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: t("library.modal.cancel") }).addEventListener("click", () => this.close());
		const go = buttons.createEl("button", { cls: "mod-warning", text: t("libcheck.confirm.cta", { n: String(this.files.length) }) });
		go.disabled = this.files.length === 0;
		go.addEventListener("click", () => {
			this.close();
			this.confirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
