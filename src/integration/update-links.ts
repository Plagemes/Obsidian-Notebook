import { Modal, type App, type TFile } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { parse } from "../model/serialize";
import { isNotebookFile, NOTEBOOK_EXTENSIONS, readNotebookText } from "../storage/format";
import { PageMoveStore } from "../storage/page-moves";
import { isHiddenNotebookPath } from "../storage/trash-paths";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import type { NotebookSettings } from "../settings";
import {
	applyLinkChanges, isConflictedCopyPath, planNoteLinks, type LinkChange, type LinkPlan, type LinkSkip, type NotebookLookup, type SkipReason,
} from "./link-update";
import { candidatePaths } from "./links";
import { viewsOf } from "./open";

import { showNotice } from "../view/notice";
/**
 * The notebooks of the vault as `planNoteLinks` needs them. Pages are read once per notebook (the open view's document
 * when there is one, else the file) and the "which notebooks have this page id" index is built only if a link needs it.
 */
class VaultNotebooks implements NotebookLookup {
	private readonly files: TFile[];
	private readonly names = new Map<string, number>();
	private readonly pages = new Map<string, Promise<string[] | null>>();
	private index: Promise<Map<string, string[]>> | null = null;
	private moves: Promise<Map<string, string[]>> | null = null;

	constructor(private readonly app: App, hidden: (path: string) => boolean, private readonly moveStore: PageMoveStore) {
		this.files = app.vault.getFiles().filter((f) => isNotebookFile(f) && !hidden(f.path));
		for (const f of this.files) {
			const key = f.basename.toLowerCase();
			this.names.set(key, (this.names.get(key) ?? 0) + 1);
		}
	}

	resolve(linkPath: string, source: string): { path: string; ambiguous: boolean } | null {
		const { metadataCache } = this.app;
		let file = metadataCache.getFirstLinkpathDest(linkPath, source);
		if (file && !isNotebookFile(file)) return null;
		if (!file) {
			for (const candidate of candidatePaths(linkPath, NOTEBOOK_EXTENSIONS).slice(1)) {
				const found = metadataCache.getFirstLinkpathDest(candidate, source);
				if (found && isNotebookFile(found)) {
					file = found;
					break;
				}
			}
		}
		if (!file || !this.files.some((f) => f.path === file.path)) return null;
		// A bare name (no folder) that several notebooks share: Obsidian picks one, but the writer may have meant another.
		const ambiguous = !linkPath.includes("/") && (this.names.get(file.basename.toLowerCase()) ?? 0) > 1;
		return { path: file.path, ambiguous };
	}

	pageIds(path: string): Promise<string[] | null> {
		let known = this.pages.get(path);
		if (!known) {
			known = this.readIds(path);
			this.pages.set(path, known);
		}
		return known;
	}

	private async readIds(path: string): Promise<string[] | null> {
		const file = this.files.find((f) => f.path === path);
		if (!file) return null;
		try {
			for (const { view } of viewsOf(this.app, file)) if (view.document) return view.document.pages.map((p) => p.id);
			const parsed = parse(readNotebookText(file.extension, await this.app.vault.read(file)));
			return parsed.ok ? parsed.doc.pages.map((p) => p.id) : null;
		} catch (e) {
			console.warn("[notebook] update links: could not read", path, e);
			return null;
		}
	}

	async notebooksWithPage(pageId: string): Promise<string[]> {
		this.index ??= this.buildIndex();
		return (await this.index).get(pageId) ?? [];
	}

	private async buildIndex(): Promise<Map<string, string[]>> {
		const index = new Map<string, string[]>();
		for (const f of this.files) {
			for (const id of (await this.pageIds(f.path)) ?? []) {
				const list = index.get(id);
				if (list) list.push(f.path);
				else index.set(id, [f.path]);
			}
		}
		return index;
	}

	linkPathFor(path: string, source: string): string {
		const file = this.files.find((f) => f.path === path);
		return file ? this.app.metadataCache.fileToLinktext(file, source, false) : path;
	}

	isConflictedCopy(path: string): boolean {
		return isConflictedCopyPath(path, this.files.map((f) => f.path));
	}

	async movedPageIds(pageId: string): Promise<readonly string[]> {
		this.moves ??= this.moveStore.load().catch((e: unknown) => {
			console.warn("[notebook] update links: could not read the page moves", e);
			return new Map<string, string[]>();
		});
		return (await this.moves).get(pageId) ?? [];
	}
}

/** Plans the update for every note that could hold a page link. Reads notes, writes nothing. */
export async function planVaultLinks(app: App, settings: NotebookSettings): Promise<LinkPlan> {
	const moves = new PageMoveStore(vaultDeviceFileAdapter(app), () => settings.folder, sidecarDeviceId(app));
	const lookup = new VaultNotebooks(app, (path) => isHiddenNotebookPath(path, settings.folder, settings.templatesFolder), moves);
	const all: LinkPlan = { changes: [], skipped: [] };
	for (const note of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(note);
		const mentions = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].some((l) => l.link.includes("#"));
		if (!mentions) continue;
		try {
			const plan = await planNoteLinks(note.path, await app.vault.cachedRead(note), lookup);
			all.changes.push(...plan.changes);
			all.skipped.push(...plan.skipped);
		} catch (e) {
			console.warn("[notebook] update links: could not read", note.path, e);
		}
	}
	return all;
}

const REASONS: Record<SkipReason, MessageKey> = {
	"ambiguous-notebook": "links.update.reason.ambiguous",
	"page-out-of-range": "links.update.reason.range",
	"page-gone": "links.update.reason.gone",
	"id-in-several": "links.update.reason.several",
	unreadable: "links.update.reason.unreadable",
};

const KINDS: Record<LinkChange["kind"], MessageKey> = {
	pin: "links.update.kind.pin",
	renumber: "links.update.kind.renumber",
	relocate: "links.update.kind.relocate",
};

/** The list the user reviews: every change with a checkbox (all ticked), and the links that are left alone, with the reason. */
class UpdateLinksModal extends Modal {
	private readonly chosen: Set<LinkChange>;

	constructor(app: App, private readonly plan: LinkPlan, private readonly onApply: (changes: LinkChange[]) => void) {
		super(app);
		this.chosen = new Set(plan.changes);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-update-links");
		this.setTitle(t("links.update.title"));
		const { contentEl } = this;
		contentEl.createEl("p", { text: t("links.update.intro"), cls: "notebook-update-links-intro" });
		const byNote = new Map<string, LinkChange[]>();
		for (const c of this.plan.changes) byNote.set(c.notePath, [...(byNote.get(c.notePath) ?? []), c]);
		let apply: HTMLButtonElement | null = null;
		const sync = () => {
			if (!apply) return;
			apply.setText(t("links.update.apply", { n: String(this.chosen.size) }));
			apply.disabled = this.chosen.size === 0;
		};
		const list = contentEl.createDiv({ cls: "notebook-update-links-list" });
		for (const [note, changes] of byNote) {
			list.createEl("h4", { text: note });
			for (const c of changes) {
				const row = list.createEl("label", { cls: "notebook-update-links-row" });
				const box = row.createEl("input", { attr: { type: "checkbox" } });
				box.checked = true;
				box.addEventListener("change", () => {
					if (box.checked) this.chosen.add(c);
					else this.chosen.delete(c);
					sync();
				});
				const text = row.createDiv();
				// A fragment change shows the subpath; a relocation shows the whole link target.
				const shown = (s: string) => (c.kind === "relocate" ? s : `#${s}`);
				text.createDiv({ text: `${t("links.update.line", { n: String(c.line) })}: ${shown(c.before)} → ${shown(c.after)}` });
				text.createDiv({ text: t(KINDS[c.kind]), cls: "notebook-update-links-note" });
				if (c.lineText) text.createDiv({ text: c.lineText, cls: "notebook-update-links-line" });
			}
		}
		if (this.plan.skipped.length > 0) {
			contentEl.createEl("h4", { text: t("links.update.skipped", { n: String(this.plan.skipped.length) }) });
			const skipped = contentEl.createDiv({ cls: "notebook-update-links-list" });
			for (const s of this.plan.skipped) {
				const row = skipped.createDiv();
				row.createDiv({ text: skipLine(s), cls: "notebook-update-links-note" });
				if (s.lineText) row.createDiv({ text: s.lineText, cls: "notebook-update-links-line" });
			}
		}
		const bar = contentEl.createDiv({ cls: "modal-button-container" });
		const applyButton = bar.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
		apply = applyButton;
		bar.createEl("button", { text: t("links.update.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
		applyButton.addEventListener("click", () => {
			const changes = this.plan.changes.filter((c) => this.chosen.has(c));
			this.close();
			this.onApply(changes);
		});
		sync();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function skipLine(s: LinkSkip): string {
	return `${s.notePath}, ${t("links.update.line", { n: String(s.line) })} (${s.text}): ${t(REASONS[s.reason])}`;
}

/** Applies the accepted changes note by note; a note edited since the plan keeps those links as they are. */
async function applyChanges(app: App, changes: readonly LinkChange[]): Promise<{ applied: number; stale: number; notes: number }> {
	const byNote = new Map<string, LinkChange[]>();
	for (const c of changes) byNote.set(c.notePath, [...(byNote.get(c.notePath) ?? []), c]);
	let applied = 0;
	let stale = 0;
	let notes = 0;
	for (const [path, list] of byNote) {
		const file = app.vault.getFileByPath(path);
		if (!file) {
			stale += list.length;
			continue;
		}
		await app.vault.process(file, (text) => {
			const r = applyLinkChanges(text, list);
			applied += r.applied;
			stale += r.stale;
			if (r.applied > 0) notes++;
			return r.text;
		});
	}
	return { applied, stale, notes };
}

export interface UpdateLinksPlugin {
	app: App;
	settings: NotebookSettings;
}

/** The "Update links to notebook pages" command: plan, show the list (nothing is written yet), apply what the user accepts. */
export async function runUpdateLinks(plugin: UpdateLinksPlugin): Promise<void> {
	const { app } = plugin;
	showNotice(t("links.update.scanning"));
	let plan: LinkPlan;
	try {
		plan = await planVaultLinks(app, plugin.settings);
	} catch (e) {
		console.error("[notebook] update links", e);
		showNotice(t("links.update.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		return;
	}
	if (plan.changes.length === 0) {
		showNotice(t(plan.skipped.length > 0 ? "links.update.noneSkipped" : "links.update.none", { n: String(plan.skipped.length) }), 8000);
		if (plan.skipped.length > 0) new UpdateLinksModal(app, plan, () => undefined).open();
		return;
	}
	new UpdateLinksModal(app, plan, (changes) => {
		void applyChanges(app, changes).then((r) => {
			showNotice(t(r.stale > 0 ? "links.update.doneStale" : "links.update.done", { n: String(r.applied), notes: String(r.notes), stale: String(r.stale) }), 8000);
		}).catch((e: unknown) => {
			console.error("[notebook] update links", e);
			showNotice(t("links.update.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		});
	}).open();
}
