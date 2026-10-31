// Shared chrome of the Zettelkasten surfaces (0.13, DESIGN.md §3, §5): icons per kind, the subject colour of a notebook, and the
// decorative art. Nothing here is behaviour; every picture is guarded by `decorate()` so a failure leaves the surface without it.
import { SUBJECT_COLORS, colorFor } from "../ui/palette";
import { artRef, type ArtRef } from "../ui/art/art-ref";
import { decorate } from "../ui/components/dom";
import type { InboxItem } from "./inbox-items";
import type { CardType } from "./card-content";

/** Lucide icon of an inbox item: what kind of thing it is. */
export function itemIcon(item: Pick<InboxItem, "kind" | "markerKind">): string {
	if (item.kind === "pdf-highlight") return "highlighter";
	if (item.kind === "pdf-comment") return "message-square";
	if (item.kind === "marker") return item.markerKind === "importance" ? "star" : item.markerKind === "placeholder" ? "bookmark" : "flag";
	return "pen-line";
}

/** Lucide icon of a source (where items come from). */
export function sourceIcon(source: string): string {
	return source === "loose-sheet" ? "sticky-note" : source === "pdf" ? "file-text" : "layers";
}

function palette(name: (typeof SUBJECT_COLORS)[number]["name"]): string {
	return SUBJECT_COLORS.find((c) => c.name === name)?.base ?? "#6366F1";
}

/** Lucide icon and subject colour of a card type. */
export const CARD_TYPE_LOOK: Record<CardType, { icon: string; color: string }> = {
	permanent: { icon: "file-text", color: palette("Blue") },
	literature: { icon: "book-open", color: palette("Amber") },
	fleeting: { icon: "zap", color: palette("Violet") },
};

/** The colour a notebook shows with, from the subject palette (a stable hash of its name). */
export function notebookColor(name: string): string {
	return colorFor(name);
}

function surface(): "light" | "dark" {
	return activeDocument.body.hasClass("theme-light") ? "light" : "dark";
}

/** A faint line-art band for a page header, as a data URL; undefined when effects are reduced or the engine fails. */
export function headerArt(seed: string, color = palette("Indigo")): ArtRef | undefined {
	return decorate<ArtRef | undefined>(undefined, () => artRef("art", { seed, color, surface: surface(), density: 0.45, intensity: 0.5 }, 720, 120));
}

/** The empty-state illustration, as a data URL; undefined when effects are reduced or the engine fails. */
export function emptyArt(seed: string, color = palette("Indigo")): ArtRef | undefined {
	return decorate<ArtRef | undefined>(undefined, () => artRef("empty", { seed, color, surface: surface() }, 280, 150));
}
