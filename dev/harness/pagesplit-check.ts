/**
 * Smoke check of merge / split / extract (0.17, roadmap #77; `doc=xfer`, npm run harness:check): the real dialog, the real
 * runner and the real notebook map on the harness vault (in memory). The dialog is driven through the DOM for each of its
 * three bodies — the gating of the button, the tick for locked pages, the sentences — and the runner is run for real:
 * extract (copy and move), split, merge with the trash, then the files are read back and compared. The map's selection mode
 * is driven with a fake host. `xferShot(state)` leaves one view open for the screenshots (tablet and phone, light and dark).
 */
import type { App, TFile } from "obsidian";
import { renderThumbnail } from "../../src/library/thumbnail";
import { extractPages, mergeNotebooks, splitNotebook, type TransferEnv } from "../../src/library/page-transfer";
import { TransferDialog, type TransferAnswer, type TransferDialogData } from "../../src/library/transfer-dialog";
import { createDocument, createPage, createStroke, quantizePoint, createId } from "../../src/model/document";
import { NotebookMapCache } from "../../src/model/notebook-map";
import { parse, serialize } from "../../src/model/serialize";
import type { NotebookDocument, Page } from "../../src/model/types";
import { createNotebook } from "../../src/storage/notebooks";
import { NotebookMapModal } from "../../src/view/notebook-map-modal";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface XferCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

export const XFER_STATES = ["extract", "split", "merge", "locked", "map"] as const;
export type XferState = typeof XFER_STATES[number];

const ROOT = "Notebooks";
const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-xfer");
const mapModal = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-map-modal");
const qa = (root: HTMLElement | null, sel: string) => [...(root?.querySelectorAll<HTMLElement>(sel) ?? [])];
const textOf = (el: Element | null | undefined) => el?.textContent ?? "";

/** Puts a `.modal` inside a dimmed layer, as Obsidian's modal container does. */
function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

export function closeXfer(): void {
	for (const el of document.querySelectorAll<HTMLElement>(".modal.nb-xfer .nb-modal-close, .modal.nb-map-modal .nb-modal-close")) el.click();
	for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
}

// ---------------------------------------------------------------- the notebooks

const line = (y: number) => createStroke("#1e1e1e", 2, [quantizePoint(40, y, 0.5), quantizePoint(300, y + 12, 0.5), quantizePoint(520, y, 0.5)]);

function pageWith(title: string, strokes = 3): Page {
	const p = createPage();
	for (let i = 0; i < strokes; i++) p.strokes.push(line(120 + i * 40));
	p.elements = [{ id: createId(), type: "text", x: 40, y: 50, width: 480, text: title, fontSize: 22, color: "#1e1e1e" }];
	return p;
}

function notebookDoc(titles: string[], locked: number[] = []): NotebookDocument {
	const doc = createDocument(new Date("2026-11-04T09:00:00.000Z"));
	doc.pages = titles.map((t, i) => {
		const p = pageWith(t);
		if (locked.includes(i + 1)) p.locked = true;
		return p;
	});
	return doc;
}

async function seed(app: App): Promise<{ physics: TFile; chemistry: TFile; docs: { physics: NotebookDocument; chemistry: NotebookDocument } }> {
	for (const f of app.vault.getFiles()) if (f.path.startsWith(`${ROOT}/Xfer`) && f.extension === "notebook") await app.fileManager.trashFile(f);
	if (!app.vault.getFolderByPath(ROOT)) await app.vault.createFolder(ROOT);
	const physics = notebookDoc(["Kinematics", "Forces and Newton's laws", "Energy", "Momentum", "Waves", "Optics"], [3]);
	const chemistry = notebookDoc(["Atoms", "Bonds", "Reactions"]);
	return {
		physics: await createNotebook(app, ROOT, "Xfer Physics", physics),
		chemistry: await createNotebook(app, ROOT, "Xfer Chemistry", chemistry),
		docs: { physics, chemistry },
	};
}

function firstText(page: Page): string {
	for (const el of page.elements ?? []) if (el.type === "text") return el.text;
	return "";
}

const items = (doc: NotebookDocument) => doc.pages.map((p, i) => ({ id: p.id, number: i + 1, excerpt: firstText(p), locked: p.locked === true }));

function openDialog(app: App, data: TransferDialogData): { answer: Promise<TransferAnswer | null> } {
	closeXfer();
	const answer = new Promise<TransferAnswer | null>((resolve) => new TransferDialog(app, data, resolve).open());
	adopt();
	return { answer };
}

const readDoc = async (app: App, path: string): Promise<NotebookDocument> => {
	const f = app.vault.getFileByPath(path);
	if (!f) throw new Error(`no ${path}`);
	const r = parse(await app.vault.read(f));
	if (!r.ok) throw new Error(r.message);
	return r.doc;
};

function fileTrash(app: App) {
	return { trash: async (f: TFile) => void (await app.fileManager.trashFile(f)) } as never as NonNullable<TransferEnv["trash"]>;
}

// ---------------------------------------------------------------- the check

export async function checkXfer(api: XferCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		await runChecks(api, add);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	closeXfer();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

async function runChecks(api: XferCheckApi, add: (name: string, ok: unknown, detail?: string) => void): Promise<void> {
	const app = api.app as App;
	const { physics, chemistry, docs } = await seed(app);
	const env: TransferEnv = { app, settings: () => ({ folder: ROOT }) as never, trash: fileTrash(app) };

	// --- extract dialog
	let d = openDialog(app, { kind: "extract", notebook: "Xfer Physics", pages: items(docs.physics), preselected: [docs.physics.pages[1]!.id], defaultName: "Xfer Physics (extract)" });
	await frames(3);
	let m = dialog();
	add("extract: the dialog opens with a row per page", qa(m, ".nb-xfer-page").length === 6, `${qa(m, ".nb-xfer-page").length}`);
	add("extract: the preselected page is ticked", qa(m, ".nb-xfer-page input").filter((i) => (i as HTMLInputElement).checked).length === 1);
	add("extract: the locked page is marked", qa(m, ".nb-xfer-page-lock").length === 1);
	const primary = () => dialog()?.querySelector<HTMLButtonElement>(".nb-modal-foot .nb-modal-btn:last-child") ?? null;
	add("extract: copy is the first choice and the button says copy", /Copy/.test(textOf(primary())), textOf(primary()));
	add("extract: the button is enabled", primary()?.disabled === false);
	qa(m, ".nb-chip").find((c) => c.dataset.key === "mode:move")?.click();
	await frames(2);
	add("extract: moving turns the button into a danger button", /Move/.test(textOf(primary())) && !!primary()?.classList.contains("is-danger"), `${textOf(primary())} ${primary()?.className}`);
	qa(m, ".nb-xfer-page input")[2]!.click();
	await frames(2);
	add("extract: ticking a locked page that would leave asks for a confirmation", primary()?.disabled === true && dialog()?.querySelector(".nb-xfer-locked.is-on") !== null);
	dialog()?.querySelector<HTMLInputElement>(".nb-xfer-locked input")?.click();
	await frames(2);
	add("extract: the confirmation enables the button", primary()?.disabled === false);
	qa(m, ".nb-chip").find((c) => c.dataset.key === "mode:copy")?.click();
	await frames(2);
	add("extract: copying does not need the confirmation", dialog()?.querySelector(".nb-xfer-locked.is-on") === null);
	add("extract: targets are at least 40 px", qa(dialog(), "button, input[type='text'], select").filter((el) => el.offsetParent !== null).every((el) => el.getBoundingClientRect().height >= 39.5),
		qa(dialog(), "button").filter((el) => el.getBoundingClientRect().height < 39.5).map((el) => el.className).join(", "));
	add("extract: no button shows Obsidian's default look", obsidianStyledButtons(dialog()!).length === 0, obsidianStyledButtons(dialog()!).map((b) => b.className).join(", "));
	add("extract: the dialog stays inside the screen", (() => { const r = dialog()!.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })());
	primary()?.click();
	const answer = await d.answer;
	add("extract: the answer carries the ticked pages in order", answer?.kind === "extract" && answer.pageIds.length === 2 && answer.mode === "copy" && !answer.allowLocked, JSON.stringify(answer));
	add("extract: a copy that includes a locked page is not a locked removal", answer?.kind === "extract" && answer.allowLocked === false);

	// --- split dialog
	d = openDialog(app, { kind: "split", notebook: "Xfer Physics", pages: items(docs.physics), splitAt: 3, defaultName: "Xfer Physics (part 2)" });
	await frames(3);
	m = dialog();
	add("split: the sentence names what stays and what goes", /Pages 1–3 stay/.test(textOf(m?.querySelector(".nb-xfer-summary"))) && /4–6/.test(textOf(m?.querySelector(".nb-xfer-summary"))), textOf(m?.querySelector(".nb-xfer-summary")));
	add("split: the button is the danger kind (pages leave the notebook)", !!primary()?.classList.contains("is-danger") && /Split/.test(textOf(primary())));
	add("split: the first page is not offered as a split point", qa(m, ".nb-xfer-select option").length === 5, `${qa(m, ".nb-xfer-select option").length}`);
	const select = m!.querySelector<HTMLSelectElement>(".nb-xfer-select")!;
	select.value = "1";
	select.dispatchEvent(new Event("change", { bubbles: true }));
	await frames(2);
	add("split: the locked page 3 would leave, so a confirmation is needed", primary()?.disabled === true && dialog()?.querySelector(".nb-xfer-locked.is-on") !== null);
	select.value = "4";
	select.dispatchEvent(new Event("change", { bubbles: true }));
	await frames(2);
	add("split: a split point after the locked page needs no confirmation", primary()?.disabled === false && dialog()?.querySelector(".nb-xfer-locked.is-on") === null);
	const name = m!.querySelector<HTMLInputElement>(".nb-xfer-name")!;
	name.value = "";
	name.dispatchEvent(new Event("input", { bubbles: true }));
	await frames(2);
	add("split: an empty name disables the button and says why", primary()?.disabled === true && /name/i.test(textOf(m?.querySelector(".nb-xfer-status"))), textOf(m?.querySelector(".nb-xfer-status")));
	closeXfer();
	add("split: closing answers nothing", (await d.answer) === null);

	// --- merge dialog
	const inspected: string[] = [];
	d = openDialog(app, {
		kind: "merge", notebook: "Xfer Physics", pages: items(docs.physics), canTrash: true,
		candidates: [{ path: chemistry.path, label: "Xfer Chemistry", folder: "" }, { path: `${ROOT}/Other.notebook`, label: "Other", folder: "Sub" }],
		inspect: async (path) => {
			inspected.push(path);
			return { pages: path === chemistry.path ? 3 : 1, locked: 0 };
		},
	});
	await frames(3);
	m = dialog();
	add("merge: lists the other notebooks and the button waits for a choice", qa(m, ".nb-xfer-pick").length === 2 && primary()?.disabled === true);
	const filter = m!.querySelector<HTMLInputElement>(".nb-xfer-filter")!;
	filter.value = "chem";
	filter.dispatchEvent(new Event("input", { bubbles: true }));
	await frames(2);
	add("merge: the filter narrows the list", qa(dialog(), ".nb-xfer-pick").length === 1);
	qa(dialog(), ".nb-xfer-pick")[0]!.click();
	await sleep(60);
	await frames(2);
	add("merge: choosing reads the notebook and shows its pages", inspected.length === 1 && /3 page/.test(textOf(dialog()?.querySelector(".nb-xfer-info"))), textOf(dialog()?.querySelector(".nb-xfer-info")));
	add("merge: the button is enabled and plain (nothing is removed)", primary()?.disabled === false && !primary()?.classList.contains("is-danger") && /Merge/.test(textOf(primary())) && !/trash/i.test(textOf(primary())), textOf(primary()));
	const after = dialog()!.querySelector<HTMLSelectElement>(".nb-xfer-select")!;
	add("merge: 'at the end' plus a choice after every page", after.options.length === 7, `${after.options.length}`);
	after.value = "1";
	after.dispatchEvent(new Event("change", { bubbles: true }));
	dialog()!.querySelector<HTMLInputElement>(".nb-xfer-trashcheck input")!.click();
	await frames(2);
	add("merge: asking for the trash makes the button a danger button that says so", !!primary()?.classList.contains("is-danger") && /trash/i.test(textOf(primary())), textOf(primary()));
	primary()?.click();
	const merged = await d.answer;
	add("merge: the answer names the notebook, the position and the trash", merged?.kind === "merge" && merged.other === chemistry.path && merged.after === 1 && merged.trashOther, JSON.stringify(merged));

	// --- the runner, for real
	const physicsBefore = await app.vault.read(physics);
	const copy = await extractPages(env, { source: physics, pageIds: [docs.physics.pages[0]!.id], mode: "copy", name: "Xfer Copy", folder: ROOT, allowLocked: false });
	add("run: copying leaves the source byte for byte as it was", (await app.vault.read(physics)) === physicsBefore && copy.added === 1 && copy.removed === 0);
	const moved = await extractPages(env, { source: physics, pageIds: [docs.physics.pages[1]!.id, docs.physics.pages[2]!.id], mode: "move", name: "Xfer Moved", folder: ROOT, allowLocked: false });
	add("run: a move without the locked page confirmation leaves the locked page", moved.added === 2 && moved.removed === 1 && moved.keptLocked === 1, JSON.stringify({ a: moved.added, r: moved.removed, k: moved.keptLocked }));
	const left = await readDoc(app, physics.path);
	add("run: the source lost only the page that moved", left.pages.length === 5 && left.pages.some((p) => p.id === docs.physics.pages[2]!.id) && !left.pages.some((p) => p.id === docs.physics.pages[1]!.id));
	const movedDoc = await readDoc(app, moved.destination.path);
	add("run: the new notebook holds both pages with their ink, the locked one still locked", movedDoc.pages.length === 2 && movedDoc.pages.every((p) => p.strokes.length === 3) && movedDoc.pages[1]!.locked === true);
	const split = await splitNotebook(env, { source: physics, at: 3, name: "Xfer Physics (part 2)", allowLocked: false });
	const first = await readDoc(app, physics.path);
	const second = await readDoc(app, split.destination.path);
	add("run: a split gives two notebooks that together hold every page", first.pages.length === 3 && second.pages.length === 2 && first.pages.length + second.pages.length === left.pages.length, `${first.pages.length} + ${second.pages.length}`);
	const m1 = await mergeNotebooks(env, { into: physics, from: chemistry, after: 0, trashFrom: false, allowLocked: false });
	const merged1 = await readDoc(app, physics.path);
	add("run: merging adds the other notebook's pages after the chosen page and leaves it alone", m1.added === 3 && merged1.pages.length === 6 && app.vault.getFileByPath(chemistry.path) !== null && (await readDoc(app, chemistry.path)).pages.length === 3);
	const m2 = await mergeNotebooks(env, { into: physics, from: chemistry, trashFrom: true, allowLocked: false });
	add("run: merging with the trash moves the other notebook to the trash only after its pages are in", m2.trashed && app.vault.getFileByPath(chemistry.path) === null && (await readDoc(app, physics.path)).pages.length === 9);

	// --- the notebook map's selection mode
	const fresh = notebookDoc(["One", "Two", "Three", "Four"], [2]);
	const cache = new NotebookMapCache();
	const picked: string[][] = [];
	const splits: string[] = [];
	const mapHost = {
		map: () => cache.build(fresh.pages), pages: () => fresh.pages, current: () => 0,
		thumbnail: (p: Page) => renderThumbnail(p, 200, { mime: "image/jpeg", quality: 0.7 }),
		goTo: () => undefined,
		extract: (ids: string[]) => void picked.push(ids),
		split: (id: string) => void splits.push(id),
	};
	closeXfer();
	new NotebookMapModal(app, mapHost).open();
	adopt();
	await frames(3);
	const toggle = () => qa(mapModal(), ".nb-map-select")[0];
	add("map: a Select pages button is offered", !!toggle());
	toggle()?.click();
	await frames(2);
	add("map: in selection mode the action bar shows and Extract waits for a page", mapModal()?.querySelector(".nb-map-selbar.is-on") !== null && (mapModal()!.querySelector<HTMLButtonElement>(".nb-map-extract")?.disabled === true));
	qa(mapModal(), ".nb-map-card")[2]!.click();
	await frames(2);
	add("map: tapping a card ticks it", qa(mapModal(), ".nb-map-card.is-picked").length === 1 && /1 selected/.test(textOf(mapModal()?.querySelector(".nb-map-selcount"))));
	add("map: one ticked page (not the first) enables Split", mapModal()!.querySelector<HTMLButtonElement>(".nb-map-split")?.disabled === false);
	qa(mapModal(), ".nb-map-card")[0]!.click();
	await frames(2);
	add("map: two ticked pages disable Split and keep Extract", mapModal()!.querySelector<HTMLButtonElement>(".nb-map-split")?.disabled === true && mapModal()!.querySelector<HTMLButtonElement>(".nb-map-extract")?.disabled === false);
	mapModal()!.querySelector<HTMLButtonElement>(".nb-map-extract")?.click();
	await frames(2);
	add("map: Extract hands the ticked ids over and closes the map", picked.length === 1 && picked[0]!.length === 2 && mapModal() === null, JSON.stringify(picked));
	new NotebookMapModal(app, mapHost).open();
	adopt();
	await frames(3);
	toggle()?.click();
	await frames(2);
	qa(mapModal(), ".nb-map-card")[1]!.click();
	await frames(2);
	mapModal()!.querySelector<HTMLButtonElement>(".nb-map-split")?.click();
	await frames(2);
	add("map: Split hands the page over", splits.length === 1 && splits[0] === fresh.pages[1]!.id);
	closeXfer();
	void serialize;
}

// ---------------------------------------------------------------- screenshots

export async function xferShot(api: XferCheckApi, state: XferState): Promise<void> {
	const app = api.app as App;
	const { chemistry, docs } = await seed(app);
	closeXfer();
	if (state === "map") {
		const doc = notebookDoc(["Kinematics", "Forces and Newton's laws", "Energy", "Momentum", "Waves", "Optics", "Heat", "Light"], [3]);
		const cache = new NotebookMapCache();
		new NotebookMapModal(app, {
			map: () => cache.build(doc.pages), pages: () => doc.pages, current: () => 1,
			thumbnail: (p: Page) => renderThumbnail(p, 200, { mime: "image/jpeg", quality: 0.7 }),
			goTo: () => undefined, extract: () => undefined, split: () => undefined,
		}).open();
		adopt();
		await frames(3);
		qa(mapModal(), ".nb-map-select")[0]?.click();
		await frames(2);
		qa(mapModal(), ".nb-map-card")[3]?.click();
		qa(mapModal(), ".nb-map-card")[4]?.click();
		await sleep(400);
		await frames(2);
		return;
	}
	const pages = items(docs.physics);
	if (state === "extract" || state === "locked") {
		openDialog(app, { kind: "extract", notebook: "Xfer Physics", pages, preselected: state === "locked" ? [pages[2]!.id, pages[3]!.id] : [pages[1]!.id, pages[3]!.id], defaultName: "Xfer Physics (extract)" });
		await frames(3);
		if (state === "locked") {
			qa(dialog(), ".nb-chip").find((c) => c.dataset.key === "mode:move")?.click();
			await frames(2);
		}
	} else if (state === "split") {
		openDialog(app, { kind: "split", notebook: "Xfer Physics", pages, splitAt: 3, defaultName: "Xfer Physics (part 2)" });
		await frames(3);
	} else {
		openDialog(app, {
			kind: "merge", notebook: "Xfer Physics", pages, canTrash: true,
			candidates: [{ path: chemistry.path, label: "Xfer Chemistry", folder: "" }, { path: `${ROOT}/Biology/Anatomy.notebook`, label: "Anatomy", folder: "Biology" }, { path: `${ROOT}/Maths.notebook`, label: "Maths", folder: "" }],
			inspect: async () => ({ pages: 3, locked: 0 }),
		});
		await frames(3);
		qa(dialog(), ".nb-xfer-pick")[0]?.click();
		await sleep(80);
		await frames(2);
	}
	await sleep(300);
	await frames(2);
}

/** What the harness page exposes (wired in harness.ts with one statement). */
export function xferApi(api: XferCheckApi): Record<string, unknown> {
	return {
		checkXfer: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkXfer(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`xfer check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		xferShot: (state: XferState) => xferShot(api, state),
		closeXfer,
		xferStates: [...XFER_STATES],
	};
}
