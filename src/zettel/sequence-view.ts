// The card sequence (roadmap Z7): a small dialog on the modal shell that shows where a card sits in the Luhmann numbering
// (parent, previous, next, children), each with a row that opens that card, and, from a notebook, buttons to make a follow-up
// or a branch card. Reading changes nothing; the buttons start the same card dialog and writer as every other card.
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { modalShell, shellButton, shellNote, shellRow, shellSection } from "../ui/components/modal-shell";
import type { CardRecord } from "./card-content";
import type { SequenceKind } from "./sequence";

/** A card and the cards around it in the numbering (null / empty: none). */
export interface SequenceInfo {
	card: CardRecord;
	parent: CardRecord | null;
	previous: CardRecord | null;
	next: CardRecord | null;
	children: CardRecord[];
}

export interface SequenceActions {
	/** Opens the note of a card. */
	open: (card: CardRecord) => void;
	/** Starts a follow-up or branch card of this card; absent when the dialog was opened outside a notebook. */
	create?: (kind: SequenceKind) => void;
}

/** Rows drawn for the children: a card with hundreds of branches never builds hundreds of rows. */
export const MAX_CHILD_ROWS = 60;

export class SequenceModal extends Modal {
	constructor(app: App, private readonly info: SequenceInfo, private readonly actions: SequenceActions) {
		super(app);
	}

	onOpen(): void {
		const { card } = this.info;
		const shell = modalShell(this, {
			title: t("sequence.title"), subtitle: t("sequence.subtitle", { id: card.id, title: card.title || card.id }), icon: "split", size: "medium", cls: "nb-sequence-modal",
		});
		const { body, foot } = shell;
		const one = (title: string, target: CardRecord | null) => {
			const list = shellSection(body, title, "nb-seq-section");
			if (target) this.row(list, target);
			else shellNote(list, t("sequence.none"));
		};
		one(t("sequence.parent"), this.info.parent);
		one(t("sequence.previous"), this.info.previous);
		one(t("sequence.next"), this.info.next);
		const children = shellSection(body, `${t("sequence.children")} (${this.info.children.length})`, "nb-seq-section");
		if (this.info.children.length === 0) shellNote(children, t("sequence.none"));
		for (const child of this.info.children.slice(0, MAX_CHILD_ROWS)) this.row(children, child);
		if (this.info.children.length > MAX_CHILD_ROWS) shellNote(children, t("sequence.more", { n: String(this.info.children.length - MAX_CHILD_ROWS) }));

		const { create } = this.actions;
		if (create) {
			const followUp = shellButton(foot, "secondary", t("sequence.newFollowUp"), () => {
				this.close();
				create("follow-up");
			}, { icon: "arrow-right" });
			followUp.title = t("sequence.help.followUp");
			const branch = shellButton(foot, "secondary", t("sequence.newBranch"), () => {
				this.close();
				create("branch");
			}, { icon: "split" });
			branch.title = t("sequence.help.branch");
		}
		shellButton(foot, "primary", t("sequence.close"), () => this.close());
	}

	private row(list: HTMLElement, target: CardRecord): void {
		const row = shellRow(list, {
			label: `${target.id}  ${target.title || ""}`.trim(), detail: target.path, cls: "nb-seq-row",
			onClick: () => {
				this.close();
				this.actions.open(target);
			},
		});
		row.title = t("sequence.help.open");
		row.setAttribute("aria-label", `${t("sequence.open")}: ${target.id} ${target.title}`.trim());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
