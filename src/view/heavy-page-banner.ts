import { t } from "../i18n";
import type { HeavyReason, PageLoad } from "../ink/heavy-page";

/** What the banner needs of the notebook view. */
export interface HeavyBannerHost {
	/** "Split page" was pressed for this page (0-based). */
	split(pageIndex: number): void;
	/** "Dismiss" was pressed: do not warn about this page again in this view. */
	dismiss(pageIndex: number): void;
}

export interface HeavyBannerInfo {
	pageIndex: number;
	load: PageLoad;
	reasons: readonly HeavyReason[];
	/** The page can be split (editable, no PDF or scan background, at least two items). */
	canSplit: boolean;
}

function megabytes(bytes: number): string {
	return `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
}

/** Text of the reasons, e.g. "3,412 strokes, 131,000 points". */
export function heavyReasonText(info: Pick<HeavyBannerInfo, "load" | "reasons">): string {
	const parts: string[] = [];
	for (const r of info.reasons) {
		if (r === "strokes") parts.push(t("heavy.reason.strokes", { count: info.load.strokes.toLocaleString() }));
		else if (r === "points") parts.push(t("heavy.reason.points", { count: info.load.points.toLocaleString() }));
		else parts.push(t("heavy.reason.assets", { size: megabytes(info.load.assetBytes) }));
	}
	return parts.join(", ");
}

/**
 * Discreet warning at the bottom of the view for a page that is too heavy (roadmap 380), with "Split page"
 * and "Dismiss". It never takes the focus and never covers the toolbar; it is hidden while writing.
 */
export class HeavyPageBanner {
	readonly el: HTMLElement;
	private key = "";
	private visible = false;

	constructor(parent: HTMLElement, private readonly host: HeavyBannerHost) {
		this.el = parent.createDiv({ cls: "notebook-heavy" });
		this.el.setAttribute("role", "status");
		this.el.setAttribute("aria-live", "polite");
		this.el.hide();
	}

	show(info: HeavyBannerInfo): void {
		const key = `${info.pageIndex}:${info.reasons.join()}:${info.canSplit}:${info.load.strokes}:${info.load.points}:${info.load.assetBytes}`;
		if (key === this.key && this.visible) return;
		this.key = key;
		this.el.empty();
		this.el.createSpan({
			cls: "notebook-heavy-text",
			text: t("heavy.message", { n: String(info.pageIndex + 1), why: heavyReasonText(info) }),
		});
		const actions = this.el.createDiv({ cls: "notebook-heavy-actions" });
		if (info.canSplit) {
			actions.createEl("button", { text: t("heavy.split"), cls: "mod-cta" }).addEventListener("click", () => this.host.split(info.pageIndex));
		}
		actions.createEl("button", { text: t("heavy.dismiss") }).addEventListener("click", () => {
			this.hide();
			this.host.dismiss(info.pageIndex);
		});
		this.el.show();
		this.visible = true;
	}

	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.key = "";
		this.el.hide();
	}

	destroy(): void {
		this.el.remove();
	}
}
