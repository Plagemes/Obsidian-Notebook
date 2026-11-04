/**
 * Smoke check of handwritten checklists (0.19, roadmap #103) on the `doc=checklists` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen events. A checkbox is inserted from the registry, ticked by a pen tap (no dot of
 * ink is left, one undo step), refused on a locked page, named in its dialog, selected together with the handwriting on its line,
 * and linked to a task line of a note: ticking it (and undoing the tick) rewrites only that line, and a line that is gone unlinks the
 * checkbox. A small square drawn by hand is offered as a checkbox in a chip (taking it replaces the stroke, one undo step); a
 * rectangle, a circle and a tall scribble are not offered. It leaves a short checklist (two ticked, one open, handwriting beside each)
 * and the "Make checkbox" chip for a fourth square on the page for the screenshot.
 */
import { checkboxLabelInk } from "../../src/ink/checklist";
import { setCheckboxTask } from "../../src/model/checklist-commands";
import type { CheckboxElement, Page } from "../../src/model/types";
import type { HarnessApp, HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ChecklistsCheckApi {
	view: unknown;
	app: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ChecklistView extends HarnessView {
	selection: { elements: Array<{ type: string }>; strokes: unknown[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { selection?: { checkboxes?: number; checkboxesLinked?: number } | null } : never;
}

interface VaultText {
	create(path: string, data: string): Promise<unknown>;
	modify(file: unknown, data: string): Promise<void>;
	read(file: unknown): Promise<string>;
	getFileByPath(path: string): unknown;
}

export async function checkChecklists(api: ChecklistsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames } = api;
	const v = api.view as ChecklistView;
	const vault = (api.app as HarnessApp & { vault: VaultText }).vault;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const boxes = (): CheckboxElement[] => (page().elements ?? []).filter((e): e is CheckboxElement => e.type === "checkbox");
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const click = async (el: Element | null | undefined) => {
		(el as HTMLElement | null)?.click();
		await frames(2);
	};
	/** A point of the page in view as fractions of the stage (what the synthetic pen takes). */
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const centre = (c: CheckboxElement): [number, number] => frac(c.x + c.size / 2, c.y + c.size / 2);
	const square = (x: number, y: number, s: number): Array<[number, number]> => [frac(x, y), frac(x + s, y), frac(x + s, y + s), frac(x, y + s), frac(x, y + 1)];
	/** A scribble that stands for a handwritten word (two humps) starting at (x, y), `w` pt wide. */
	const word = (x: number, y: number, w: number): Array<[number, number]> => [frac(x, y + 8), frac(x + w * 0.25, y), frac(x + w * 0.5, y + 10), frac(x + w * 0.75, y), frac(x + w, y + 8)];
	const offer = (): HTMLElement | null => q<HTMLElement>(".nb-chk-offer");
	const labelDialog = (): HTMLElement | null => q<HTMLElement>(".nb-chk-label-modal");
	const taskDialog = (): HTMLElement | null => q<HTMLElement>(".notebook-task-modal");
	const text = async (path: string): Promise<string | null> => {
		const f = vault.getFileByPath(path);
		return f ? vault.read(f) : null;
	};
	const settings = v.host.settings as unknown as { checklistDraw: string };

	// --- insert ---
	setTool("lasso");
	add("a new notebook has no checkboxes", boxes().length === 0);
	v.runAction("insert-checkbox");
	await frames(3);
	add("Insert checkbox adds one unticked square", boxes().length === 1 && boxes()[0]!.checked !== true && boxes()[0]!.size > 12, JSON.stringify(boxes()[0]));
	add("the new checkbox is selected and the bar offers Tick, Label and Send to tasks", v.uiContext().selection?.checkboxes === 1 && v.uiContext().selection?.checkboxesLinked === 0);
	const first = boxes()[0]!;
	v.undo();
	await frames(2);
	add("one undo takes it away", boxes().length === 0);
	v.redo();
	await frames(2);

	// --- tick with a tap of the pen ---
	v.clearSelection();
	setTool("pen");
	const ink0 = strokeCount();
	await penStroke([centre(boxes()[0]!)]);
	add("a pen tap ticks the checkbox and leaves no dot of ink", boxes()[0]!.checked === true && strokeCount() === ink0 && typeof boxes()[0]!.at === "number", `${strokeCount() - ink0} strokes, checked=${boxes()[0]!.checked}`);
	v.undo();
	await frames(2);
	add("one undo unticks it", boxes()[0]!.checked !== true);
	v.redo();
	await frames(2);
	add("one redo ticks it again", boxes()[0]!.checked === true);
	await penStroke([centre(boxes()[0]!)]);
	add("a second tap unticks it", boxes()[0]!.checked !== true);

	// --- a drag that starts on the box is ink, not a tap ---
	const c0 = boxes()[0]!;
	const here = centre(c0);
	await penStroke([here, [here[0] + 0.05, here[1] + 0.01], [here[0] + 0.1, here[1]]]);
	add("a stroke that starts on the box and moves is ink and ticks nothing", boxes()[0]!.checked !== true && strokeCount() === ink0 + 1);
	v.undo();
	await frames(2);

	// --- the page lock is respected ---
	v.setPageLocked(page(), true);
	await frames(2);
	setTool("lasso");
	v.runAction("insert-checkbox");
	await frames(2);
	add("a locked page refuses Insert checkbox", boxes().length === 1);
	setTool("pen");
	await penStroke([centre(boxes()[0]!)]);
	add("a locked page refuses a tap", boxes()[0]!.checked !== true);
	v.setPageLocked(page(), false);
	await frames(2);

	// --- the label dialog ---
	setTool("lasso");
	await penStroke([frac(first.x - 6, first.y - 6), frac(first.x + first.size + 6, first.y - 6), frac(first.x + first.size + 6, first.y + first.size + 6), frac(first.x - 6, first.y + first.size + 6), frac(first.x - 6, first.y - 4)]);
	await frames(3);
	add("the lasso selects the checkbox", v.uiContext().selection?.checkboxes === 1);
	v.runAction("checkbox-label");
	await frames(3);
	const input = labelDialog()?.querySelector<HTMLInputElement>("input");
	add("Label opens a small dialog with one field", !!input);
	if (input) {
		input.value = "  Buy   milk ";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await click(labelDialog()?.querySelector<HTMLButtonElement>(".is-primary"));
	add("Save writes a one-line label in one step", boxes()[0]!.label === "Buy milk" && labelDialog() === null, String(boxes()[0]!.label));
	v.undo();
	await frames(2);
	add("one undo takes the label back", boxes()[0]!.label === undefined);
	v.redo();
	await frames(2);

	// --- the handwriting on its line belongs to it ---
	setTool("pen");
	const row = boxes()[0]!;
	await penStroke(word(row.x + row.size + 10, row.y + 2, 40));
	await penStroke(word(row.x + row.size + 56, row.y + 2, 30));
	await penStroke(word(row.x + row.size + 10, row.y + 60, 40));
	add("the ink on its line is its label (and the line below is not)", checkboxLabelInk(row, page().strokes).length === 2, `${checkboxLabelInk(row, page().strokes).length}`);
	setTool("lasso");
	v.clearSelection();
	v.runAction("insert-checkbox");
	await frames(2);
	v.undo();
	await frames(2);
	await penStroke([frac(row.x - 6, row.y - 6), frac(row.x + row.size + 6, row.y - 6), frac(row.x + row.size + 6, row.y + row.size + 6), frac(row.x - 6, row.y + row.size + 6), frac(row.x - 6, row.y - 4)]);
	await frames(3);
	v.runAction("checkbox-select-label");
	await frames(3);
	add("Select with text selects the box and its two words", v.selection?.elements.length === 1 && v.selection.strokes.length === 2, `${v.selection?.elements.length}/${v.selection?.strokes.length}`);
	v.clearSelection();

	// --- the link to a task line ---
	const note = "intro\n- [ ] Buy milk ^nb-harness1\n- [ ] Other ^nb-harness2\nend\n";
	await vault.create("Tasks/Today.md", note);
	v.applyCommand(setCheckboxTask(page().id, row.id, { path: "Tasks/Today.md", block: "nb-harness1" }));
	await frames(3);
	setTool("pen");
	await penStroke([centre(boxes()[0]!)]);
	await sleep(1500);
	const ticked = await text("Tasks/Today.md");
	add("ticking a linked checkbox ticks only its line of the note", ticked === "intro\n- [x] Buy milk ^nb-harness1\n- [ ] Other ^nb-harness2\nend\n", JSON.stringify(ticked));
	v.undo();
	await frames(2);
	await sleep(1500);
	add("undoing the tick unticks the line again", (await text("Tasks/Today.md")) === note, JSON.stringify(await text("Tasks/Today.md")));
	// the line is gone: the checkbox is unlinked
	const file = vault.getFileByPath("Tasks/Today.md");
	await vault.modify(file, "intro\nend\n");
	await penStroke([centre(boxes()[0]!)]);
	await sleep(1500);
	add("a line that is gone unlinks the checkbox and the note is left alone", boxes()[0]!.task === undefined && (await text("Tasks/Today.md")) === "intro\nend\n" && boxes()[0]!.checked === true);
	add("and says so", api.notices.some((n) => /no longer in|non è più/i.test(n)), api.notices.slice(-2).join(" | "));
	v.undo();
	await frames(2);
	v.undo();
	await frames(2);
	await sleep(1000);

	// --- the dialog of Send to tasks ---
	setTool("lasso");
	await penStroke([frac(row.x - 6, row.y - 6), frac(row.x + row.size + 6, row.y - 6), frac(row.x + row.size + 6, row.y + row.size + 6), frac(row.x - 6, row.y + row.size + 6), frac(row.x - 6, row.y - 4)]);
	await frames(3);
	v.runAction("checkbox-task");
	await frames(3);
	const dlg = taskDialog();
	const primary = dlg?.querySelector<HTMLButtonElement>(".is-primary");
	add("Send to tasks opens the task dialog with the label, and can be sent without typing", !!dlg && primary?.disabled === false && (dlg.querySelector<HTMLInputElement>("input")?.value ?? "") === "Buy milk");
	(dlg?.querySelector<HTMLButtonElement>(".nb-modal-btn:not(.is-primary)"))?.click();
	await frames(2);
	v.clearSelection();

	// --- a square drawn by hand ---
	setTool("pen");
	settings.checklistDraw = "offer";
	const before = boxes().length;
	const strokes0 = strokeCount();
	await penStroke(square(150, 300, 22));
	await frames(2);
	add("a small square drawn by hand is offered as a checkbox", !!offer() && strokeCount() === strokes0 + 1 && boxes().length === before);
	await click(offer()?.querySelector("button"));
	add("taking the offer replaces the square by a checkbox of its size, in one step", boxes().length === before + 1 && strokeCount() === strokes0 && offer() === null, `${boxes().length} boxes, ${strokeCount() - strokes0} strokes`);
	const made = boxes()[boxes().length - 1]!;
	add("the new checkbox is where the square was", Math.abs(made.x - 150) < 3 && Math.abs(made.y - 300) < 3 && Math.abs(made.size - 22) < 3, JSON.stringify(made));
	v.undo();
	await frames(2);
	add("one undo gives the square back as ink", boxes().length === before && strokeCount() === strokes0 + 1);
	v.undo();
	await frames(2);
	// not squares
	await penStroke([frac(150, 300), frac(210, 300), frac(210, 318), frac(150, 318), frac(150, 301)]);
	add("a rectangle is not offered", offer() === null);
	v.undo();
	await frames(2);
	const circle: Array<[number, number]> = Array.from({ length: 25 }, (_, i) => frac(160 + 11 * Math.cos((i / 24) * Math.PI * 2), 310 + 11 * Math.sin((i / 24) * Math.PI * 2)));
	await penStroke(circle);
	add("a circle is not offered", offer() === null);
	v.undo();
	await frames(2);
	await penStroke(square(150, 300, 90));
	add("a large square is not offered", offer() === null);
	v.undo();
	await frames(2);
	settings.checklistDraw = "off";
	await penStroke(square(150, 300, 22));
	add("with the setting off nothing is offered", offer() === null);
	v.undo();
	await frames(2);
	settings.checklistDraw = "offer";
	await penStroke(square(150, 300, 22));
	await penStroke(word(190, 303, 30));
	add("writing on takes the offer away", offer() === null);
	v.undo();
	await frames(2);
	v.undo();
	await frames(2);

	// --- the page that stays for the screenshot ---
	const keep = boxes()[0]!;
	if (keep.checked !== true) await penStroke([centre(keep)]);
	for (let i = 1; i <= 2; i++) {
		const y = keep.y + i * 38;
		await penStroke(square(keep.x, y, keep.size));
		await click(offer()?.querySelector("button"));
		const added = boxes().find((b) => Math.abs(b.y - y) < 4);
		await penStroke(word(keep.x + keep.size + 10, y + 2, 70 + i * 12));
		if (added && i === 1) await penStroke([centre(added)]);
	}
	await penStroke(square(keep.x, keep.y + 3 * 38, keep.size));
	await frames(3);
	add("the page shows a short checklist and the offer for one more square", boxes().length === 3 && !!offer(), `${boxes().length} boxes`);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { boxes: boxes().length, ticked: boxes().filter((b) => b.checked).length } };
}
