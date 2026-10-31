// Pure part of the modal shell (wave 0.13): the options, the class lists and the colour rule. No obsidian, no DOM, so the unit
// tests (plain Node) can check them.
import { colorFor } from "../palette";

export type ShellSize = "narrow" | "medium" | "wide";
export type ShellButtonKind = "primary" | "secondary" | "danger";

export interface ShellOptions {
	title: string;
	/** One quiet line under the title. */
	subtitle?: string;
	/** A Lucide icon for the icon square in the header (absent: no square). */
	icon?: string;
	/** The colour of the icon square and the band (`#rrggbb`); default: a subject colour picked from `seed` or the title. */
	color?: string;
	/** Seed of the line art (same seed, same picture); default: the title. */
	seed?: string;
	/** Width class: narrow 440 px, medium 560 px (default), wide 720 px. */
	size?: ShellSize;
	/** An extra class for the Obsidian modal element (hooks for the dialog's own rules and the harness). */
	cls?: string;
	/** Draw the faint art band behind the header (default true; off with reduced motion and effects, see the engine). */
	art?: boolean;
	/** Make the footer (default true). A dialog whose actions live in its body leaves it out. */
	footer?: boolean;
	/** Show the close button (default true). */
	closeable?: boolean;
}

/** Classes of the Obsidian modal element for a shell. Pure, for tests. */
export function shellClasses(size: ShellSize = "medium", extra?: string): string[] {
	const out = ["nb-ui", "nb-modal", `is-${size}`];
	if (extra) out.push(...extra.split(/\s+/).filter(Boolean));
	return out;
}

/** Classes of a shell button of this kind. Pure, for tests. */
export function shellButtonClasses(kind: ShellButtonKind): string[] {
	const out = ["nb-modal-btn", `is-${kind}`];
	if (kind === "primary") out.push("mod-cta");
	if (kind === "danger") out.push("mod-warning");
	return out;
}

/** The colour a shell uses: the one asked for, else a subject colour picked from the seed (or the title). */
export function shellColour(o: Pick<ShellOptions, "color" | "seed" | "title">): string {
	return o.color ?? colorFor(o.seed ?? o.title);
}

