import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { cleanCommentText } from "../model/comments-format";
import { COMMENT_TEXT_MAX, type CommentSketch } from "../model/types";
import { modalShell, shellButton, shellField } from "../ui/components/modal-shell";
import { SketchPad } from "./comments-sketch";

/** What the editor hands back. `sketch` is absent when there is none. */
export interface CommentDraft {
	text: string;
	sketch?: CommentSketch | undefined;
}

export interface CommentModalOptions {
	/** "comment": typed text and a sketch; "reply": typed text only. */
	kind: "comment" | "reply";
	/** An existing comment being edited (the dialog says so, and its Done button reads "Save"). */
	editing: boolean;
	text: string;
	sketch?: CommentSketch | undefined;
	/** Page number, for the subtitle. */
	page: number;
}

/**
 * The editor of a comment (0.18, #86): the typed text and, for a comment, a small handwritten sketch (finger, mouse or pen).
 * Built on the shared modal shell. Nothing is changed until Done; Cancel (or closing) leaves the comment as it is. A comment
 * must hold something: Done stays off while there is neither text nor sketch.
 */
export class CommentModal extends Modal {
	private done = false;
	private area!: HTMLTextAreaElement;
	private pad: SketchPad | null = null;
	private submit!: HTMLButtonElement;

	constructor(app: App, private readonly opts: CommentModalOptions, private readonly onDone: (draft: CommentDraft) => void) {
		super(app);
	}

	onOpen(): void {
		const o = this.opts;
		const title = o.kind === "reply" ? t(o.editing ? "comments.editReply" : "comments.newReply") : t(o.editing ? "comments.editComment" : "comments.newComment");
		const shell = modalShell(this, { title, subtitle: t("comments.editorSubtitle", { page: String(o.page) }), icon: "message-square", size: "medium", cls: "nb-cm-editor" });
		const field = shellField(shell.body, t("comments.text"), "nb-cm-text");
		this.area = field.createEl("textarea", {
			cls: "nb-modal-input nb-cm-text",
			attr: { id: "nb-cm-text", rows: o.kind === "reply" ? "4" : "5", maxlength: String(COMMENT_TEXT_MAX), placeholder: t("comments.textPlaceholder"), "data-key": "comment-text" },
		});
		this.area.value = o.text;
		this.area.addEventListener("input", () => this.sync());
		if (o.kind === "comment") {
			const sketch = shellField(shell.body, t("comments.sketch"));
			const wrap = sketch.createDiv({ cls: "nb-cm-pad-wrap" });
			this.pad = new SketchPad(wrap, o.sketch, t("comments.sketch.aria"), () => this.sync());
			const row = sketch.createDiv({ cls: "nb-cm-pad-tools" });
			const undo = row.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": t("comments.sketch.undo"), title: t("comments.sketch.undo"), "data-key": "comment-sketch-undo" } });
			setIcon(undo, "undo-2");
			undo.addEventListener("click", () => this.pad?.undo());
			const clear = row.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": t("comments.sketch.clear"), title: t("comments.sketch.clear"), "data-key": "comment-sketch-clear" } });
			setIcon(clear, "eraser");
			clear.addEventListener("click", () => this.pad?.clear());
		}
		shellButton(shell.foot, "secondary", t("comments.cancel"), () => this.close());
		this.submit = shellButton(shell.foot, "primary", t(o.editing ? "comments.save" : "comments.add"), () => this.finish(), { icon: "check" });
		this.sync();
		window.setTimeout(() => this.area.focus(), 0);
	}

	/** Done is available only when there is something to keep. */
	private sync(): void {
		this.submit.disabled = cleanCommentText(this.area.value) === "" && (this.pad?.empty ?? true);
	}

	private finish(): void {
		if (this.submit.disabled) return;
		this.done = true;
		this.close();
	}

	onClose(): void {
		const draft: CommentDraft = { text: this.area?.value ?? "", sketch: this.pad?.value };
		this.contentEl.empty();
		if (this.done) this.onDone(draft);
	}
}
