/**
 * The creation dialog (wave 0.12): one modal with two tabs, Notebook and Folder (DESIGN.md, the creation mock-ups).
 *
 * - Notebook: a portrait cover preview (generated art in a colour, or an image) with "Change cover"; name, description,
 *   folder, page template (paper tiles drawn by the real paper renderer), page size (A4 · A5 · B5 · Letter · Custom) and
 *   orientation. The host creates the file through the normal path (storage/notebooks.ts) and opens it.
 * - Folder: a preview that is the library's own subject card (ui/components/subject-card.ts: glossy folder icon with the
 *   chosen symbol, name, description, line art), with "Change colour" and "Change pattern"; name, description,
 *   location, icon (a row plus a Lucide icon search) and colour (eight subject colours and a custom picker). The host
 *   creates the vault folder and stores its look in the folder metadata (library/folder-meta-store.ts).
 *
 * Names are checked as they are typed (empty, invalid characters, taken); Enter submits; every control is a real button
 * reachable with pen, finger and keyboard. On a phone the dialog is a full-height sheet with the preview on top (CSS).
 * Nothing is written until the create button is pressed, and a failed creation keeps the dialog open with what was typed.
 */
import { getIconIds, Modal, setIcon, SuggestModal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { createId, createPage } from "../model/document";
import { COVER_ART_STYLES, META_DESCRIPTION_MAX, PAPER_KINDS, PAPER_SPACING, type CoverArtStyle, type NotebookDocument, type PageSizeName, type PaperKind } from "../model/types";
import { FOLDER_DESCRIPTION_MAX, type FolderMeta } from "../library/folder-meta";
import { renderThumbnail } from "../library/thumbnail";
import { artEnabled, artImage, artStyleFor, coverImage, type ArtSpec } from "../ui/art/generative-art";
import { subjectCard } from "../ui/components/subject-card";
import { colorFor, SUBJECT_COLORS } from "../ui/palette";
import { ColourPicker } from "./colour-picker";
import {
	CUSTOM_MAX_MM, CUSTOM_MIN_MM, customSide, depthBelow, folderChoices, joinPath, MAX_NAME, nameProblem, nextArtStyle, pageSize,
	SIZE_CHOICES, startFolder, type NameProblem, type NotebookSpec, type SizeChoice,
} from "./create-logic";
import type { PickedFile } from "./pick";

export type CreateTab = "notebook" | "folder";

/** What the Folder tab decided. */
export interface FolderSpec {
	name: string;
	description: string;
	parent: string;
	icon: string;
	color: string;
	art: CoverArtStyle;
}

export interface CreateDialogHost {
	/** The notebooks folder. */
	root(): string;
	/** Every folder path of the vault. */
	allFolders(): string[];
	/** Whether something exists at this vault path. */
	exists(path: string): boolean;
	/** The stored look of a folder (colour, icon), for the folder list. */
	folderMeta?(path: string): FolderMeta | null;
	defaults(): { size: PageSizeName; landscape: boolean; paper: PaperKind };
	/** The folder the last notebook or folder was created in, on this device. */
	lastFolder(): string | null;
	/** Opens the template gallery (absent: no template button). */
	pickTemplate?(done: (template: { name: string; doc: NotebookDocument }) => void): void;
	/** Lets the user pick an image (vault or device) for the cover. */
	pickImage(): Promise<PickedFile | null>;
	/** Creates and opens the notebook. Resolves false (the dialog stays open) when it failed; the host told the user why. */
	createNotebook(spec: NotebookSpec, extras: { image?: PickedFile; template?: { name: string; doc: NotebookDocument } }): Promise<boolean>;
	createFolder(spec: FolderSpec): Promise<boolean>;
}

/** Icons offered directly on the Folder tab (DESIGN.md subjects); "More icons…" searches every Lucide icon. */
export const FOLDER_ICONS = ["folder", "graduation-cap", "heart-pulse", "flask-conical", "sigma", "brain", "atom"] as const;

const dpr = () => Math.min(3, activeWindow.devicePixelRatio || 1);
/** The surface the art sits on (the real engine draws deeper lines on light themes). */
const surface = (): ArtSpec["surface"] => (activeDocument.body.hasClass("theme-light") ? "light" : "dark");
/** A CSS image value for a decoration: `none` when the art is off (reduced motion: artImage returns ""). */
const cssImage = (url: string) => (url ? `url("${url}")` : "none");

/** Paper tile previews, by kind and page size (each is drawn once by the real paper renderer). */
const paperPreviews = new Map<string, string>();
function paperPreview(kind: PaperKind, size: { width: number; height: number }): string {
	const px = Math.round(72 * dpr());
	const key = `${kind}|${size.width}x${size.height}|${px}`;
	let url = paperPreviews.get(key);
	if (url === undefined) {
		url = renderThumbnail(createPage(size, { kind, spacing: PAPER_SPACING[kind] }), px);
		if (paperPreviews.size > 200) paperPreviews.clear();
		paperPreviews.set(key, url);
	}
	return url;
}

function iconButton(parent: HTMLElement, icon: string, label: string, cls = ""): HTMLButtonElement {
	const b = parent.createEl("button", { cls: `nb-create-icon-button ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
	setIcon(b, icon);
	return b;
}

export class CreateDialog extends Modal {
	private tab: CreateTab;
	private readonly choices: string[];
	private readonly nb: NotebookSpec;
	private readonly fd: FolderSpec;
	/** The user picked a cover colour (else it follows the folder's colour). */
	private nbColorChosen = false;
	private coverOptionsOpen = false;
	private image: { file: PickedFile; url: string } | null = null;
	private template: { name: string; doc: NotebookDocument } | null = null;
	private customIcon: string | null = null;
	private customWidth = "210";
	private customHeight = "297";
	private busy = false;
	/** Shown after the first try to create, or once the name was typed. */
	private nameTouched = false;
	private picker: ColourPicker | null = null;
	private closePopover: (() => void) | null = null;
	/** Rebuilds the folder card (its art seed is the path) once typing pauses. */
	private cardTimer: number | null = null;

	constructor(app: App, private readonly host: CreateDialogHost, tab: CreateTab = "notebook", folder?: string) {
		super(app);
		this.tab = tab;
		this.choices = folderChoices(host.root(), host.allFolders());
		const start = startFolder(this.choices, folder, host.lastFolder());
		const d = host.defaults();
		const seed = createId();
		this.nb = {
			name: "", description: "", folder: start, paper: d.paper, size: d.size, customMm: { width: 210, height: 297 }, landscape: d.landscape,
			color: host.folderMeta?.(start)?.color ?? colorFor(seed), art: { style: artStyleFor(seed), seed },
		};
		this.fd = { name: "", description: "", parent: start, icon: "folder", color: SUBJECT_COLORS[0]!.base, art: "contours" };
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-create-modal");
		this.titleEl.empty();
		this.render();
	}

	onClose(): void {
		this.cancelCardRefresh();
		this.closePopover?.();
		this.picker?.destroy();
		if (this.image) URL.revokeObjectURL(this.image.url);
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------ layout

	private render(focusName = true): void {
		this.cancelCardRefresh();
		this.closePopover?.();
		this.picker?.destroy();
		this.picker = null;
		const el = this.contentEl;
		el.empty();
		el.toggleClass("is-folder", this.tab === "folder");
		const head = el.createDiv({ cls: "nb-create-head" });
		// Decoration only: a faint band of the chosen colour's line art behind the header (off with reduced motion).
		const band = head.createDiv({ cls: "nb-create-band", attr: { "aria-hidden": "true" } });
		band.setCssProps({ "--nb-create-band": cssImage(artImage({ seed: "create-header", color: this.color(), style: this.tab === "folder" ? this.fd.art : this.nb.art.style, density: 0.4, intensity: 0.35, surface: surface() }, 480, 64)) });
		const tabs = head.createDiv({ cls: "nb-create-tabs", attr: { role: "tablist", "aria-label": t("create.tabs") } });
		for (const id of ["notebook", "folder"] as const) {
			const on = this.tab === id;
			const b = tabs.createEl("button", { cls: "nb-create-tab", text: t(id === "notebook" ? "create.tab.notebook" : "create.tab.folder"), attr: { type: "button", role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1" } });
			b.toggleClass("is-active", on);
			b.addEventListener("click", () => this.switchTab(id));
			b.addEventListener("keydown", (e) => {
				if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
					e.preventDefault();
					this.switchTab(id === "notebook" ? "folder" : "notebook");
					this.contentEl.querySelector<HTMLElement>(".nb-create-tab.is-active")?.focus();
				}
			});
		}
		iconButton(head, "x", t("create.close"), "nb-create-close").addEventListener("click", () => this.close());

		const body = el.createDiv({ cls: "nb-create-body" });
		const preview = body.createDiv({ cls: "nb-create-preview" });
		const form = body.createDiv({ cls: "nb-create-form" });
		if (this.tab === "notebook") {
			this.renderCover(preview);
			this.renderNotebookForm(form);
		} else {
			this.renderFolderPreview(preview);
			this.renderFolderForm(form);
		}

		const foot = el.createDiv({ cls: "nb-create-foot" });
		const cancel = foot.createEl("button", { cls: "nb-create-secondary", text: t("create.cancel"), attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const cta = foot.createEl("button", { cls: "nb-create-primary mod-cta", text: t(this.tab === "notebook" ? "create.notebook.cta" : "create.folder.cta"), attr: { type: "button" } });
		cta.disabled = this.busy;
		cta.addEventListener("click", () => void this.submit());

		el.onkeydown = (e) => {
			if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
			const target = e.target as HTMLElement | null;
			// Buttons, tiles and lists handle their own Enter (it presses them).
			if (target && (target.tagName === "BUTTON" || target.getAttribute("role") === "option" || target.closest(".notebook-colour-picker"))) return;
			e.preventDefault();
			void this.submit();
		};
		if (focusName) window.setTimeout(() => this.contentEl.querySelector<HTMLInputElement>(".nb-create-name")?.focus(), 0);
	}

	private color(): string {
		return this.tab === "folder" ? this.fd.color : this.nb.color;
	}

	private switchTab(tab: CreateTab): void {
		if (tab === this.tab) return;
		// The name typed so far carries over: the user may have started on the wrong tab.
		if (tab === "folder") {
			this.fd.name ||= this.nb.name;
			this.fd.parent = this.nb.folder;
		} else {
			this.nb.name ||= this.fd.name;
			this.nb.folder = this.fd.parent;
		}
		this.tab = tab;
		this.nameTouched = false;
		this.render();
	}

	private field(parent: HTMLElement, label: string, id: string): HTMLElement {
		const f = parent.createDiv({ cls: "nb-create-field" });
		f.createEl("label", { cls: "nb-create-label", text: label, attr: { for: id } });
		return f;
	}

	private group(parent: HTMLElement, label: string): HTMLElement {
		const f = parent.createDiv({ cls: "nb-create-field" });
		const id = `nb-create-${Math.random().toString(36).slice(2, 8)}`;
		f.createDiv({ cls: "nb-create-label", text: label, attr: { id } });
		return f.createDiv({ cls: "nb-create-group", attr: { role: "radiogroup", "aria-labelledby": id } });
	}

	// --------------------------------------------------------------- name etc.

	private nameField(form: HTMLElement): void {
		const spec = this.tab === "notebook" ? this.nb : this.fd;
		const f = this.field(form, t("create.name"), "nb-create-name");
		const input = f.createEl("input", {
			cls: "nb-create-input nb-create-name",
			attr: { id: "nb-create-name", type: "text", maxlength: String(MAX_NAME), autocomplete: "off", spellcheck: "false", "aria-required": "true",
				placeholder: t(this.tab === "notebook" ? "create.name.notebookPlaceholder" : "create.name.folderPlaceholder") },
		});
		input.value = spec.name;
		const error = f.createDiv({ cls: "nb-create-error", attr: { id: "nb-create-name-error", role: "alert" } });
		const show = () => {
			const problem = this.nameTouched ? this.nameProblem() : null;
			error.setText(problem ? this.problemText(problem) : "");
			input.toggleClass("is-invalid", !!problem);
			input.setAttribute("aria-invalid", String(!!problem));
			if (problem) input.setAttribute("aria-describedby", "nb-create-name-error");
			else input.removeAttribute("aria-describedby");
		};
		input.addEventListener("input", () => {
			spec.name = input.value;
			this.nameTouched = true;
			show();
			this.refreshPreview();
		});
		show();
	}

	private descriptionField(form: HTMLElement): void {
		const spec = this.tab === "notebook" ? this.nb : this.fd;
		const f = this.field(form, t("create.description"), "nb-create-description");
		const area = f.createEl("textarea", {
			cls: "nb-create-input nb-create-description",
			attr: { id: "nb-create-description", rows: "2", maxlength: String(this.tab === "notebook" ? META_DESCRIPTION_MAX : FOLDER_DESCRIPTION_MAX), placeholder: t("create.description.placeholder") },
		});
		area.value = spec.description;
		area.addEventListener("input", () => {
			spec.description = area.value;
			this.refreshPreview();
		});
	}

	private nameProblem(): NameProblem | null {
		if (this.tab === "notebook") {
			return nameProblem(this.nb.name, (clean) => this.host.exists(joinPath(this.nb.folder, `${clean}.notebook`)));
		}
		return nameProblem(this.fd.name, (clean) => this.host.exists(joinPath(this.fd.parent, clean)));
	}

	private problemText(p: NameProblem): string {
		const name = (this.tab === "notebook" ? this.nb.name : this.fd.name).trim();
		switch (p) {
			case "empty": return t("create.error.empty");
			case "chars": return t("create.error.chars");
			case "dot": return t("create.error.dot");
			case "long": return t("create.error.long", { max: String(MAX_NAME) });
			case "exists": return t(this.tab === "notebook" ? "create.error.notebookExists" : "create.error.folderExists", { name });
		}
	}

	/** The folder list: a button that opens a list of folders with their icons (and colours). */
	private folderField(form: HTMLElement, label: string, value: string, set: (path: string) => void): void {
		const f = this.field(form, label, "nb-create-folder");
		const wrap = f.createDiv({ cls: "nb-create-select-wrap" });
		const button = wrap.createEl("button", { cls: "nb-create-select", attr: { id: "nb-create-folder", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" } });
		const fill = (el: HTMLElement, path: string) => {
			const icon = el.createSpan({ cls: "nb-create-folder-icon" });
			const meta = this.host.folderMeta?.(path);
			setIcon(icon, meta?.icon ?? "folder");
			if (meta?.color) icon.setCssProps({ "--nb-folder-color": meta.color });
			el.createSpan({ cls: "nb-create-select-text", text: this.folderLabel(path) });
		};
		fill(button, value);
		setIcon(button.createSpan({ cls: "nb-create-select-chevron" }), "chevron-down");
		button.addEventListener("click", () => {
			if (this.closePopover) return this.closePopover();
			button.setAttribute("aria-expanded", "true");
			const list = wrap.createDiv({ cls: "nb-create-options", attr: { role: "listbox", "aria-label": label } });
			const options: HTMLElement[] = [];
			for (const path of this.choices) {
				const on = path === value;
				const o = list.createDiv({ cls: "nb-create-option", attr: { role: "option", tabindex: "-1", "aria-selected": String(on) } });
				o.toggleClass("is-active", on);
				o.setCssProps({ "--nb-depth": String(Math.min(6, depthBelow(this.host.root(), path))) });
				fill(o, path);
				const pick = () => {
					close();
					set(path);
					this.render(false);
					this.contentEl.querySelector<HTMLElement>("#nb-create-folder")?.focus();
				};
				o.addEventListener("click", pick);
				o.addEventListener("keydown", (e) => {
					const i = options.indexOf(o);
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						pick();
					} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						options[Math.max(0, Math.min(options.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						close();
						button.focus();
					}
				});
				options.push(o);
			}
			const outside = (e: PointerEvent) => {
				if (!wrap.contains(e.target as Node)) close();
			};
			const close = () => {
				list.remove();
				button.setAttribute("aria-expanded", "false");
				activeDocument.removeEventListener("pointerdown", outside, true);
				this.closePopover = null;
			};
			activeDocument.addEventListener("pointerdown", outside, true);
			this.closePopover = close;
			(options.find((o) => o.hasClass("is-active")) ?? options[0])?.focus();
		});
	}

	private folderLabel(path: string): string {
		const root = this.host.root().replace(/^\/+|\/+$/g, "");
		if (path === root) return root ? root.slice(root.lastIndexOf("/") + 1) : t("create.vaultRoot");
		return root ? path.slice(root.length + 1) : path;
	}

	/** A row of radio tiles; arrow keys move the choice. */
	private radioTiles<T extends string>(group: HTMLElement, items: ReadonlyArray<{ id: T; label: string; build?: (tile: HTMLElement) => void; cls?: string }>, value: T, set: (id: T) => void): void {
		const tiles: HTMLButtonElement[] = [];
		items.forEach((item, i) => {
			const on = item.id === value;
			const tile = group.createEl("button", { cls: `nb-create-tile ${item.cls ?? ""}`.trim(), attr: { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "aria-label": item.label, title: item.label } });
			tile.toggleClass("is-active", on);
			item.build?.(tile);
			tile.addEventListener("click", () => set(item.id));
			tile.addEventListener("keydown", (e) => {
				const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
				if (!d) return;
				e.preventDefault();
				const next = items[(i + d + items.length) % items.length]!;
				set(next.id);
				this.contentEl.querySelector<HTMLElement>(`.nb-create-tile[data-id="${next.id}"]`)?.focus();
			});
			tile.dataset.id = item.id;
			tiles.push(tile);
		});
		if (!tiles.some((x) => x.hasClass("is-active")) && tiles[0]) tiles[0].tabIndex = 0;
	}

	// ---------------------------------------------------------------- notebook

	private coverUrl(w: number, h: number): string {
		return this.image ? this.image.url : coverImage({ seed: this.nb.art.seed, color: this.nb.color, style: this.nb.art.style, surface: surface() }, w, h, dpr());
	}

	private renderCover(preview: HTMLElement): void {
		preview.setCssProps({ "--nb-create-glow": this.nb.color });
		const frame = preview.createDiv({ cls: "nb-create-cover-frame" });
		frame.createDiv({ cls: "nb-create-glow", attr: { "aria-hidden": "true" } });
		const cover = frame.createEl("button", { cls: "nb-create-cover", attr: { type: "button", "aria-label": t("create.cover.next") } });
		cover.createEl("img", { cls: "nb-create-cover-img", attr: { src: this.coverUrl(180, 252), alt: "" } });
		cover.createDiv({ cls: "nb-create-cover-title", text: this.nb.name.trim() || t("create.tab.notebook") });
		cover.createDiv({
			cls: "nb-create-badge",
			text: this.image ? t("create.cover.badge.image") : t(`create.style.${this.nb.art.style}` as MessageKey),
		});
		cover.addEventListener("click", () => {
			if (this.image) return this.toggleCoverOptions();
			this.nb.art = { ...this.nb.art, style: nextArtStyle(this.nb.art.style) };
			this.render(false);
		});
		const actions = preview.createDiv({ cls: "nb-create-row nb-create-preview-actions" });
		const change = actions.createEl("button", { cls: "nb-create-secondary nb-create-change", attr: { type: "button", "aria-expanded": String(this.coverOptionsOpen) } });
		setIcon(change.createSpan({ cls: "nb-create-button-icon" }), "palette");
		change.createSpan({ text: t("create.cover.change") });
		change.addEventListener("click", () => this.toggleCoverOptions());
		// A new variation of the same pattern (a new seed), like the Folder tab's pattern button.
		if (!this.image) {
			iconButton(actions, "shuffle", t("create.cover.shuffle"), "nb-create-reseed").addEventListener("click", () => {
				this.nb.art = { ...this.nb.art, seed: createId() };
				this.render(false);
				this.contentEl.querySelector<HTMLElement>(".nb-create-reseed")?.focus();
			});
		}
		if (this.coverOptionsOpen) this.renderCoverOptions(preview);
	}

	private toggleCoverOptions(): void {
		this.coverOptionsOpen = !this.coverOptionsOpen;
		this.render(false);
		this.contentEl.querySelector<HTMLElement>(".nb-create-change")?.focus();
	}

	private renderCoverOptions(preview: HTMLElement): void {
		const box = preview.createDiv({ cls: "nb-create-cover-options" });
		if (!this.image) {
			const styles = this.group(box, t("create.cover.style"));
			styles.addClass("nb-create-styles");
			this.radioTiles(styles, COVER_ART_STYLES.map((style) => ({
				id: style, label: t(`create.style.${style}` as MessageKey), cls: "nb-create-style",
				build: (tile: HTMLElement) => void tile.createEl("img", { attr: { src: coverImage({ seed: this.nb.art.seed, color: this.nb.color, style, surface: surface() }, 36, 50, dpr()), alt: "" } }),
			})), this.nb.art.style, (style) => {
				this.nb.art = { ...this.nb.art, style };
				this.render(false);
			});
			const colors = this.group(box, t("create.cover.color"));
			this.swatches(colors, this.nb.color, (c) => {
				this.nb.color = c;
				this.nbColorChosen = true;
				this.render(false);
			});
		}
		const row = box.createDiv({ cls: "nb-create-row" });
		const image = row.createEl("button", { cls: "nb-create-secondary", attr: { type: "button" } });
		setIcon(image.createSpan({ cls: "nb-create-button-icon" }), this.image ? "image-off" : "image");
		image.createSpan({ text: t(this.image ? "create.cover.removeImage" : "create.cover.image") });
		image.addEventListener("click", () => {
			if (this.image) {
				URL.revokeObjectURL(this.image.url);
				this.image = null;
				this.render(false);
				return;
			}
			void this.host.pickImage().then((file) => {
				if (!file || file.bytes.byteLength === 0) return;
				const url = URL.createObjectURL(new Blob([file.bytes], file.type ? { type: file.type } : {}));
				this.image = { file, url };
				this.render(false);
			});
		});
	}

	private renderNotebookForm(form: HTMLElement): void {
		this.nameField(form);
		this.descriptionField(form);
		this.folderField(form, t("create.folder"), this.nb.folder, (path) => {
			this.nb.folder = path;
			// The cover follows the folder's colour until the user picks one.
			const c = this.host.folderMeta?.(path)?.color;
			if (c && !this.nbColorChosen) this.nb.color = c;
		});

		const tplRow = form.createDiv({ cls: "nb-create-field" });
		const size = pageSize(this.nb.size, this.nb.landscape, this.nb.customMm);
		if (this.template) {
			const chip = tplRow.createDiv({ cls: "nb-create-template" });
			setIcon(chip.createSpan({ cls: "nb-create-button-icon" }), "layout-template");
			chip.createSpan({ text: t("create.template.chosen", { name: this.template.name }) });
			iconButton(chip, "x", t("create.template.clear")).addEventListener("click", () => {
				this.template = null;
				this.render(false);
			});
			return;
		}
		tplRow.remove();
		const papers = this.group(form, t("create.paper"));
		papers.addClass("nb-create-papers");
		this.radioTiles(papers, PAPER_KINDS.map((kind) => ({
			id: kind, label: t(`paper.${kind}`), cls: "nb-create-paper",
			build: (tile: HTMLElement) => {
				// Decoration only: subtle line art behind the selected tile.
				if (kind === this.nb.paper) tile.setCssProps({ "--nb-create-tile-art": cssImage(artImage({ seed: kind, color: this.nb.color, style: this.nb.art.style, density: 0.3, intensity: 0.6, surface: surface() }, 96, 120)) });
				const thumb = tile.createDiv({ cls: "nb-create-paper-thumb" });
				thumb.createEl("img", { attr: { src: paperPreview(kind, size), alt: "" } });
				tile.createSpan({ cls: "nb-create-tile-label", text: t(`paper.${kind}`) });
			},
		})), this.nb.paper, (kind) => {
			this.nb.paper = kind;
			this.render(false);
		});
		const pick = this.host.pickTemplate?.bind(this.host);
		if (pick) {
			const b = form.createEl("button", { cls: "nb-create-link", attr: { type: "button" } });
			setIcon(b.createSpan({ cls: "nb-create-button-icon" }), "layout-template");
			b.createSpan({ text: t("create.template.use") });
			b.addEventListener("click", () => pick((template) => {
				this.template = template;
				this.render(false);
			}));
		}

		const sizes = this.group(form, t("create.size"));
		sizes.addClass("nb-create-chips");
		const sizeItems: Array<{ id: SizeChoice; label: string; cls: string }> = [
			...SIZE_CHOICES.map((s) => ({ id: s, label: t(`size.${s}`), cls: "nb-create-chip" })),
			{ id: "custom", label: t("create.size.custom"), cls: "nb-create-chip" },
		];
		this.radioTiles(sizes, sizeItems.map((it) => ({ ...it, build: (tile: HTMLElement) => void tile.setText(it.label) })), this.nb.size, (s) => {
			this.nb.size = s;
			this.render(false);
		});
		if (this.nb.size === "custom") this.customSize(form);

		const orient = this.group(form, t("create.orientation"));
		orient.addClass("nb-create-orient");
		this.radioTiles(orient, [
			{ id: "portrait", label: t("create.portrait"), icon: "rectangle-vertical" },
			{ id: "landscape", label: t("create.landscape"), icon: "rectangle-horizontal" },
		].map((o) => ({ id: o.id, label: o.label, cls: "nb-create-orient-tile", build: (tile: HTMLElement) => {
			setIcon(tile.createSpan({ cls: "nb-create-tile-icon" }), o.icon);
			tile.createSpan({ cls: "nb-create-tile-label", text: o.label });
		} })), this.nb.landscape ? "landscape" : "portrait", (o) => {
			this.nb.landscape = o === "landscape";
			this.render(false);
		});
	}

	private customSize(form: HTMLElement): void {
		const row = form.createDiv({ cls: "nb-create-custom" });
		const error = form.createDiv({ cls: "nb-create-error", attr: { role: "alert" } });
		const input = (label: string, value: string, set: (v: string) => void) => {
			const wrap = row.createEl("label", { cls: "nb-create-custom-side" });
			wrap.createSpan({ cls: "nb-create-label", text: label });
			const el = wrap.createEl("input", { cls: "nb-create-input", attr: { type: "number", inputmode: "decimal", min: String(CUSTOM_MIN_MM), max: String(CUSTOM_MAX_MM), step: "1" } });
			el.value = value;
			el.addEventListener("input", () => {
				set(el.value);
				check();
			});
			return el;
		};
		const w = input(t("create.custom.width"), this.customWidth, (v) => (this.customWidth = v));
		row.createSpan({ cls: "nb-create-times", text: "×" });
		const h = input(t("create.custom.height"), this.customHeight, (v) => (this.customHeight = v));
		const check = () => {
			const cw = customSide(this.customWidth);
			const ch = customSide(this.customHeight);
			w.toggleClass("is-invalid", cw === null);
			h.toggleClass("is-invalid", ch === null);
			error.setText(cw === null || ch === null ? t("create.custom.invalid", { min: String(CUSTOM_MIN_MM), max: String(CUSTOM_MAX_MM) }) : "");
			if (cw !== null && ch !== null) this.nb.customMm = { width: cw, height: ch };
		};
		check();
	}

	// ------------------------------------------------------------------ folder

	private renderFolderPreview(preview: HTMLElement): void {
		preview.setCssProps({ "--nb-create-glow": this.fd.color });
		const frame = preview.createDiv({ cls: "nb-create-card-frame" });
		frame.createDiv({ cls: "nb-create-glow", attr: { "aria-hidden": "true" } });
		this.folderCard(frame);
		const row = preview.createDiv({ cls: "nb-create-row nb-create-preview-actions" });
		const change = row.createEl("button", { cls: "nb-create-secondary nb-create-change", attr: { type: "button" } });
		setIcon(change.createSpan({ cls: "nb-create-button-icon" }), "palette");
		change.createSpan({ text: t("create.color.change") });
		change.addEventListener("click", () => {
			const i = SUBJECT_COLORS.findIndex((c) => c.base.toLowerCase() === this.fd.color.toLowerCase());
			this.fd.color = SUBJECT_COLORS[(i + 1) % SUBJECT_COLORS.length]!.base;
			this.render(false);
			this.contentEl.querySelector<HTMLElement>(".nb-create-change")?.focus();
		});
		iconButton(row, "shuffle", `${t("create.art.change")}: ${t(`create.style.${this.fd.art}` as MessageKey)}`, "nb-create-art").addEventListener("click", () => {
			this.fd.art = nextArtStyle(this.fd.art);
			this.render(false);
			this.contentEl.querySelector<HTMLElement>(".nb-create-art")?.focus();
		});
	}

	private renderFolderForm(form: HTMLElement): void {
		this.nameField(form);
		this.descriptionField(form);
		this.folderField(form, t("create.parent"), this.fd.parent, (path) => (this.fd.parent = path));

		const icons = this.group(form, t("create.icon"));
		icons.addClass("nb-create-icons");
		const ids: string[] = [...FOLDER_ICONS];
		const extra = this.customIcon ?? (ids.includes(this.fd.icon) ? null : this.fd.icon);
		if (extra && !ids.includes(extra)) ids.push(extra);
		this.radioTiles(icons, ids.map((id) => ({ id, label: t("create.icon.named", { name: id }), cls: "nb-create-icon-tile", build: (tile: HTMLElement) => setIcon(tile, id) })), this.fd.icon, (id) => {
			this.fd.icon = id;
			this.render(false);
		});
		iconButton(icons, "more-horizontal", t("create.icon.more"), "nb-create-icon-tile nb-create-more").addEventListener("click", () => {
			new IconSearchModal(this.app, (id) => {
				this.customIcon = id;
				this.fd.icon = id;
				this.render(false);
			}).open();
		});

		const colors = this.group(form, t("create.color"));
		this.swatches(colors, this.fd.color, (c) => {
			this.fd.color = c;
			this.render(false);
		});
	}

	/** The eight subject colours and a custom colour (the plugin's colour picker, under the row). */
	private swatches(group: HTMLElement, value: string, set: (c: string) => void): void {
		group.addClass("nb-create-swatches");
		const inPalette = SUBJECT_COLORS.some((c) => c.base.toLowerCase() === value.toLowerCase());
		this.radioTiles(group, SUBJECT_COLORS.map((c) => ({
			id: c.base, label: t(`create.colorName.${c.name.toLowerCase()}` as MessageKey), cls: "nb-create-swatch",
			build: (tile: HTMLElement) => tile.setCssProps({ "--nb-swatch": c.base }),
		})), inPalette ? (SUBJECT_COLORS.find((c) => c.base.toLowerCase() === value.toLowerCase())!.base) : "", set);
		const custom = group.createEl("button", {
			cls: "nb-create-tile nb-create-swatch nb-create-swatch-custom",
			attr: { type: "button", role: "radio", "aria-checked": String(!inPalette), "aria-label": t("create.color.custom"), title: t("create.color.custom") },
		});
		custom.toggleClass("is-active", !inPalette);
		if (!inPalette) custom.setCssProps({ "--nb-swatch": value });
		setIcon(custom, "plus");
		custom.addEventListener("click", () => {
			if (this.picker) {
				this.picker.destroy();
				this.picker = null;
				return;
			}
			const holder = group.parentElement ?? group;
			let last = value;
			this.picker = new ColourPicker(holder, value, [], {
				change: (hex, commit) => {
					last = hex;
					if (commit) {
						this.picker?.destroy();
						this.picker = null;
						set(hex);
					}
				},
				close: () => {
					this.picker?.destroy();
					this.picker = null;
					if (last !== value) set(last);
				},
			});
			this.picker.focus();
		});
	}

	/**
	 * The folder exactly as the library will show it: the shared subject card (tile), seeded with the path the folder will
	 * have, in its colour, symbol and art style; the description, else the empty count, as its meta line.
	 */
	private folderCard(frame: HTMLElement): HTMLElement {
		const name = this.fd.name.trim() || t("create.tab.folder");
		return subjectCard(frame, {
			name, color: this.fd.color, seed: joinPath(this.fd.parent, name), artStyle: this.fd.art, icon: this.fd.icon,
			lines: [this.folderMetaLine()], shape: "tile", art: artEnabled(),
		});
	}

	private folderMetaLine(): string {
		return this.fd.description.trim() || t("library.notebooks.many", { count: "0" });
	}

	private cancelCardRefresh(): void {
		if (this.cardTimer !== null) window.clearTimeout(this.cardTimer);
		this.cardTimer = null;
	}

	// ------------------------------------------------------------------ submit

	/** Updates the parts of the preview that show the name and description, without rebuilding the form (focus stays). */
	private refreshPreview(): void {
		if (this.tab === "notebook") {
			const title = this.contentEl.querySelector(".nb-create-cover-title");
			if (title) title.textContent = this.nb.name.trim() || t("create.tab.notebook");
			return;
		}
		// The text follows at once; the card (its art is seeded by the folder's path) is rebuilt when typing pauses.
		const card = this.contentEl.querySelector(".nb-create-card-frame .nb-subject-card");
		const title = card?.querySelector(".nb-subject-title");
		const meta = card?.querySelector(".nb-subject-meta");
		if (title) title.textContent = this.fd.name.trim() || t("create.tab.folder");
		if (meta) meta.textContent = this.folderMetaLine();
		this.cancelCardRefresh();
		this.cardTimer = window.setTimeout(() => {
			this.cardTimer = null;
			const frame = this.contentEl.querySelector<HTMLElement>(".nb-create-card-frame");
			const old = frame?.querySelector(".nb-subject-card");
			if (frame && old) old.replaceWith(this.folderCard(frame));
		}, 250);
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		this.nameTouched = true;
		const problem = this.nameProblem();
		const customBad = this.tab === "notebook" && this.nb.size === "custom" && !this.template
			&& (customSide(this.customWidth) === null || customSide(this.customHeight) === null);
		if (problem || customBad) {
			this.render(false);
			const target = problem ? ".nb-create-name" : ".nb-create-custom input.is-invalid";
			this.contentEl.querySelector<HTMLElement>(target)?.focus();
			return;
		}
		this.busy = true;
		this.contentEl.querySelector<HTMLButtonElement>(".nb-create-primary")?.setAttribute("disabled", "true");
		let ok = false;
		try {
			if (this.tab === "notebook") {
				const spec: NotebookSpec = { ...this.nb, name: this.nb.name.trim(), description: this.nb.description.trim() };
				ok = await this.host.createNotebook(spec, { ...(this.image ? { image: this.image.file } : {}), ...(this.template ? { template: this.template } : {}) });
			} else {
				ok = await this.host.createFolder({ ...this.fd, name: this.fd.name.trim(), description: this.fd.description.trim() });
			}
		} finally {
			this.busy = false;
		}
		if (ok) this.close();
		else this.contentEl.querySelector<HTMLButtonElement>(".nb-create-primary")?.removeAttribute("disabled");
	}
}

/** "More icons…": searches every Lucide icon Obsidian has. */
class IconSearchModal extends SuggestModal<string> {
	private readonly ids: string[];

	constructor(app: App, private readonly onPick: (id: string) => void) {
		super(app);
		this.ids = getIconIds().map((id) => id.replace(/^lucide-/, "")).filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64);
		this.setPlaceholder(t("create.icon.search"));
		this.emptyStateText = t("create.icon.none");
	}

	getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase().replace(/\s+/g, "-");
		const list = q ? this.ids.filter((id) => id.includes(q)) : this.ids;
		return list.slice(0, 80);
	}

	renderSuggestion(id: string, el: HTMLElement): void {
		el.addClass("nb-create-icon-suggestion");
		setIcon(el.createSpan({ cls: "nb-create-icon-suggestion-icon" }), id);
		el.createSpan({ text: id });
	}

	onChooseSuggestion(id: string): void {
		this.onPick(id);
	}
}
