/**
 * Smoke check of "Export written area / selection" (0.23, roadmap #280, `doc=exportarea`, npm run harness:check): the real AreaExportModal
 * offers the page area and the selection, PNG scales and SVG, saves through a stand-in vault (PNG with a transparent corner and ink in the
 * middle, SVG with no white sheet), refuses an empty page with a notice, and leaves the dialog open for the screenshot.
 */
import { TFile, type App } from "obsidian";
import { AreaExportModal, saveArea, type AreaHost } from "../../src/view/export-area";
import { createPage, createStroke, quantizePoint } from "../../src/model/document";
import { PAGE_SIZES, type Page, type Point, type Tool } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface ExportAreaCheckApi {
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
const buttonNamed = (root: HTMLElement, re: RegExp): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => re.test(x.textContent ?? ""));

function setSelect(from: HTMLElement | null, value: string): void {
	const sel = from?.querySelector("select");
	if (!sel) return;
	sel.value = value;
	sel.dispatchEvent(new Event("change"));
}

const pen = (tool: Tool, color: string, y: number) => {
	const pts: Point[] = Array.from({ length: 12 }, (_, i) => quantizePoint(120 + i * 14, y + Math.sin(i / 2) * 6, 0.3 + (i % 5) / 8));
	return createStroke(color, 4, pts, tool);
};

function demoPage(): Page {
	const p = createPage(PAGE_SIZES.a4);
	p.strokes.push(pen("pen", "#1e1e1e", 200), pen("highlighter", "#f5c400", 230), pen("fountain", "#2255cc", 260), pen("brush", "#cc3322", 290), pen("marker", "#118844", 320));
	p.elements = [{ id: "t1", type: "text", x: 110, y: 340, width: 220, text: "Written area", fontSize: 16, color: "#000000" }];
	return p;
}

interface Written {
	path: string;
	bytes?: ArrayBuffer;
	text?: string;
}

function standIn(app: unknown, written: Written[]): App {
	return Object.assign(Object.create(app as object) as object, {
		vault: {
			getAbstractFileByPath: (path: string) => (written.some((w) => w.path === path) ? {} : null),
			createBinary: (path: string, bytes: ArrayBuffer) => { written.push({ path, bytes }); return Promise.resolve({ path }); },
			create: (path: string, text: string) => { written.push({ path, text }); return Promise.resolve({ path }); },
		},
		saveLocalStorage: () => undefined,
		loadLocalStorage: () => null,
	}) as unknown as App;
}

function host(app: App, page: Page, withSelection: boolean): AreaHost {
	const made: unknown = Object.assign(Object.create(TFile.prototype) as object, { basename: "Demo", parent: { path: "Notebooks" }, path: "Notebooks/Demo.notebook" });
	if (!(made instanceof TFile)) throw new Error("harness: could not build the demo file");
	const file = made;
	return {
		app, file, page, pageNumber: 1, media: null, exportOptions: {}, render: {},
		selection: withSelection ? { strokes: [page.strokes[2]!], elements: [] } : null,
	};
}

function openDialog(api: ExportAreaCheckApi, h: AreaHost): HTMLElement {
	closeDialog();
	const m = new AreaExportModal({ ...h, app: api.app as App });
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

async function alphaAt(bytes: ArrayBuffer): Promise<{ corner: number; ink: boolean; w: number; h: number }> {
	const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
	const c = createEl("canvas");
	c.width = bmp.width;
	c.height = bmp.height;
	const ctx = c.getContext("2d")!;
	ctx.drawImage(bmp, 0, 0);
	const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
	let ink = false;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i]! > 200) {
			ink = true;
			break;
		}
	}
	return { corner: data[3]!, ink, w: bmp.width, h: bmp.height };
}

export async function checkExportArea(api: ExportAreaCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const written: Written[] = [];
	const fake = standIn(api.app, written);
	const page = demoPage();

	// The page area, PNG 2x.
	const png = await saveArea(host(fake, page, false), { scope: "page", format: "png", scale: 2 });
	const w0 = written[0];
	add("PNG saved next to the notebook", png === "Notebooks/Demo p1 area.png" && !!w0?.bytes, String(png));
	if (w0?.bytes) {
		const a = await alphaAt(w0.bytes);
		add("PNG corner is transparent and ink is drawn", a.corner === 0 && a.ink, JSON.stringify(a));
		add("PNG is cropped to the written area (smaller than the page, at 2x)", a.w < PAGE_SIZES.a4.width * 2 * 0.7 && a.h < PAGE_SIZES.a4.height * 2 * 0.4, `${a.w}x${a.h}`);
	}
	const svgPath = await saveArea(host(fake, page, false), { scope: "page", format: "svg", scale: 2 });
	const svg = written.find((w) => w.path.endsWith(".svg"))?.text ?? "";
	add("SVG saved, vector and without a white sheet", svgPath === "Notebooks/Demo p1 area.svg" && svg.includes("<path") && !svg.includes('fill="#ffffff"'), String(svgPath));
	add("SVG keeps the highlighter alpha", /fill-opacity="0\./.test(svg));
	const sel = await saveArea(host(fake, page, true), { scope: "selection", format: "svg", scale: 2 });
	add("the selection is saved on its own", sel === "Notebooks/Demo p1 selection.svg" && (written.find((w) => w.path === sel)?.text ?? "").length < svg.length, String(sel));
	const before = written.length;
	const empty = await saveArea(host(fake, createPage(PAGE_SIZES.a4), false), { scope: "page", format: "png", scale: 1 });
	await sleep(30);
	add("an empty page is refused with a notice and writes nothing", empty === null && written.length === before && api.notices.some((n) => /nothing written/i.test(n)), api.notices.slice(-2).join("|"));

	// The dialog.
	let root = openDialog(api, host(fake, page, true));
	await sleep(80);
	const scopeOptions = [...(row(root, /^What to export/)?.querySelectorAll("option") ?? [])].map((o) => o.textContent);
	add("the scope offers the page area and the selection", scopeOptions.length === 2, scopeOptions.join("|"));
	add("the scale is shown for PNG", shown(row(root, /^Scale/)));
	setSelect(row(root, /^Format/), "svg");
	await sleep(40);
	add("the scale is hidden for SVG", !shown(row(root, /^Scale/)));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	add("Save is there", !!buttonNamed(root, /^Save$/));
	closeDialog();
	root = openDialog(api, host(fake, page, false));
	await sleep(60);
	add("without a selection only the page area is offered", [...(row(root, /^What to export/)?.querySelectorAll("option") ?? [])].length === 1);
	closeDialog();
	root = openDialog(api, host(fake, page, true));
	await sleep(120);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function exportAreaApi(api: ExportAreaCheckApi): Record<string, unknown> {
	return {
		checkExportArea: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkExportArea(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`exportarea check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeExportArea: closeDialog,
	};
}
