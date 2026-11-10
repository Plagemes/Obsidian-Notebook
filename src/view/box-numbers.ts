// 0.28 (#205) The numbers of the structured boxes of the open notebook, worked out from the document and cached: nothing is stored.
// One instance per notebook view. `label` is the BoxLabel the renderer and every export of that view use. The cache key is
// cheap (box positions, page stroke counts, the edit tick, the settings), so the label can be asked for on every redraw.
import type { BoxLabel } from "../ink/marker-render";
import { BOX_NAMES } from "../ink/marker-render";
import type { HeadingIndex } from "../model/heading-index";
import {
	NUMBERED_KINDS, numberBoxes, numberMap, numberedBoxLabel, type BoxAbbreviations, type ChapterMark, type NumberedBox,
} from "../model/box-numbering";
import type { BoxKind, Page } from "../model/types";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { NotebookSettings } from "../settings";

export interface BoxNumbersHost {
	pages(): readonly Page[];
	settings(): Pick<NotebookSettings, "boxNumbering" | "boxNumberChapter" | "boxNumberShared">;
	headingIndex(): HeadingIndex;
	/** Changes with every edit of the document. */
	tick(): number;
	/** The numbers were not ready (headings still being analysed): redraw later. */
	redraw(): void;
}

const KINDS: readonly BoxKind[] = ["definition", "theorem", "example", "proof", "remark"];

export function boxNames(): Record<BoxKind, string> {
	const out = { ...BOX_NAMES };
	for (const k of KINDS) out[k] = t(`markers.box.${k}` as MessageKey);
	return out;
}

export function boxAbbreviations(): BoxAbbreviations {
	const out = { ...BOX_NAMES } as Record<BoxKind, string>;
	for (const k of KINDS) out[k] = t(`markers.box.abbr.${k}` as MessageKey);
	return out;
}

/** Time budget for analysing stale pages for the chapter marks on the render path, ms. */
const WARM_MS = 12;
/** Retry delay when the headings were not all analysed yet, ms. */
const RETRY_MS = 400;

export class BoxNumbers {
	private key = "";
	private list: NumberedBox[] = [];
	private map: ReadonlyMap<string, string> = new Map();
	private retry: number | null = null;

	constructor(private readonly host: BoxNumbersHost) {}

	/** Forgets the cache (another document was loaded). */
	reset(): void {
		this.key = "";
		this.list = [];
		this.map = new Map();
	}

	dispose(): void {
		if (this.retry !== null) window.clearTimeout(this.retry);
		this.retry = null;
	}

	/** Every numbered box of the notebook in reading order (empty when numbering is off). */
	items(): readonly NumberedBox[] {
		this.refresh();
		return this.list;
	}

	/** Like `items` but also when numbering is off: the numbers are still worked out (the index lists the boxes either way). */
	itemsAlways(): NumberedBox[] {
		const s = this.host.settings();
		return numberBoxes(this.host.pages(), s.boxNumberChapter ? this.marks(false) : [], { chapter: s.boxNumberChapter, shared: s.boxNumberShared });
	}

	/** The BoxLabel for renderers and exports. */
	readonly label: BoxLabel = (box) => {
		const names = boxNames();
		if (!this.host.settings().boxNumbering || !NUMBERED_KINDS.includes(box.kind)) return numberedBoxLabel(box, undefined, names, boxAbbreviations());
		this.refresh();
		return numberedBoxLabel(box, this.map.get(box.id), names, boxAbbreviations());
	};

	private refresh(): void {
		const s = this.host.settings();
		if (!s.boxNumbering) {
			if (this.key !== "off") this.reset();
			this.key = "off";
			return;
		}
		const pages = this.host.pages();
		let sig = `${this.host.tick()}|${s.boxNumberChapter ? 1 : 0}${s.boxNumberShared ? 1 : 0}|${pages.length}`;
		let any = false;
		for (const p of pages) {
			sig += `|${p.strokes.length}`;
			for (const e of p.elements ?? []) {
				if (e.type === "box") {
					any = true;
					sig += `,${e.id}:${e.kind}:${e.x}:${e.y}`;
				}
			}
		}
		if (sig === this.key) return;
		this.key = sig;
		if (!any) {
			this.list = [];
			this.map = new Map();
			return;
		}
		const marks = s.boxNumberChapter ? this.marks(true) : [];
		this.list = numberBoxes(pages, marks, { chapter: s.boxNumberChapter, shared: s.boxNumberShared });
		this.map = numberMap(this.list);
	}

	/** Top-level headings as chapter marks. On the render path (`soft`) at most WARM_MS is spent analysing pages; the rest is retried later. */
	private marks(soft: boolean): ChapterMark[] {
		const pages = this.host.pages();
		const index = this.host.headingIndex();
		if (soft && index.warm(pages, WARM_MS) > 0) {
			// Not ready: no chapter prefix for now; the retry forgets the key and redraws, and analyses a few more pages.
			if (this.retry === null) {
				this.retry = window.setTimeout(() => {
					this.retry = null;
					this.key = "";
					this.host.redraw();
				}, RETRY_MS);
			}
			return [];
		}
		const out: ChapterMark[] = [];
		for (const list of index.headings(pages)) for (const h of list.headings) if (h.level === 1) out.push({ pageIndex: list.index, y: h.rect.y });
		return out;
	}
}
