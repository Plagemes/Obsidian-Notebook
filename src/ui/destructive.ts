import { Modal, type App, type ButtonComponent } from "obsidian";
import { t } from "../i18n";
import { modalShell, shellButton } from "./components/modal-shell";

/**
 * Styles `b` as a destructive button (delete, remove). Obsidian 1.13 added `setDestructive()` and deprecated
 * `setWarning()`. Older versions (minAppVersion is 1.8.7) have no `setDestructive()`: there the button gets the
 * `mod-warning` class, which is what `setWarning()` adds and what the plugin's other warning buttons already use.
 */
export function setDestructive(b: ButtonComponent): ButtonComponent {
	const modern = (b as { setDestructive?: () => ButtonComponent }).setDestructive;
	if (typeof modern === "function") return modern.call(b);
	b.buttonEl.addClass("mod-warning");
	return b;
}

export interface ConfirmDestructiveOptions {
	title: string;
	body: string;
	/** The label of the destructive button ("Delete"). */
	confirm: string;
	/** The label of the other button; default "Cancel". */
	cancel?: string;
}

/**
 * The design-system confirmation for a destructive action (wave 0.13): a dialog on the modal shell with a warning icon, the
 * question, a secondary Cancel and a danger button. Nothing happens until the danger button is pressed; Escape and ×
 * cancel. Returns the modal (already open).
 */
class ConfirmDestructiveModal extends Modal {
	constructor(app: App, private readonly opts: ConfirmDestructiveOptions, private readonly onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: this.opts.title, icon: "triangle-alert", color: "#F0565E", size: "narrow", cls: "nb-confirm" });
		shell.body.createEl("p", { cls: "nb-modal-text", text: this.opts.body });
		shellButton(shell.foot, "secondary", this.opts.cancel ?? t("ui.modal.cancel"), () => this.close());
		shellButton(shell.foot, "danger", this.opts.confirm, () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Opens the confirmation for a destructive action and runs `onConfirm` only when the danger button is pressed. */
export function confirmDestructive(app: App, opts: ConfirmDestructiveOptions, onConfirm: () => void): void {
	new ConfirmDestructiveModal(app, opts, onConfirm).open();
}
