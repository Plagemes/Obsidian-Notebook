/**
 * Smoke check of sticky notes (0.17, roadmap #20) on the `doc=sticky` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen events. A note is inserted from the registry, edited in its dialog (text and
 * colour), written on by hand, moved with the lasso (its ink follows), collapsed to an icon (its ink is hidden and goes with
 * it) and opened again, deleted, undone and redone, and refused on a locked page. It leaves an open note with text and
 * handwriting and a collapsed blue note on the page for the screenshot.
 */
import { inkOwner, linkedInkIds } from "../../src/ink/attach";
import type { Page, PageElement, StickyElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface StickyCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface StickyView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	selection: { elements: PageElement[]; strokes: unknown[] } | null;
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { selection?: { stickies?: number; stickiesCollapsed?: number } | null; page?: { locked?: boolean } } : never;
}

export async function checkSticky(api: StickyCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames } = api;
	const v = api.view as StickyView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const notes = (): StickyElement[] => (page().elements ?? []).filter((e): e is StickyElement => e.type === "sticky");
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-sticky-editor");
	const click = async (el: Element | null | undefined) => {
		(el as HTMLElement | null)?.click();
		await frames(2);
	};
	/** A point of the page in view as fractions of the stage (what the synthetic pen takes). */
	const frac = (x: number, y: number): [number, number] => {
		const r = document.querySelector(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	/** Ink of the page written on the note (geometric owner), by stroke id. */
	const onNote = (n: StickyElement): string[] => page().strokes.filter((s) => inkOwner(s, page().elements ?? []) === n).map((s) => s.id);

	// --- insert ---
	add("a new notebook has no notes", notes().length === 0);
	v.runAction("insert-sticky");
	await frames(3);
	add("Insert sticky note adds one square note", notes().length === 1 && Math.abs(notes()[0]!.width - notes()[0]!.height) < 0.01, `${notes().length}`);
	add("the new note is selected and the bar offers Edit and Collapse", v.uiContext().selection?.stickies === 1 && v.uiContext().selection?.stickiesCollapsed === 0);

	// --- edit: text and colour in the dialog ---
	v.runAction("sticky-edit");
	await frames(3);
	const dlg = modal();
	add("Edit note opens the dialog", !!dlg);
	const area = dlg?.querySelector<HTMLTextAreaElement>("textarea.nb-sticky-text");
	if (area) {
		area.value = "Call the lab\nbefore Friday";
		area.dispatchEvent(new Event("input", { bubbles: true }));
	}
	const swatches = Array.from(dlg?.querySelectorAll<HTMLButtonElement>(".nb-sticky-swatch") ?? []);
	add("the dialog offers the eight palette colours, each a labelled button", swatches.length === 8 && swatches.every((s) => !!s.getAttribute("aria-label")), `${swatches.length}`);
	await click(swatches[1]);
	add("a swatch shows it is chosen", swatches[1]?.getAttribute("aria-checked") === "true");
	await click(dlg?.querySelector('[data-key="sticky-larger"]'));
	const done = Array.from(dlg?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button") ?? []).find((b) => b.classList.contains("is-primary") || /Done/.test(b.textContent ?? ""));
	await click(done);
	await frames(3);
	const first = notes()[0]!;
	add("Done writes the text, colour and size in one step", first.text === "Call the lab\nbefore Friday" && first.color === "#2F80F7" && first.fontSize === 16, JSON.stringify([first.text, first.color, first.fontSize]));
	add("the dialog closed", modal() === null);
	v.undo();
	await frames(2);
	add("one undo takes the edit back", notes()[0]!.text === undefined && notes()[0]!.color === "#F59E0B");
	v.redo();
	await frames(2);
	add("and one redo brings it again", notes()[0]!.text === "Call the lab\nbefore Friday");

	// --- write on it by hand ---
	setTool("pen");
	const base = strokeCount();
	const note0 = notes()[0]!;
	const w = note0.width, h = note0.height;
	await penStroke([frac(note0.x + 0.2 * w, note0.y + 0.62 * h), frac(note0.x + 0.5 * w, note0.y + 0.8 * h), frac(note0.x + 0.8 * w, note0.y + 0.62 * h)]);
	await penStroke([frac(note0.x + 0.2 * w, note0.y + 0.88 * h), frac(note0.x + 0.8 * w, note0.y + 0.88 * h)]);
	add("the pen writes on the note", strokeCount() === base + 2);
	const owned = onNote(note0);
	add("the ink written on the note belongs to it", owned.length === 2, `${owned.length}`);

	// --- move it with the lasso: the ink follows ---
	setTool("lasso");
	await frames(2);
	const before = { x: note0.x, y: note0.y };
	const inkBefore = page().strokes.slice(base).map((s) => [s.points[0]![0], s.points[0]![1]]);
	const top = frac(note0.x + 0.5 * w, note0.y + 0.2 * h);
	await penStroke([top, top], { pointerType: "pen" });
	await frames(2);
	add("a tap with the lasso selects the note", v.uiContext().selection?.stickies === 1);
	await penStroke([top, frac(note0.x + 0.5 * w + 60, note0.y + 0.2 * h + 40)]);
	await frames(3);
	const moved = notes()[0]!;
	const dx = moved.x - before.x;
	const dy = moved.y - before.y;
	add("dragging the selected note moves it", Math.abs(dx) > 10 || Math.abs(dy) > 10, `${dx.toFixed(1)}, ${dy.toFixed(1)}`);
	const inkAfter = page().strokes.slice(base).map((s) => [s.points[0]![0], s.points[0]![1]]);
	add("and the ink on it moves by the same amount", inkAfter.length === 2 && inkAfter.every((p, i) => Math.abs(p[0]! - inkBefore[i]![0]! - dx) < 0.1 && Math.abs(p[1]! - inkBefore[i]![1]! - dy) < 0.1), JSON.stringify([dx, dy]));
	add("the note stays selected after the move", v.uiContext().selection?.stickies === 1);

	// --- collapse: an icon, the ink hidden with it ---
	v.runAction("sticky-collapse");
	await frames(3);
	const closed = notes()[0]!;
	add("Collapse note keeps the ink it covers in its own list", closed.collapsed === true && (closed.ink?.length ?? 0) === 2, JSON.stringify(closed.ink));
	add("the bar now offers Open note instead", v.uiContext().selection?.stickiesCollapsed === 1);
	add("the ink is still saved (nothing is deleted)", page().strokes.length === base + 2);
	add("the hidden ink belongs to the icon", (closed.ink ?? []).length > 0 && (closed.ink ?? []).every((id) => linkedInkIds(closed)?.has(id)));
	v.runAction("sticky-expand");
	await frames(3);
	v.undo();
	await frames(2);
	add("undo of Open note collapses it again", notes()[0]!.collapsed === true);
	v.undo();
	await frames(2);
	add("undo of Collapse opens it with its ink", notes()[0]!.collapsed !== true && strokeCount() === base + 2);
	v.redo();
	await frames(2);
	// The undo replaced the note: tap its icon with the lasso to select it again, then open it.
	const icon = notes()[0]!;
	const iconAt = frac(icon.x + 10, icon.y + 10);
	await penStroke([iconAt, iconAt], { pointerType: "pen" });
	await frames(2);
	add("a tap on the icon selects the collapsed note", v.uiContext().selection?.stickiesCollapsed === 1);
	v.runAction("sticky-expand");
	await frames(3);
	add("Open note shows the note and its ink again", notes()[0]!.collapsed !== true && notes()[0]!.ink === undefined);

	// --- a second note, collapsed, for the picture ---
	v.clearSelection();
	setTool("lasso");
	v.runAction("insert-sticky");
	await frames(3);
	add("a second note can be added", notes().length === 2);
	v.runAction("sticky-edit");
	await frames(3);
	const swatches2 = Array.from(modal()?.querySelectorAll<HTMLButtonElement>(".nb-sticky-swatch") ?? []);
	await click(swatches2[3]);
	await click(Array.from(modal()?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button") ?? []).find((b) => /Done/.test(b.textContent ?? "")));
	await frames(3);
	v.runAction("sticky-collapse");
	await frames(3);
	add("the second note is an icon", notes().some((n) => n.collapsed === true) && notes().length === 2);

	// --- delete: one step, undone whole ---
	const count = notes().length;
	v.removeSelection();
	await frames(3);
	add("Delete removes the selected note", notes().length === count - 1);
	v.undo();
	await frames(3);
	add("and one undo brings it back", notes().length === count);
	v.clearSelection();

	// --- a locked page refuses every note action ---
	v.runAction("page-lock");
	await frames(3);
	const locked = JSON.stringify(notes());
	v.runAction("insert-sticky");
	await frames(2);
	add("a locked page refuses Insert sticky note", JSON.stringify(notes()) === locked && notes().length === count);
	add("and the context says the page is locked", v.uiContext().page?.locked === true);
	v.runAction("page-lock-toggle");
	await frames(3);
	add("unlocked again", page().locked !== true);

	// --- the picture: open note with text and ink + a collapsed blue one, nothing selected ---
	v.clearSelection();
	setTool("pen");
	await frames(3);
	const sticky = notes();
	add("the page is left with an open note and an icon", sticky.length === 2 && sticky.filter((n) => n.collapsed).length === 1);
	await sleep(50);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
