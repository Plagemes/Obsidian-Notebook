/**
 * Smoke check of per-page undo (0.28, roadmap #98) on the `doc=pageundo` notebook (the blank "New" notebook; npm run harness:check): the
 * real view. With the setting off Undo is the plain global one (its name says "Undo"). With it on the toolbar buttons say "Undo on this
 * page" / "Redo on this page" (tooltip and long-press help), Undo takes back the newest step of the page in view even when other pages were
 * written on since, Redo brings it back, a new edit on another page keeps what the page undid, a step that touched two pages is not undone
 * from either page (one notice says why), and the history panel marks the steps of this page and the steps of the whole notebook and says
 * that per-page undo is on. The final state (the panel open) is left for the screenshot.
 */
import { createStroke, quantizePoint } from "../../src/model/document";
import { AddStroke, Batch, ReplaceStroke } from "../../src/model/history";
import type { NotebookDocument, Point, Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PageundoCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PageundoView extends HarnessView {
	host: { settings: HarnessView["host"]["settings"] & { pageUndo: boolean } };
}

export async function checkPageundo(api: PageundoCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as PageundoView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const doc = (): NotebookDocument => v.document;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const undoButton = (): HTMLButtonElement | null => q<HTMLButtonElement>('.notebook-toolbar [data-action="undo"]');
	const redoButton = (): HTMLButtonElement | null => q<HTMLButtonElement>('.notebook-toolbar [data-action="redo"]');
	const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-hist-modal .nb-hist-row"));
	const setting = async (on: boolean): Promise<void> => {
		v.host.settings.pageUndo = on;
		v.applySettings(v.host.settings);
		await frames(3);
	};
	const goTo = async (index: number): Promise<void> => {
		v.jumpToPage(index);
		await frames(6);
	};
	const scribble = (y: number): Stroke => {
		const pts: Point[] = [];
		for (let i = 0; i <= 8; i++) pts.push(quantizePoint(60 + i * 20, y + Math.sin(i) * 6, 0.5));
		return createStroke("#1e1e1e", 2, pts);
	};
	const write = async (index: number, y: number): Promise<Stroke> => {
		const page = doc().pages[index]!;
		const s = scribble(y);
		v.applyCommand(new AddStroke(page.id, s, page.strokes.length));
		await frames(2);
		return s;
	};
	const show = async (): Promise<void> => {
		await frames(3);
		const m = q<HTMLElement>(".nb-hist-modal")?.closest(".modal") as HTMLElement | null;
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
		await frames(2);
	};

	while (doc().pages.length < 3) v.addPage();
	await frames(3);
	const [p1, p2, p3] = doc().pages as [NotebookDocument["pages"][number], NotebookDocument["pages"][number], NotebookDocument["pages"][number]];

	// --- setting off: the plain Undo, unchanged ---
	await setting(false);
	add("with the setting off the buttons are the plain Undo and Redo", undoButton()?.getAttribute("aria-label") === "Undo" && redoButton()?.getAttribute("aria-label") === "Redo", undoButton()?.getAttribute("aria-label") ?? "");
	const x1 = await write(0, 100);
	const x2 = await write(1, 100);
	v.undo();
	await frames(2);
	add("the plain Undo takes back the newest step of the notebook, whatever its page", p2.strokes.length === 0 && p1.strokes.includes(x1));
	v.redo();
	await frames(2);
	add("the plain Redo brings it back", p2.strokes.includes(x2));

	// --- setting on ---
	await setting(true);
	add("with the setting on the buttons say they act on this page", undoButton()?.getAttribute("aria-label") === "Undo on this page" && redoButton()?.getAttribute("aria-label") === "Redo on this page", undoButton()?.getAttribute("aria-label") ?? "");
	add("their long-press help is the per-page one", undoButton()?.dataset.help === "help.undoPage" && redoButton()?.dataset.help === "help.redoPage");
	const y1 = await write(0, 160);
	const y3 = await write(2, 100);
	const y2 = await write(1, 160);
	await goTo(0);
	add("Undo is available on a page with steps", undoButton()?.disabled === false);
	v.undo();
	await frames(3);
	add("Undo on page 1 takes back page 1's newest step although two other pages were written on since", !p1.strokes.includes(y1) && p1.strokes.includes(x1) && p2.strokes.includes(y2) && p3.strokes.includes(y3), `p1 ${p1.strokes.length} p2 ${p2.strokes.length} p3 ${p3.strokes.length}`);
	add("Redo is available on that page", redoButton()?.disabled === false);
	await goTo(1);
	v.undo();
	await frames(3);
	add("on page 2 Undo takes back page 2's own newest step, page 1 keeps its undone state", !p2.strokes.includes(y2) && p2.strokes.includes(x2) && !p1.strokes.includes(y1) && p3.strokes.includes(y3));
	await goTo(0);
	v.redo();
	await frames(3);
	add("Redo on page 1 brings back page 1's step only", p1.strokes.includes(y1) && !p2.strokes.includes(y2) && p3.strokes.includes(y3));
	await write(2, 160);
	add("a new edit on page 3 keeps the step page 2 undid", (doc().pages[1]?.strokes.length ?? 0) === 1);
	await goTo(1);
	v.redo();
	await frames(3);
	add("so Redo on page 2 still brings it back", p2.strokes.includes(y2));

	// --- a step that touched two pages ---
	const moved = createStroke("#1e1e1e", 2, y1.points.map(([x, y, pr]) => quantizePoint(x, y + 40, pr)));
	v.applyCommand(new Batch("Move selection to page", [new ReplaceStroke(p1.id, y1, [], p1.strokes.indexOf(y1)), new AddStroke(p2.id, moved, p2.strokes.length, false)]));
	await frames(3);
	const before = p1.strokes.length + p2.strokes.length;
	const noticesBefore = api.notices.length;
	await goTo(0);
	v.undo();
	await frames(3);
	add("a step that touched two pages is not undone from page 1", p1.strokes.length + p2.strokes.length === before && p2.strokes.includes(moved));
	add("one notice says why and where to go", api.notices.length === noticesBefore + 1 && /other pages or the whole notebook/.test(api.notices[api.notices.length - 1] ?? ""), api.notices[api.notices.length - 1] ?? "");
	await goTo(1);
	v.undo();
	await frames(3);
	add("nor from page 2", p2.strokes.includes(moved));

	// --- the history panel ---
	v.runAction("history-panel");
	await show();
	add("the panel says per-page undo is on", /Per-page undo is on/.test(q(".nb-hist-modal .nb-modal-note")?.textContent ?? ""));
	add("the steps of the page in view are marked, and the step of two pages is marked as the whole notebook", rows().some((r) => r.classList.contains("is-here")) && rows().some((r) => r.classList.contains("is-global")), rows().map((r) => r.className).join(" | "));
	add("the list is still the global one: one row is the current point", rows().filter((r) => r.classList.contains("is-current")).length === 1);
	add("every row keeps a tap target of at least 44 px", rows().every((r) => r.getBoundingClientRect().height >= 44));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
