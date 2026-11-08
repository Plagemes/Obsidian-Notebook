/**
 * Smoke check of the global bookmarks (0.24, roadmap #265) on the `doc=bookmarks` notebook (the outline notebook, five
 * pages; npm run harness:check): the real view with an in-memory `_meta` folder. A page is bookmarked from the registry
 * (the page sheet / command, a toggle), pages of other notebooks, a page that is gone and a notebook that is missing are
 * added to the store, the dialog lists them (missing ones drawn dashed with a badge), a tap opens the notebook at the page,
 * a row is renamed, reordered and removed, a notebook that moved is found again by its id, Home's chip opens the dialog, and
 * no notebook is ever changed. It leaves the dialog open for the screenshot (dev/harness/dist/shots/bookmarks-*.png).
 */
import type { App, TFile } from "obsidian";
import { BookmarksStore } from "../../src/library/bookmarks-store";
import { renderHome } from "../../src/library/home-surface";
import { parse } from "../../src/model/serialize";
import { readNotebookText } from "../../src/storage/format";
import type { DeviceFileAdapter } from "../../src/storage/device-files";
import { BookmarksService } from "../../src/view/bookmarks-service";
import { openBookmarks } from "../../src/view/bookmarks-dialog";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface BookmarksCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

const adapter = new MemoryAdapter();
const opened: Array<{ path: string; page: number; pageId: string }> = [];
let service: BookmarksService | null = null;
let appRef: App | null = null;
const store = new BookmarksStore(adapter, () => "Notebooks", "0a000000");

/** The service the harness gives the view when `doc=bookmarks` (in-memory files, a recorded opener). */
export function harnessBookmarks(app: unknown): BookmarksService {
	const a = app as App;
	appRef = a;
	const read = async (file: TFile) => {
		try {
			const r = parse(readNotebookText(file.extension, await a.vault.read(file)));
			return r.ok ? r.doc : null;
		} catch {
			return null;
		}
	};
	service ??= new BookmarksService({
		app: a,
		store,
		readNotebook: read,
		readNotebookId: async (file) => (await read(file))?.id ?? null,
		notebooksFolder: () => "Notebooks",
		openAt: (file: TFile, page: number, pageId: string) => {
			opened.push({ path: file.path, page, pageId });
			return Promise.resolve();
		},
	});
	return service;
}

interface BookView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	quickApi(): { jump(i: number): void; docId(): string | null };
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { page?: { globalBookmark?: boolean } | null } : never;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function checkBookmarks(api: BookmarksCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as BookView;
	const svc = service!;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".nb-gbm-modal .nb-gbm-row")];
	const titles = (): string[] => rows().map((r) => r.querySelector(".nb-gbm-title")?.textContent ?? "");
	const settle = async () => {
		await frames(3);
		await sleep(120);
		await frames(2);
	};
	const goTo = async (i: number) => {
		v.quickApi().jump(i);
		await frames(4);
		await sleep(60);
	};
	const docText = (): string => JSON.stringify(v.document);
	const before = docText();
	const docId = v.quickApi().docId()!;
	await store.load();

	// --- toggle from the page sheet / command ---
	await goTo(1);
	add("the page is not bookmarked at first", v.uiContext().page?.globalBookmark === false);
	v.runAction("page-global-bookmark");
	await settle();
	add("the action bookmarks the page in view", svc.count() === 1 && v.uiContext().page?.globalBookmark === true, `${svc.count()}`);
	const first = svc.list()[0]!;
	add("it stores the notebook path and id, the page id and the number", first.path === "Notebooks/Outline.notebook" && first.docId === docId && first.num === 2 && first.pageId.length > 0, JSON.stringify(first));
	v.runAction("page-global-bookmark");
	await settle();
	add("the same action again removes it", svc.count() === 0 && v.uiContext().page?.globalBookmark === false);
	v.runAction("page-global-bookmark");
	await settle();
	await goTo(3);
	v.runAction("page-global-bookmark");
	await settle();
	add("two pages of this notebook", svc.count() === 2);

	// --- pages of other notebooks, a page that is gone, a notebook that is missing, a notebook that moved ---
	await store.add({ docId: "doc-new", path: "Notebooks/New.notebook", pageId: "formulas-1", num: 1, label: "Formulas" });
	await store.add({ docId: docId, path: "Notebooks/Outline.notebook", pageId: "gone-page", num: 2, label: "" });
	await store.add({ docId: "doc-nowhere", path: "Notebooks/Lost/Gone.notebook", pageId: "x", num: 4, label: "Lab report" });
	await store.add({ docId, path: "Notebooks/Moved/Outline.notebook", pageId: (v.document as unknown as { pages: Array<{ id: string }> }).pages[4]!.id, num: 5, label: "Moved copy" });
	await settle();

	// --- the dialog ---
	openBookmarks(appRef!, svc);
	await settle();
	add("the dialog lists every bookmark", rows().length === 6, titles().join("|"));
	add("a row says the notebook and the page", rows()[0]?.querySelector(".nb-gbm-detail")?.textContent?.includes("page 2") === true, rows()[0]?.textContent ?? "");
	const missing = rows().filter((r) => r.classList.contains("is-missing"));
	add("the gone pages and the missing notebook are drawn as missing, with a badge", missing.length === 3 && missing.every((r) => !!r.querySelector(".nb-gbm-badge")), `${missing.length}`);
	add("a notebook that moved is found again by its id", !!rows()[5] && !rows()[5]!.classList.contains("is-missing"), rows()[5]?.className ?? "");
	add("a missing row can still be removed and moved", missing.every((r) => !!r.querySelector(".nb-gbm-remove:not(:disabled)")));
	add("every action is a labelled control", [...document.querySelectorAll<HTMLButtonElement>(".nb-gbm-modal .nb-gbm-actions button")].every((b) => !!b.getAttribute("aria-label")));
	const touch = [...document.querySelectorAll<HTMLElement>(".nb-gbm-modal .nb-gbm-actions button")].map((b) => Math.round(b.getBoundingClientRect().height));
	add("the action buttons are touch-sized", touch.length > 0 && Math.min(...touch) >= 28, touch.join(","));

	// --- tap opens the notebook at the page ---
	rows()[2]?.querySelector<HTMLButtonElement>(".nb-gbm-main")?.click();
	await settle();
	add("a tap opens the other notebook at the page", opened.length === 1 && opened[0]!.path === "Notebooks/New.notebook" && opened[0]!.pageId === "formulas-1", JSON.stringify(opened));
	add("the dialog closed", !document.querySelector(".nb-gbm-modal"));

	// --- the moved notebook opens from its real path ---
	await svc.open(svc.list().find((b) => b.label === "Moved copy")!);
	add("a bookmark of a moved notebook opens it from where it is now", opened.length === 2 && opened[1]!.path === "Notebooks/Outline.notebook", JSON.stringify(opened[1]));
	await settle();
	add("and the bookmark follows it", svc.list().find((b) => b.label === "Moved copy")?.path === "Notebooks/Outline.notebook");
	const noticesBefore = api.notices.length;
	await svc.open(svc.list().find((b) => b.label === "Lab report")!);
	add("a missing notebook says so and opens nothing", opened.length === 2 && api.notices.length > noticesBefore && /not found/.test(api.notices[api.notices.length - 1] ?? ""), api.notices[api.notices.length - 1] ?? "");

	// --- rename, reorder, remove, from the dialog ---
	openBookmarks(appRef!, svc);
	await settle();
	const firstTitle = titles()[0];
	rows()[0]?.querySelector<HTMLButtonElement>(".nb-gbm-down")?.click();
	await settle();
	add("a row moves down", titles()[1] === firstTitle && titles()[0] !== firstTitle, titles().join("|"));
	add("the first row cannot move up, the last cannot move down", rows()[0]?.querySelector<HTMLButtonElement>(".nb-gbm-up")?.disabled === true && rows()[rows().length - 1]?.querySelector<HTMLButtonElement>(".nb-gbm-down")?.disabled === true);
	await svc.rename(svc.list()[0]!.id, "Exam notes");
	await settle();
	add("a rename shows in the list", titles()[0] === "Exam notes", titles().join("|"));
	const lab = rows().find((r) => r.querySelector(".nb-gbm-title")?.textContent === "Lab report");
	lab?.querySelector<HTMLButtonElement>(".nb-gbm-remove")?.click();
	await settle();
	add("a missing row is removed", rows().length === 5 && !titles().includes("Lab report"), titles().join("|"));

	// --- Home's chip ---
	const home = document.body.createDiv({ cls: "nb-ui" });
	renderHome(home, {
		dynamic: svc.count() > 0 ? [{ id: "bookmarks", icon: "bookmark", label: "Bookmarks", count: svc.count(), onClick: () => openBookmarks(appRef!, svc) }] : [],
		continue: null, empty: null, quickPage: null, quick: [], subjects: [], moreSubjects: null,
		createSubject: { icon: "folder-plus", title: "New folder", onRun: () => undefined }, recent: null, stats: null,
	});
	const chip = home.querySelector<HTMLElement>('[data-key="dyn:bookmarks"], .nb-chip');
	add("Home has a Bookmarks chip with the count", !!chip && (chip.textContent ?? "").includes("Bookmarks") && (chip.textContent ?? "").includes("5"), chip?.textContent ?? "missing");
	const dialogs = document.querySelectorAll(".nb-gbm-modal").length;
	chip?.click();
	await settle();
	add("the chip opens the list", document.querySelectorAll(".nb-gbm-modal").length === dialogs + 1);
	home.remove();

	// --- never in the notebook ---
	add("the notebook was not changed by any of it", docText() === before);
	const file = [...adapter.files.entries()].find(([p]) => p.endsWith("/_meta/bookmarks-0a000000.json"));
	add("the bookmarks are in this device's _meta file", !!file && file[1].includes('"format":"obsidian-notebook-bookmarks"'), file?.[0] ?? "no file");
	add("no script errors", api.errors.length === 0, api.errors.join("; "));

	// leave one dialog open for the screenshot (close the extra one)
	const open = [...document.querySelectorAll<HTMLElement>(".nb-gbm-modal")];
	open.slice(0, -1).forEach((m) => m.querySelector<HTMLButtonElement>(".nb-modal-close")?.click());
	const last = open[open.length - 1];
	if (last && !last.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(last);
	await settle();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { titles: titles() } };
}
