import { MarkdownRenderChild, type App, type MarkdownPostProcessorContext, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { renderThumbnail, type ThumbnailOptions } from "../library/thumbnail";
import { parse } from "../model/serialize";
import type { NotebookDocument, Page } from "../model/types";
import { readNotebookText } from "../storage/format";
import { embedPixelWidth, parseEmbedSource } from "./links";
import { resolveNotebookFile } from "./open";

export interface EmbedDeps {
	app: App;
	folder: () => string;
	/** Loads the PDF page or image behind a page (null when there is none or it cannot be loaded). */
	background: (doc: NotebookDocument, page: Page, width: number) => Promise<ThumbnailOptions["drawBackground"] | null>;
	open: (file: TFile, page: number) => void;
}

const REFRESH_MS = 400;

/** Registers the `notebook` code block: a static preview of one notebook page. */
export function registerEmbed(plugin: Plugin, deps: EmbedDeps): void {
	plugin.registerMarkdownCodeBlockProcessor("notebook", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		ctx.addChild(new NotebookEmbed(el, source, ctx.sourcePath, deps));
	});
}

/** One rendered embed. Redraws when its notebook changes; everything is released on unload. */
export class NotebookEmbed extends MarkdownRenderChild {
	private run = 0;
	private timer: number | null = null;
	/** Path of the notebook shown now, to react to its changes. */
	private watched: string | null = null;

	constructor(el: HTMLElement, private readonly source: string, private readonly sourcePath: string, private readonly deps: EmbedDeps) {
		super(el);
	}

	onload(): void {
		const { vault } = this.deps.app;
		this.registerEvent(vault.on("modify", (f) => this.changed(f.path)));
		this.registerEvent(vault.on("delete", (f) => this.changed(f.path)));
		this.registerEvent(vault.on("rename", (f, old) => this.changed(old, f.path)));
		this.registerEvent(vault.on("create", (f) => {
			if (this.watched === null) this.changed(f.path);
		}));
		this.register(() => {
			this.run++;
			if (this.timer !== null) window.clearTimeout(this.timer);
		});
		this.containerEl.addClass("notebook-embed-host");
		this.containerEl.createDiv({ text: t("embed.loading"), cls: "notebook-embed-message" });
		void this.render();
	}

	private changed(...paths: string[]): void {
		if (this.watched === null ? !this.couldBeFixedBy(paths) : !paths.includes(this.watched)) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.render();
		}, REFRESH_MS);
	}

	/** While nothing is shown, only a file with the wanted name can fix the embed. */
	private couldBeFixedBy(paths: string[]): boolean {
		const parsed = parseEmbedSource(this.source);
		if (!parsed.ok) return false;
		const wanted = (parsed.target.value.split("/").pop() ?? "").toLowerCase();
		return paths.some((p) => (p.split("/").pop() ?? "").toLowerCase().startsWith(wanted));
	}

	private message(text: string): void {
		this.containerEl.replaceChildren(createDiv({ text, cls: "notebook-embed-message" }));
	}

	private async render(): Promise<void> {
		const run = ++this.run;
		const stale = () => run !== this.run;
		try {
			const parsed = parseEmbedSource(this.source);
			if (!parsed.ok) {
				this.watched = null;
				this.message(parsed.error === "empty" ? t("embed.empty") : t("embed.badPage", { page: parsed.detail }));
				return;
			}
			const file = resolveNotebookFile(this.deps.app, parsed.target, this.sourcePath, this.deps.folder());
			if (!file) {
				this.watched = null;
				this.message(t("embed.notFound", { target: parsed.target.value }));
				return;
			}
			this.watched = file.path;
			const raw = await this.deps.app.vault.read(file);
			const result = parse(readNotebookText(file.extension, raw));
			if (stale()) return;
			if (!result.ok) {
				this.message(t("embed.unreadable", { name: file.basename }));
				return;
			}
			const doc = result.doc;
			const page = doc.pages[parsed.page - 1];
			if (!page) {
				this.message(t("embed.pageMissing", { name: file.basename, count: String(doc.pages.length), page: String(parsed.page) }));
				return;
			}
			const px = embedPixelWidth(this.containerEl.clientWidth, window.devicePixelRatio);
			const background = await this.deps.background(doc, page, px).catch(() => null);
			if (stale()) return;
			const url = renderThumbnail(page, px, background ? { drawBackground: background } : {});
			if (!url) throw new Error("Canvas 2D is not available");
			this.show(file, parsed.page, url);
		} catch (e) {
			if (!stale()) this.message(t("embed.failed", { error: (e as Error).message }));
		}
	}

	private show(file: TFile, page: number, url: string): void {
		const title = t("embed.title", { name: file.basename, page: String(page) });
		const card = createDiv({ cls: "notebook-embed" });
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		card.setAttribute("aria-label", t("embed.open", { name: file.basename, page: String(page) }));
		card.createDiv({ text: title, cls: "notebook-embed-title" });
		const img = card.createEl("img", { cls: "notebook-embed-image" });
		img.alt = title;
		img.src = url;
		const open = () => this.deps.open(file, page);
		card.addEventListener("click", open);
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				open();
			}
		});
		this.containerEl.replaceChildren(card);
	}
}
