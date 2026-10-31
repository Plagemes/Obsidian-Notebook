import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { clipAge, type SharedClipItem } from "../ink/shared-clip";
import { modalShell, shellNote, shellRow } from "../ui/components/modal-shell";

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
		const shell = modalShell(this, { title: t("clipshare.pasteTitle"), subtitle: t("clipshare.pasteHint"), icon: "clipboard-paste", size: "narrow", footer: false, cls: "notebook-clipshare-modal" });
		const list = shell.body.createDiv({ cls: "nb-modal-list notebook-clipshare-list", attr: { role: "list" } });
		const now = Date.now();
		for (const item of this.items) {
			shellRow(list, {
				label: clipSummary(item), detail: `${clipAgeText(now, item.entry.at)} · ${t("clipshare.device", { id: item.device })}`, cls: "notebook-clipshare-row",
				onClick: () => {
					this.close();
					this.onPick(item);
				},
			}).setAttribute("role", "listitem");
		}
		if (this.unreadable > 0) shellNote(shell.body, t("clipshare.unreadable", { n: String(this.unreadable) })).addClass("notebook-clipshare-hint");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
