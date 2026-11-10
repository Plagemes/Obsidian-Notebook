/**
 * 0.29 (#248) Figure captions and references written in the text of a text box. Pure: no 'obsidian', no DOM, and no imports, so
 * `wikilink.ts` (the one place that turns stored text into the text a reader sees) can use it without a cycle.
 *
 * Nothing here changes the document format: a caption or a reference is a marker inside an ordinary text box.
 *   `{{figcap:<id>}} Text`   the caption of the picture whose element id is <id>; shown as "Fig. 3 — Text"
 *   `{{figref:<id>}}`        a reference to that picture; shown as "Fig. 3" (a link: a tap goes to the figure)
 * The number is never stored: it is looked up when the text is shown (like a wikilink's label), from the registry below that the
 * open notebook view fills in. A marker whose figure is gone (or that no registered notebook knows) shows "Fig. ?".
 */

/** Prefix of the synthetic link target a reference gets when it is shown (`nbfig:<id>`); never written to a file. */
export const FIGURE_TARGET_PREFIX = "nbfig:";

const TOKEN_RE = /\{\{fig(cap|ref):([A-Za-z0-9_-]{1,80})\}\}/g;

export interface FigureToken {
	kind: "cap" | "ref";
	/** The element id of the picture. */
	id: string;
	/** Index of `{{` and one past `}}` in the text. */
	start: number;
	end: number;
}

/** Cheap test used before any parsing: most text boxes have no marker. */
export function hasFigureTokens(text: string): boolean {
	return text.includes("{{fig");
}

/** Every caption and reference marker in `text`, in order. */
export function figureTokens(text: string): FigureToken[] {
	if (!hasFigureTokens(text)) return [];
	const out: FigureToken[] = [];
	for (const m of text.matchAll(TOKEN_RE)) out.push({ kind: m[1] === "cap" ? "cap" : "ref", id: m[2]!, start: m.index, end: m.index + m[0].length });
	return out;
}

export const captionToken = (id: string): string => `{{figcap:${id}}}`;
export const referenceToken = (id: string): string => `{{figref:${id}}}`;

/** The figure a link target names (`nbfig:<id>`), or null for any other target. */
export function figureIdOfTarget(target: string): string | null {
	return target.startsWith(FIGURE_TARGET_PREFIX) ? target.slice(FIGURE_TARGET_PREFIX.length) : null;
}

/**
 * The figure a text box captions: its text starts (after blank space) with a caption marker. `text` is what follows the marker with
 * the one space after it dropped (the words the person typed).
 */
export function parseCaption(text: string): { figureId: string; text: string } | null {
	const lead = /^\s*/.exec(text)![0].length;
	const m = /^\{\{figcap:([A-Za-z0-9_-]{1,80})\}\}/.exec(text.slice(lead));
	if (!m) return null;
	return { figureId: m[1]!, text: text.slice(lead + m[0].length).replace(/^[ \t]/, "") };
}

/** The stored text of a caption box. */
export function captionText(figureId: string, text: string): string {
	const words = text.replace(/\r\n?/g, "\n").trim();
	return words === "" ? captionToken(figureId) : `${captionToken(figureId)} ${words}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The registry: who knows the numbers. The open notebook view adds a source; exports of a notebook that is not open add a scoped one.

export interface FigureLabelSource {
	/** The short word before the number ("Fig."), translated. */
	abbr(): string;
	/** The number of the figure, or null when this source does not know it. */
	number(id: string): number | null;
}

const sources: FigureLabelSource[] = [];

/** Adds a source; the returned function removes it. */
export function addFigureLabelSource(source: FigureLabelSource): () => void {
	sources.push(source);
	return () => {
		const i = sources.lastIndexOf(source);
		if (i >= 0) sources.splice(i, 1);
	};
}

/** The current number of a figure (1-based), or null when no source knows it (a figure that was deleted, or a caption of nothing). */
export function figureNumber(id: string): number | null {
	for (let i = sources.length - 1; i >= 0; i--) {
		const n = sources[i]!.number(id);
		if (n !== null) return n;
	}
	return null;
}

export const DEFAULT_FIGURE_ABBR = "Fig.";

export function figureAbbr(): string {
	return sources[sources.length - 1]?.abbr() ?? DEFAULT_FIGURE_ABBR;
}

/** "Fig. 3", or "Fig. ?" when the figure has no number. */
export function figureLabel(id: string): string {
	const n = figureNumber(id);
	return `${figureAbbr()} ${n === null ? "?" : n}`;
}

/**
 * `text` with every marker replaced by what a reader sees ("Fig. 3 — words", "Fig. 3"); the rest is untouched (wikilinks stay as
 * written). For outputs that carry text as Markdown (the companion note, the Markdown export).
 */
export function resolveFigureMarkers(text: string): string {
	const tokens = figureTokens(text);
	if (tokens.length === 0) return text;
	let out = "";
	let at = 0;
	for (const t of tokens) {
		out += text.slice(at, t.start);
		out += t.kind === "cap" ? captionShown(t.id, text.slice(t.end)) : figureLabel(t.id);
		at = t.end;
	}
	return out + text.slice(at);
}

/** The em dash between the label and the words of a caption. */
export const CAPTION_DASH = "—";

/**
 * What a caption marker shows: "Fig. 3 —" when words follow on the same line, else "Fig. 3". `after` is the text right behind the
 * marker.
 */
export function captionShown(id: string, after: string): string {
	const label = figureLabel(id);
	const rest = /^[^\n]*/.exec(after)![0];
	if (rest.trim() === "") return label;
	return /^\s/.test(rest) ? `${label} ${CAPTION_DASH}` : `${label} ${CAPTION_DASH} `;
}
