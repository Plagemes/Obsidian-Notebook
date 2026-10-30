import { artImage, folderIconSvg } from "../art/generative-art";
import { pressable, setIconSafe, subjectVars, svgDataUrl } from "./dom";

export interface SubjectCardOptions {
	name: string;
	/** Subject base colour `#rrggbb`. */
	color: string;
	/** Seed of the artwork (the folder path). */
	seed: string;
	/** Meta lines under the title ("12 quaderni", "248 pagine"). */
	lines: readonly string[];
	/** "row": icon left, text, chevron (Home, 2 per row). "tile": icon on top (library, 4 per row). */
	shape: "row" | "tile";
	/** Draw the procedural artwork (off with reduced effects). */
	art: boolean;
	key?: string;
	onOpen: () => void;
}

/** Art bitmaps are cached by size, so every card asks for the same few sizes. */
const ART_SIZE = { row: [320, 128], tile: [280, 176] } as const;

/** Subject card (DESIGN.md §3): gradient in the subject colour, glossy folder icon, title, meta, artwork, chevron. */
export function subjectCard(parent: HTMLElement, o: SubjectCardOptions): HTMLElement {
	const card = parent.createDiv({ cls: `nb-subject-card is-${o.shape}` });
	subjectVars(card, o.color);
	if (o.key) card.dataset.key = o.key;
	pressable(card, o.onOpen, [o.name, ...o.lines].join(", "));
	if (o.art) {
		const [w, h] = ART_SIZE[o.shape];
		const url = artImage({ seed: o.seed, color: o.color }, w, h, Math.min(2, activeWindow.devicePixelRatio || 1));
		if (url) card.createDiv({ cls: "nb-subject-art", attr: { "aria-hidden": "true" } }).setCssProps({ "--nb-art": `url("${url}")` });
	}
	card.createEl("img", { cls: "nb-folder-icon", attr: { src: svgDataUrl(folderIconSvg(o.color, 64)), alt: "", draggable: "false" } });
	const text = card.createDiv({ cls: "nb-subject-text" });
	text.createDiv({ cls: "nb-subject-title", text: o.name, attr: { title: o.name } });
	for (const line of o.lines) text.createDiv({ cls: "nb-subject-meta", text: line });
	setIconSafe(card.createSpan({ cls: "nb-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
	return card;
}
