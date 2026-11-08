/**
 * "Change cover…" (roadmap #53, 0.22): one dialog on the modal shell with four sources for a notebook's cover: a generated pattern
 * (the families of the creation dialog), an image from the vault or the device, a page of the notebook, or a designed template
 * with the notebook's title on generated art. Images and pages are moved and zoomed inside the card's 3:4 frame (model/cover-crop.ts).
 * The dialog only asks; nothing is written until "Use this cover" (a picture is baked small, stored next to the notebook as an
 * asset and set as `meta.coverArt`, all by the host). The maths and the template helpers are pure (model/), the painting is
 * ui/cover-compose.ts.
 */
import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { COVER_FAMILIES, decodeCoverArt, encodeCoverArt, type CoverFamily } from "../model/cover-family";
import { centeredCrop, clampCrop, COVER_PX, COVER_ZOOM_MAX, panCrop, zoomCrop, type Crop } from "../model/cover-crop";
import { COVER_TEMPLATES, type CoverTemplateId } from "../model/cover-template";
import type { CoverArt, CoverArtStyle } from "../model/types";
import { applyArt, artRef, resolveRef } from "../ui/art/art-ref";
import { hashString } from "../ui/art/prng";
import { artFamilyFor } from "../ui/art/generative-art";
import { chip } from "../ui/components/chip";
import { iconButton } from "../ui/components/dom";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { bakeCanvas, canvasJpeg, decodeSource, loadImage, loadTemplateArt, paintCrop, paintTemplate, sourceFromUrl, type CoverSource } from "../ui/cover-compose";
import type { PickedFile } from "../view/pick";
import { showNotice } from "../view/notice";
import { COVER_COLORS, DEFAULT_COVER } from "./scan";

export type CoverMode = "art" | "image" | "page" | "template";

/** What the dialog asks the host to do. A picture is JPEG bytes of the baked size. */
export interface CoverChange {
	/** The cover colour to set (absent: unchanged). */
	color?: string;
	/** A generated cover (no picture). */
	art?: { style: CoverArtStyle; seed: string };
	/** A baked picture to store as an asset and point the cover at. */
	picture?: { bytes: ArrayBuffer; name: string };
}

export interface CoverDialogHost {
	/** The notebook's name (the title on a template cover). */
	name: string;
	/** The cover colour now. */
	color: string;
	/** The cover now (undefined: a plain colour). */
	current: CoverArt | undefined;
	/** A stable seed for a first pattern (the notebook's id or path). */
	seed: string;
	pickImage(): Promise<PickedFile | null>;
	pageCount(): Promise<number>;
	/** The page drawn as a data URL about 1000 px wide ("" when it cannot be drawn). */
	pageImage(index: number): Promise<string>;
	apply(change: CoverChange): Promise<void>;
}

const surface = (): "light" | "dark" => (activeDocument.body.hasClass("theme-light") ? "light" : "dark");
const MODE_ICON: Record<CoverMode, string> = { art: "sparkles", image: "image", page: "file-text", template: "layout-template" };
const MODES: CoverMode[] = ["art", "image", "page", "template"];

export class CoverDialog extends Modal {
	private mode: CoverMode = "art";
	private family: CoverFamily;
	private seed: string;
	private color: string;
	private template: CoverTemplateId = "classic";
	private source: CoverSource | null = null;
	private crop: Crop = centeredCrop();
	private pageIndex = 0;
	private pages = -1;
	private pageBusy = false;
	private pageFailed = false;
	private imageFailed = false;
	private busy = false;
	private closed = false;
	private canvas: HTMLCanvasElement | null = null;
	private side: HTMLElement | null = null;
	private applyBtn: HTMLButtonElement | null = null;
	private templateArt: HTMLImageElement | null = null;
	private templateArtKey = "";
	private artCache: { key: string; img: HTMLImageElement } | null = null;
	private paintToken = 0;
	private raf = 0;
	private tiles: Array<{ id: CoverTemplateId; canvas: HTMLCanvasElement }> = [];

	constructor(app: App, private readonly dialogHost: CoverDialogHost) {
		super(app);
		const cur = dialogHost.current;
		const art = cur?.kind === "art" ? decodeCoverArt(cur) : null;
		this.family = art?.family ?? artFamilyFor(dialogHost.name || dialogHost.seed);
		this.seed = art?.seed ?? `${dialogHost.seed}`;
		this.color = dialogHost.color || DEFAULT_COVER;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("cover.title"), subtitle: this.dialogHost.name, icon: "image", color: this.color, size: "wide", cls: "nb-cover-dialog" });
		const edit = shell.body.createDiv({ cls: "nb-cover-edit" });
		const stage = edit.createDiv({ cls: "nb-cover-stage" });
		this.buildStage(stage);
		this.side = edit.createDiv({ cls: "nb-cover-side" });
		this.renderSide();
		shellNote(shell.body, t("cover.saved.note"));
		shellButton(shell.foot, "secondary", t("cover.cancel"), () => this.close());
		this.applyBtn = shellButton(shell.foot, "primary", t("cover.apply"), () => void this.submit());
		this.refreshApply();
		this.schedule();
	}

	onClose(): void {
		this.closed = true;
		this.paintToken++;
		if (this.raf) window.cancelAnimationFrame(this.raf);
		this.source = null;
		this.templateArt = null;
		this.artCache = null;
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------ the frame

	private buildStage(stage: HTMLElement): void {
		const frame = stage.createDiv({ cls: "nb-cover-frame" });
		const canvas = frame.createEl("canvas", { cls: "nb-cover-canvas", attr: { width: String(COVER_PX.w), height: String(COVER_PX.h), role: "img", "aria-label": t("cover.preview"), tabindex: "0" } });
		frame.createDiv({ cls: "nb-cover-spine", attr: { "aria-hidden": "true" } });
		this.canvas = canvas;
		this.bindCrop(canvas);
	}

	private get cropping(): boolean {
		return (this.mode === "image" || this.mode === "page") && this.source !== null;
	}

	private bindCrop(canvas: HTMLCanvasElement): void {
		const pointers = new Map<number, { x: number; y: number }>();
		let pinch = 0;
		const apply = (next: Crop) => {
			this.crop = next;
			this.syncZoom();
			this.schedule();
		};
		canvas.addEventListener("pointerdown", (e) => {
			if (!this.cropping) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {
				// A pointer that is already gone: the drag simply goes on without capture.
			}
			if (pointers.size === 2) pinch = this.pinchDistance(pointers);
			e.preventDefault();
		});
		canvas.addEventListener("pointermove", (e) => {
			const was = pointers.get(e.pointerId);
			if (!was || !this.source) return;
			const s = this.source.canvas;
			const w = canvas.getBoundingClientRect().width;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 1) apply(panCrop(s.width, s.height, this.crop, e.clientX - was.x, e.clientY - was.y, w));
			else if (pointers.size === 2) {
				const d = this.pinchDistance(pointers);
				if (pinch > 0 && d > 0) {
					const rect = canvas.getBoundingClientRect();
					const pts = [...pointers.values()];
					const fx = ((pts[0]!.x + pts[1]!.x) / 2 - rect.left) / rect.width;
					const fy = ((pts[0]!.y + pts[1]!.y) / 2 - rect.top) / rect.height;
					apply(zoomCrop(s.width, s.height, this.crop, this.crop.zoom * (d / pinch), fx, fy));
				}
				pinch = d;
			}
		});
		const end = (e: PointerEvent) => {
			pointers.delete(e.pointerId);
			pinch = pointers.size === 2 ? this.pinchDistance(pointers) : 0;
		};
		canvas.addEventListener("pointerup", end);
		canvas.addEventListener("pointercancel", end);
		canvas.addEventListener("wheel", (e) => {
			if (!this.cropping || !this.source) return;
			e.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const s = this.source.canvas;
			apply(zoomCrop(s.width, s.height, this.crop, this.crop.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height));
		}, { passive: false });
		canvas.addEventListener("keydown", (e) => {
			if (!this.cropping || !this.source) return;
			const s = this.source.canvas;
			const w = canvas.getBoundingClientRect().width;
			const step = 24;
			const move: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
			const m = move[e.key];
			if (m) apply(panCrop(s.width, s.height, this.crop, m[0], m[1], w));
			else if (e.key === "+" || e.key === "=") apply(zoomCrop(s.width, s.height, this.crop, this.crop.zoom * 1.15));
			else if (e.key === "-") apply(zoomCrop(s.width, s.height, this.crop, this.crop.zoom / 1.15));
			else return;
			e.preventDefault();
		});
	}

	private pinchDistance(pointers: Map<number, { x: number; y: number }>): number {
		const pts = [...pointers.values()];
		return pts.length < 2 ? 0 : Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
	}

	// ------------------------------------------------------------------ painting

	/** Draws the frame once per animation frame however many pointer events came in. */
	private schedule(): void {
		if (this.raf || this.closed) return;
		this.raf = window.requestAnimationFrame(() => {
			this.raf = 0;
			void this.paint();
		});
	}

	private async paint(): Promise<void> {
		const canvas = this.canvas;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx || this.closed) return;
		const token = ++this.paintToken;
		const w = canvas.width;
		const h = canvas.height;
		const alive = () => !this.closed && token === this.paintToken;
		if (this.mode === "image" || this.mode === "page") {
			if (this.source) paintCrop(ctx, w, h, this.source, this.crop);
			else {
				ctx.clearRect(0, 0, w, h);
				ctx.fillStyle = "rgba(127,127,127,0.12)";
				ctx.fillRect(0, 0, w, h);
			}
			return;
		}
		if (this.mode === "template") {
			const art = await this.ensureTemplateArt();
			if (!alive()) return;
			paintTemplate(ctx, w, h, { template: this.template, title: this.dialogHost.name, color: this.color, art });
			this.paintTiles(art);
			return;
		}
		const img = await this.coverArtImage();
		if (!alive()) return;
		ctx.clearRect(0, 0, w, h);
		if (img) ctx.drawImage(img, 0, 0, w, h);
		else {
			ctx.fillStyle = this.color;
			ctx.fillRect(0, 0, w, h);
		}
	}

	/** The generated cover for the pattern mode, kept while the choice stays the same. */
	private async coverArtImage(): Promise<HTMLImageElement | null> {
		const key = `${this.family}|${this.seed}|${this.color}|${surface()}`;
		if (this.artCache?.key === key) return this.artCache.img;
		const url = await resolveRef(artRef("cover", { seed: this.seed, color: this.color, style: this.family, surface: surface() }, 270, 360));
		const img = await loadImage(url);
		if (img) this.artCache = { key, img };
		return img;
	}

	private async ensureTemplateArt(): Promise<HTMLImageElement | null> {
		const key = `${this.family}|${this.seed}|${this.color}`;
		if (this.templateArtKey === key) return this.templateArt;
		const img = await loadTemplateArt(this.seed, this.family, this.color);
		this.templateArt = img;
		this.templateArtKey = key;
		return img;
	}

	private paintTiles(art: CanvasImageSource | null): void {
		for (const tile of this.tiles) {
			const ctx = tile.canvas.getContext("2d");
			if (ctx && tile.canvas.isConnected) paintTemplate(ctx, tile.canvas.width, tile.canvas.height, { template: tile.id, title: this.dialogHost.name, color: this.color, art });
		}
	}

	// ------------------------------------------------------------------ the controls

	private setMode(mode: CoverMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		// The image and the page are different sources: each keeps its own picture while the dialog is open.
		this.source = mode === "image" ? this.imageSource : mode === "page" ? this.pageSource : null;
		this.crop = centeredCrop();
		this.renderSide();
		this.refreshApply();
		this.schedule();
		if (mode === "page" && !this.pageSource && !this.pageBusy) void this.loadPage(this.pageIndex);
	}

	private imageSource: CoverSource | null = null;
	private pageSource: CoverSource | null = null;

	private renderSide(): void {
		const side = this.side;
		if (!side) return;
		side.empty();
		this.tiles = [];
		const modes = side.createDiv({ cls: "nb-cover-modes", attr: { role: "toolbar", "aria-label": t("cover.mode.group") } });
		for (const m of MODES) chip(modes, { label: t(`cover.mode.${m}` as MessageKey), icon: MODE_ICON[m], active: m === this.mode, key: `cover-mode:${m}`, onClick: () => this.setMode(m) });
		const body = side.createDiv({ cls: "nb-cover-controls" });
		if (this.mode === "art") this.renderArt(body);
		else if (this.mode === "image") this.renderImage(body);
		else if (this.mode === "page") this.renderPage(body);
		else this.renderTemplate(body);
	}

	private renderArt(body: HTMLElement): void {
		const group = body.createDiv({ cls: "nb-cover-group" });
		group.createDiv({ cls: "nb-cover-label", text: t("create.cover.style") });
		const styles = group.createDiv({ cls: "nb-cover-styles", attr: { role: "radiogroup", "aria-label": t("create.cover.style") } });
		for (const family of COVER_FAMILIES) {
			const b = styles.createEl("button", { cls: "nb-cover-style", attr: { type: "button", role: "radio", "aria-checked": String(family === this.family), "aria-label": t(`create.style.${family}` as MessageKey), title: t(`create.style.${family}` as MessageKey) } });
			b.toggleClass("is-active", family === this.family);
			const img = b.createEl("img", { attr: { alt: "", draggable: "false" } });
			applyArt(img, artRef("cover", { seed: this.seed, color: this.color, style: family, surface: surface() }, 36, 50), { set: (url) => img.setAttribute("src", url), onNone: () => img.remove() });
			b.addEventListener("click", () => {
				this.family = family;
				this.renderSide();
				this.schedule();
			});
		}
		this.colourRow(body);
		this.shuffleRow(body);
	}

	private colourRow(body: HTMLElement): void {
		const group = body.createDiv({ cls: "nb-cover-group" });
		group.createDiv({ cls: "nb-cover-label", text: t("create.cover.color") });
		const row = group.createDiv({ cls: "nb-cover-swatches", attr: { role: "radiogroup", "aria-label": t("create.cover.color") } });
		const colours = (COVER_COLORS as readonly string[]).some((c) => c.toLowerCase() === this.color.toLowerCase()) ? COVER_COLORS : [this.color, ...COVER_COLORS];
		for (const c of colours) {
			const on = c.toLowerCase() === this.color.toLowerCase();
			const b = row.createEl("button", { cls: "nb-cover-swatch", attr: { type: "button", role: "radio", "aria-checked": String(on), "aria-label": c } });
			b.setCssProps({ "--nb-cover-swatch": c });
			b.toggleClass("is-active", on);
			b.addEventListener("click", () => {
				this.color = c;
				this.renderSide();
				this.schedule();
			});
		}
	}

	private shuffleRow(body: HTMLElement): void {
		const row = body.createDiv({ cls: "nb-cover-actions" });
		iconButton(row, "shuffle", t("cover.shuffle"), () => {
			this.seed = `${hashString(`${this.seed}|${Math.random()}`).toString(36)}`;
			this.renderSide();
			this.schedule();
		}, "nb-cover-shuffle");
	}

	private renderImage(body: HTMLElement): void {
		const row = body.createDiv({ cls: "nb-cover-actions" });
		shellButton(row, "secondary", t(this.source ? "cover.image.another" : "cover.image.choose"), () => void this.chooseImage(), { icon: "image-plus" });
		if (!this.source) shellNote(body, t(this.imageFailed ? "cover.image.unreadable" : "cover.image.empty"), this.imageFailed ? "error" : "note");
		else this.cropControls(body);
	}

	private async chooseImage(): Promise<void> {
		const picked = await this.dialogHost.pickImage();
		if (!picked || this.closed) return;
		const src = await decodeSource(picked.bytes, picked.type);
		if (this.closed) return;
		this.imageFailed = !src;
		if (src) {
			this.imageSource = src;
			this.source = src;
			this.crop = centeredCrop();
		}
		this.renderSide();
		this.refreshApply();
		this.schedule();
	}

	private cropControls(body: HTMLElement): void {
		shellNote(body, t("cover.crop.hint"));
		const zoom = body.createDiv({ cls: "nb-cover-zoom" });
		zoom.createEl("label", { cls: "nb-cover-label", text: t("cover.crop.zoom"), attr: { for: "nb-cover-zoom" } });
		const input = zoom.createEl("input", { cls: "nb-cover-slider", attr: { id: "nb-cover-zoom", type: "range", min: "1", max: String(COVER_ZOOM_MAX), step: "0.01", value: String(this.crop.zoom) } });
		input.addEventListener("input", () => {
			const s = this.source?.canvas;
			if (!s) return;
			this.crop = zoomCrop(s.width, s.height, this.crop, Number(input.value));
			this.schedule();
		});
		iconButton(zoom, "scan", t("cover.crop.reset"), () => {
			this.crop = centeredCrop();
			this.syncZoom();
			this.schedule();
		}, "nb-cover-reset");
		if (this.source && (this.source.canvas.width < this.source.originalW || this.source.canvas.height < this.source.originalH)) {
			shellNote(body, t("cover.image.reduced", { w: String(this.source.canvas.width), h: String(this.source.canvas.height) }));
		}
	}

	private syncZoom(): void {
		const input = this.side?.querySelector<HTMLInputElement>(".nb-cover-slider");
		if (input) input.value = String(this.crop.zoom);
	}

	private renderPage(body: HTMLElement): void {
		if (this.pages === 0) {
			shellNote(body, t("cover.page.none"));
			return;
		}
		const row = body.createDiv({ cls: "nb-cover-pager" });
		const prev = iconButton(row, "chevron-left", t("cover.page.prev"), () => void this.loadPage(this.pageIndex - 1), "nb-cover-prev");
		row.createSpan({ cls: "nb-cover-label", text: t("cover.page.label") });
		const num = row.createEl("input", { cls: "nb-cover-page", attr: { type: "number", min: "1", max: String(Math.max(1, this.pages)), value: String(this.pageIndex + 1), "aria-label": t("cover.page.label"), inputmode: "numeric" } });
		row.createSpan({ cls: "nb-cover-of", text: this.pages > 0 ? t("cover.page.of", { n: String(this.pages) }) : "" });
		const next = iconButton(row, "chevron-right", t("cover.page.next"), () => void this.loadPage(this.pageIndex + 1), "nb-cover-next");
		prev.disabled = this.pageIndex <= 0 || this.pageBusy;
		next.disabled = this.pages > 0 && this.pageIndex >= this.pages - 1;
		num.addEventListener("change", () => void this.loadPage(Number(num.value) - 1));
		if (this.pageBusy) shellNote(body, t("cover.page.loading"));
		else if (this.pageFailed) shellNote(body, t("cover.page.failed"), "error");
		else if (this.source) this.cropControls(body);
	}

	private async loadPage(index: number): Promise<void> {
		if (this.pageBusy) return;
		this.pageBusy = true;
		this.pageFailed = false;
		try {
			if (this.pages < 0) this.pages = await this.dialogHost.pageCount();
			if (this.closed) return;
			if (this.pages === 0) return;
			const at = Math.min(this.pages - 1, Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0));
			this.pageIndex = at;
			if (this.mode === "page") this.renderSide();
			const src = await sourceFromUrl(await this.dialogHost.pageImage(at));
			if (this.closed) return;
			this.pageFailed = !src;
			if (src) {
				this.pageSource = src;
				if (this.mode === "page") {
					this.source = src;
					this.crop = centeredCrop();
				}
			}
		} catch (e) {
			console.error("[notebook] cover page", e);
			this.pageFailed = true;
		} finally {
			this.pageBusy = false;
		}
		if (this.closed) return;
		if (this.mode === "page") this.renderSide();
		this.refreshApply();
		this.schedule();
	}

	private renderTemplate(body: HTMLElement): void {
		const group = body.createDiv({ cls: "nb-cover-group" });
		group.createDiv({ cls: "nb-cover-label", text: t("cover.template.label") });
		const grid = group.createDiv({ cls: "nb-cover-templates", attr: { role: "radiogroup", "aria-label": t("cover.template.label") } });
		for (const id of COVER_TEMPLATES) {
			const label = t(`cover.template.${id}` as MessageKey);
			const b = grid.createEl("button", { cls: "nb-cover-template", attr: { type: "button", role: "radio", "aria-checked": String(id === this.template), "aria-label": label } });
			b.toggleClass("is-active", id === this.template);
			const canvas = b.createEl("canvas", { attr: { width: "90", height: "120", "aria-hidden": "true" } });
			b.createSpan({ cls: "nb-cover-template-name", text: label });
			this.tiles.push({ id, canvas });
			b.addEventListener("click", () => {
				this.template = id;
				this.renderSide();
				this.schedule();
			});
		}
		this.colourRow(body);
		this.shuffleRow(body);
		shellNote(body, t("cover.template.note"));
	}

	// ------------------------------------------------------------------ applying

	private canApply(): boolean {
		if (this.busy) return false;
		return this.mode === "art" || this.mode === "template" || this.source !== null;
	}

	private refreshApply(): void {
		if (this.applyBtn) this.applyBtn.disabled = !this.canApply();
	}

	private async submit(): Promise<void> {
		if (!this.canApply()) return;
		this.busy = true;
		this.refreshApply();
		try {
			const change = await this.buildChange();
			if (!change) {
				showNotice(t("cover.notice.encode"));
				return;
			}
			await this.dialogHost.apply(change);
			showNotice(t("cover.notice.done"));
			this.close();
		} catch (e) {
			console.error("[notebook] change cover", e);
			showNotice(t("cover.notice.failed", { error: (e as Error).message ?? String(e) }), 8000);
		} finally {
			this.busy = false;
			this.refreshApply();
		}
	}

	private async buildChange(): Promise<CoverChange | null> {
		if (this.mode === "art") {
			const art = encodeCoverArt(this.family, this.seed);
			return { color: this.color, art };
		}
		// Paint the picture once more at the baked size, so the file holds exactly what the frame showed.
		const canvas = bakeCanvas();
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		if (this.mode === "template") {
			const art = await this.ensureTemplateArt();
			paintTemplate(ctx, canvas.width, canvas.height, { template: this.template, title: this.dialogHost.name, color: this.color, art });
		} else if (this.source) {
			const s = this.source.canvas;
			paintCrop(ctx, canvas.width, canvas.height, this.source, clampCrop(s.width, s.height, this.crop));
		} else return null;
		const bytes = await canvasJpeg(canvas);
		if (!bytes) return null;
		return { ...(this.mode === "template" ? { color: this.color } : {}), picture: { bytes, name: "cover.jpg" } };
	}
}

/** Opens the dialog. */
export function openCoverDialog(app: App, host: CoverDialogHost): void {
	new CoverDialog(app, host).open();
}
