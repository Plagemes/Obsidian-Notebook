/**
 * Smoke check of the Interactive HTML export (0.21, roadmap #164, `doc=htmlexport`, npm run harness:check): the real ExportModal offers
 * "Interactive HTML" and Export carries format html for the notebook and a typed range; a generated file is loaded in a sandboxed
 * iframe and its viewer is driven (next page, keys, zoom, page link). It leaves the dialog open on the HTML format for the screenshot.
 */
import type { App } from "obsidian";
import { buildHtml, pageHtmlLinks } from "../../src/ink/export-html";
import { pageToSvg } from "../../src/ink/export-svg";
import { createPage } from "../../src/model/document";
import { PAGE_SIZES, type Page, type TextElement } from "../../src/model/types";
import type { ExportRequest } from "../../src/view/export";
import { ExportModal } from "../../src/view/export-dialog";
import type { CheckResult } from "./reading-check";

export interface HtmlExportCheckApi {
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
const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;
const exportButton = (root: HTMLElement): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Export");

function openDialog(api: HtmlExportCheckApi, picked: ExportRequest[]): HTMLElement {
	closeDialog();
	const pages = [createPage(PAGE_SIZES.a4), createPage(PAGE_SIZES.a4), createPage(PAGE_SIZES.a4)];
	const m = new ExportModal({
		app: api.app as App, pageCount: pages.length, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Demo (PNG)", canPrint: false,
		pages: () => pages, run: (request) => picked.push(request),
	});
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

function setSelect(from: HTMLElement | null, value: string): void {
	const sel = from?.querySelector("select");
	if (!sel) return;
	sel.value = value;
	sel.dispatchEvent(new Event("change"));
}

/** The viewer of a generated file, in a sandboxed iframe: the real script on the real file. */
async function driveViewer(): Promise<Record<string, boolean>> {
	const link: TextElement = { id: "t1", type: "text", x: 40, y: 40, width: 300, text: "go [[Demo#p3]]", fontSize: 14, color: "#000000" };
	const pages: Page[] = [{ ...createPage(PAGE_SIZES.a4), elements: [link] }, createPage(PAGE_SIZES.a4), createPage(PAGE_SIZES.a4)];
	const html = buildHtml({ title: "Demo <b>" }, pages.map((p, i) => ({ svg: pageToSvg(p), label: `Page ${i + 1}`, links: pageHtmlLinks(p, "Demo", (n) => (n >= 1 && n <= 3 ? n - 1 : null)) })));
	const frame = document.body.createEl("iframe");
	frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
	frame.setCssProps({ position: "fixed", left: "-9999px", top: "0", width: "900px", height: "700px" });
	frame.srcdoc = html;
	await new Promise<void>((r) => frame.addEventListener("load", () => r(), { once: true }));
	await sleep(150);
	const doc = frame.contentDocument!;
	const win = frame.contentWindow! as Window & typeof window;
	const pos = () => doc.getElementById("pos")?.textContent ?? "";
	const width = () => parseFloat(doc.querySelector("#sheet svg")?.getAttribute("width") ?? "0");
	const out: Record<string, boolean> = {};
	out["viewer starts on page 1 of 3"] = pos() === "Page 1 of 3";
	out["the thumbnail strip has 3 pages"] = doc.querySelectorAll("#strip a").length === 3;
	const fitted = width();
	out["page is fitted to the width"] = fitted > 100 && fitted <= doc.getElementById("stage")!.clientWidth;
	doc.getElementById("next")!.click();
	out["Next goes to page 2"] = pos() === "Page 2 of 3";
	win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft" }));
	out["the left arrow goes back"] = pos() === "Page 1 of 3";
	doc.getElementById("zin")!.click();
	out["zoom in enlarges the page"] = width() > fitted * 1.2;
	doc.getElementById("fit")!.click();
	out["Fit width restores the fit"] = Math.abs(width() - fitted) < 1;
	doc.querySelector("#sheet a[data-go]")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
	out["a page link jumps inside the file"] = pos() === "Page 3 of 3";
	out["the title is shown as text, not markup"] = doc.querySelector("h1")?.textContent === "Demo <b>" && doc.querySelector("h1 b") === null;
	frame.remove();
	return out;
}

export async function checkHtmlExport(api: HtmlExportCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const picked: ExportRequest[] = [];

	let root = openDialog(api, picked);
	await sleep(60);
	const fmt = row(root, /^Format/);
	const options = [...(fmt?.querySelectorAll("option") ?? [])].map((o) => o.textContent);
	add("the format list offers Interactive HTML", options.includes("Interactive HTML"), options.join("|"));
	setSelect(fmt, "html");
	await sleep(60);
	add("the note explains the single file", /ONE \.html file/.test(root.textContent ?? ""));
	add("the PNG folder is not asked", !shown(row(root, /^Folder|^Cartella/)));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	exportButton(root)?.click();
	await sleep(50);
	add("Export asks for html of the notebook", picked[0]?.format === "html" && picked[0].scope === "notebook", JSON.stringify(picked[0]));

	root = openDialog(api, picked);
	await sleep(60);
	const scopeRow = [...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => [...r.querySelectorAll("option")].some((o) => o.value === "range")) ?? null;
	setSelect(scopeRow, "range");
	await sleep(40);
	const rangeInput = [...root.querySelectorAll<HTMLInputElement>("input[type=text]")].find((i) => i.placeholder.startsWith("1-3"));
	if (rangeInput) {
		rangeInput.value = "1, 3";
		rangeInput.dispatchEvent(new Event("input"));
	}
	exportButton(root)?.click();
	await sleep(50);
	add("a typed range carries the pages", picked[1]?.format === "html" && picked[1].scope === "range" && JSON.stringify(picked[1].range) === "[0,2]", JSON.stringify(picked[1]));

	const viewer = await driveViewer();
	for (const [name, ok] of Object.entries(viewer)) add(name, ok);

	// The picture for the review: the format is remembered, so the dialog opens on Interactive HTML.
	root = openDialog(api, picked);
	await sleep(120);
	add("the format is remembered for the next export", (row(root, /^Format/)?.querySelector("select"))?.value === "html");
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function htmlExportApi(api: HtmlExportCheckApi): Record<string, unknown> {
	return {
		checkHtmlExport: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkHtmlExport(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`htmlexport check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeHtmlExport: closeDialog,
	};
}
