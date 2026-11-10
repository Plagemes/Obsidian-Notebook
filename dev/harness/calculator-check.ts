/**
 * Smoke check of the advanced calculator (0.29, roadmap #182) on the `doc=calculator` notebook (the blank "New" notebook;
 * HARNESS_DOC=calculator npm run harness:check): the real view and History. The dialog opens from the action; the on-screen keys build an
 * expression and "=" shows the exact answer (a fraction with its decimal, a unit conversion, a matrix grid); a bad expression says why in the
 * dialog; variables and the tape persist for the notebook on this device; "Insert as text" and "Insert as formula" add one element each as one
 * undo step; "Draw as graph" adds a graph of f(x); a locked page refuses; nothing scrolls sideways. `calculatorShot` leaves the dialog showing
 * for the screenshots.
 */
import { SetPageLocked } from "../../src/model/page-lock";
import type { GraphElement, Page, PageElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface CalculatorCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface CalcView extends HarnessView {
	app: { loadLocalStorage(key: string): unknown; saveLocalStorage(key: string, data: unknown): void };
	selection: { elements: PageElement[] } | null;
}

const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-calc-modal");
const input = (): HTMLInputElement | null => modal()?.querySelector<HTMLInputElement>(".nb-calc-input") ?? null;
const answer = (): string => modal()?.querySelector<HTMLElement>(".nb-calc-answer")?.textContent ?? "";
const result = (): string => modal()?.querySelector<HTMLElement>(".nb-calc-result")?.textContent ?? "";
const keyButton = (label: string): HTMLButtonElement | null => [...(modal()?.querySelectorAll<HTMLButtonElement>(".nb-calc-pad .nb-calc-key") ?? [])].find((b) => b.textContent === label) ?? null;
const actionButton = (label: RegExp): HTMLButtonElement | null => [...(modal()?.querySelectorAll<HTMLButtonElement>(".nb-calc-actions button") ?? [])].find((b) => label.test(b.textContent ?? "")) ?? null;

async function type(api: CalculatorCheckApi, text: string, commit = true): Promise<void> {
	const el = input();
	if (!el) return;
	el.value = text;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	if (commit) keyButton("=")?.click();
	await api.frames(2);
}

function closeDialog(): void {
	modal()?.querySelector<HTMLElement>(".nb-modal-close")?.click();
}

export async function checkCalculator(api: CalculatorCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as CalcView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const count = (): number => page().elements?.length ?? 0;

	v.runAction("calculator");
	await api.frames(4);
	add("the calculator opens from its action", !!modal());
	add("it shows the keys, the tape area and the prefs", !!keyButton("7") && !!modal()?.querySelector(".nb-calc-tape") && !!modal()?.querySelector(".nb-calc-prefs"));

	// --- the keys build an expression, "=" works it out ---
	for (const k of ["1", "÷", "3", "+", "1", "÷", "6"]) keyButton(k)?.click();
	await api.frames(2);
	add("the keys write the expression", input()?.value === "1/3+1/6", input()?.value ?? "");
	add("a preview shows while typing", result().startsWith("= "), result());
	keyButton("=")?.click();
	await api.frames(2);
	add("= shows the exact fraction", result() === "= 1/2", result());
	add("the decimal sits beside the fraction", (modal()?.querySelector(".nb-calc-approx")?.textContent ?? "").includes("0.5"));
	add("the line is on the tape", (modal()?.querySelectorAll(".nb-calc-taperow").length ?? 0) === 1);

	// --- units, an error, a matrix ---
	await type(api, "3 km/h to m/s");
	add("a unit conversion", result() === "= 0.833333333333 m/s", result());
	await type(api, "3 m + 2 s");
	add("a mismatch says why, in the dialog", !!modal()?.querySelector(".nb-calc-error") && /units do not match/.test(answer()), answer());
	await type(api, "inv([1, 2; 3, 4])");
	add("a matrix is a grid", (modal()?.querySelectorAll(".nb-calc-grid td").length ?? 0) === 4, answer());

	// --- variables persist for the notebook on this device ---
	await type(api, "a = 3.2");
	await type(api, "f(x) = a * x");
	add("the variable and the function are listed", (modal()?.querySelectorAll(".nb-calc-varchip").length ?? 0) === 2);
	closeDialog();
	await api.frames(3);
	v.runAction("calculator");
	await api.frames(4);
	await type(api, "a * 2");
	add("a variable is still there after the dialog is reopened", result() === "= 6.4", result());
	await type(api, "f(5)");
	add("so is a function", result() === "= 16", result());
	add("the tape is kept too", (modal()?.querySelectorAll(".nb-calc-taperow").length ?? 0) >= 6);

	// --- onto the page ---
	await type(api, "sin(30)");
	const before = count();
	actionButton(/as text/i)?.click();
	await api.frames(4);
	const added = page().elements?.[count() - 1];
	add("Insert as text adds one text box with the expression and answer", count() === before + 1 && added?.type === "text" && added.text === "sin(30) = 0.5", JSON.stringify(added));
	v.undo();
	await api.frames(3);
	add("one undo takes it away", count() === before);

	actionButton(/as formula/i)?.click();
	await api.frames(8);
	const eq = page().elements?.[count() - 1];
	add("Insert as formula adds one element", count() === before + 1 && (eq?.type === "equation" || eq?.type === "text"), eq?.type ?? "none");
	if (eq?.type === "equation") add("the formula carries the expression and its answer", /\\sin\\left\(30\\right\) = 0\.5/.test(eq.latex), eq.latex);
	v.undo();
	await api.frames(3);

	await type(api, "f(x) = x^2 - 3");
	const graphBtn = actionButton(/graph/i);
	add("a function of x offers the graph", !!graphBtn && !graphBtn.disabled);
	graphBtn?.click();
	await api.frames(4);
	const g = page().elements?.[count() - 1] as GraphElement | undefined;
	add("Draw as graph adds a graph of it", g?.type === "graph" && g.functions[0]?.expr === "x^2 - 3", JSON.stringify(g?.functions));
	v.undo();
	await api.frames(3);
	await type(api, "2 + 2");
	add("a plain sum offers no graph", !!actionButton(/graph/i)?.disabled);

	// --- a locked page refuses ---
	v.applyCommand(new SetPageLocked(page().id, true));
	await api.frames(2);
	const lockedCount = count();
	actionButton(/as text/i)?.click();
	await api.frames(3);
	add("a locked page refuses the result", count() === lockedCount);
	v.undo();
	await api.frames(2);
	add("the page is unlocked again", page().locked !== true);

	// --- preferences ---
	await type(api, "1/3");
	modal()?.querySelectorAll<HTMLButtonElement>(".nb-calc-pref")[2]?.querySelectorAll<HTMLButtonElement>(".nb-calc-segbtn")[1]?.click();
	await api.frames(2);
	add("Decimal shows a decimal", /0\.3333/.test(result()) && !result().includes("1/3"), result());
	const dialog = modal();
	add("the dialog has no sideways scroll", !!dialog && dialog.scrollWidth <= dialog.clientWidth + 1, `${dialog?.scrollWidth} vs ${dialog?.clientWidth}`);
	closeDialog();
	await api.frames(2);
	add("closing leaves the page as it was", !modal() && count() === before);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { elements: count() } };
}

export type CalculatorState = "fraction" | "units" | "matrix" | "error";

/** Leaves the dialog open on one of four answers, for the screenshots. */
export async function calculatorShot(api: CalculatorCheckApi, state: CalculatorState): Promise<void> {
	closeDialog();
	await api.frames(2);
	(api.view as CalcView).runAction("calculator");
	await api.frames(4);
	const expr: Record<CalculatorState, string> = {
		fraction: "1/3 + 1/6",
		units: "3 km/h to m/s",
		matrix: "inv([1, 2; 3, 4])",
		error: "3 m + 2 s",
	};
	if (state !== "fraction") await type(api, "1/3 + 1/6");
	await type(api, expr[state]);
	await api.frames(3);
}
