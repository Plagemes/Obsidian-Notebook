import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { clipAge, type SharedClipItem } from "../ink/shared-clip";

/** "12 strokes · 2 pictures · 1 text box". */
export function clipSummary(item: SharedClipItem): string {
	const e = item.entry;
	const parts: string[] = [];
	if (e.strokes > 0) parts.push(t("clipshare.strokes", { n: String(e.strokes) }));
	if (e.images > 0) parts.push(t("clipshare.images", { n: String(e.images) }));
	if (e.texts > 0) parts.push(t("clipshare.texts", { n: String(e.texts) }));
	return parts.join(" · ");
}

export function clipAgeText(now: number, at: number): string {
	const age = clipAge(now, at);
	return age.unit === "now" ? t("clipshare.ago.now") : t(`clipshare.ago.${age.unit}`, { n: String(age.n) });
}

/**
 * wave 0.10 (362): the clipboards the other devices copied, newest first. Choosing one pastes it; nothing is written to
 * any clipboard file here.
 */
export class SharedClipModal extends Modal {
	constructor(
		app: App,
		private readonly items: readonly SharedClipItem[],
		private readonly unreadable: number,
		private readonly onPick: (item: SharedClipItem) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("clipshare.pasteTitle"));
		this.contentEl.createEl("p", { text: t("clipshare.pasteHint"), cls: "notebook-clipshare-hint" });
		const list = this.contentEl.createDiv({ cls: "notebook-clipshare-list", attr: { role: "list" } });
		const now = Date.now();
		for (const item of this.items) {
			const row = list.createEl("button", { cls: "notebook-clipshare-row", attr: { type: "button", role: "listitem" } });
			row.createSpan({ cls: "notebook-clipshare-what", text: clipSummary(item) });
			row.createSpan({ cls: "notebook-clipshare-meta", text: `${clipAgeText(now, item.entry.at)} · ${t("clipshare.device", { id: item.device })}` });
			row.addEventListener("click", () => {
				this.close();
				this.onPick(item);
			});
		}
		if (this.unreadable > 0) {
			this.contentEl.createEl("p", { text: t("clipshare.unreadable", { n: String(this.unreadable) }), cls: "notebook-clipshare-hint" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
