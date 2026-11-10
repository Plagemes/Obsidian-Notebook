/**
 * 0.30 (#247) The legend of numbered markers on a figure. Pure (no DOM, no 'obsidian') and format-neutral: a legend is an ordinary text
 * box whose lines read `1. words`, `2. words`, ... The words are the person's (typed into the box like any text); the numbers are the ones
 * of the markers on the figure. This file reads that text and works out what it must say once a marker was added or the markers were
 * renumbered, without ever touching what the person typed:
 *
 *   `Key`                     a line that is not an entry (a heading, a note, a source, a blank spacer) is free text: it is never changed,
 *                             moved or removed
 *   `1. Cell wall`            an entry
 *   `   which goes on`        an INDENTED line right under an entry (no blank line between) belongs to it: a description on two lines
 *   ``                        a blank line ends an entry, so a note typed after it ("Source: textbook p.4") is free text, never a description
 *
 * Review 0.30 (I2, I3): every rewrite works on the lines as typed. Adding a marker splices ONE line into the text; renumbering changes
 * only the digits at the start of an entry line (its indentation, `.` or `)` and words stay), adds an empty line for a marker without one,
 * and removes only the entry lines of markers that are gone. Those are reported (`removed`) so the view asks first when they hold words.
 * Two entries under one number (a typo, or a merge) both follow their marker; nothing is ever dropped silently.
 *
 * A number is one to three digits followed by `.` or `)` and a space (or nothing); "2.5 mm" is not an entry. Numbers are never looked up
 * from the document here: the callers say which marker numbers exist and which numbers they become.
 */

/** The largest marker number (three digits keep a marker readable and a legend line short). */
export const MAX_MARKER_NUMBER = 99;

const ENTRY_RE = /^(\s*)(\d{1,3})([.)])(?:\s+(.*))?$/;

/** One entry of a legend: its line, the indented lines under it, and the words they hold. */
export interface LegendEntry {
	/** The number the line starts with. */
	number: number;
	/** The words after the number, continuation lines joined with a newline (leading blanks of those lines dropped). */
	words: string;
	/** The index of the entry's line, and one past its last continuation line, in `lines`. */
	start: number;
	end: number;
}

export interface ParsedLegend {
	/** The lines as typed (a `\r` before a newline stays on its line). */
	lines: string[];
	/** The entries, in the order written. Every line that is in no entry is free text. */
	entries: LegendEntry[];
}

/** A line without the `\r` of a CRLF ending (only for reading it; lines are written back as they were). */
const bare = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** The entries of a legend text, in the order written. */
export function parseLegend(text: string): ParsedLegend {
	const lines = text.split("\n");
	const entries: LegendEntry[] = [];
	let open: LegendEntry | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = bare(lines[i]!);
		const m = ENTRY_RE.exec(line);
		if (m) {
			open = { number: Number(m[2]), words: (m[4] ?? "").trim(), start: i, end: i + 1 };
			entries.push(open);
		} else if (open && line.trim() !== "" && /^\s/.test(line)) {
			const more = line.trim();
			open.words = open.words === "" ? more : `${open.words}\n${more}`;
			open.end = i + 1;
		} else {
			open = null;
		}
	}
	return { lines, entries };
}

/** The line of an empty entry `number`, written like `like` (its indentation and its `.` or `)`), or `n.` when there is none. */
function emptyEntry(number: number, like: string | undefined): string {
	const m = like === undefined ? null : ENTRY_RE.exec(bare(like));
	return `${m?.[1] ?? ""}${number}${m?.[3] ?? "."}`;
}

/** A line with the number at its start changed to `to` (its indentation, separator and words kept). */
function renumberLine(line: string, to: number): string {
	return line.replace(/^(\s*)\d{1,3}/, `$1${to}`);
}

/** Where a new line goes when there is no entry after which it belongs: after the last line that is not blank. */
function afterText(lines: readonly string[]): number {
	let n = lines.length;
	while (n > 0 && bare(lines[n - 1]!).trim() === "") n--;
	return n;
}

/** A legend with an empty entry for each of `numbers` (a new legend). */
export function freshLegend(numbers: readonly number[]): string {
	return [...numbers].sort((a, b) => a - b).map((n) => `${n}.`).join("\n");
}

/**
 * The legend text with one more entry for `number`: ONE line spliced in before the first entry with a larger number, else after the last
 * entry (and its indented lines), else after the last line of text. Every other line stays exactly as typed. The same text when the legend
 * already has an entry for that number.
 */
export function withEntry(oldText: string, number: number): string {
	if (oldText === "") return `${number}.`;
	const { lines, entries } = parseLegend(oldText);
	if (entries.some((e) => e.number === number)) return oldText;
	const next = entries.find((e) => e.number > number);
	const last = entries[entries.length - 1];
	const at = next ? next.start : last ? last.end : afterText(lines);
	const like = next ?? last;
	const out = [...lines];
	out.splice(at, 0, emptyEntry(number, like ? lines[like.start] : undefined));
	return out.join("\n");
}

/** What the legend of a figure says once its markers are renumbered. */
export interface LegendPlan {
	text: string;
	/** Entries of the old text that name no marker any more (they are removed, with their indented lines). */
	dropped: number;
	/** The text of each removed entry that holds words (the view asks before they go). */
	removed: string[];
	/** Markers that had no entry (they get an empty one). */
	added: number;
	/** Entries that share their number with an entry above them: they keep their words and follow the same marker. */
	shared: number;
}

type EntryPiece = { entry: true; number: number; lines: string[] };
type Piece = EntryPiece | { entry: false; line: string };

/**
 * The legend text after a renumbering. `markers` lists every marker as `{ from, to }`: the number it had (the number its words are filed
 * under in the old text) and the number it has now. Entries keep their place and their words; only their number changes. An entry whose
 * number no marker had is removed (`removed` holds its text when it has words). A marker without an entry gets an empty one, before the
 * first entry with a larger number. When two markers carried the same old number, the first keeps the words and the second gets an empty
 * line; when two entries carry the same number, both follow its marker (`shared`). Free text lines never change.
 */
export function reconcileLegend(oldText: string, markers: readonly { from: number; to: number }[]): LegendPlan {
	const { lines, entries } = parseLegend(oldText);
	const target = new Map<number, number>();
	const extra: number[] = [];
	for (const m of [...markers].sort((a, b) => a.to - b.to)) {
		if (target.has(m.from)) extra.push(m.to);
		else target.set(m.from, m.to);
	}
	const owned = new Set(entries.map((e) => e.number));
	for (const [from, to] of target) if (!owned.has(from)) extra.push(to);
	extra.sort((a, b) => a - b);

	const pieces: Piece[] = [];
	const removed: string[] = [];
	let dropped = 0;
	let shared = 0;
	const seen = new Set<number>();
	let i = 0;
	for (const e of entries) {
		for (; i < e.start; i++) pieces.push({ entry: false, line: lines[i]! });
		const block = lines.slice(e.start, e.end);
		i = e.end;
		const to = target.get(e.number);
		if (to === undefined) {
			dropped++;
			if (e.words !== "") removed.push(block.map(bare).join("\n"));
			continue;
		}
		if (seen.has(e.number)) shared++;
		seen.add(e.number);
		pieces.push({ entry: true, number: to, lines: [renumberLine(block[0]!, to), ...block.slice(1)] });
	}
	for (; i < lines.length; i++) pieces.push({ entry: false, line: lines[i]! });

	for (const n of extra) {
		const kept = pieces.filter((p): p is EntryPiece => p.entry);
		const next = kept.find((p) => p.number > n);
		const last = kept[kept.length - 1];
		const piece: Piece = { entry: true, number: n, lines: [emptyEntry(n, (next ?? last)?.lines[0])] };
		if (next) pieces.splice(pieces.indexOf(next), 0, piece);
		else if (last) pieces.splice(pieces.indexOf(last) + 1, 0, piece);
		else {
			// no entry left: after the last line of text (a blank last line stays last)
			let at = pieces.length;
			while (at > 0) {
				const p = pieces[at - 1]!;
				if (p.entry || bare(p.line).trim() !== "") break;
				at--;
			}
			pieces.splice(at, 0, piece);
		}
	}
	const text = pieces.flatMap((p) => (p.entry ? p.lines : [p.line])).join("\n");
	return { text, dropped, removed, added: extra.length, shared };
}

/** The words of the entry for `number` (empty when there is none). */
export function wordsOf(text: string, number: number): string {
	return parseLegend(text).entries.find((e) => e.number === number)?.words ?? "";
}
