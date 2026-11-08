import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { elementDetail } from "../model/groups";
import type { PageElement } from "../model/types";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";

/** One locked element as the list shows it. */
export interface LockedEntry {
	id: string;
	element: PageElement;
}

/** What the "Locked elements" list needs from the view: the locked elements of the page now, and the two things it can do with them. */
export interface LockedListHost {
	/** The locked elements of the page, in page order (asked again after every change). */
	entries(): LockedEntry[];
	/** Unlocks these elements as one undo step; false when it could not be done (a locked page, read-only). */
	unlock(ids: readonly string[]): boolean;
	/** Scrolls to the element. */
	reveal(id: string): void;
}

const ICONS: Readonly<Record<PageElement["type"], string>> = {
	text: "type", image: "image", marker: "flag", box: "square", equation: "sigma", graph: "chart-spline", excerpt: "crop", sticky: "sticky-note", checkbox: "square-check", area: "highlighter",
};

/**
 * The page's locked elements (0.20, #39), reached from the page menu: what each one is, a way to see where it is and to unlock it,
 * and "Unlock all". Built on the shared modal shell. It lists what is locked now and redraws after each change, so it never offers
 * an element that has been unlocked, erased or undone in the meantime.
 */
export class LockedElementsModal extends Modal {
	constructor(app: App, private readonly pageNumber: number, private readonly host: LockedListHost) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const entries = this.host.entries();
		const shell = modalShell(this, { title: t("groups.list.title"), subtitle: t("groups.list.page", { n: String(this.pageNumber) }), icon: "lock", size: "narrow", cls: "nb-grp-modal" });
		shellNote(shell.body, t(entries.length > 0 ? "groups.list.desc" : "groups.list.empty"));
		const list = shell.body.createDiv({ cls: "nb-grp-list", attr: { role: "list" } });
		for (const entry of entries) {
			const row = list.createDiv({ cls: "nb-grp-row", attr: { role: "listitem" } });
			setIcon(row.createSpan({ cls: "nb-grp-row-icon", attr: { "aria-hidden": "true" } }), ICONS[entry.element.type]);
			const show = row.createEl("button", { cls: "nb-grp-row-text", attr: { type: "button", title: t("groups.list.show") } });
			show.createSpan({ cls: "nb-grp-row-label", text: t(`groups.kind.${entry.element.type}`) });
			const detail = elementDetail(entry.element);
			if (detail !== "") show.createSpan({ cls: "nb-grp-row-detail", text: detail });
			show.addEventListener("click", () => {
				this.host.reveal(entry.id);
				this.close();
			});
			const unlock = row.createEl("button", { cls: "nb-grp-row-unlock", attr: { type: "button", "data-key": "groups-unlock", "aria-label": `${t("groups.unlock")}: ${t(`groups.kind.${entry.element.type}`)}` } });
			setIcon(unlock.createSpan({ cls: "nb-grp-row-unlock-icon", attr: { "aria-hidden": "true" } }), "lock-open");
			unlock.createSpan({ text: t("groups.unlock") });
			unlock.addEventListener("click", () => {
				if (this.host.unlock([entry.id])) this.render();
			});
		}
		shellButton(shell.foot, "secondary", t("groups.list.close"), () => this.close());
		if (entries.length > 1) {
			shellButton(shell.foot, "primary", t("groups.unlockAll"), () => {
				if (this.host.unlock(entries.map((e) => e.id))) this.render();
			}, { icon: "lock-open" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
