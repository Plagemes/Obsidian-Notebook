import { Batch, ReplaceElement, ReplaceStroke, type Command } from "../model/history";
import { freezeElement, freezeStroke } from "../model/serialize";
import { UpdateItems, type PageItem } from "../model/groups";
import { normaliseOpacity, opacityOf, withOpacity } from "../model/opacity";
import type { AreaElement, Page, PageElement, Stroke, TextElement } from "../model/types";

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
	// v23: an area highlighter is recoloured with the highlighter colours (it has no width).
	const area = elements.some((e) => e.type === "area");
	return { inkColor: ink || text, inkWidth: ink, highlighterColor: hl || area, highlighterWidth: hl };
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
	// v23: the area highlighters of the selection count with the highlighter, the text boxes with the ink.
	for (const e of elements) {
		if (group === "ink" && e.type === "text") colors.add(e.color.toLowerCase());
		else if (group === "highlighter" && e.type === "area") colors.add(e.color.toLowerCase());
	}
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
		} else if (el.type === "area" && req.group === "highlighter" && color && color !== el.color.toLowerCase() && page.elements?.includes(el)) {
			// v23: an area highlighter takes the colours of the highlighter.
			const next: AreaElement = { ...el, color };
			commands.push(new ReplaceElement(page.id, el, next));
			newElements.push(next);
		} else {
			newElements.push(el);
		}
	}
	if (commands.length === 0) return null;
	return { command: new Batch("Restyle selection", commands), strokes: newStrokes, elements: newElements };
}

// --- opacity (format v24, roadmap #358) ---

/**
 * Whether `item` takes an opacity: any stroke (every pen), a picture and an area highlighter; a locked element never (it is not restyled).
 * Text, equations, graphs and the other elements have none.
 */
export function takesOpacity(item: Stroke | PageElement): boolean {
	if (!("type" in item)) return true;
	return (item.type === "image" || item.type === "area") && item.locked !== true;
}

/** Whether a selection holds anything the opacity slider changes. */
export function opacityAbility(strokes: readonly Stroke[], elements: readonly PageElement[]): boolean {
	return strokes.length > 0 || elements.some(takesOpacity);
}

/** The opacity every item of the selection has (1 for one without), or null when they differ or there is nothing to change. */
export function commonOpacity(strokes: readonly Stroke[], elements: readonly PageElement[]): number | null {
	const values = new Set<number>();
	for (const s of strokes) values.add(opacityOf(s));
	for (const e of elements) if (takesOpacity(e)) values.add(opacityOf(e as { opacity?: number }));
	return values.size === 1 ? [...values][0]! : null;
}

/** `item` with the opacity `opacity` (the same object when nothing changes; 1 or less than 5 % are normalised, see `normaliseOpacity`). */
function opaqueItem<T extends PageItem>(item: T, opacity: number | undefined): T {
	if (!takesOpacity(item)) return item;
	const next = withOpacity(item as { opacity?: number }, opacity) as T;
	if (next === item) return item;
	return ("type" in next ? freezeElement(next) : freezeStroke(next)) as T;
}

export interface OpacityPlan {
	command: Command;
	/** The selection after the change: every stroke and element given, replaced by its copy where it changed. */
	strokes: Stroke[];
	elements: PageElement[];
}

/**
 * The command that sets the opacity of the strokes, pictures and areas of `page` among the given items, as ONE undo step (`UpdateItems`: it finds the items
 * by id, implements `remap`, and History refuses it on a locked page). `opacity` 1 puts the item back to full strength (the key is removed, so the
 * notebook is what earlier versions wrote). Null when nothing would change. Items no longer on the page are skipped; groups come whole from the caller
 * (`selectableItems`).
 */
export function planOpacity(page: Page, strokes: readonly Stroke[], elements: readonly PageElement[], opacity: number): OpacityPlan | null {
	const target = normaliseOpacity(opacity);
	const onPage = new Set<string>([...page.strokes.map((s) => s.id), ...(page.elements ?? []).map((e) => e.id)]);
	const next = new Map<string, PageItem>();
	const before = new Map<string, PageItem>();
	const plan = <T extends PageItem>(item: T): T => {
		if (!onPage.has(item.id)) return item;
		const changed = opaqueItem(item, target);
		if (changed !== item) {
			next.set(item.id, changed);
			before.set(item.id, item);
		}
		return changed;
	};
	const newStrokes = strokes.map(plan);
	const newElements = elements.map(plan);
	if (next.size === 0) return null;
	// A pure function of the CURRENT item: the planned copy when the item is still the planned one (so the selection keeps pointing at the object
	// in the page), otherwise the item as it is now with the opacity set (a non-history upkeep replaced it since: its change is kept, never reverted).
	const change = (item: PageItem): PageItem => {
		const planned = next.get(item.id);
		if (!planned) return item;
		return item === before.get(item.id) ? planned : opaqueItem(item, target);
	};
	const command = new UpdateItems(page.id, new Set(next.keys()), change, "Opacity");
	return { command, strokes: newStrokes, elements: newElements };
}
