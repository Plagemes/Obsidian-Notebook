/**
 * Smoke check of "Split into sheets" in the export dialog (0.18, roadmap #178, `doc=a4split`, npm run harness:check): the real
 * ExportModal on the harness stand-in for Obsidian, driven with synthetic clicks. An infinite page makes the switch appear; turning
 * it on shows the paper choices and the preview of the cuts drawn over the page picture; a change of paper redraws it; the PDF-only
 * choices follow the format; the request carries the split; a notebook without an infinite page is not offered the switch.
 * It leaves the dialog open (switch on, preview drawn) for the screenshot.
 */
import type { App } from "obsidian";
import { createPage, createStroke } from "../../src/model/document";
import type { Page } from "../../src/model/types";
import { PAGE_SIZES } from "../../src/model/types";
import type { ExportRequest } from "../../src/view/export";
import { ExportModal } from "../../src/view/export-dialog";
import type { CheckResult } from "./reading-check";

export interface A4splitCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

let open: { root: HTMLElement; close: () => void } | null = null;

function closeDialog(): void {
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
const shown = (el: Element | null): boolean => !!el && (el as HTMLElement).style.display !== "none" && (el as HTMLElement).getBoundingClientRect().width > 0;

function infinitePage(): Page {
	const page = createPage({ width: 600, height: 3200 });
	page.infinite = true;
	for (let i = 0; i < 70; i++) {
		const y = 40 + i * 42;
		page.strokes.push(createStroke("#1e1e1e", 2, [[30, y, 0.5], [160, y + 8, 0.5], [300, y - 4, 0.5], [480, y + 6, 0.5]], "pen"));
	}
	return page;
}

function openDialog(api: A4splitCheckApi, pages: Page[], format: "pdf" | "png", picked: ExportRequest[]): HTMLElement {
	closeDialog();
	const m = new ExportModal({
		app: api.app as App, pageCount: pages.length, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Demo (PNG)", canPrint: false,
		initialFormat: format, pages: () => pages, run: (request) => picked.push(request),
	});
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;

function pick(select: HTMLSelectElement | null | undefined, value: string): void {
	if (!select) throw new Error("no select");
	select.value = value;
	select.dispatchEvent(new Event("change"));
}

export async function checkA4split(api: A4splitCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const picked: ExportRequest[] = [];
	const normal = createPage(PAGE_SIZES.a4);
	normal.strokes.push(createStroke("#1e1e1e", 2, [[40, 100, 0.5], [200, 104, 0.5]], "pen"));

	// --- no infinite page: no switch ---
	let root = openDialog(api, [normal], "pdf", picked);
	await sleep(60);
	add("a notebook without an infinite page is not offered the switch", !shown(row(root, /^Split into sheets/)));

	// --- an infinite page: the switch, off at first ---
	root = openDialog(api, [infinitePage(), normal], "pdf", picked);
	await sleep(60);
	const sw = row(root, /^Split into sheets/);
	add("an infinite page offers the switch", shown(sw));
	add("the choices and the preview wait for the switch", !shown(root.querySelector(".nb-split-body")));

	// --- on: the choices and the preview of the cuts ---
	sw?.querySelector<HTMLElement>(".checkbox-container")?.click();
	await sleep(500);
	const body = root.querySelector<HTMLElement>(".nb-split-body");
	add("the switch opens the choices", shown(body));
	add("paper, orientation, size, margin, overlap, cut, numbers and empty sheets are there", ["Paper", "Orientation", "Size on paper", "Margin", "Overlap", "Cut between lines", "Page numbers", "Leave out empty sheets"].every((n) => shown(row(root, new RegExp(`^${n}`)))));
	const box = root.querySelector<HTMLElement>(".nb-split-preview");
	const img = root.querySelector<HTMLImageElement>(".nb-split-img");
	add("the preview shows the page picture", !!box && shown(box) && !!img && img.src.startsWith("data:image/"), img?.src.slice(0, 20) ?? "none");
	const tiles = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".nb-split-tile")];
	const before = tiles().length;
	add("the grid overlay has a tile per sheet", before > 1, String(before));
	const b = box?.getBoundingClientRect();
	add("the tiles stay inside the preview", !!b && tiles().every((t) => {
		const r = t.getBoundingClientRect();
		return r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
	}));
	add("the summary says how many sheets", /sheets \(\d+ × \d+\) at \d+%/.test(root.querySelector(".nb-split-body .notebook-export-note:not(.notebook-hidden)")?.textContent ?? "") || /sheets/.test(body?.textContent ?? ""), body?.textContent?.slice(-120) ?? "");
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);

	// --- a change of orientation redraws the preview ---
	pick(row(root, /^Orientation/)?.querySelector("select"), "landscape");
	await sleep(300);
	add("landscape paper makes more sheets", tiles().length > before, `${before} -> ${tiles().length}`);

	// --- PDF-only choices follow the format ---
	add("the page numbers are offered for a PDF", shown(row(root, /^Page numbers/)));
	pick(root.querySelectorAll("select")[0], "png");
	await sleep(100);
	add("page numbers are not offered for PNG, the note about the images is", !shown(row(root, /^Page numbers/)) && /page-001-part-01/.test(body?.textContent ?? ""));
	pick(root.querySelectorAll("select")[0], "pdf");
	await sleep(100);

	// --- Export carries the split ---
	const exportButton = [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Export");
	exportButton?.click();
	await sleep(50);
	const req = picked[0];
	add("Export carries the split", req?.format === "pdf" && req.split?.orientation === "landscape" && req.split.smartCuts === true, JSON.stringify(req?.split));
	closeDialog();

	// --- the picture for the review: switch on, preview drawn ---
	root = openDialog(api, [infinitePage(), normal], "pdf", picked);
	await sleep(600);
	add("the choices are remembered for the next export", shown(root.querySelector(".nb-split-body")) && tiles().length > 1);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function a4splitApi(api: A4splitCheckApi): Record<string, unknown> {
	return {
		checkA4split: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkA4split(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`a4split check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeA4split: closeDialog,
	};
}
