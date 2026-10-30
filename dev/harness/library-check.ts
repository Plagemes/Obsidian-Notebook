/**
 * 0.12 design system: Home and the library in the browser harness (doc=library&surface=home|library), on a seeded demo
 * vault: four subjects (Anatomia, Fisiologia, Biomateriali, Matematica), notebooks with tags, favourites, open markers,
 * a PDF notebook, recent page edits and three Inbox items for the bell. `checkLibrary()` checks the layout (no sideways
 * scroll, 40 px targets, the sections of the surface); `libraryInteractions()` drives the rail, the quick actions, the
 * bell, search and the favourite star, and leaves the screen as it found it.
 */
import { WorkspaceLeaf, type App } from "./obsidian-stub";
import { LibraryView, type LibraryHost } from "../../src/library/library-view";
import { HomeView } from "../../src/library/home-view";
import type { InboxPort } from "../../src/library/inbox-bell";
import type { InboxItem } from "../../src/zettel/inbox";
import { createDocument, createId, createPage, createStroke } from "../../src/model/document";
import { createPdfPages } from "../../src/model/pages";
import { parse, serialize } from "../../src/model/serialize";
import type { NotebookDocument, NotebookMeta } from "../../src/model/types";
import { FAKE_ASSET, FAKE_PAGE, FAKE_PATH, installFakePdf } from "./fake-pdf";
import type { WorkspaceLeaf as ObsidianLeaf } from "obsidian";

const DAY = 24 * 3600 * 1000;
const ROOT = "Notebooks";

interface Spec {
	folder: string;
	name: string;
	tags: string[];
	favorite?: boolean;
	pages?: number;
	createdDaysAgo: number;
	modifiedHoursAgo: number;
	pdf?: boolean;
	question?: boolean;
	bookmark?: string;
	cover?: string;
}

const SPECS: Spec[] = [
	{ folder: "Anatomia", name: "Anatomia dell'arto superiore", tags: ["Anatomia", "Esame"], favorite: true, pages: 6, createdDaysAgo: 3, modifiedHoursAgo: 2, bookmark: "Plesso brachiale", cover: "#F0565E" },
	{ folder: "Anatomia", name: "Struttura del tessuto osseo", tags: ["Osso", "Istologia"], pages: 4, createdDaysAgo: 12, modifiedHoursAgo: 26, question: true },
	{ folder: "Anatomia", name: "Sistema nervoso periferico", tags: ["Riassunto"], pages: 3, createdDaysAgo: 40, modifiedHoursAgo: 120 },
	{ folder: "Fisiologia", name: "Fisiologia cardiovascolare", tags: ["Fisiologia", "Cuore"], favorite: true, pages: 5, createdDaysAgo: 6, modifiedHoursAgo: 5, cover: "#2F80F7" },
	{ folder: "Fisiologia", name: "Trasmissione del potenziale d'azione", tags: ["Neuroni", "Domande"], pages: 4, createdDaysAgo: 2, modifiedHoursAgo: 1, question: true },
	{ folder: "Fisiologia", name: "Appunti lezione 5", tags: ["Lezione"], pages: 2, createdDaysAgo: 20, modifiedHoursAgo: 220 },
	{ folder: "Biomateriali", name: "Polimeri biodegradabili", tags: ["Polimeri", "Lezione"], pages: 3, createdDaysAgo: 9, modifiedHoursAgo: 50 },
	{ folder: "Biomateriali", name: "Scaffold e tissue engineering", tags: ["Biomateriali", "Esame"], favorite: true, pdf: true, createdDaysAgo: 15, modifiedHoursAgo: 30 },
	{ folder: "Matematica", name: "Trasformata di Fourier", tags: ["Analisi", "Formula"], pages: 3, createdDaysAgo: 26, modifiedHoursAgo: 70 },
	{ folder: "Matematica", name: "Serie e trasformate", tags: ["Matematica", "Formula"], favorite: true, pages: 4, createdDaysAgo: 33, modifiedHoursAgo: 90, cover: "#16C2A3" },
	{ folder: "Matematica", name: "Esercizi di analisi", tags: ["Esame", "Domande"], pages: 2, createdDaysAgo: 50, modifiedHoursAgo: 400 },
	{ folder: "", name: "Appunti generali", tags: ["Riassunto"], pages: 1, createdDaysAgo: 70, modifiedHoursAgo: 600 },
];

function scribble(seed: number, y: number, width: number): number[][] {
	return Array.from({ length: 36 }, (_, i) => {
		const t = i / 35;
		return [60 + t * width, y + Math.sin(t * 14 + seed) * 5 + Math.sin(t * 3 + seed * 2) * 3, 0.5];
	});
}

function inkPage(doc: NotebookDocument, index: number): void {
	const page = index < doc.pages.length ? doc.pages[index]! : createPage();
	if (index >= doc.pages.length) doc.pages.push(page);
	const colors = ["#1e1e1e", "#1d4ed8", "#1e1e1e", "#dc2626"];
	for (let l = 0; l < 7; l++) page.strokes.push(createStroke(colors[l % colors.length]!, 2, scribble(index * 7 + l, 110 + l * 46, 260 + ((l * 53) % 180)) as never, "pen"));
}

function notebook(spec: Spec, now: number): NotebookDocument {
	const doc = createDocument(new Date(now - spec.createdDaysAgo * DAY));
	if (spec.pdf) {
		doc.assets = { [FAKE_ASSET]: { id: FAKE_ASSET, kind: "pdf", path: FAKE_PATH, name: "Scaffold.pdf", bytes: 8 } };
		doc.pages = createPdfPages(doc.assets[FAKE_ASSET]!, [{ ...FAKE_PAGE }, { ...FAKE_PAGE }, { ...FAKE_PAGE }]);
	}
	for (let i = 0; i < (spec.pages ?? (spec.pdf ? 3 : 1)); i++) inkPage(doc, i);
	if (spec.question) doc.pages[0]!.elements = [...(doc.pages[0]!.elements ?? []), { id: createId(), type: "marker", kind: "question", x: 420, y: 90 }];
	const meta: NotebookMeta = { tags: spec.tags, favorite: !!spec.favorite, cover: spec.cover ?? "#3b82f6", bookmarks: [] };
	if (spec.bookmark) {
		const id = doc.pages[1]!.id;
		meta.bookmarks = [id];
		meta.bookmarkInfo = { [id]: { title: spec.bookmark } };
	}
	doc.meta = meta;
	doc.modifiedAt = new Date(now - spec.modifiedHoursAgo * 3600 * 1000).toISOString();
	return doc;
}

export interface LibraryHarness {
	view: LibraryView;
	calls: string[];
	host: LibraryHost;
}

/** Seeds the demo vault and opens Home (surface=home) or the library (surface=library) in the harness leaf. */
export async function openLibraryHarness(app: App, surface: string): Promise<LibraryHarness> {
	const now = Date.now();
	installFakePdf();
	await app.vault.createFolder(ROOT);
	await app.vault.createFolder(`${ROOT}/_assets`);
	await app.vault.createBinary(FAKE_PATH, new Uint8Array(8).buffer);
	const docs = new Map<string, NotebookDocument>();
	for (const folder of ["Anatomia", "Fisiologia", "Biomateriali", "Matematica"]) await app.vault.createFolder(`${ROOT}/${folder}`);
	for (const spec of SPECS) {
		const path = `${ROOT}/${spec.folder ? `${spec.folder}/` : ""}${spec.name}.notebook`;
		const doc = notebook(spec, now);
		docs.set(path, doc);
		await app.vault.create(path, serialize(doc));
	}
	const calls: string[] = [];
	const edits = [...docs.entries()].flatMap(([path, doc], i) => doc.pages.slice(0, 2).map((p, k) => ({ path, page: p.id, num: k + 1, at: now - (i * 5 + k * 2 + 1) * 3600 * 1000 - (i % 3) * 7 * DAY })))
		.sort((a, b) => b.at - a.at);
	const listeners = new Set<() => void>();
	const inboxItems: InboxItem[] = [...docs.entries()].slice(0, 3).map(([path, doc], i) => ({
		key: `harness|${doc.id}|${i}`, source: "loose-sheet", kind: (["block", "pdf-highlight", "marker"] as const)[i]!,
		notebookPath: path, notebookName: path.slice(path.lastIndexOf("/") + 1).replace(/\.notebook$/, ""), notebookId: doc.id, pageId: doc.pages[0]!.id,
		pageIndex: 0, pageSize: { width: 595, height: 842 }, region: null, text: ["Rivedere il plesso brachiale", "", "Chiedere al docente: soglia di eccitazione"][i]!,
		sig: 1, cardType: "permanent", order: i,
	}));
	let open = inboxItems;
	let scanned = false;
	const inbox: InboxPort = {
		open: () => open,
		scanned: () => scanned,
		scan: async () => {
			scanned = true;
			for (const fn of listeners) fn();
		},
		onChange: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		openItem: (item) => calls.push(`inbox-open:${item.key}`),
		discard: async (item) => {
			open = open.filter((x) => x !== item);
			for (const fn of listeners) fn();
			return true;
		},
		openInbox: () => calls.push("inbox-view"),
		processInInbox: () => calls.push("inbox-process"),
	};
	let index: unknown = null;
	const host: LibraryHost = {
		root: () => ROOT,
		readNotebook: async (file) => {
			const r = parse(await app.vault.read(file as unknown as Parameters<App["vault"]["read"]>[0]));
			return r.ok ? r.doc : null;
		},
		openNotebook: async (file, page) => void calls.push(`open:${file.path}${page === undefined ? "" : `#${page}`}`),
		createNotebook: (folder) => void calls.push(`create:${folder}`),
		importPdf: (folder) => void calls.push(`import-pdf:${folder}`),
		scanToNotebook: (folder) => void calls.push(`scan:${folder}`),
		lectureFromSlides: (folder) => void calls.push(`lecture:${folder}`),
		updateMeta: async (file, patch) => {
			const f = file as unknown as Parameters<App["vault"]["read"]>[0];
			const r = parse(await app.vault.read(f));
			if (!r.ok) throw new Error("unreadable");
			r.doc.meta = { ...r.doc.meta!, ...patch };
			await app.vault.modify(f, serialize(r.doc));
			calls.push(`meta:${file.path}:${JSON.stringify(patch)}`);
		},
		loadIndex: async () => index,
		saveIndex: async (data) => {
			index = data;
		},
		runAction: (id) => {
			calls.push(`action:${id}`);
			return true;
		},
		openSettings: () => void calls.push("settings"),
		recentEdits: () => edits,
		openRecentPages: () => void calls.push("recent-pages"),
		checkLibrary: () => void calls.push("library-check"),
		inbox: () => inbox,
	};
	const root = document.getElementById("harness-app")!;
	root.empty();
	const leaf = new WorkspaceLeaf(app, root);
	const asLeaf = leaf as unknown as ObsidianLeaf;
	const view = surface === "home" ? new HomeView(asLeaf, host) : new LibraryView(asLeaf, host);
	await view.onOpen();
	// Reading the twelve notebooks, then the thumbnails and the bell's first look.
	for (let i = 0; i < 100 && document.querySelectorAll(".notebook-lib-status:not(:empty)").length > 0; i++) await wait(50);
	await wait(900);
	return { view, calls, host };
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};

type Result = { name: string; ok: boolean; detail: string };

function visible(el: Element): el is HTMLElement {
	const h = el as HTMLElement;
	if (!h.offsetParent && getComputedStyle(h).position !== "fixed") return false;
	const r = h.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

/** Layout checks of the surface on screen (no state change). */
export function checkLibraryLayout(surface: string): Result[] {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `${surface} ${window.innerWidth}px: ${name}`, ok, detail });
	const app = document.querySelector<HTMLElement>(".nb-app");
	add("the view is built", !!app);
	if (!app) return out;
	const scroll = app.querySelector<HTMLElement>(".nb-scroll")!;
	add("no sideways scroll", document.documentElement.scrollWidth <= window.innerWidth + 1 && scroll.scrollWidth <= scroll.clientWidth + 1, `${scroll.scrollWidth} / ${scroll.clientWidth}`);
	const small = Array.from(app.querySelectorAll("button, [role='button'], input")).filter(visible)
		.filter((el) => !el.closest(".notebook-lib-card") && !el.closest(".nb-rail"))
		.filter((el) => {
			const r = el.getBoundingClientRect();
			return Math.min(r.width, r.height) < 39.5 && !el.classList.contains("nb-search-input");
		});
	add("targets are at least 40 px", small.length === 0, small.slice(0, 5).map((el) => `${el.className || el.tagName} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).join(", "));
	const rail = Array.from(app.querySelectorAll(".nb-rail button")).filter(visible).filter((el) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) < 35.5);
	add("rail targets are at least 36 px", rail.length === 0, rail.slice(0, 3).map((el) => el.className).join(", "));
	const count = (sel: string) => Array.from(app.querySelectorAll(sel)).filter(visible).length;
	const phone = app.classList.contains("is-phone");
	add("the rail matches the width", phone ? !visible(app.querySelector(".nb-rail")!) || !app.classList.contains("is-rail-open") : count(".nb-rail-item") >= 6, app.className);
	add("the bell shows the 3 open Inbox items", app.querySelector(".nb-bell .nb-badge")?.textContent === "3", app.querySelector(".nb-bell .nb-badge")?.textContent ?? "no bell");
	if (surface === "home") {
		add("4 subject cards", count(".nb-home-subjects .nb-subject-card") === 4, String(count(".nb-home-subjects .nb-subject-card")));
		add("recent notes (5 rows)", count(".nb-home-recent .nb-list-row") === 5, String(count(".nb-home-recent .nb-list-row")));
		add("4 KPI tiles", count(".nb-kpi") === 4, String(count(".nb-kpi")));
		add("quick actions", count(".nb-quick") === 4, String(count(".nb-quick")));
		const created = app.querySelector('[data-key="kpi:created"] .nb-kpi-value')?.textContent;
		add("notebooks created in 4 weeks is counted", created === "8", created ?? "");
	} else {
		add("6 filter chips", count(".nb-chips .nb-chip") === 6, String(count(".nb-chips .nb-chip")));
		add("4 subject cards", count(".nb-lib-subjects .nb-subject-card") === 4, String(count(".nb-lib-subjects .nb-subject-card")));
		const collections = Array.from(app.querySelectorAll<HTMLElement>(".nb-lib-collections .nb-quick")).map((el) => el.dataset.key);
		add("smart collections with content", ["collection:study", "collection:favourites", "collection:pdf", "collection:recent", "collection:exams"].every((k) => collections.includes(k)), collections.join());
		add("frequent tags", count(".nb-lib-tags .nb-chip") >= 8, String(count(".nb-lib-tags .nb-chip")));
		add("recent notebooks (5 rows)", count(".nb-lib-recent .nb-list-row") === 5, String(count(".nb-lib-recent .nb-list-row")));
		add("favourite rows (4)", count(".nb-lib-favourites .nb-fav-row") === 4, String(count(".nb-lib-favourites .nb-fav-row")));
		add("all notebooks grid", app.querySelectorAll(".nb-all .notebook-lib-card").length === 12, String(app.querySelectorAll(".nb-all .notebook-lib-card").length));
		// Thumbnails are drawn when a row scrolls into view.
		const favTop = app.querySelector(".nb-lib-favourites")?.getBoundingClientRect().top ?? Infinity;
		const thumbs = Array.from(app.querySelectorAll(".nb-lib-favourites .nb-fav-thumb img")).length;
		if (favTop < window.innerHeight - 120) add("favourite rows show page thumbnails", thumbs >= 1, String(thumbs));
	}
	return out;
}

function click(el: Element | null | undefined): void {
	(el as HTMLElement | null)?.click();
}

/** Drives the controls (rail, quick action, bell, search, star) and returns to the starting surface. */
/** A state for a review screenshot: "bell" (inbox popover open), "search" (grouped results), "list" (list mode), "reset". */
export async function libraryState(state: string): Promise<boolean> {
	const app = document.querySelector<HTMLElement>(".nb-app");
	if (!app) return false;
	const input = app.querySelector<HTMLInputElement>(".nb-search-input")!;
	const toggle = () => app.querySelector<HTMLElement>(".nb-header-buttons [aria-pressed]");
	if (state === "reset") {
		document.querySelector<HTMLElement>(".nb-sheet-backdrop")?.click();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		if (input.value) {
			input.value = "";
			input.dispatchEvent(new Event("input"));
			await wait(300);
		}
		if (app.classList.contains("is-list")) click(toggle());
	} else if (state === "bell") {
		click(app.querySelector(".nb-bell"));
	} else if (state === "search") {
		input.value = "fisiologia";
		input.dispatchEvent(new Event("input"));
		await wait(400);
	} else if (state === "list") {
		if (!toggle()) click(app.querySelector('.nb-rail [data-key="nav:all"]'));
		await frames(2);
		click(toggle());
	}
	await frames(3);
	await wait(150);
	return true;
}

export async function libraryInteractions(h: LibraryHarness, surface: string): Promise<Result[]> {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `${surface} interactions: ${name}`, ok, detail });
	const app = () => document.querySelector<HTMLElement>(".nb-app")!;
	const go = async (key: string) => {
		const phone = app().classList.contains("is-phone");
		if (phone) click(app().querySelector(".nb-rail-toggle"));
		click(app().querySelector(`.nb-rail [data-key="${key}"]`));
		await frames(3);
	};
	// The bell: popover with the three items; discarding one updates the badge.
	click(app().querySelector(".nb-bell"));
	await frames(2);
	const pop = document.querySelector(".nb-inbox-pop");
	add("the bell opens the inbox popover with 3 rows", !!pop && pop.querySelectorAll(".nb-inbox-row").length === 3, String(pop?.querySelectorAll(".nb-inbox-row").length));
	click(pop?.querySelector(".nb-pop-footer"));
	add("Open inbox opens the Inbox view", h.calls.includes("inbox-view") && !document.querySelector(".nb-inbox-pop"), h.calls.join());
	// Quick actions and the rail.
	await go("nav:home");
	click(app().querySelector('[data-key="quick:new-notebook"]'));
	add("New notebook runs the registry action", h.calls.includes("action:new-notebook"), h.calls.join());
	click(app().querySelector('[data-key="quick:new-folder"]'));
	add("New folder runs the registry action", h.calls.includes("action:new-folder"), h.calls.join());
	await go("nav:all");
	add("the rail switches to the library", !!app().querySelector(".nb-chips"), "");
	click(app().querySelector('[data-key="collection:pdf"]'));
	await frames(3);
	add("Con PDF lists the PDF notebook", app().querySelectorAll(".notebook-lib-card").length === 1, String(app().querySelectorAll(".notebook-lib-card").length));
	click(app().querySelector('[data-key="chip:all"]'));
	await frames(3);
	// The favourite star writes the notebook.
	const star = app().querySelector<HTMLElement>(".nb-lib-favourites .nb-star");
	click(star);
	await wait(300);
	add("the star toggles the favourite (written to the file)", h.calls.some((c) => c.startsWith("meta:") && c.includes('"favorite":false')), h.calls.filter((c) => c.startsWith("meta:")).join());
	// Search: grouped results (folders, tags, notebooks).
	const input = app().querySelector<HTMLInputElement>(".nb-search-input")!;
	input.value = "fisiologia";
	input.dispatchEvent(new Event("input"));
	await wait(400);
	const groups = Array.from(app().querySelectorAll(".nb-search-group .nb-section-title")).map((x) => x.textContent);
	add("search groups folders, tags and notebooks", groups.length === 3, groups.join(" | "));
	input.value = "";
	input.dispatchEvent(new Event("input"));
	await wait(300);
	// List mode.
	click(app().querySelector('.nb-header-buttons [aria-pressed]'));
	await frames(3);
	add("the view toggle switches to a list", app().classList.contains("is-list"), app().className);
	click(app().querySelector('.nb-header-buttons [aria-pressed]'));
	await frames(2);
	// Back to where it started.
	await go(surface === "home" ? "nav:home" : "nav:all");
	app().querySelector<HTMLElement>(".nb-scroll")!.scrollTop = 0;
	return out;
}
