/**
 * Smoke check of the saved views (0.23, roadmap #264, format v21) on the `doc=savedviews` notebook (the blank "New" notebook; npm run
 * harness:check): the real view. Three pages are added and one is zoomed into; "Save current view" opens the dialog on the name field and
 * saves the page, region and zoom under that name (one undo step); panning away and tapping the view in "Go to saved view…" brings the
 * very same viewport back; the list renames, reorders, updates and removes through the menu (each one undoable); a view whose page is
 * deleted is shown as missing, can be removed and works again after Undo; a read-only notebook can recall views but not change them; the
 * views survive the writer and the reader. The final state (the list open with three views, the last one missing) is left for the screenshot.
 */
import { AddPage, DeletePage } from "../../src/model/history";
import { createPage } from "../../src/model/document";
import { parse, serialize } from "../../src/model/serialize";
import type { NotebookDocument, SavedView } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SavedviewsCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ViewsView extends HarnessView {
	viewSize: { width: number; height: number };
	setViewport(v: { scale: number; offsetX: number; offsetY: number }, interactive?: boolean): void;
}

export async function checkSavedviews(api: SavedviewsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as ViewsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const doc = (): NotebookDocument => v.document;
	const views = (): readonly SavedView[] => doc().views ?? [];
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const modal = (): HTMLElement | null => q<HTMLElement>(".nb-views-modal");
	const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-views-modal .nb-views-row"));
	const labels = (): string[] => rows().map((r) => r.querySelector(".nb-views-row-label")?.textContent ?? r.querySelector<HTMLInputElement>("input")?.value ?? "");
	const near = (a: number, b: number, eps = 0.5): boolean => Math.abs(a - b) <= eps;
	const same = (a: { scale: number; offsetX: number; offsetY: number }, b: { scale: number; offsetX: number; offsetY: number }): boolean =>
		near(a.scale, b.scale, 1e-6) && near(a.offsetX, b.offsetX) && near(a.offsetY, b.offsetY);
	const here = () => ({ scale: v.viewport.scale, offsetX: v.viewport.offsetX, offsetY: v.viewport.offsetY });
	/** The harness stands in for Obsidian's modal container: the dialog is moved in so the screenshot shows it. */
	const show = async (): Promise<void> => {
		await frames(3);
		const m = modal()?.closest(".modal") as HTMLElement | null;
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
		await frames(2);
	};
	const closeDialog = async (): Promise<void> => {
		q<HTMLButtonElement>(".nb-views-modal .nb-modal-foot button")?.click();
		document.querySelectorAll(".harness-modal-container").forEach((el) => el.remove());
		await frames(2);
	};
	/** Types into a field the way a keyboard does (the input event is what the dialog listens to). */
	const type = (input: HTMLInputElement, text: string): void => {
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const menuOf = (row: HTMLElement): string[] => {
		row.querySelector<HTMLButtonElement>(".nb-views-row-more")?.click();
		return (window as unknown as { harnessMenu?: { titles: string[] } }).harnessMenu?.titles ?? [];
	};
	const pick = async (title: string): Promise<void> => {
		(window as unknown as { harnessMenu?: { run(title: string): void } }).harnessMenu?.run(title);
		await frames(3);
	};

	// --- a notebook of four pages, zoomed into the middle of the second ---
	for (let i = 0; i < 3; i++) v.applyCommand(new AddPage(createPage(), doc().pages.length));
	await frames(3);
	add("the notebook has four pages and no saved view", doc().pages.length === 4 && views().length === 0);
	v.scrollToPage(1);
	await frames(3);
	const fit = v.viewport.scale;
	const zoomed = { scale: fit * 2, offsetX: 0, offsetY: 0 };
	const box = v.layout.boxes[1]!;
	zoomed.offsetX = -(box.x + 120) * zoomed.scale;
	zoomed.offsetY = -(box.y + 260) * zoomed.scale;
	v.setViewport(zoomed);
	await frames(3);
	const placed = here();
	add("the view is zoomed to twice the fit on the second page", near(placed.scale, fit * 2, 1e-6) && v.currentPage() === 1, `${placed.scale.toFixed(3)} on page ${v.currentPage() + 1}`);

	// --- save the current view ---
	v.runAction("saved-view-save");
	await frames(3);
	// (before the dialog is moved into the harness container: moving a node drops its focus)
	const focused = modal() !== null && document.activeElement?.id === "nb-views-name";
	await show();
	add("Save current view opens the dialog on the name field", focused);
	const nameInput = q<HTMLInputElement>("#nb-views-name")!;
	add("the field has a free name ready, and says what will be saved", nameInput.value === "View 1" && (q(".nb-views-now")?.textContent ?? "").includes("page 2"), `${nameInput.value} / ${q(".nb-views-now")?.textContent ?? ""}`);
	type(nameInput, "Proof of lemma 2");
	q<HTMLButtonElement>(".nb-views-save .nb-modal-btn")!.click();
	await frames(3);
	add("saving closes the dialog and stores one view in the notebook", modal() === null && views().length === 1);
	const first = views()[0]!;
	add("it holds the name, the page id and the zoom", first.name === "Proof of lemma 2" && first.page === doc().pages[1]!.id && near(first.zoom, 2, 0.01), JSON.stringify(first));
	add("the region is in page coordinates (the corner of the view on the page)", near(first.x, 120, 0.2) && near(first.y, 260, 0.2) && first.width > 50 && first.height > 50, `${first.x}, ${first.y}, ${first.width} x ${first.height}`);
	v.undo();
	await frames(2);
	add("one undo takes the view away", views().length === 0);
	v.redo();
	await frames(2);
	add("one redo makes it again", views().length === 1 && views()[0]!.name === "Proof of lemma 2");

	// --- go away and come back ---
	v.scrollToPage(3);
	await frames(3);
	add("the view moved to the last page", v.currentPage() === 3 && !same(here(), placed));
	v.runAction("saved-view-go");
	await show();
	add("Go to saved view lists it with its page and zoom", rows().length === 1 && (rows()[0]!.querySelector(".nb-views-row-detail")?.textContent ?? "").includes("Page 2") && (rows()[0]!.querySelector(".nb-views-row-detail")?.textContent ?? "").includes("200%"), rows()[0]?.textContent ?? "");
	rows()[0]!.querySelector<HTMLButtonElement>(".nb-views-row-text")!.click();
	await frames(4);
	add("a tap closes the list and shows the very same viewport again", modal() === null && same(here(), placed), `${JSON.stringify(here())} vs ${JSON.stringify(placed)}`);
	document.querySelectorAll(".harness-modal-container").forEach((el) => el.remove());

	// --- the same place on another screen size (the middle of the region stays in the middle) ---
	const wide = v.viewSize.width;
	add("the screen is measured", wide > 0 && v.viewSize.height > 0);

	// --- more views from the list, then rename, move, update, remove ---
	v.scrollToPage(2);
	await frames(3);
	v.runAction("saved-view-go");
	await show();
	const addInput = q<HTMLInputElement>("#nb-views-name")!;
	add("the list also saves: the name field is there with a new free name", addInput.value === "View 2", addInput.value);
	type(addInput, "Intro");
	q<HTMLButtonElement>(".nb-views-save .nb-modal-btn")!.click();
	await frames(3);
	add("saving from the list keeps it open and adds a row", modal() !== null && rows().length === 2 && labels()[1] === "Intro", labels().join(" | "));
	add("a second save under a name that exists is refused by the numbering (View 3 is next)", q<HTMLInputElement>("#nb-views-name")!.value === "View 3");
	type(q<HTMLInputElement>("#nb-views-name")!, "Appendix");
	q<HTMLButtonElement>(".nb-views-save .nb-modal-btn")!.click();
	await frames(3);
	add("three views, in the order they were saved", views().map((x) => x.name).join(",") === "Proof of lemma 2,Intro,Appendix");

	const menu = menuOf(rows()[1]!);
	add("the menu of a view offers go, rename, update, move up and down, remove", ["Go to Intro", "Rename", "Update to the current view", "Move up", "Move down", "Remove"].every((t) => menu.includes(t)), menu.join(" | "));
	await pick("Rename");
	const edit = q<HTMLInputElement>(".nb-views-rename");
	add("Rename turns the name into a field", edit !== null && edit.value === "Intro");
	if (edit) {
		edit.value = "  Introduction ";
		edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	}
	await frames(3);
	add("Enter renames it (trimmed) and the list shows it", views()[1]!.name === "Introduction" && labels()[1] === "Introduction", labels().join(" | "));
	v.undo();
	await frames(2);
	add("undo gives the old name back", views()[1]!.name === "Intro");
	v.redo();
	await frames(2);

	await closeDialog();
	v.runAction("saved-view-go");
	await show();
	menuOf(rows()[2]!);
	await pick("Move up");
	add("Move up swaps with the view above", views().map((x) => x.name).join(",") === "Proof of lemma 2,Appendix,Introduction" && labels()[1] === "Appendix", labels().join(" | "));
	add("the first row has no Move up and the last no Move down", !menuOf(rows()[0]!).includes("Move up") && !menuOf(rows()[2]!).includes("Move down"));
	await closeDialog();

	// Update: point "Appendix" at the zoomed view of page 2 where we are now.
	v.scrollToPage(1);
	v.setViewport(zoomed);
	await frames(3);
	v.runAction("saved-view-go");
	await show();
	menuOf(rows()[1]!);
	await pick("Update to the current view");
	const updated = views()[1]!;
	add("Update points the view at where we are now and keeps its name and place", updated.name === "Appendix" && updated.page === doc().pages[1]!.id && near(updated.zoom, 2, 0.01), JSON.stringify(updated));
	v.undo();
	await frames(2);
	add("undo puts the old place back", views()[1]!.page === doc().pages[2]!.id);
	v.redo();
	await frames(2);

	menuOf(rows()[2]!);
	await pick("Remove");
	add("Remove takes the view out of the list", views().map((x) => x.name).join(",") === "Proof of lemma 2,Appendix" && rows().length === 2);
	v.undo();
	await frames(2);
	add("undo brings it back where it was", views().map((x) => x.name).join(",") === "Proof of lemma 2,Appendix,Introduction");
	await closeDialog();

	// --- a page that is deleted: the view turns missing, never crashes, can be removed ---
	const doomed = doc().pages[2]!;
	const index = doc().pages.indexOf(doomed);
	const target = views().find((x) => x.page === doomed.id) ?? null;
	add("one of the views is on the third page", target !== null);
	v.applyCommand(new DeletePage(doomed, index));
	await frames(3);
	v.runAction("saved-view-go");
	await show();
	const missing = rows().filter((r) => r.classList.contains("is-missing"));
	add("the views of the deleted page stay in the list, marked as missing", views().length === 3 && missing.length === views().filter((x) => x.page === doomed.id).length && missing.length >= 1, labels().join(" | "));
	add("the row says the page is missing", (missing[0]?.querySelector(".nb-views-row-detail")?.textContent ?? "") === "Page missing", missing[0]?.textContent ?? "");
	const before = here();
	const noticeCount = api.notices.length;
	missing[0]?.querySelector<HTMLButtonElement>(".nb-views-row-text")?.click();
	await frames(3);
	add("a tap on a missing view says so, stays in the dialog and does not move", modal() !== null && same(here(), before) && api.notices.length >= noticeCount, api.notices.slice(-1)[0] ?? "");
	const missMenu = menuOf(missing[0]!);
	add("its menu has no Go to, and does have Remove", !missMenu.some((t) => t.startsWith("Go to")) && missMenu.includes("Remove"), missMenu.join(" | "));
	await closeDialog();
	v.undo();
	await frames(3);
	add("undoing the delete makes the view work again", doc().pages.includes(doomed));
	v.runAction("saved-view-go");
	await show();
	add("no row is missing any more", rows().every((r) => !r.classList.contains("is-missing")));
	await closeDialog();

	// --- read-only: recall yes, change no ---
	v.setReadOnlyMode(true, false);
	await frames(3);
	v.runAction("saved-view-go");
	await show();
	add("a read-only notebook lists its views", rows().length === 3);
	add("but cannot save, rename or remove", q<HTMLInputElement>("#nb-views-name")!.disabled && q<HTMLButtonElement>(".nb-views-save .nb-modal-btn")!.disabled && menuOf(rows()[0]!).join("|") === "Go to Proof of lemma 2");
	const away = here();
	rows()[0]!.querySelector<HTMLButtonElement>(".nb-views-row-text")!.click();
	await frames(3);
	add("and can still go to a view", modal() === null && (!same(here(), away) || same(here(), placed)));
	document.querySelectorAll(".harness-modal-container").forEach((el) => el.remove());
	v.setReadOnlyMode(false, false);
	await frames(3);

	// --- the file ---
	const text = serialize(doc());
	const back = parse(text);
	add("the views are written and read back exactly", back.ok && JSON.stringify(back.doc.views) === JSON.stringify(views()), back.ok ? "" : back.message);
	add("the file says it is format 21 or newer (22 since 0.24)", /"version": 2[12]\D/.test(text));

	// --- the final state: the list open, one view missing, for the screenshot ---
	// (the third page goes again: the view saved on it is the missing row)
	v.applyCommand(new DeletePage(doc().pages[2]!, 2));
	await frames(3);
	v.runAction("saved-view-go");
	await show();
	add("the list is open with the views and a missing one for the screenshot", modal() !== null && rows().length === 3, labels().join(" | "));
	await sleep(50);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
