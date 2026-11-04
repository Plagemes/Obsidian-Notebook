/**
 * Smoke check of "Copy to notebook…" with a link back (0.18, roadmap #186; `doc=linkback`, npm run harness:check): the real
 * dialog driven through the DOM, the real run (copy into a closed notebook through the careful file write) with the files read
 * back, the "Copied to" chips on the originals through a fake edit context (locked page skipped, one undo step), and the
 * notebook map's selection bar with the new button. `linkbackShot(state)` leaves one view open for the screenshots.
 */
import type { App, TFile } from "obsidian";
import { renderThumbnail } from "../../src/library/thumbnail";
import { copyWithLink } from "../../src/library/copy-with-link";
import { askCopyLink, type CopyLinkAnswer } from "../../src/library/copy-with-link-dialog";
import type { TransferEnv } from "../../src/library/page-transfer";
import { soleLink } from "../../src/ink/link-text";
import { createDocument, createId, createPage, createStroke, quantizePoint } from "../../src/model/document";
import { History } from "../../src/model/history";
import { NotebookMapCache } from "../../src/model/notebook-map";
import { parse } from "../../src/model/serialize";
import type { NotebookDocument, Page } from "../../src/model/types";
import { createNotebook } from "../../src/storage/notebooks";
import type { EditContext } from "../../src/view/edit-context";
import { NotebookMapModal } from "../../src/view/notebook-map-modal";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface LinkbackCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

export const LINKBACK_STATES = ["dialog", "map"] as const;
export type LinkbackState = typeof LINKBACK_STATES[number];

const ROOT = "Notebooks";
const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-xfer-copylink");
const mapModal = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-map-modal");
const qa = (root: HTMLElement | null, sel: string) => [...(root?.querySelectorAll<HTMLElement>(sel) ?? [])];
const textOf = (el: Element | null | undefined) => el?.textContent ?? "";

function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

export function closeLinkback(): void {
	for (const el of document.querySelectorAll<HTMLElement>(".modal.nb-xfer-copylink .nb-modal-close, .modal.nb-map-modal .nb-modal-close")) el.click();
	for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
}

const line = (y: number) => createStroke("#1e1e1e", 2, [quantizePoint(40, y, 0.5), quantizePoint(300, y + 12, 0.5), quantizePoint(520, y, 0.5)]);

function notebookDoc(titles: string[], locked: number[] = []): NotebookDocument {
	const doc = createDocument(new Date("2026-11-04T09:00:00.000Z"));
	doc.pages = titles.map((title, i) => {
		const p = createPage();
		for (let k = 0; k < 3; k++) p.strokes.push(line(120 + k * 40));
		p.elements = [{ id: createId(), type: "text", x: 40, y: 70, width: 480, text: title, fontSize: 22, color: "#1e1e1e" }];
		if (locked.includes(i + 1)) p.locked = true;
		return p;
	});
	return doc;
}

async function seed(app: App): Promise<{ physics: TFile; revision: TFile; physicsDoc: NotebookDocument }> {
	for (const f of app.vault.getFiles()) if (f.path.startsWith(`${ROOT}/Linkback`) && f.extension === "notebook") await app.fileManager.trashFile(f);
	if (!app.vault.getFolderByPath(ROOT)) await app.vault.createFolder(ROOT);
	const physicsDoc = notebookDoc(["Kinematics", "Forces and Newton's laws", "Energy", "Momentum", "Waves"], [3]);
	return {
		physics: await createNotebook(app, ROOT, "Linkback Physics", physicsDoc),
		revision: await createNotebook(app, ROOT, "Linkback Revision", notebookDoc(["Exam list", "Formulas"])),
		physicsDoc,
	};
}

const readDoc = async (app: App, f: TFile): Promise<NotebookDocument> => {
	const r = parse(await app.vault.read(f));
	if (!r.ok) throw new Error(r.message);
	return r.doc;
};

/** The edit context of an open notebook, on the document read from its file; commands go through an undo stack. */
function fakeContext(app: App, file: TFile, doc: NotebookDocument): { ctx: EditContext; history: History } {
	const history = new History(() => doc);
	const ctx: EditContext = {
		app, folder: ROOT, file, doc, measure: (s, size) => s.length * size * 0.5, alive: () => true, addPending: () => undefined, removePending: () => undefined,
		currentPage: () => 0, visibleLocal: () => null,
		execute: (cmd) => history.execute(cmd),
		flush: async () => true,
	};
	return { ctx, history };
}

function openDialog(app: App, pages: NotebookDocument, candidates: Array<{ path: string; label: string; folder: string }>, pre: string[]): Promise<CopyLinkAnswer | null> {
	closeLinkback();
	const answer = askCopyLink(app, {
		notebook: "Linkback Physics", preselected: pre, candidates, reverse: false,
		pages: pages.pages.map((p, i) => ({ id: p.id, number: i + 1, excerpt: p.elements?.[0]?.type === "text" ? p.elements[0].text : "", locked: p.locked === true })),
		inspect: async () => ({ pages: 2 }),
	});
	adopt();
	return answer;
}

export async function checkLinkback(api: LinkbackCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		await runChecks(api, add);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	closeLinkback();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

async function runChecks(api: LinkbackCheckApi, add: (name: string, ok: unknown, detail?: string) => void): Promise<void> {
	const app = api.app as App;
	const { physics, revision, physicsDoc } = await seed(app);
	const env: TransferEnv = { app, settings: () => ({ folder: ROOT }) as never };
	const candidates = [{ path: revision.path, label: "Linkback Revision", folder: "" }, { path: `${ROOT}/Maths.notebook`, label: "Maths", folder: "" }];

	// --- the dialog
	const answerP = openDialog(app, physicsDoc, candidates, [physicsDoc.pages[1]!.id]);
	await frames(3);
	const m = dialog();
	const primary = () => dialog()?.querySelector<HTMLButtonElement>(".nb-modal-foot .nb-modal-btn:last-child") ?? null;
	add("dialog: a row per page, the preselected one ticked", qa(m, ".nb-xfer-page").length === 5 && qa(m, ".nb-xfer-page input").filter((i) => (i as HTMLInputElement).checked).length === 1);
	add("dialog: the button waits for a notebook", primary()?.disabled === true, textOf(dialog()?.querySelector(".nb-xfer-status")));
	qa(m, ".nb-xfer-pick")[0]?.click();
	await sleep(80);
	await frames(2);
	const where = m!.querySelector<HTMLSelectElement>("#nb-xfer-copy-at")!;
	add("dialog: the places are the start, between pages and the end", [...where.options].map((o) => o.text).join("|") === "At the start|After page 1|At the end", [...where.options].map((o) => o.text).join("|"));
	add("dialog: the end is chosen at first", where.value === "2");
	add("dialog: the button is enabled and says copy", primary()?.disabled === false && /Copy/.test(textOf(primary())), textOf(primary()));
	add("dialog: targets are at least 40 px", qa(dialog(), "button, input[type='text'], select").filter((el) => el.offsetParent !== null).every((el) => el.getBoundingClientRect().height >= 39.5),
		qa(dialog(), "button").filter((el) => el.getBoundingClientRect().height < 39.5).map((el) => el.className).join(", "));
	add("dialog: no button shows Obsidian's default look", obsidianStyledButtons(dialog()!).length === 0);
	add("dialog: stays inside the screen", (() => { const r = dialog()!.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })());
	where.value = "1";
	const reverseBox = qa(m, "input[type='checkbox']").find((b) => !b.closest(".nb-xfer-page")) as HTMLInputElement | undefined;
	if (reverseBox && !reverseBox.checked) reverseBox.click();
	primary()?.click();
	const answer = await answerP;
	add("dialog: the answer has the page, the notebook, the place and the second link", !!answer && answer.pageIds.length === 1 && answer.dest === revision.path && answer.at === 1 && answer.reverse, JSON.stringify(answer));

	// --- the run: pages 2 and 3 (3 is locked) into the closed Revision notebook after page 1, with the chips on the originals
	const open = await readDoc(app, physics);
	const { ctx, history } = fakeContext(app, physics, open);
	const ids = [open.pages[1]!.id, open.pages[2]!.id];
	const out = await copyWithLink(env, ctx, { pageIds: ids, dest: revision, at: 1, reverse: true });
	add("run: two pages copied, one original locked and left alone", out.copied === 2 && out.reversed === 1 && out.skippedLocked === 1 && !out.reverseFailed, JSON.stringify(out));
	const dest = await readDoc(app, revision);
	add("run: the copies are in the middle of the destination with new ids", dest.pages.length === 4 && dest.pages[1]!.id !== ids[0] && dest.pages[2]!.id !== ids[1], dest.pages.map((p) => p.id.slice(0, 4)).join(","));
	const chipOf = (p: Page) => (p.elements ?? []).filter((e) => e.type === "text" && e.fontSize === 9);
	const fromChip = chipOf(dest.pages[1]!)[0];
	const link = fromChip && fromChip.type === "text" ? soleLink(fromChip.text) : null;
	add("run: the first copy carries a small link back to page 2 of the original", !!link && link.display === "Copied from Linkback Physics p.2" && link.subpath.startsWith("p2&id=") && link.subpath.endsWith(ids[0]!), link?.display ?? "none");
	add("run: the chip sits in the top margin", !!fromChip && fromChip.y < 40 && fromChip.x < 60);
	add("run: the other pages of the destination are untouched", chipOf(dest.pages[0]!).length === 0 && chipOf(dest.pages[3]!).length === 0);
	add("run: the locked copy is still locked", dest.pages[2]!.locked === true);
	const back = open.pages[1]!.elements?.find((e) => e.type === "text" && e.fontSize === 9);
	const backLink = back && back.type === "text" ? soleLink(back.text) : null;
	add("run: the original has a link to its copy, as one undo step", !!backLink && backLink.subpath.endsWith(dest.pages[1]!.id) && /^Copied to Linkback Revision p\.2$/.test(backLink.display) && history.canUndo(), backLink?.display ?? "none");
	add("run: the locked original got no chip", chipOf(open.pages[2]!).length === 0);
	history.undo();
	add("run: undo takes the chip off the original", chipOf(open.pages[1]!).length === 0);
	add("run: the source file is unchanged", (await readDoc(app, physics)).pages.length === 5);

	// --- a second copy of the same page stacks the chip under the first
	await copyWithLink(env, fakeContext(app, physics, await readDoc(app, physics)).ctx, { pageIds: [ids[0]!], dest: revision, at: 0, reverse: false });
	const again = await readDoc(app, revision);
	add("run: a second copy is a new page with its own chip", again.pages.length === 5 && chipOf(again.pages[0]!).length === 1);
}

export async function linkbackShot(api: LinkbackCheckApi, state: LinkbackState): Promise<void> {
	const app = api.app as App;
	const { revision, physicsDoc } = await seed(app);
	closeLinkback();
	if (state === "map") {
		const cache = new NotebookMapCache();
		new NotebookMapModal(app, {
			map: () => cache.build(physicsDoc.pages), pages: () => physicsDoc.pages, current: () => 1,
			thumbnail: (p: Page) => renderThumbnail(p, 200, { mime: "image/jpeg", quality: 0.7 }),
			goTo: () => undefined, extract: () => undefined, split: () => undefined, copyTo: () => undefined,
		}).open();
		adopt();
		await frames(3);
		qa(mapModal(), ".nb-map-select")[0]?.click();
		await frames(2);
		qa(mapModal(), ".nb-map-card")[1]?.click();
		qa(mapModal(), ".nb-map-card")[3]?.click();
		await sleep(400);
		await frames(2);
		return;
	}
	void openDialog(app, physicsDoc, [{ path: revision.path, label: "Linkback Revision", folder: "" }, { path: `${ROOT}/Biology/Anatomy.notebook`, label: "Anatomy", folder: "Biology" }, { path: `${ROOT}/Maths.notebook`, label: "Maths", folder: "" }], [physicsDoc.pages[1]!.id, physicsDoc.pages[3]!.id]);
	await frames(3);
	qa(dialog(), ".nb-xfer-pick")[0]?.click();
	await sleep(120);
	await frames(2);
}

/** What the harness page exposes (wired in harness.ts with one statement). */
export function linkbackApi(api: LinkbackCheckApi): Record<string, unknown> {
	return {
		checkLinkback: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkLinkback(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`linkback check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		linkbackShot: (state: LinkbackState) => linkbackShot(api, state),
		closeLinkback,
		linkbackStates: [...LINKBACK_STATES],
	};
}
