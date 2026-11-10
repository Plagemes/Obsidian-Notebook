/**
 * 0.30 (#247) The legend of numbered markers on a figure. Pure (no DOM, no 'obsidian') and format-neutral: a legend is an ordinary text
 * box whose lines read `1. words`, `2. words`, ... The words are the person's (typed into the box like any text); the numbers are the ones
 * of the markers on the figure. This file turns that text into entries and back, and works out what the text must say once the markers
 * were renumbered, without ever losing a description:
 *
 *   `1. Cell wall`            an entry; a line that does not start with a number belongs to the entry above it (a long description
 *   `   which goes on`        written on two lines), and is written back indented
 *   `Key`                     lines before the first entry (a heading the person typed) are kept as they are
 *
 * A number is one to three digits followed by `.` or `)` and a space (or nothing); "2.5 mm" is not an entry. Numbers are never looked up
 * from the document here: the callers say which marker numbers exist and which numbers they become.
 */

/** The largest marker number (three digits keep a marker readable and a legend line short). */
export const MAX_MARKER_NUMBER = 99;

const ENTRY_RE = /^\s*(\d{1,3})[.)](?:\s+(.*))?$/;

export interface LegendEntry {
	/** The number the line starts with. */
	number: number;
	/** The words after the number, continuation lines joined with a newline (leading blanks of those lines dropped). */
	words: string;
}

export interface ParsedLegend {
	/** The lines before the first entry, as typed (may be empty). */
	head: string[];
	entries: LegendEntry[];
}

/** The entries of a legend text, in the order written. */
export function parseLegend(text: string): ParsedLegend {
	const head: string[] = [];
	const entries: LegendEntry[] = [];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const m = ENTRY_RE.exec(line);
		if (m) {
			entries.push({ number: Number(m[1]), words: (m[2] ?? "").trim() });
		} else if (entries.length === 0) {
			head.push(line);
		} else {
			const last = entries[entries.length - 1]!;
			const more = line.trim();
			if (more !== "") last.words = last.words === "" ? more : `${last.words}\n${more}`;
		}
	}
	// a heading made of blank lines only is nothing
	while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop();
	return { head, entries };
}

/** One entry as written: `3. words`, a second line of words indented under the first. */
export function entryLine(number: number, words: string): string {
	const lines = words.split("\n");
	const first = lines[0]!;
	const rest = lines.slice(1).map((l) => `   ${l}`);
	return [first === "" ? `${number}.` : `${number}. ${first}`, ...rest].join("\n");
}

/** The text of a legend: the heading lines, then the entries in the order given. */
export function legendText(head: readonly string[], entries: readonly LegendEntry[]): string {
	return [...head, ...entries.map((e) => entryLine(e.number, e.words))].join("\n");
}

/** What the legend of a figure says once its markers are numbered `numbers`. */
export interface LegendPlan {
	text: string;
	/** Entries of the old text that name no marker (their words are dropped). */
	dropped: number;
	/** Markers that had no entry (they get an empty one). */
	added: number;
}

/**
 * The legend text after a renumbering. `markers` lists every marker as `{ from, to }`: the number it had (the number its words are filed
 * under in the old text) and the number it has now. Entries come out in the order of the new numbers; the words follow their marker. Two
 * entries under one old number keep the words of the first. The heading lines stay.
 */
export function reconcileLegend(oldText: string, markers: readonly { from: number; to: number }[]): LegendPlan {
	const { head, entries } = parseLegend(oldText);
	const words = new Map<number, string>();
	for (const e of entries) if (!words.has(e.number)) words.set(e.number, e.words);
	const used = new Set<number>();
	const out: LegendEntry[] = [];
	let added = 0;
	for (const m of [...markers].sort((a, b) => a.to - b.to)) {
		const had = words.get(m.from);
		// a second marker that carried the same old number has no words of its own
		const mine = had !== undefined && !used.has(m.from) ? had : undefined;
		if (mine === undefined) added++;
		used.add(m.from);
		out.push({ number: m.to, words: mine ?? "" });
	}
	const dropped = [...words.keys()].filter((n) => !used.has(n)).length;
	return { text: legendText(head, out), dropped, added };
}

/** A legend with an empty entry for each of `numbers` (a new legend). */
export function freshLegend(numbers: readonly number[]): string {
	return legendText([], [...numbers].sort((a, b) => a - b).map((number) => ({ number, words: "" })));
}

/**
 * The legend text with one more entry for `number` at the end of the entries (the words of the other entries stay exactly as typed). The
 * same text when the legend already has an entry for that number.
 */
export function withEntry(oldText: string, number: number): string {
	const { head, entries } = parseLegend(oldText);
	if (entries.some((e) => e.number === number)) return oldText;
	const at = entries.findIndex((e) => e.number > number);
	const next = [...entries];
	next.splice(at < 0 ? next.length : at, 0, { number, words: "" });
	return legendText(head, next);
}

/** The words of the entry for `number` (empty when there is none). */
export function wordsOf(text: string, number: number): string {
	return parseLegend(text).entries.find((e) => e.number === number)?.words ?? "";
}
