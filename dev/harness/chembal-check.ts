/**
 * Smoke check of "Balance reaction" (0.23, roadmap #294) on the `doc=chembal` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen events. Two typed reactions and a note are on the page; a lasso over the reactions
 * offers the action in the selection bar (not for the note alone); the preview shows each line before and after and a reason for a
 * reaction that cannot be balanced; Cancel changes nothing, Balance replaces the text in one undo step. It leaves the preview open on a
 * page with one balanceable reaction, one impossible and one ambiguous line for the screenshot.
 */
import { AddElement } from "../../src/model/history";
import type { Page, PageElement, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ChembalCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ChembalView extends HarnessView {
	selection: { elements: PageElement[] } | null;
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { selection?: { reactions?: number } | null } : never;
}

export async function checkChembal(api: ChembalCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as ChembalView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const around = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [frac(x0, y0), frac(x1, y0), frac(x1, y1), frac(x0, y1), frac(x0, y0 + 2)];
	const text = (id: string, y: number, t: string): TextElement => ({ id, type: "text", x: 60, y, width: 380, text: t, fontSize: 18, color: "#1f2937" });
	const texts = (): TextElement[] => (page().elements ?? []).filter((e): e is TextElement => e.type === "text");
	const byId = (id: string): string => texts().find((e) => e.id === id)?.text ?? "";
	const modal = (): HTMLElement | null => q<HTMLElement>(".nb-chem-modal");
	const buttons = (): HTMLButtonElement[] => [...(modal()?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button") ?? [])];

	v.applyCommand(new AddElement(page().id, text("chem-a", 80, "CH4 + O2 -> CO2 + H2O"), 0));
	v.applyCommand(new AddElement(page().id, text("chem-b", 130, "MnO4^- + Fe^2+ + H^+ -> Mn^2+ + Fe^3+ + H2O"), 1));
	v.applyCommand(new AddElement(page().id, text("chem-note", 260, "Remember to add the catalyst"), 2));
	await frames(3);

	// --- the note alone is not a reaction ---
	setTool("lasso");
	await penStroke(around(40, 240, 460, 300));
	await frames(3);
	add("the note alone is selected", v.selection?.elements.length === 1);
	add("no Balance reaction for a plain note", (v.uiContext().selection?.reactions ?? 0) === 0);
	v.clearSelection();
	await frames(2);

	// --- the two reactions ---
	await penStroke(around(40, 60, 460, 180));
	await frames(3);
	add("a lasso over the reactions selects two boxes", v.selection?.elements.length === 2, String(v.selection?.elements.length));
	add("the bar counts two reactions", v.uiContext().selection?.reactions === 2);
	v.runAction("chem-balance");
	await frames(3);
	add("the preview opens", !!modal());
	const after = [...(modal()?.querySelectorAll(".nb-chem-after") ?? [])].map((e) => e.textContent);
	add("the first reaction shows its balanced line", after.includes("CH4 + 2 O2 -> CO2 + 2 H2O"), JSON.stringify(after));
	add("the redox reaction shows its balanced line", after.includes("MnO4^- + 5 Fe^2+ + 8 H^+ -> Mn^2+ + 5 Fe^3+ + 4 H2O"), JSON.stringify(after));
	add("nothing changed yet", byId("chem-a") === "CH4 + O2 -> CO2 + H2O");
	buttons()[0]?.click();
	await frames(3);
	add("Cancel closes it and changes nothing", !modal() && byId("chem-a") === "CH4 + O2 -> CO2 + H2O");

	v.runAction("chem-balance");
	await frames(3);
	const primary = buttons().find((b) => !b.disabled && b.classList.contains("is-primary")) ?? buttons()[1];
	primary?.click();
	await frames(3);
	add("Balance replaces both texts", byId("chem-a") === "CH4 + 2 O2 -> CO2 + 2 H2O" && byId("chem-b").startsWith("MnO4^- + 5 Fe^2+"), byId("chem-a"));
	v.undo();
	await frames(2);
	add("one undo gives both texts back", byId("chem-a") === "CH4 + O2 -> CO2 + H2O" && byId("chem-b") === "MnO4^- + Fe^2+ + H^+ -> Mn^2+ + Fe^3+ + H2O");
	v.redo();
	await frames(2);
	add("one redo balances them again", byId("chem-a") === "CH4 + 2 O2 -> CO2 + 2 H2O");
	v.undo();
	await frames(2);
	v.clearSelection();

	// --- a box with lines that cannot be balanced, for the screenshot ---
	v.applyCommand(new AddElement(page().id, text("chem-mixed", 330, "N2 + H2 -> NH3\nNaCl -> Na\nH2 + O2 + H2O2 -> H2O\nH2 + Xx -> H2O"), 3));
	await frames(3);
	await penStroke(around(40, 310, 460, 440));
	await frames(3);
	add("the mixed box is selected", v.selection?.elements.length === 1 && v.uiContext().selection?.reactions === 1);
	v.runAction("chem-balance");
	await frames(3);
	const problems = [...(modal()?.querySelectorAll(".nb-chem-problem") ?? [])].map((e) => e.textContent ?? "");
	add("each impossible line says why", problems.length === 3 && problems.some((p) => /Cl/.test(p)) && problems.some((p) => /independent/.test(p)) && problems.some((p) => /Xx/.test(p)), JSON.stringify(problems));
	const row = modal()?.querySelector<HTMLElement>(".nb-chem-row");
	add("the dialog has no sideways scroll", !!row && modal()!.scrollWidth <= modal()!.clientWidth + 1);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { texts: texts().length, problems: problems.length } };
}
