/**
 * 0.28 boxnum (roadmap #205): numbered structured boxes and the index of definitions and theorems on the `doc=boxnum` scenario
 * (HARNESS_DOC=boxnum npm run harness:check). Checked: the labels are derived ("Def. 1", "Thm. 1", proofs unnumbered, one counter on
 * request, none when numbering is off), the dialog lists the boxes in reading order with a jump each, "Write index note" writes
 * "<Notebook> — Definitions.md" between the owner markers, a rebuild rewrites only that region, and a note of the user's is left
 * untouched. The dialog is left open for the screenshot (tablet and phone, dark and light).
 */
import { BoxIndexModal, boxesNotePath, writeBoxesNote, type BoxIndexHost } from "../../src/view/box-index";
import { BoxNumbers } from "../../src/view/box-numbers";
import { HeadingIndex } from "../../src/model/heading-index";
import { BOXES_START, numberBoxes } from "../../src/model/box-numbering";
import { createPage } from "../../src/model/document";
import type { BoxElement, BoxKind } from "../../src/model/types";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

const START_OPEN = BOXES_START.slice(0, BOXES_START.indexOf(" -->"));

export interface BoxnumCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkBoxnum(api: BoxnumCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const vault = app.vault;
	const notebook = await vault.create("Notebooks/Analysis.notebook", "{}");
	let id = 0;
	const box = (kind: BoxKind, x: number, y: number, title?: string): BoxElement => ({ id: `bx${++id}`, type: "box", kind, x, y, width: 300, height: 90, ...(title ? { title } : {}) });
	const pages = [createPage({ width: 600, height: 800 }), createPage({ width: 600, height: 800 }), createPage({ width: 600, height: 800 })];
	pages[0]!.elements = [box("theorem", 60, 400, "Bolzano"), box("definition", 60, 100, "Limit"), box("proof", 60, 520)];
	pages[1]!.elements = [box("example", 60, 120), box("definition", 60, 400, "Continuity")];
	pages[2]!.elements = [box("remark", 60, 100)];
	const settings = { ...DEFAULT_SETTINGS };
	const numbers = new BoxNumbers({ pages: () => pages, settings: () => settings, headingIndex: () => new HeadingIndex(), tick: () => 0, redraw: () => undefined });
	const labels = () => pages.flatMap((p) => (p.elements ?? []).flatMap((e) => (e.type === "box" ? [numbers.label(e)] : [])));
	add("labels are numbered per kind, proofs are not", labels().join("|") === "Thm. 1 · Bolzano|Def. 1 · Limit|Proof|Ex. 1|Def. 2 · Continuity|Rem. 1", labels().join("|"));
	settings.boxNumberShared = true;
	add("one shared counter on request", numbers.label(pages[1]!.elements[1] as BoxElement) === "Def. 4 · Continuity", numbers.label(pages[1]!.elements[1] as BoxElement));
	settings.boxNumberShared = false;
	settings.boxNumbering = false;
	add("numbering off gives the plain kind names", labels().join("|") === "Theorem · Bolzano|Definition · Limit|Proof|Example|Definition · Continuity|Remark", labels().join("|"));
	settings.boxNumbering = true;
	const moved = pages[1]!.elements[1] as BoxElement;
	pages[1]!.elements = [{ ...moved, y: 20 }, pages[1]!.elements[0] as BoxElement];
	add("moving a box renumbers", numbers.label(pages[1]!.elements[0] as BoxElement) === "Def. 2 · Continuity");
	const items = () => numberBoxes(pages, [], { chapter: false, shared: false });
	const jumps: Array<[number, number]> = [];
	const host: BoxIndexHost = { app: app as never, file: notebook as never, docId: "an-doc", items, goTo: (i, y) => jumps.push([i, y]) };
	const dialog = new BoxIndexModal(host, true);
	dialog.open();
	await sleep(60);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.notebook-boxindex-modal ${sel}`));
	add("the dialog lists every numbered box in reading order", q(".nb-boxindex-label").map((e) => e.textContent).join("|") === "Def. 1|Thm. 1|Def. 2|Ex. 1|Rem. 1", q(".nb-boxindex-label").map((e) => e.textContent).join("|"));
	add("every row is a 44 px target", q(".nb-boxindex-row").every((r) => r.getBoundingClientRect().height >= 43));
	q(".nb-boxindex-row")[1]?.click();
	await sleep(40);
	add("a row jumps to its page and closes the dialog", jumps.length === 1 && jumps[0]![0] === 0 && q(".nb-boxindex-row").length === 0, JSON.stringify(jumps));

	const notePath = boxesNotePath(notebook as never);
	const written = await writeBoxesNote(host);
	const file = vault.getFileByPath(notePath);
	const text1 = file ? await vault.read(file) : "";
	add("'Write index note' writes the owner-marked region", written === notePath && text1.includes(START_OPEN) && text1.includes("**Def. 1**") && text1.includes("**Thm. 1**"), text1.slice(0, 160));
	if (file) await vault.modify(file, `Preface\n\n${text1.trimEnd()}\n\nAfterword`);
	pages[2]!.elements = [box("remark", 60, 100), box("remark", 60, 300)];
	await writeBoxesNote(host);
	const text2 = file ? await vault.read(file) : "";
	add("a rebuild rewrites only the region", text2.startsWith("Preface\n\n") && text2.endsWith("\n\nAfterword") && text2.includes("**Rem. 2**") && text2.split(START_OPEN).length === 2);
	if (file) await vault.modify(file, "A note of mine without markers");
	const foreign = await writeBoxesNote(host);
	add("a note without markers is never changed", foreign === "Notebooks/Analysis — Definitions (2).md" && (await vault.read(file as never)) === "A note of mine without markers", String(foreign));
	api.errors.splice(0, api.errors.length);

	const shot = new BoxIndexModal(host, true);
	shot.open();
	await sleep(80);
	const modal = document.querySelector<HTMLElement>(".notebook-boxindex-modal");
	add("the dialog fits the screen", !!modal && modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= window.innerWidth + 1);
	if (modal && !modal.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(modal);
	await sleep(40);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
