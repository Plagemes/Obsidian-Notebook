/**
 * Links of PDF pages (0.16, roadmap #46): a tap on a link goes to the notebook page that shows the PDF page it points at, or
 * (a web address) asks first and then opens it. The boxes of the links come from pdf.js (`PdfStore.pageLinks`, read once per
 * page); the geometry is in pdf/pdf-outline.ts and pdf/text-select.ts. Nothing here changes a notebook file.
 *
 * Who follows a link: a finger tap (when the finger pans, it does not write), a mouse click with Ctrl/Cmd, any tap while the
 * notebook is read-only, and any tap in the Select text mode (view/pdf-text.ts calls `tapAt`). A pen tap in the normal
 * mode stays ink: a dot on a page is a legitimate stroke, and it is never taken away.
 */
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import type { Layout } from "../ink/layout";
import { backgroundRect } from "../model/margins";
import { sourcePageIndex } from "../model/pdf-outline-map";
import { viewOf, viewSize } from "../model/pdf-view";
import type { NotebookDocument } from "../model/types";
import { linkAt, safeExternalUrl, type PdfPageLink, type PdfPageLinks } from "../pdf/pdf-outline";
import { isTap, pageToPdf } from "../pdf/text-select";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";

/** What the links need from the notebook view. */
export interface PdfLinksHost {
	app: App;
	stage: HTMLElement;
	/** The setting: links are followed. */
	enabled(): boolean;
	/** The document shown (also while it is read-only). */
	doc(): NotebookDocument | null;
	layout(): Layout | null;
	/** The links of a page of a PDF (`PdfStore.pageLinks`). */
	pageLinks(asset: string, page: number): Promise<PdfPageLinks>;
	/** The page and the point on it under a client position, or null. */
	pageAtClient(clientX: number, clientY: number): { pageIndex: number; local: [number, number] } | null;
	/** A finger writes (so its tap is ink, not a link). */
	fingerWrites(): boolean;
	/** The notebook cannot be edited: any tap may follow a link. */
	readOnly(): boolean;
	/** The Select text mode is on: it follows the links itself. */
	selecting(): boolean;
	/** Page-view scale, to turn a finger-sized tolerance into pt. */
	scale(): number;
	/** Goes to a page (recorded in the back/forward history). */
	goTo(index: number): void;
}

/** A tap lands this close (CSS px) to a link's box and still counts. */
const TOLERANCE_PX = 6;

interface Contact {
	id: number;
	x: number;
	y: number;
	t: number;
	type: string;
	ctrl: boolean;
	moved: boolean;
}

export class PdfLinks {
	private readonly cache = new Map<string, PdfPageLinks>();
	private readonly loading = new Map<string, Promise<PdfPageLinks | null>>();
	/** Pages whose links could not be read: not asked for again by the read-ahead (a tap still tries). */
	private readonly unreadable = new Set<string>();
	private contact: Contact | null = null;
	private readonly disposers: Array<() => void> = [];
	private destroyed = false;

	constructor(private readonly host: PdfLinksHost) {
		const stage = host.stage;
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			stage.addEventListener(type, fn, { passive: true });
			this.disposers.push(() => stage.removeEventListener(type, fn));
		};
		on("pointerdown", (e) => {
			// A second finger makes it a gesture (pinch, two-finger tap): not a tap on a link.
			this.contact = e.isPrimary && this.host.enabled() ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, type: e.pointerType, ctrl: e.ctrlKey || e.metaKey, moved: false } : null;
		});
		on("pointermove", (e) => {
			const c = this.contact;
			if (c && c.id === e.pointerId && Math.hypot(e.clientX - c.x, e.clientY - c.y) > 8) c.moved = true;
		});
		on("pointercancel", () => {
			this.contact = null;
		});
		on("pointerup", (e) => {
			const c = this.contact;
			this.contact = null;
			if (!c || c.id !== e.pointerId || c.moved || !isTap(Math.hypot(e.clientX - c.x, e.clientY - c.y), e.timeStamp - c.t)) return;
			if (this.host.selecting() || !this.host.enabled()) return;
			const follows = this.host.readOnly() || (c.type === "touch" && !this.host.fingerWrites()) || (c.type === "mouse" && c.ctrl);
			if (follows) void this.followAtClient(e.clientX, e.clientY);
		});
	}

	/** Reads the links of a page in the background (a tap then finds them at once). */
	prefetch(asset: string, page: number): void {
		if (this.unreadable.has(`${asset}|${page}`) || this.cache.has(`${asset}|${page}`)) return;
		void this.links(asset, page);
	}

	/** The links of a page if they are read already. */
	peek(asset: string, page: number): PdfPageLinks | null {
		return this.cache.get(`${asset}|${page}`) ?? null;
	}

	/** Reads the links of a page (null when they cannot be read). */
	links(asset: string, page: number): Promise<PdfPageLinks | null> {
		const key = `${asset}|${page}`;
		const have = this.cache.get(key);
		if (have) return Promise.resolve(have);
		let p = this.loading.get(key);
		if (!p) {
			p = this.host.pageLinks(asset, page).then(
				(r) => {
					this.cache.set(key, r);
					this.unreadable.delete(key);
					return r;
				},
				() => {
					this.unreadable.add(key);
					return null;
				},
			).finally(() => this.loading.delete(key));
			this.loading.set(key, p);
		}
		return p;
	}

	private followAtClient(clientX: number, clientY: number): Promise<boolean> {
		const at = this.host.pageAtClient(clientX, clientY);
		return at ? this.tapAt(at.pageIndex, at.local) : Promise.resolve(false);
	}

	/** Follows the link at a point of a notebook page, if there is one. True when there was one (whether or not it could be followed). */
	async tapAt(pageIndex: number, local: readonly [number, number]): Promise<boolean> {
		const doc = this.host.doc();
		const page = doc?.pages[pageIndex];
		const bg = page?.background;
		if (!doc || !page || bg?.kind !== "pdf") return false;
		const found = await this.links(bg.asset, bg.page);
		if (!found || this.destroyed) return false;
		const rect = backgroundRect(page);
		const view = viewOf(bg);
		const pt = pageToPdf({ x: local[0], y: local[1] }, rect, found, view);
		// The tolerance is in PDF points: the page scale over the view's size (a quarter turn swaps the sides).
		const across = viewSize(view, found).width;
		const tolerance = TOLERANCE_PX / Math.max(0.05, this.host.scale()) * (across / Math.max(1, rect.width));
		const link = linkAt(found.links, pt, tolerance);
		if (!link) return false;
		this.follow(doc, bg.asset, link);
		return true;
	}

	/** True when a link of the page lies under the point (used to keep a tap from selecting a word under a link). */
	hasLinkAt(pageIndex: number, local: readonly [number, number]): boolean {
		const page = this.host.doc()?.pages[pageIndex];
		const bg = page?.background;
		if (!page || bg?.kind !== "pdf") return false;
		const found = this.peek(bg.asset, bg.page);
		if (!found) return false;
		const rect = backgroundRect(page);
		return linkAt(found.links, pageToPdf({ x: local[0], y: local[1] }, rect, found, viewOf(bg))) !== null;
	}

	private follow(doc: NotebookDocument, asset: string, link: PdfPageLink): void {
		if (link.page !== undefined) {
			const index = sourcePageIndex(doc.pages, asset).get(link.page);
			if (index === undefined) showNotice(t("pdfLinks.notInNotebook", { n: String(link.page) }), 4000);
			else this.host.goTo(index);
			return;
		}
		const url = link.url ? safeExternalUrl(link.url) : null;
		if (!url) {
			showNotice(t("pdfLinks.blocked"), 4000);
			return;
		}
		new ConfirmLinkModal(this.host.app, url).open();
	}

	destroy(): void {
		this.destroyed = true;
		for (const off of this.disposers.splice(0)) off();
		this.contact = null;
		this.cache.clear();
		this.loading.clear();
		this.unreadable.clear();
	}
}

/** Asks before a web address in a PDF is opened outside Obsidian. */
class ConfirmLinkModal extends Modal {
	constructor(app: App, private readonly address: string) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("pdfLinks.confirmTitle"), icon: "external-link", size: "narrow", cls: "notebook-pdflink-modal" });
		shellNote(shell.body, t("pdfLinks.confirmBody"));
		shell.body.createDiv({ cls: "nb-pdflink-address", text: this.address, attr: { translate: "no" } });
		shellButton(shell.foot, "secondary", t("pdfLinks.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("pdfLinks.open"), () => {
			window.open(this.address, "_blank", "noopener");
			this.close();
		}, { icon: "external-link" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
