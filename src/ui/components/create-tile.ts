import { pressable, setIconSafe } from "./dom";

export interface CreateTileOptions {
	icon: string;
	title: string;
	description?: string;
	/** 0.13: as tall as a compact subject card, so it can be the last cell of Home's folder grid. */
	compact?: boolean;
	key?: string;
	onRun: () => void;
}

/**
 * Dashed "create" tile (DESIGN.md §3, §5): stands in for the cards of a section that has none yet, for things that can
 * be created (a subject folder, a notebook). A real target: it runs the creation it names.
 */
export function createTile(parent: HTMLElement, o: CreateTileOptions): HTMLElement {
	const tile = parent.createDiv({ cls: o.compact ? "nb-create-tile is-compact" : "nb-create-tile" });
	if (o.key) tile.dataset.key = o.key;
	pressable(tile, o.onRun, o.title);
	setIconSafe(tile.createSpan({ cls: "nb-create-icon", attr: { "aria-hidden": "true" } }), o.icon);
	const text = tile.createDiv({ cls: "nb-create-text" });
	text.createDiv({ cls: "nb-create-title", text: o.title });
	if (o.description) text.createDiv({ cls: "nb-create-desc", text: o.description });
	return tile;
}
