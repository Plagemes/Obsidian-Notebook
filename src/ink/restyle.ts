import { Batch, ReplaceElement, ReplaceStroke, type Command } from "../model/history";
import { freezeStroke } from "../model/serialize";
import type { Page, PageElement, Stroke, TextElement } from "../model/types";

/**
 * Restyle selection (pure): change colour and width of lasso-selected strokes as ONE undo step.
 * A highlighter keeps highlighter colours and widths: a request names the group it is for, and strokes of
 * the other group are left alone (so a mixed selection can be restyled one group at a time).
 */

export type StyleGroup = "ink" | "highlighter";

export interface RestyleRequest {
	group: StyleGroup;
	/** `#rrggbb`. Text boxes take it too when `group` is "ink". */
	color?: string;
	/** Nominal width in pt. */
	width?: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function styleGroup(stroke: Stroke): StyleGroup {
	return stroke.tool === "highlighter" ? "highlighter" : "ink";
}

/** What can be restyled in a selection: which colour/width rows make sense. */
export interface RestyleAbilities {
	inkColor: boolean;
	inkWidth: boolean;
	highlighterColor: boolean;
	highlighterWidth: boolean;
}

export function restyleAbilities(strokes: readonly Stroke[], elements: readonly PageElement[]): RestyleAbilities {
	const ink = strokes.some((s) => styleGroup(s) === "ink");
	const hl = strokes.some((s) => styleGroup(s) === "highlighter");
	const text = elements.some((e) => e.type === "text");
	return { inkColor: ink || text, inkWidth: ink, highlighterColor: hl, highlighterWidth: hl };
}

/** The value shared by every item, or null when they differ (to mark the active swatch). */
export function commonStyle(
	strokes: readonly Stroke[], elements: readonly PageElement[], group: StyleGroup,
): { color: string | null; width: number | null } {
	const colors = new Set<string>();
	const widths = new Set<number>();
	for (const s of strokes) {
		if (styleGroup(s) !== group) continue;
		colors.add(s.color.toLowerCase());
		widths.add(s.width);
	}
	if (group === "ink") for (const e of elements) if (e.type === "text") colors.add(e.color.toLowerCase());
	return {
		color: colors.size === 1 ? [...colors][0]! : null,
		width: widths.size === 1 ? [...widths][0]! : null,
	};
}

export interface RestylePlan {
	command: Batch;
	strokes: Stroke[];
	elements: PageElement[];
}

/** A copy of `stroke` with the requested style (same id and points); `stroke` itself when nothing changes. */
export function restyleStroke(stroke: Stroke, req: RestyleRequest): Stroke {
	if (styleGroup(stroke) !== req.group) return stroke;
	const color = req.color !== undefined && HEX.test(req.color) ? req.color.toLowerCase() : stroke.color;
	const width = req.width !== undefined && Number.isFinite(req.width) && req.width > 0 ? Math.round(req.width * 100) / 100 : stroke.width;
	if (color === stroke.color && width === stroke.width) return stroke;
	return freezeStroke({ ...stroke, color, width });
}

/**
 * The command that restyles `strokes` (and the text boxes among `elements`) of `page`, plus the new objects to
 * keep selected. Null when nothing would change. Strokes and elements no longer on the page are skipped.
 */
export function planRestyle(
	page: Page, strokes: readonly Stroke[], elements: readonly PageElement[], req: RestyleRequest,
): RestylePlan | null {
	const commands: Command[] = [];
	const newStrokes: Stroke[] = [];
	const newElements: PageElement[] = [];
	const ordered = strokes
		.map((stroke) => ({ stroke, index: page.strokes.indexOf(stroke) }))
		.filter((it) => it.index >= 0);
	const replaced = new Map<Stroke, Stroke>();
	for (const it of ordered) {
		const next = restyleStroke(it.stroke, req);
		replaced.set(it.stroke, next);
		if (next !== it.stroke) commands.push(new ReplaceStroke(page.id, it.stroke, [next], it.index));
	}
	for (const s of strokes) newStrokes.push(replaced.get(s) ?? s);
	const color = req.color !== undefined && HEX.test(req.color) ? req.color.toLowerCase() : null;
	for (const el of elements) {
		if (el.type === "text" && req.group === "ink" && color && color !== el.color.toLowerCase() && page.elements?.includes(el)) {
			const next: TextElement = { ...el, color };
			commands.push(new ReplaceElement(page.id, el, next));
			newElements.push(next);
		} else {
			newElements.push(el);
		}
	}
	if (commands.length === 0) return null;
	return { command: new Batch("Restyle selection", commands), strokes: newStrokes, elements: newElements };
}
