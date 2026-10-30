/**
 * v10 anchored excerpts (#105) in the notebook view: cutting a region of a page (the lasso selection, or a region
 * dragged after choosing the action), placing it on a page picked with the go-to-page picker or copying it to the
 * plugin clipboard (so it can be pasted in another notebook), and the jump back to the source when its badge is tapped
 * or "Go to source" is chosen. Snapshots are drawn with the page raster and stored as image assets through the vault.
 */
import { Notice, type App } from "obsidian";
import { t } from "../i18n";
import { captureClip } from "../ink/clipboard";
import type { BBox } from "../ink/hit-test";
import { drawPageRaster } from "../ink/page-raster";
import { apply, type Matrix } from "../ink/transform";
import { openNotebookAtPage, resolveNotebookFile } from "../integration/open";
import { createPage } from "../model/document";
import {
	clampSourceRegion, createExcerpt, elementAssetId, excerptBadgeAt, excerptRegion, excerptSourceName, excerptSourceState,
	MIN_EXCERPT_SIDE, placeExcerpt, type Rect,
} from "../model/excerpts";
import { AddAsset, AddElement, AddPage, Batch, type Command } from "../model/history";
import type { Asset, ExcerptElement, NotebookDocument, Page, PageElement } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { internalClip, writeSystemText } from "./clipboard";
import { GotoPageModal, type GotoView } from "./goto-page";
import type { GotoTarget } from "./goto-logic";
import { translatedBoxLabel } from "./markers";
import { storeAsset, type NotebookMedia } from "./media";
import { showNotice } from "./notice";

/** Contact moved further than this (CSS px): a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** A tap this close to a badge (CSS px) still hits it. */
const BADGE_TOLERANCE_PX = 6;
/** Snapshot resolution, px per pt (about 216 dpi), and its longest side, px. */
const SNAPSHOT_SCALE = 3;
const SNAPSHOT_MAX_SIDE = 2048;
/** How long the source region is outlined after a jump, ms. */
const FLASH_MS = 1800;

/** What the view lends to the excerpt tools. */
export interface ExcerptHost {
	app: App;
	doc(): NotebookDocument | null;
	/** Vault path of the open notebook. */
	path(): string | null;
	folder(): string;
	editable(): boolean;
	media(): NotebookMedia | null;
	/** Runs one undo step; false when it was refused (or nothing is editable). */
	execute(cmd: Command): boolean;
	currentPageIndex(): number;
	scrollTo(index: number, y: number): void;
	/** The lasso selection: page, items and its box with the drag transform applied (page coordinates). */
	selection(): { pageIndex: number; elements: readonly PageElement[]; bounds: BBox; matrix: Matrix } | null;
	select(pageIndex: number, elements: PageElement[]): void;
	/** Outlines a region of a page on the live layer (null clears it). */
	preview(pageIndex: number, rect: Rect | null): void;
	/** Whether the live layer outline belongs to us (nothing else uses it now). */
	previewFree(): boolean;
	scale(): number;
	gotoContext: GotoView["gotoContext"];
}

type Mode = "page" | "copy";

interface Gesture {
	mode: "region" | "tap";
	pageIndex: number;
	pageId: string;
	start: [number, number];
	end: [number, number];
	sx: number;
	sy: number;
	moved: boolean;
	target: ExcerptElement | null;
}

/** The excerpt actions and gestures of one notebook view. */
export class ExcerptTools {
	/** The next drag on a page outlines the region to excerpt (one-shot), or null. */
	armed: Mode | null = null;
	private gesture: Gesture | null = null;
	private flashTimer: number | null = null;
	private busy = false;

	constructor(private readonly host: ExcerptHost) {}

	/** The page of the gesture in progress (the view feeds it the moves), or null. */
	get gesturePage(): number | null {
		return this.gesture?.pageIndex ?? null;
	}

	/** "Excerpt to page…": the selection's region, or (nothing selected) the next region dragged on a page. */
	excerptToPage(): void {
		this.start("page");
	}

	/** "Copy as excerpt": like excerptToPage, but the excerpt goes to the plugin clipboard (paste it in any notebook). */
	copyAsExcerpt(): void {
		this.start("copy");
	}

	private start(mode: Mode): void {
		if (!this.host.editable()) return;
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel ? doc?.pages[sel.pageIndex] : undefined;
		if (sel && page) {
			const region = excerptRegion(movedBounds(sel.bounds, sel.matrix), page);
			if (!region) {
				new Notice(t("excerpt.tooSmall"));
				return;
			}
			void this.made(mode, sel.pageIndex, page, region);
			return;
		}
		this.armed = mode;
		new Notice(t("excerpt.hint.region"));
	}

	disarm(): void {
		this.armed = null;
	}

	/**
	 * Pen or finger down at `local` on page `pageIndex`. True when the contact is ours: the region of an armed
	 * excerpt, or a tap on an excerpt's badge (any tool but the lasso and the eraser, which select and erase).
	 */
	begin(pageIndex: number, page: Page, local: [number, number], screen: { x: number; y: number }, tool: string): boolean {
		this.gesture = null;
		if (this.armed) {
			this.gesture = { mode: "region", pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, moved: false, target: null };
			return true;
		}
		if (tool === "lasso" || tool === "eraser") return false;
		const tol = BADGE_TOLERANCE_PX / Math.max(0.05, this.host.scale());
		const hit = excerptBadgeAt(page.elements ?? [], local[0], local[1], tol);
		if (!hit) return false;
		this.gesture = { mode: "tap", pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, moved: false, target: hit };
		return true;
	}

	/** The contact moved. True while the gesture is ours. */
	move(local: [number, number] | null, screen: { x: number; y: number } | null): boolean {
		const g = this.gesture;
		if (!g) return false;
		if (screen && Math.hypot(screen.x - g.sx, screen.y - g.sy) > TAP_SLOP_PX) g.moved = true;
		if (local) g.end = local;
		if (g.mode === "region" && g.moved) this.host.preview(g.pageIndex, rectOf(g.start, g.end));
		return true;
	}

	/** The contact ended. True when it was ours. */
	end(cancelled: boolean): boolean {
		const g = this.gesture;
		if (!g) return false;
		this.gesture = null;
		if (g.mode === "region") this.host.preview(g.pageIndex, null);
		if (cancelled) return true;
		const doc = this.host.doc();
		const page = doc?.pages[g.pageIndex];
		// The document may have been reloaded meanwhile: never act on another page.
		if (!doc || !page || page.id !== g.pageId) return true;
		if (g.mode === "tap") {
			if (!g.moved && g.target && page.elements?.includes(g.target)) this.openSource(g.target);
			return true;
		}
		const mode = this.armed;
		this.armed = null;
		if (!mode) return true;
		const r = rectOf(g.start, g.end);
		const region = g.moved ? excerptRegion({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height }, page, 0) : null;
		if (!region || region.width < MIN_EXCERPT_SIDE || region.height < MIN_EXCERPT_SIDE) {
			new Notice(t("excerpt.tooSmall"));
			this.armed = mode;
			return true;
		}
		void this.made(mode, g.pageIndex, page, region);
		return true;
	}

	/** "Go to source" on the selection bar: the first selected excerpt. */
	openSelectedSource(): void {
		const el = this.host.selection()?.elements.find((e): e is ExcerptElement => e.type === "excerpt");
		if (!el) {
			new Notice(t("excerpt.noneSelected"));
			return;
		}
		this.openSource(el);
	}

	/**
	 * Jumps to the excerpt's source: a page of this notebook is scrolled to and its region outlined; another notebook is
	 * opened at the page (by id) with the region outlined there. A source that is gone says so; nothing is changed.
	 */
	openSource(el: ExcerptElement): void {
		const doc = this.host.doc();
		if (!doc) return;
		const state = excerptSourceState(el, doc);
		const name = excerptSourceName(el.source);
		if (state.kind === "page-missing") {
			showNotice(t("excerpt.pageMissing", { name }), 8000);
			return;
		}
		const source = el.source;
		const region: Rect = { x: source.x, y: source.y, width: source.width, height: source.height };
		if (state.kind === "here") {
			this.reveal(state.index, region);
			return;
		}
		const { app } = this.host;
		const byPath = app.vault.getFileByPath(source.notebook);
		const file = byPath && isNotebookFile(byPath)
			? byPath
			: resolveNotebookFile(app, { kind: "path", value: source.notebook }, this.host.path() ?? "", this.host.folder());
		if (!file) {
			showNotice(t("excerpt.notebookMissing", { name }), 8000);
			return;
		}
		// The notebook view resolves the page by id once loaded (a missing page says so there) and outlines the region.
		void openNotebookAtPage(app, file, null, null, source.page, region);
	}

	/** Scrolls page `index` of this notebook so the region shows, and outlines it for a moment. */
	reveal(index: number, region: Rect): void {
		const page = this.host.doc()?.pages[index];
		if (!page) return;
		const clamped = clampSourceRegion({ notebook: "", doc: "", page: "", ...region }, page) ?? region;
		this.host.scrollTo(index, Math.max(0, clamped.y - 24));
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		if (!this.host.previewFree()) return;
		this.host.preview(index, clamped);
		this.flashTimer = window.setTimeout(() => {
			this.flashTimer = null;
			if (this.host.previewFree()) this.host.preview(index, null);
		}, FLASH_MS);
	}

	/** A region was chosen: snapshot it, then place it (picker) or copy it. */
	private async made(mode: Mode, pageIndex: number, page: Page, region: Rect): Promise<void> {
		const doc = this.host.doc();
		const path = this.host.path();
		const media = this.host.media();
		if (!doc || !path || !media || this.busy) return;
		this.busy = true;
		try {
			const snapshot = await this.snapshot(media, page, region, pageIndex);
			if (this.host.doc() !== doc) return;
			const excerpt = createExcerpt(doc, path, page, region, { x: 0, y: 0, width: region.width, height: region.height }, snapshot?.asset.id);
			if (mode === "copy") {
				this.copy(excerpt, snapshot);
				return;
			}
			new ExcerptTargetModal(this.host.app, this.host.gotoContext, (target) => this.place(doc, excerpt, snapshot, target)).open();
		} catch (e) {
			console.error("[notebook] excerpt", e);
			new Notice(t("excerpt.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
	}

	/** Puts the excerpt on page `target.index` (a new page after the last one when it is one past it), one undo step. */
	private place(doc: NotebookDocument, excerpt: ExcerptElement, snapshot: { asset: Asset } | null, target: ExcerptTarget): void {
		if (this.host.doc() !== doc || !this.host.editable()) return;
		const commands: Command[] = [];
		if (snapshot && !doc.assets?.[snapshot.asset.id]) commands.push(new AddAsset(snapshot.asset));
		let page = doc.pages[target.index];
		if (target.newPage) {
			const like = doc.pages[target.index - 1] ?? doc.pages[doc.pages.length - 1];
			page = like ? createPage({ width: like.width, height: like.height }, { ...like.paper }) : createPage();
			commands.push(new AddPage(page, target.index));
		}
		if (!page) return;
		const box = placeExcerpt(excerpt, page);
		const placed: ExcerptElement = { ...excerpt, ...box };
		commands.push(new AddElement(page.id, placed, page.elements?.length ?? 0));
		if (!this.host.execute(new Batch("Excerpt", commands))) return;
		const index = doc.pages.indexOf(page);
		const added = page.elements?.find((e) => e.id === placed.id);
		if (index < 0 || !added) return;
		this.host.scrollTo(index, Math.max(0, placed.y - 24));
		this.host.select(index, [added]);
		new Notice(t("excerpt.done", { n: String(index + 1) }));
	}

	/** The excerpt (with its snapshot's bytes) on the plugin clipboard, so "Paste" puts it on a page of any notebook. */
	private copy(excerpt: ExcerptElement, snapshot: { asset: Asset; bytes: ArrayBuffer } | null): void {
		const assets: Record<string, Asset> = snapshot ? { [snapshot.asset.id]: snapshot.asset } : {};
		const content = captureClip([], [excerpt], assets);
		if (!content) return;
		const marker = `notebook-excerpt:${excerpt.id}`;
		const clip = internalClip.set(content, marker);
		if (snapshot) clip.bytes.set(snapshot.asset.id, snapshot.bytes);
		void writeSystemText(marker);
		new Notice(t("excerpt.copied"));
	}

	/**
	 * Draws the region of `page` with the page raster (background, paper, pictures, boxes, equations, text, visible ink;
	 * never hidden ink) and stores it as a PNG image asset. Null when nothing can be drawn (no canvas).
	 */
	private async snapshot(media: NotebookMedia, page: Page, region: Rect, pageIndex: number): Promise<{ asset: Asset; bytes: ArrayBuffer } | null> {
		const scale = Math.min(SNAPSHOT_SCALE, SNAPSHOT_MAX_SIDE / Math.max(region.width, region.height));
		let background: CanvasImageSource | null = null;
		const bg = page.background;
		try {
			if (bg?.kind === "pdf") background = await media.pdf.render(bg.asset, bg.page, scale);
			else if (bg?.kind === "image") background = await createImageBitmap(new Blob([await media.readAsset(bg.asset)]));
		} catch (e) {
			// Without its background the picture would be wrong: better no snapshot (the excerpt draws live or as a card).
			console.error("[notebook] excerpt background", e);
			return null;
		}
		const images = new Map<string, CanvasImageSource>();
		for (const el of page.elements ?? []) {
			const id = elementAssetId(el);
			if (id === null || images.has(id)) continue;
			try {
				images.set(id, await createImageBitmap(new Blob([await media.readAsset(id)])));
			} catch {
				// A missing picture is left out, as on screen.
			}
		}
		const canvas = activeDocument.createEl("canvas");
		canvas.width = Math.max(1, Math.round(region.width * scale));
		canvas.height = Math.max(1, Math.round(region.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		drawPageRaster(ctx, page, scale, { background, images, region, boxLabel: translatedBoxLabel });
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!blob) return null;
		const bytes = await blob.arrayBuffer();
		const base = (this.host.path()?.split("/").pop() ?? "notebook").replace(/\.[^.]+$/, "");
		const asset = await storeAsset(this.host.app, this.host.folder(), bytes, `${base} p${pageIndex + 1} excerpt.png`, "image");
		media.addPending(asset);
		return { asset, bytes };
	}

	destroy(): void {
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		this.flashTimer = null;
		this.gesture = null;
		this.armed = null;
	}
}

/** The box of a selection after its drag transform. */
function movedBounds(b: BBox, m: Matrix): BBox {
	const pts = [apply(m, b.minX, b.minY), apply(m, b.maxX, b.minY), apply(m, b.minX, b.maxY), apply(m, b.maxX, b.maxY)];
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function rectOf(a: readonly [number, number], b: readonly [number, number]): Rect {
	return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
}

/** A page picked for an excerpt: an existing page, or a new one inserted at `index`. */
interface ExcerptTarget {
	index: number;
	newPage: boolean;
}

/**
 * The go-to-page picker (number, `p12` or a bookmark) choosing where the excerpt goes. With nothing typed it offers
 * this page, the next page and a new page after this one.
 */
class ExcerptTargetModal extends GotoPageModal {
	private readonly here: { total: number; current: number };
	private chosen = false;

	constructor(app: App, gotoContext: GotoView["gotoContext"], private readonly onPick: (target: ExcerptTarget) => void) {
		const ctx = gotoContext();
		super(app, { gotoContext: () => ctx, jumpToPage: () => undefined });
		this.here = { total: ctx.total, current: ctx.current };
		this.setPlaceholder(t("excerpt.pick.placeholder", { total: String(ctx.total) }));
	}

	getSuggestions(query: string): GotoTarget[] {
		const found = super.getSuggestions(query);
		if (query.trim() !== "") return found;
		const { current, total } = this.here;
		const out: GotoTarget[] = [{ index: current, kind: "page", label: t("excerpt.pick.here", { n: String(current + 1) }) }];
		if (current + 1 < total) out.push({ index: current + 1, kind: "page", label: t("excerpt.pick.next", { n: String(current + 2) }) });
		out.push({ index: -1 - (current + 1), kind: "page", label: t("excerpt.pick.newPage", { n: String(current + 1) }) });
		return [...out, ...found];
	}

	renderSuggestion(target: GotoTarget, el: HTMLElement): void {
		// The empty-query rows carry their own label; the others are the picker's own rows.
		if (target.kind === "page" && !/^\d+$/.test(target.label)) {
			el.addClass("notebook-goto-row");
			el.createSpan({ text: target.label });
			return;
		}
		super.renderSuggestion(target, el);
	}

	onChooseSuggestion(target: GotoTarget): void {
		if (this.chosen) return;
		this.chosen = true;
		this.onPick(target.index < 0 ? { index: -1 - target.index, newPage: true } : { index: target.index, newPage: false });
	}
}
