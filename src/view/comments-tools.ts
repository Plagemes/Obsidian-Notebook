import { getLanguage, type App } from "obsidian";
import { t } from "../i18n";
import type { BBox } from "../ink/hit-test";
import type { PageBox } from "../ink/layout";
import type { Viewport } from "../ink/viewport";
import {
	addReplyCommand, cleanCommentText, commentCounts, createReply, planAddComment, deleteCommentCommand, editedComment, editedReply, findComment, isNote,
	regionFromBounds, repliesOf, replaceCommentCommand, resolvedComment, threadsOf, orderedNotes, type CommentFilter,
} from "../model/comments";
import type { PdfCommentLabels } from "../ink/export-pdf";
import type { Command } from "../model/history";
import type { CommentRegion, NotebookDocument, Page, PageCommentNote } from "../model/types";
import { writeSystemText } from "./clipboard";
import { CommentCard, type CardView } from "./comments-card";
import { CommentLayer } from "./comments-layer";
import { CommentModal, type CommentDraft } from "./comments-modal";
import { CommentsPanel } from "./comments-panel";

/**
 * View side of margin comments (0.18, roadmap #86): "Comment" on a selection, "Comment on a region" (a drawn rectangle), the
 * markers in the page margin, the card of one comment, the side panel. Every change is one undo step through the view's
 * history, which also refuses it on a locked page. The view passes itself as a CommentsHost.
 */
export interface CommentsHost {
	app: App;
	/** The page area: the card and the panel float over it, outside the stage. */
	body: HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not loading). */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	geometry(): { stage: HTMLElement; viewport: Viewport; boxes: readonly PageBox[] } | null;
	/** Registers a function called after every viewport, layout or history change; returns the function that removes it. */
	addOverlayListener(fn: () => void): () => void;
	/** Page and bounds (page coordinates) of the selection, or null. */
	selection(): { pageIndex: number; bounds: BBox } | null;
	clearSelection(): void;
	currentPage(): number;
	/** The name of this device, written as the author of a comment. */
	deviceName(): string;
	/** Brings page `pageIndex` into view with page y `y` at the top. */
	reveal(pageIndex: number, y: number): void;
	/** The setting "Show comment markers". */
	markersOn(): boolean;
	narrow(): boolean;
	notify(message: string): void;
	/** The contextual bar and sheets are redrawn (the panel and a pending rectangle change what they offer). */
	refreshUi(): void;
}

/** The time of a comment as the reader's language writes it. */
export function commentTime(ms: number): string {
	try {
		return new Date(ms).toLocaleString(getLanguage(), { dateStyle: "medium", timeStyle: "short" });
	} catch {
		return new Date(ms).toISOString();
	}
}

/** The words of the margin notes of a PDF export, in the reader's language. */
export function pdfCommentLabels(): PdfCommentLabels {
	return { resolved: t("comments.resolved").toLowerCase(), sketch: t("comments.markdown.sketch"), more: (n) => t("comments.pdf.more", { n: String(n) }), when: commentTime };
}

export class CommentTools {
	private readonly layer: CommentLayer;
	private readonly card: CommentCard;
	private readonly panel: CommentsPanel;
	private readonly off: () => void;
	private selected: { pageId: string; id: string } | null = null;
	private filter: CommentFilter = "open";
	/** Identity numbers of the comment lists of the pages, to notice a change without comparing the lists. */
	private readonly ids = new WeakMap<object, number>();
	private nextId = 1;
	private signature = "";

	constructor(private readonly host: CommentsHost) {
		this.layer = new CommentLayer({
			doc: () => host.doc(),
			geometry: () => host.geometry(),
			markersOn: () => host.markersOn(),
			selected: () => this.selected,
			pick: (pageId, id) => this.toggle(pageId, id),
		});
		this.card = new CommentCard(host.body, {
			reply: (pageId, parent, text) => this.reply(pageId, parent, text),
			edit: (pageId, id) => this.edit(pageId, id),
			setResolved: (pageId, id, resolved) => this.setResolved(pageId, id, resolved),
			remove: (pageId, id) => this.remove(pageId, id),
			close: () => this.closeCard(),
		}, () => host.narrow());
		this.panel = new CommentsPanel(host.body, {
			open: (pageId, id) => this.open(pageId, id),
			add: () => this.commentOnRegion(),
			close: () => this.setPanelOpen(false),
		}, (f) => {
			this.filter = f;
			this.update(true);
		});
		this.off = host.addOverlayListener(() => this.update());
		this.update(true);
	}

	destroy(): void {
		this.off();
		this.layer.destroy();
		this.card.destroy();
		this.panel.destroy();
	}

	// --- state the registry reads -------------------------------------------------------------------------------------

	get panelOpen(): boolean {
		return this.panel.open;
	}

	get drawing(): boolean {
		return this.layer.armed;
	}

	/** How many comments the notebook has (for the sheet's badge and the empty states). */
	get counts(): { open: number; resolved: number; total: number } {
		const doc = this.host.doc();
		return doc ? commentCounts(doc) : { open: 0, resolved: 0, total: 0 };
	}

	// --- adding ---------------------------------------------------------------------------------------------------------

	/** "Comment" on the selection: the region is the selection's box, padded; the editor opens, and Done adds the comment. */
	commentOnSelection(): void {
		const doc = this.host.doc();
		const sel = this.host.selection();
		const page = sel ? doc?.pages[sel.pageIndex] : undefined;
		if (!sel || !page || !this.host.editable()) return;
		const region = regionFromBounds(sel.bounds, page);
		this.compose(sel.pageIndex, region);
	}

	/** "Comment on a region": a one-shot rectangle on a page, then the editor. */
	commentOnRegion(): void {
		if (!this.host.editable()) return;
		this.closeCard();
		this.host.clearSelection();
		this.layer.armDraw((pageIndex, region) => {
			this.host.refreshUi();
			this.compose(pageIndex, region);
		}, () => this.host.refreshUi());
		this.host.refreshUi();
	}

	/** The editor for a new comment on `region` of page `pageIndex`. */
	private compose(pageIndex: number, region: CommentRegion): void {
		const doc = this.host.doc();
		const page = doc?.pages[pageIndex];
		if (!page) return;
		if (page.locked) {
			this.host.notify(t("comments.locked"));
			return;
		}
		new CommentModal(this.host.app, { kind: "comment", editing: false, text: "", page: pageIndex + 1 }, (draft) => {
			const outcome = this.add(page.id, region, draft);
			if (outcome === "full") this.host.notify(t("comments.full"));
			else if (outcome === "locked") this.host.notify(t("comments.locked"));
		}).open();
	}

	/** Adds the comment to its page; the outcome says why not (the caller tells the user, once). */
	private add(pageId: string, region: CommentRegion, draft: CommentDraft): "ok" | "empty" | "none" | "full" | "locked" {
		// The page can be gone while the editor was open (deleted, or removed by a sync): what was typed goes to the page in view.
		const page = this.page(pageId) ?? this.host.doc()?.pages[this.host.currentPage()];
		if (!page) return "none";
		const plan = planAddComment(page, { region, text: draft.text, ...(draft.sketch ? { sketch: draft.sketch } : {}), author: this.host.deviceName(), now: Date.now() });
		if (!plan.ok) return plan.reason;
		if (!this.host.execute(plan.command)) return "locked";
		this.select(page.id, plan.note.id);
		return "ok";
	}

	/**
	 * The comment (or its page) went while the editor was open: the typed text is kept as a new comment, on its page if it is still
	 * there. The notice says so only once that worked; if the page is locked or full (or gone), the text goes to the clipboard.
	 */
	private keepAsNew(pageId: string, region: CommentRegion, draft: CommentDraft): void {
		const text = cleanCommentText(draft.text);
		if (text === "" && !draft.sketch) return;
		const outcome = this.add(pageId, region, draft);
		if (outcome === "ok") {
			this.host.notify(t("comments.keptAsNew"));
		} else if (outcome !== "empty" && text !== "") {
			void writeSystemText(text).then((copied) => this.host.notify(t(copied ? "comments.keptCopied" : "comments.keptLost", { text })));
		} else if (outcome !== "empty") {
			this.host.notify(t("comments.keptLostSketch"));
		}
	}

	// --- one comment ------------------------------------------------------------------------------------------------

	private page(pageId: string): Page | undefined {
		return this.host.doc()?.pages.find((p) => p.id === pageId);
	}

	private pageIndex(pageId: string): number {
		return this.host.doc()?.pages.findIndex((p) => p.id === pageId) ?? -1;
	}

	private edit(pageId: string, id: string): void {
		const page = this.page(pageId);
		const c = page ? findComment(page, id) : undefined;
		if (!page || !c || !this.host.editable()) return;
		const reply = !isNote(c);
		const start = isNote(c) ? c.sketch : undefined;
		// Where the text goes if its comment disappears meanwhile: the comment's place (a reply's: its comment's).
		const home = isNote(c) ? c : findComment(page, c.parent);
		const region = home && isNote(home) ? home.region : { x: 20, y: 20, width: 120, height: 60 };
		new CommentModal(this.host.app, { kind: reply ? "reply" : "comment", editing: true, text: c.text, sketch: start, page: this.pageIndex(pageId) + 1 }, (draft) => {
			const now = this.page(pageId);
			const current = now ? findComment(now, id) : undefined;
			if (!now || !current) {
				this.keepAsNew(pageId, region, draft);
				return;
			}
			const next = isNote(current) ? editedComment(current, { text: draft.text, sketch: draft.sketch }, Date.now()) : editedReply(current, draft.text, Date.now());
			const cmd = next ? replaceCommentCommand(now, id, next, reply ? "Edit reply" : "Edit comment") : null;
			if (cmd && !this.host.execute(cmd)) this.host.notify(t("comments.locked"));
		}).open();
	}

	private setResolved(pageId: string, id: string, resolved: boolean): void {
		const page = this.page(pageId);
		const c = page ? findComment(page, id) : undefined;
		if (!page || !c || !isNote(c)) return;
		const next = resolvedComment(c, resolved, Date.now());
		const cmd = next ? replaceCommentCommand(page, id, next, resolved ? "Resolve comment" : "Reopen comment") : null;
		if (cmd && !this.host.execute(cmd)) this.host.notify(t("comments.locked"));
	}

	private remove(pageId: string, id: string): void {
		const page = this.page(pageId);
		const c = page ? findComment(page, id) : undefined;
		const cmd = page ? deleteCommentCommand(page, id) : null;
		if (!page || !c || !cmd) return;
		if (!this.host.execute(cmd)) {
			this.host.notify(t("comments.locked"));
			return;
		}
		if (isNote(c)) this.closeCard();
		this.host.notify(t(isNote(c) ? "comments.deleted" : "comments.replyDeleted"));
	}

	private reply(pageId: string, parent: string, text: string): boolean {
		const page = this.page(pageId);
		const reply = page ? createReply(page, parent, text, this.host.deviceName(), Date.now()) : null;
		const cmd = page && reply ? addReplyCommand(page, reply) : null;
		if (!cmd) return false;
		if (!this.host.execute(cmd)) {
			this.host.notify(t("comments.locked"));
			return false;
		}
		return true;
	}

	// --- selection, card and panel ----------------------------------------------------------------------------------

	/** A marker was tapped: opens its card, or closes it when it already is the open one. */
	private toggle(pageId: string, id: string): void {
		if (this.selected?.id === id && this.selected.pageId === pageId) this.closeCard();
		else this.select(pageId, id);
	}

	/** Opens the card of a comment (no scrolling). */
	private select(pageId: string, id: string): void {
		this.selected = { pageId, id };
		this.update(true);
		this.card.focusReply();
	}

	/** Jumps to the region of a comment (the panel's rows) and opens its card. */
	open(pageId: string, id: string): void {
		const page = this.page(pageId);
		const c = page ? findComment(page, id) : undefined;
		const index = this.pageIndex(pageId);
		if (!page || !c || !isNote(c) || index < 0) return;
		this.host.reveal(index, Math.max(0, c.region.y - 80));
		this.selected = { pageId, id };
		this.update(true);
		// A phone shows the card as a sheet over the panel: the panel steps aside.
		if (this.host.narrow()) this.setPanelOpen(false);
	}

	closeCard(): void {
		if (!this.selected) return;
		this.selected = null;
		this.update(true);
	}

	setPanelOpen(open: boolean): void {
		if (this.panel.open === open) return;
		this.panel.setOpen(open);
		this.update(true);
		this.host.refreshUi();
	}

	togglePanel(): void {
		this.setPanelOpen(!this.panel.open);
	}

	/** Moves the view to the next (or previous) open comment after the page in view; false when there is none. */
	step(delta: 1 | -1): boolean {
		const doc = this.host.doc();
		if (!doc) return false;
		const list = threadsOf(doc, "open");
		if (list.length === 0) return false;
		const here = this.host.currentPage();
		const after = delta === 1 ? list.find((r) => r.pageIndex > here) ?? list[0] : [...list].reverse().find((r) => r.pageIndex < here) ?? list[list.length - 1];
		if (!after) return false;
		this.open(after.page.id, after.note.id);
		return true;
	}

	/** Key of the state the markers, card and panel are drawn from: changes when a comment list is replaced or a view setting flips. */
	private sign(doc: NotebookDocument): string {
		let s = "";
		for (const p of doc.pages) {
			if (!p.comments) continue;
			let id = this.ids.get(p.comments);
			if (id === undefined) {
				id = this.nextId++;
				this.ids.set(p.comments, id);
			}
			s += `${p.id}:${id}:${p.locked ? 1 : 0};`;
		}
		return `${s}|${this.host.editable() ? 1 : 0}|${this.filter}|${this.selected?.id ?? ""}|${this.panel.open ? 1 : 0}`;
	}

	/** After a viewport, layout or history change (or `force`): the markers are placed, the card and panel follow. */
	private update(force = false): void {
		const doc = this.host.doc();
		this.layer.draw();
		if (!doc) {
			this.card.hide();
			return;
		}
		const sig = this.sign(doc);
		const changed = force || sig !== this.signature;
		this.signature = sig;
		if (changed) {
			this.syncCard(doc);
			this.syncPanel(doc);
		}
		if (this.card.open) {
			const s = this.card.target;
			this.card.place(s ? this.layer.markerOf(s.id)?.getBoundingClientRect() ?? null : null, this.host.body.getBoundingClientRect());
		}
	}

	private syncCard(doc: NotebookDocument): void {
		const sel = this.selected;
		const view = sel ? this.cardView(doc, sel) : null;
		if (!sel || !view) {
			// The comment is gone (deleted, undone): the highlight goes with it.
			if (sel) this.selected = null;
			this.card.hide();
			this.layer.draw();
			return;
		}
		this.card.show(view, sel);
		this.layer.draw();
	}

	private cardView(doc: NotebookDocument, sel: { pageId: string; id: string }): CardView | null {
		const pageIndex = doc.pages.findIndex((p) => p.id === sel.pageId);
		const page = doc.pages[pageIndex];
		const note = page ? findComment(page, sel.id) : undefined;
		if (!page || !note || !isNote(note)) return null;
		const number = orderedNotes(page).findIndex((n: PageCommentNote) => n.id === note.id) + 1;
		return {
			page, pageNumber: pageIndex + 1, note, replies: repliesOf(page, note.id), number,
			canEdit: this.host.editable() && !page.locked, locked: page.locked === true,
		};
	}

	private syncPanel(doc: NotebookDocument): void {
		if (!this.panel.open) return;
		this.panel.update({
			threads: threadsOf(doc, this.filter), counts: commentCounts(doc), filter: this.filter, selected: this.selected, canAdd: this.host.editable(),
		});
	}
}
