/**
 * 0.17 (#57) Task from a selection: the pure text side (no DOM, no 'obsidian'). A region of a page becomes a Markdown task line
 * `- [ ] text ... ![[crop|200]] [[page link]]` appended to a note; the picture is a crop of the page around the selection.
 * Nothing here changes the document format.
 */

/** A rectangle in page points. */
export interface TaskRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Margin kept around the selection in the crop, pt. */
export const TASK_CROP_PAD = 12;
/** The crop is never smaller than this, pt (a single dot would otherwise give a useless picture). */
export const TASK_CROP_MIN = 48;
/** Width the picture is shown at in the note, px. */
export const TASK_IMAGE_WIDTH = 200;

/** The crop of a page around `bounds` (page coordinates): padded, at least `TASK_CROP_MIN`, kept inside the page. */
export function taskCropRect(bounds: { minX: number; minY: number; maxX: number; maxY: number }, page: { width: number; height: number }): TaskRect {
	let x0 = bounds.minX - TASK_CROP_PAD;
	let y0 = bounds.minY - TASK_CROP_PAD;
	let x1 = bounds.maxX + TASK_CROP_PAD;
	let y1 = bounds.maxY + TASK_CROP_PAD;
	if (x1 - x0 < TASK_CROP_MIN) {
		const c = (x0 + x1) / 2;
		x0 = c - TASK_CROP_MIN / 2;
		x1 = c + TASK_CROP_MIN / 2;
	}
	if (y1 - y0 < TASK_CROP_MIN) {
		const c = (y0 + y1) / 2;
		y0 = c - TASK_CROP_MIN / 2;
		y1 = c + TASK_CROP_MIN / 2;
	}
	x0 = Math.max(0, x0);
	y0 = Math.max(0, y0);
	x1 = Math.min(page.width, x1);
	y1 = Math.min(page.height, y1);
	return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

const two = (n: number) => String(n).padStart(2, "0");

/** `HHmmss` of a local time: makes the picture name of a task unique without a counter. */
export function taskStamp(date: Date): string {
	return `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** File name of the crop of a task: `<Notebook> task p<page>-<HHmmss>.png` (recognised by name as written by the plugin). */
export function taskPictureName(notebook: string, pageNumber: number, stamp: string): string {
	return `${notebook} task p${pageNumber}-${stamp}.png`;
}

/** Is `value` a real calendar date written `YYYY-MM-DD`? */
export function isIsoDate(value: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The text of a task as one line: line breaks and runs of spaces collapse. */
export function cleanTaskText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A bare web address inside typed text (the split keeps each one as an odd piece). */
const URL_TOKEN = /(https?:\/\/[^\s<>[\]$`\\]+)/g;

/**
 * The text of a task made safe to sit in a Markdown line: what typed text could open or swallow (a `%%` comment, an HTML
 * comment or tag, a `$` math span, a link or embed, emphasis or code that runs on into the picture and the link after it) is
 * escaped with a backslash, and so is a start that would turn the task line into a heading, a quote or a nested list. Applied
 * once, when the line is built: the text the dialog holds stays what the user typed.
 */
export function escapeTaskText(text: string): string {
	// A bare URL stays as typed (escaping `_`, `%`, `*` or `$` inside it would break the link). The token stops at what could
	// still open a tag, a link or a math span (`<`, `[`, `]`, `$`, backtick, backslash), which is then escaped as usual,
	// and a `%%` inside it is split so it cannot open a comment.
	const out = text
		.split(URL_TOKEN)
		.map((piece, i) => (i % 2 === 1 ? piece.replace(/%%/g, "%\\%") : piece.replace(/[\\`*_[\]<$%]/g, (c) => `\\${c}`)))
		.join("");
	return out
		.replace(/^#{1,6}(?=\s|$)/, (m) => `\\${m}`)
		.replace(/^(?:[+-](?=\s|$)|>)/, (m) => `\\${m}`)
		.replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2");
}

/** Whether a key press in the text field adds the task: Enter, but not the Enter that confirms an IME composition. */
export function isSubmitKey(e: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
	return e.key === "Enter" && e.isComposing !== true && e.keyCode !== 229;
}

/** The due date as text: the Tasks plugin's `📅 date`, or the Dataview field `[due:: date]` when the emoji is off. Empty for no date. */
export function dueText(iso: string, emoji: boolean): string {
	if (!isIsoDate(iso)) return "";
	return emoji ? `\u{1F4C5} ${iso}` : `[due:: ${iso}]`;
}

/**
 * Gives an image embed a display width: `![[a.png]]` -> `![[a.png|200]]`, `![alt](a.png)` -> `![alt|200](a.png)`. Anything else is
 * returned as it is.
 */
export function embedWithWidth(embed: string, width: number): string {
	const wiki = /^(!\[\[[^\]|]*)(\|[^\]]*)?\]\]$/.exec(embed);
	if (wiki) return `${wiki[1]}|${width}]]`;
	const md = /^!\[([^\]|]*)(?:\|\d+)?\](\(.*\))$/.exec(embed);
	if (md) return `![${md[1]}|${width}]${md[2]}`;
	return embed;
}

export interface TaskLineParts {
	text: string;
	/** `YYYY-MM-DD` or empty. */
	due: string;
	/** Tasks-plugin emoji for the date (else a Dataview field). */
	emoji: boolean;
	/** The picture embed, already with its width; null when the picture could not be made. */
	image: string | null;
	/** Link to the page of the notebook. */
	pageLink: string;
}

/**
 * `- [ ] text ![[crop|200]] [[page]] 📅 date`. The date goes last because the Tasks plugin reads its signifiers from the end of
 * the line; the picture and the link stay in the description.
 */
export function buildTaskLine(p: TaskLineParts): string {
	const parts = ["- [ ]", escapeTaskText(cleanTaskText(p.text))];
	if (p.image) parts.push(p.image);
	if (p.pageLink) parts.push(p.pageLink);
	const due = dueText(p.due, p.emoji);
	if (due) parts.push(due);
	return parts.filter((s) => s !== "").join(" ");
}

/**
 * The note's text with `line` added at the end; null when that very line is already there (nothing is written). The rest of the
 * text is returned byte for byte, with the note's own line ending.
 */
export function appendTaskLine(text: string, line: string): string | null {
	if (text.split(/\r?\n/).some((l) => l.trim() === line.trim())) return null;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const sep = text === "" || text.endsWith("\n") ? "" : eol;
	return `${text}${sep}${line}${eol}`;
}
