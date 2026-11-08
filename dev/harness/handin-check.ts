/**
 * Smoke check of "Hand in…" (0.24, roadmap #334, `doc=handin`, `HARNESS_DOC=handin npm run harness:check`): the real HandInModal over a five-page
 * demo notebook (a blank page, an open gap, an unticked box). It checks the page grid and its default, the live pre-flight rows, "leave out the
 * blank pages", "export anyway", the remembered name, and the PDF written through a stand-in vault (cover first, a free name each time).
 * `handinShot("dialog" | "cover")` leaves the dialog, or the cover page, on screen for the screenshots.
 */
import { TFile, type App } from "obsidian";
import { pageToSvg } from "../../src/ink/export-svg";
import { createPage, createStroke, quantizePoint } from "../../src/model/document";
import { coverPage } from "../../src/model/hand-in";
import { createCheckbox } from "../../src/model/checklist";
import { createMarker } from "../../src/model/markers";
import { PAGE_SIZES, type Page, type Point } from "../../src/model/types";
import { HandInModal, loadHandInName, runHandIn, saveHandInName, type HandInHost } from "../../src/view/hand-in";
import type { CheckResult } from "./reading-check";

export interface HandInCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

let open: { root: HTMLElement; close: () => void } | null = null;

function closeAll(): void {
	const h = open;
	open = null;
	if (!h) return;
	try {
		h.close();
	} catch {
		// Already closed.
	}
	h.root.remove();
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const buttonNamed = (root: HTMLElement, re: RegExp): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => re.test(x.textContent ?? ""));

const scribble = (y: number): ReturnType<typeof createStroke> => {
	const pts: Point[] = Array.from({ length: 14 }, (_, i) => quantizePoint(110 + i * 14, y + Math.sin(i / 2) * 7, 0.3 + (i % 5) / 8));
	return createStroke("#1e1e1e", 3, pts, "pen");
};

function demoPages(): Page[] {
	const pages = Array.from({ length: 5 }, () => createPage(PAGE_SIZES.a4));
	pages[0]!.strokes.push(scribble(160), scribble(200));
	pages[1]!.strokes.push(scribble(180));
	pages[1]!.elements = [createMarker("gap", 120, 300, { text: "Fill in the proof" })];
	// pages[2] stays blank.
	pages[3]!.strokes.push(scribble(220));
	pages[3]!.elements = [createCheckbox(130, 320, PAGE_SIZES.a4)];
	pages[4]!.strokes.push(scribble(140), scribble(170));
	return pages;
}

interface Written {
	path: string;
	bytes: ArrayBuffer;
}

function standIn(app: unknown, written: Written[], store: Map<string, unknown>): App {
	return Object.assign(Object.create(app as object) as object, {
		vault: {
			getAbstractFileByPath: (path: string) => (written.some((w) => w.path === path) ? {} : null),
			createBinary: (path: string, bytes: ArrayBuffer) => { written.push({ path, bytes }); return Promise.resolve({ path }); },
		},
		saveLocalStorage: (k: string, v: unknown) => { store.set(k, v); },
		loadLocalStorage: (k: string) => store.get(k) ?? null,
	}) as unknown as App;
}

function host(app: App, pages: Page[], gone: number[]): HandInHost {
	const made: unknown = Object.assign(Object.create(TFile.prototype) as object, { basename: "Analysis notes", parent: { path: "Notebooks" }, path: "Notebooks/Analysis notes.notebook" });
	if (!(made instanceof TFile)) throw new Error("harness: could not build the demo file");
	return {
		app, file: made, pages: () => pages, picked: [], current: 1, course: "Analysis 2", media: null, options: () => ({}),
		goToPage: (i) => { gone.push(i); },
	};
}

function openDialog(h: HandInHost): HTMLElement {
	closeAll();
	const m = new HandInModal(h);
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

const rows = (root: HTMLElement): string[] => [...root.querySelectorAll<HTMLElement>(".nb-handin-finding")].map((r) => r.textContent ?? "");
const checked = (root: HTMLElement): number => root.querySelectorAll<HTMLInputElement>(".nb-handin-cell input:checked").length;
const pdfPages = (bytes: ArrayBuffer): number => (new TextDecoder("latin1").decode(bytes).match(/\/Type \/Page\b/g) ?? []).length;

export async function checkHandIn(api: HandInCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const written: Written[] = [];
	const store = new Map<string, unknown>();
	const app = standIn(api.app, written, store);
	const pages = demoPages();
	const gone: number[] = [];
	const h = host(app, pages, gone);

	saveHandInName(app, "  Ada   Lovelace ");
	add("the name is remembered, cleaned, on this device", loadHandInName(app) === "Ada Lovelace", loadHandInName(app));

	let root = openDialog(h);
	await sleep(200);
	add("the grid shows every page", root.querySelectorAll(".nb-handin-cell").length === 5);
	add("only the current page is chosen at first", checked(root) === 1 && (root.querySelectorAll<HTMLInputElement>(".nb-handin-cell input")[1]?.checked ?? false));
	for (let k = 0; k < 40 && [...root.querySelectorAll<HTMLImageElement>(".nb-handin-thumb img")].some((i) => !i.src.startsWith("data:")); k++) await sleep(100);
	add("the thumbnails are drawn", [...root.querySelectorAll<HTMLImageElement>(".nb-handin-thumb img")].filter((i) => i.src.startsWith("data:")).length === 5);
	add("the remembered name fills the field", [...root.querySelectorAll<HTMLInputElement>(".nb-handin-cover input")].some((i) => i.value === "Ada Lovelace"));
	add("the course comes from the timetable", [...root.querySelectorAll<HTMLInputElement>(".nb-handin-cover input")].some((i) => i.value === "Analysis 2"));
	add("an open gap on the chosen page is listed", rows(root).some((r) => /Gaps/.test(r)), rows(root).join("|"));
	buttonNamed(root, /^All$/)?.click();
	await sleep(40);
	add("All chooses every page", checked(root) === 5);
	const list = rows(root);
	add("the blank page and the open items are listed", list.some((r) => /Blank page/.test(r)) && list.some((r) => /Gaps/.test(r)) && list.some((r) => /not ticked/.test(r)), list.join("|"));
	add("the main button says Export anyway", !!buttonNamed(root, /Export anyway/));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	buttonNamed(root, /Leave out the blank pages/)?.click();
	await sleep(40);
	add("leaving out the blank pages unticks only that page", checked(root) === 4 && rows(root).every((r) => !/Blank page/.test(r)));
	root.querySelector<HTMLElement>(".nb-handin-finding.is-gap")?.click();
	await sleep(60);
	add("a finding takes you to its page and closes the dialog", gone.length === 1 && gone[0] === 1, String(gone));
	closeAll();

	// The export.
	const p1 = await runHandIn(h, { pages: [0, 1, 3, 4], fields: { name: "Ada Lovelace", course: "Analysis 2", title: "Assignment 3", date: "8 November 2026" }, share: false });
	const w0 = written[0];
	add("the PDF is written next to the notebook", p1 === "Notebooks/Analysis notes hand-in.pdf" && !!w0, String(p1));
	add("it starts with the cover and holds the chosen pages", !!w0 && new TextDecoder("latin1").decode(w0.bytes).startsWith("%PDF-") && pdfPages(w0.bytes) === 5, w0 ? String(pdfPages(w0.bytes)) : "");
	const p2 = await runHandIn(h, { pages: [0], fields: { name: "", course: "", title: "", date: "" }, share: false });
	add("a second export never overwrites the first", p2 === "Notebooks/Analysis notes hand-in 2.pdf" && written.length === 2, String(p2));
	const before = written.length;
	const none = await runHandIn(h, { pages: [], fields: { name: "", course: "", title: "", date: "" }, share: false });
	add("no pages: nothing is written", none === null && written.length === before);

	root = openDialog(h);
	await sleep(120);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** Puts the dialog, or the cover page in a card, on screen. */
async function handinShot(api: HandInCheckApi, state: "dialog" | "cover"): Promise<void> {
	closeAll();
	const pages = demoPages();
	const app = standIn(api.app, [], new Map([["notebook-hand-in-name", "Ada Lovelace"]]));
	if (state === "dialog") {
		const root = openDialog(host(app, pages, []));
		root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { if (/^All$/.test(b.textContent ?? "")) b.click(); });
		await sleep(250);
		return;
	}
	const cover = coverPage(
		{ name: "Ada Lovelace", course: "Analysis 2", title: "Assignment 3: series and convergence", date: "8 November 2026", footer: "4 pages" },
		{ name: "Name", course: "Course", date: "Date" },
	);
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.setCssStyles({ position: "fixed", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", background: "#888", zIndex: "9999" });
	const img = root.createEl("img", { attr: { alt: "" } });
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pageToSvg(cover, { paper: true }))}`;
	img.setCssStyles({ width: `${Math.min(560, window.innerWidth - 40)}px`, background: "#fff" });
	img.setCssStyles({ boxShadow: "0 8px 32px rgba(0,0,0,.35)", maxHeight: "94vh" });
	open = { root, close: () => undefined };
	await sleep(150);
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function handInApi(api: HandInCheckApi): Record<string, unknown> {
	return {
		checkHandIn: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkHandIn(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`handin check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		handinShot: (state: "dialog" | "cover") => handinShot(api, state),
		handinStates: ["dialog", "cover"],
		closeHandIn: closeAll,
	};
}
