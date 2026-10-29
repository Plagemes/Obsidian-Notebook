import { Notice, setIcon, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { captureClip, clipAssetIds, duplicateOffset, instantiateClip, pasteCommand, pasteOffset, type ClipContent } from "../ink/clipboard";
import { whiteToTransparent } from "../ink/image-alpha";
import { measureText } from "../ink/renderer";
import { commonStyle, planRestyle, restyleAbilities, type StyleGroup } from "../ink/restyle";
import { AddAsset, AddElement, Batch, ReplaceElement, type Command } from "../model/history";
import type { Asset, ImageElement, NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import { decodePhoto, PhotoDecodeError, photoSize } from "../scan/decode";
import { isHeic } from "../scan/image-bytes";
import { internalClip, readSystemClipboard, systemClipFromEvent, writeSystemText, type SystemClip, type SystemImage } from "./clipboard";
import { resolveAssetFile, storeAsset, type NotebookMedia } from "./media";
import { PasteModal } from "./paste-modal";
import {
	clipMarker, decidePaste, MAX_PASTED_TEXT, normalizePastedText, pastedImageElement, pastedImageName, pastedTextElement,
} from "./paste-logic";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from "./toolbar";

export interface SelectionState {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
}

/** The part of the notebook view the selection actions need. */
export interface SelectionHost {
	app: App;
	folder(): string;
	media(): NotebookMedia | null;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** The lasso tool is active (the bar then offers Paste even with nothing selected). */
	lassoActive(): boolean;
	selection(): SelectionState | null;
	/** Selects exactly these items of the page (switching to the lasso) so they can be moved right away. */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	/** Runs the command as one undo step and refreshes everything that depends on the document. */
	execute(cmd: Command): void;
	deleteSelection(): void;
	/** Page in view and the centre of the view in that page's coordinates. */
	pasteTarget(): { pageIndex: number; page: Page; x: number; y: number } | null;
	textStyle(): { fontSize: number; color: string };
	/** True while the same document is still open and editable (everything here is asynchronous). */
	stillHere(doc: NotebookDocument): boolean;
}

/** Longest side of the copy made when white is turned transparent: enough for a page, light on a phone's memory. */
const MAX_TRANSPARENT_SIDE = 2048;

export class SelectionActions {
	readonly el: HTMLElement;
	private readonly actionsRow: HTMLElement;
	private readonly styleRows: HTMLElement;
	private busy = false;

	constructor(parent: HTMLElement, private readonly host: SelectionHost) {
		this.el = parent.createDiv({ cls: "notebook-selection-bar notebook-hidden", attr: { role: "toolbar", "aria-label": t("selection.bar") } });
		this.actionsRow = this.el.createDiv({ cls: "notebook-toolbar-group" });
		this.styleRows = this.el.createDiv({ cls: "notebook-selection-styles" });
	}

	destroy(): void {
		this.el.remove();
	}

	// --- bar ---

	/** Rebuilds the bar for the current selection and tool; hides it when there is nothing to offer. */
	update(): void {
		const sel = this.host.selection();
		const show = this.host.editable() && (!!sel || this.host.lassoActive());
		this.el.toggleClass("notebook-hidden", !show);
		if (!show) return;
		this.actionsRow.empty();
		this.styleRows.empty();
		if (sel) {
			this.button(this.actionsRow, "copy", "selection.copy", () => void this.copy());
			this.button(this.actionsRow, "scissors", "selection.cut", () => void this.cut());
			this.button(this.actionsRow, "copy-plus", "selection.duplicate", () => this.duplicate());
		}
		this.button(this.actionsRow, "clipboard-paste", "selection.paste", () => void this.paste());
		if (!sel) return;
		if (sel.elements.some((e) => e.type === "image")) {
			this.button(this.actionsRow, "eraser", "selection.whiteTransparent", () => void this.makeWhiteTransparent());
		}
		const ability = restyleAbilities(sel.strokes, sel.elements);
		if (ability.inkColor || ability.inkWidth) this.styleRow(sel, "ink", ability.inkColor, ability.inkWidth);
		if (ability.highlighterColor) this.styleRow(sel, "highlighter", true, ability.highlighterWidth);
	}

	private styleRow(sel: SelectionState, group: StyleGroup, colour: boolean, width: boolean): void {
		const row = this.styleRows.createDiv({ cls: "notebook-toolbar-group" });
		const common = commonStyle(sel.strokes, sel.elements, group);
		const highlighter = group === "highlighter";
		if (colour) {
			for (const color of highlighter ? HIGHLIGHTER_COLORS : PEN_COLORS) {
				const b = this.rawButton(row, `${t("selection.color")} ${color}`, () => this.restyle({ group, color }));
				b.addClass("notebook-swatch");
				b.toggleClass("is-active", common.color === color);
				b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": color });
			}
		}
		if (width) {
			(highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS).forEach((w, i) => {
				const b = this.rawButton(row, `${t("selection.width")} ${i + 1}`, () => this.restyle({ group, width: w }));
				b.addClass("notebook-width");
				b.toggleClass("is-active", common.width === w);
				b.createSpan({ cls: `notebook-width-dot notebook-width-${highlighter ? "h" : "p"}${i}` });
			});
		}
	}

	private rawButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": label, type: "button" } });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	private button(parent: HTMLElement, icon: string, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = this.rawButton(parent, t(label), onClick);
		setIcon(b, icon);
		return b;
	}

	// --- restyle ---

	private restyle(req: { group: StyleGroup; color?: string; width?: number }): void {
		const sel = this.host.selection();
		const page = sel && this.host.doc()?.pages[sel.pageIndex];
		if (!sel || !page || !this.host.editable()) return;
		const plan = planRestyle(page, sel.strokes, sel.elements, req);
		if (!plan) return;
		this.host.execute(plan.command);
		this.host.select(sel.pageIndex, plan.strokes, plan.elements);
	}

	// --- copy, cut, duplicate ---

	private capture(): { clip: ClipContent; pageIndex: number } | null {
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !page) return null;
		const strokes = sel.strokes.filter((s) => page.strokes.includes(s));
		const elements = sel.elements.filter((e) => page.elements?.includes(e));
		const clip = captureClip(strokes, elements, doc.assets, measureText);
		return clip ? { clip, pageIndex: sel.pageIndex } : null;
	}

	/** Copies the selection to the plugin clipboard and returns the text to put on the system clipboard (null: nothing selected). */
	copySync(): string | null {
		const got = this.capture();
		if (!got) return null;
		const images = got.clip.elements.filter((e) => e.type === "image").length;
		const marker = clipMarker(got.clip.strokes.length, images, got.clip.elements.length - images);
		const stored = internalClip.set(got.clip, marker);
		void this.keepImageBytes(stored.content, stored.bytes);
		return marker;
	}

	/** Reads the image files of a fresh clip, so it can be pasted into another notebook even if the source file moves. */
	private async keepImageBytes(content: ClipContent, into: Map<string, ArrayBuffer>): Promise<void> {
		const media = this.host.media();
		if (!media) return;
		for (const id of clipAssetIds(content)) {
			try {
				into.set(id, await media.readAsset(id));
			} catch (e) {
				console.error("[notebook] copy image", e);
			}
		}
	}

	async copy(): Promise<void> {
		const marker = this.copySync();
		if (marker === null) return;
		await writeSystemText(marker);
		new Notice(t("selection.copied"));
	}

	async cut(): Promise<void> {
		const marker = this.copySync();
		if (marker === null || !this.host.editable()) return;
		this.host.deleteSelection();
		await writeSystemText(marker);
		new Notice(t("selection.cutDone"));
	}

	duplicate(): void {
		const got = this.capture();
		const doc = this.host.doc();
		const page = doc?.pages[got?.pageIndex ?? -1];
		if (!got || !doc || !page || !this.host.editable()) return;
		const [dx, dy] = duplicateOffset(got.clip.bounds, page);
		const made = instantiateClip(got.clip, dx, dy, undefined, measureText);
		this.host.execute(pasteCommand(page, made.strokes, made.elements, [], "Duplicate selection"));
		this.host.select(got.pageIndex, made.strokes, made.elements);
	}

	// --- paste ---

	/** Paste button: the newest of the plugin clipboard and the system clipboard; the paste box when the system one cannot be read. */
	async paste(): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sys = await readSystemClipboard();
		await this.pasteClip(sys, true);
	}

	/** Ctrl/Cmd+V (or the system's paste menu): the event carries the clipboard. */
	async pasteFromEvent(e: ClipboardEvent): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sys = await systemClipFromEvent(e);
		await this.pasteClip(sys, false);
	}

	private async pasteClip(sys: SystemClip, mayAskBox: boolean): Promise<void> {
		const decision = decidePaste(sys.state, internalClip.get()?.marker ?? null);
		this.busy = true;
		try {
			switch (decision) {
				case "internal":
					await this.pasteInternal();
					break;
				case "image":
					if (sys.image) await this.pasteImage(sys.image);
					break;
				case "text":
					this.pasteText(sys.state.text);
					break;
				case "unreadable":
					if (mayAskBox) this.openPasteBox();
					else new Notice(t("selection.nothingToPaste"));
					break;
				case "empty":
					new Notice(t("selection.nothingToPaste"));
					break;
			}
		} catch (e) {
			console.error("[notebook] paste", e);
			const heic = e instanceof PhotoDecodeError && e.reason === "heic";
			new Notice(heic ? t("scan.heic") : t("selection.pasteFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.busy = false;
		}
	}

	private openPasteBox(): void {
		new PasteModal(this.host.app, (clip) => void this.pasteClip(clip, false)).open();
	}

	/** Pastes the plugin clipboard on the page in view; images are stored again in this vault's assets folder when needed. */
	private async pasteInternal(): Promise<void> {
		const clip = internalClip.get();
		const target = this.host.pasteTarget();
		const doc = this.host.doc();
		const media = this.host.media();
		if (!clip || !target || !doc || !media) return;
		const newAssets: Asset[] = [];
		const pending: string[] = [];
		const assetMap = new Map<string, string>();
		const missing = new Set<string>();
		try {
			for (const id of clipAssetIds(clip.content)) {
				const known = doc.assets?.[id];
				if (known && resolveAssetFile(this.host.app, known, this.host.folder())) continue;
				const record = clip.content.assets.find((a) => a.id === id);
				const bytes = clip.bytes.get(id) ?? (await this.readFromSource(record));
				if (!bytes || !record) {
					missing.add(id);
					continue;
				}
				const stored = await storeAsset(this.host.app, this.host.folder(), bytes, record.name, "image");
				media.addPending(stored);
				pending.push(stored.id);
				if (stored.id !== id) assetMap.set(id, stored.id);
				if (!doc.assets?.[stored.id] && !newAssets.some((a) => a.id === stored.id)) newAssets.push(stored);
			}
			if (!this.host.stillHere(doc) || !doc.pages.includes(target.page)) return;
			const content: ClipContent = missing.size === 0
				? clip.content
				: { ...clip.content, elements: clip.content.elements.filter((e) => e.type !== "image" || !missing.has(e.asset)) };
			if (content.strokes.length === 0 && content.elements.length === 0) {
				new Notice(t("selection.assetMissing"), 8000);
				return;
			}
			const [dx, dy] = pasteOffset(content.bounds, target.page, [target.x, target.y], clip.pastes % 8);
			clip.pastes++;
			const made = instantiateClip(content, dx, dy, assetMap, measureText);
			this.host.execute(pasteCommand(target.page, made.strokes, made.elements, newAssets));
			this.host.select(target.pageIndex, made.strokes, made.elements);
			if (missing.size > 0) new Notice(t("selection.assetMissing"), 8000);
		} finally {
			for (const id of pending) media.removePending(id);
		}
	}

	private async readFromSource(record: Asset | undefined): Promise<ArrayBuffer | null> {
		if (!record) return null;
		const file = resolveAssetFile(this.host.app, record, this.host.folder());
		if (!file) return null;
		try {
			return await this.host.app.vault.readBinary(file);
		} catch {
			return null;
		}
	}

	/** A pasted picture becomes an image element in the middle of the view, like Insert image, and is selected. */
	private async pasteImage(image: SystemImage): Promise<void> {
		const target = this.host.pasteTarget();
		const doc = this.host.doc();
		const media = this.host.media();
		if (!target || !doc || !media) return;
		// Same checks as Insert image: HEIF/HEIC cannot be shown by the WebView, so it is refused before anything is stored.
		if (isHeic(image.bytes)) throw new PhotoDecodeError("heic");
		const dims = await photoSize(image.bytes, "", image.mime);
		const asset = await storeAsset(this.host.app, this.host.folder(), image.bytes, pastedImageName(image.mime), "image");
		media.addPending(asset);
		try {
			if (!this.host.stillHere(doc) || !doc.pages.includes(target.page)) return;
			const element = pastedImageElement(asset.id, dims, target.page, target.x, target.y);
			const index = target.page.elements?.length ?? 0;
			this.host.execute(new Batch("Paste image", [new AddAsset(asset), new AddElement(target.page.id, element, index)]));
			this.host.select(target.pageIndex, [], [element]);
		} finally {
			media.removePending(asset.id);
		}
	}

	/** Pasted plain text becomes a text box. */
	private pasteText(raw: string): void {
		const target = this.host.pasteTarget();
		if (!target) return;
		const { text, truncated } = normalizePastedText(raw);
		if (text === "") {
			new Notice(t("selection.nothingToPaste"));
			return;
		}
		const style = this.host.textStyle();
		const el = pastedTextElement(text, target.page, target.x, target.y, style.fontSize, style.color);
		this.host.execute(new AddElement(target.page.id, el, target.page.elements?.length ?? 0));
		this.host.select(target.pageIndex, [], [el]);
		if (truncated) new Notice(t("selection.textTruncated", { n: String(MAX_PASTED_TEXT) }), 8000);
	}

	// --- white to transparent ---

	/** Stores a copy of each selected image with its white made transparent (a new asset) and points the element at it; one undo step. */
	async makeWhiteTransparent(): Promise<void> {
		if (this.busy || !this.host.editable()) return;
		const sel = this.host.selection();
		const doc = this.host.doc();
		const media = this.host.media();
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !media || !page) return;
		const images = sel.elements.filter((e): e is ImageElement => e.type === "image" && !!page.elements?.includes(e));
		if (images.length === 0) return;
		this.busy = true;
		const pending: string[] = [];
		try {
			const made = new Map<string, Asset | null>();
			for (const el of images) {
				if (made.has(el.asset)) continue;
				const copy = await this.transparentCopy(el.asset, media);
				made.set(el.asset, copy);
				if (copy) {
					media.addPending(copy);
					pending.push(copy.id);
				}
			}
			if (!this.host.stillHere(doc) || !doc.pages.includes(page)) return;
			const commands: Command[] = [];
			const added = new Set<string>();
			const replaced = new Map<PageElement, PageElement>();
			for (const el of images) {
				const copy = made.get(el.asset);
				if (!copy || !page.elements?.includes(el)) continue;
				if (!added.has(copy.id) && !doc.assets?.[copy.id]) {
					added.add(copy.id);
					commands.push(new AddAsset(copy));
				}
				const next: ImageElement = { ...el, asset: copy.id };
				replaced.set(el, next);
				commands.push(new ReplaceElement(page.id, el, next));
			}
			if (replaced.size === 0) {
				new Notice(t("selection.transparentNone"));
				return;
			}
			this.host.execute(new Batch("Make white transparent", commands));
			this.host.select(sel.pageIndex, sel.strokes, sel.elements.map((e) => replaced.get(e) ?? e));
		} catch (e) {
			console.error("[notebook] white to transparent", e);
			const heic = e instanceof PhotoDecodeError && e.reason === "heic";
			new Notice(heic ? t("scan.heic") : t("selection.transparentFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			for (const id of pending) media.removePending(id);
			this.busy = false;
		}
	}

	/** New asset with the white of `assetId` removed; null when the picture has no white to remove. */
	private async transparentCopy(assetId: string, media: NotebookMedia): Promise<Asset | null> {
		const source = media.asset(assetId);
		const bytes = await media.readAsset(assetId);
		const photo = await decodePhoto(bytes, source?.name ?? "", MAX_TRANSPARENT_SIDE);
		try {
			const { canvas, ctx } = photo;
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
			if (whiteToTransparent(data.data) === 0) return null;
			ctx.putImageData(data, 0, 0);
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw new Error("could not encode PNG");
			const stem = (source?.name ?? "image").replace(/\.[A-Za-z0-9]+$/, "");
			return await storeAsset(this.host.app, this.host.folder(), await blob.arrayBuffer(), `${stem}-transparent.png`, "image");
		} finally {
			photo.canvas.width = 0;
			photo.canvas.height = 0;
		}
	}
}
