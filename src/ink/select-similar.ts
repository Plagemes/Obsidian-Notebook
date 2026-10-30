import type { PageElement, Stroke, Tool } from "../model/types";

/**
 * Select by colour or tool (roadmap 64). Pure: it picks, from the ink the reader can see and the text boxes of a page,
 * the items that share a colour or a tool with a seed (the current selection) or with a choice made in the picker.
 * Text boxes have a colour but no tool, so a colour matches them too and a tool never does. Callers pass only the
 * strokes the reader can see (hidden ink stays out unless the solutions are shown), like the lasso does.
 */

export interface StyleChoice {
	/** `#rrggbb`, compared case-insensitively. */
	colour?: string;
	tool?: Tool;
}

export interface StyleCatalog {
	tools: Array<{ tool: Tool; count: number }>;
	colours: Array<{ colour: string; count: number }>;
	/** Tool and colour together, for pages that mix (yellow highlighter next to a green one). */
	combos: Array<{ tool: Tool; colour: string; count: number }>;
}

const norm = (c: string) => c.toLowerCase();

const byCountThenName = <T extends { count: number }>(key: (x: T) => string) => (a: T, b: T): number =>
	b.count - a.count || key(a).localeCompare(key(b));

/** The tools, colours and tool-colour pairs in use on a page, most used first. */
export function styleCatalog(strokes: readonly Stroke[], elements: readonly PageElement[] = []): StyleCatalog {
	const tools = new Map<Tool, number>();
	const colours = new Map<string, number>();
	const combos = new Map<string, { tool: Tool; colour: string; count: number }>();
	for (const s of strokes) {
		const colour = norm(s.color);
		tools.set(s.tool, (tools.get(s.tool) ?? 0) + 1);
		colours.set(colour, (colours.get(colour) ?? 0) + 1);
		const key = `${s.tool}|${colour}`;
		const c = combos.get(key);
		if (c) c.count++;
		else combos.set(key, { tool: s.tool, colour, count: 1 });
	}
	for (const e of elements) {
		if (e.type !== "text") continue;
		const colour = norm(e.color);
		colours.set(colour, (colours.get(colour) ?? 0) + 1);
	}
	return {
		tools: [...tools].map(([tool, count]) => ({ tool, count })).sort(byCountThenName((x) => x.tool)),
		colours: [...colours].map(([colour, count]) => ({ colour, count })).sort(byCountThenName((x) => x.colour)),
		combos: [...combos.values()].sort(byCountThenName((x) => `${x.tool}${x.colour}`)),
	};
}

/** Strokes (and text boxes, for a colour) that match every part of the choice; a choice with nothing in it matches nothing. */
export function selectByStyle(
	strokes: readonly Stroke[], elements: readonly PageElement[], choice: StyleChoice,
): { strokes: Stroke[]; elements: PageElement[] } {
	if (choice.colour === undefined && choice.tool === undefined) return { strokes: [], elements: [] };
	const colour = choice.colour === undefined ? null : norm(choice.colour);
	return {
		strokes: strokes.filter((s) => (colour === null || norm(s.color) === colour) && (choice.tool === undefined || s.tool === choice.tool)),
		// A text box has a colour and no tool: it only follows a choice that names a colour and no tool.
		elements: choice.tool === undefined && colour !== null
			? elements.filter((e) => e.type === "text" && norm(e.color) === colour)
			: [],
	};
}

/** What the selection says about "similar": the colours of its strokes and text boxes and the tools of its strokes. */
export function seedStyles(strokes: readonly Stroke[], elements: readonly PageElement[]): { colours: string[]; tools: Tool[] } {
	const colours = new Set<string>();
	const tools = new Set<Tool>();
	for (const s of strokes) {
		colours.add(norm(s.color));
		tools.add(s.tool);
	}
	for (const e of elements) if (e.type === "text") colours.add(norm(e.color));
	return { colours: [...colours], tools: [...tools] };
}

/**
 * "Select similar": everything on the page that shares a colour (`by` "colour") or a tool (`by` "tool") with the seed.
 * With several colours or tools in the seed, all of them count. The seed is part of the result when it matches itself,
 * which it always does.
 */
export function selectSimilar(
	strokes: readonly Stroke[], elements: readonly PageElement[], seed: { strokes: readonly Stroke[]; elements: readonly PageElement[] }, by: "colour" | "tool",
): { strokes: Stroke[]; elements: PageElement[] } {
	const styles = seedStyles(seed.strokes, seed.elements);
	if (by === "tool") {
		const tools = new Set(styles.tools);
		return { strokes: strokes.filter((s) => tools.has(s.tool)), elements: [] };
	}
	const colours = new Set(styles.colours);
	return {
		strokes: strokes.filter((s) => colours.has(norm(s.color))),
		elements: elements.filter((e) => e.type === "text" && colours.has(norm(e.color))),
	};
}
