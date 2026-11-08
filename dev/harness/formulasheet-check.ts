/**
 * 0.23 formulasheet (roadmap #249): the formula sheet on the `doc=formulasheet` scenario (npm run harness:check). Checked: the dialog lists
 * the equations in reading order with a page chip each, "Build formula sheet" writes "<Notebook> — Formulas.md" next to the notebook with
 * `$$` blocks and page links, a second run rewrites only the generated region, an unpaired marker, a note without markers and another
 * notebook's sheet are left untouched (the sheet goes to " (2)"), and the notice of the result is shown. The dialog is left open for the screenshot.
 */
import { FormulaSheetModal, formulaNotePath, writeFormulaNote, type FormulaSheetHost } from "../../src/view/formula-sheet";
import { createPage } from "../../src/model/document";
import { FORMULA_END, FORMULA_START, formulaRegionOf } from "../../src/model/formula-sheet";
import type { EquationElement } from "../../src/model/types";
import { t } from "../../src/i18n";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

const START_OPEN = FORMULA_START.slice(0, FORMULA_START.indexOf(" -->"));

export interface FormulaSheetCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkFormulaSheet(api: FormulaSheetCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const vault = app.vault;
	const notebook = await vault.create("Notebooks/Physics.notebook", "{}");
	let id = 0;
	const eq = (latex: string, x: number, y: number, numbered = false): EquationElement => ({ id: `eq${++id}`, type: "equation", x, y, width: 160, height: 40, latex, fontSize: 18, color: "#1c1c1c", ...(numbered ? { numbered: true as const } : {}) });
	const pages = [createPage({ width: 600, height: 800 }), createPage({ width: 600, height: 800 }), createPage({ width: 600, height: 800 })];
	pages[0]!.elements = [eq("F = m a", 80, 300), eq("E = m c^2", 80, 100, true)];
	pages[2]!.elements = [eq("\\int_0^1 x^2\\,dx = \\tfrac{1}{3}", 80, 120), eq("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}", 80, 260)];
	const jumps: Array<[number, number]> = [];
	const host: FormulaSheetHost = { app: app as never, file: notebook as never, docId: "phys-doc", pages: () => pages, goTo: (i, y) => jumps.push([i, y]) };
	const read = async (f: unknown) => (f ? vault.read(f as never) : "");

	const dialog = new FormulaSheetModal(host);
	dialog.open();
	await sleep(60);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.notebook-formulasheet-modal ${sel}`));
	add("the dialog lists the formulas in reading order", q(".nb-formulasheet-code").map((e) => e.textContent).join("|").startsWith("E = m c^2|F = m a|\\int"), q(".nb-formulasheet-code").map((e) => e.textContent).join("|"));
	add("a page chip per page with formulas (pages 1 and 3)", q(".nb-formulasheet-ref").map((e) => e.textContent).join(",") === "p. 1,p. 3");
	add("the summary counts formulas and pages", q(".nb-modal-note").some((e) => e.textContent === t("formulasheet.summary", { n: "4", pages: "2" })), q(".nb-modal-note").map((e) => e.textContent).join("|"));
	add("every chip is a 36 px target", q(".nb-formulasheet-ref").every((c) => c.getBoundingClientRect().height >= 35));
	q(".nb-formulasheet-ref")[1]?.click();
	await sleep(40);
	add("a chip goes to its page and closes the dialog", jumps.length === 1 && jumps[0]![0] === 2 && q(".nb-formulasheet-ref").length === 0, JSON.stringify(jumps));

	const notePath = formulaNotePath(notebook as never);
	add("the note is named after the notebook, next to it", notePath === "Notebooks/Physics — Formulas.md", notePath);
	const before = api.notices.length;
	const written = await writeFormulaNote(host);
	const file = vault.getFileByPath(notePath);
	const text1 = await read(file);
	add("'Build formula sheet' writes the region with $$ blocks and a notice", written === notePath && text1.includes(START_OPEN) && formulaRegionOf(text1)?.path === "Notebooks/Physics.notebook" && text1.includes("$$\nE = m c^2\n\\tag{1}\n$$") && api.notices.length > before, text1.slice(0, 160));
	add("the sheet links back to the pages", text1.includes("p. 3"));
	if (file) await vault.modify(file, `Preface\n\n${text1.trimEnd()}\n\nAfterword`);
	pages[1]!.elements = [eq("a^2 + b^2 = c^2", 80, 80)];
	await writeFormulaNote(host);
	const text2 = await read(file);
	add("a rebuild rewrites only the region", text2.startsWith("Preface\n\n") && text2.endsWith("\n\nAfterword") && text2.includes("a^2 + b^2 = c^2") && text2.split(START_OPEN).length === 2);
	if (file) await vault.modify(file, `Only mine ${FORMULA_START} broken`);
	const unsafe = await writeFormulaNote(host);
	add("an unpaired marker is left untouched and the sheet goes to the next free name", unsafe === "Notebooks/Physics — Formulas (2).md" && (await read(file)) === `Only mine ${FORMULA_START} broken`, String(unsafe));
	if (file) await vault.modify(file, "A note of mine without markers");
	const foreign = await writeFormulaNote(host);
	add("a note without markers is never changed and the sheet goes to the next free name", foreign === "Notebooks/Physics — Formulas (2).md" && (await read(file)) === "A note of mine without markers", String(foreign));
	const otherText = `# Other\n\n<!-- notebook-formulas:start for=School%2FOther.notebook id=other-doc -->\n\nOther\n\n${FORMULA_END}\n`;
	if (file) await vault.modify(file, otherText);
	const second = await writeFormulaNote(host);
	add("another notebook's sheet is never rewritten", (await read(file)) === otherText && second === "Notebooks/Physics — Formulas (2).md", String(second));
	api.errors.splice(0, api.errors.length);

	const shot = new FormulaSheetModal(host);
	shot.open();
	await sleep(80);
	const box = document.querySelector<HTMLElement>(".notebook-formulasheet-modal");
	add("the dialog fits the screen", !!box && box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= window.innerWidth + 1);
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await sleep(40);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
