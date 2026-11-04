/**
 * Smoke check of notebook templates (0.15 templates, roadmap #19, `doc=templates`, npm run harness:check): a planner is saved
 * as a template into the templates folder (new ids, hidden from the library), the real creation dialog offers "From a notebook
 * template", the real picker shows its cards (cover art, Pages only / With content), a notebook is made from it (fresh ids,
 * today's date in the title and text boxes, ink kept or cleared), and the manager of the settings tab renames and deletes.
 * `templatesShot(state)` leaves one surface open for the screenshots.
 */
import type { App, TFile } from "obsidian";
import { createDocument, createPage, createStroke } from "../../src/model/document";
import { freezeElement, parse } from "../../src/model/serialize";
import type { NotebookDocument } from "../../src/model/types";
import { createNotebook } from "../../src/storage/notebooks";
import { listStoredTemplates, saveStoredTemplate } from "../../src/storage/templates-store";
import { isHiddenNotebookPath } from "../../src/storage/trash-paths";
import { CreateDialog, type ChosenTemplate, type CreateDialogHost } from "../../src/view/create-dialog";
import { applyNotebookMeta } from "../../src/view/create-logic";
import { notebookTemplatesFolder, openNotebookTemplateManager, openNotebookTemplatePicker, saveNotebookAsTemplate } from "../../src/view/notebook-templates";
import { expandPlaceholders, notebookFromTemplate, templateFromNotebook } from "../../src/model/notebook-template";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface TemplatesCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

export const TEMPLATE_STATES = ["picker", "dialog", "manager"] as const;
export type TemplateState = typeof TEMPLATE_STATES[number];

const settings = { folder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "" };

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

let opened: { root: HTMLElement; close: () => void } | null = null;

function closeAll(): void {
	const h = opened;
	opened = null;
	try {
		h?.close();
	} catch {
		// Already closed.
	}
	h?.root.remove();
	document.querySelectorAll("body > .modal, .harness-modal-container").forEach((el) => el.remove());
}

/** Puts the Modal that was just opened (the last `.modal` of the page) inside a dimmed layer, as Obsidian's container does. */
function adoptLast(): HTMLElement {
	const all = [...document.querySelectorAll<HTMLElement>("body > .modal")];
	const el = all[all.length - 1];
	if (!el) throw new Error("no modal opened");
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(el);
	opened = { root, close: () => el.querySelector<HTMLElement>(".nb-modal-close")?.click() };
	return el;
}

function tap(el: Element | null, pointerType: "pen" | "touch" | "mouse" = "touch"): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType, isPrimary: true, pointerId: 11 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

const until = async (test: () => boolean, tries = 60): Promise<boolean> => {
	for (let i = 0; i < tries && !test(); i++) await new Promise<void>((r) => window.setTimeout(r, 50));
	return test();
};

const line = (x0: number, y0: number, x1: number, y1: number) => createStroke("#1e1e1e", 2, [[x0, y0, 0.5], [(x0 + x1) / 2, (y0 + y1) / 2, 0.5], [x1, y1, 0.5]]);

/** A two-page planner with a text box holding {{date}}, ink on the first page. */
function planner(name: string, cover: string): NotebookDocument {
	const doc = createDocument();
	doc.pages[0]!.strokes.push(line(40, 60, 300, 60), line(40, 90, 300, 90));
	doc.pages[0]!.elements = [freezeElement({ id: "tx1", type: "text", x: 40, y: 120, width: 260, text: "Week of {{date}}", fontSize: 18, color: "#1e1e1e" })];
	const second = createPage();
	second.paper = { kind: "ruled", spacing: 28 };
	doc.pages.push(second);
	doc.meta = { tags: [], favorite: false, cover, bookmarks: [], description: `${name} template`, coverArt: { kind: "art", style: "waves", seed: name } };
	return doc;
}

const noteDoc = (title: string): NotebookDocument => {
	const doc = planner(title, "#16C2A3");
	doc.meta!.coverArt = { kind: "art", style: "branches", seed: title };
	return doc;
};

async function seed(app: App): Promise<void> {
	const folder = notebookTemplatesFolder(settings);
	for (const f of await listStoredTemplates(app, folder)) await app.fileManager.trashFile(f.file);
	for (const [name, color] of [["Weekly planner", "#6366F1"], ["Lab book", "#F59E0B"], ["Course journal", "#EC4899"]] as const) {
		const doc = name === "Lab book" ? noteDoc(name) : planner(name, color);
		await saveStoredTemplate(app, folder, name, templateFromNotebook(doc));
	}
}

function host(app: App, created: string[], chosen: ChosenTemplate[]): CreateDialogHost {
	return {
		root: () => "Notebooks",
		allFolders: () => ["Notebooks"],
		exists: (path) => app.vault.getAbstractFileByPath(path) !== null,
		defaults: () => ({ size: "a4", landscape: false, paper: "grid" }),
		lastFolder: () => null,
		pickImage: async () => null,
		pickNotebookTemplate: (done) => openNotebookTemplatePicker(app, settings, (c) => {
			chosen.push(c);
			done(c);
		}),
		createNotebook: async (spec, extras) => {
			const template = extras.template;
			if (!template) return false;
			const s = { ...spec, name: expandPlaceholders(spec.name), description: expandPlaceholders(spec.description) };
			const doc = template.ready ? template.doc : notebookFromTemplate(template.doc);
			applyNotebookMeta(doc, s);
			const file: TFile = await createNotebook(app, s.folder, s.name, doc);
			created.push(file.path);
			return true;
		},
		createFolder: async () => true,
	};
}

function showDialog(app: App, created: string[], chosen: ChosenTemplate[]): CreateDialog {
	const dialog = new CreateDialog(app, host(app, created, chosen), "notebook", "Notebooks");
	dialog.open();
	adoptLast();
	return dialog;
}

const ids = (d: NotebookDocument): Set<string> => new Set([d.id, ...d.pages.flatMap((p) => [p.id, ...p.strokes.map((s) => s.id), ...(p.elements ?? []).map((e) => e.id)])]);

export async function checkTemplates(api: TemplatesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	closeAll();
	await seed(app);
	const folder = notebookTemplatesFolder(settings);
	const stored = await listStoredTemplates(app, folder);
	add("three templates are stored in the templates folder", stored.length === 3, String(stored.length));
	add("the default folder is inside the plugin's templates folder", folder === "Notebooks/_templates/notebooks", folder);
	add("the library does not list them", stored.every((s) => isHiddenNotebookPath(s.file.path, "Notebooks", "", "")));
	const original = planner("Weekly planner", "#6366F1");
	const copy = stored.find((s) => s.name === "Weekly planner")!.doc;
	add("a saved template has new ids everywhere", [...ids(copy)].every((id) => !ids(original).has(id)));

	// --- "Save as notebook template" from a name prompt ---
	saveNotebookAsTemplate(app, settings, original, "Saved by prompt");
	const prompt = adoptLast();
	const input = prompt.querySelector<HTMLInputElement>("input");
	add("Save as notebook template opens a prompt with the notebook's name", input?.value === "Saved by prompt");
	tap([...prompt.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.classList.contains("mod-cta")) ?? null, "mouse");
	add("and writes the template", await until(() => app.vault.getFileByPath(`${folder}/Saved by prompt.notebook`) !== null));
	closeAll();

	// --- Creation dialog -> picker -> new notebook ---
	const created: string[] = [];
	const chosen: ChosenTemplate[] = [];
	showDialog(app, created, chosen);
	await frames();
	const link = document.querySelector<HTMLElement>(".notebook-create-modal .nb-create-nbtemplate");
	add("the creation dialog offers “From a notebook template…”", !!link && link.getBoundingClientRect().height >= 39.5, link?.textContent ?? "");
	const dialogEl = document.querySelector<HTMLElement>(".notebook-create-modal");
	const grey = dialogEl ? obsidianStyledButtons(dialogEl) : [];
	add("no button in the dialog shows Obsidian's default look", grey.length === 0, grey.slice(0, 3).map((e) => e.className).join(", "));
	tap(link, "pen");
	const picker = await until(() => !!document.querySelector(".nb-tpl-picker .nb-tpl-card"));
	add("the picker lists the saved templates as cards", picker && document.querySelectorAll(".nb-tpl-picker .nb-tpl-card").length === 4, String(document.querySelectorAll(".nb-tpl-picker .nb-tpl-card").length));
	await frames(3);
	const cover = document.querySelector<HTMLElement>(".nb-tpl-picker .nb-tpl-cover");
	add("with cover art", await until(() => (cover?.style.getPropertyValue("--nb-tpl-art") ?? "").startsWith("url(")), cover?.style.getPropertyValue("--nb-tpl-art").slice(0, 20) ?? "");
	const pickerEl = document.querySelector<HTMLElement>(".nb-tpl-picker");
	const small = [...(pickerEl?.querySelectorAll<HTMLElement>(".nb-tpl-card, .nb-tpl-mode, .nb-modal-btn") ?? [])].filter((b) => b.getBoundingClientRect().height < 39.5);
	add("every target of the picker is at least 40 px", small.length === 0, small.map((b) => b.className).join(", "));
	const body = pickerEl?.querySelector<HTMLElement>(".nb-modal-body");
	add("nothing overflows sideways", !!body && body.scrollWidth <= body.clientWidth + 1, `${body?.scrollWidth} > ${body?.clientWidth}`);
	const modes = [...document.querySelectorAll<HTMLElement>(".nb-tpl-picker .nb-tpl-mode")].map((m) => m.textContent);
	add("the choice is Pages only / With content", modes.join("|") === "Pages only|With content", modes.join("|"));
	const lab = [...document.querySelectorAll<HTMLElement>(".nb-tpl-picker .nb-tpl-card")].find((c) => c.querySelector(".nb-tpl-name")?.textContent === "Lab book") ?? null;
	tap(lab, "touch");
	add("tapping a card selects it", lab?.getAttribute("aria-checked") === "true" && document.querySelectorAll(".nb-tpl-picker .nb-tpl-card.is-selected").length === 1);
	tap([...document.querySelectorAll<HTMLElement>(".nb-tpl-picker .nb-tpl-mode")][0] ?? null, "pen");
	add("Pages only is marked", document.querySelector(".nb-tpl-picker .nb-tpl-mode.is-selected")?.textContent === "Pages only");
	tap(document.querySelector(".nb-tpl-picker .nb-modal-btn.is-primary"), "touch");
	await frames(3);
	const nameInput = document.querySelector<HTMLInputElement>(".notebook-create-modal .nb-create-name");
	add("the dialog shows the chosen template and suggests its name", nameInput?.value === "Lab book" && !!document.querySelector(".notebook-create-modal .nb-create-template"), nameInput?.value ?? "");
	add("and its description", document.querySelector<HTMLTextAreaElement>(".notebook-create-modal .nb-create-description")?.value === "Lab book template");
	nameInput!.value = "Lab {{date}}";
	nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
	tap(document.querySelector(".notebook-create-modal .nb-create-primary"), "mouse");
	await until(() => created.length > 0);
	const today = expandPlaceholders("{{date}}");
	add("creating makes the notebook with today's date in the title", created[0] === `Notebooks/Lab ${today}.notebook`, created[0] ?? "none");
	const file = created[0] ? app.vault.getFileByPath(created[0]) : null;
	const parsed = file ? parse(await app.vault.read(file)) : null;
	if (parsed?.ok) {
		const doc = parsed.doc;
		const tpl = stored.find((s) => s.name === "Lab book")!.doc;
		add("Pages only: the pages stay, ink and text boxes are gone", doc.pages.length === 2 && doc.pages.every((p) => p.strokes.length === 0 && !(p.elements?.length)), JSON.stringify(doc.pages.map((p) => p.strokes.length)));
		add("with the template's paper", doc.pages[1]!.paper.kind === "ruled");
		add("and fresh ids", [...ids(doc)].every((id) => !ids(tpl).has(id)));
		add("with the cover of the template", doc.meta?.cover === "#16C2A3" && doc.meta.coverArt?.kind === "art" && doc.meta.coverArt.style === "branches", JSON.stringify(doc.meta?.coverArt));
	} else add("the new notebook reads back", false, parsed && !parsed.ok ? parsed.message : "missing");
	add("the dialog closed after creating", await until(() => !document.querySelector(".notebook-create-modal")));
	closeAll();

	// --- With content ---
	const content = notebookFromTemplate(copy, { content: true });
	const text = content.pages[0]!.elements?.find((e) => e.type === "text");
	add("With content keeps the ink and fills {{date}} in text boxes", content.pages[0]!.strokes.length === 2 && text?.type === "text" && text.text === `Week of ${today}`, text?.type === "text" ? text.text : "");

	// --- Manager (settings) ---
	openNotebookTemplateManager(app, () => settings);
	adoptLast();
	await until(() => document.querySelectorAll(".nb-tpl-manager .nb-tpl-row").length > 0);
	await frames(3);
	const rows = document.querySelectorAll(".nb-tpl-manager .nb-tpl-row").length;
	add("the manager lists the templates with Rename and Delete", rows === 4 && document.querySelectorAll(".nb-tpl-manager .nb-tpl-row-actions button").length === 8, String(rows));
	const mgr = document.querySelector<HTMLElement>(".nb-tpl-manager");
	const mgrSmall = [...(mgr?.querySelectorAll<HTMLElement>(".nb-modal-btn") ?? [])].filter((b) => b.getBoundingClientRect().height < 39.5);
	add("its buttons are at least 40 px", mgrSmall.length === 0, String(mgrSmall.length));
	const delRow = [...document.querySelectorAll<HTMLElement>(".nb-tpl-manager .nb-tpl-row")].find((r) => r.querySelector(".nb-tpl-name")?.textContent === "Saved by prompt") ?? null;
	tap(delRow?.querySelector<HTMLElement>(".nb-modal-btn.is-danger") ?? null, "touch");
	await frames();
	const confirm = document.querySelector<HTMLElement>(".nb-confirm");
	add("Delete asks for a confirmation first", !!confirm && !!app.vault.getFileByPath(`${folder}/Saved by prompt.notebook`));
	if (confirm) tap(confirm.querySelector(".nb-modal-btn.is-danger"), "mouse");
	add("and then moves the template to the trash", await until(() => app.vault.getFileByPath(`${folder}/Saved by prompt.notebook`) === null));
	add("…the library Trash (restorable), not Obsidian's trash", app.vault.getFiles().some((f) => f.path.includes("/_trash/items/") && f.name === "Saved by prompt.notebook"));
	closeAll();

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** Leaves one surface open for a screenshot. */
export async function templatesShot(api: TemplatesCheckApi, state: TemplateState): Promise<void> {
	const app = api.app as App;
	closeAll();
	await seed(app);
	if (state === "picker") {
		openNotebookTemplatePicker(app, settings, () => undefined);
		await until(() => !!document.querySelector(".nb-tpl-picker .nb-tpl-card"));
		adoptLast();
	} else if (state === "manager") {
		openNotebookTemplateManager(app, () => settings);
		await until(() => !!document.querySelector(".nb-tpl-manager .nb-tpl-row"));
		adoptLast();
	} else {
		const dialog = showDialog(app, [], []);
		await frames();
		tapLink();
		await until(() => !!document.querySelector(".nb-tpl-picker .nb-tpl-card"));
		tap(document.querySelector(".nb-tpl-picker .nb-modal-btn.is-primary"));
		await frames(3);
		void dialog;
	}
	await frames(4);
	await new Promise<void>((r) => window.setTimeout(r, 400));
	window.scrollTo(0, 0);
}

function tapLink(): void {
	tap(document.querySelector(".notebook-create-modal .nb-create-nbtemplate"));
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function templatesApi(api: TemplatesCheckApi): Record<string, unknown> {
	return {
		checkTemplates: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkTemplates(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`templates check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		templatesShot: (state: TemplateState) => templatesShot(api, state),
		closeTemplates: closeAll,
		templateStates: [...TEMPLATE_STATES],
	};
}
