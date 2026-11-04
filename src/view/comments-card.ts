import { getLanguage, setIcon } from "obsidian";
import { t } from "../i18n";
import { cleanCommentText } from "../model/comments-format";
import type { CommentReply, Page, PageCommentNote } from "../model/types";
import { COMMENT_TEXT_MAX } from "../model/types";
import { sketchCanvas } from "./comments-sketch";

/** What the card asks the controller to do. Each is one undo step (or a dialog that ends in one). */
export interface CardActions {
	reply(pageId: string, parentId: string, text: string): boolean;
	edit(pageId: string, id: string): void;
	setResolved(pageId: string, id: string, resolved: boolean): void;
	remove(pageId: string, id: string): void;
	close(): void;
}

/** What the card shows: the comment, its page and replies, its marker number. Null when the comment is gone. */
export interface CardView {
	page: Page;
	pageNumber: number;
	note: PageCommentNote;
	replies: readonly CommentReply[];
	number: number;
	/** The notebook can be edited and the page is not locked. */
	canEdit: boolean;
	/** The page is locked (the card says so instead of offering edits). */
	locked: boolean;
}

/** Events kept from the page below the card and from the view's shortcuts (Backspace deletes a selection). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "mousedown", "contextmenu", "click", "keydown", "keyup", "wheel"] as const;

/** Width of the card beside a marker (CSS px) and its distance from it. */
const CARD_W = 320;
const GAP = 10;

function stamp(ms: number): string {
	try {
		return new Date(ms).toLocaleString(getLanguage(), { dateStyle: "medium", timeStyle: "short" });
	} catch {
		return new Date(ms).toISOString();
	}
}

/**
 * The card of one comment (0.18, #86): who wrote it and when, the text and sketch, the flat thread of replies, a box to reply,
 * and Resolve / Reopen, Edit and Delete. Floats beside the margin marker on a tablet or desktop and docks to the bottom edge on
 * a phone. It sits outside the stage so its taps never reach the pen input. The reply box keeps what is typed in it while the
 * rest of the card is redrawn (a change from another place, an undo).
 */
export class CommentCard {
	readonly el: HTMLElement;
	private readonly head: HTMLElement;
	private readonly thread: HTMLElement;
	private readonly foot: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly resolve: HTMLButtonElement;
	private shown: { pageId: string; id: string } | null = null;
	private lastKey = "";
	private left = 0;
	private top = 0;

	constructor(parent: HTMLElement, private readonly actions: CardActions, private readonly narrow: () => boolean) {
		this.el = parent.createDiv({ cls: "nb-ui nb-cm-card notebook-hidden", attr: { role: "dialog", "aria-label": t("comments.card.aria"), "data-key": "comment-card" } });
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		this.head = this.el.createDiv({ cls: "nb-cm-card-head" });
		this.thread = this.el.createDiv({ cls: "nb-cm-thread" });
		this.foot = this.el.createDiv({ cls: "nb-cm-card-foot" });
		const reply = this.foot.createDiv({ cls: "nb-cm-reply" });
		this.input = reply.createEl("textarea", {
			cls: "nb-cm-reply-input",
			attr: { rows: "1", maxlength: String(COMMENT_TEXT_MAX), placeholder: t("comments.reply.placeholder"), "aria-label": t("comments.reply.placeholder"), "data-key": "comment-reply-input" },
		});
		this.send = reply.createEl("button", { cls: "nb-cm-icon-btn is-primary", attr: { type: "button", "aria-label": t("comments.reply.send"), title: t("comments.reply.send"), "data-key": "comment-reply-send" } });
		setIcon(this.send, "send");
		const submit = () => {
			const s = this.shown;
			if (!s) return;
			const text = cleanCommentText(this.input.value);
			if (text === "") return;
			if (this.actions.reply(s.pageId, s.id, text)) {
				this.input.value = "";
				this.sync();
			}
		};
		this.send.addEventListener("click", submit);
		this.input.addEventListener("input", () => this.sync());
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
				e.preventDefault();
				submit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.actions.close();
			}
		});
		this.resolve = this.foot.createEl("button", { cls: "nb-cm-resolve", attr: { type: "button", "data-key": "comment-resolve" } });
		this.resolve.addEventListener("click", () => {
			const s = this.shown;
			if (!s) return;
			const note = this.lastNote;
			if (note) this.actions.setResolved(s.pageId, s.id, note.resolved !== true);
		});
	}

	private lastNote: PageCommentNote | null = null;

	get open(): boolean {
		return this.shown !== null;
	}

	get target(): { pageId: string; id: string } | null {
		return this.shown;
	}

	hide(): void {
		this.shown = null;
		this.lastKey = "";
		this.lastNote = null;
		this.el.addClass("notebook-hidden");
	}

	/** Shows (or redraws) the card for a comment; hides it when the comment is gone. */
	show(view: CardView | null, target: { pageId: string; id: string }): void {
		if (!view) {
			this.hide();
			return;
		}
		const changedTarget = this.shown?.id !== target.id;
		this.shown = target;
		this.lastNote = view.note;
		this.el.removeClass("notebook-hidden");
		const key = JSON.stringify([view.note, view.replies, view.canEdit, view.locked, view.number, view.pageNumber]);
		if (key !== this.lastKey) {
			this.lastKey = key;
			this.render(view, target);
		}
		if (changedTarget) {
			this.input.value = "";
			this.sync();
		}
		const canReply = view.canEdit;
		this.foot.toggleClass("is-locked", !canReply);
		this.input.disabled = !canReply;
		this.resolve.disabled = !canReply;
		this.sync();
		setResolveLabel(this.resolve, view.note.resolved === true);
	}

	private sync(): void {
		this.send.disabled = this.input.disabled || cleanCommentText(this.input.value) === "";
	}

	private render(v: CardView, target: { pageId: string; id: string }): void {
		const note = v.note;
		this.head.empty();
		const badge = this.head.createSpan({ cls: "nb-cm-card-badge", text: String(v.number) });
		badge.toggleClass("is-resolved", note.resolved === true);
		const title = this.head.createDiv({ cls: "nb-cm-card-title" });
		title.createDiv({ cls: "nb-cm-card-name", text: t("comments.card.title", { n: String(v.number), page: String(v.pageNumber) }) });
		if (note.resolved) title.createDiv({ cls: "nb-cm-card-state", text: t("comments.resolved") });
		else if (v.locked) title.createDiv({ cls: "nb-cm-card-state", text: t("comments.pageLocked") });
		const close = this.head.createEl("button", { cls: "nb-cm-icon-btn", attr: { type: "button", "aria-label": t("comments.close"), title: t("comments.close"), "data-key": "comment-close" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.actions.close());

		this.thread.empty();
		this.entry(this.thread, note, v.canEdit, target.pageId, true);
		for (const r of v.replies) this.entry(this.thread, r, v.canEdit, target.pageId, false);
	}

	/** One comment or reply of the thread: author and time, the text, the sketch, and its Edit and Delete. */
	private entry(parent: HTMLElement, c: PageCommentNote | CommentReply, canEdit: boolean, pageId: string, root: boolean): void {
		const row = parent.createDiv({ cls: `nb-cm-entry${root ? " is-root" : ""}` });
		const meta = row.createDiv({ cls: "nb-cm-meta" });
		meta.createSpan({ cls: "nb-cm-author", text: c.author || t("comments.unknownAuthor") });
		meta.createSpan({ cls: "nb-cm-when", text: stamp(c.created) });
		if (c.edited !== undefined) meta.createSpan({ cls: "nb-cm-edited", text: t("comments.edited") });
		if (c.text !== "") row.createDiv({ cls: "nb-cm-text", text: c.text });
		if ("sketch" in c && c.sketch) sketchCanvas(row, c.sketch, 260, t("comments.sketch.aria"));
		if (!canEdit) return;
		const tools = row.createDiv({ cls: "nb-cm-entry-tools" });
		const edit = tools.createEl("button", { cls: "nb-cm-icon-btn", attr: { type: "button", "aria-label": t("comments.edit"), title: t("comments.edit"), "data-key": `comment-edit:${c.id}` } });
		setIcon(edit, "pencil");
		edit.addEventListener("click", () => this.actions.edit(pageId, c.id));
		const del = tools.createEl("button", { cls: "nb-cm-icon-btn is-danger", attr: { type: "button", "aria-label": t(root ? "comments.delete" : "comments.deleteReply"), title: t(root ? "comments.delete" : "comments.deleteReply"), "data-key": `comment-delete:${c.id}` } });
		setIcon(del, "trash-2");
		del.addEventListener("click", () => this.actions.remove(pageId, c.id));
	}

	/**
	 * Puts the card beside `anchor` (the marker, in window coordinates) inside `bounds` (the view's body): to the left of the
	 * marker, level with it, kept inside the body. On a phone the card is docked by the style sheet and this does nothing.
	 */
	place(anchor: DOMRect | null, bounds: DOMRect): void {
		if (!this.shown) return;
		this.el.toggleClass("is-docked", this.narrow());
		if (this.narrow()) return;
		const width = Math.min(CARD_W, bounds.width - 16);
		const height = this.el.offsetHeight || 240;
		let left = anchor ? anchor.left - bounds.left - width - GAP : (bounds.width - width) / 2;
		if (left < 8) left = anchor ? anchor.right - bounds.left + GAP : 8;
		let top = anchor ? anchor.top - bounds.top - 8 : 60;
		left = Math.max(8, Math.min(bounds.width - width - 8, left));
		top = Math.max(8, Math.min(bounds.height - height - 8, top));
		if (left === this.left && top === this.top && this.el.hasClass("is-placed")) return;
		this.left = left;
		this.top = top;
		this.el.addClass("is-placed");
		this.el.setCssProps({ "--nb-cm-card-x": `${left}px`, "--nb-cm-card-y": `${top}px`, "--nb-cm-card-w": `${width}px` });
	}

	focusReply(): void {
		if (!this.input.disabled) this.input.focus();
	}

	destroy(): void {
		this.el.remove();
	}
}

function setResolveLabel(b: HTMLButtonElement, resolved: boolean): void {
	const label = t(resolved ? "comments.reopen" : "comments.resolve");
	if (b.getAttribute("aria-label") === label) return;
	b.empty();
	b.setAttribute("aria-label", label);
	setIcon(b.createSpan({ cls: "nb-cm-resolve-icon", attr: { "aria-hidden": "true" } }), resolved ? "rotate-ccw" : "circle-check");
	b.createSpan({ cls: "nb-cm-resolve-label", text: label });
}
