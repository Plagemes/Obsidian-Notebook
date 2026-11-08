/**
 * Smoke check of the action history panel (0.25, roadmap #84) on the `doc=histpanel` notebook (the blank "New" notebook; npm run
 * harness:check): the real view. A few steps are made on three pages (strokes, a text box, a moved selection, an erase); "Action
 * history" lists them newest first with the current point marked; a tap on an older step goes back to the point just after it (each
 * step an ordinary Undo, the undone ones listed dimmed above); a tap on an undone step goes forward again; "Start of the history"
 * undoes everything; a page locked in the meantime stops the jump half way and says so; a read-only notebook shows the list but cannot
 * jump. The final state (the list open, some steps undone) is left for the screenshot.
 */
import { createStroke, quantizePoint } from "../../src/model/document";
import { AddElement, AddStroke, Batch, EraseStrokes, ReplaceStroke } from "../../src/model/history";
import type { NotebookDocument, PageElement, Point } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface HistpanelCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkHistpanel(api: HistpanelCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const doc = (): NotebookDocument => v.document;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const modal = (): HTMLElement | null => q<HTMLElement>(".nb-hist-modal");
	const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-hist-modal .nb-hist-row"));
	const titles = (): string[] => rows().map((r) => r.querySelector(".nb-hist-row-title")?.textContent ?? "");
	const tap = async (row: HTMLElement | undefined): Promise<void> => {
		row?.querySelector<HTMLButtonElement>(".nb-hist-row-btn")?.click();
		await frames(4);
		await show();
	};
	/** The harness stands in for Obsidian's modal container: the dialog is moved in so the screenshot shows it. */
	const show = async (): Promise<void> => {
		await frames(3);
		const m = modal()?.closest(".modal") as HTMLElement | null;
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
		await frames(2);
	};
	const closeDialog = async (): Promise<void> => {
		q<HTMLButtonElement>(".nb-hist-modal .nb-modal-foot button")?.click();
		document.querySelectorAll(".harness-modal-container").forEach((el) => el.remove());
		await frames(2);
	};
	const scribble = (y: number): ReturnType<typeof createStroke> => {
		const pts: Point[] = [];
		for (let i = 0; i <= 8; i++) pts.push(quantizePoint(60 + i * 20, y + Math.sin(i) * 6, 0.5));
		return createStroke("#1e1e1e", 2, pts);
	};

	// --- a notebook of three pages and a few steps ---
	while (doc().pages.length < 3) v.addPage();
	await frames(3);
	const [p1, p2, p3] = doc().pages as [NotebookDocument["pages"][number], NotebookDocument["pages"][number], NotebookDocument["pages"][number]];
	const s1 = scribble(100);
	const s2 = scribble(160);
	const s3 = scribble(100);
	const note: PageElement = { id: "histpanel-note", type: "text", x: 80, y: 220, width: 220, text: "Proof of lemma 2", fontSize: 16, color: "#1e1e1e" };
	v.applyCommand(new AddStroke(p1.id, s1, p1.strokes.length));
	v.applyCommand(new AddStroke(p1.id, s2, p1.strokes.length));
	v.applyCommand(new AddElement(p2.id, note, p2.elements?.length ?? 0));
	v.applyCommand(new AddStroke(p3.id, s3, p3.strokes.length));
	const moved = createStroke("#1e1e1e", 2, s1.points.map(([x, y, p]) => quantizePoint(x + 40, y + 30, p)));
	v.applyCommand(new Batch("Transform selection", [new ReplaceStroke(p1.id, s1, [moved], p1.strokes.indexOf(s1))]));
	v.applyCommand(new EraseStrokes(p1.id, [{ stroke: s2, index: p1.strokes.indexOf(s2) }]));
	await frames(3);

	// --- the list ---
	v.runAction("history-panel");
	await show();
	const list = titles();
	add("the action is in the All actions registry and opens the panel", modal() !== null);
	add("every step is listed newest first, then the start of the history", list[0] === "Erased" && list[1] === "Selection moved or transformed" && list[list.length - 1] === "Start of the history" && list.length >= 7, list.join(" | "));
	add("exactly one row is marked as the current point, the newest step", rows().filter((r) => r.classList.contains("is-current")).length === 1 && rows()[0]!.classList.contains("is-current"));
	add("the current row says Now and cannot be tapped", rows()[0]!.querySelector(".nb-hist-now")?.textContent === "Now" && rows()[0]!.querySelector<HTMLButtonElement>(".nb-hist-row-btn")!.disabled);
	const detail = (i: number): string => rows()[i]?.querySelector(".nb-hist-row-detail")?.textContent ?? "";
	add("a row says the page and when", /p\. 1/.test(detail(0)) && /just now|min ago/.test(detail(0)), detail(0));
	add("an added text box names what it is and its page", titles().some((x) => x === "Added: text box") && detail(titles().indexOf("Added: text box")).startsWith("p. 2"), titles().join(" | "));
	add("every row has a tap target of at least 44 px", rows().every((r) => r.getBoundingClientRect().height >= 44), String(Math.min(...rows().map((r) => r.getBoundingClientRect().height))));
	add("the list does not scroll sideways", (q<HTMLElement>(".nb-hist-modal .nb-modal-body")?.scrollWidth ?? 0) <= (q<HTMLElement>(".nb-hist-modal .nb-modal-body")?.clientWidth ?? 0) + 1);

	// --- back to the point after the text box ---
	const strokesNow = (): number => p1.strokes.length + p3.strokes.length;
	const noteRow = rows()[titles().indexOf("Added: text box")]!;
	await tap(noteRow);
	add("a tap goes back to the point just after that step: the later steps are undone", p3.strokes.length === 0 && p1.strokes.length === 2 && (p2.elements ?? []).includes(note) === true && strokesNow() === 2, `p1 ${p1.strokes.length} p3 ${p3.strokes.length}`);
	add("the undone steps are listed dimmed above the current point", rows().filter((r) => r.classList.contains("is-undone")).length === 3 && rows()[3]!.classList.contains("is-current"), titles().join(" | "));
	add("the panel stays open and says how far it went", modal() !== null && api.notices.some((n) => n.includes("Went back 3 steps")), api.notices.slice(-1)[0] ?? "");

	// --- forward again, one step ---
	await tap(rows()[2]);
	add("a tap on an undone step goes forward to the point just after it", p3.strokes.length === 1 && p1.strokes.length === 2 && p1.strokes.includes(s1) === true, `p3 ${p3.strokes.length}`);
	add("the steps still undone stay listed above the current point", rows().filter((r) => r.classList.contains("is-undone")).length === 2 && rows()[2]!.classList.contains("is-current"), titles().join(" | "));

	// --- the start of the history ---
	await tap(rows()[rows().length - 1]);
	add("the start row undoes everything the history holds", strokesNow() === 0 && (p2.elements ?? []).length === 0 && rows()[rows().length - 1]!.classList.contains("is-current"), `strokes ${strokesNow()}`);
	add("every step is now an undone one", rows().filter((r) => r.classList.contains("is-undone")).length === rows().length - 1);

	// --- all the way forward, through the newest step ---
	await tap(rows()[0]);
	add("a tap on the furthest step brings everything back, exactly", p1.strokes.includes(moved) && !p1.strokes.includes(s2) && p3.strokes.includes(s3) && (p2.elements ?? []).includes(note));
	add("the newest step is the current point again", rows()[0]!.classList.contains("is-current") && rows().every((r) => !r.classList.contains("is-undone")));

	// --- a step the page lock refuses stops the jump half way ---
	p3.locked = true; // locked since (a change from elsewhere): the step that wrote on page 3 is refused when the jump reaches it
	await tap(rows()[rows().length - 1]);
	add("a locked page stops the jump where the step is refused, and the notice says so", api.notices.some((n) => /Stopped after 2 of \d+ steps/.test(n)), api.notices.slice(-1)[0] ?? "");
	add("the steps before it were undone, the rest is untouched", p3.strokes.length === 1 && p1.strokes.includes(s1) && p1.strokes.includes(s2) && (p2.elements ?? []).includes(note), `p3 ${p3.strokes.length}`);
	add("the panel is still there and lists the steps, the refused one still undoable", modal() !== null && rows().length > 2 && rows().filter((r) => r.classList.contains("is-undone")).length === 2);
	delete p3.locked;
	await closeDialog();

	// --- read-only: the list can be read, not used ---
	v.setReadOnlyMode(true, false);
	await frames(3);
	v.runAction("history-panel");
	await show();
	add("a read-only notebook lists the steps", rows().length > 2);
	add("but no row can be tapped, and it says why", rows().every((r) => r.querySelector<HTMLButtonElement>(".nb-hist-row-btn")!.disabled) && /read-only/.test(q(".nb-hist-modal .nb-modal-note")?.textContent ?? ""));
	await closeDialog();
	v.setReadOnlyMode(false, false);
	await frames(3);

	// --- the final state: the list open with some steps undone, for the screenshot ---
	v.undo();
	v.undo();
	await frames(3);
	v.runAction("history-panel");
	await show();
	add("the list is open with undone steps above the current point for the screenshot", modal() !== null && rows().some((r) => r.classList.contains("is-undone")) && rows().some((r) => r.classList.contains("is-current")), titles().join(" | "));
	await sleep(50);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
