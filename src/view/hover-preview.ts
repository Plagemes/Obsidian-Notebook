/**
 * 0.17 hover (O5): hovering a link to a notebook page (`[[Physics.notebook#p3&id=...]]`) shows the page thumbnail, the
 * notebook name and the page number in Obsidian's Page preview popover; clicking the card opens the page. It listens to the
 * workspace `hover-link` event, so it follows the core plugin's switch and its Ctrl/Cmd setting. Read only: the notebook
 * is read, never written. The thumbnail is drawn once per page version, when the pen is quiet, and cached.
 * Android has no hover: Obsidian's own long press raises the same event and is left as it is.
 */
import { HoverPopover, Keymap, parseLinktext, setIcon, type App, type Plugin, type TFile } from "obsidian";
import { writing } from "../ink/writing-guard";
import { openNotebookAtPage } from "../integration/open";
import { embedPixelWidth } from "../integration/links";
import { t } from "../i18n";
import type { NotebookDocument, Page } from "../model/types";
import { NOTEBOOK_EXTENSIONS, isNotebookFile } from "../storage/format";
import { renderThumbnail, type ThumbnailOptions } from "../library/thumbnail";
import {
	HOVER_SOURCE_ID, asHoverLinkEvent, hoverPage, hoverTarget, mayBeNotebookLink, readPagePreviewConfig, shouldShowPreview, splitLinktext,
} from "./hover-preview-logic";

export interface HoverPreviewDeps {
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	background(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
}

const CARD_WIDTH = 260;
const SHOW_DELAY_MS = 300;
const CACHE_MAX = 40;

interface Shown {
	url: string;
	total: number;
	index: number;
	pageId: string;
}

/** Page thumbnails for the popover: drawn after the pen is quiet, remembered by file version and page. */
export class HoverThumbs {
	private readonly cache = new Map<string, Shown | null>();
	private readonly pending = new Map<string, Promise<Shown | "deleted" | null>>();

	constructor(private readonly deps: HoverPreviewDeps, private readonly width: () => number) {}

	load(file: TFile, target: ReturnType<typeof hoverTarget>): Promise<Shown | "deleted" | null> {
		const key = `${file.path}@${file.stat.mtime}#${target.pageId ?? ""}:${target.page ?? ""}@${this.width()}`;
		if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null);
		const job = this.pending.get(key) ?? this.start(key, file, target);
		return job.then((shown) => {
			if (shown !== "deleted") this.remember(key, shown);
			return shown;
		});
	}

	private start(key: string, file: TFile, target: ReturnType<typeof hoverTarget>): Promise<Shown | "deleted" | null> {
		const job = this.draw(file, target).finally(() => this.pending.delete(key));
		this.pending.set(key, job);
		return job;
	}

	private remember(key: string, shown: Shown | null): void {
		this.cache.set(key, shown);
		if (this.cache.size > CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
	}

	private async draw(file: TFile, target: ReturnType<typeof hoverTarget>): Promise<Shown | "deleted" | null> {
		try {
			await writing.idle();
			const doc = await this.deps.readNotebook(file);
			if (!doc) return null;
			const found = hoverPage(doc.pages, target);
			if ("missing" in found) return "deleted";
			const page = doc.pages[found.index];
			if (!page) return null;
			const width = this.width();
			const drawBackground = await this.deps.background(doc, page, width);
			const url = renderThumbnail(page, width, { drawBackground: drawBackground ?? undefined, mime: "image/jpeg", quality: 0.82 });
			return url ? { url, total: doc.pages.length, index: found.index, pageId: page.id } : null;
		} catch (e) {
			console.error("[notebook] hover preview failed", file.path, e);
			return null;
		}
	}
}

/** Registers the hover source and the `hover-link` listener. */
export function registerHoverPreview(plugin: Plugin, deps: HoverPreviewDeps): void {
	const { app } = plugin;
	const thumbs = new HoverThumbs(deps, () => embedPixelWidth(CARD_WIDTH, window.devicePixelRatio || 1, 1024));
	plugin.registerHoverLinkSource(HOVER_SOURCE_ID, { display: "Notebook", defaultMod: true });

	// `hover-link` is not in the typings; the event is read leniently.
	type Hook = (name: string, cb: (e: unknown) => void) => ReturnType<typeof app.workspace.on>;
	const on = app.workspace.on.bind(app.workspace) as unknown as Hook;
	plugin.registerEvent(on("hover-link", (raw) => {
		const e = asHoverLinkEvent(raw);
		if (!e || !mayBeNotebookLink(e.linktext, NOTEBOOK_EXTENSIONS)) return;
		const config = readPagePreviewConfig((app as unknown as { internalPlugins?: unknown }).internalPlugins);
		if (!shouldShowPreview(config, e.source, Keymap.isModEvent(e.event) !== false)) return;
		const { path, subpath } = splitLinktext(e.linktext);
		const file = app.metadataCache.getFirstLinkpathDest(parseLinktext(path).path, e.sourcePath ?? "");
		if (!file || !isNotebookFile(file)) return;
		showCard(app, thumbs, e.hoverParent, e.targetEl as HTMLElement, file, hoverTarget(subpath));
	}));
}

function showCard(
	app: App, thumbs: HoverThumbs, parent: unknown, targetEl: HTMLElement, file: TFile, target: ReturnType<typeof hoverTarget>,
): void {
	if (typeof parent !== "object" || parent === null || !("hoverPopover" in parent)) return;
	const owner = parent as { hoverPopover: HoverPopover | null };
	if ((owner.hoverPopover as { targetEl?: unknown } | null)?.targetEl === targetEl) return;
	const popover = new HoverPopover(owner, targetEl, SHOW_DELAY_MS);
	const card = popover.hoverEl.createDiv({ cls: "nb-ui nb-hover-card", attr: { role: "button", tabindex: "0", "aria-label": t("hover.open") } });
	const thumb = card.createDiv({ cls: "nb-hover-thumb nb-hover-loading" });
	const meta = card.createDiv({ cls: "nb-hover-meta" });
	setIcon(meta.createSpan({ cls: "nb-hover-icon" }), "pencil-line");
	const text = meta.createDiv({ cls: "nb-hover-text" });
	text.createDiv({ cls: "nb-hover-title", text: file.basename });
	const sub = text.createDiv({ cls: "nb-hover-sub", text: target.page !== null ? t("nav.page", { n: String(target.page) }) : "" });

	let opened: { page: number | null; pageId: string | null } = { page: target.page, pageId: target.pageId };
	const open = (ev: Event): void => {
		ev.preventDefault();
		ev.stopPropagation();
		void openNotebookAtPage(app, file, opened.page, null, opened.pageId);
		(popover as unknown as { hide?: () => void }).hide?.();
	};
	card.addEventListener("click", open);
	card.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") open(ev); });

	void thumbs.load(file, target).then((shown) => {
		thumb.removeClass("nb-hover-loading");
		if (shown === "deleted") {
			thumb.addClass("nb-hover-empty");
			thumb.setText(t("hover.deleted"));
			sub.setText("");
			opened = { page: 1, pageId: null };
			return;
		}
		if (!shown) {
			thumb.addClass("nb-hover-empty");
			thumb.setText(t("hover.unreadable"));
			return;
		}
		thumb.createEl("img", { attr: { src: shown.url, alt: "", draggable: "false", decoding: "async" } });
		sub.setText(t("hover.pageOf", { n: String(shown.index + 1), total: String(shown.total) }));
		opened = { page: shown.index + 1, pageId: shown.pageId };
	});
}
