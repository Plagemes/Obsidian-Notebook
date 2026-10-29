/**
 * Vault side and dialogs of the reliability features (wave p1b):
 * - #140 guided repair of a damaged notebook into a new notebook (sources: the file, the journal,
 *   version-history snapshots and backup copies; logic in model/repair.ts and storage/recovery.ts);
 * - #122 merge of conflicted copies created by Google Drive / OneDrive and other sync clients
 *   (logic in model/merge.ts, names in storage/conflicts.ts);
 * - #180 restore a single page from a previous version (logic in model/page-restore.ts).
 *
 * Nothing here overwrites a damaged file, deletes a file, or changes a notebook outside the open view's
 * undo history: repairs go into a new file, merges and page restores are one undo step of the open
 * notebook, and a conflicted copy is only moved (to the backup folder) after the merged notebook was
 * saved and read back containing everything of the copy.
 */
import { FuzzySuggestModal, Modal, normalizePath, Notice, Setting, TFile, type App, type FuzzyMatch, type Plugin } from "obsidian";
import { t } from "../i18n";
import { renderThumbnail } from "../library/thumbnail";
import { createId } from "../model/document";
import type { Command } from "../model/history";
import { mergeChangeCount, mergeCovers, planMerge, type MergeSummary } from "../model/merge";
import { matchingPageIndex, planPageRestore, type RestoreMode } from "../model/page-restore";
import type { RepairSummary } from "../model/repair";
import { parse, serializeChecked } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { backupFolder, type NotebookSettings } from "../settings";
import { conflictBaseOf, conflictCopiesOf } from "../storage/conflicts";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { extractDocId, formatSnapshotDate, parseSnapshotName, snapshotFolder } from "../storage/history";
import { journalKey, type JournalStore } from "../storage/journal";
import { createNotebook } from "../storage/notebooks";
import {
	backupDate, combineCandidates, isBackupOf, journalTexts, rankSources, type RecoveryCandidate, type RecoverySource, type SourceKind,
} from "../storage/recovery";
import { ensureFolder } from "../storage/vault-io";

export interface ReliabilityDeps {
	app: App;
	settings: NotebookSettings;
	journal?: JournalStore;
}

/** What the dialogs need from an open notebook view (NotebookView implements it). */
export interface ReliabilityView {
	readonly file: TFile | null;
	/** The loaded document when it can be edited, else null. */
	editableDocument(): NotebookDocument | null;
	/** Runs `cmd` on the document as one undo step. False when the view cannot take it now. */
	applyCommand(cmd: Command, scrollTo?: number): boolean;
	/** Index of the page in view. */
	currentPage(): number;
	/** Writes everything to disk; true when nothing is left only in memory. */
	flushNow(): Promise<boolean>;
}

// ------------------------------------------------------------------ previous versions

interface VersionFile {
	file: TFile;
	kind: "snapshot" | "backup";
	date: Date | null;
}

function folderChildren(app: App, path: string): TFile[] {
	const folder = app.vault.getFolderByPath(normalizePath(path));
	return (folder?.children ?? []).filter((f): f is TFile => f instanceof TFile);
}

/** Version-history snapshots and backup copies of a notebook, newest first (not read yet). */
function versionFiles(deps: ReliabilityDeps, file: TFile, docId: string | null): VersionFile[] {
	const out: VersionFile[] = [];
	if (docId) {
		for (const f of folderChildren(deps.app, snapshotFolder(backupFolder(deps.settings), docId))) {
			const date = parseSnapshotName(f.name);
			if (date) out.push({ file: f, kind: "snapshot", date });
		}
	}
	for (const f of folderChildren(deps.app, backupFolder(deps.settings))) {
		if (isBackupOf(f.name, file.basename)) out.push({ file: f, kind: "backup", date: backupDate(f.name) });
	}
	return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

function versionLabel(v: { kind: SourceKind; date: Date | null }): string {
	const date = v.date ? formatSnapshotDate(v.date) : "?";
	return t(`repair.source.${v.kind}`, { date });
}

// ------------------------------------------------------------------ #140 repair

/** Opens the repair dialog for a notebook that cannot be read. Never writes to `file`. */
export async function openRepair(deps: ReliabilityDeps, file: TFile): Promise<void> {
	const { app } = deps;
	try {
		const raw = readNotebookText(file.extension, await app.vault.read(file));
		if (parse(raw).ok) {
			new Notice(t("repair.notBroken"));
			return;
		}
		const docId = extractDocId(raw);
		const sources: RecoverySource[] = [{ kind: "file", label: file.path, date: new Date(file.stat.mtime), text: raw }];
		const others: RecoverySource[] = [];
		for (const v of versionFiles(deps, file, docId)) {
			try {
				const text = await app.vault.read(v.file);
				// A backup of another notebook with a similar name is not a version of this one.
				if (docId !== null && extractDocId(text) !== docId) continue;
				others.push({ kind: v.kind, label: v.file.path, date: v.date, text });
			} catch (e) {
				console.error("[notebook] could not read", v.file.path, e);
			}
		}
		if (docId !== null && deps.journal) {
			try {
				const slots = await deps.journal.read(journalKey(docId, file.path));
				for (const j of journalTexts(slots, docId, [raw, ...others.map((o) => o.text)])) {
					const date = new Date(j.savedAt);
					sources.push({ kind: "journal", label: t("repair.source.journal", { date: formatSnapshotDate(date) }), date, text: j.text });
				}
			} catch (e) {
				console.error("[notebook] could not read the journal", e);
			}
		}
		const ranked = rankSources([...sources, ...others]);
		if (ranked.length === 0) {
			new Notice(t("repair.none"));
			return;
		}
		new RepairModal(deps, file, ranked).open();
	} catch (e) {
		new Notice(t("repair.failed", { error: (e as Error).message }));
	}
}

/** One line per part of a repair summary, for the dialog. */
export function describeRepair(s: RepairSummary): string[] {
	if (s.alreadyReadable) return [t("repair.summary.readable", { pages: String(s.pages.recovered), strokes: String(s.strokes.recovered) })];
	const kept = (c: { recovered: number; repaired: number }) => String(c.recovered + c.repaired);
	const lines = [
		t("repair.summary.pages", { kept: kept(s.pages), lost: String(s.pages.lost) }),
		t("repair.summary.strokes", { kept: kept(s.strokes), repaired: String(s.strokes.repaired), lost: String(s.strokes.lost) }),
		t("repair.summary.elements", { kept: kept(s.elements), lost: String(s.elements.lost) }),
	];
	if (s.assets.lost > 0) lines.push(t("repair.summary.assets", { count: String(s.assets.lost) }));
	if (s.backgroundsLost > 0) lines.push(t("repair.summary.backgrounds", { count: String(s.backgroundsLost) }));
	if (s.damaged) lines.push(t("repair.summary.damage", { at: String(s.damageAt ?? "?") }));
	if (s.unknownFields > 0) lines.push(t("repair.summary.unknown", { count: String(s.unknownFields) }));
	return lines;
}

class RepairModal extends Modal {
	private busy = false;

	constructor(private readonly deps: ReliabilityDeps, private readonly file: TFile, private readonly candidates: RecoveryCandidate[]) {
		super(deps.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(t("repair.title"));
		contentEl.createEl("p", { text: t("repair.intro", { name: t("repair.newName", { name: this.file.basename }) }) });
		const fileCandidate = this.candidates.find((c) => c.source.kind === "file");
		this.candidates.forEach((c, i) => {
			const label = c.source.kind === "file" ? t("repair.source.file") : versionLabel(c.source);
			this.option(i === 0 ? `${label} · ${t("repair.best")}` : label, describeRepair(c.summary), c.doc, i === 0);
		});
		// The damaged file and the best other version together: everything of both.
		const other = this.candidates.find((c) => c.source.kind !== "file");
		if (fileCandidate && other) {
			const combined = combineCandidates(fileCandidate, other);
			if (combined) {
				this.option(t("repair.source.combined", { source: versionLabel(other.source) }), [t("repair.summary.combined", { count: String(combined.added) })], combined.doc, false);
			}
		}
	}

	private option(name: string, lines: string[], doc: NotebookDocument, cta: boolean): void {
		const s = new Setting(this.contentEl).setName(name);
		s.descEl.empty();
		for (const l of lines) s.descEl.createDiv({ text: l });
		s.addButton((b) => {
			b.setButtonText(t("repair.create")).onClick(() => void this.create(doc));
			if (cta) b.setCta();
		});
	}

	/** Writes `doc` into a new notebook next to the original, checks it reads back, opens it. */
	private async create(doc: NotebookDocument): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			// A new document id: the original keeps its own (journal, version history and library entries stay apart).
			const copy: NotebookDocument = { ...doc, id: createId(), modifiedAt: new Date().toISOString() };
			const checked = serializeChecked(copy, true);
			if (!checked.ok) throw new Error(checked.message);
			const folder = this.file.parent?.path ?? "/";
			const created = await createNotebook(this.app, folder, t("repair.newName", { name: this.file.basename }), copy);
			const back = parse(readNotebookText(created.extension, await this.app.vault.read(created)));
			if (!back.ok) throw new Error(back.message);
			new Notice(t("repair.done", { path: created.path }), 8000);
			this.close();
			await this.app.workspace.getLeaf("tab").openFile(created);
		} catch (e) {
			new Notice(t("repair.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------------ #122 conflicted copies

interface ConflictCopy {
	file: TFile;
	doc: NotebookDocument | null;
}

/** Notebook files in the folder of `file` whose names look like conflicted copies of it. */
function copyFilesOf(app: App, file: TFile): TFile[] {
	const siblings = (file.parent?.children ?? []).filter((f): f is TFile => f instanceof TFile && isNotebookFile(f) && f !== file);
	const stems = conflictCopiesOf(file.basename, siblings.map((f) => f.basename));
	return siblings.filter((f) => stems.includes(f.basename));
}

/**
 * Conflicted copies of the notebook `docId` stored in `file`: a conflict-like name in the same folder
 * AND the same document id. A copy that cannot be read is listed with `doc: null` (offer repair).
 */
async function findConflictCopies(app: App, file: TFile, docId: string): Promise<ConflictCopy[]> {
	const out: ConflictCopy[] = [];
	for (const f of copyFilesOf(app, file)) {
		try {
			const text = readNotebookText(f.extension, await app.vault.read(f));
			const r = parse(text);
			if (r.ok) {
				if (r.doc.id === docId) out.push({ file: f, doc: r.doc });
			} else if (extractDocId(text) === docId) {
				out.push({ file: f, doc: null });
			}
		} catch (e) {
			console.error("[notebook] could not read", f.path, e);
		}
	}
	return out;
}

export function describeMerge(s: MergeSummary): string[] {
	if (mergeChangeCount(s) === 0) return [t("merge.summary.nothing")];
	const lines: string[] = [];
	const add = (n: number, key: Parameters<typeof t>[0]) => {
		if (n > 0) lines.push(t(key, { count: String(n) }));
	};
	add(s.pagesAdded, "merge.summary.pages");
	add(s.strokesAdded, "merge.summary.strokes");
	add(s.strokesCopied, "merge.summary.strokesCopied");
	add(s.elementsAdded, "merge.summary.elements");
	add(s.elementsCopied, "merge.summary.elementsCopied");
	add(s.assetsAdded, "merge.summary.assets");
	add(s.tagsAdded + s.bookmarksAdded, "merge.summary.meta");
	add(s.pageSettingsDiffer, "merge.summary.settings");
	add(s.marginsDiffer, "merge.summary.margins");
	add(s.onlyInMain, "merge.summary.onlyMain");
	return lines;
}

/** Opens the merge dialog for the notebook shown in `view`. */
export async function openMerge(deps: ReliabilityDeps, view: ReliabilityView): Promise<void> {
	const file = view.file;
	const doc = view.editableDocument();
	if (!file || !doc) {
		new Notice(t("merge.notEditable"));
		return;
	}
	try {
		const copies = await findConflictCopies(deps.app, file, doc.id);
		if (copies.length === 0) {
			new Notice(t("merge.none"));
			return;
		}
		new MergeModal(deps, view, copies).open();
	} catch (e) {
		new Notice(t("merge.failed", { error: (e as Error).message }));
	}
}

/** Moves a conflicted copy into `<backup folder>/conflicts/` (never deletes it). Returns the new path. */
async function moveToBackup(deps: ReliabilityDeps, copy: TFile): Promise<string> {
	const folder = normalizePath(`${backupFolder(deps.settings)}/conflicts`);
	await ensureFolder(deps.app, folder);
	let target = normalizePath(`${folder}/${copy.name}`);
	for (let i = 2; deps.app.vault.getAbstractFileByPath(target); i++) target = normalizePath(`${folder}/${copy.basename} ${i}.${copy.extension}`);
	await deps.app.fileManager.renameFile(copy, target);
	return target;
}

class MergeModal extends Modal {
	private moveCopy = false;
	private busy = false;

	constructor(private readonly deps: ReliabilityDeps, private readonly view: ReliabilityView, private readonly copies: ConflictCopy[]) {
		super(deps.app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("merge.title"));
		contentEl.createEl("p", { text: t("merge.intro") });
		const doc = this.view.editableDocument();
		for (const copy of this.copies) {
			const s = new Setting(contentEl).setName(copy.file.path);
			s.descEl.empty();
			if (!copy.doc || !doc) {
				s.descEl.createDiv({ text: t("merge.unreadable", { name: copy.file.name }) });
				if (!copy.doc) s.addButton((b) => b.setButtonText(t("repair.title")).onClick(() => {
					this.close();
					void openRepair(this.deps, copy.file);
				}));
				continue;
			}
			const plan = planMerge(doc, copy.doc);
			for (const line of describeMerge(plan.summary)) s.descEl.createDiv({ text: line });
			if (plan.command) {
				s.addButton((b) => b.setButtonText(t("merge.apply")).setCta().onClick(() => void this.merge(copy)));
			} else if (mergeCovers(doc, copy.doc)) {
				s.addButton((b) => b.setButtonText(t("merge.moveOnly")).onClick(() => void this.afterMerge(copy, copy.doc!)));
			}
		}
		new Setting(contentEl)
			.setName(t("merge.moveCopy"))
			.setDesc(t("merge.moveCopy.desc"))
			.addToggle((tg) => tg.setValue(this.moveCopy).onChange((v) => {
				this.moveCopy = v;
			}));
	}

	private async merge(copy: ConflictCopy): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			// The copy may have changed since the dialog opened: read it again and plan against the current document.
			const fresh = parse(readNotebookText(copy.file.extension, await this.app.vault.read(copy.file)));
			const doc = this.view.editableDocument();
			if (!fresh.ok || !doc || fresh.doc.id !== doc.id) throw new Error(t("merge.unreadable", { name: copy.file.name }));
			const plan = planMerge(doc, fresh.doc);
			if (plan.command && !this.view.applyCommand(plan.command)) throw new Error(t("merge.notEditable"));
			new Notice(t("merge.done", { name: copy.file.name }));
			if (this.moveCopy) await this.afterMerge(copy, fresh.doc, true);
			copy.doc = fresh.doc;
			this.render();
		} catch (e) {
			new Notice(t("merge.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
	}

	/** Saves, reads the notebook back and moves the copy only if the saved file contains all of it. */
	private async afterMerge(copy: ConflictCopy, copyDoc: NotebookDocument, fromMerge = false): Promise<void> {
		const file = this.view.file;
		const saved = await this.view.flushNow();
		const back = saved && file ? parse(readNotebookText(file.extension, await this.app.vault.read(file))) : null;
		if (!back?.ok || !mergeCovers(back.doc, copyDoc)) {
			new Notice(t("merge.notMoved"), 8000);
			return;
		}
		const path = await moveToBackup(this.deps, copy.file);
		new Notice(t("merge.moved", { path }), 8000);
		const i = this.copies.indexOf(copy);
		if (i >= 0) this.copies.splice(i, 1);
		if (!fromMerge) this.render();
		if (this.copies.length === 0) this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Paths already told about in this app session, so a reload of the same file does not repeat the notice. */
const notified = new Set<string>();

/** Shows a notice with a "Merge" action when the notebook in `view` has conflicted copies. Never throws. */
export async function checkConflicts(deps: ReliabilityDeps, view: ReliabilityView, force = false): Promise<void> {
	const file = view.file;
	const doc = view.editableDocument();
	if (!file || !doc || (!force && notified.has(file.path))) return;
	try {
		if (copyFilesOf(deps.app, file).length === 0) return;
		const copies = await findConflictCopies(deps.app, file, doc.id);
		if (copies.length === 0 || view.file !== file) return;
		notified.add(file.path);
		const fragment = createFragment((f) => {
			f.createDiv({ text: t("merge.found", { name: file.basename, copies: copies.map((c) => c.file.name).join(", ") }) });
			const button = f.createEl("button", { text: t("merge.foundAction") });
			button.addEventListener("click", () => void openMerge(deps, view));
		});
		new Notice(fragment, 15000);
	} catch (e) {
		console.error("[notebook] conflict check failed", e);
	}
}

// ------------------------------------------------------------------ #180 restore one page

interface VersionItem extends VersionFile {
	label: string;
}

class VersionPickModal extends FuzzySuggestModal<VersionItem> {
	constructor(app: App, private readonly items: VersionItem[], private readonly onChoose: (item: VersionItem) => void) {
		super(app);
		this.setPlaceholder(t("pageRestore.placeholder"));
		this.emptyStateText = t("pageRestore.none");
	}

	getItems(): VersionItem[] {
		return this.items;
	}

	getItemText(item: VersionItem): string {
		return item.label;
	}

	renderSuggestion(match: FuzzyMatch<VersionItem>, el: HTMLElement): void {
		el.createDiv({ text: match.item.label });
	}

	onChooseItem(item: VersionItem): void {
		this.onChoose(item);
	}
}

/** Lists previous versions of the notebook in `view`, then lets the user restore one page of the chosen one. */
export function openPageRestore(deps: ReliabilityDeps, view: ReliabilityView, pageIndex: number): void {
	const file = view.file;
	const doc = view.editableDocument();
	if (!file || !doc) {
		new Notice(t("merge.notEditable"));
		return;
	}
	const items = versionFiles(deps, file, doc.id).map((v) => ({ ...v, label: versionLabel(v) }));
	if (items.length === 0) {
		new Notice(t("pageRestore.none"));
		return;
	}
	const targetId = doc.pages[pageIndex]?.id ?? null;
	new VersionPickModal(deps.app, items, (item) => void (async () => {
		try {
			const r = parse(await deps.app.vault.read(item.file));
			if (!r.ok) {
				new Notice(t("pageRestore.unreadable"));
				return;
			}
			if (r.doc.id !== doc.id) {
				new Notice(t("pageRestore.otherNotebook"));
				return;
			}
			new PageRestoreModal(deps.app, view, r.doc, item, targetId, pageIndex).open();
		} catch (e) {
			new Notice(t("merge.failed", { error: (e as Error).message }));
		}
	})()).open();
}

class PageRestoreModal extends Modal {
	private selected: number;

	constructor(
		app: App,
		private readonly view: ReliabilityView,
		private readonly version: NotebookDocument,
		private readonly item: VersionItem,
		/** Page in view when the dialog was opened (by id: pages may move meanwhile). */
		private readonly targetId: string | null,
		targetIndex: number,
	) {
		super(app);
		const doc = view.editableDocument();
		this.selected = matchingPageIndex(version, doc?.pages.find((p) => p.id === targetId), targetIndex);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(t("pageRestore.title", { date: this.item.date ? formatSnapshotDate(this.item.date) : this.item.file.name }));
		contentEl.createEl("p", { text: t("pageRestore.hint") });
		const grid = contentEl.createDiv({ cls: "notebook-restore-grid" });
		this.version.pages.forEach((page, i) => {
			const cell = grid.createDiv({ cls: "notebook-restore-page" });
			cell.toggleClass("is-selected", i === this.selected);
			const url = renderThumbnail(page, 120);
			if (url) cell.createEl("img", { attr: { src: url, alt: t("pageRestore.pageLabel", { n: String(i + 1) }) } });
			cell.createDiv({ text: t("pageRestore.pageLabel", { n: String(i + 1) }) });
			cell.addEventListener("click", () => {
				this.selected = i;
				this.render();
			});
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("pageRestore.insert")).onClick(() => this.restore("insert")))
			.addButton((b) => b.setButtonText(t("pageRestore.replace")).setCta().onClick(() => this.restore("replace")));
	}

	private restore(mode: RestoreMode): void {
		const doc = this.view.editableDocument();
		const target = doc ? doc.pages.findIndex((p) => p.id === this.targetId) : -1;
		const plan = doc && target >= 0 ? planPageRestore(doc, this.version, this.selected, target, mode) : null;
		if (!plan || !this.view.applyCommand(plan.command, plan.pageIndex)) {
			new Notice(t("merge.notEditable"));
			return;
		}
		new Notice(t("pageRestore.done"));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------------ registration

/** Commands and the conflicted-copy watcher. Called once from onload. */
export function registerReliability(plugin: Plugin, deps: ReliabilityDeps, views: () => ReliabilityView[], active: () => ReliabilityView | null): void {
	const { app } = plugin;
	plugin.addCommand({
		id: "repair-damaged",
		name: t("command.repair"),
		checkCallback: (checking) => {
			const file = app.workspace.getActiveFile();
			if (!file || !isNotebookFile(file)) return false;
			if (!checking) void openRepair(deps, file);
			return true;
		},
	});
	plugin.addCommand({
		id: "merge-conflicted-copies",
		name: t("command.mergeConflicts"),
		checkCallback: (checking) => {
			const view = active();
			if (!view?.editableDocument()) return false;
			if (!checking) void openMerge(deps, view);
			return true;
		},
	});
	plugin.addCommand({
		id: "restore-page",
		name: t("command.restorePage"),
		checkCallback: (checking) => {
			const view = active();
			if (!view?.editableDocument()) return false;
			if (!checking) openPageRestore(deps, view, view.currentPage());
			return true;
		},
	});
	// A conflicted copy that arrives while the notebook is open (the sync client writes it next to the file).
	// Registered after the layout is ready: Obsidian reports every existing file as "created" while loading.
	app.workspace.onLayoutReady(() => {
		plugin.registerEvent(app.vault.on("create", (f) => {
			if (!(f instanceof TFile) || !isNotebookFile(f) || !f.parent) return;
			const stems = new Set(f.parent.children.filter((c): c is TFile => c instanceof TFile && isNotebookFile(c)).map((c) => c.basename));
			const base = conflictBaseOf(f.basename, stems);
			if (base === null) return;
			for (const view of views()) {
				if (view.file?.parent === f.parent && view.file.basename === base) void checkConflicts(deps, view, true);
			}
		}));
	});
}
