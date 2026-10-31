/**
 * Notebook outline and page tags (v7, roadmap #15, #85, #119; 0.13 generated outline #407): the outline list shown in the page panel, the
 * bookmark editor (title, colour, category), the page tags editor and their page-menu items. Every change is
 * one undoable command run by the host (SetMeta for bookmarks, SetPageTags for tags).
 */
import { Menu, Modal, Setting, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import {
	BOOKMARK_COLORS, bookmarkColor, categoriesInUse, isBuiltInCategory, removeBookmark, setBookmark,
} from "../model/bookmarks";
import { filterByCategory, type OutlineBuilder, type OutlineItem, type OutlineSources } from "../model/outline-builder";
import { cloneMeta } from "../model/document";
import { SetMeta, type Command } from "../model/history";
import { pageTagCounts, parsePageTagInput, SetPageTags } from "../model/page-tags";
import { BOOKMARK_CATEGORIES, DEFAULT_META, type Asset, type BookmarkInfo, type NotebookMeta, type Page } from "../model/types";
import { setDestructive } from "../ui/destructive";

export interface OutlineHost {
	readonly app: App;
	pages(): readonly Page[];
	meta(): NotebookMeta | undefined;
	/** False while the notebook cannot be edited (read-only, not loaded, pen down). */
	canEdit(): boolean;
	/** Runs an undoable command on the open notebook. */
	execute(cmd: Command): void;
	goTo(index: number): void;
	/** 0.13: the assets of the notebook (names of the PDFs in the outline). */
	assets(): Readonly<Record<string, Asset>> | undefined;
	/** 0.13: the generated outline with its per-page cache (one per open notebook). */
	outline(): OutlineBuilder;
	/** 0.13: which sources the outline lists (settings). */
	sources(): OutlineSources;
	/** 0.13: picture (data URL) of the ink of a heading entry; null when it cannot be drawn. */
	headingImage(item: OutlineItem): string | null;
}

/** Label of a category: the built-in ones are translated, custom ones are shown as typed. */
export function categoryLabel(category: string): string {
	if (category === "important") return t("bookmark.category.important");
	if (category === "review") return t("bookmark.category.review");
	return category;
}

function metaOf(host: OutlineHost): NotebookMeta {
	return host.meta() ?? cloneMeta(DEFAULT_META);
}

function changeMeta(host: OutlineHost, after: NotebookMeta): void {
	if (!host.canEdit()) return;
	host.execute(new SetMeta(metaOf(host), after));
}

/** Opens the bookmark editor for the page `pageId` (adds the bookmark on save when the page has none). */
export function editBookmark(host: OutlineHost, pageId: string): void {
	const index = host.pages().findIndex((p) => p.id === pageId);
	if (index < 0 || !host.canEdit()) return;
	const meta = metaOf(host);
	new BookmarkModal(host.app, {
		pageNumber: index + 1,
		exists: meta.bookmarks.includes(pageId),
		info: meta.bookmarkInfo?.[pageId] ?? {},
		customCategories: categoriesInUse(meta, host.pages()).filter((c) => !isBuiltInCategory(c)),
		onSave: (info) => {
			const page = host.pages().find((p) => p.id === pageId);
			if (page) changeMeta(host, setBookmark(metaOf(host), pageId, info));
		},
		onRemove: () => changeMeta(host, removeBookmark(metaOf(host), pageId)),
	}).open();
}

/** Opens the page tags editor of `page`. */
export function editPageTags(host: OutlineHost, page: Page): void {
	const index = host.pages().indexOf(page);
	if (index < 0 || !host.canEdit()) return;
	new PageTagsModal(host.app, index + 1, page.tags ?? [], pageTagCounts(host.pages()).map((c) => c.tag), (tags) => {
		const current = host.pages().find((p) => p.id === page.id);
		if (!current || !host.canEdit()) return;
		const before = current.tags ?? [];
		if (before.length === tags.length && before.every((x, i) => x === tags[i])) return;
		host.execute(new SetPageTags(page.id, before, tags));
	}).open();
}

/** Icon of an outline row: bookmarks use the colour dot, the others a Lucide icon. */
const MARKER_ICONS: Readonly<Record<string, string>> = { question: "help-circle", homework: "book-open-check", critical: "alert-triangle", star: "star", important: "alert-circle" };

function rowIcon(item: OutlineItem): string | null {
	switch (item.kind) {
		case "document": return "file-text";
		case "slide": return "presentation";
		case "heading": return "heading";
		case "marker": return MARKER_ICONS[item.marker?.kind ?? ""] ?? "circle";
		default: return null;
	}
}

function markerKindLabel(item: OutlineItem): string {
	return t(`markers.kind.${item.marker?.kind ?? "question"}` as MessageKey);
}

/** What a row says (an image replaces the text of a heading). */
export function outlineLabel(item: OutlineItem): string {
	switch (item.kind) {
		case "bookmark": return item.title || t("outline.untitled", { n: String(item.index + 1) });
		case "document": return item.title || t("outline.pdf");
		case "slide": return t("outline.slide", { n: String(item.slide?.page ?? item.index + 1) });
		case "heading": return t("outline.headingAlt", { n: String(item.index + 1) });
		default: return item.title || markerKindLabel(item);
	}
}

/**
 * The generated outline (roadmap #407): bookmarks, PDF slide changes, large handwriting and markers in one nested list,
 * built by the model (cached per page). Tap a row to jump to its page; bookmarks also have a "…" menu. `category`
 * filters the bookmarks (null: everything).
 */
export function renderOutline(
	list: HTMLElement,
	host: OutlineHost,
	state: { category: string | null; current: number },
	onCategory: (category: string | null) => void,
): void {
	const meta = host.meta();
	const editable = host.canEdit();
	const sources = host.sources();
	const bar = list.createDiv({ cls: "notebook-outline-bar" });
	const categories = sources.bookmarks ? categoriesInUse(meta, host.pages()) : [];
	const category = state.category !== null && categories.includes(state.category) ? state.category : null;
	if (categories.length > 0) {
		const select = bar.createEl("select", { cls: "dropdown notebook-outline-category", attr: { "aria-label": t("bookmark.modal.category") } });
		select.createEl("option", { text: t("outline.allCategories"), value: "" });
		for (const c of categories) select.createEl("option", { text: categoryLabel(c), value: c });
		select.value = category ?? "";
		select.addEventListener("change", () => onCategory(select.value === "" ? null : select.value));
	}
	if (editable) {
		const add = bar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("outline.add"), type: "button" } });
		setIcon(add, "bookmark-plus");
		add.addEventListener("click", () => {
			const page = host.pages()[state.current];
			if (page) editBookmark(host, page.id);
		});
	}
	const all = filterByCategory(host.outline().build({ pages: host.pages(), meta, assets: host.assets() }, sources), category);
	const box = list.createDiv({ cls: "nb-ui nb-outline" });
	if (all.length === 0) {
		const empty = box.createDiv({ cls: "nb-outline-empty" });
		setIcon(empty.createDiv({ cls: "nb-outline-empty-icon", attr: { "aria-hidden": "true" } }), "list-tree");
		const anyOn = sources.bookmarks || sources.slides || sources.headings || sources.markers;
		empty.createDiv({ cls: "nb-outline-empty-text", text: t(!anyOn ? "outline.allOff" : category !== null ? "outline.emptyCategory" : "outline.emptyAll") });
		return;
	}
	// Where you are: the last entry at or before the current page.
	let here = -1;
	all.forEach((e, i) => {
		if (e.index <= state.current) here = i;
	});
	all.forEach((e, i) => {
		const label = outlineLabel(e);
		const row = box.createDiv({
			cls: "nb-outline-row",
			attr: {
				tabindex: "0", role: "button", "data-index": String(e.index), "data-kind": e.kind, "data-depth": String(e.depth),
				"aria-label": `${label}, ${t("outline.pageNumber", { n: String(e.index + 1) })}`,
			},
		});
		row.toggleClass("is-current", i === here);
		row.setCssProps({ "--nb-outline-depth": String(Math.min(e.depth, 4) - 1) });
		const icon = row.createSpan({ cls: "nb-outline-icon", attr: { "aria-hidden": "true" } });
		const name = rowIcon(e);
		if (name) setIcon(icon, name);
		else {
			icon.addClass("is-dot");
			if (e.color) icon.setCssProps({ "--notebook-bookmark-color": e.color });
		}
		const text = row.createDiv({ cls: "nb-outline-text" });
		if (e.kind === "heading" && e.heading) {
			const url = host.headingImage(e);
			if (url) text.createEl("img", { cls: "nb-outline-ink", attr: { src: url, alt: label, draggable: "false" } });
			else text.createDiv({ cls: "nb-outline-title", text: label });
		} else {
			text.createDiv({ cls: `nb-outline-title${e.kind === "document" || e.kind === "bookmark" ? " is-strong" : ""}`, text: label });
			if (e.kind === "bookmark" && e.category) text.createDiv({ cls: "nb-outline-meta", text: categoryLabel(e.category) });
			if (e.kind === "marker" && e.title) text.createDiv({ cls: "nb-outline-meta", text: markerKindLabel(e) });
			if (e.kind === "marker" && e.marker?.done) text.createDiv({ cls: "nb-outline-meta", text: t("outline.markerDone") });
		}
		row.createSpan({ cls: "nb-outline-page", text: t("outline.pageNumber", { n: String(e.index + 1) }) });
		if (editable && e.kind === "bookmark") {
			const more = row.createEl("button", { cls: "nb-outline-more", attr: { "aria-label": t("outline.menu"), type: "button" } });
			setIcon(more, "more-vertical");
			more.addEventListener("click", (ev) => {
				ev.stopPropagation();
				const menu = new Menu();
				menu.addItem((it) => it.setTitle(t("outline.edit")).setIcon("pencil").onClick(() => editBookmark(host, e.pageId)));
				menu.addItem((it) => it.setTitle(t("outline.delete")).setIcon("trash-2").setSection("danger")
					.onClick(() => changeMeta(host, removeBookmark(metaOf(host), e.pageId))));
				menu.showAtMouseEvent(ev);
			});
		}
		row.addEventListener("click", () => host.goTo(e.index));
		row.addEventListener("keydown", (ev) => {
			if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) {
				ev.preventDefault();
				host.goTo(e.index);
			}
		});
	});
}

interface BookmarkModalOptions {
	pageNumber: number;
	exists: boolean;
	info: BookmarkInfo;
	customCategories: string[];
	onSave(info: BookmarkInfo): void;
	onRemove(): void;
}

const CUSTOM = "\u0000custom";

/** Title, colour and category of a bookmark. */
export class BookmarkModal extends Modal {
	private readonly info: BookmarkInfo;

	constructor(app: App, private readonly opts: BookmarkModalOptions) {
		super(app);
		this.info = { ...opts.info };
	}

	onOpen(): void {
		const o = this.opts;
		this.setTitle(t("bookmark.modal.title", { n: String(o.pageNumber) }));
		const save = () => {
			this.close();
			o.onSave({ ...this.info });
		};
		new Setting(this.contentEl).setName(t("bookmark.modal.name")).addText((text) => {
			text.setPlaceholder(t("bookmark.modal.namePlaceholder", { n: String(o.pageNumber) }))
				.setValue(this.info.title ?? "")
				.onChange((v) => (this.info.title = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					save();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		const colours = new Setting(this.contentEl).setName(t("bookmark.modal.color"));
		const swatches = colours.controlEl.createDiv({ cls: "notebook-bookmark-swatches" });
		const paint = () => {
			swatches.querySelectorAll<HTMLElement>(".notebook-bookmark-swatch").forEach((el) => {
				const on = (el.dataset.color ?? "") === (this.info.color ?? "");
				el.toggleClass("is-active", on);
				el.setAttribute("aria-pressed", String(on));
			});
		};
		const swatch = (color: string | null) => {
			const b = swatches.createEl("button", {
				cls: "notebook-bookmark-swatch",
				attr: { type: "button", "aria-label": color ?? t("bookmark.modal.defaultColor"), title: color ?? t("bookmark.modal.defaultColor") },
			});
			b.dataset.color = color ?? "";
			if (color) b.setCssProps({ "--notebook-bookmark-color": color });
			else {
				b.addClass("is-default");
				const fallback = bookmarkColor({ category: this.info.category });
				if (fallback) b.setCssProps({ "--notebook-bookmark-color": fallback });
			}
			b.addEventListener("click", () => {
				if (color) this.info.color = color;
				else delete this.info.color;
				paint();
			});
		};
		swatch(null);
		for (const c of BOOKMARK_COLORS) swatch(c);
		paint();

		let customSetting: Setting | null = null;
		const showCustom = (show: boolean) => customSetting?.settingEl.toggleClass("notebook-hidden", !show);
		new Setting(this.contentEl).setName(t("bookmark.modal.category")).addDropdown((dd) => {
			dd.addOption("", t("bookmark.modal.categoryNone"));
			for (const c of BOOKMARK_CATEGORIES) dd.addOption(c, categoryLabel(c));
			const custom = [...new Set([...o.customCategories, ...(this.info.category && !isBuiltInCategory(this.info.category) ? [this.info.category] : [])])];
			for (const c of custom) dd.addOption(c, c);
			dd.addOption(CUSTOM, t("bookmark.modal.categoryCustom"));
			dd.setValue(this.info.category ?? "");
			dd.onChange((v) => {
				if (v === CUSTOM) {
					showCustom(true);
					return;
				}
				showCustom(false);
				if (v) this.info.category = v;
				else delete this.info.category;
				// The "category colour" swatch follows the chosen category.
				const def = swatches.querySelector<HTMLElement>(".notebook-bookmark-swatch.is-default");
				const fallback = bookmarkColor({ category: this.info.category });
				def?.setCssProps({ "--notebook-bookmark-color": fallback ?? "" });
			});
		});
		customSetting = new Setting(this.contentEl).setName(t("bookmark.modal.customName")).addText((text) => {
			text.onChange((v) => {
				const name = v.trim();
				if (name) this.info.category = name;
				else delete this.info.category;
			});
		});
		showCustom(false);

		const buttons = new Setting(this.contentEl);
		if (o.exists) {
			buttons.addButton((b) => setDestructive(b.setButtonText(t("bookmark.modal.remove"))).onClick(() => {
				this.close();
				o.onRemove();
			}));
		}
		buttons
			.addButton((b) => b.setButtonText(t("library.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("bookmark.modal.save")).setCta().onClick(save));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Tags of one page: a comma-separated field plus the tags used on other pages as toggle chips. */
export class PageTagsModal extends Modal {
	private input: HTMLInputElement | null = null;

	constructor(
		app: App,
		private readonly pageNumber: number,
		private readonly current: readonly string[],
		private readonly existing: readonly string[],
		private readonly onSave: (tags: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("pageTags.modal.title", { n: String(this.pageNumber) }));
		const read = () => parsePageTagInput(this.input?.value ?? "");
		const save = () => {
			this.close();
			this.onSave(read());
		};
		let chips: HTMLElement | null = null;
		const sync = () => {
			const active = new Set(read().map((x) => x.toLowerCase()));
			chips?.querySelectorAll<HTMLElement>(".notebook-lib-chip").forEach((el) => {
				const on = active.has((el.dataset.tag ?? "").toLowerCase());
				el.toggleClass("is-active", on);
				el.setAttribute("aria-pressed", String(on));
			});
		};
		new Setting(this.contentEl)
			.setDesc(t("pageTags.modal.desc"))
			.addText((text) => {
				this.input = text.inputEl;
				text.setPlaceholder(t("pageTags.modal.placeholder")).setValue(this.current.join(", ")).onChange(sync);
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						save();
					}
				});
				window.setTimeout(() => text.inputEl.focus(), 0);
			});
		if (this.existing.length > 0) {
			this.contentEl.createDiv({ text: t("pageTags.modal.suggestions"), cls: "notebook-lib-modal-label" });
			chips = this.contentEl.createDiv({ cls: "notebook-lib-chips" });
			for (const tag of this.existing) {
				const chip = chips.createEl("button", { text: tag, cls: "notebook-lib-chip", attr: { type: "button" } });
				chip.dataset.tag = tag;
				chip.addEventListener("click", () => {
					const tags = read();
					const key = tag.toLowerCase();
					const next = tags.some((x) => x.toLowerCase() === key) ? tags.filter((x) => x.toLowerCase() !== key) : [...tags, tag];
					if (this.input) this.input.value = next.join(", ");
					sync();
				});
			}
			sync();
		}
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("library.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("pageTags.modal.save")).setCta().onClick(save));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
