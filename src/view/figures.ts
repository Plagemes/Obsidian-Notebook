// 0.19 Figures gallery (roadmap #228): a grid of every picture and figure cut-out of the section, the notebook or some pages. The
// thumbnails come from the stored asset files, lazily (only the cards in view), one at a time, small, and kept in a bounded cache.
// Tap goes to the figure on its page and outlines it; long-press (or the card's "more" button) offers Copy image, Insert into note
// and Open original. Read-only: nothing here writes the notebook.
import { Menu, Modal, Platform, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { writing } from "../ink/writing-guard";
import {
	collectFigures, figureCounts, filterFigures, FIGURE_SCOPES, hasSections, JobQueue, LruCache, pageCount, scopePages, thumbPixelWidth,
	THUMB_CACHE_MAX, THUMB_CSS_WIDTH, THUMB_MAX_DPR, type FigureEntry, type FigureKind, type FigureScope,
} from "../model/figures";
import { parsePageRange } from "../model/page-range";
import type { Page } from "../model/types";
import { chip, filterChips } from "../ui/components/chip";
import { modalShell, shellNote } from "../ui/components/modal-shell";
import { showErrorNotice, showNotice } from "./notice";
import { rangeProblem } from "./range-text";

export interface FiguresHost {
	app: App;
	/** The pages as the view shows them. */
	pages(): readonly Page[];
	/** The ids of the image assets the document lists. */
	assetIds(): ReadonlySet<string>;
	/** The page in view (0-based). */
	current(): number;
	/** The bytes of an image asset; rejects when the file is missing or still arriving. */
	readAsset(id: string): Promise<ArrayBuffer>;
	/** Scrolls to the figure and outlines it for a moment. */
	goTo(entry: FigureEntry): void;
	/** Draws the figure's place on its page into a note (the 0.18 selection-insert path). Absent: the action is not offered. */
	insertIntoNote?(entry: FigureEntry): void;
	/** Opens the stored file of the picture; false when the file cannot be found. */
	openOriginal(entry: FigureEntry): boolean;
	/**
	 * Review fix (0.26 #285): why the picture must not be copied (a redaction box covers it, or the boxes cannot be read), or null. Copy
	 * puts the whole original picture on the clipboard, so a covered one is refused instead.
	 */
	copyRefused?(entry: FigureEntry): string | null;
}

/** Thumbnails by asset id (assets are content-addressed, so the picture is the same in any notebook), kept across openings. */
const thumbs = new LruCache<string>(THUMB_CACHE_MAX);
type Failure = "missing" | "unreadable";

let lastScope: FigureScope | null = null;

const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;

/** A picture of `bytes` no wider than the thumbnail size, as a JPEG data URL; null when it cannot be decoded. */
async function makeThumb(bytes: ArrayBuffer): Promise<string | null> {
	const dpr = Math.min(THUMB_MAX_DPR, window.devicePixelRatio || 1);
	const wanted = Math.round(THUMB_CSS_WIDTH * dpr);
	const blob = new Blob([bytes]);
	let bmp: ImageBitmap | null = null;
	let canvas: HTMLCanvasElement | null = null;
	try {
		// Decoded at the small size where the browser can: a 12-megapixel photo is never held whole in memory.
		try {
			bmp = await createImageBitmap(blob, { resizeWidth: wanted, resizeQuality: "low" });
		} catch {
			bmp = await createImageBitmap(blob);
		}
		const width = thumbPixelWidth(bmp.width, dpr);
		const height = Math.max(1, Math.round(bmp.height * (width / bmp.width)));
		canvas = createEl("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(bmp, 0, 0, width, height);
		return canvas.toDataURL("image/jpeg", 0.78);
	} catch {
		return null;
	} finally {
		bmp?.close();
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

/** The picture as PNG bytes in a Blob (the system clipboard takes PNG). */
async function pngBlob(bytes: ArrayBuffer): Promise<Blob | null> {
	const bmp = await createImageBitmap(new Blob([bytes]));
	let canvas: HTMLCanvasElement | null = null;
	try {
		canvas = createEl("canvas");
		canvas.width = bmp.width;
		canvas.height = bmp.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(bmp, 0, 0);
		return await new Promise<Blob | null>((resolve) => canvas!.toBlob((b) => resolve(b), "image/png"));
	} finally {
		bmp.close();
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

/** Puts the figure's picture on the system clipboard; true when it worked. */
async function copyFigureImage(host: FiguresHost, entry: FigureEntry): Promise<boolean> {
	try {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
		const blob = await pngBlob(await host.readAsset(entry.asset));
		if (!blob) return false;
		await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		return true;
	} catch (e) {
		console.error("[notebook] copy figure", e);
		return false;
	}
}

const KIND_ICON: Readonly<Record<FigureKind, string>> = { photo: "image", crop: "crop" };

export class FiguresModal extends Modal {
	private scopeChoice: FigureScope;
	private kind: FigureKind | null = null;
	private rangeText = "";
	private rangePages: number[] | null = null;
	private bar: HTMLElement | null = null;
	private rangeRow: HTMLElement | null = null;
	private grid: HTMLElement | null = null;
	private subtitle: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	/** The cards near the screen whose picture is not shown yet. */
	private readonly near = new Set<HTMLElement>();
	private readonly queue = new JobQueue();
	private opened = true;

	constructor(private readonly figures: FiguresHost) {
		super(figures.app);
		this.scopeChoice = lastScope && (lastScope !== "section" || hasSections(figures.pages())) ? lastScope : hasSections(figures.pages()) ? "section" : "notebook";
	}

	onOpen(): void {
		this.opened = true;
		const shell = modalShell(this, { title: t("figures.title"), icon: "images", size: "wide", cls: "nb-figures-modal", footer: false, seed: "notebook-figures" });
		this.subtitle = shell.head.querySelector<HTMLElement>(".nb-modal-subtitle") ?? shell.head.querySelector<HTMLElement>(".nb-modal-headtext")?.createDiv({ cls: "nb-modal-subtitle" }) ?? null;
		this.bar = shell.body.createDiv({ cls: "nb-figures-bar" });
		this.rangeRow = shell.body.createDiv({ cls: "nb-figures-range" });
		this.grid = shell.body.createDiv({ cls: "nb-figures-grid" });
		this.observer = new IntersectionObserver((entries) => {
			for (const e of entries) {
				const card = e.target as HTMLElement;
				const asset = card.dataset.asset ?? "";
				if (e.isIntersecting) {
					this.near.add(card);
					this.want(card, asset);
				} else {
					this.near.delete(card);
					// Scrolled away before its turn: the picture gives up its place in the queue unless another card of it is still near.
					if (!Array.from(this.near).some((c) => c.dataset.asset === asset)) this.queue.cancel(asset);
				}
			}
		}, { root: shell.body, rootMargin: "300px" });
		this.render();
	}

	onClose(): void {
		this.opened = false;
		this.queue.stop();
		this.observer?.disconnect();
		this.near.clear();
		this.observer = null;
		this.contentEl.empty();
	}

	private pages(): readonly Page[] {
		return this.figures.pages();
	}

	/** Re-reads the document: the notebook may have changed since the last drawing (a photo added in another tab is not read until the next opening, but a scope change reads again). */
	private entries(): FigureEntry[] {
		const pages = this.pages();
		const indexes = scopePages(pages, { scope: this.scopeChoice, current: this.figures.current(), range: this.rangePages });
		return collectFigures(pages, indexes, this.figures.assetIds());
	}

	private render(): void {
		const { bar, rangeRow } = this;
		if (!bar || !rangeRow) return;
		const pages = this.pages();
		bar.empty();
		rangeRow.empty();
		const scopes = FIGURE_SCOPES.filter((s) => s !== "section" || hasSections(pages)).map((id) => ({ id, label: t(`figures.scope.${id}`), icon: SCOPE_ICON[id] }));
		filterChips(bar, scopes, this.scopeChoice, (id) => {
			this.scopeChoice = id;
			lastScope = id;
			this.render();
		}, t("figures.scope.label"));
		bar.createDiv({ cls: "nb-figures-kinds" });
		if (this.scopeChoice === "range") this.renderRange(rangeRow, pages.length);
		rangeRow.toggleClass("is-on", this.scopeChoice === "range");
		this.renderGrid();
	}

	private setKind(k: FigureKind | null): void {
		this.kind = this.kind === k ? null : k;
		this.renderGrid();
	}

	private renderRange(row: HTMLElement, count: number): void {
		const input = row.createEl("input", {
			cls: "nb-modal-input nb-figures-range-input",
			attr: { type: "text", inputmode: "text", placeholder: t("figures.range.placeholder"), "aria-label": t("figures.range.label"), value: this.rangeText },
		});
		input.value = this.rangeText;
		const problem = row.createDiv({ cls: "nb-figures-range-problem", attr: { role: "status" } });
		const apply = (text: string, final: boolean): void => {
			this.rangeText = text;
			const result = parsePageRange(text, count);
			const issue = rangeProblem(result, count);
			const next = result.ok ? result.pages : null;
			problem.setText(issue !== null && (final || result.ok === false && result.error !== "empty") && text.trim() !== "" ? issue : "");
			if (next?.join(",") === this.rangePages?.join(",") && (next !== null) === (this.rangePages !== null)) return;
			this.rangePages = next;
			this.renderGrid();
		};
		let timer: number | null = null;
		input.addEventListener("input", () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => apply(input.value, false), 350);
		});
		input.addEventListener("change", () => apply(input.value, true));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") apply(input.value, true);
		});
		if (this.rangeText !== "") apply(this.rangeText, true);
	}

	/** Redraws the kind chips, the counts and the cards (not the scope row or the range field: the user may be typing in it). */
	private renderGrid(): void {
		const { grid, bar } = this;
		if (!grid || !bar) return;
		const all = this.entries();
		const counts = figureCounts(all);
		this.observer?.disconnect();
		this.near.clear();
		this.queue.clear();
		grid.empty();
		if (this.subtitle) this.subtitle.setText(t("figures.subtitle", { n: String(counts.total), pages: String(pageCount(all)) }));
		const kinds = bar.querySelector<HTMLElement>(".nb-figures-kinds");
		if (kinds) {
			kinds.empty();
			chip(kinds, { label: t("figures.kind.all"), count: counts.total, active: this.kind === null, key: "all", onClick: () => this.setKind(null) });
			for (const k of ["photo", "crop"] as const) {
				// A kind with nothing in it is not offered, except the one that is on.
				if (counts[k] === 0 && this.kind !== k) continue;
				chip(kinds, { label: t(`figures.kind.${k}`), icon: KIND_ICON[k], count: counts[k], active: this.kind === k, key: k, onClick: () => this.setKind(k) });
			}
		}
		const shown = filterFigures(all, this.kind);
		if (shown.length === 0) {
			const typing = this.scopeChoice === "range" && this.rangePages === null;
			shellNote(grid, t(typing ? "figures.none.range" : counts.total > 0 ? "figures.none.kind" : "figures.none"));
			return;
		}
		for (const entry of shown) this.card(grid, entry);
	}

	private card(grid: HTMLElement, entry: FigureEntry): void {
		const card = grid.createDiv({ cls: "nb-figures-card", attr: { "data-asset": entry.asset, "data-page": String(entry.pageIndex + 1), "data-kind": entry.kind, "data-key": entry.key } });
		const open = card.createEl("button", {
			cls: "nb-figures-tile",
			attr: { type: "button", "aria-label": t("figures.tile.aria", { kind: t(`figures.kind.${entry.kind}.one`), n: String(entry.pageIndex + 1) }) },
		});
		const frame = open.createDiv({ cls: "nb-figures-thumb" });
		const img = frame.createEl("img", { attr: { alt: "", draggable: "false" } });
		const cached = thumbs.get(entry.asset);
		if (cached) {
			img.src = cached;
			frame.addClass("is-ready");
		} else {
			setIcon(frame.createSpan({ cls: "nb-figures-ph", attr: { "aria-hidden": "true" } }), "image");
			this.observer?.observe(card);
		}
		const badge = open.createSpan({ cls: "nb-figures-badge", text: t("figures.page", { n: String(entry.pageIndex + 1) }) });
		badge.setAttribute("aria-hidden", "true");
		const kindMark = open.createSpan({ cls: `nb-figures-kind is-${entry.kind}`, attr: { "aria-hidden": "true" } });
		setIcon(kindMark, KIND_ICON[entry.kind]);

		const more = card.createEl("button", { cls: "nb-figures-more", attr: { type: "button", "aria-label": t("figures.more"), title: t("figures.more") } });
		setIcon(more, "more-horizontal");

		let pressTimer: number | null = null;
		let fired = false;
		let origin: [number, number] = [0, 0];
		let lastType = "mouse";
		const stop = (): void => {
			if (pressTimer !== null) window.clearTimeout(pressTimer);
			pressTimer = null;
		};
		open.addEventListener("pointerdown", (e) => {
			lastType = e.pointerType;
			fired = false;
			if (e.pointerType === "mouse" || e.button !== 0) return;
			origin = [e.clientX, e.clientY];
			stop();
			pressTimer = window.setTimeout(() => {
				pressTimer = null;
				fired = true;
				this.menu(entry, { x: origin[0], y: origin[1] });
			}, LONG_PRESS_MS);
		});
		open.addEventListener("pointermove", (e) => {
			if (pressTimer !== null && Math.hypot(e.clientX - origin[0], e.clientY - origin[1]) > PRESS_SLOP_PX) stop();
		});
		for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) open.addEventListener(type, stop);
		open.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			// A touch long-press also raises this event: the timer already opened the menu.
			if (lastType === "mouse" && !fired) this.menu(entry, { x: e.clientX, y: e.clientY });
		});
		open.addEventListener("click", (e) => {
			if (fired) {
				fired = false;
				e.preventDefault();
				return;
			}
			this.go(entry);
		});
		more.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const r = more.getBoundingClientRect();
			this.menu(entry, { x: r.left, y: r.bottom });
		});
	}

	private go(entry: FigureEntry): void {
		this.close();
		this.figures.goTo(entry);
	}

	private menu(entry: FigureEntry, at: { x: number; y: number }): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("figures.act.go", { n: String(entry.pageIndex + 1) })).setIcon("locate-fixed").onClick(() => this.go(entry)));
		menu.addItem((i) => i.setTitle(t("figures.act.copy")).setIcon("copy").onClick(() => void this.copy(entry)));
		const host = this.figures;
		if (host.insertIntoNote) {
			menu.addItem((i) => i.setTitle(t("figures.act.insert")).setIcon("file-input").onClick(() => {
				this.close();
				host.insertIntoNote?.(entry);
			}));
		}
		menu.addItem((i) => i.setTitle(t("figures.act.original")).setIcon("external-link").onClick(() => {
			if (this.figures.openOriginal(entry)) this.close();
			else showErrorNotice(t("figures.original.missing"), 6000);
		}));
		menu.showAtPosition(at);
	}

	private async copy(entry: FigureEntry): Promise<void> {
		const refused = this.figures.copyRefused?.(entry) ?? null;
		if (refused) {
			showErrorNotice(refused, 8000);
			return;
		}
		const ok = await copyFigureImage(this.figures, entry);
		if (ok) showNotice(t("figures.copied"), 3000);
		else showErrorNotice(t("figures.copyFailed"), 6000);
	}

	/** Queues the thumbnail of a card that scrolled into view. */
	private want(card: HTMLElement, asset: string): void {
		const done = thumbs.get(asset);
		if (done) {
			this.show(card, done);
			return;
		}
		this.queue.add(asset, async () => {
			if (!this.opened || !card.isConnected) return;
			// Not while the pen is writing (a notebook behind this dialog may be in use on a split view).
			await writing.idle();
			if (!this.opened) return;
			let url: string | null = null;
			let reason: Failure = "unreadable";
			try {
				url = await makeThumb(await this.figures.readAsset(asset));
			} catch {
				reason = "missing";
			}
			if (!this.opened) return;
			if (url) {
				thumbs.set(asset, url);
				// Every card of the same picture on the page gets it.
				for (const c of Array.from(this.grid?.querySelectorAll<HTMLElement>(".nb-figures-card") ?? [])) if (c.dataset.asset === asset) this.show(c, url);
			} else {
				for (const c of Array.from(this.grid?.querySelectorAll<HTMLElement>(".nb-figures-card") ?? [])) if (c.dataset.asset === asset) this.fail(c, reason);
			}
			// Let the interface breathe between two photos (the pen and scrolling come first).
			await new Promise<void>((resolve) => window.setTimeout(resolve, Platform.isMobile ? 30 : 0));
		});
	}

	private show(card: HTMLElement, url: string): void {
		const img = card.querySelector("img");
		const frame = card.querySelector<HTMLElement>(".nb-figures-thumb");
		if (!img || !frame) return;
		img.src = url;
		frame.addClass("is-ready");
		this.observer?.unobserve(card);
		this.near.delete(card);
	}

	private fail(card: HTMLElement, reason: Failure): void {
		const frame = card.querySelector<HTMLElement>(".nb-figures-thumb");
		if (!frame) return;
		frame.addClass("is-failed");
		frame.empty();
		setIcon(frame.createSpan({ cls: "nb-figures-ph", attr: { "aria-hidden": "true" } }), "image-off");
		frame.createSpan({ cls: "nb-figures-ph-text", text: t(reason === "missing" ? "figures.thumb.missing" : "figures.thumb.unreadable") });
		this.observer?.unobserve(card);
		this.near.delete(card);
	}
}

const SCOPE_ICON: Readonly<Record<FigureScope, string>> = { section: "bookmark", notebook: "book-open", range: "list-ordered" };

