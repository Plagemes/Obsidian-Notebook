/**
 * Smoke check of the coloured sections of a notebook (0.30, roadmap #52, format v28) on the `doc=sections` notebook (the blank "New"
 * notebook, grown to ten pages; HARNESS_DOC=sections npm run harness:check). Not to be confused with sections-check.ts (the 0.14 dynamic
 * sections of the library). The real view, page navigator, dialogs and History: "New section…" opens the edit dialog on the page in view
 * and Create adds one section (one undo step); the navigator shows the tab strip (the section in view current) and a divider before the
 * first page of each section; a tab jumps to its section; "Next section" / "Previous section" step between them; deleting the first page of
 * a section moves the section to the next page and undo puts both back; the Sections dialog lists them and a tap on a row goes there; rename
 * and recolour are one step each; nothing scrolls sideways. `nbSectionsShot` leaves the navigator with three sections, the Sections dialog or
 * the edit dialog showing for the screenshots.
 */
import { AddPage, DeletePage } from "../../src/model/history";
import { SetSections, sectionsOf } from "../../src/model/sections";
import type { NotebookDocument, Page, Section } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface NbSectionsCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export type NbSectionsShotState = "navigator" | "list" | "edit";

interface SectionsView {
	document: NotebookDocument;
	currentPage(): number;
	applyCommand(command: unknown): boolean | void;
	runAction(id: string): void;
	jumpToPage(index: number): void;
	setNavigatorOpen(open: boolean): void;
	undo(): void;
	redo(): void;
}

const PAGES = 10;
const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const qa = <T extends Element>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));
const editModal = (): HTMLElement | null => q<HTMLElement>(".nb-sections-edit");
const listModal = (): HTMLElement | null => q<HTMLElement>(".nb-sections-modal");
const tabs = (): HTMLElement[] => qa<HTMLElement>(".nb-sections-strip .nb-sections-tab");
const dividers = (): HTMLElement[] => qa<HTMLElement>(".notebook-navigator-list .nb-sections-divider");

/** The harness stands in for Obsidian's modal container: the dialog is moved in so the screenshot shows it. */
async function show(api: NbSectionsCheckApi, el: HTMLElement | null): Promise<void> {
	await api.frames(2);
	const m = el?.closest(".modal") as HTMLElement | null;
	if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
	await api.frames(2);
}

function closeDialogs(): void {
	for (const m of [editModal(), listModal()]) m?.querySelector<HTMLButtonElement>(".nb-modal-foot button")?.click();
	document.querySelectorAll(".harness-modal-container").forEach((el) => el.remove());
}

/** Types a title into the edit dialog the way a keyboard does, optionally picks a swatch, and presses its primary button. */
async function submit(api: NbSectionsCheckApi, title: string, swatch = -1): Promise<void> {
	const m = editModal();
	const input = m?.querySelector<HTMLInputElement>("#nb-sections-name");
	if (!m || !input) return;
	input.value = title;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	if (swatch >= 0) m.querySelectorAll<HTMLButtonElement>(".nb-sections-swatch")[swatch]?.click();
	const buttons = m.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button");
	buttons[buttons.length - 1]?.click();
	await api.frames(3);
}

/** Ten blank pages, no sections, the first page in view, the navigator open, no dialog. */
async function reset(api: NbSectionsCheckApi): Promise<SectionsView> {
	const v = api.view as SectionsView;
	closeDialogs();
	const doc = v.document;
	if (sectionsOf(doc).length > 0) v.applyCommand(new SetSections(sectionsOf(doc), [], "Change sections"));
	const first = doc.pages[0]!;
	for (let i = doc.pages.length; i < PAGES; i++) {
		const page: Page = { ...first, id: `sec-page-${i + 1}`, strokes: [], elements: [] };
		v.applyCommand(new AddPage(page, doc.pages.length));
	}
	v.jumpToPage(0);
	v.setNavigatorOpen(true);
	await api.frames(4);
	return v;
}

export async function checkNbSections(api: NbSectionsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = await reset(api);
	const doc = (): NotebookDocument => v.document;
	const list = (): readonly Section[] => sectionsOf(doc());
	const anchors = (): string => list().map((s) => `${s.title}@${doc().pages.findIndex((p) => p.id === s.page)}`).join(",");
	add("the notebook has ten pages and no section", doc().pages.length === PAGES && list().length === 0, `${doc().pages.length} pages`);
	add("no strip without sections", !q(".nb-sections-strip:not(.notebook-hidden)"));

	// --- New section at page 3 ---
	v.jumpToPage(2);
	await api.frames(3);
	v.runAction("section-new");
	await api.frames(3);
	const focused = document.activeElement?.id === "nb-sections-name";
	add("New section opens the edit dialog on the page in view, the title field focused", !!editModal() && focused, `focused ${document.activeElement?.id ?? "none"}`);
	await submit(api, "  Chemistry  ", 3);
	add("Create adds one section at page 3 with the trimmed title and the chosen colour", anchors() === "Chemistry@2" && list()[0]!.color === "#16c2a3" && !editModal(), `${anchors()} ${list()[0]?.color ?? ""}`);
	v.setNavigatorOpen(true);
	await api.frames(3);
	add("the navigator shows the strip with one current tab", tabs().length === 1 && tabs()[0]!.classList.contains("is-current"), `${tabs().length} tabs`);
	add("a divider with the title and page count sits before page 3", dividers().length === 1 && /Chemistry/.test(dividers()[0]?.textContent ?? "") && /8/.test(dividers()[0]?.textContent ?? ""), dividers()[0]?.textContent ?? "none");
	const item = dividers()[0]?.nextElementSibling;
	add("the divider is followed by a row with the colour edge", !!item && item.classList.contains("has-section"));
	v.undo();
	await api.frames(3);
	add("one undo removes the section, and the strip", list().length === 0 && tabs().length === 0);
	v.redo();
	await api.frames(3);
	add("redo brings it back", anchors() === "Chemistry@2" && tabs().length === 1);

	// --- A second section, tabs in page order, jumps ---
	v.jumpToPage(5);
	await api.frames(3);
	v.runAction("section-new");
	await api.frames(3);
	await submit(api, "Physics");
	add("a second section at page 6", anchors() === "Chemistry@2,Physics@5", anchors());
	v.setNavigatorOpen(true);
	await api.frames(3);
	add("two tabs in page order, the one in view current", tabs().map((t) => t.textContent).join("|") === "Chemistry|Physics" && !!tabs()[1]?.classList.contains("is-current"), tabs().map((t) => t.textContent).join("|"));
	const counts = dividers().map((d) => (d.querySelector(".nb-sections-divider-count")?.textContent ?? "").replace(/\D+/g, "")).join(" ");
	add("the dividers count 3 and 5 pages", counts === "3 5", counts);
	tabs()[0]?.click();
	await api.frames(4);
	add("a tap on a tab goes to the first page of its section", v.currentPage() === 2, `page ${v.currentPage()}`);
	v.jumpToPage(0);
	await api.frames(2);
	const steps: number[] = [];
	for (const [from, id] of [[-1, "section-next"], [-1, "section-next"], [7, "section-previous"], [-1, "section-previous"]] as Array<[number, string]>) {
		if (from >= 0) {
			v.jumpToPage(from);
			await api.frames(2);
		}
		v.runAction(id);
		await api.frames(3);
		steps.push(v.currentPage());
	}
	add("Next section goes 1 -> 3 -> 6; Previous from 8 goes to 6, then 3", steps.join(",") === "2,5,5,2", steps.join(","));

	// --- Deleting the first page of a section ---
	const sixth = doc().pages[5]!;
	const seventh = doc().pages[6]!.id;
	v.applyCommand(new DeletePage(sixth, 5));
	await api.frames(3);
	add("deleting the first page of Physics moves it to the next page", list()[1]?.page === seventh && anchors() === "Chemistry@2,Physics@5", anchors());
	v.undo();
	await api.frames(3);
	add("undo puts the page and the section back", doc().pages[5]?.id === sixth.id && list()[1]?.page === sixth.id, anchors());

	// --- The Sections dialog ---
	v.jumpToPage(3);
	await api.frames(2);
	v.runAction("sections-list");
	await api.frames(3);
	const rows = qa<HTMLElement>(".nb-sections-modal .nb-sections-row");
	add("the Sections dialog lists both, the one in view highlighted", rows.length === 2 && !!rows[0]?.classList.contains("is-current") && !rows[1]?.classList.contains("is-current"), `${rows.length} rows`);
	add("it offers New section at the page in view", !!q(".nb-sections-modal .nb-sections-new"));
	rows[1]?.querySelector<HTMLButtonElement>(".nb-sections-row-text")?.click();
	await api.frames(4);
	add("a tap on a row goes there and closes the dialog", v.currentPage() === 5 && !listModal(), `page ${v.currentPage()}`);

	// --- Rename and recolour (the row menu calls the same dialog) ---
	v.runAction("section-rename");
	await api.frames(3);
	const renameFocus = document.activeElement?.id === "nb-sections-name";
	await submit(api, "Physics II");
	add("Rename section edits the title of the section in view", list()[1]?.title === "Physics II" && renameFocus, anchors());
	v.runAction("section-recolour");
	await api.frames(3);
	const oldColour = list()[1]?.color;
	await submit(api, "Physics II", 2);
	add("Change section colour sets the colour", list()[1]?.color === "#8b5cf6" && oldColour !== "#8b5cf6", `${oldColour ?? ""} -> ${list()[1]?.color ?? ""}`);
	v.undo();
	await api.frames(2);
	add("undo puts the colour back, the title stays", list()[1]?.color === oldColour && list()[1]?.title === "Physics II", JSON.stringify(list()));

	// --- Layout ---
	const wide = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
	add("nothing scrolls sideways", !wide, `${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
	add("no errors", api.errors.length === 0, api.errors.join(" | "));
	closeDialogs();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { sections: anchors() } };
}

/** Three sections; the navigator open on a page of the second one, or the Sections dialog, or the edit dialog showing. */
export async function nbSectionsShot(api: NbSectionsCheckApi, state: NbSectionsShotState): Promise<void> {
	const v = await reset(api);
	const pages = v.document.pages;
	const mk = (id: string, title: string, color: string, index: number): Section => ({ id, title, color, page: pages[index]!.id });
	v.applyCommand(new SetSections([], [
		mk("shot-a", "Organic chemistry", "#16c2a3", 1),
		mk("shot-b", "Thermodynamics and statistical mechanics", "#2f80f7", 4),
		mk("shot-c", "Lab notes", "#f59e0b", 7),
	], "Change sections"));
	v.jumpToPage(5);
	await api.frames(3);
	v.setNavigatorOpen(true);
	await api.frames(6);
	if (state === "list") {
		v.runAction("sections-list");
		await show(api, listModal());
	} else if (state === "edit") {
		v.runAction("section-recolour");
		await show(api, editModal());
	}
	await api.frames(3);
}
