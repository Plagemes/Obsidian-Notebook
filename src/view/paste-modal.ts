import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { systemClipFromEvent, type SystemClip } from "./clipboard";

/**
 * Paste box for WebViews that do not let a page read the clipboard (Android): the user presses and holds in the box,
 * chooses the system's Paste, and the paste event delivers the picture or the text.
 */
export class PasteModal extends Modal {
	private done = false;

	constructor(app: App, private readonly onClip: (clip: SystemClip) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("selection.pasteTitle"));
		this.contentEl.createEl("p", { text: t("selection.pasteHint"), cls: "notebook-paste-hint" });
		const box = this.contentEl.createDiv({
			cls: "notebook-paste-box",
			text: t("selection.pasteBox"),
			attr: { contenteditable: "true", role: "textbox", "aria-label": t("selection.pasteBox") },
		});
		box.addEventListener("paste", (e) => {
			e.preventDefault();
			void systemClipFromEvent(e).then((clip) => {
				if (this.done) return;
				this.done = true;
				this.close();
				this.onClip(clip);
			}, () => undefined);
		});
		// Typing into the box is not a paste: keep it empty.
		box.addEventListener("beforeinput", (e) => {
			if (e.inputType !== "insertFromPaste") e.preventDefault();
		});
		window.setTimeout(() => box.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
