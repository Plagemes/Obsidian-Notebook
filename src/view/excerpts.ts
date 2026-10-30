/**
 * v10 anchored excerpts (#105) in the notebook view: cutting a region of a page (the lasso selection, or a region
 * dragged after choosing the action), placing it on a page picked with the go-to-page picker or copying it to the
 * plugin clipboard (so it can be pasted in another notebook), and the jump back to the source when its badge is tapped
 * or "Go to source" is chosen. Snapshots are drawn with the page raster and stored as image assets through the vault.
 */
import { Notice, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { captureClip } from "../ink/clipboard";
import { elementBounds } from "../ink/elements";
import type { BBox } from "../ink/hit-test";
import { drawPageRaster } from "../ink/page-raster";
import { apply, type Matrix } from "../ink/transform";
import { openNotebookAtPage, resolveNotebookFile } from "../integration/open";
import { createPage } from "../model/document";
import {
	clampSourceRegion, createExcerpt, documentIdOf, elementAssetId, excerptBadgeAt, excerptRegion, excerptSourceName, excerptSourceState,
	MIN_EXCERPT_SIDE, placeExcerpt, type Rect,
} from "../model/excerpts";
import { AddAsset, AddElement, AddPage, Batch, ReplaceElement, type Command } from "../model/history";
import { boxesOverlap } from "../model/layers";
import type { Asset, ExcerptElement, NotebookDocument, Page, PageElement } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { internalClip, writeSystemText } from "./clipboard";
import { GotoPageModal, type GotoView } from "./goto-page";
import type { GotoTarget } from "./goto-logic";
import { translatedBoxLabel } from "./markers";
import { assetRecord, storeAsset, type NotebookMedia } from "./media";
import { showNotice } from "./notice";

/** Contact moved further than this (CSS px): a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** A tap this close to a badge (CSS px) still hits it. */
const BADGE_TOLERANCE_PX = 6;
/** Longest contact that still counts as a tap on a badge, ms. */
const TAP_MS = 500;
/** Snapshot resolution, px per pt (about 216 dpi), and its longest side, px. */
const SNAPSHOT_SCALE = 3;
const SNAPSHOT_MAX_SIDE = 2048;
/** How long the source region is outlined after a jump, ms. */
const FLASH_MS = 1800;
/** At most this many notebooks are read to find a renamed source notebook by its id. */
const FIND_BY_ID_LIMIT = 400;
/** A source notebook not found is not looked for again for this long, ms. */
const MISS_TTL_MS = 60_000;
/** Where each source notebook (by document id) was found this session, or null (not found) and when. */
const notebookPaths = new Map<string, { path: string | null; at: number }>();

/** What the view lends to the excerpt tools. */
export interface ExcerptHost {
	app: App;
	/** The document being edited (null while loading or when it cannot be edited). */
	doc(): NotebookDocument | null;
	/** The document shown, also while a large file is still loading and when it is read-only. */
	shownDoc(): NotebookDocument | null;
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
	/** Forgets any other one-shot placement armed in the view (an armed marker or box). */
	disarmOthers(): void;
	/** The page and page point under a client position, or null (between pages, nothing laid out). */
	pageAtClient(clientX: number, clientY: number): { pageIndex: number; local: [number, number] } | null;
}

/** A contact that may be a tap on a badge while the notebook is read-only (see attachReadOnlyTaps). */
interface ReadOnlyTap {
	id: number;
	x: number;
	y: number;
	t: number;
	moved: boolean;
}

type Mode = "page" | "copy";

/** The region being dragged after "Excerpt to page…" or "Copy as excerpt" with nothing selected. */
interface RegionDrag {
	pageIndex: number;
	pageId: string;
	start: [number, number];
	end: [number, number];
	sx: number;
	sy: number;
	moved: boolean;
}

/** A contact that started on a badge: a tap if it lifts soon without moving, otherwise ordinary ink (never taken). */
interface BadgeContact {
	pageId: string;
	target: ExcerptElement;
	sx: number;
	sy: number;
	t: number;
	moved: boolean;
}

/** A snapshot drawn but not written yet: it is stored only when the excerpt is placed (or pasted). */
interface Snapshot {
	asset: Asset;
	bytes: ArrayBuffer;
}

/** The excerpt actions and gestures of one notebook view. */
export class ExcerptTools {
	/** The next drag on a page outlines the region to excerpt (one-shot), or null. */
	armed: Mode | null = null;
	private drag: RegionDrag | null = null;
	private contact: BadgeContact | null = null;
	private flashTimer: number | null = null;
	private busy = false;
	private readOnlyTap: ReadOnlyTap | null = null;
	/** A search for a source notebook is running (badge taps meanwhile are ignored). */
	private finding = false;
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly host: ExcerptHost) {}

	/** The page of the region drag in progress (the view feeds it the moves), or null. */
	get gesturePage(): number | null {
		return this.drag?.pageIndex ?? null;
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
		// One one-shot placement at a time: an armed marker would otherwise take the region's drag (or the reverse).
		this.host.disarmOthers();
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel ? doc?.pages[sel.pageIndex] : undefined;
		if (sel && page) {
			this.armed = null;
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

	/** Forgets an armed region (tool changed, Escape, read-only mode, another one-shot mode armed). */
	disarm(): void {
		this.armed = null;
		if (this.drag) this.host.preview(this.drag.pageIndex, null);
		this.drag = null;
	}

	/**
	 * Pen or finger down at `local` on page `pageIndex`. True when the contact is ours: the region of an armed excerpt.
	 * A contact on an excerpt's badge (any tool but the lasso and the eraser, which select and erase) is only noted:
	 * it goes on as ink, and `takeBadgeTap` says at the end whether it was a tap.
	 */
	begin(pageIndex: number, page: Page, local: [number, number], screen: { x: number; y: number; t: number }, tool: string): boolean {
		this.drag = null;
		this.contact = null;
		if (this.armed) {
			this.drag = { pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, moved: false };
			return true;
		}
		if (tool === "lasso" || tool === "eraser") return false;
		const tol = BADGE_TOLERANCE_PX / Math.max(0.05, this.host.scale());
		const hit = excerptBadgeAt(page.elements ?? [], local[0], local[1], tol);
		if (hit) this.contact = { pageId: page.id, target: hit, sx: screen.x, sy: screen.y, t: screen.t, moved: false };
		return false;
	}

	/** The contact moved (stage px): a badge contact that moves is ink from now on. */
	watch(screen: { x: number; y: number } | null): void {
		const c = this.contact;
		if (c && screen && Math.hypot(screen.x - c.sx, screen.y - c.sy) > TAP_SLOP_PX) this.contact = null;
	}

	/**
	 * The contact ended: the excerpt whose badge was tapped (short, unmoved, not cancelled), or null. The view then
	 * discards the dot the tap would have left and jumps; any other contact stays the ink it was.
	 */
	takeBadgeTap(cancelled: boolean, now: number, extentPx: () => number): ExcerptElement | null {
		const c = this.contact;
		this.contact = null;
		// `extentPx`: how far what the contact drew reaches (every point and where it lifted): anything longer is ink.
		if (!c || cancelled || c.moved || now - c.t > TAP_MS || extentPx() > TAP_SLOP_PX) return null;
		const page = this.host.doc()?.pages.find((p) => p.id === c.pageId);
		return page?.elements?.includes(c.target) ? c.target : null;
	}

	/** The region drag moved. True while it is ours. */
	move(local: [number, number] | null, screen: { x: number; y: number } | null): boolean {
		const g = this.drag;
		if (!g) return false;
		if (screen && Math.hypot(screen.x - g.sx, screen.y - g.sy) > TAP_SLOP_PX) g.moved = true;
		if (local) g.end = local;
		if (g.moved) this.host.preview(g.pageIndex, rectOf(g.start, g.end));
		return true;
	}

	/** The region drag ended. True when it was ours. */
	end(cancelled: boolean): boolean {
		const g = this.drag;
		if (!g) return false;
		this.drag = null;
		this.host.preview(g.pageIndex, null);
		if (cancelled) return true;
		const doc = this.host.doc();
		const page = doc?.pages[g.pageIndex];
		// The document may have been reloaded meanwhile: never act on another page.
		if (!doc || !page || page.id !== g.pageId) return true;
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
	 * opened at the page (by id) with the region outlined there. The other notebook must have the source's document id:
	 * its stored path first, then a notebook of the same name, then any notebook of the vault (renamed); when it is found
	 * under another path, the path stored in the excerpts of this notebook is updated (one undo step, editable only). A
	 * source that is gone says so; nothing else is changed.
	 */
	openSource(el: ExcerptElement): void {
		const doc = this.host.shownDoc();
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
		void this.openOther(el, region, name);
	}

	private async openOther(el: ExcerptElement, region: Rect, name: string): Promise<void> {
		const { app } = this.host;
		const source = el.source;
		// One search at a time: more taps while one runs are ignored.
		if (this.finding) return;
		this.finding = true;
		let file: TFile | null;
		try {
			file = await this.findNotebook(source.notebook, source.doc);
		} finally {
			this.finding = false;
		}
		if (!file) {
			showNotice(t("excerpt.notebookMissing", { name }), 8000);
			return;
		}
		if (file.path !== source.notebook) this.updateSourcePath(source.doc, source.notebook, file.path);
		// The notebook view resolves the page by id once loaded (a missing page says so there) and outlines the region.
		await openNotebookAtPage(app, file, null, null, source.page, region);
	}

	/**
	 * The notebook file whose document id is `docId`: at `path`, else of the same name, else anywhere in the vault,
	 * notebooks in the stored path's folder first (a copy made with "Make a copy" keeps the id). Results, misses too,
	 * are remembered for the session (a remembered file is checked again; a miss is retried after a while).
	 */
	private async findNotebook(path: string, docId: string): Promise<TFile | null> {
		const { app } = this.host;
		const known = notebookPaths.get(docId);
		if (known && known.path === null && Date.now() - known.at < MISS_TTL_MS) return null;
		const tried = new Set<string>();
		const matches = async (f: TFile | null): Promise<boolean> => {
			if (!f || tried.has(f.path) || !isNotebookFile(f)) return false;
			tried.add(f.path);
			return (await this.notebookId(f)) === docId;
		};
		const found = async (): Promise<TFile | null> => {
			if (known?.path) {
				const f = app.vault.getFileByPath(known.path);
				if (await matches(f)) return f;
			}
			const byPath = app.vault.getFileByPath(path);
			if (await matches(byPath)) return byPath;
			const byName = resolveNotebookFile(app, { kind: "path", value: path }, this.host.path() ?? "", this.host.folder());
			if (await matches(byName)) return byName;
			const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			const rank = (f: TFile) => ((f.parent?.path ?? "") === folder || (folder === "" && f.parent?.path === "/") ? 0 : 1);
			const all = app.vault.getFiles().filter((f) => isNotebookFile(f) && !tried.has(f.path)).sort((a, b) => rank(a) - rank(b)).slice(0, FIND_BY_ID_LIMIT);
			for (const f of all) if (await matches(f)) return f;
			return null;
		};
		const file = await found();
		notebookPaths.set(docId, { path: file?.path ?? null, at: Date.now() });
		return file;
	}

	/** The document id written at the start of a notebook file, or null when it cannot be read. */
	private async notebookId(file: TFile): Promise<string | null> {
		try {
			return documentIdOf(await this.host.app.vault.cachedRead(file));
		} catch {
			return null;
		}
	}

	/** The excerpts of this notebook that point at `oldPath` of document `docId` now point at `newPath` (one undo step). */
	private updateSourcePath(docId: string, oldPath: string, newPath: string): void {
		const doc = this.host.doc();
		if (!doc || !this.host.editable()) return;
		const commands: Command[] = [];
		for (const page of doc.pages) {
			for (const e of page.elements ?? []) {
				if (e.type !== "excerpt" || e.source.doc !== docId || e.source.notebook !== oldPath) continue;
				commands.push(new ReplaceElement(page.id, e, { ...e, source: { ...e.source, notebook: newPath } }));
			}
		}
		if (commands.length > 0) this.host.execute(new Batch("Update excerpt source", commands));
	}

	/**
	 * Scrolls page `index` of the shown notebook so the region shows, and outlines it for a moment. Works while a large
	 * file is still loading (the pages are laid out) and in a read-only notebook. False when the page is not there.
	 */
	reveal(index: number, region: Rect): boolean {
		const page = this.host.shownDoc()?.pages[index];
		if (!page) return false;
		const clamped = clampSourceRegion({ notebook: "", doc: "", page: "", ...region }, page) ?? region;
		this.host.scrollTo(index, Math.max(0, clamped.y - 24));
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		if (!this.host.previewFree()) return true;
		this.host.preview(index, clamped);
		this.flashTimer = window.setTimeout(() => {
			this.flashTimer = null;
			if (this.host.previewFree()) this.host.preview(index, null);
		}, FLASH_MS);
		return true;
	}

	/** A region was chosen: snapshot it (in memory), then place it (picker) or copy it. */
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
			// Nothing is written until a page is chosen: closing the picker leaves no file behind.
			new ExcerptTargetModal(this.host.app, this.host.gotoContext, (target) => void this.place(doc, excerpt, snapshot, target)).open();
		} catch (e) {
			console.error("[notebook] excerpt", e);
			new Notice(t("excerpt.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
	}

	/** Stores the snapshot and puts the excerpt on page `target.index` (or a new page there), one undo step. */
	private async place(doc: NotebookDocument, excerpt: ExcerptElement, snapshot: Snapshot | null, target: ExcerptTarget): Promise<void> {
		if (this.host.doc() !== doc || !this.host.editable()) return;
		let asset: Asset | null = null;
		if (snapshot) {
			try {
				asset = await storeAsset(this.host.app, this.host.folder(), snapshot.bytes, snapshot.asset.name, "image");
				this.host.media()?.addPending(asset);
			} catch (e) {
				console.error("[notebook] excerpt snapshot", e);
				new Notice(t("excerpt.failed", { error: (e as Error).message }));
				return;
			}
		}
		if (this.host.doc() !== doc || !this.host.editable()) return;
		const commands: Command[] = [];
		if (asset && !doc.assets?.[asset.id]) commands.push(new AddAsset(asset));
		let page = doc.pages[target.index];
		if (target.newPage) {
			const like = doc.pages[target.index - 1] ?? doc.pages[doc.pages.length - 1];
			page = like ? createPage({ width: like.width, height: like.height }, { ...like.paper }) : createPage();
			commands.push(new AddPage(page, target.index));
		}
		if (!page) return;
		const box = placeExcerpt(excerpt, page);
		const placed: ExcerptElement = asset ? { ...excerpt, ...box, asset: asset.id } : { ...excerpt, ...box };
		commands.push(new AddElement(page.id, placed, page.elements?.length ?? 0));
		if (!this.host.execute(new Batch("Excerpt", commands))) return;
		const index = doc.pages.indexOf(page);
		const added = page.elements?.find((e) => e.id === placed.id);
		if (index < 0 || !added) return;
		this.host.scrollTo(index, Math.max(0, placed.y - 24));
		this.host.select(index, [added]);
		new Notice(t("excerpt.done", { n: String(index + 1) }));
	}

	/**
	 * The excerpt (with its snapshot's bytes) on the plugin clipboard, so "Paste" puts it on a page of any notebook. The
	 * snapshot file is written by the paste, like the picture of any copied image.
	 */
	private copy(excerpt: ExcerptElement, snapshot: Snapshot | null): void {
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
	 * Draws the region of `page` with the page raster (background, paper, the pictures and elements that meet the region,
	 * visible ink; never hidden ink) into PNG bytes, with the record the asset will have once stored. Nothing is written
	 * here. Null when nothing can be drawn (no canvas, background missing).
	 */
	private async snapshot(media: NotebookMedia, page: Page, region: Rect, pageIndex: number): Promise<Snapshot | null> {
		const scale = Math.min(SNAPSHOT_SCALE, SNAPSHOT_MAX_SIDE / Math.max(region.width, region.height));
		const opened: ImageBitmap[] = [];
		try {
			let background: CanvasImageSource | null = null;
			const bg = page.background;
			try {
				if (bg?.kind === "pdf") background = await media.pdf.render(bg.asset, bg.page, scale);
				else if (bg?.kind === "image") {
					const bmp = await createImageBitmap(new Blob([await media.readAsset(bg.asset)]));
					opened.push(bmp);
					background = bmp;
				}
			} catch (e) {
				// Without its background the picture would be wrong: better no snapshot (the excerpt draws live or as a card).
				console.error("[notebook] excerpt background", e);
				return null;
			}
			const images = new Map<string, CanvasImageSource>();
			const box = { minX: region.x, minY: region.y, maxX: region.x + region.width, maxY: region.y + region.height };
			for (const el of page.elements ?? []) {
				const id = elementAssetId(el);
				if (id === null || images.has(id) || !boxesOverlap(elementBounds(el), box)) continue;
				try {
					const bmp = await createImageBitmap(new Blob([await media.readAsset(id)]));
					opened.push(bmp);
					images.set(id, bmp);
				} catch {
					// A missing picture is left out, as on screen.
				}
			}
			const canvas = createEl("canvas");
			canvas.width = Math.max(1, Math.round(region.width * scale));
			canvas.height = Math.max(1, Math.round(region.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			drawPageRaster(ctx, page, scale, { background, images, region, boxLabel: translatedBoxLabel });
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
			canvas.width = 0;
			canvas.height = 0;
			if (!blob) return null;
			const bytes = await blob.arrayBuffer();
			const base = (this.host.path()?.split("/").pop() ?? "notebook").replace(/\.[^.]+$/, "");
			const asset = await assetRecord(this.host.folder(), bytes, `${base} p${pageIndex + 1} excerpt.png`, "image");
			return { asset, bytes };
		} finally {
			for (const bmp of opened) bmp.close();
		}
	}

	/**
	 * wave 0.10 (51): in a notebook that cannot be edited (read-only mode, a hidden-annotations view, a file opened
	 * read-only) the page takes no strokes, so a tap never reaches `begin`. The jump back does not edit anything, so a
	 * tap (pen, finger or mouse) on an excerpt's badge is watched here, passively: panning and zooming are untouched.
	 */
	attachReadOnlyTaps(stage: HTMLElement): void {
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			stage.addEventListener(type, fn, { passive: true });
			this.disposers.push(() => stage.removeEventListener(type, fn));
		};
		on("pointerdown", (e) => {
			this.readOnlyTap = this.host.editable() || !e.isPrimary ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false };
		});
		on("pointermove", (e) => {
			const tap = this.readOnlyTap;
			if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_PX) tap.moved = true;
		});
		on("pointercancel", () => {
			this.readOnlyTap = null;
		});
		on("pointerup", (e) => {
			const tap = this.readOnlyTap;
			this.readOnlyTap = null;
			if (!tap || tap.id !== e.pointerId || tap.moved || e.timeStamp - tap.t > TAP_MS || this.host.editable()) return;
			const at = this.host.pageAtClient(e.clientX, e.clientY);
			const page = at ? this.host.shownDoc()?.pages[at.pageIndex] : undefined;
			if (!at || !page) return;
			const tol = BADGE_TOLERANCE_PX / Math.max(0.05, this.host.scale());
			const hit = excerptBadgeAt(page.elements ?? [], at.local[0], at.local[1], tol);
			if (hit) this.openSource(hit);
		});
	}

	destroy(): void {
		for (const off of this.disposers.splice(0)) off();
		this.readOnlyTap = null;
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		this.flashTimer = null;
		this.drag = null;
		this.contact = null;
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
