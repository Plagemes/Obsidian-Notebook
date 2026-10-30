import { SuggestModal, type App } from "obsidian";
import { t } from "../i18n";
import { gotoTargets, type GotoBookmark, type GotoTarget } from "./goto-logic";

/** What "Go to page number" needs from the notebook view. */
export interface GotoView {
	gotoContext(): { total: number; current: number; bookmarks: GotoBookmark[] };
	/** Scrolls to the page (0-based). */
	jumpToPage(index: number): void;
}

/** Roadmap 366: type 12, p12 or the start of a bookmark title. */
export class GotoPageModal extends SuggestModal<GotoTarget> {
	private readonly ctx: ReturnType<GotoView["gotoContext"]>;

	constructor(app: App, private readonly view: GotoView) {
		super(app);
		this.ctx = view.gotoContext();
		this.setPlaceholder(t("goto.placeholder", { total: String(this.ctx.total) }));
		this.emptyStateText = t("goto.empty");
	}

	getSuggestions(query: string): GotoTarget[] {
		return gotoTargets(query, this.ctx.total, this.ctx.bookmarks);
	}

	renderSuggestion(target: GotoTarget, el: HTMLElement): void {
		el.addClass("notebook-goto-row");
		if (target.kind === "page") {
			el.createSpan({ text: t("goto.page", { n: target.label, total: String(this.ctx.total) }) });
		} else {
			el.createSpan({ cls: "notebook-goto-title", text: target.label });
			el.createSpan({ cls: "notebook-goto-num", text: t("quicknav.page", { n: String(target.index + 1) }) });
		}
	}

	onChooseSuggestion(target: GotoTarget): void {
		this.view.jumpToPage(target.index);
	}
}

