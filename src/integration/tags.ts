import { AbstractInputSuggest, getAllTags, Modal, Notice, Setting, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { normalizeTagList, parseTagInput, suggestTags, tagsFromVault, uniqueTags, tagKey, type TagCount } from "../model/tags";
import type { NotebookSettings } from "../settings";
import { NotebookView } from "../view/notebook-view";
import { activeCompanion } from "./companion";

/**
 * Shared tags (O2): the tag editor of a notebook, used by the library and by the *Edit tags* command.
 *
 * The notebook's tags live in the notebook (`meta.tags`). Obsidian only indexes Markdown, so they reach the Tags pane
 * through the companion note's `tags` property (integration/companion.ts, merge rule in model/tags.ts). The editor
 * suggests the tags that already exist in the vault, normalises what is typed the way Obsidian writes tags, and says so
 * when companion notes are off, offering to turn them on.
 */

export interface TagsHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

let host: TagsHost | null = null;

/** Registers the *Edit tags* command. Called once from registerIntegration. */
export function registerTags(plugin: TagsHost): void {
	host = plugin;
	plugin.register(() => {
		host = null;
	});
	plugin.addCommand({
		id: "edit-tags",
		name: t("command.editTags"),
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(NotebookView);
			if (!view?.file) return false;
			if (!checking) editNotebookTags(plugin.app, view);
			return true;
		},
	});
}

/** Tags in the vault (the Tags pane) with their counts, most used first; `extra` (e.g. the library's tags) are added. */
export function vaultTags(app: App, extra: readonly string[] = []): TagCount[] {
	const cache = app.metadataCache as unknown as { getTags?: () => Record<string, number> };
	let record: Record<string, number> = {};
	if (typeof cache.getTags === "function") {
		try {
			record = cache.getTags();
		} catch (e) {
			console.error("[notebook] metadataCache.getTags", e);
		}
	} else {
		// `getTags()` is not part of the public typings: count the tags of every note when it is missing.
		for (const file of app.vault.getMarkdownFiles()) {
			for (const tag of new Set(getAllTags(app.metadataCache.getFileCache(file) ?? {}) ?? [])) record[tag] = (record[tag] ?? 0) + 1;
		}
	}
	const all = tagsFromVault(record);
	const known = new Set(all.map((x) => tagKey(x.tag)));
	for (const raw of extra) {
		const [tag] = normalizeTagList([raw]).tags;
		if (tag && !known.has(tagKey(tag))) {
			known.add(tagKey(tag));
			all.push({ tag, count: 0 });
		}
	}
	return all;
}

/** Edit the tags of the notebook open in `view` (undoable there). */
export function editNotebookTags(app: App, view: NotebookView): void {
	const file = view.file;
	if (!file) return;
	openTagEditor(app, {
		file,
		current: view.document?.meta?.tags ?? [],
		onSave: (tags) => {
			if (!view.applyMetaPatch({ tags })) throw new Error(t("host.metaRejected"));
		},
	});
}

export interface TagEditorOptions {
	/** The notebook; used to refresh its companion note after saving and after turning companion notes on. */
	file: TFile | null;
	current: readonly string[];
	/** Tags known to the library but maybe not (yet) to Obsidian: suggested too. */
	libraryTags?: readonly string[];
	/** Receives the normalised tags. May return a promise; the companion note is refreshed when it settles. */
	onSave: (tags: string[]) => void | Promise<void>;
}

export function openTagEditor(app: App, options: TagEditorOptions): void {
	new TagEditorModal(app, options).open();
}

class TagSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private readonly input: HTMLInputElement, private readonly candidates: () => TagCount[], private readonly chosen: () => string[], private readonly pick: (tag: string) => void) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		// Only the last tag of a line with several (`a, b`) is being completed.
		const last = parseTagInput(query).pop() ?? "";
		return suggestTags(last, this.candidates(), { exclude: this.chosen(), limit: 8 });
	}

	renderSuggestion(tag: string, el: HTMLElement): void {
		el.setText(`#${tag}`);
	}

	selectSuggestion(tag: string): void {
		this.pick(tag);
		this.input.value = "";
		this.close();
		this.input.focus();
	}
}

class TagEditorModal extends Modal {
	private tags: string[];
	private chipsEl!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private errorEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private readonly candidates: TagCount[];

	constructor(app: App, private readonly opts: TagEditorOptions) {
		super(app);
		this.tags = normalizeTagList(opts.current).tags;
		this.candidates = vaultTags(app, opts.libraryTags);
	}

	onOpen(): void {
		this.setTitle(t("tags.editor.title"));
		this.chipsEl = this.contentEl.createDiv({ cls: "notebook-tags-chips" });
		this.renderChips();

		const row = this.contentEl.createDiv({ cls: "notebook-tags-row" });
		this.inputEl = row.createEl("input", { type: "text", cls: "notebook-tags-input", attr: { placeholder: t("tags.editor.placeholder"), "aria-label": t("tags.editor.title") } });
		new TagSuggest(this.app, this.inputEl, () => this.candidates, () => this.tags, (tag) => this.add([tag]));
		const addButton = row.createEl("button", { text: t("tags.editor.add") });
		addButton.addEventListener("click", () => this.addTyped());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.isComposing) return;
			if (e.key === "Enter") {
				e.preventDefault();
				// Enter on an empty field saves; with text it adds the tag.
				if (this.inputEl.value.trim() === "") void this.save();
				else this.addTyped();
			} else if (e.key === "," || e.key === ";") {
				e.preventDefault();
				this.addTyped();
			} else if (e.key === "Backspace" && this.inputEl.value === "" && this.tags.length > 0) {
				this.tags = this.tags.slice(0, -1);
				this.renderChips();
			}
		});
		this.errorEl = this.contentEl.createDiv({ cls: "notebook-tags-error" });
		this.contentEl.createDiv({ cls: "notebook-tags-desc", text: t("tags.editor.desc") });
		this.hintEl = this.contentEl.createDiv({ cls: "notebook-tags-hint" });
		this.renderHint();

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("library.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("library.modal.save")).setCta().onClick(() => void this.save()));
		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderChips(): void {
		this.chipsEl.empty();
		if (this.tags.length === 0) {
			this.chipsEl.createSpan({ cls: "notebook-tags-none", text: t("tags.editor.none") });
			return;
		}
		for (const tag of this.tags) {
			const chip = this.chipsEl.createEl("button", { cls: "notebook-tags-chip", attr: { "aria-label": t("tags.editor.remove", { tag }) } });
			chip.createSpan({ text: `#${tag}` });
			chip.createSpan({ cls: "notebook-tags-x", text: "×" });
			chip.addEventListener("click", () => {
				this.tags = this.tags.filter((x) => tagKey(x) !== tagKey(tag));
				this.renderChips();
				this.inputEl.focus();
			});
		}
	}

	/** Adds what is in the field (one or several tags). Entries that cannot be tags stay in the field with a message. */
	private addTyped(): boolean {
		const parts = parseTagInput(this.inputEl.value);
		if (parts.length === 0) return true;
		const { tags, rejected } = normalizeTagList(parts);
		this.add(tags);
		this.inputEl.value = rejected.join(", ");
		this.errorEl.setText(rejected.length > 0 ? t("tags.editor.invalid", { tags: rejected.join(", ") }) : "");
		return rejected.length === 0;
	}

	private add(tags: readonly string[]): void {
		this.tags = uniqueTags([...this.tags, ...tags]);
		this.errorEl.setText("");
		this.renderChips();
	}

	/** Why the Tags pane may not show these tags, and a way to fix it. */
	private renderHint(): void {
		this.hintEl.empty();
		const plugin = host;
		if (!plugin) return;
		if (plugin.settings.companionNotes) {
			this.hintEl.setText(t("tags.editor.companionOn"));
			return;
		}
		this.hintEl.createDiv({ text: t("tags.editor.companionOff") });
		const button = this.hintEl.createEl("button", { text: t("tags.editor.enableCompanion") });
		button.addEventListener("click", () => {
			button.disabled = true;
			plugin.settings = { ...plugin.settings, companionNotes: true };
			void plugin.saveSettings().then(() => {
				this.renderHint();
				const file = this.opts.file;
				if (file) activeCompanion()?.schedule(file, 2_000);
			}, (e: unknown) => {
				console.error("[notebook] could not turn on companion notes", e);
				plugin.settings = { ...plugin.settings, companionNotes: false };
				button.disabled = false;
				new Notice(t("tags.editor.enableFailed", { error: e instanceof Error ? e.message : String(e) }));
			});
		});
	}

	private async save(): Promise<void> {
		if (!this.addTyped()) return; // something in the field is not a tag: say so instead of dropping it
		try {
			await this.opts.onSave([...this.tags]);
		} catch (e) {
			console.error("[notebook] tags", e);
			new Notice(t("library.notice.failed", { error: e instanceof Error ? e.message : String(e) }));
		}
		const file = this.opts.file;
		if (file) activeCompanion()?.schedule(file, 2_000);
		this.close();
	}
}
