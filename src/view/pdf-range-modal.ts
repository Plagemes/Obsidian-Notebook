import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { parsePageRange } from "./view-helpers";

/**
 * Asks which pages of a PDF to insert: all of them or "from–to". Resolves null when cancelled.
 * A one-page PDF needs no question: the caller should not open this modal for it.
 */
export function askPdfRange(app: App, count: number): Promise<{ from: number; to: number } | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const finish = (value: { from: number; to: number } | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let all = true;
		let from = "1";
		let to = String(count);
		modal.setTitle(t("pdfRange.title"));
		let fromInput: HTMLInputElement | null = null;
		let toInput: HTMLInputElement | null = null;
		const errorEl = modal.contentEl.createDiv({ cls: "notebook-modal-error notebook-hidden" });

		new Setting(modal.contentEl).setName(t("pdfRange.all", { n: String(count) })).addToggle((tg) => tg.setValue(true).onChange((v) => {
			all = v;
			if (fromInput) fromInput.disabled = v;
			if (toInput) toInput.disabled = v;
		}));
		new Setting(modal.contentEl)
			.setName(t("pdfRange.from"))
			.addText((tx) => {
				fromInput = tx.inputEl;
				tx.inputEl.type = "number";
				tx.inputEl.min = "1";
				tx.inputEl.max = String(count);
				tx.inputEl.disabled = true;
				tx.setValue(from).onChange((v) => (from = v));
			});
		new Setting(modal.contentEl)
			.setName(t("pdfRange.to"))
			.addText((tx) => {
				toInput = tx.inputEl;
				tx.inputEl.type = "number";
				tx.inputEl.min = "1";
				tx.inputEl.max = String(count);
				tx.inputEl.disabled = true;
				tx.setValue(to).onChange((v) => (to = v));
			});

		const submit = () => {
			const range = all ? { from: 1, to: count } : parsePageRange(from, to, count);
			if (!range) {
				errorEl.setText(t("pdfRange.invalid", { n: String(count) }));
				errorEl.removeClass("notebook-hidden");
				return;
			}
			finish(range);
			modal.close();
		};
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText(t("pdfRange.cancel")).onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(t("pdfRange.insert")).setCta().onClick(submit));
		modal.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		modal.onClose = () => {
			finish(null);
			modal.contentEl.empty();
		};
		modal.open();
	});
}
