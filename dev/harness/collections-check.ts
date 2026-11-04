/**
 * 0.17 collections (roadmap #120): the saved collections in the library's rail, in the browser harness
 * (doc=library&surface=library). `checkCollections()` uses the host's real collections store (an in-memory file), makes two
 * collections through the real editor dialog and checks: the rail section and its + , the live count in the rail and in the
 * dialog, opening a collection filters the grid to the same number of notebooks (the rail count and the cards agree), the
 * header names it, editing changes the rules, deleting asks first and removes the row (a notebook is never touched), and no
 * sideways scroll. `collectionsState()` leaves the editor or a collection open for the review screenshots.
 */
import type { LibraryHarness } from "./library-check";
import { obsidianStyledButtons } from "./library-check";

type Result = { name: string; ok: boolean; detail: string };

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};
const app = () => document.querySelector<HTMLElement>(".nb-app")!;
const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app()) => root.querySelector<T>(sel);
const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();
const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-coll-editor");
const confirm = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-confirm");

function visible(el: Element): el is HTMLElement {
	const h = el as HTMLElement;
	if (!h.offsetParent && getComputedStyle(h).position !== "fixed") return false;
	const r = h.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

/** Puts a `.modal` inside a dimmed layer, as Obsidian's modal container does (once). */
function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

function closeModals(): void {
	for (const x of Array.from(document.querySelectorAll<HTMLElement>(".modal .nb-modal-close"))) x.click();
	for (const layer of Array.from(document.querySelectorAll(".harness-modal-container"))) if (!layer.querySelector(".modal")) layer.remove();
}

async function openRail(): Promise<void> {
	if (app().classList.contains("is-phone") && !app().classList.contains("is-rail-open")) click(q(".nb-rail-toggle"));
	await frames(2);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change"): void {
	el.value = value;
	el.dispatchEvent(new Event(event, { bubbles: true }));
}

const countOf = (): number => Number((modal()?.querySelector(".nb-coll-count")?.textContent ?? "").match(/\d+/)?.[0] ?? -1);

async function openEditor(): Promise<HTMLElement | null> {
	await frames(3);
	await wait(150);
	adopt();
	return modal();
}

export async function collectionsState(h: LibraryHarness, state: string): Promise<boolean> {
	const store = h.host.collections;
	if (!store) return false;
	if (state === "reset") {
		closeModals();
		for (const c of store.list()) await store.remove(c.id);
		await openRail();
		click(q('.nb-rail [data-key="nav:all"]'));
		await frames(3);
		return true;
	}
	if (state === "list" || state === "editor") {
		if (store.list().length === 0) {
			await store.save({ name: "Esami del mese", rules: { tags: ["Esame"], period: { field: "modified", kind: "days", days: 30 } } });
			await store.save({ name: "Matematica preferiti", rules: { folder: "Notebooks/Matematica", favourite: true } });
		}
		await frames(3);
		await openRail();
		click(q('.nb-rail [data-key^="coll:"]:not([data-key="coll:add"])'));
		await frames(3);
		if (state === "editor") {
			click(q(".nb-coll-edit"));
			await openEditor();
		}
		return true;
	}
	return false;
}

export async function checkCollections(h: LibraryHarness, surface: string): Promise<Result[]> {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `collections: ${name}`, ok, detail });
	const store = h.host.collections;
	if (!store) return [{ name: "collections: the host has a store", ok: false, detail: "missing" }];
	if (surface !== "library") return out;
	await openRail();
	click(q('.nb-rail [data-key="nav:all"]'));
	await frames(3);

	add("the rail has a Collections section with a + row", !!q('.nb-rail [data-key="coll:add"]'), "");
	add("with none saved the rail says how to make one", !!q(".nb-rail-collections .nb-rail-hint"), "");

	// Make one through the real dialog.
	click(q('.nb-rail [data-key="coll:add"]'));
	let dlg = await openEditor();
	add("+ opens the editor", !!dlg, "");
	const total = countOf();
	add("the editor counts all notebooks while there are no rules", total > 0, String(total));
	if (dlg) {
		add("the Save button is off until there is a name", q<HTMLButtonElement>(".nb-modal-btn.is-primary, .nb-modal-foot button:last-child", dlg)?.disabled === true, "");
		setValue(q<HTMLInputElement>('[data-key="coll-name"]', dlg)!, "Preferiti", "input");
		setValue(q<HTMLSelectElement>('[data-key="coll-fav"]', dlg)!, "yes", "change");
		await frames(2);
		const favs = countOf();
		add("choosing 'only favourites' lowers the live count", favs > 0 && favs < total, `${favs} of ${total}`);
		setValue(q<HTMLSelectElement>('[data-key="coll-period-mode"]', dlg)!, "range", "change");
		await frames(2);
		add("a date range shows its dates and needs one", visible(q('[data-key="coll-from"]', dlg)!) && !!q(".nb-modal-error:not(.is-hidden)", dlg), "");
		setValue(q<HTMLSelectElement>('[data-key="coll-period-mode"]', dlg)!, "any", "change");
		const small = Array.from(dlg.querySelectorAll<HTMLElement>("button, input, select")).filter((b) => visible(b) && b.getBoundingClientRect().height < 36);
		add("the editor's controls are at least 36 px tall", small.length === 0, small.map((b) => b.className).join(" | "));
		add("the editor has no Obsidian-styled buttons", obsidianStyledButtons(dlg).length === 0, "");
		click(Array.from(dlg.querySelectorAll<HTMLElement>(".nb-modal-foot button")).pop());
		await frames(3);
		await wait(200);
	}
	adopt();
	add("saving closes the editor and writes this device's file", !modal() && store.list().some((c) => c.name === "Preferiti"), store.list().map((c) => c.name).join());
	const saved = store.list().find((c) => c.name === "Preferiti");
	await openRail();
	const row = saved ? q(`.nb-rail [data-key="coll:${saved.id}"]`) : null;
	add("the new collection is in the rail and opened", !!row && row.classList.contains("is-active"), "");
	const badge = Number(row?.querySelector(".nb-rail-count")?.textContent ?? -1);
	const cards = app().querySelectorAll(".notebook-lib-card").length;
	add("the rail count, the editor's count and the cards agree", badge === cards && cards > 0, `rail ${badge}, cards ${cards}`);
	add("the header names the collection", (q(".nb-page-title")?.textContent ?? "") === "Preferiti", q(".nb-page-title")?.textContent ?? "");

	// Edit: a second rule lowers the count.
	click(q(".nb-header-buttons .nb-coll-edit"));
	dlg = await openEditor();
	add("the pencil in the header opens the editor with the rules filled in", !!dlg && q<HTMLSelectElement>('[data-key="coll-fav"]', dlg)?.value === "yes", "");
	if (dlg) {
		setValue(q<HTMLSelectElement>('[data-key="coll-pdf"]', dlg)!, "yes", "change");
		await frames(2);
		click(Array.from(dlg.querySelectorAll<HTMLElement>(".nb-modal-foot button")).pop());
		await wait(300);
		adopt();
	}
	await frames(3);
	const after = app().querySelectorAll(".notebook-lib-card").length;
	add("editing changes what the collection shows", after < cards || (after === 0 && !!q(".nb-empty-state")), `${cards} -> ${after}`);

	// Delete asks first.
	click(q(".nb-header-buttons .nb-coll-edit"));
	dlg = await openEditor();
	click(Array.from(dlg?.querySelectorAll<HTMLElement>(".nb-modal-foot button") ?? []).find((b) => b.classList.contains("is-danger") || /elimina|delete/i.test(b.textContent ?? "")));
	await frames(3);
	adopt();
	const ask = confirm();
	add("deleting asks for confirmation first", !!ask && store.list().length === 1, "");
	click(ask?.querySelector(".nb-modal-foot button:last-child"));
	await wait(300);
	adopt();
	add("after confirming the collection is gone and the library shows", store.list().length === 0 && !!q(".nb-chips"), store.list().length.toString());
	closeModals();

	const scroll = q(".nb-scroll");
	add("no sideways scroll", !scroll || scroll.scrollWidth <= scroll.clientWidth + 1, `${scroll?.scrollWidth} > ${scroll?.clientWidth}`);
	return out;
}
