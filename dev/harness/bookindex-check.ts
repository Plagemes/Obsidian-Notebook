/**
 * 0.21 bookindex (roadmap #187): the back-of-book index on the `doc=bookindex` scenario (npm run harness:check). Checked: the index dialog
 * lists the terms A-Z with sub-terms and a page chip each, the filter narrows the list, a chip jumps to its page and closes the dialog,
 * "Write to note" makes the note next to the notebook, a second run rewrites only the generated region (text around it stays byte for
 * byte), an unpaired marker and a foreign note are left untouched, and the "Add to index…" dialog suggests terms already in use and
 * hands back the prefixed label. The dialog is left open for the screenshot.
 */
import { BookIndexModal, AddToIndexModal, indexNotePath, writeIndexNote, type BookIndexHost } from "../../src/view/book-index";
import { createPage } from "../../src/model/document";
import { createMarker } from "../../src/model/markers";
import { INDEX_END, INDEX_START, indexOwnerOf } from "../../src/model/book-index";

/** The start marker without its closing, which the generated one carries a notebook path in (review W21 D8). */
const START_OPEN = INDEX_START.slice(0, INDEX_START.indexOf(" -->"));
import { t } from "../../src/i18n";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface BookIndexCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkBookIndex(api: BookIndexCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const vault = app.vault;
	const notebook = await vault.create("Notebooks/Biology.notebook", "{}");

	const mk = (text: string, y: number) => createMarker("star", 80, y, { text, region: { x: 60, y, width: 120, height: 24 } });
	const pages = [createPage({ width: 595, height: 842 }), createPage({ width: 595, height: 842 }), createPage({ width: 595, height: 842 }), createPage({ width: 595, height: 842 })];
	pages[0]!.elements = [mk("#idx Cell / Nucleus", 200), mk("#idx Cell", 120), createMarker("question", 50, 50, { text: "not an index term" })];
	pages[1]!.elements = [mk("#idx Photosynthesis", 100), mk("#idx Enzyme", 300)];
	pages[2]!.elements = [mk("#idx Cell / Membrane", 90), mk("#idx Élan vital", 400), mk("#idx 3D structure", 500)];
	pages[3]!.elements = [mk("#idx photosynthesis", 80)];
	const jumps: Array<[number, number]> = [];
	const host: BookIndexHost = { app: app as never, file: notebook as never, docId: "bio-doc", prefix: "#idx", pages: () => pages, goTo: (i, y) => jumps.push([i, y]) };

	// 1. The dialog.
	const dialog = new BookIndexModal(host);
	dialog.open();
	await sleep(60);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.notebook-bookindex-modal ${sel}`));
	add("the dialog lists a section per first letter, '#' first", q(".nb-bookindex-letter").map((e) => e.textContent).join("") === "#CEP", q(".nb-bookindex-letter").map((e) => e.textContent).join("|"));
	add("terms are merged and sub-terms nested (Cell > Membrane, Nucleus)", q(".nb-bookindex-name").map((e) => e.textContent).join("|") === "3D structure|Cell|Membrane|Nucleus|Élan vital|Enzyme|Photosynthesis", q(".nb-bookindex-name").map((e) => e.textContent).join("|"));
	add("a duplicate on two pages gets two chips", q(".nb-bookindex-term").filter((e) => e.textContent?.startsWith("Photosynthesis")).every((e) => e.querySelectorAll(".nb-bookindex-ref").length === 2));
	add("the summary counts terms and pages", q(".nb-modal-note").some((e) => e.textContent === t("bookindex.summary", { terms: "7", pages: "4" })), q(".nb-modal-note").map((e) => e.textContent).join("|"));
	const filter = document.querySelector<HTMLInputElement>("#nb-bookindex-filter");
	if (filter) {
		filter.value = "nucl";
		filter.dispatchEvent(new Event("input"));
	}
	add("the filter keeps the term and its parent", q(".nb-bookindex-name").map((e) => e.textContent).join("|") === "Cell|Nucleus", q(".nb-bookindex-name").map((e) => e.textContent).join("|"));
	if (filter) {
		filter.value = "";
		filter.dispatchEvent(new Event("input"));
	}
	const chips = q(".nb-bookindex-ref");
	add("every chip is a 36 px target", chips.length > 0 && chips.every((c) => c.getBoundingClientRect().height >= 36 - 1), String(chips.length));

	// 2. The note.
	const notePath = indexNotePath(notebook as never);
	add("the note is named after the notebook, next to it", notePath === "Notebooks/Biology — Index.md", notePath);
	const written = await writeIndexNote(host);
	const file = vault.getFileByPath(notePath);
	const text1 = file ? await vault.read(file) : "";
	add("'Write to note' makes the note with the generated region", written === notePath && text1.includes(START_OPEN) && indexOwnerOf(text1) === (notebook as unknown as { path: string }).path && text1.includes(INDEX_END) && text1.includes("### C") && text1.includes("Nucleus"), text1.slice(0, 120));
	if (file) await vault.modify(file, `My preface\n\n${text1.trimEnd()}\n\nMy afterword`);
	pages[0]!.elements = [...(pages[0]!.elements ?? []), mk("#idx Zygote", 600)];
	await writeIndexNote(host);
	const text2 = file ? await vault.read(file) : "";
	add("a second run rewrites only the region", text2.startsWith("My preface\n\n") && text2.endsWith("\n\nMy afterword") && text2.includes("Zygote") && text2.split(START_OPEN).length === 2, text2.slice(-80));
	if (file) await vault.modify(file, `Only mine ${INDEX_START} broken`);
	const before = api.notices.length;
	const unsafe = await writeIndexNote(host);
	add("an unpaired marker is left untouched, with a notice", unsafe === null && (file ? await vault.read(file) : "") === `Only mine ${INDEX_START} broken` && api.notices.length > before);
	if (file) await vault.modify(file, "A note of mine without markers");
	const foreign = await writeIndexNote(host);
	add("a foreign note with that name is never changed", foreign === null && (file ? await vault.read(file) : "") === "A note of mine without markers");
	// A note that records another notebook is never rewritten: this notebook's index goes to the "(2)" note.
	const otherText = `# Other\n\n<!-- notebook-index:start for=School%2FOther.notebook id=other-doc -->\n\nOther index\n\n${INDEX_END}\n`;
	if (file) await vault.modify(file, otherText);
	const second = await writeIndexNote(host);
	const secondFile = second ? vault.getFileByPath(second) : null;
	add("another notebook's index note is never rewritten", (file ? await vault.read(file) : "") === otherText && second === "Notebooks/Biology — Index (2).md" && !!secondFile && indexOwnerOf(await vault.read(secondFile)) === (notebook as unknown as { path: string }).path, String(second));
	// Review W21 N1: a note that records this notebook's document id under an old path (the notebook was renamed or moved) is rewritten in place.
	const movedText = `# Moved\n\n<!-- notebook-index:start for=Old%2FBiology.notebook id=bio-doc -->\n\nStale index\n\n${INDEX_END}\n`;
	if (file) await vault.modify(file, movedText);
	const third = await writeIndexNote(host);
	add("a note recording this notebook's id is rewritten in place after a rename", third === "Notebooks/Biology — Index.md" && !!file && (await vault.read(file)).includes("# Moved") && !(await vault.read(file)).includes("Stale index"), String(third));

	// 3. A chip jumps and closes.
	chips[0]?.click();
	await sleep(40);
	add("a chip goes to its page and closes the dialog", jumps.length === 1 && q(".nb-bookindex-ref").length === 0, JSON.stringify(jumps));

	// 4. Add to index.
	let label = "";
	const add1 = new AddToIndexModal(app as never, "#idx", ["Cell", "Cell / Nucleus", "Enzyme"], (l) => (label = l));
	add1.open();
	await sleep(60);
	const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.notebook-bookindex-add ${sel}`));
	add("the add dialog suggests the terms in use", qa(".nb-bookindex-suggestion").length === 3);
	const input = document.querySelector<HTMLInputElement>("#nb-bookindex-term");
	if (input) {
		input.value = "cel";
		input.dispatchEvent(new Event("input"));
	}
	add("typing narrows the suggestions", qa(".nb-bookindex-suggestion").length === 2);
	qa(".nb-bookindex-suggestion")[1]?.click();
	add("a suggestion fills the field", input?.value === "Cell / Nucleus");
	const addButtons = qa(".nb-modal-btn");
	addButtons[addButtons.length - 1]?.click();
	await sleep(40);
	add("Add hands back the prefixed label", label === "#idx Cell / Nucleus", label);
	api.errors.splice(0, api.errors.length);

	// 5. Leave the index dialog open for the screenshot.
	const shot = new BookIndexModal(host);
	shot.open();
	await sleep(80);
	const box = document.querySelector<HTMLElement>(".notebook-bookindex-modal");
	add("the dialog fits the screen", !!box && box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= window.innerWidth + 1);
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await sleep(40);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
