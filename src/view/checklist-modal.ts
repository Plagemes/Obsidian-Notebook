import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { CHECKBOX_LABEL_MAX, cleanCheckboxLabel } from "../model/checklist";
import { isSubmitKey } from "../model/selection-task";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";

/**
 * The small dialog that names a checkbox (0.19, #103): one line of typed text shown in lists and used when the item is sent to the
 * tasks. Built on the shared modal shell. Nothing changes until Save; Cancel (or closing) leaves the checkbox as it is. An empty
 * label is allowed (it removes the typed label; the handwriting beside the box stays the item's label).
 */
export class ChecklistLabelModal extends Modal {
	private value: string;
	private saved = false;

	constructor(app: App, start: string, private readonly onSave: (label: string) => void) {
		super(app);
		this.value = start;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("checklist.label.title"), icon: "square-check", size: "narrow", cls: "nb-chk-label-modal" });
		shellNote(shell.body, t("checklist.label.desc"));
		const field = shellField(shell.body, t("checklist.label.field"), "nb-chk-label");
		const input = field.createEl("input", {
			cls: "nb-modal-input",
			attr: { id: "nb-chk-label", type: "text", maxlength: String(CHECKBOX_LABEL_MAX), autocomplete: "off", placeholder: t("checklist.label.placeholder"), "data-key": "checklist-label" },
		});
		input.value = this.value;
		const save = () => {
			this.value = input.value;
			this.saved = true;
			this.close();
		};
		input.addEventListener("input", () => (this.value = input.value));
		// The Enter that confirms an IME composition is not "save".
		input.addEventListener("keydown", (e) => {
			if (isSubmitKey(e)) save();
		});
		shellButton(shell.foot, "secondary", t("checklist.label.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("checklist.label.save"), save, { icon: "check" });
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.saved) this.onSave(cleanCheckboxLabel(this.value));
	}
}
