import { t } from "../i18n";
import { LibraryView, type LibraryHost } from "./library-view";
import type { WorkspaceLeaf } from "obsidian";

export const HOME_VIEW_TYPE = "notebook-home";

/**
 * 0.12: the Notebook home (DESIGN.md §4, docs/design/reference/home.png). The same view as the library, opened on its
 * Home surface: the rail switches between Home and the library in place, with one index and one thumbnail queue.
 */
export class HomeView extends LibraryView {
	constructor(leaf: WorkspaceLeaf, host: LibraryHost) {
		super(leaf, host, "home");
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("home.tab");
	}

	getIcon(): string {
		return "home";
	}
}
