/**
 * Smoke check of the creation dialog (wave 0.12, `doc=create`, npm run harness:check): the real CreateDialog on the harness
 * vault, driven with synthetic pen, touch and mouse clicks and keyboard events. Creates a notebook (paper, size, orientation,
 * cover and description must land in the file) and a folder (vault folder plus its metadata file), checks the inline name
 * errors and Enter, then leaves the dialog open on the tab asked for, for the screenshots.
 */
import { TFolder, type App } from "obsidian";
import { FolderMetaStore } from "../../src/library/folder-meta-store";
import { parse } from "../../src/model/serialize";
import { PAGE_SIZES } from "../../src/model/types";
import { createNotebook } from "../../src/storage/notebooks";
import { vaultDeviceFileAdapter } from "../../src/storage/vault-io";
import { CreateDialog, type CreateDialogHost, type CreateTab } from "../../src/view/create-dialog";
import { notebookDocument } from "../../src/view/create-logic";
import type { CheckResult } from "./reading-check";
import { obsidianStyledButtons } from "./library-check";

export interface CreateCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

let current: CreateDialog | null = null;
let backdrop: HTMLElement | null = null;
let store: FolderMetaStore | null = null;

function host(app: App, meta: FolderMetaStore, created: string[]): CreateDialogHost {
	return {
		root: () => "Notebooks",
		allFolders: () => app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path),
		exists: (path) => app.vault.getAbstractFileByPath(path) !== null,
		folderMeta: (path) => meta.getFolderMeta(path),
		defaults: () => ({ size: "a4", landscape: false, paper: "grid" }),
		lastFolder: () => null,
		pickImage: async () => null,
		createNotebook: async (spec) => {
			const file = await createNotebook(app, spec.folder, spec.name, notebookDocument(spec));
			created.push(file.path);
			return true;
		},
		createFolder: async (spec) => {
			const path = `${spec.parent}/${spec.name}`;
			await app.vault.createFolder(path);
			await meta.set(path, { color: spec.color, icon: spec.icon, art: spec.art, description: spec.description || null });
			created.push(path);
			return true;
		},
	};
}

/** Opens the dialog inside a dimmed full-screen layer (Obsidian's modal container, which the stub does not have). */
export function showCreate(api: CreateCheckApi, tab: CreateTab, folder?: string, created: string[] = []): CreateDialog {
	const app = api.app as App;
	current?.close();
	backdrop?.remove();
	store ??= new FolderMetaStore(vaultDeviceFileAdapter(app), () => "Notebooks", "0c0c0c0c");
	const dialog = new CreateDialog(app, host(app, store, created), tab, folder);
	dialog.open();
	backdrop = document.body.createDiv({ cls: "harness-modal-container" });
	backdrop.appendChild(dialog.modalEl);
	current = dialog;
	return dialog;
}

/** 0.12.2: closes the dialog that showCreate opened; the tab it was on ("notebook" | "folder"), or null when none was open. */
export function closeCreate(): CreateTab | null {
	if (!current) return null;
	const tab: CreateTab = current.contentEl.hasClass("is-folder") ? "folder" : "notebook";
	current.close();
	backdrop?.remove();
	current = null;
	backdrop = null;
	return tab;
}

/** 0.13 polish: the cover arrives from the art worker a moment after the dialog is drawn. */
const coverReady = async (): Promise<string> => {
	for (let i = 0; i < 50; i++) {
		const src = document.querySelector<HTMLImageElement>(".nb-create-cover-img")?.getAttribute("src") ?? "";
		if (src.startsWith("data:image/png")) return src;
		await new Promise<void>((r) => window.setTimeout(r, 100));
	}
	return "";
};
const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

/** A tap as each pointer type delivers it: pointerdown/up, then the click the browser makes of it. */
function tap(el: Element | null, pointerType: "pen" | "touch" | "mouse" = "touch"): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType, isPrimary: true, pointerId: 7 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

function type(input: HTMLInputElement | HTMLTextAreaElement | null, text: string): void {
	if (!input) throw new Error("no input");
	input.focus();
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(el: Element | null, k: string): void {
	(el ?? document.activeElement)?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

export async function checkCreate(api: CreateCheckApi, finalTab: CreateTab): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(`.notebook-create-modal ${sel}`);
	const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(`.notebook-create-modal ${sel}`)];
	if (!app.vault.getFolderByPath("Notebooks/Anatomia")) await app.vault.createFolder("Notebooks/Anatomia");
	if (!app.vault.getFolderByPath("Notebooks/Matematica")) await app.vault.createFolder("Notebooks/Matematica");
	const created: string[] = [];

	// --- Notebook tab ---
	showCreate(api, "notebook", "Notebooks/Anatomia", created);
	await frames();
	add("opens on the Notebook tab with the name focused", q(".nb-create-tab.is-active")?.textContent === "Notebook" && document.activeElement === q(".nb-create-name"));
	add("shows a cover preview", (await coverReady()).startsWith("data:image/png"));
	add("starts in the folder it was opened in", q(".nb-create-select-text")?.textContent === "Anatomia", q(".nb-create-select-text")?.textContent ?? "");
	add("offers every paper kind with a real preview", qa(".nb-create-paper img").length === 12 && qa(".nb-create-paper img").every((i) => (i as HTMLImageElement).src.startsWith("data:image")));
	add("offers A4 · A5 · B5 · Letter · Custom", qa(".nb-create-chip").map((c) => c.textContent).join(" ") === "A4 A5 B5 Letter Custom", qa(".nb-create-chip").map((c) => c.textContent).join(" "));
	const tooSmall = qa(".nb-create-tile, .nb-create-primary, .nb-create-secondary, .nb-create-tab, .nb-create-select").filter((b) => {
		const r = b.getBoundingClientRect();
		return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
	});
	add("every target is at least 40 px", tooSmall.length === 0, tooSmall.map((b) => b.className).join(", "));
	const body = q(".nb-create-body")!;
	add("nothing overflows sideways", body.scrollWidth <= body.clientWidth + 1, `${body.scrollWidth} > ${body.clientWidth}`);
	// 0.12.1: Obsidian's own button rules (dev/harness/obsidian-base.css) never win over the dialog's components.
	const modal = document.querySelector<HTMLElement>(".notebook-create-modal");
	const grey = modal ? obsidianStyledButtons(modal) : [];
	add("no button shows Obsidian's default button look", !!modal && grey.length === 0, grey.slice(0, 4).map((el) => el.className || el.tagName).join(", "));

	// Validation: empty, invalid characters, taken.
	tap(q(".nb-create-primary"), "mouse");
	await frames();
	add("an empty name gives an inline error and creates nothing", q(".nb-create-error")?.textContent === "Enter a name." && created.length === 0, q(".nb-create-error")?.textContent ?? "");
	type(q<HTMLInputElement>(".nb-create-name"), "a/b");
	add("invalid characters give an inline error", /cannot contain/.test(q(".nb-create-error")?.textContent ?? ""));
	await app.vault.create("Notebooks/Anatomia/Ossa.notebook", "{}");
	type(q<HTMLInputElement>(".nb-create-name"), "Ossa");
	add("an existing name gives an inline error", /already in this folder/.test(q(".nb-create-error")?.textContent ?? ""));

	// Choices with pen and finger, then Enter creates it.
	type(q<HTMLInputElement>(".nb-create-name"), "Lezioni");
	type(q<HTMLTextAreaElement>(".nb-create-description"), "Prima parte del corso");
	tap(q('.nb-create-paper[data-id="dotted"]'), "pen");
	tap(q('.nb-create-chip[data-id="a5"]'), "touch");
	tap(q('.nb-create-orient-tile[data-id="landscape"]'), "pen");
	const coverBefore = await coverReady();
	tap(q(".nb-create-reseed"), "pen");
	await frames();
	const coverAfter = await coverReady();
	add("the shuffle button next to Change cover draws a new variation", !!coverBefore && !!coverAfter && coverAfter !== coverBefore);
	tap(q(".nb-create-change"), "touch");
	tap(q('.nb-create-style[data-id="cells"]'), "pen");
	tap(q('.nb-create-cover-options .nb-create-swatch[data-id="#16C2A3"]'), "touch");
	await frames();
	add("the selected tiles are marked", q('.nb-create-paper[data-id="dotted"]')?.getAttribute("aria-checked") === "true" && q('.nb-create-chip[data-id="a5"]')?.hasClass("is-active") === true);
	add("the description survived the re-renders", q<HTMLTextAreaElement>(".nb-create-description")?.value === "Prima parte del corso");
	key(q(".nb-create-name"), "Enter");
	for (let i = 0; i < 20 && created.length === 0; i++) await frames();
	const nbPath = created[0] ?? "";
	add("Enter creates the notebook in the chosen folder", nbPath === "Notebooks/Anatomia/Lezioni.notebook", nbPath);
	const nbFile = app.vault.getFileByPath(nbPath);
	const parsed = nbFile ? parse(await app.vault.read(nbFile)) : null;
	if (parsed?.ok) {
		const p = parsed.doc.pages[0]!;
		add("with exactly the chosen paper, size and orientation", p.paper.kind === "dotted" && p.width === PAGE_SIZES.a5.height && p.height === PAGE_SIZES.a5.width, `${p.paper.kind} ${p.width}x${p.height}`);
		const m = parsed.doc.meta!;
		add("and the cover and description", m.cover === "#16C2A3" && m.coverArt?.kind === "art" && m.coverArt.style === "cells" && m.description === "Prima parte del corso", JSON.stringify(m));
	} else add("the new notebook reads back", false, parsed && !parsed.ok ? parsed.message : "missing");
	add("the dialog closed after creating", !document.querySelector(".notebook-create-modal"));

	// --- Folder tab: switch by keyboard, create one ---
	showCreate(api, "notebook", "Notebooks", created);
	await frames();
	type(q<HTMLInputElement>(".nb-create-name"), "Fisiologia");
	q(".nb-create-tab.is-active")!.focus();
	key(q(".nb-create-tab.is-active"), "ArrowRight");
	await frames();
	add("the arrow keys switch to the Folder tab and keep the name", q(".nb-create-tab.is-active")?.textContent === "Folder" && q<HTMLInputElement>(".nb-create-name")?.value === "Fisiologia");
	add("the folder preview is the library's subject card", !!q(".nb-create-card-frame .nb-subject-card.is-tile img.nb-folder-icon") && q(".nb-create-card-frame .nb-subject-title")?.textContent === "Fisiologia");
	add("with the real line art", !!q(".nb-create-card-frame .nb-subject-art"));
	tap(q('.nb-create-icon-tile[data-id="brain"]'), "pen");
	await frames();
	add("the chosen symbol sits on the folder icon", !!q(".nb-create-card-frame .nb-folder-badge .nb-folder-glyph svg"));
	tap(q('.nb-create-swatch[data-id="#8B5CF6"]'), "touch");
	tap(q(".nb-create-art"), "mouse");
	tap(q(".nb-create-select"), "touch");
	await frames();
	add("the location list shows the folders with icons", qa(".nb-create-option").length >= 3 && qa(".nb-create-option svg").length >= 3);
	tap(qa(".nb-create-option").find((o) => o.textContent === "Matematica") ?? null, "pen");
	await frames();
	add("picking a location closes the list", !q(".nb-create-options") && q(".nb-create-select-text")?.textContent === "Matematica");
	tap(q(".nb-create-primary"), "touch");
	for (let i = 0; i < 20 && created.length < 2; i++) await frames();
	add("creates the vault folder", !!app.vault.getFolderByPath("Notebooks/Matematica/Fisiologia"));
	const meta = store?.getFolderMeta("Notebooks/Matematica/Fisiologia");
	add("and stores its look", meta?.icon === "brain" && meta.color === "#8B5CF6" && meta.art === "cells", JSON.stringify(meta));
	add("in this device's metadata file", !!app.vault.getFileByPath("Notebooks/_meta/folders-0c0c0c0c.json"));
	// A rename moves the look along.
	await store!.rename("Notebooks/Matematica/Fisiologia", "Notebooks/Matematica/Fisio");
	add("a rename moves the folder's look", store?.getFolderMeta("Notebooks/Matematica/Fisio")?.icon === "brain" && store.getFolderMeta("Notebooks/Matematica/Fisiologia") === null);

	await prepareShot(api, finalTab);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** Leaves the dialog open on `tab`, with something typed, for a screenshot. */
export async function prepareShot(api: CreateCheckApi, tab: CreateTab): Promise<void> {
	const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(`.notebook-create-modal ${sel}`);
	showCreate(api, tab, "Notebooks/Anatomia");
	await frames();
	type(q<HTMLInputElement>(".nb-create-name"), tab === "notebook" ? "Anatomia – lezioni" : "Anatomia");
	type(q<HTMLTextAreaElement>(".nb-create-description"), tab === "notebook" ? "Ossa, muscoli e articolazioni" : "Corso del primo semestre");
	if (tab === "folder") tap(q('.nb-create-icon-tile[data-id="heart-pulse"]'), "touch");
	await frames(3);
	q<HTMLInputElement>(".nb-create-name")?.blur();
	window.scrollTo(0, 0);
}
