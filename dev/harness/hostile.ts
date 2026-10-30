/**
 * 0.12.3: the "hostile" mode of the empty-vault scenarios (`doc=empty&hostile=1`). It makes the page look like an old or
 * odd Android WebView: built-ins newer than Chrome ~105 and risky canvas APIs are deleted, and the art engine cannot make
 * a single picture (its canvas factory and every canvas's toDataURL throw). Home, the library, the empty state, the quick
 * actions, + New and both tabs of the creation dialog must still be drawn, with the art simply missing and no error card.
 */
import { setArtCanvasFactory } from "../../src/ui/art/generative-art";
import { PAPER_KINDS } from "../../src/model/types";
import { t } from "../../src/i18n";
import { closeCreate } from "./create-check";

type Result = { name: string; ok: boolean; detail: string };

/** Console errors the hostile mode causes on purpose (logged once by the guards); anything else fails the scenario. */
export const HOSTILE_ERROR = /harness hostile/;

/** What was removed, for the report. */
export const removed: string[] = [];

function drop(owner: object | undefined, key: string, label: string): void {
	if (!owner) return;
	try {
		if (key in owner) {
			Reflect.deleteProperty(owner, key);
			if (key in owner) Object.defineProperty(owner, key, { value: undefined, configurable: true, writable: true });
			removed.push(label);
		}
	} catch {
		// A non-configurable built-in stays; the list says what went.
	}
}

export function installHostile(): void {
	const w = window as unknown as Record<string, unknown>;
	drop(Object, "groupBy", "Object.groupBy");
	drop(Map, "groupBy", "Map.groupBy");
	for (const k of ["toSorted", "toReversed", "toSpliced", "with", "findLast", "findLastIndex", "at"]) drop(Array.prototype, k, `Array.prototype.${k}`);
	for (const k of ["union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"]) drop(Set.prototype, k, `Set.prototype.${k}`);
	drop(Array, "fromAsync", "Array.fromAsync");
	drop(Promise, "withResolvers", "Promise.withResolvers");
	drop(String.prototype, "isWellFormed", "String.prototype.isWellFormed");
	drop(String.prototype, "toWellFormed", "String.prototype.toWellFormed");
	drop(w, "structuredClone", "structuredClone");
	drop(w, "OffscreenCanvas", "OffscreenCanvas");
	drop(CanvasRenderingContext2D.prototype, "roundRect", "CanvasRenderingContext2D.roundRect");
	drop(CanvasRenderingContext2D.prototype, "reset", "CanvasRenderingContext2D.reset");
	drop(CanvasRenderingContext2D.prototype, "letterSpacing", "CanvasRenderingContext2D.letterSpacing");
	drop(Element.prototype, "checkVisibility", "Element.checkVisibility");
	drop(HTMLElement.prototype, "showPopover", "HTMLElement.showPopover");
	// The art engine cannot make a picture, and no canvas can be read back (paper previews, thumbnails).
	setArtCanvasFactory(() => {
		throw new Error("harness hostile: the art canvas cannot be created");
	});
	HTMLCanvasElement.prototype.toDataURL = function () {
		throw new Error("harness hostile: toDataURL");
	};
}

const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};

function shown(el: Element | null): el is HTMLElement {
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

/** Opens the creation dialog from the empty state and switches to `tab`; true when the dialog is up on that tab. */
export async function hostileDialog(tab: "notebook" | "folder"): Promise<boolean> {
	closeCreate();
	document.querySelector<HTMLElement>('.nb-app [data-key="empty:new-notebook"]')?.click();
	await frames(3);
	if (tab === "folder") {
		const b = Array.from(document.querySelectorAll<HTMLElement>(".nb-create-tab")).find((x) => x.textContent === t("create.tab.folder"));
		b?.click();
		await frames(3);
	}
	const modal = document.querySelector(".notebook-create-modal");
	return !!modal && !!modal.querySelector(".nb-create-tabs") && !!modal.querySelector(".is-folder") === (tab === "folder");
}

export async function checkHostile(surface: string): Promise<Result[]> {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `hostile ${surface} ${window.innerWidth}px: ${name}`, ok, detail });
	const app = document.querySelector<HTMLElement>(".nb-app");
	add("the view is built", !!app, removed.join(", "));
	if (!app) return out;
	const q = (sel: string) => app.querySelector<HTMLElement>(sel);
	const count = (sel: string) => Array.from(app.querySelectorAll(sel)).filter(shown).length;
	add(`risky APIs removed (${removed.length})`, removed.length >= 10, removed.join(", "));

	add("no error card anywhere (art failures only drop the art)", app.querySelectorAll(".nb-error-card").length === 0, q(".nb-error-card")?.textContent ?? "");
	add("the header has + New", shown(q(".nb-header-buttons .nb-new-btn")) && q(".nb-header-buttons .nb-new-btn")?.textContent === t("lib.new"));
	add("the header's art band is hidden", !shown(q(".nb-header-art")) || q(".nb-header-art")!.classList.contains("is-hidden"));
	add("the empty state is shown, with its icon instead of the illustration", count(".nb-empty-state") === 1 && count(".nb-empty-state .nb-empty-art") === 0 && count(".nb-empty-state .nb-empty-icon") === 1);
	add("the empty state's three buttons", count(".nb-empty-state .nb-pill-btn") === 3, String(count(".nb-empty-state .nb-pill-btn")));
	add("the dashed Create a folder tile", count(".nb-subject-grid .nb-create-tile") === 1);
	if (surface === "home") {
		add("the quick actions are shown, without art", count(".nb-home-quick .nb-quick") === 4 && count(".nb-quick-art") === 0, `${count(".nb-home-quick .nb-quick")} tiles, ${count(".nb-quick-art")} art`);
	} else {
		add("the filter chips are shown", count(".nb-chips .nb-chip") === 6, String(count(".nb-chips .nb-chip")));
		// The Tags page (the device showed it empty in 0.12.2).
		q('[data-key="nav:tags"]')?.click();
		await frames(3);
		add("the Tags page has its title, its hint and + New", q(".nb-page-title")?.textContent === t("nav.tags") && count(".nb-hint") === 1 && shown(q(".nb-header-buttons .nb-new-btn")));
		q('[data-key="nav:all"]')?.click();
		await frames(3);
	}

	// The creation dialog: both tabs, all fields, no pictures.
	const dlg = () => document.querySelector<HTMLElement>(".notebook-create-modal");
	await hostileDialog("notebook");
	const nb = dlg();
	add("the dialog opens with two tabs", !!nb && nb.querySelectorAll(".nb-create-tab").length === 2);
	add("Notebook tab: name, description, folder, paper tiles, sizes, orientation, footer", !!nb && !!nb.querySelector(".nb-create-name") && !!nb.querySelector(".nb-create-description")
		&& !!nb.querySelector("#nb-create-folder") && nb.querySelectorAll(".nb-create-paper").length === PAPER_KINDS.length && nb.querySelectorAll(".nb-create-chip").length >= 5
		&& nb.querySelectorAll(".nb-create-orient-tile").length === 2 && !!nb.querySelector(".nb-create-primary") && !!nb.querySelector(".nb-create-secondary"));
	add("Notebook tab: the cover is a plain colour and the paper tiles have no picture", !!nb && !nb.querySelector(".nb-create-cover-img") && !!nb.querySelector(".nb-create-cover") && nb.querySelectorAll(".nb-create-paper img").length === 0);
	add("Notebook tab: no error card", !!nb && nb.querySelectorAll(".nb-error-card").length === 0, nb?.querySelector(".nb-error-card")?.textContent ?? "");
	await hostileDialog("folder");
	const fd = dlg();
	add("Folder tab: card preview, name, location, icons, colours, footer", !!fd && !!fd.querySelector(".nb-subject-card") && !!fd.querySelector(".nb-create-name")
		&& !!fd.querySelector("#nb-create-folder") && fd.querySelectorAll(".nb-create-icon-tile").length >= 7 && fd.querySelectorAll(".nb-create-swatch").length === 9 && !!fd.querySelector(".nb-create-primary"));
	add("Folder tab: the card has no art and no error card", !!fd && !fd.querySelector(".nb-subject-art") && fd.querySelectorAll(".nb-error-card").length === 0, fd?.querySelector(".nb-error-card")?.textContent ?? "");
	closeCreate();
	return out;
}
