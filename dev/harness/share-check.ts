/**
 * Smoke check of "Share page…" (0.20, roadmap #30, `doc=share`, npm run harness:check): the real SharePageModal and the real export
 * renderers on the harness stand-in for Obsidian, with `navigator.share` / `navigator.canShare` replaced by recorders. It checks both
 * branches (share sheet, saved copy), that a closed share sheet writes nothing, that a share that came too late offers a new tap, that the
 * PDF and the selection are shared under the right names and types, and that the last choice is remembered. The real share sheet needs hardware
 * (docs/testing.md). It leaves the dialog open on "Some pages" for the screenshot.
 */
import { TFile, type App } from "obsidian";
import { createPage, createStroke } from "../../src/model/document";
import { PAGE_SIZES, type Page } from "../../src/model/types";
import { SharePageModal, type ShareHost } from "../../src/view/share-page";
import type { CheckResult } from "./reading-check";

export interface ShareCheckApi {
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
/** Waits until `cond` holds (drawing a page takes a while on a busy machine), at most `ms`. */
async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await sleep(40);
}
const shown = (el: Element | null): boolean => !!el && (el as HTMLElement).style.display !== "none" && (el as HTMLElement).getBoundingClientRect().width > 0;
const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;
const button = (root: HTMLElement, label: string): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => (x.querySelector(".nb-modal-btn-label")?.textContent ?? x.textContent) === label);

function pages(): Page[] {
	return [0, 1, 2].map((n) => {
		const p = createPage(PAGE_SIZES.a4);
		for (let i = 0; i < 8; i++) p.strokes.push(createStroke("#1e1e1e", 2, [[60, 90 + i * 40 + n * 3, 0.5], [200, 100 + i * 40, 0.5], [380, 90 + i * 40, 0.5]], "pen"));
		return p;
	});
}

function notebookFile(): TFile {
	const f = new TFile();
	f.basename = "Maths";
	f.extension = "notebook";
	f.name = "Maths.notebook";
	f.path = "Notebooks/Maths.notebook";
	return f;
}

function openDialog(api: ShareCheckApi, withSelection: boolean, onSelection = false): HTMLElement {
	closeDialog();
	const all = pages();
	const host: ShareHost = {
		app: api.app as App, file: notebookFile(), pageCount: all.length, pageIndex: 0,
		selection: withSelection ? { x: 40, y: 70, width: 360, height: 200 } : null,
		pages: () => all, media: null, options: () => ({}),
	};
	const m = new SharePageModal(host);
	if (onSelection) m.startOnSelection();
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

function setSelect(r: HTMLElement | null, value: string): void {
	const sel = r?.querySelector<HTMLSelectElement>("select");
	if (!sel) return;
	sel.value = value;
	sel.dispatchEvent(new Event("change"));
}

type Call = { files: File[]; title?: string };

/** Replaces navigator.canShare/share for the check; `restore` puts back what was there. */
function stubShare(behaviour: () => Promise<void>): { calls: Call[]; restore: () => void } {
	const calls: Call[] = [];
	const nav = navigator as unknown as Record<string, unknown>;
	const before = { canShare: Object.getOwnPropertyDescriptor(nav, "canShare"), share: Object.getOwnPropertyDescriptor(nav, "share") };
	Object.defineProperty(nav, "canShare", { configurable: true, value: (d: { files?: File[] }) => (d.files ?? []).length > 0 });
	Object.defineProperty(nav, "share", { configurable: true, value: (d: Call) => {
		calls.push(d);
		return behaviour();
	} });
	return {
		calls,
		restore: () => {
			for (const k of ["canShare", "share"] as const) {
				if (before[k]) Object.defineProperty(nav, k, before[k]);
				else delete nav[k];
			}
		},
	};
}

function unstubShare(): void {
	const nav = navigator as unknown as Record<string, unknown>;
	Object.defineProperty(nav, "canShare", { configurable: true, value: undefined });
	Object.defineProperty(nav, "share", { configurable: true, value: undefined });
}

export async function checkShare(api: ShareCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const vault = (api.app as App).vault;
	const fileCount = (): number => vault.getFiles().length;
	const noticeCount = (): number => api.notices.length;

	// --- the device cannot share files: a copy is saved in the vault.
	unstubShare();
	let root = openDialog(api, false);
	await sleep(60);
	add("the page is the first choice", /Page 1/.test(row(root, /^What to share/)?.textContent ?? ""));
	add("no selection is offered without a selection", !/selection/i.test(row(root, /^What to share/)?.querySelector("select")?.textContent ?? ""));
	add("the page range waits for 'Some pages'", !shown(row(root, /^Pages$/)));
	add("without a share sheet the button says Save a copy", !!button(root, "Save a copy") && !button(root, "Share"));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	const before = fileCount();
	const n0 = noticeCount();
	button(root, "Save a copy")?.click();
	await waitFor(() => !!vault.getAbstractFileByPath("Maths (PNG)/page-001.png"));
	await sleep(100);
	add("a copy is saved next to the notebook, named like the PNG export", !!vault.getAbstractFileByPath("Maths (PNG)/page-001.png"), String(vault.getFiles().map((f) => f.path)));
	add("exactly one file was written", fileCount() === before + 1, `${before} -> ${fileCount()}`);
	add("the notice says where it went", api.notices.slice(n0).some((m) => /Saved to Maths \(PNG\)\/page-001\.png/.test(m)), api.notices.slice(n0).join(" | "));

	// --- the share sheet takes the files.
	let stub = stubShare(() => Promise.resolve());
	root = openDialog(api, false);
	await sleep(60);
	add("with a share sheet the button says Share", !!button(root, "Share") && !button(root, "Save a copy"), [...root.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(" ") + ` canShare=${typeof navigator.canShare} share=${typeof navigator.share}`);
	let files = fileCount();
	button(root, "Share")?.click();
	await waitFor(() => stub.calls.length > 0);
	const first = stub.calls[0]?.files[0];
	add("the page is handed to the share sheet as a PNG", stub.calls.length === 1 && first?.name === "Maths p1.png" && first.type === "image/png" && first.size > 500, `${first?.name} ${first?.type} ${first?.size}`);
	add("sharing writes nothing in the vault", fileCount() === files, `${files} -> ${fileCount()}`);
	stub.restore();

	// --- the user closes the share sheet: no file, no notice.
	stub = stubShare(() => Promise.reject(new DOMException("closed", "AbortError")));
	root = openDialog(api, false);
	await sleep(60);
	files = fileCount();
	const n1 = noticeCount();
	button(root, "Share")?.click();
	await waitFor(() => stub.calls.length > 0);
	await sleep(250);
	add("closing the share sheet writes nothing", stub.calls.length === 1 && fileCount() === files, `${files} -> ${fileCount()}`);
	const said = api.notices.slice(n1).filter((m) => !/^Exporting/.test(m));
	add("closing the share sheet is not reported as an error", said.length === 0, said.join(" | "));
	stub.restore();

	// --- the share came too long after the tap: the files are kept and a new tap is offered.
	stub = stubShare(() => Promise.reject(new DOMException("needs a tap", "NotAllowedError")));
	root = openDialog(api, false);
	await sleep(60);
	files = fileCount();
	const n2 = noticeCount();
	button(root, "Share")?.click();
	await waitFor(() => api.notices.slice(n2).some((m) => /Ready to share/.test(m)));
	add("a share that needs a new tap offers one and writes nothing", api.notices.slice(n2).some((m) => /Ready to share/.test(m)) && fileCount() === files, api.notices.slice(n2).join(" | "));
	stub.restore();

	// --- the share sheet refuses the files: a copy is saved instead.
	stub = stubShare(() => Promise.reject(new TypeError("files not supported")));
	root = openDialog(api, false);
	await sleep(60);
	files = fileCount();
	button(root, "Share")?.click();
	await waitFor(() => fileCount() > files);
	add("a share sheet that cannot take the files falls back to a saved copy", fileCount() === files + 1, `${files} -> ${fileCount()}`);
	stub.restore();

	// --- a PDF of some pages, then the choice is remembered.
	stub = stubShare(() => Promise.resolve());
	root = openDialog(api, false);
	await sleep(60);
	setSelect(row(root, /^What to share/), "range");
	await sleep(30);
	add("'Some pages' shows the range field", shown(row(root, /^Pages$/)));
	setSelect(row(root, /^Format/), "pdf");
	const rangeInput = row(root, /^Pages$/)?.querySelector<HTMLInputElement>("input");
	if (rangeInput) {
		rangeInput.value = "1-3";
		rangeInput.dispatchEvent(new Event("input"));
	}
	await sleep(30);
	button(root, "Share")?.click();
	await waitFor(() => stub.calls.length > 0);
	const pdf = stub.calls[0]?.files[0];
	const head = pdf ? new TextDecoder().decode(await pdf.slice(0, 5).arrayBuffer()) : "";
	add("a range is shared as one PDF", stub.calls.length === 1 && stub.calls[0]!.files.length === 1 && pdf?.name === "Maths p1-3.pdf" && pdf.type === "application/pdf" && head === "%PDF-", `${pdf?.name} ${pdf?.type} ${head}`);
	root = openDialog(api, false);
	await sleep(60);
	add("the last format is remembered on this device", row(root, /^Format/)?.querySelector("select")?.value === "pdf", row(root, /^Format/)?.querySelector("select")?.value ?? "");
	add("a remembered range falls back to the page without typed pages", row(root, /^What to share/)?.querySelector("select")?.value === "range" || row(root, /^What to share/)?.querySelector("select")?.value === "page");
	stub.restore();

	// --- a PDF range with a wrong range text is refused with a sentence, nothing is shared.
	stub = stubShare(() => Promise.resolve());
	root = openDialog(api, false);
	await sleep(60);
	setSelect(row(root, /^What to share/), "range");
	await sleep(30);
	button(root, "Share")?.click();
	await sleep(200);
	add("an empty range is refused with a sentence", stub.calls.length === 0 && (root.querySelector(".notebook-export-problem")?.textContent ?? "") !== "", root.querySelector(".notebook-export-problem")?.textContent ?? "");
	stub.restore();

	// --- the selection: always one PNG of its region.
	stub = stubShare(() => Promise.resolve());
	root = openDialog(api, true, true);
	await sleep(60);
	add("the selection is chosen and the format is not asked", row(root, /^What to share/)?.querySelector("select")?.value === "selection" && !shown(row(root, /^Format/)));
	files = fileCount();
	button(root, "Share")?.click();
	await waitFor(() => stub.calls.length > 0);
	const sel = stub.calls[0]?.files[0];
	add("the selection is shared as a PNG named after the page", stub.calls.length === 1 && sel?.name === "Maths p1 selection.png" && sel.type === "image/png" && sel.size > 300, `${sel?.name} ${sel?.type} ${sel?.size}`);
	add("sharing the selection writes nothing", fileCount() === files);
	stub.restore();

	// The picture for the review.
	stub = stubShare(() => Promise.resolve());
	root = openDialog(api, true);
	await sleep(60);
	setSelect(row(root, /^What to share/), "range");
	await sleep(120);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function shareApi(api: ShareCheckApi): Record<string, unknown> {
	return {
		checkShare: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkShare(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`share check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeShare: closeDialog,
	};
}
