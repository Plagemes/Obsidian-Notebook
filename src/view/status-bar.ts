import { t } from "../i18n";
import { statusBarText, type StatusBarInfo } from "./status-bar-logic";

/**
 * Obsidian's status bar item for the active notebook (desktop only: Obsidian mobile has no status bar, so the plugin
 * does not create the item there and the toolbar keeps showing the same two facts). Shown only while a notebook is
 * the active view; a click or Enter/Space opens the page panel (the navigator).
 */
export class NotebookStatusBar {
	private dot: HTMLElement;
	private text: HTMLElement;

	constructor(readonly el: HTMLElement, private readonly open: () => void) {
		el.addClass("notebook-statusbar", "notebook-hidden");
		el.setAttribute("role", "button");
		el.setAttribute("tabindex", "0");
		this.dot = el.createSpan({ cls: "notebook-statusbar-dot" });
		this.text = el.createSpan({ cls: "notebook-statusbar-text" });
		el.addEventListener("click", () => this.open());
		el.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			this.open();
		});
	}

	/** Shows the info, or hides the item for null (no notebook is active). */
	update(info: StatusBarInfo | null): void {
		this.el.toggleClass("notebook-hidden", info === null);
		if (!info) return;
		const text = statusBarText(t("statusbar.page", { n: String(info.page), total: String(info.total) }), info.save);
		if (this.text.getText() !== text) this.text.setText(text);
		this.dot.dataset.kind = info.kind;
		this.el.setAttribute("aria-label", t("statusbar.label", { n: String(info.page), total: String(info.total), state: info.save }));
	}
}
