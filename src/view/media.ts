import { loadPdfJs, normalizePath, Platform, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import type { MediaSource } from "../ink/renderer";
import type { Asset, AssetKind, NotebookDocument, Page } from "../model/types";
import { assetExtension, assetPath, assetsFolder, kindFromName } from "../pdf/assets";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import type { PdfLib } from "../pdf/pdfjs-types";
import { isAbortError, PdfStore } from "../pdf/pdf-store";
import { ensureFolder } from "../storage/vault-io";

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

/** PDF pages, scans and images of the open notebook, for the renderer and exports. */
export class NotebookMedia implements MediaSource {
	readonly pdf: PdfStore;
	private readonly images = new Map<string, ImageBitmap | "loading" | "missing">();
	private readonly missing = new Set<string>();
	/** Assets stored but not yet in the document (an import in progress), readable by id. */
	private readonly pending = new Map<string, Asset>();

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

	async readAsset(id: string): Promise<ArrayBuffer> {
		const asset = this.asset(id);
		const file = asset && resolveAssetFile(this.app, asset, this.folder());
		if (!file) {
			this.missing.add(id);
			throw new Error(`missing asset ${asset?.name ?? id}`);
		}
		return this.app.vault.readBinary(file);
	}

	background(page: Page, deviceScale: number): CanvasImageSource | null {
		const bg = page.background;
		if (!bg) return null;
		if (bg.kind === "image") return this.image(bg.asset);
		if (this.missing.has(bg.asset)) return null;
		const scale = quantizeScale(deviceScale);
		const have = this.pdf.peek(bg.asset, bg.page, scale);
		if (!have || have.scale < scale * 0.99) {
			this.pdf.render(bg.asset, bg.page, scale).then(() => this.changed(), (e) => {
				if (!isAbortError(e)) {
					console.error("[notebook] PDF page", e);
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
		return this.missing.has(bg.asset) ? t("media.missing", { name }) : t("media.loading");
	}

	image(id: string): CanvasImageSource | null {
		const cached = this.images.get(id);
		if (cached && cached !== "loading" && cached !== "missing") return cached;
		if (!cached) {
			this.images.set(id, "loading");
			this.readAsset(id)
				.then((bytes) => createImageBitmap(new Blob([bytes])))
				.then((bmp) => {
					this.images.set(id, bmp);
					this.changed();
				}, (e) => {
					console.error("[notebook] image", e);
					this.images.set(id, "missing");
					this.changed();
				});
		}
		return null;
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
		this.pdf.clear();
		this.pending.clear();
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

