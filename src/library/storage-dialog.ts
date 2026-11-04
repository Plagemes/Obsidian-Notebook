/**
 * The Storage manager dialog (roadmap #128): what takes the space, and what can be cleaned up. Built on the modal shell
 * (ui/components/modal-shell.ts). The scan is library/storage-scan.ts (async, chunked, cancellable); what each button does is
 * library/storage-actions.ts. Nothing here changes a file: every action first shows what it will do and waits for the button.
 */
import { getLanguage, Modal, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import type { NotebookSettings } from "../settings";
import { filterChips } from "../ui/components/chip";
import { modalShell, shellButton, shellNote, setShellButtonLabel } from "../ui/components/modal-shell";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { showErrorNotice, showNotice } from "../view/notice";
import { assetTrashDir, formatBytes, moveOrphans, type AssetFile, type RunOptions } from "./library-check";
import { liveAssetIds } from "./library-check-live";
import { LibraryCheckSeenStore } from "./library-check-seen";
import { configFor, journalReader, vaultCheckSource, vaultMover } from "./library-check-modal";
import {
	downscaleHeavy, mergeDuplicates, trashConflictCopies, trashOldBackups, type StorageEnv,
} from "./storage-actions";
import { DOWNSCALE_MAX_EDGE } from "./storage-image-logic";
import {
	HEAVY_DEFAULT, newStorageCache, scanStorage, sortNotebooks, totalsParts,
	type DuplicateGroup, type HeavyImage, type JournalFile, type NotebookSort, type NotebookStorage, type StorageReport, type StorageSource,
} from "./storage-scan";
import type { ConflictCopy, OldBackup } from "../storage/storage-backups";
import { OLD_BACKUP_DAYS } from "../storage/storage-backups";

const SORT_KEY = "notebook-storage-sort";
const HEAVY_KEY = "notebook-storage-heavy";
const SORTS: readonly NotebookSort[] = ["size", "name", "assets", "backups"];
/** Sizes (MiB) the heavy-picture threshold can be set to. */
export const HEAVY_CHOICES: readonly number[] = [1, 2, 5, 10];
/** Rows a list shows before "Show all". */
const LIST_LIMIT = 25;

/** What the dialog needs from the plugin. */
export interface StorageDialogHost {
	app: App;
	settings(): NotebookSettings;
	/** The instant-save journal folder (config folder). */
	journalFolder: string;
	/** What every open notebook view holds in memory (NotebookView.libraryCheckRoots). */
	openRoots(): readonly unknown[];
	/** Moves a notebook to the library trash. */
	trashNotebook(file: TFile): Promise<unknown>;
	openNotebook(file: TFile): void;
}

/** Unchanged notebooks are not read again when the scan is repeated. */
const cache = newStorageCache();

function storageSource(app: App): StorageSource {
	return {
		...vaultCheckSource(app),
		readBinary: async (path) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`"${path}" does not exist`);
			return app.vault.readBinary(file);
		},
	};
}

async function journalFiles(app: App, folder: string): Promise<JournalFile[]> {
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) return [];
	const out: JournalFile[] = [];
	for (const path of (await adapter.list(folder)).files) {
		if (!path.endsWith(".journal")) continue;
		const stat = await adapter.stat(path);
		if (stat) out.push({ name: path.slice(path.lastIndexOf("/") + 1), size: stat.size });
	}
	return out;
}

const breathe = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

function readPref<T>(app: App, key: string, ok: (v: unknown) => v is T, fallback: T): T {
	try {
		const v: unknown = app.loadLocalStorage(key);
		return ok(v) ? v : fallback;
	} catch {
		return fallback;
	}
}

function writePref(app: App, key: string, value: unknown): void {
	try {
		app.saveLocalStorage(key, value);
	} catch {
		// Local storage can be unavailable; the choice is then just not remembered.
	}
}

export function openStorageManager(host: StorageDialogHost): void {
	new StorageDialog(host).open();
}

class StorageDialog extends Modal {
	private report: StorageReport | null = null;
	private alive = true;
	private scanning = false;
	private busy = false;
	private error: string | null = null;
	private sort: NotebookSort;
	private heavyMin: number;
	private readonly expanded = new Set<string>();
	/** Paths ticked in the lists; absent = not ticked. Rebuilt with every scan. */
	private readonly picked = new Set<string>();
	private body!: HTMLElement;
	private foot!: HTMLElement;

	constructor(private readonly host: StorageDialogHost) {
		super(host.app);
		this.sort = readPref(host.app, SORT_KEY, (v): v is NotebookSort => typeof v === "string" && (SORTS as readonly string[]).includes(v), "size");
		this.heavyMin = readPref(host.app, HEAVY_KEY, (v): v is number => typeof v === "number" && HEAVY_CHOICES.includes(v), HEAVY_DEFAULT / (1024 * 1024));
	}

	private get env(): StorageEnv {
		return { app: this.host.app, settings: () => this.host.settings(), trashNotebook: (f) => this.host.trashNotebook(f) };
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("storage.title"), subtitle: t("storage.subtitle"), icon: "hard-drive", size: "wide", cls: "nb-storage-modal" });
		this.body = shell.body;
		this.foot = shell.foot;
		void this.scan();
	}

	onClose(): void {
		this.alive = false;
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------ scanning

	private runOptions(): Pick<RunOptions, "live" | "seen" | "breathe"> {
		const app = this.host.app;
		return {
			live: () => liveAssetIds(() => this.host.openRoots(), journalReader(app), this.host.journalFolder),
			seen: new LibraryCheckSeenStore(vaultDeviceFileAdapter(app), () => this.host.settings().folder, sidecarDeviceId(app)),
			breathe,
		};
	}

	private async scan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		this.error = null;
		this.renderScanning(t("storage.scanning", { done: "0", total: "…" }));
		const settings = this.host.settings();
		try {
			const report = await scanStorage(storageSource(this.host.app), configFor(settings), {
				...this.runOptions(),
				cache,
				journals: () => journalFiles(this.host.app, this.host.journalFolder),
				keepSnapshots: settings.snapshotsToKeep,
				cancelled: () => !this.alive,
				progress: (phase, done, total) => this.renderScanning(t(phase === "notebooks" ? "storage.scanning" : phase === "images" ? "storage.scanning.images" : "storage.scanning.copies", { done: String(done), total: String(total) })),
			});
			if (!this.alive) return;
			this.report = report;
			this.picked.clear();
			if (!report.cancelled) {
				for (const o of report.check.orphans) this.picked.add(o.path);
				for (const b of report.oldBackups) if (!b.recovery) this.picked.add(b.path);
				for (const c of report.conflictsIdentical) if (!c.maybeManual) this.picked.add(c.path);
			}
		} catch (e) {
			console.error("[notebook] storage scan failed", e);
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.scanning = false;
		}
		if (this.alive) this.render();
	}

	private renderScanning(text: string): void {
		if (!this.alive) return;
		let line = this.body.querySelector<HTMLElement>(".nb-storage-progress-text");
		if (!line) {
			this.body.empty();
			this.foot.empty();
			this.modalEl.addClass("is-busy");
			const wrap = this.body.createDiv({ cls: "nb-storage-progress", attr: { role: "status" } });
			wrap.createDiv({ cls: "nb-storage-spinner", attr: { "aria-hidden": "true" } });
			line = wrap.createDiv({ cls: "nb-storage-progress-text" });
			shellButton(this.foot, "secondary", t("storage.cancel"), () => this.close());
		}
		line.setText(text);
	}

	// ------------------------------------------------------------------ drawing

	private render(): void {
		const body = this.body;
		body.empty();
		this.foot.empty();
		this.modalEl.toggleClass("is-busy", this.busy || this.scanning);
		const r = this.report;
		if (this.error !== null || !r) {
			shellNote(body, t("storage.failed", { error: this.error ?? "" }), "error");
		} else if (r.cancelled) {
			shellNote(body, t("storage.stopped"));
		} else {
			this.summary(body, r);
			this.notebooksSection(r);
			this.unusedSection(r);
			this.duplicatesSection(r);
			this.heavySection(r);
			this.backupsSection(r);
		}
		shellButton(this.foot, "secondary", t("storage.again"), () => void this.scan(), { icon: "refresh-cw", disabled: this.busy });
		shellButton(this.foot, "primary", t("storage.close"), () => this.close());
	}

	private section(id: string, title: string): { box: HTMLElement; head: HTMLElement } {
		const box = this.body.createDiv({ cls: "nb-storage-section", attr: { role: "group", "aria-label": title, "data-section": id } });
		const head = box.createDiv({ cls: "nb-storage-head" });
		head.createDiv({ cls: "nb-modal-section-title", text: title });
		return { box, head };
	}

	private summary(parent: HTMLElement, r: StorageReport): void {
		const box = parent.createDiv({ cls: "nb-storage-summary" });
		const top = box.createDiv({ cls: "nb-storage-total" });
		top.createDiv({ cls: "nb-storage-total-value", text: formatBytes(r.totals.bytes) });
		top.createDiv({ cls: "nb-storage-total-label", text: t("storage.total", { n: String(r.totals.notebooks.count) }) });
		const bar = box.createDiv({ cls: "nb-storage-bar", attr: { "aria-hidden": "true" } });
		const parts = totalsParts(r.totals);
		for (const p of parts) bar.createSpan({ cls: `nb-storage-seg is-${p.id}` }).setCssProps({ "--nb-w": `${Math.max(1, Math.round(p.share * 100))}%` });
		const legend = box.createDiv({ cls: "nb-storage-legend" });
		for (const p of parts) {
			const item = legend.createDiv({ cls: "nb-storage-key" });
			item.createSpan({ cls: `nb-storage-swatch is-${p.id}`, attr: { "aria-hidden": "true" } });
			item.createSpan({ text: `${t(`storage.cat.${p.id}`)} ${formatBytes(p.bytes)}` });
		}
	}

	private notebooksSection(r: StorageReport): void {
		const { box, head } = this.section("notebooks", t("storage.notebooks", { n: String(r.notebooks.length) }));
		if (r.notebooks.length === 0) {
			shellNote(box, t("storage.notebooks.none"));
			return;
		}
		const chips = head.createDiv({ cls: "nb-storage-sorts" });
		filterChips(chips, SORTS.map((id) => ({ id, label: t(`storage.sort.${id}`) })), this.sort, (id) => {
			this.sort = id;
			writePref(this.host.app, SORT_KEY, id);
			this.render();
		}, t("storage.sort"));
		const rows = sortNotebooks(r.notebooks, this.sort, getLanguage());
		const list = box.createDiv({ cls: "nb-storage-list" });
		for (const n of this.limited(rows, "notebooks")) this.notebookRow(list, n);
		this.moreButton(box, "notebooks", rows.length);
		if (r.notebooks.some((n) => n.sharedAssetBytes > 0)) shellNote(box, t("storage.notebooks.shared"));
	}

	private notebookRow(list: HTMLElement, n: NotebookStorage): void {
		const parts: string[] = [`${t("storage.part.file")} ${formatBytes(n.fileBytes)}`];
		if (n.ownAssetBytes + n.sharedShareBytes > 0) parts.push(`${t("storage.part.files")} ${formatBytes(n.ownAssetBytes + n.sharedShareBytes)}`);
		if (n.sharedAssetBytes > 0) parts.push(t("storage.part.shared", { size: formatBytes(n.sharedAssetBytes) }));
		if (n.backupBytes > 0) parts.push(`${t("storage.part.backups")} ${formatBytes(n.backupBytes)}`);
		if (n.journalBytes > 0) parts.push(`${t("storage.part.journal")} ${formatBytes(n.journalBytes)}`);
		const row = list.createEl("button", { cls: "nb-storage-row is-link", attr: { type: "button", "data-path": n.path, "data-bytes": String(n.totalBytes) } });
		const text = row.createDiv({ cls: "nb-storage-text" });
		text.createDiv({ cls: "nb-storage-name", text: n.name });
		text.createDiv({ cls: "nb-storage-detail", text: parts.join(" · ") });
		if (n.status !== "ok") text.createDiv({ cls: "nb-storage-tag", text: t(n.status === "unreadable" ? "storage.tag.unreadable" : n.status === "future-version" ? "storage.tag.future" : "storage.tag.notRead") });
		row.createDiv({ cls: "nb-storage-size", text: formatBytes(n.totalBytes) });
		row.addEventListener("click", () => {
			const file = this.host.app.vault.getFileByPath(n.path);
			if (!file) return;
			this.close();
			this.host.openNotebook(file);
		});
	}

	private unusedSection(r: StorageReport): void {
		const c = r.check;
		const { box } = this.section("unused", t("storage.unused"));
		if (!c.complete) {
			if (c.unavailable > 0) shellNote(box, t("libcheck.incomplete", { n: String(c.unavailable) }));
			if (c.openIncomplete) shellNote(box, t("libcheck.openIncomplete"));
			if (c.unjudged.count > 0) shellNote(box, t("libcheck.unjudged", { n: String(c.unjudged.count), size: formatBytes(c.unjudged.bytes) }));
			return;
		}
		if (c.orphans.length === 0) shellNote(box, t("storage.unused.none"));
		else {
			const root = configFor(this.host.settings()).root;
			shellNote(box, t("storage.unused.note", { target: assetTrashDir(root) }));
			const list = box.createDiv({ cls: "nb-storage-list" });
			for (const o of this.limited(c.orphans, "unused")) this.pickRow(list, o.path, o.path.slice(o.path.lastIndexOf("/") + 1), t("storage.unused.row"), o.size);
			this.moreButton(box, "unused", c.orphans.length);
			this.actionBar(box, c.orphans.map((o) => o.path), (n, size) => t("storage.unused.move", { n: String(n), size }), c.orphans.map((o) => o.size), () => void this.moveUnused(c.orphans));
		}
		if (c.recent.count > 0) shellNote(box, t("libcheck.recent", { n: String(c.recent.count), size: formatBytes(c.recent.bytes) }));
		if (c.kept.count > 0) shellNote(box, t("libcheck.kept", { n: String(c.kept.count), size: formatBytes(c.kept.bytes) }));
	}

	private duplicatesSection(r: StorageReport): void {
		const { box } = this.section("dup", t("storage.dup"));
		if (r.duplicates.length === 0) {
			shellNote(box, t("storage.dup.none"));
			return;
		}
		shellNote(box, t("storage.dup.note"));
		const list = box.createDiv({ cls: "nb-storage-list" });
		for (const g of this.limited(r.duplicates, "dup")) {
			const users = new Set(g.extras.flatMap((e) => e.users));
			const detail = [t("storage.dup.copies", { n: String(g.extras.length + 1) }), t("storage.dup.keeps", { file: g.keep.path.slice(g.keep.path.lastIndexOf("/") + 1) })];
			if (users.size > 0) detail.push(t("storage.dup.users", { n: String(users.size) }));
			this.actionRow(list, g.keep.path.slice(g.keep.path.lastIndexOf("/") + 1), detail.join(" · "), formatBytes(g.extraBytes), t("storage.dup.merge"), () => void this.merge(g));
		}
		this.moreButton(box, "dup", r.duplicates.length);
	}

	private heavySection(r: StorageReport): void {
		const { box, head } = this.section("heavy", t("storage.heavy"));
		shellNote(box, t("storage.heavy.note", { edge: String(DOWNSCALE_MAX_EDGE) }));
		const chips = head.createDiv({ cls: "nb-storage-sorts" });
		filterChips(chips, HEAVY_CHOICES.map((mb) => ({ id: String(mb), label: `${mb} MB` })), String(this.heavyMin), (id) => {
			this.heavyMin = Number(id);
			writePref(this.host.app, HEAVY_KEY, this.heavyMin);
			this.render();
		}, t("storage.heavy.from"));
		const rows = r.heavy.filter((h) => h.file.size >= this.heavyMin * 1024 * 1024);
		if (rows.length === 0) {
			shellNote(box, t("storage.heavy.none", { size: `${this.heavyMin} MB` }));
			return;
		}
		const list = box.createDiv({ cls: "nb-storage-list" });
		for (const h of this.limited(rows, "heavy")) {
			const detail = [t("storage.heavy.users", { n: String(h.users.length) })];
			if (h.blocked.length > 0) detail.push(t("storage.heavy.blocked", { n: String(h.blocked.length) }));
			this.actionRow(list, h.file.path.slice(h.file.path.lastIndexOf("/") + 1), detail.join(" · "), formatBytes(h.file.size), t("storage.heavy.downscale"), () => void this.downscale(h));
		}
		this.moreButton(box, "heavy", rows.length);
	}

	private backupsSection(r: StorageReport): void {
		const { box } = this.section("backups", t("storage.backups"));
		const none = r.oldBackups.length === 0 && r.conflictsIdentical.length === 0;
		if (none) shellNote(box, t("storage.backups.none", { days: String(OLD_BACKUP_DAYS) }));
		else {
			shellNote(box, t("storage.backups.note", { days: String(OLD_BACKUP_DAYS) }));
			const list = box.createDiv({ cls: "nb-storage-list" });
			const items: Array<{ path: string; label: string; detail: string; size: number }> = [];
			for (const c of r.conflictsIdentical) items.push({ path: c.path, label: c.path.slice(c.path.lastIndexOf("/") + 1), detail: t(c.maybeManual ? "storage.conflict.maybeManual" : "storage.conflict.identical", { main: c.main.slice(c.main.lastIndexOf("/") + 1) }), size: c.size });
			for (const b of r.oldBackups) items.push({ path: b.path, label: b.path.slice(b.path.lastIndexOf("/") + 1), detail: this.backupDetail(b), size: b.size });
			for (const it of this.limited(items, "backups")) this.pickRow(list, it.path, it.label, it.detail, it.size);
			this.moreButton(box, "backups", items.length);
			this.actionBar(box, items.map((i) => i.path), (n, size) => t("storage.backups.trash", { n: String(n), size }), items.map((i) => i.size), () => void this.trashBackups(r));
		}
		if (r.conflictsDiffering.length > 0) {
			shellNote(box, t("storage.conflict.differs", { n: String(r.conflictsDiffering.length) }));
			const list = box.createDiv({ cls: "nb-storage-list" });
			for (const c of r.conflictsDiffering) this.copyRow(list, c);
		}
	}

	private backupDetail(b: OldBackup): string {
		const when = new Date(b.at).toLocaleDateString(getLanguage());
		const nb = b.notebook.slice(b.notebook.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
		if (b.kind === "snapshot") return `${t("storage.backup.snapshot")} · ${nb} · ${when}`;
		return `${t("storage.backup.bak", { reason: b.reason ?? "" })} · ${nb} · ${when}${b.recovery ? ` · ${t("storage.backup.recovery")}` : ""}`;
	}

	/** A copy that differs from its notebook: shown with a way to open it, never offered for the trash. */
	private copyRow(list: HTMLElement, c: ConflictCopy): void {
		this.actionRow(list, c.path.slice(c.path.lastIndexOf("/") + 1), t("storage.conflict.differsRow", { main: c.main.slice(c.main.lastIndexOf("/") + 1) }), formatBytes(c.size), t("storage.open"), () => {
			const file = this.host.app.vault.getFileByPath(c.path);
			if (!file) return;
			this.close();
			this.host.openNotebook(file);
		});
	}

	// ------------------------------------------------------------------ building blocks

	private limited<T>(items: readonly T[], key: string): T[] {
		return this.expanded.has(key) ? [...items] : items.slice(0, LIST_LIMIT);
	}

	private moreButton(box: HTMLElement, key: string, total: number): void {
		if (total <= LIST_LIMIT) return;
		const open = this.expanded.has(key);
		shellButton(box, "secondary", open ? t("storage.fewer") : t("storage.all", { n: String(total) }), () => {
			if (open) this.expanded.delete(key);
			else this.expanded.add(key);
			this.render();
		}).addClass("nb-storage-more");
	}

	private pickRow(list: HTMLElement, path: string, label: string, detail: string, size: number): void {
		const row = list.createEl("label", { cls: "nb-storage-row is-pick", attr: { "data-path": path } });
		const box = row.createEl("input", { attr: { type: "checkbox" } });
		box.checked = this.picked.has(path);
		box.disabled = this.busy;
		box.addEventListener("change", () => {
			if (box.checked) this.picked.add(path);
			else this.picked.delete(path);
			this.render();
		});
		const text = row.createDiv({ cls: "nb-storage-text" });
		text.createDiv({ cls: "nb-storage-name", text: label });
		text.createDiv({ cls: "nb-storage-detail", text: detail });
		row.createDiv({ cls: "nb-storage-size", text: formatBytes(size) });
	}

	private actionRow(list: HTMLElement, label: string, detail: string, size: string, action: string, run: () => void): void {
		const row = list.createDiv({ cls: "nb-storage-row is-action" });
		const text = row.createDiv({ cls: "nb-storage-text" });
		text.createDiv({ cls: "nb-storage-name", text: label });
		text.createDiv({ cls: "nb-storage-detail", text: detail });
		row.createDiv({ cls: "nb-storage-size", text: size });
		shellButton(row, "secondary", action, run, { disabled: this.busy }).addClass("nb-storage-act");
	}

	/** The button under a list of ticked rows: how many are ticked, and the action. */
	private actionBar(box: HTMLElement, paths: readonly string[], label: (n: number, size: string) => string, sizes: readonly number[], run: () => void): void {
		const ticked = paths.map((p, i) => ({ p, size: sizes[i] ?? 0 })).filter((x) => this.picked.has(x.p));
		const bar = box.createDiv({ cls: "nb-storage-bar-actions" });
		const b = shellButton(bar, "danger", label(ticked.length, formatBytes(ticked.reduce((n, x) => n + x.size, 0))), run, { disabled: this.busy || ticked.length === 0, icon: "archive" });
		setShellButtonLabel(b, label(ticked.length, formatBytes(ticked.reduce((n, x) => n + x.size, 0))));
	}

	// ------------------------------------------------------------------ actions

	private async guarded(job: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.render();
		try {
			await job();
		} catch (e) {
			console.error("[notebook] storage action failed", e);
			showErrorNotice(t("storage.failed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			this.busy = false;
		}
		if (this.alive) {
			this.scanning = false;
			await this.scan();
		}
	}

	private async moveUnused(orphans: readonly AssetFile[]): Promise<void> {
		const chosen = orphans.filter((o) => this.picked.has(o.path));
		if (chosen.length === 0) return;
		const root = configFor(this.host.settings()).root;
		const ok = await confirmList(this.host.app, {
			title: t("storage.unused.confirm.title"),
			intro: t("storage.unused.confirm.body", { n: String(chosen.length), size: formatBytes(chosen.reduce((n, f) => n + f.size, 0)), target: assetTrashDir(root) }),
			rows: chosen.map((f) => ({ label: f.path.slice(f.path.lastIndexOf("/") + 1), detail: formatBytes(f.size) })),
			confirm: t("storage.unused.confirm.cta", { n: String(chosen.length) }),
		});
		if (!ok) return;
		await this.guarded(async () => {
			const result = await moveOrphans(vaultCheckSource(this.host.app), configFor(this.host.settings()), chosen, vaultMover(this.host.app), { ...this.runOptions(), cache: cache.scans });
			if (result.incomplete) showNotice(t("libcheck.incompleteNow"));
			else {
				showNotice(t("libcheck.moved", { n: String(result.moved.length), size: formatBytes(result.moved.reduce((n, f) => n + f.size, 0)), target: result.folder }));
				if (result.skipped.length > 0) showNotice(t("libcheck.skipped", { n: String(result.skipped.length) }));
				if (result.failed.length > 0) showErrorNotice(t("libcheck.moveFailed", { n: String(result.failed.length), error: result.failed[0]!.error }));
			}
		});
	}

	private async merge(g: DuplicateGroup): Promise<void> {
		const root = configFor(this.host.settings()).root;
		const rows = [{ label: g.keep.path.slice(g.keep.path.lastIndexOf("/") + 1), detail: t("storage.dup.confirm.keeps") }];
		for (const e of g.extras) rows.push({ label: e.file.path.slice(e.file.path.lastIndexOf("/") + 1), detail: e.kind === "same-id" ? t("storage.dup.confirm.moves", { target: assetTrashDir(root) }) : t("storage.dup.confirm.points", { n: String(e.users.length) }) });
		const ok = await confirmList(this.host.app, {
			title: t("storage.dup.confirm.title"),
			intro: t("storage.dup.confirm.body"),
			rows,
			confirm: t("storage.dup.merge"),
		});
		if (!ok) return;
		await this.guarded(async () => {
			const out = await mergeDuplicates(this.env, g, root);
			showNotice(t("storage.dup.done", { moved: String(out.moved.length), notebooks: String(out.repoint.updated.length) }));
			const left = out.repoint.skipped.length + out.skipped.length;
			if (left > 0) showNotice(t("storage.left", { n: String(left) }));
			const failed = out.failed.length + out.repoint.failed.length;
			if (failed > 0) showErrorNotice(t("storage.errors", { n: String(failed), error: (out.failed[0] ?? out.repoint.failed[0])!.error }));
		});
	}

	private async downscale(h: HeavyImage): Promise<void> {
		const ok = await confirmList(this.host.app, {
			title: t("storage.heavy.confirm.title"),
			intro: t("storage.heavy.confirm.body", { size: formatBytes(h.file.size), edge: String(DOWNSCALE_MAX_EDGE) }),
			rows: h.users.map((p) => ({ label: p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), detail: t("storage.heavy.confirm.row") })),
			confirm: t("storage.heavy.downscale"),
			tone: "primary",
		});
		if (!ok) return;
		await this.guarded(async () => {
			const out = await downscaleHeavy(this.env, h);
			if (!out.ok) {
				showNotice(t(`storage.heavy.fail.${out.reason}`));
				return;
			}
			showNotice(t("storage.heavy.done", { from: formatBytes(out.from), to: formatBytes(out.to), n: String(out.repoint.updated.length) }), 8000);
			const left = out.repoint.skipped.length;
			if (left > 0) showNotice(t("storage.left", { n: String(left) }));
			if (out.repoint.failed.length > 0) showErrorNotice(t("storage.errors", { n: String(out.repoint.failed.length), error: out.repoint.failed[0]!.error }));
		});
	}

	private async trashBackups(r: StorageReport): Promise<void> {
		const backups = r.oldBackups.filter((b) => this.picked.has(b.path));
		const copies = r.conflictsIdentical.filter((c) => this.picked.has(c.path));
		if (backups.length + copies.length === 0) return;
		const size = backups.reduce((n, b) => n + b.size, 0) + copies.reduce((n, c) => n + c.size, 0);
		const rows = [
			...copies.map((c) => ({ label: c.path.slice(c.path.lastIndexOf("/") + 1), detail: t("storage.backups.confirm.copy") })),
			...backups.map((b) => ({ label: b.path.slice(b.path.lastIndexOf("/") + 1), detail: this.backupDetail(b) })),
		];
		const ok = await confirmList(this.host.app, {
			title: t("storage.backups.confirm.title"),
			intro: t("storage.backups.confirm.body", { n: String(rows.length), size: formatBytes(size) }),
			rows,
			confirm: t("storage.backups.confirm.cta", { n: String(rows.length) }),
		});
		if (!ok) return;
		await this.guarded(async () => {
			const [a, b] = [await trashOldBackups(this.env, backups), await trashConflictCopies(this.env, copies)];
			showNotice(t("storage.backups.done", { n: String(a.trashed.length + b.trashed.length) }));
			const left = a.skipped.length + b.skipped.length;
			if (left > 0) showNotice(t("storage.left", { n: String(left) }));
			const failed = [...a.failed, ...b.failed];
			if (failed.length > 0) showErrorNotice(t("storage.errors", { n: String(failed.length), error: failed[0]!.error }));
		});
	}
}

// ------------------------------------------------------------------ the confirmation

export interface ConfirmListOptions {
	title: string;
	intro: string;
	rows: ReadonlyArray<{ label: string; detail?: string }>;
	confirm: string;
	/** `danger` (default) for moving or removing files, `primary` for a change that keeps everything. */
	tone?: "danger" | "primary";
}

/** The confirmation of every action: what will happen, every file or notebook it touches, then the button. Resolves false for Cancel, Escape and ×. */
export function confirmList(app: App, o: ConfirmListOptions): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const finish = (v: boolean) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const shell = modalShell(modal, { title: o.title, icon: o.tone === "primary" ? "image-down" : "archive", size: "medium", cls: "nb-storage-confirm" });
		shell.body.createEl("p", { cls: "nb-modal-text", text: o.intro });
		const list = shell.body.createDiv({ cls: "nb-storage-list is-confirm" });
		for (const r of o.rows) {
			const row = list.createDiv({ cls: "nb-storage-row" });
			const text = row.createDiv({ cls: "nb-storage-text" });
			text.createDiv({ cls: "nb-storage-name", text: r.label });
			if (r.detail) text.createDiv({ cls: "nb-storage-detail", text: r.detail });
		}
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => modal.close());
		shellButton(shell.foot, o.tone ?? "danger", o.confirm, () => {
			finish(true);
			modal.close();
		}, { disabled: o.rows.length === 0 });
		modal.onClose = () => {
			finish(false);
			modal.contentEl.empty();
		};
		modal.open();
	});
}
