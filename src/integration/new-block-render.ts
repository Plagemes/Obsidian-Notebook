import { MarkdownRenderChild, TFile, type App, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import { t } from "../i18n";
import { shellButton } from "../ui/components/modal-shell";
import { showNotice } from "../view/notice";
import type { NotebookApi } from "./api";
import { isTemplateNote, newBlockSlot, parseNewBlock, NEW_BLOCK_LANG, replaceNewBlock, templateFoldersFrom, type NewBlockSpec } from "./new-block";

export interface NewBlockDeps {
	app: App;
	api: () => NotebookApi | undefined;
}

/** Registers the `notebook-new` code block: a "Create notebook" button. Nothing is created until the button is pressed. */
export function registerNewBlock(plugin: Plugin, deps: NewBlockDeps): void {
	plugin.registerMarkdownCodeBlockProcessor(NEW_BLOCK_LANG, (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		ctx.addChild(new NewBlockCard(el, source, ctx, deps));
	});
}

const ERRORS = {
	empty: "newblock.error.empty",
	syntax: "newblock.error.syntax",
	"unknown-key": "newblock.error.unknownKey",
	"no-name": "newblock.error.noName",
	unexpanded: "newblock.error.unexpanded",
	"bad-value": "newblock.error.badValue",
} as const;

class NewBlockCard extends MarkdownRenderChild {
	private busy = false;

	constructor(el: HTMLElement, private readonly source: string, private readonly ctx: MarkdownPostProcessorContext, private readonly deps: NewBlockDeps) {
		super(el);
	}

	onload(): void {
		const parsed = parseNewBlock(this.source);
		const card = createDiv({ cls: "nb-ui nb-newblock" });
		this.containerEl.replaceChildren(card);
		// In a note template the block is the template's own text: a button there would rewrite the template file.
		if (isTemplateNote(this.ctx.sourcePath, templateFoldersFrom(this.deps.app))) {
			card.createDiv({ cls: "nb-newblock-title", text: t("newblock.title") });
			card.createDiv({ cls: "nb-newblock-detail", text: t("newblock.inTemplate") });
			return;
		}
		if (!parsed.ok) {
			card.addClass("is-error");
			card.createDiv({ cls: "nb-newblock-title", text: t("newblock.title") });
			card.createDiv({ cls: "nb-newblock-detail", text: t(ERRORS[parsed.error], { detail: parsed.detail }) });
			return;
		}
		const { spec } = parsed;
		const text = card.createDiv({ cls: "nb-newblock-text" });
		text.createDiv({ cls: "nb-newblock-title", text: spec.name });
		text.createDiv({ cls: "nb-newblock-detail", text: spec.template ? t("newblock.fromTemplate", { template: spec.template }) : t("newblock.plain") });
		const button = shellButton(card, "primary", t("newblock.create"), () => void this.create(spec, button), { icon: "pencil-line" });
	}

	private noteFile(): TFile | null {
		const f = this.deps.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		return f instanceof TFile ? f : null;
	}

	private async create(spec: NewBlockSpec, button: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		const { app } = this.deps;
		const api = this.deps.api();
		if (!api) return void showNotice(t("newblock.noApi"));
		const note = this.noteFile();
		const hint = this.ctx.getSectionInfo(this.containerEl)?.lineStart;
		// Check the block can be replaced before making anything: a notebook with nowhere to go would be an orphan.
		// Which of several identical blocks this is stays fixed from here on, even if lines are typed above it meanwhile.
		const slot = note ? newBlockSlot(await app.vault.read(note), this.source, hint) : null;
		if (!note || !slot) return void showNotice(t("newblock.notFound"));
		this.busy = true;
		button.disabled = true;
		let made: Awaited<ReturnType<NotebookApi["newNotebook"]>>;
		try {
			made = await api.newNotebook({ name: spec.name, ...(spec.folder ? { folder: spec.folder } : {}), ...(spec.template ? { template: spec.template } : {}), ...(spec.content !== undefined ? { content: spec.content } : {}), ...(spec.open !== undefined ? { open: spec.open } : {}) });
		} catch (e) {
			showNotice(t("newblock.failed", { error: e instanceof Error ? e.message : String(e) }));
			button.disabled = false;
			this.busy = false;
			return;
		}
		// From here on the notebook exists: the button stays off whatever happens, so a second click cannot make a second notebook.
		try {
			let replaced = false;
			await app.vault.process(note, (data) => {
				const next = replaceNewBlock(data, this.source, made.embed, hint, slot);
				replaced = next !== null;
				return next ?? data;
			});
			showNotice(replaced ? t("newblock.created", { name: made.name }) : t("newblock.createdNotReplaced", { name: made.name, link: made.embed }));
		} catch (e) {
			console.error("[notebook] the new notebook's block could not be replaced", e);
			showNotice(t("newblock.createdNotReplaced", { name: made.name, link: made.embed }), 12000);
		} finally {
			this.busy = false;
		}
	}
}
