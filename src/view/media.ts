import { loadPdfJs, normalizePath, Platform, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import type { MediaSource } from "../ink/renderer";
import { drawPageRaster } from "../ink/page-raster";
import { BoundsCache, LIVE_BUDGET_BYTES, LiveCache, liveScale, regionContent, Tokens } from "../ink/excerpt-live";
import { clampSourceRegion, elementAssetId, excerptSourceState } from "../model/excerpts";
import { equationNumbers } from "../model/math-elements";
import type { Asset, AssetKind, ExcerptElement, NotebookDocument, Page, Stroke } from "../model/types";
import { assetExtension, assetPath, assetsFolder, kindFromName } from "../pdf/assets";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import type { PdfLib } from "../pdf/pdfjs-types";
import { isAbortError, PdfStore } from "../pdf/pdf-store";
import { ensureFolder } from "../storage/vault-io";
import { assetAvailability } from "../storage/sync-state";

/** Render scales are rounded to steps of √2 so zooming does not re-render on every frame. */
function quantizeScale(s: number): number {
	return Math.pow(2, Math.round(Math.log2(Math.max(0.1, s)) * 2) / 2);
}

/** Finds an asset's file: its stored path first, then `<assets folder>/<id>.<ext>`. */
export function resolveAssetFile(app: App, asset: Asset, notebooksFolder: string): TFile | null {
	const byPath = app.vault.getFileByPath(asset.path);
	if (byPath) return byPath;
	const fallback = app.vault.getFileByPath(normalizePath(assetPath(assetsFolder(notebooksFolder), asset.id, assetExtension(asset.kind, asset.name))));
	return fallback;
}

/** True if `file` holds exactly `bytes` (size first, then a hash of the content). */
async function sameBytes(app: App, file: TFile, bytes: ArrayBuffer): Promise<boolean> {
	try {
		const current = await app.vault.readBinary(file);
		if (current.byteLength !== bytes.byteLength) return false;
		return (await sha256Hex(current)) === (await sha256Hex(bytes));
	} catch {
		return false;
	}
}

/**
 * Stores bytes as a content-addressed asset (`_assets/<hash>.<ext>`); the same file imported twice is
 * stored once. Returns the asset record to put in the document.
 */
export async function storeAsset(app: App, notebooksFolder: string, bytes: ArrayBuffer, name: string, kind?: AssetKind): Promise<Asset> {
	const k = kind ?? kindFromName(name);
	if (!k) throw new Error(`unsupported file type: ${name}`);
	const id = assetIdFromHash(await sha256Hex(bytes));
	const folder = assetsFolder(notebooksFolder);
	const path = normalizePath(assetPath(folder, id, assetExtension(k, name)));
	const existing = app.vault.getFileByPath(path);
	if (!existing) {
		await ensureFolder(app, folder);
		await app.vault.createBinary(path, bytes);
	} else if (!(await sameBytes(app, existing, bytes))) {
		// The file is named by the hash of the bytes but holds something else (truncated by a failed sync, or
		// edited): reusing it would make every notebook that references it show a broken asset. Rewrite it.
		await app.vault.modifyBinary(existing, bytes);
	}
	return { id, kind: k, path, name, bytes: bytes.byteLength };
}

/** v10: a live excerpt picture is drawn again at most this often while its notebook is being edited, ms. */
const LIVE_MIN_INTERVAL_MS = 400;

/**
 * The record `storeAsset` will give these bytes (same content id, path and name), without writing anything: an excerpt
 * snapshot is written only when the excerpt is placed or pasted.
 */
export async function assetRecord(notebooksFolder: string, bytes: ArrayBuffer, name: string, kind: AssetKind): Promise<Asset> {
	const id = assetIdFromHash(await sha256Hex(bytes));
	const path = normalizePath(assetPath(assetsFolder(notebooksFolder), id, assetExtension(kind, name)));
	return { id, kind, path, name, bytes: bytes.byteLength };
}

/** PDF pages, scans and images of the open notebook, for the renderer and exports. */
export class NotebookMedia implements MediaSource {
	readonly pdf: PdfStore;
	private readonly images = new Map<string, ImageBitmap | "loading" | "missing">();
	private readonly missing = new Set<string>();
	/** wave 0.7: sync safety (#343): assets whose file is not in the vault yet, or still arriving. Not an error. */
	private readonly waiting = new Set<string>();
	/** Placeholders drawn for image assets that are waiting for sync. */
	private readonly placeholders = new Map<string, HTMLCanvasElement>();
	/** Assets stored but not yet in the document (an import in progress), readable by id. */
	private readonly pending = new Map<string, Asset>();
	/** v10: live pictures of excerpts of this notebook's own pages, by excerpt id (LRU within a byte budget). */
	private readonly live = new LiveCache<HTMLCanvasElement>(LIVE_BUDGET_BYTES, (c) => {
		// Gives the pixels back at once (a canvas keeps them until it is collected).
		c.width = 0;
		c.height = 0;
	});
	private liveTimer: number | null = null;
	private readonly tokens = new Tokens();
	private readonly bounds = new BoundsCache();
	/** v10: stroke shapes reused by the live pictures (strokes are immutable). */
	private readonly paths = new WeakMap<Stroke, Path2D>();
	/** v10: bumped whenever a picture finishes loading, fails or is evicted, so a live picture waiting for it is redrawn. */
	private imageRevision = 0;

	constructor(
		private readonly app: App,
		private readonly doc: () => NotebookDocument | null,
		private readonly folder: () => string,
		private readonly changed: () => void,
	) {
		this.pdf = new PdfStore({
			loadPdfJs: () => loadPdfJs() as Promise<PdfLib>,
			readAsset: (id) => this.readAsset(id),
			createCanvas: (w, h) => {
				const c = activeDocument.createEl("canvas");
				c.width = w;
				c.height = h;
				return c;
			},
			// Phones and tablets have less memory for bitmaps.
			memoryBudgetBytes: (Platform.isMobile ? 96 : 192) * 1024 * 1024,
		});
	}

	asset(id: string): Asset | null {
		return this.doc()?.assets?.[id] ?? this.pending.get(id) ?? null;
	}

	/** Makes an asset readable before the command that adds it to the document runs (to read a PDF's page sizes). */
	addPending(asset: Asset): void {
		this.pending.set(asset.id, asset);
		this.missing.delete(asset.id);
	}

	removePending(id: string): void {
		this.pending.delete(id);
	}

	/** The assets stored but not yet in the document (read-only: the library check protects their files). */
	pendingAssets(): Asset[] {
		return [...this.pending.values()];
	}

	async readAsset(id: string): Promise<ArrayBuffer> {
		const asset = this.asset(id);
		const file = asset && resolveAssetFile(this.app, asset, this.folder());
		// wave 0.7: an asset the sync client has not (completely) downloaded yet is waiting, not missing.
		if (!file || assetAvailability(file.stat.size, asset.bytes) === "waiting") {
			if (asset) this.waiting.add(id);
			else this.missing.add(id);
			throw new Error(`${file ? "incomplete" : "missing"} asset ${asset?.name ?? id}`);
		}
		this.waiting.delete(id);
		return this.app.vault.readBinary(file);
	}

	background(page: Page, deviceScale: number): CanvasImageSource | null {
		const bg = page.background;
		if (!bg) return null;
		if (bg.kind === "image") return this.waiting.has(bg.asset) ? null : this.image(bg.asset);
		if (this.missing.has(bg.asset) || this.waiting.has(bg.asset)) return null;
		const scale = quantizeScale(deviceScale);
		const have = this.pdf.peek(bg.asset, bg.page, scale);
		if (!have || have.scale < scale * 0.99) {
			this.pdf.render(bg.asset, bg.page, scale).then(() => this.changed(), (e) => {
				if (!isAbortError(e)) {
					if (!this.waiting.has(bg.asset)) console.error("[notebook] PDF page", e);
					this.missing.add(bg.asset);
					this.changed();
				}
			});
		}
		return (have?.canvas as CanvasImageSource | undefined) ?? null;
	}

	backgroundLabel(page: Page): string | null {
		const bg = page.background;
		if (!bg) return null;
		const name = this.asset(bg.asset)?.name ?? bg.asset;
		if (this.waiting.has(bg.asset)) return t("sync.asset.waiting", { name });
		return this.missing.has(bg.asset) ? t("media.missing", { name }) : t("media.loading");
	}

	image(id: string): CanvasImageSource | null {
		const cached = this.images.get(id);
		if (cached && cached !== "loading" && cached !== "missing") return cached;
		if (cached === "missing" && this.waiting.has(id)) return this.placeholder(id);
		if (!cached) {
			this.images.set(id, "loading");
			this.readAsset(id)
				.then((bytes) => createImageBitmap(new Blob([bytes])))
				.then((bmp) => {
					this.images.set(id, bmp);
					this.imageRevision++;
					this.changed();
				}, (e) => {
					if (!this.waiting.has(id)) console.error("[notebook] image", e);
					this.images.set(id, "missing");
					this.imageRevision++;
					// A file that is there but does not decode is usually still arriving (written in place by the sync
					// client): wait for it, so the next change of its file (assetFileChanged) loads it again.
					if (this.asset(id)) this.waiting.add(id);
					this.changed();
				});
		}
		return null;
	}

	/**
	 * wave 0.7: sync safety (#343). A file was created, changed or renamed in the vault: if it is the file of an asset
	 * that was waiting (or could not be read), forget what is cached so it is loaded again. Returns true if it was.
	 */
	assetFileChanged(file: TFile): boolean {
		const ids = [...new Set([...this.waiting, ...this.missing])];
		let hit = false;
		for (const id of ids) {
			const asset = this.asset(id);
			if (!asset || resolveAssetFile(this.app, asset, this.folder()) !== file) continue;
			hit = true;
			this.waiting.delete(id);
			this.missing.delete(id);
			this.placeholders.delete(id);
			const cached = this.images.get(id);
			if (typeof cached === "object") cached.close();
			this.images.delete(id);
			this.pdf.evictAsset(id);
		}
		if (hit) {
			this.imageRevision++;
			this.changed();
		}
		return hit;
	}

	/**
	 * v10: the content of the document changed. A moment later (never during the stroke that changed it), the cached
	 * live pictures of excerpts that are no longer in the document are dropped, and a repaint is asked for only when
	 * the content of a live excerpt's region changed: writing elsewhere never redraws anything for the excerpts.
	 */
	excerptsChanged(): void {
		if (this.live.size === 0 || this.liveTimer !== null) return;
		this.liveTimer = window.setTimeout(() => {
			this.liveTimer = null;
			if (this.liveRegionsChanged()) this.changed();
		}, LIVE_MIN_INTERVAL_MS);
	}

	/** Drops pictures of excerpts that are gone; true when the region of a remaining one has other content now. */
	private liveRegionsChanged(): boolean {
		const doc = this.doc();
		if (!doc) {
			this.live.clear();
			return false;
		}
		const ids = new Set<string>();
		for (const p of doc.pages) for (const e of p.elements ?? []) if (e.type === "excerpt") ids.add(e.id);
		this.live.retain(ids);
		for (const [, entry] of this.live.values()) {
			const page = doc.pages.find((p) => p.id === entry.source.page);
			if (!page || regionContent(page, entry.source.region, this.tokens, this.bounds).fingerprint !== entry.fingerprint) return true;
		}
		return false;
	}

	/**
	 * v10: the live picture of an excerpt whose source is a page of this notebook (drawn with the page raster from the
	 * strokes and elements that meet its region, at no more than its size on screen); null when the source is another
	 * notebook, is gone, or its background or pictures are still loading (the renderer then draws the snapshot). The
	 * source page's own excerpts are drawn from their snapshots, so an excerpt of a page that holds an excerpt of it
	 * cannot recurse.
	 */
	excerpt(el: ExcerptElement, deviceScale: number): CanvasImageSource | null {
		const doc = this.doc();
		if (!doc) return null;
		const state = excerptSourceState(el, doc);
		if (state.kind !== "here") return null;
		const page = doc.pages[state.index]!;
		const region = clampSourceRegion(el.source, page);
		if (!region) return null;
		const have = this.live.get(el.id);
		const scale = liveScale(deviceScale, el, region);
		let background: CanvasImageSource | null = null;
		const bg = page.background;
		if (bg) {
			// Any bitmap of the page already rendered first: asking for another scale of a page the view is drawing would
			// cancel its render in flight (one render per page at a time).
			const peek = bg.kind === "pdf" && !this.missing.has(bg.asset) ? this.pdf.peek(bg.asset, bg.page, scale) : null;
			background = (peek?.canvas as CanvasImageSource | undefined) ?? this.background(page, scale);
			if (!background) return have?.picture ?? null;
		}
		const content = regionContent(page, region, this.tokens, this.bounds);
		const images = new Map<string, CanvasImageSource>();
		for (const e of content.elements) {
			const id = elementAssetId(e);
			if (id === null || images.has(id)) continue;
			const img = this.image(id);
			if (img) images.set(id, img);
			// Wait for pictures still loading rather than show the region without them.
			else if (this.images.get(id) === "loading") return have?.picture ?? null;
		}
		const bgWidth = background && "width" in background ? Number(background.width) : 0;
		const key = [
			content.fingerprint, page.width, page.height, page.paper.kind, page.paper.spacing, bg ? `${bg.asset}:${bg.kind === "pdf" ? bg.page : 0}` : "",
			scale, region.x, region.y, region.width, region.height, bgWidth, this.imageRevision,
		].join("|");
		if (have?.key === key) return have.picture;
		const now = Date.now();
		if (have && now - have.at < LIVE_MIN_INTERVAL_MS) {
			if (this.liveTimer === null) {
				this.liveTimer = window.setTimeout(() => {
					this.liveTimer = null;
					this.changed();
				}, LIVE_MIN_INTERVAL_MS);
			}
			return have.picture;
		}
		const canvas = have?.picture ?? activeDocument.createEl("canvas");
		canvas.width = Math.max(1, Math.round(region.width * scale));
		canvas.height = Math.max(1, Math.round(region.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		drawPageRaster(ctx, { ...page, strokes: content.strokes, elements: content.elements }, scale, {
			background, images, region, clipElements: page.elements ?? [], paths: this.paths, equationNumbers: equationNumbers(doc.pages),
		});
		this.live.set(el.id, {
			key, picture: canvas, bytes: canvas.width * canvas.height * 4, at: now, fingerprint: content.fingerprint,
			source: { page: page.id, region },
		});
		return canvas;
	}

	/** v10: the excerpt's source is this notebook and its page is not in it any more. */
	excerptMissing(el: ExcerptElement): boolean {
		const doc = this.doc();
		return !!doc && excerptSourceState(el, doc).kind === "page-missing";
	}

	/** Whether an asset is waiting for the sync client (for labels and tests). */
	isWaiting(id: string): boolean {
		return this.waiting.has(id);
	}

	/** A light "waiting for sync" card in the shape of the first image element that shows `id`. */
	private placeholder(id: string): HTMLCanvasElement {
		const have = this.placeholders.get(id);
		if (have) return have;
		let ratio = 4 / 3;
		for (const page of this.doc()?.pages ?? []) {
			const el = page.elements?.find((e) => e.type === "image" && e.asset === id);
			if (el && el.type === "image" && el.width > 0 && el.height > 0) {
				ratio = Math.min(8, Math.max(1 / 8, el.width / el.height));
				break;
			}
		}
		const width = 480;
		const height = Math.max(40, Math.round(width / ratio));
		const c = activeDocument.createEl("canvas");
		c.width = width;
		c.height = height;
		const ctx = c.getContext("2d");
		if (ctx) {
			ctx.fillStyle = "#f1f5f9";
			ctx.fillRect(0, 0, width, height);
			ctx.strokeStyle = "#94a3b8";
			ctx.lineWidth = 3;
			ctx.setLineDash([12, 8]);
			ctx.strokeRect(2, 2, width - 4, height - 4);
			ctx.fillStyle = "#64748b";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			const size = Math.max(12, Math.min(28, height / 5));
			ctx.font = `${size}px sans-serif`;
			const name = this.asset(id)?.name ?? "";
			const lines = name && height >= size * 3.2 ? [t("sync.asset.waitingShort"), name] : [t("sync.asset.waitingShort")];
			lines.forEach((line, i) => ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * size * 1.4, width - 24));
		}
		this.placeholders.set(id, c);
		return c;
	}

	/** JPEG of a PDF page at `dpi`, for exports. */
	async pdfPageJpeg(asset: string, page: number, dpi = 200): Promise<{ jpeg: Uint8Array; pixelWidth: number; pixelHeight: number }> {
		const canvas = await this.pdf.render(asset, page, dpi / 72);
		return canvasToJpeg(canvas);
	}

	/** JPEG of an image asset (any browser-decodable format), for exports. */
	async imageJpeg(asset: string): Promise<{ jpeg: Uint8Array; pixelWidth: number; pixelHeight: number }> {
		const bmp = await createImageBitmap(new Blob([await this.readAsset(asset)]));
		const c = activeDocument.createEl("canvas");
		c.width = bmp.width;
		c.height = bmp.height;
		const ctx = c.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D is not available");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, c.width, c.height);
		ctx.drawImage(bmp, 0, 0);
		return canvasToJpeg(c);
	}

	destroy(): void {
		if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
		this.liveTimer = null;
		this.live.clear();
		this.pdf.clear();
		this.pending.clear();
		this.placeholders.clear();
		this.waiting.clear();
		for (const v of this.images.values()) if (typeof v === "object") v.close();
		this.images.clear();
	}
}

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<{ jpeg: Uint8Array; pixelWidth: number; pixelHeight: number }> {
	let blob: Blob | null;
	if ("convertToBlob" in canvas) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
	else blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
	if (!blob) throw new Error("could not encode JPEG");
	return { jpeg: new Uint8Array(await blob.arrayBuffer()), pixelWidth: canvas.width, pixelHeight: canvas.height };
}

