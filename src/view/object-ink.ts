import { t } from "../i18n";
import { attachedInk } from "../ink/attach";
import { inkFollowers, type PagePart } from "../ink/cross-page";
import { measureText } from "../ink/renderer";
import type { Page, PageElement, Stroke } from "../model/types";
import { showNotice, type NoticeHandle } from "./notice";

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

interface AcrossMemo {
	geometric: boolean;
	items: Array<{ page: Page | undefined; strokes: readonly Stroke[]; elements: readonly PageElement[]; strokeCount: number; elementCount: number }>;
	result: Stroke[][];
}

export class ObjectInk {
	private memo: Memo | null = null;
	private acrossMemo: AcrossMemo | null = null;
	private offer: NoticeHandle | null = null;

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

	/**
	 * wave 0.10 (359): for a selection across pages, per part, the strokes that move with its objects without being
	 * selected themselves: the ink bound to a selected graph, and with `geometric` the ink written on the objects
	 * (ink/cross-page.ts `inkFollowers`). Cached while the selection and the pages are unchanged.
	 */
	attachedAcross(parts: ReadonlyArray<{ part: PagePart; page: Page | undefined }>, geometric: boolean): Stroke[][] {
		const items = parts.map(({ part, page }) => ({
			page, strokes: part.strokes, elements: part.elements, strokeCount: page?.strokes.length ?? 0, elementCount: page?.elements?.length ?? 0,
		}));
		const m = this.acrossMemo;
		if (m && m.geometric === geometric && m.items.length === items.length
			&& m.items.every((it, i) => {
				const n = items[i]!;
				return it.page === n.page && it.strokes === n.strokes && it.elements === n.elements && it.strokeCount === n.strokeCount && it.elementCount === n.elementCount;
			})) return m.result;
		const result = parts.map(({ part, page }) => {
			if (!page) return [];
			const own = new Set(part.strokes);
			return inkFollowers(page, part, geometric, measureText).map((f) => f.stroke).filter((s) => !own.has(s));
		});
		this.acrossMemo = { geometric, items, result };
		return result;
	}

	forget(): void {
		this.memo = null;
		this.acrossMemo = null;
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
		this.offer = showNotice(fragment, 10000);
	}

	dismissOffer(): void {
		this.offer?.hide();
		this.offer = null;
	}

	destroy(): void {
		this.dismissOffer();
		this.memo = null;
		this.acrossMemo = null;
	}
}
