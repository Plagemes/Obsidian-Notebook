/**
 * 0.26 gallery (#421): the small builder behind the command "Insert gallery block". It only writes text into the note being edited
 * (through the `onInsert` callback), never anything to the vault by itself.
 */
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { modalShell, shellButton, shellCheck, shellField, shellNote } from "../ui/components/modal-shell";
import { MARKER_KINDS } from "../model/types";
import { normalizePageTag } from "../model/page-tags";
import { emptyGalleryQuery, formatGalleryQuery, GALLERY_DEFAULT_LIMIT, type GalleryQuery, type GallerySort } from "./gallery-query";
import type { GalleryData } from "./gallery-service";

const LIMITS = [6, 12, 24, 48] as const;

/** The text to put in the note at the cursor: on its own lines, so a block never lands inside a sentence. */
export function galleryInsertText(block: string, atLineStart: boolean): string {
	return `${atLineStart ? "" : "\n"}${block}\n`;
}

export class GalleryBuilderModal extends Modal {
	private query: GalleryQuery = emptyGalleryQuery();
	private preview!: HTMLElement;

	constructor(app: App, private readonly data: Pick<GalleryData, "courses" | "tags">, private readonly onInsert: (block: string) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("gallery.builder.title"), subtitle: t("gallery.builder.subtitle"), icon: "layout-grid", size: "medium", cls: "nb-gallery-builder" });
		const body = shell.body;

		const tagF = shellField(body, t("gallery.builder.tag"), "nb-gal-tag");
		const tag = tagF.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-gal-tag", type: "text", list: "nb-gal-tags", placeholder: t("gallery.builder.tag.placeholder"), "data-key": "gal-tag" } });
		const list = tagF.createEl("datalist", { attr: { id: "nb-gal-tags" } });
		void this.data.tags().then((tags) => {
			for (const x of tags.slice(0, 40)) list.createEl("option", { attr: { value: x } });
		}, () => undefined);
		tag.addEventListener("input", () => {
			const one = normalizePageTag(tag.value);
			this.query.tags = one ? [one] : [];
			this.refresh();
		});

		const courses = this.data.courses();
		if (courses.length > 0) {
			const courseF = shellField(body, t("gallery.builder.course"), "nb-gal-course");
			const course = courseF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-gal-course", "data-key": "gal-course" } });
			course.createEl("option", { text: t("gallery.builder.any"), attr: { value: "" } });
			for (const c of courses) course.createEl("option", { text: c, attr: { value: c } });
			course.addEventListener("change", () => {
				this.query.courses = course.value ? [course.value] : [];
				this.refresh();
			});
		}

		const kindF = shellField(body, t("gallery.builder.kind"), "nb-gal-kind");
		const kind = kindF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-gal-kind", "data-key": "gal-kind" } });
		kind.createEl("option", { text: t("gallery.builder.any"), attr: { value: "" } });
		for (const k of MARKER_KINDS) kind.createEl("option", { text: t(`markers.kind.${k}`), attr: { value: k } });
		kind.addEventListener("change", () => {
			this.query.marked = kind.value ? [kind.value] : [];
			this.refresh();
		});

		shellCheck(body, t("gallery.builder.bookmarked"), false, (on) => {
			this.query.bookmarked = on;
			this.refresh();
		});

		const row = body.createDiv({ cls: "nb-modal-inputrow nb-gal-row" });
		const limitF = row.createDiv({ cls: "nb-modal-field" });
		limitF.createEl("label", { cls: "nb-modal-label", text: t("gallery.builder.limit"), attr: { for: "nb-gal-limit" } });
		const limit = limitF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-gal-limit", "data-key": "gal-limit" } });
		for (const n of LIMITS) limit.createEl("option", { text: String(n), attr: { value: String(n) } });
		limit.value = String(GALLERY_DEFAULT_LIMIT);
		limit.addEventListener("change", () => {
			this.query.limit = Number(limit.value);
			this.refresh();
		});
		const sortF = row.createDiv({ cls: "nb-modal-field" });
		sortF.createEl("label", { cls: "nb-modal-label", text: t("gallery.builder.sort"), attr: { for: "nb-gal-sort" } });
		const sort = sortF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-gal-sort", "data-key": "gal-sort" } });
		sort.createEl("option", { text: t("gallery.builder.sort.recent"), attr: { value: "recent" } });
		sort.createEl("option", { text: t("gallery.builder.sort.title"), attr: { value: "title" } });
		sort.addEventListener("change", () => {
			this.query.sort = sort.value as GallerySort;
			this.refresh();
		});

		const previewF = shellField(body, t("gallery.builder.preview"));
		this.preview = previewF.createEl("pre", { cls: "nb-gallery-preview" });
		shellNote(body, t("gallery.builder.hint"));
		this.refresh();

		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("gallery.builder.insert"), () => {
			this.onInsert(formatGalleryQuery(this.query));
			this.close();
		}, { icon: "plus" });
	}

	private refresh(): void {
		this.preview.setText(formatGalleryQuery(this.query));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
