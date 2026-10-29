import { Notice } from "obsidian";
import { t } from "../i18n";
import { attachedInk } from "../ink/attach";
import { measureText } from "../ink/renderer";
import type { Page, PageElement, Stroke } from "../model/types";

/**
 * View side of "ink attached to objects" (roadmap 149). The geometry is in ink/attach.ts; this keeps the answer
 * for the current selection (so a drag does not scan the page on every pointer move) and shows the offer to
 * delete the ink of a deleted object.
 */

interface Memo {
	page: Page;
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	strokeCount: number;
	elementCount: number;
	result: Stroke[];
}

export class ObjectInk {
	private memo: Memo | null = null;
	private offer: Notice | null = null;

	/**
	 * Strokes of `page` that move with the selected elements without being selected themselves. Cached while the
	 * selection and the page are unchanged.
	 */
	attachedTo(page: Page, selection: { strokes: readonly Stroke[]; elements: readonly PageElement[] }): Stroke[] {
		if (selection.elements.length === 0) return [];
		const m = this.memo;
		const elementCount = page.elements?.length ?? 0;
		if (m && m.page === page && m.strokes === selection.strokes && m.elements === selection.elements
			&& m.strokeCount === page.strokes.length && m.elementCount === elementCount) return m.result;
		const result = attachedInk(page.strokes, page.elements ?? [], selection.elements, new Set(selection.strokes), measureText);
		this.memo = { page, strokes: selection.strokes, elements: selection.elements, strokeCount: page.strokes.length, elementCount, result };
		return result;
	}

	forget(): void {
		this.memo = null;
	}

	/** A notice with a button that runs `onDelete`; the button and the notice go away after one use. Replaces an earlier offer. */
	offerDelete(count: number, onDelete: () => void): void {
		this.dismissOffer();
		const message = count === 1 ? t("object.inkOnDeleted.one") : t("object.inkOnDeleted.many", { count: String(count) });
		const fragment = createFragment((f) => {
			f.createDiv({ text: message });
			const button = f.createEl("button", { text: t("object.deleteInk"), cls: "mod-cta", attr: { type: "button" } });
			button.addEventListener("click", (e) => {
				e.preventDefault();
				this.dismissOffer();
				onDelete();
			});
		});
		this.offer = new Notice(fragment, 10000);
	}

	dismissOffer(): void {
		this.offer?.hide();
		this.offer = null;
	}

	destroy(): void {
		this.dismissOffer();
		this.memo = null;
	}
}
