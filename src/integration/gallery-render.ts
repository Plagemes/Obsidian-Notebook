/**
 * 0.26 gallery (#421): renders the `notebook-gallery` code block (reading view and Live Preview) as a grid of page thumbnails.
 * Read-only: it never writes to the vault. Thumbnails come from the library's page thumbnail cache (`PageThumbs`); the grid is
 * rebuilt, debounced, when the indexed notebooks, the bookmarks or the timetable change.
 */
import { MarkdownRenderChild, setIcon, type App, type MarkdownPostProcessorContext, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import type { PageThumbs } from "../library/page-thumbs";
import { describeGalleryQuery, GALLERY_LANG, parseGalleryQuery, resolveGallery, type GalleryItem, type GalleryQuery } from "./gallery-query";
import type { GalleryData } from "./gallery-service";

export interface GalleryRenderDeps {
	app: App;
	data: GalleryData;
	thumbs: PageThumbs;
	/** `page` is 1-based; `pageId` makes the tap land on the same page even if it moved. */
	open: (file: TFile, page: number, pageId?: string) => void;
}

const THUMB_WIDTH = 280;
const ERRORS = {
	syntax: "gallery.error.syntax",
	"unknown-key": "gallery.error.unknownKey",
	"bad-value": "gallery.error.badValue",
} as const;

export function registerGallery(plugin: Plugin, deps: GalleryRenderDeps): void {
	plugin.registerMarkdownCodeBlockProcessor(GALLERY_LANG, (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		ctx.addChild(new GalleryBlock(el, source, deps));
	});
}

export class GalleryBlock extends MarkdownRenderChild {
	private run = 0;
	private query: GalleryQuery | null = null;

	constructor(el: HTMLElement, private readonly source: string, private readonly deps: GalleryRenderDeps) {
		super(el);
	}

	onload(): void {
		const parsed = parseGalleryQuery(this.source);
		const root = createDiv({ cls: "nb-ui nb-gallery" });
		this.containerEl.replaceChildren(root);
		if (!parsed.ok) {
			root.addClass("is-error");
			root.createDiv({ cls: "nb-gallery-error", attr: { role: "alert" }, text: t(ERRORS[parsed.error], { detail: parsed.detail }) });
			return;
		}
		this.query = parsed.query;
		this.register(() => void this.run++);
		this.register(this.deps.data.onChange(() => void this.render(root)));
		void this.render(root);
	}

	private async render(root: HTMLElement): Promise<void> {
		const q = this.query;
		if (!q) return;
		const run = ++this.run;
		const { data } = this.deps;
		try {
			const items = await resolveGallery(await data.entries(), q, data.context(), (e) => data.pagesOf(e));
			if (run !== this.run) return;
			this.show(root, q, items);
		} catch (e) {
			if (run !== this.run) return;
			console.error("[notebook] gallery failed", e);
			root.empty();
			root.addClass("is-error");
			root.createDiv({ cls: "nb-gallery-error", attr: { role: "alert" }, text: t("gallery.failed", { error: e instanceof Error ? e.message : String(e) }) });
		}
	}

	private show(root: HTMLElement, q: GalleryQuery, items: GalleryItem[]): void {
		root.empty();
		root.removeClass("is-error");
		const what = describeGalleryQuery(q);
		if (items.length === 0) {
			root.addClass("is-empty");
			const icon = root.createDiv({ cls: "nb-gallery-empty-icon", attr: { "aria-hidden": "true" } });
			setIcon(icon, "layout-grid");
			const text = root.createDiv({ cls: "nb-gallery-empty" });
			text.createDiv({ cls: "nb-gallery-empty-title", text: t("gallery.empty") });
			if (what.length > 0) text.createDiv({ cls: "nb-gallery-empty-detail", text: what.join(" · ") });
			return;
		}
		root.removeClass("is-empty");
		const head = root.createDiv({ cls: "nb-gallery-head" });
		head.createSpan({ cls: "nb-gallery-title", text: t("gallery.title") });
		head.createSpan({ cls: "nb-gallery-count", text: t("gallery.count", { count: String(items.length) }) });
		if (what.length > 0) head.createSpan({ cls: "nb-gallery-query", text: what.join(" · ") });
		const grid = root.createDiv({ cls: "nb-gallery-grid", attr: { role: "list" } });
		for (const item of items) this.tile(grid, item);
	}

	private tile(grid: HTMLElement, item: GalleryItem): void {
		const label = t("gallery.open", { name: item.name, page: String(item.page + 1) });
		const tile = grid.createDiv({ cls: "nb-gallery-tile", attr: { role: "listitem" } });
		const button = tile.createEl("button", { cls: "nb-gallery-card", attr: { type: "button", "aria-label": label, title: label } });
		const thumb = button.createDiv({ cls: "nb-page-thumb nb-gallery-thumb" });
		thumb.dataset.pageThumbPath = item.path;
		thumb.dataset.pageThumbWidth = String(THUMB_WIDTH);
		thumb.dataset.pageThumbIndex = String(item.page);
		if (item.pageId) thumb.dataset.pageThumbId = item.pageId;
		const caption = button.createDiv({ cls: "nb-gallery-caption" });
		caption.createSpan({ cls: "nb-gallery-name", text: item.name });
		caption.createSpan({ cls: "nb-gallery-page", text: t("gallery.page", { page: String(item.page + 1) }) });
		button.addEventListener("click", () => {
			const file = this.deps.app.vault.getFileByPath(item.path);
			if (file) this.deps.open(file, item.page + 1, item.pageId);
		});
		this.deps.thumbs.fill(thumb);
	}
}
