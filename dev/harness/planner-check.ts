/**
 * Smoke check of the planner generator (0.20 planner, roadmap #118, `doc=planner`, npm run harness:check): the real creation
 * dialog on its Planner tab (suggested name, section chips, page count and the large-notebook warning), a planner created
 * through the dialog and read back from the vault (page count, ids, links, bookmarks), and the generated pages drawn by the
 * real thumbnail renderer. `plannerShot(state)` leaves one surface open for the screenshots.
 */
import type { App, TFile } from "obsidian";
import { renderThumbnail } from "../../src/library/thumbnail";
import { soleLink } from "../../src/ink/link-text";
import { parse } from "../../src/model/serialize";
import { buildPlanner } from "../../src/model/planner";
import { PAGE_SIZES, type TextElement } from "../../src/model/types";
import { createNotebook } from "../../src/storage/notebooks";
import { CreateDialog, type CreateDialogHost } from "../../src/view/create-dialog";
import { applyNotebookMeta } from "../../src/view/create-logic";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface PlannerCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

export const PLANNER_STATES = ["dialog", "large", "pages"] as const;
export type PlannerState = typeof PLANNER_STATES[number];

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

let opened: { root: HTMLElement; close: () => void } | null = null;
let overlay: HTMLElement | null = null;

function closeAll(): void {
	const h = opened;
	opened = null;
	try {
		h?.close();
	} catch {
		// Already closed.
	}
	h?.root.remove();
	overlay?.remove();
	overlay = null;
	document.querySelectorAll("body > .modal, .harness-modal-container").forEach((el) => el.remove());
}

function adoptLast(): HTMLElement {
	const all = [...document.querySelectorAll<HTMLElement>("body > .modal")];
	const el = all[all.length - 1];
	if (!el) throw new Error("no modal opened");
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(el);
	opened = { root, close: () => el.querySelector<HTMLElement>(".nb-create-close")?.click() };
	return el;
}

function tap(el: Element | null): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 13 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

const until = async (test: () => boolean, tries = 80): Promise<boolean> => {
	for (let i = 0; i < tries && !test(); i++) await new Promise<void>((r) => window.setTimeout(r, 50));
	return test();
};

function host(app: App, created: string[]): CreateDialogHost {
	return {
		root: () => "Notebooks",
		allFolders: () => ["Notebooks"],
		exists: (path) => app.vault.getAbstractFileByPath(path) !== null,
		defaults: () => ({ size: "a4", landscape: false, paper: "grid" }),
		lastFolder: () => null,
		pickImage: async () => null,
		plannerDefaults: () => ({ lang: "en", weekStart: 1, year: 2026 }),
		linkTarget: (path) => path.slice(path.lastIndexOf("/") + 1),
		createNotebook: async (spec, extras) => {
			const template = extras.template;
			if (!template) return false;
			applyNotebookMeta(template.doc, spec);
			const file: TFile = await createNotebook(app, spec.folder, spec.name, template.doc);
			created.push(file.path);
			return true;
		},
		createFolder: async () => true,
	};
}

function openPlanner(app: App, created: string[]): CreateDialog {
	const dialog = new CreateDialog(app, host(app, created), "planner", "Notebooks");
	dialog.open();
	adoptLast();
	return dialog;
}

const chips = () => [...document.querySelectorAll<HTMLButtonElement>(".notebook-create-modal .nb-create-check")];
const chip = (index: number) => chips()[index] ?? null;
const summary = () => document.querySelector<HTMLElement>(".notebook-create-modal .nb-create-planner-summary")?.textContent ?? "";

export async function checkPlanner(api: PlannerCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	closeAll();
	const created: string[] = [];
	openPlanner(app, created);
	await frames();
	const modal = document.querySelector<HTMLElement>(".notebook-create-modal");
	const tabs = [...(modal?.querySelectorAll<HTMLElement>(".nb-create-tab") ?? [])].map((b) => b.textContent);
	add("the dialog has a Planner tab beside Notebook and Folder", tabs.join(",") === "Notebook,Planner,Folder", tabs.join(","));
	add("the Planner tab is the active one", modal?.querySelector(".nb-create-tab.is-active")?.textContent === "Planner");
	const name = modal?.querySelector<HTMLInputElement>("input.nb-create-name");
	add("the name is suggested", name?.value === "Planner 2026", name?.value ?? "");
	add("five section chips, each a comfortable target", chips().length === 5 && chips().every((c) => c.getBoundingClientRect().height >= 39.5), String(chips().length));
	add("year, calendar, every month first: 72 pages by default", summary().includes("72 pages"), summary());
	add("no large warning at 72 pages", !modal?.querySelector(".nb-create-planner-warning"));
	const grey = modal ? obsidianStyledButtons(modal) : [];
	add("no button in the dialog shows Obsidian's default look", grey.length === 0, grey.slice(0, 3).map((e) => e.className).join(", "));

	// Daily pages: 365 more pages, and the warning.
	tap(chip(3));
	await frames();
	add("daily pages: 72 + 365 = 437 pages", summary().includes("437 pages"), summary());
	add("and the large-notebook warning shows", !!document.querySelector(".notebook-create-modal .nb-create-planner-warning"));
	add("the days chip is checked", chip(3)?.getAttribute("aria-checked") === "true");

	tap(chip(3));
	await frames();
	add("daily pages off again: 72 pages", summary().includes("72 pages"), summary());

	// No section at all: a message, not a count.
	for (const i of [0, 1, 2, 4]) tap(chip(i));
	await frames();
	add("with every section off the dialog says to pick one", summary().includes("Pick at least one section"), summary());
	for (const i of [0, 1, 2, 4]) tap(chip(i));
	await frames();

	// Create it through the dialog: the 72-page planner, read back from the vault.
	tap(document.querySelector(".notebook-create-modal .nb-create-primary"));
	add("the planner is created", await until(() => created.length === 1), created.join(","));
	const file = created[0] ? app.vault.getFileByPath(created[0]) : null;
	const parsed = file ? parse(await app.vault.read(file)) : null;
	add("it reads back as a valid notebook", !!parsed && parsed.ok);
	if (parsed?.ok) {
		const pages = parsed.doc.pages;
		add("with 72 pages, the year first", pages.length === 72 && pages[0]!.id === "y", String(pages.length));
		add("a bookmark on the year, each month and the notes", (parsed.doc.meta?.bookmarks.length ?? 0) === 14, String(parsed.doc.meta?.bookmarks.length));
		const month = pages.find((p) => p.id === "m3");
		const links = (month?.elements ?? []).filter((e): e is TextElement => e.type === "text" && soleLink(e.text) !== null);
		add("a month page links to its weeks and up to the year", links.length >= 6 && links.some((e) => e.text.includes("|‹ Year]]")), String(links.length));
		add("the links name this notebook by file name", links.every((e) => e.text.startsWith("[[Planner 2026.notebook#p")), links[0]?.text ?? "");
		add("no ink in any page", pages.every((p) => p.strokes.length === 0));
	}
	closeAll();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}

async function showPages(app: App): Promise<void> {
	const { pages } = buildPlanner({
		year: 2026, startMonth: 1, lang: "en", weekStart: 1, size: PAGE_SIZES.a4, notesPages: 1, linkTarget: "Planner 2026.notebook",
		sections: { year: true, months: true, weeks: true, days: true, notes: false },
	});
	void app;
	const pick = ["y", "m3", "w11", "d71"].map((id) => pages.find((p) => p.id === id)!);
	overlay = document.body.createDiv({ cls: "harness-planner-pages" });
	for (const p of pick) {
		overlay.createEl("img", { attr: { src: renderThumbnail(p, 560), alt: p.id } });
	}
	await frames();
}

export async function plannerShot(api: PlannerCheckApi, state: PlannerState): Promise<void> {
	const app = api.app as App;
	closeAll();
	if (state === "pages") {
		await showPages(app);
		return;
	}
	openPlanner(app, []);
	await frames();
	if (state === "large") {
		tap(chip(3));
		await frames();
		document.querySelector(".notebook-create-modal .nb-create-planner-warning")?.scrollIntoView({ block: "center" });
	}
	await frames(4);
}

export function plannerApi(api: PlannerCheckApi): Record<string, unknown> {
	return {
		checkPlanner: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkPlanner(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`planner check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		plannerShot: (state: PlannerState) => plannerShot(api, state),
		closePlanner: closeAll,
		plannerStates: [...PLANNER_STATES],
	};
}
