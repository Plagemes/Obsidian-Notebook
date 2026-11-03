import type { App } from "obsidian";
import { t } from "../i18n";
import { parseSmartAddHistory, pushSmartAdd, rankSmartAdd, type SmartAddChoice, type SmartAddHistoryEntry, type SmartAddInput } from "../model/smart-add";
import type { PaperKind } from "../model/types";
import { chip } from "../ui/components/chip";

/** How long the strip stays when nobody answers, ms. */
const STRIP_MS = 10000;
/** Events that must not reach the page or the view's shortcuts. */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;
const STORAGE_PREFIX = "notebook-smart-add:";

export interface SmartAddHost {
	readonly app: App;
	/** The element the strip floats in (the notebook body, over the page area). */
	parent(): HTMLElement;
	/** Id of the open notebook, or null when none is editable (nothing is offered). */
	notebookId(): string | null;
	/** What the ranker needs about the page in view and the context; null when the notebook cannot be edited now. */
	context(): Omit<SmartAddInput, "history"> | null;
	/** Makes the page of this choice after the page in view (one undo step); false when it could not. */
	add(choice: SmartAddChoice): boolean;
	/** "More…": the full chooser (the page sheet with every way to add a page). */
	more(): void;
}

/** Roadmap 410: the label and icon of each choice (the paper name for the paper choices). */
export function smartAddLabel(choice: SmartAddChoice): { label: string; icon: string } {
	const paper = (p: PaperKind | undefined): string => t(`paper.${p ?? "blank"}`);
	switch (choice.id) {
		case "same": return { label: t("smartAdd.same", { paper: paper(choice.paper) }), icon: "file-plus" };
		case "exercise": return { label: t("smartAdd.exercise"), icon: "pencil-ruler" };
		case "slide": return { label: t("smartAdd.slide"), icon: "presentation" };
		case "recent-paper": return { label: t("smartAdd.paper", { paper: paper(choice.paper) }), icon: "file-text" };
		default: return { label: t("smartAdd.blank"), icon: "file" };
	}
}

/**
 * The Smart "+": tapping "+" shows a small strip with the 2-3 most likely new pages (the ranker is model/smart-add.ts),
 * each one tap, plus "More…" for the full chooser. Nothing is added until a chip is tapped; the strip goes away when the
 * pen goes down, the page changes, after a few seconds or on Escape. What was taken is remembered per notebook on this
 * device (`saveLocalStorage`), never in the notebook file.
 */
export class SmartAddStrip {
	private strip: HTMLElement | null = null;
	private timer: number | null = null;

	constructor(private readonly host: SmartAddHost) {}

	get visible(): boolean {
		return this.strip !== null;
	}

	/** Shows the strip, or hides it when it is already on screen. False when there is nothing to offer (not editable). */
	toggle(): boolean {
		if (this.strip) {
			this.hide();
			return true;
		}
		const ctx = this.host.context();
		const id = this.host.notebookId();
		if (!ctx || !id) return false;
		this.show(rankSmartAdd({ ...ctx, history: this.history(id) }));
		return true;
	}

	hide(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.strip?.remove();
		this.strip = null;
	}

	destroy(): void {
		this.hide();
	}

	private show(choices: SmartAddChoice[]): void {
		const strip = this.host.parent().createDiv({ cls: "nb-ui nb-smart-add", attr: { role: "group", "aria-label": t("smartAdd.aria") } });
		for (const type of ISOLATED) strip.addEventListener(type, (e) => e.stopPropagation());
		strip.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.hide();
		});
		for (const choice of choices) {
			const { label, icon } = smartAddLabel(choice);
			chip(strip, { label, icon, key: `smart-add:${choice.id}`, onClick: () => this.take(choice) });
		}
		chip(strip, {
			label: t("smartAdd.more"), icon: "more-horizontal", key: "smart-add:more",
			onClick: () => {
				this.hide();
				this.host.more();
			},
		});
		this.strip = strip;
		this.timer = window.setTimeout(() => this.hide(), STRIP_MS);
	}

	private take(choice: SmartAddChoice): void {
		this.hide();
		if (!this.host.add(choice)) return;
		const id = this.host.notebookId();
		if (id) this.remember(id, choice);
	}

	private history(id: string): SmartAddHistoryEntry[] {
		try {
			return parseSmartAddHistory(this.host.app.loadLocalStorage(STORAGE_PREFIX + id));
		} catch {
			return [];
		}
	}

	private remember(id: string, choice: SmartAddChoice): void {
		try {
			const entry: SmartAddHistoryEntry = choice.paper ? { id: choice.id, paper: choice.paper } : { id: choice.id };
			this.host.app.saveLocalStorage(STORAGE_PREFIX + id, pushSmartAdd(this.history(id), entry));
		} catch {
			// The history is a convenience; losing it changes the ranking, nothing else.
		}
	}
}
