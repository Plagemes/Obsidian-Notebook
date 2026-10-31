// The subject card (DESIGN.md §3): ONE component for every surface that shows a folder as a subject — the library
// grid, Home and the creation dialog's folder preview — so the preview is exactly the card the folder will get.
import { artImage, folderIconSvg, type ArtStyle } from "../art/generative-art";
import { decorate, pressable, setIconSafe, subjectVars, svgDataUrl } from "./dom";

export interface SubjectCardOptions {
	name: string;
	/** Subject base colour `#rrggbb` (folder metadata, else `colorFor(name)`). */
	color: string;
	/** Seed of the artwork (the folder path). */
	seed: string;
	/** Art family (folder metadata); absent: `artStyleFor(seed)`, as the engine picks it. */
	artStyle?: ArtStyle;
	/** Lucide symbol drawn on the folder icon (folder metadata); absent or "folder": the plain folder. */
	icon?: string;
	/** Meta lines under the title ("12 quaderni", "248 pagine", or the folder's description). */
	lines: readonly string[];
	/** "row": icon left, text, chevron (Home, 2 per row). "tile": icon on top (library, 4 per row). */
	shape: "row" | "tile";
	/** Draw the procedural artwork (off with reduced effects). */
	art: boolean;
	/** 0.13: the lower card of Home's three-column grid (a row card about 92 px tall with a smaller folder). */
	compact?: boolean;
	key?: string;
	/** Opens the subject. Absent: a picture only (the creation dialog's preview): no button role, no chevron. */
	onOpen?: () => void;
}

/** Art bitmaps are cached by size, so every card asks for the same few sizes. */
const ART_SIZE = { row: [320, 128], tile: [280, 176] } as const;

/**
 * Subject card (DESIGN.md §3): gradient in the subject colour, glossy folder icon, title, meta, artwork, chevron. The
 * artwork is laid out beside the icon and text (styles.css, "subject cards"), never under them, at every width.
 */
export function subjectCard(parent: HTMLElement, o: SubjectCardOptions): HTMLElement {
	const card = parent.createDiv({ cls: `nb-subject-card is-${o.shape}${o.compact ? " is-compact" : ""}` });
	subjectVars(card, o.color);
	if (o.key) card.dataset.key = o.key;
	const label = [o.name, ...o.lines].join(", ");
	if (o.onOpen) pressable(card, o.onOpen, label);
	else card.setAttrs({ role: "img", "aria-label": label });
	// 0.12.3: the art and the folder picture are decoration: if they cannot be made the card is drawn without them.
	if (o.art) {
		const [w, h] = ART_SIZE[o.shape];
		const url = decorate("", () => {
			const surface = activeDocument.body.hasClass("theme-light") ? "light" : "dark";
			return artImage({ seed: o.seed, color: o.color, style: o.artStyle, surface }, w, h, Math.min(2, activeWindow.devicePixelRatio || 1));
		});
		if (url) card.createDiv({ cls: "nb-subject-art", attr: { "aria-hidden": "true" } }).setCssProps({ "--nb-art": `url("${url}")` });
	}
	// The folder SVG is shown as an image (never parsed into the page); the symbol sits on the folder's front.
	const glyph = o.icon && o.icon !== "folder" ? o.icon : null;
	const iconHost = glyph ? card.createDiv({ cls: "nb-folder-badge", attr: { "aria-hidden": "true" } }) : card;
	const folder = decorate("", () => svgDataUrl(folderIconSvg(o.color, 64)));
	if (folder) iconHost.createEl("img", { cls: "nb-folder-icon", attr: { src: folder, alt: "", draggable: "false" } });
	else setIconSafe(iconHost.createSpan({ cls: "nb-folder-icon nb-folder-icon-plain" }), "folder");
	if (glyph) setIconSafe(iconHost.createSpan({ cls: "nb-folder-glyph" }), glyph);
	const text = card.createDiv({ cls: "nb-subject-text" });
	text.createDiv({ cls: "nb-subject-title", text: o.name, attr: { title: o.name } });
	for (const line of o.lines) text.createDiv({ cls: "nb-subject-meta", text: line });
	if (o.onOpen) setIconSafe(card.createSpan({ cls: "nb-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
	return card;
}
