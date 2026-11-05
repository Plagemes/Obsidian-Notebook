import { createId } from "./document";
import type { BBox } from "../ink/hit-test";
import type { CheckboxElement, CheckboxTask, Page, PageElement } from "./types";

/**
 * Handwritten checklists (0.19, roadmap #103, format v17). Pure data and geometry: no 'obsidian', no DOM. A drawn square becomes a
 * page element (`CheckboxElement`) that a tap ticks; the ink on the same line to its right is its handwritten label (found
 * geometrically, ink/checklist.ts, nothing is stored). The optional link to an Obsidian task (`task`) names the note and the block
 * id (`^nb-…`) of one task line; `setTaskLineChecked` is the only code that ever changes such a line. See docs/architecture.md,
 * *Handwritten checklists, format v17*.
 */

/** Side of a checkbox inserted from a menu (pt): a little taller than a line of handwriting. */
export const CHECKBOX_DEFAULT_SIZE = 20;
/** A checkbox is never smaller or larger than this (pt, a side). */
export const CHECKBOX_MIN_SIZE = 8;
export const CHECKBOX_MAX_SIZE = 96;
/** Longest typed label (characters): a checklist item is a line, not a note. */
export const CHECKBOX_LABEL_MAX = 200;
/** Longest note path and block id a link can hold (the strict writer and the readers share them). */
export const CHECKBOX_PATH_MAX = 500;
export const CHECKBOX_BLOCK_MAX = 40;
/** Block ids written by the plugin start with this (`^nb-…` at the end of a task line). */
export const CHECKBOX_BLOCK_PREFIX = "nb-";
/** The default colour: the neutral ink colour (a recognised square keeps the colour it was drawn in). */
export const CHECKBOX_DEFAULT_COLOR = "#1f2430";

const round2 = (v: number) => Math.round(v * 100) / 100;
const clampSize = (v: number) => Math.min(CHECKBOX_MAX_SIZE, Math.max(CHECKBOX_MIN_SIZE, round2(v)));

/** Whether `el` is a checkbox. */
export function isCheckbox(el: PageElement): el is CheckboxElement {
	return el.type === "checkbox";
}

/** Checkboxes of a page, in array order. */
export function checkboxesOf(page: Pick<Page, "elements">): CheckboxElement[] {
	return (page.elements ?? []).filter(isCheckbox);
}

/** A new, unticked checkbox of side `size` whose centre is (`cx`, `cy`), kept inside a page of `page` size when it fits. */
export function createCheckbox(
	cx: number, cy: number, page: { width: number; height: number }, color: string = CHECKBOX_DEFAULT_COLOR, size = CHECKBOX_DEFAULT_SIZE,
): CheckboxElement {
	const side = clampSize(Math.min(size, Math.max(CHECKBOX_MIN_SIZE, Math.min(page.width, page.height))));
	const x = Math.min(Math.max(0, page.width - side), Math.max(0, cx - side / 2));
	const y = Math.min(Math.max(0, page.height - side), Math.max(0, cy - side / 2));
	return { id: createId(), type: "checkbox", x: round2(x), y: round2(y), size: side, color };
}

/** The box of the checkbox. */
export function checkboxBounds(el: CheckboxElement): BBox {
	return { minX: el.x, minY: el.y, maxX: el.x + el.size, maxY: el.y + el.size };
}

/** Typed label as stored: one line, runs of spaces collapsed, at most CHECKBOX_LABEL_MAX characters. */
export function cleanCheckboxLabel(text: string): string {
	return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, CHECKBOX_LABEL_MAX).join("");
}

/** The checkbox ticked (or unticked) at time `at` (ms). The tick time is what the merge of two copies compares. */
export function withChecked(el: CheckboxElement, checked: boolean, at: number): CheckboxElement {
	const out: CheckboxElement = { ...el, at: Math.max(0, Math.round(at)) };
	if (checked) out.checked = true;
	else delete out.checked;
	return out;
}

/** The other state of the checkbox, stamped with `at`. */
export function toggledCheckbox(el: CheckboxElement, at: number): CheckboxElement {
	return withChecked(el, el.checked !== true, at);
}

/** A copy with its typed label changed (empty removes it). */
export function withCheckboxLabel(el: CheckboxElement, label: string): CheckboxElement {
	const out: CheckboxElement = { ...el };
	const clean = cleanCheckboxLabel(label);
	if (clean === "") delete out.label;
	else out.label = clean;
	return out;
}

/** A copy linked to the task line (`task`), or without a link (null). */
export function withCheckboxTask(el: CheckboxElement, task: CheckboxTask | null): CheckboxElement {
	const out: CheckboxElement = { ...el };
	if (task === null) delete out.task;
	else out.task = { path: task.path, block: task.block };
	return out;
}

/**
 * A copy for another place (a template, a copy of a page or of a notebook): unticked, never toggled, without the task link. A copy
 * must not tick the task line of the original, and a template is a form to fill in again.
 */
export function clearedCheckbox(el: CheckboxElement): CheckboxElement {
	const out: CheckboxElement = { ...el };
	delete out.checked;
	delete out.at;
	delete out.task;
	return out;
}

/** The checkbox as a copy under a new id keeps its state but never the link to the task of the original. */
export function copiedCheckbox(el: CheckboxElement, id: string): CheckboxElement {
	const out: CheckboxElement = { ...el, id };
	delete out.task;
	return out;
}

/** `page` with every checkbox cleared (see `clearedCheckbox`); the same page object when it has none that needs it. */
export function clearChecklist(page: Page): Page {
	const elements = page.elements;
	if (!elements || !elements.some((e) => e.type === "checkbox" && (e.checked || e.at !== undefined || e.task))) return page;
	// (frozen like every committed element; a cleared checkbox has no nested object left)
	return { ...page, elements: elements.map((e) => (e.type === "checkbox" ? Object.freeze(clearedCheckbox(e)) : e)) };
}

/** The unticked checkboxes of `pages`, with their page index, in reading order (page, then the order on the page). */
export function openCheckboxes(pages: readonly Pick<Page, "id" | "elements">[]): Array<{ pageIndex: number; pageId: string; checkbox: CheckboxElement }> {
	const out: Array<{ pageIndex: number; pageId: string; checkbox: CheckboxElement }> = [];
	pages.forEach((page, pageIndex) => {
		for (const el of page.elements ?? []) if (el.type === "checkbox" && el.checked !== true) out.push({ pageIndex, pageId: page.id, checkbox: el });
	});
	return out;
}

/** Counts of the checkboxes of a page. */
export function checklistCounts(page: Pick<Page, "elements">): { total: number; open: number; done: number } {
	let total = 0;
	let done = 0;
	for (const el of page.elements ?? []) {
		if (el.type !== "checkbox") continue;
		total++;
		if (el.checked === true) done++;
	}
	return { total, open: total - done, done };
}

// ---------------------------------------------------------------- the task line in a note

/**
 * The block id for a checkbox: `nb-` and the first letters and digits of its element id (a block id allows nothing else), then
 * `salt` (letters and digits too): sending the same checkbox again after it was unlinked must not write a second line with the same
 * block id, so the caller passes something new each time.
 */
export function blockIdFor(el: Pick<CheckboxElement, "id">, salt = ""): string {
	const body = el.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
	return `${CHECKBOX_BLOCK_PREFIX}${body === "" ? "x" : body}${salt.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
}

/** Whether `block` is a block id this plugin could have written. */
export function isOurBlockId(block: unknown): block is string {
	return typeof block === "string" && block.length <= CHECKBOX_BLOCK_MAX && /^nb-[A-Za-z0-9]+$/.test(block);
}

export interface TaskLineEdit {
	/** The note's text: the same string when nothing changed. */
	text: string;
	/** A task line that ends with the block id exists. */
	found: boolean;
	/** The line was rewritten. */
	changed: boolean;
}

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\](?:\s.*)?)$/;

/** Whether `line` ends with the block id `^block` (preceded by a space, followed by nothing but spaces). */
function endsWithBlock(line: string, block: string): boolean {
	const trimmed = line.replace(/\s+$/, "");
	return trimmed.endsWith(` ^${block}`) || trimmed === `^${block}`;
}

/**
 * Ticks (or unticks) the one task line of `text` that ends with `^block`: only the status character between the brackets changes,
 * every other byte of the note (every other line, the line ending of this one) stays as it is. A custom status (`[/]`, `[-]`) is left
 * alone when ticking, and only `x` / `X` becomes a space when unticking. When several lines carry the block id the first is used. A
 * block id that is not one of ours (anything but `nb-…`) is never looked for.
 */
export function setTaskLineChecked(text: string, block: string, checked: boolean): TaskLineEdit {
	if (!isOurBlockId(block)) return { text, found: false, changed: false };
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const cr = raw.endsWith("\r") ? "\r" : "";
		const body = cr ? raw.slice(0, -1) : raw;
		if (!endsWithBlock(body, block)) continue;
		const m = TASK_LINE.exec(body);
		if (!m) continue; // the block id is on something that is not a task: not ours to change
		const status = m[2]!;
		let next = status;
		if (checked && status === " ") next = "x";
		else if (!checked && (status === "x" || status === "X")) next = " ";
		if (next === status) return { text, found: true, changed: false };
		lines[i] = `${m[1]}${next}${m[3]}${cr}`;
		return { text: lines.join("\n"), found: true, changed: true };
	}
	return { text, found: false, changed: false };
}
