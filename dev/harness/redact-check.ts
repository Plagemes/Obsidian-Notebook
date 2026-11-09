/**
 * Smoke check of redaction before export (0.26, roadmap #285, `doc=redact`, `HARNESS_DOC=redact npm run harness:check`). In a real browser
 * (real canvas, real PNG and JPEG encoders):
 *  - the page renderer (PNG export, print, Markdown, share, copy as image) paints the box solid black over a scanned background, in a
 *    background-only export too, and leaves the cached picture of the PDF page as it was;
 *  - `NotebookMedia.pdfPageJpeg(…, burn)` encodes a JPEG that has the box burned in;
 *  - the written-area picture (PNG) has the box opaque and the ink under it gone;
 *  - the real RedactModal draws a box with a pen drag, removes it, steps between pages and keeps the boxes through `commit`;
 *  - the real ExportModal offers "Redact…", shows the switch only when there are boxes and sends them with the request.
 * `redactShot("export" | "editor" | "scan")` leaves the dialog on screen for the screenshots.
 */
import { TFile, type App } from "obsidian";
import { createPage, createStroke, quantizePoint } from "../../src/model/document";
import { REDACT_COLOR } from "../../src/ink/redact";
import { countBoxes, type RedactState, type Redactions } from "../../src/model/redact";
import { PAGE_SIZES, type Page, type PageElement, type Point } from "../../src/model/types";
import { loadRedactState, saveRedactState } from "../../src/ui/redact-store";
import type { ExportRequest } from "../../src/view/export";
import { ExportModal } from "../../src/view/export-dialog";
import { planWithRedaction, saveArea, type AreaHost } from "../../src/view/export-area";
import { NotebookMedia } from "../../src/view/media";
import { PageImageRenderer } from "../../src/view/page-images";
import { RedactModal } from "../../src/view/redact-dialog";
import { redactPage } from "../../src/ink/redact";
import type { CheckResult } from "./reading-check";

export interface RedactCheckApi {
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
const shown = (el: Element | null): boolean => !!el && (el as HTMLElement).style.display !== "none" && (el as HTMLElement).getBoundingClientRect().width > 0;
const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;
const buttonNamed = (root: HTMLElement, re: RegExp): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => re.test(x.textContent ?? "") || re.test(x.getAttribute("aria-label") ?? ""));

const SCAN_RED: [number, number, number] = [200, 40, 40];

/** A canvas that stands for a scanned document: a red sheet with grey "text" lines (so a screenshot of the editor looks like a scan). */
function scanCanvas(pixelWidth: number, pixelHeight: number, flat = false): HTMLCanvasElement {
	const c = createEl("canvas");
	c.width = pixelWidth;
	c.height = pixelHeight;
	const ctx = c.getContext("2d")!;
	if (flat) {
		ctx.fillStyle = `rgb(${SCAN_RED.join(",")})`;
		ctx.fillRect(0, 0, c.width, c.height);
		return c;
	}
	ctx.fillStyle = "#f6f1e4";
	ctx.fillRect(0, 0, c.width, c.height);
	ctx.fillStyle = "#8a8578";
	for (let y = 0.1; y < 0.92; y += 0.034) {
		const w = 0.38 + 0.46 * Math.abs(Math.sin(y * 31));
		ctx.fillRect(c.width * 0.1, c.height * y, c.width * w, Math.max(2, c.height * 0.008));
	}
	return c;
}

function pngOf(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? void b.arrayBuffer().then(resolve) : reject(new Error("no PNG"))), "image/png"));
}

/** A media stand-in: its PDF store hands out the same flat red "scan" canvas every time (like the real cache), and any asset reads as a red PNG. */
async function fakeMedia(app: App, flat: boolean): Promise<{ media: NotebookMedia; scan: HTMLCanvasElement }> {
	const scan = scanCanvas(Math.round(595.28 * 1.5), Math.round(841.89 * 1.5), flat);
	const png = await pngOf(scanCanvas(300, 400, true));
	const media = new NotebookMedia(app, () => null, () => "Notebooks", () => undefined);
	Object.defineProperty(media, "pdf", { value: { render: () => Promise.resolve(scan), clear: () => undefined } });
	media.readAsset = () => Promise.resolve(png.slice(0));
	return { media, scan };
}

async function pixels(blob: Blob | ArrayBuffer): Promise<{ at: (x: number, y: number) => [number, number, number, number]; w: number; h: number }> {
	const bmp = await createImageBitmap(blob instanceof Blob ? blob : new Blob([blob]));
	const c = createEl("canvas");
	c.width = bmp.width;
	c.height = bmp.height;
	const ctx = c.getContext("2d", { willReadFrequently: true })!;
	ctx.drawImage(bmp, 0, 0);
	const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
	return { w: bmp.width, h: bmp.height, at: (x, y) => { const i = (Math.floor(y) * bmp.width + Math.floor(x)) * 4; return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]; } };
}

const near = (p: readonly number[], rgb: readonly number[], tol = 28): boolean => rgb.every((v, i) => Math.abs((p[i] ?? 0) - v) <= tol);
const dark = (p: readonly number[]): boolean => p[0]! < 40 && p[1]! < 40 && p[2]! < 40 && p[3]! > 240;

/** Whether a grid of points well inside the box (every 10 pt, away from its edges by `margin` pt) is solid black in a picture drawn at `scale` px per pt. */
function insideAllDark(px: { at: (x: number, y: number) => [number, number, number, number] }, scale: number, margin: number, origin: { x: number; y: number } = BOX): boolean {
	for (let x = margin + 4; x < BOX.width - margin - 4; x += 10) for (let y = margin + 4; y < BOX.height - margin - 4; y += 10) {
		if (!dark(px.at((origin.x + x) * scale, (origin.y + y) * scale))) return false;
	}
	return true;
}

const BOX = { x: 120, y: 200, width: 260, height: 70 };

const scribble = (y: number, x0 = 60): ReturnType<typeof createStroke> => {
	const pts: Point[] = Array.from({ length: 26 }, (_, i) => quantizePoint(x0 + i * 16, y + Math.sin(i / 2) * 7, 0.3 + (i % 5) / 8));
	return createStroke("#1b4fa0", 3, pts, "pen");
};

const text = (id: string, x: number, y: number, body: string, size = 16): PageElement => ({ id, type: "text", x, y, width: 300, text: body, fontSize: size, color: "#111111" });

/** A page with a typed name, an account number and handwriting under the box, and public lines outside it. */
function demoPage(id: string, scan = false): Page {
	const p = createPage(PAGE_SIZES.a4);
	p.id = id;
	p.paper = { kind: scan ? "blank" : "ruled", spacing: 28 };
	p.strokes.push(scribble(225), scribble(250), scribble(420), scribble(520));
	p.elements = [text("n", 130, 205, "Name: Ada Lovelace"), text("a", 130, 232, "IBAN IT60 X054 2811 1010 0000 0123 456", 13), text("pub", 60, 340, "Invoice 2026-114 · amount due 340 EUR", 15)];
	if (scan) p.background = { kind: "pdf", asset: "scan", page: 1 };
	return p;
}

function standIn(app: unknown, written: Array<{ path: string; bytes: ArrayBuffer }>, store: Map<string, unknown>): App {
	return Object.assign(Object.create(app as object) as object, {
		vault: {
			getAbstractFileByPath: (path: string) => (written.some((w) => w.path === path) ? {} : null),
			createBinary: (path: string, bytes: ArrayBuffer) => { written.push({ path, bytes }); return Promise.resolve({ path }); },
			create: () => Promise.resolve({}),
		},
		saveLocalStorage: (k: string, v: unknown) => { store.set(k, v); },
		loadLocalStorage: (k: string) => store.get(k) ?? null,
	}) as unknown as App;
}

function demoFile(): TFile {
	const made: unknown = Object.assign(Object.create(TFile.prototype) as object, { basename: "Tax 2026", parent: { path: "Notebooks" }, path: "Notebooks/Tax 2026.notebook" });
	if (!(made instanceof TFile)) throw new Error("harness: could not build the demo file");
	return made;
}

function mount(m: { modalEl: HTMLElement; close: () => void; open: () => void }): HTMLElement {
	closeAll();
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

function pointer(el: Element, type: string, x: number, y: number, pointerType = "pen"): void {
	el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, isPrimary: true }));
}

/** Drags a box over the picture of the editor from a fraction of the page to another. */
function drag(root: HTMLElement, from: [number, number], to: [number, number], pointerType = "pen"): void {
	const layer = root.querySelector<HTMLElement>(".nb-redact-layer");
	const img = root.querySelector<HTMLElement>(".nb-redact-img");
	if (!layer || !img) return;
	const r = img.getBoundingClientRect();
	const at = (f: [number, number]): [number, number] => [r.left + r.width * f[0], r.top + r.height * f[1]];
	const a = at(from);
	const b = at(to);
	pointer(layer, "pointerdown", a[0], a[1], pointerType);
	pointer(layer, "pointermove", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pointerType);
	pointer(layer, "pointermove", b[0], b[1], pointerType);
	pointer(layer, "pointerup", b[0], b[1], pointerType);
}

async function waitPreview(root: HTMLElement): Promise<void> {
	for (let k = 0; k < 60; k++) {
		const img = root.querySelector<HTMLImageElement>(".nb-redact-img");
		if (img?.src.startsWith("blob:") && !root.querySelector(".nb-redact-stage.is-loading") && img.complete && img.naturalWidth > 0) return;
		await sleep(50);
	}
}

export async function checkRedact(api: RedactCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const written: Array<{ path: string; bytes: ArrayBuffer }> = [];
	const store = new Map<string, unknown>();
	const app = standIn(api.app, written, store);

	// --- the page renderer (PNG export, print, Markdown, share, copy as image) over a scanned background ---
	const { media, scan } = await fakeMedia(app, true);
	const scanBefore = scan.getContext("2d")!.getImageData(0, 0, 4, 4).data.join(",");
	const page = demoPage("pg-1", true);
	const redacted = redactPage(page, [BOX]);
	const renderer = new PageImageRenderer(media, { layers: "both" });
	const both = await renderer.render(redacted, 72);
	let px = await pixels(both.blob);
	add("PNG: the box is opaque black over the scan, all over", insideAllDark(px, 1, 1), JSON.stringify(px.at(BOX.x + 130, BOX.y + 35)));
	add("PNG: the scan is still there outside the box", near(px.at(20, 20), SCAN_RED) || near(px.at(px.w - 20, px.h - 20), SCAN_RED), JSON.stringify(px.at(20, 20)));
	const bgOnly = await new PageImageRenderer(media, { layers: "background" }).render(redacted, 72);
	px = await pixels(bgOnly.blob);
	add("PNG, background only: the box is burned into the scan (no ink layer to hide it)", insideAllDark(px, 1, 1) && near(px.at(20, 20), SCAN_RED), JSON.stringify(px.at(BOX.x + 130, BOX.y + 35)));
	const plain = await new PageImageRenderer(media, { layers: "background" }).render(page, 72);
	px = await pixels(plain.blob);
	add("without redaction the same export shows the scan under the box", near(px.at(BOX.x + 130, BOX.y + 35), SCAN_RED), JSON.stringify(px.at(BOX.x + 130, BOX.y + 35)));
	add("the cached picture of the PDF page was not changed", scan.getContext("2d")!.getImageData(0, 0, 4, 4).data.join(",") === scanBefore && near(Array.from(scan.getContext("2d")!.getImageData(BOX.x * 1.5 + 100, BOX.y * 1.5 + 50, 1, 1).data), SCAN_RED));
	const inkOnly = await new PageImageRenderer(media, { layers: "ink" }).render(redacted, 72);
	px = await pixels(inkOnly.blob);
	add("PNG, ink only: transparent outside, the box solid", px.at(10, 10)[3] === 0 && insideAllDark(px, 1, 1), JSON.stringify(px.at(10, 10)));

	// --- the JPEG a PDF export embeds ---
	const jpg = await media.pdfPageJpeg("scan", 1, 108, { rect: { x: 0, y: 0, width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height }, boxes: [BOX] });
	const jp = await pixels(new Blob([jpg.jpeg.slice().buffer], { type: "image/jpeg" }));
	const k = jp.w / PAGE_SIZES.a4.width;
	add("PDF export: the JPEG of the page has the box burned in", insideAllDark(jp, k, 3), JSON.stringify(jp.at((BOX.x + 130) * k, (BOX.y + 35) * k)));
	add("PDF export: the JPEG keeps the scan outside the box", near(jp.at(20 * k, 20 * k), SCAN_RED, 40), JSON.stringify(jp.at(20 * k, 20 * k)));
	const raw = await media.pdfPageJpeg("scan", 1, 108);
	const rp = await pixels(new Blob([raw.jpeg.slice().buffer], { type: "image/jpeg" }));
	add("(control) without a burn the JPEG shows the scan under the box", near(rp.at((BOX.x + 130) * k, (BOX.y + 35) * k), SCAN_RED, 40));
	const pic = await media.imageJpeg("anything", { rect: { x: 0, y: 0, width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height }, boxes: [{ x: 0, y: 0, width: 300, height: 400 }] });
	const pp = await pixels(new Blob([pic.jpeg.slice().buffer], { type: "image/jpeg" }));
	add("a picture background is burned in too", pp.at(pp.w * 0.2, pp.h * 0.2)[0] < 60, JSON.stringify(pp.at(pp.w * 0.2, pp.h * 0.2)));

	// --- the written-area picture ---
	const host: AreaHost = {
		app, file: demoFile(), page: demoPage("pg-2"), pageNumber: 2, selection: null, media: null, render: {},
		exportOptions: { redact: { "pg-2": [BOX] } },
	};
	const saved = await saveArea(host, { scope: "page", format: "png", scale: 2 });
	const png = written.find((w) => w.path === saved);
	add("area export: a PNG is saved", !!png, String(saved));
	if (png) {
		const a = await pixels(png.bytes);
		const rect = planWithRedaction(host, "page")!.rect;
		add("area export: the box is in the picture, solid and opaque all over", insideAllDark(a, 2, 1, { x: BOX.x - rect.x, y: BOX.y - rect.y }), JSON.stringify(a.at((BOX.x - rect.x + 130) * 2, (BOX.y - rect.y + 35) * 2)));
	}
	add("area export tells the reader the redaction was applied", api.notices.some((n) => /Redaction applied/i.test(n)), api.notices.slice(-3).join("|"));

	// --- the editor ---
	let committed: Redactions = {};
	const pages = [demoPage("pg-1", true), demoPage("pg-2")];
	const m = new RedactModal({
		app, media, options: {}, pageIndex: 0, initial: {}, pages: () => pages,
		commit: (b) => { committed = b; },
	});
	let root = mount(m);
	await waitPreview(root);
	add("the editor shows the first page picture", root.querySelector<HTMLImageElement>(".nb-redact-img")?.src.startsWith("blob:") === true);
	add("the editor says which page it is", /Page 1 of 2/.test(root.querySelector(".nb-redact-page")?.textContent ?? ""));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	drag(root, [0.2, 0.25], [0.65, 0.33]);
	await sleep(60);
	add("a pen drag draws a box and hands it out", countBoxes(committed) === 1 && (committed["pg-1"]?.length ?? 0) === 1, JSON.stringify(committed));
	add("the box is outlined on the picture", root.querySelectorAll(".nb-redact-box").length === 1);
	await waitPreview(root);
	add("the picture is drawn again from the redacted page", root.querySelector<HTMLImageElement>(".nb-redact-img")?.src.startsWith("blob:") === true);
	drag(root, [0.3, 0.3], [0.305, 0.305]);
	await sleep(40);
	add("a tap draws nothing", countBoxes(committed) === 1);
	drag(root, [0.1, 0.5], [0.3, 0.6], "touch");
	await sleep(40);
	add("a finger draws too while the switch is on", countBoxes(committed) === 2, String(countBoxes(committed)));
	buttonNamed(root, /Draw with finger/)?.click();
	await sleep(20);
	drag(root, [0.5, 0.6], [0.8, 0.7], "touch");
	await sleep(40);
	add("with the switch off a finger draws nothing (it scrolls)", countBoxes(committed) === 2 && buttonNamed(root, /Draw with finger/)?.getAttribute("aria-pressed") === "false");
	buttonNamed(root, /Undo last box/)?.click();
	await sleep(30);
	add("Undo last box removes the last one", countBoxes(committed) === 1);
	buttonNamed(root, /Next page/)?.click();
	await sleep(40);
	add("Next page moves on and the count follows", /Page 2 of 2/.test(root.querySelector(".nb-redact-page")?.textContent ?? "") && /0 on this page, 1 in all/.test(root.querySelector(".nb-redact-count")?.textContent ?? ""), root.querySelector(".nb-redact-count")?.textContent ?? "");
	await waitPreview(root);
	drag(root, [0.2, 0.2], [0.5, 0.3]);
	await sleep(40);
	add("each page keeps its own boxes", countBoxes(committed) === 2 && Object.keys(committed).length === 2);
	buttonNamed(root, /Previous page/)?.click();
	await sleep(40);
	root.querySelector<HTMLElement>(".nb-redact-x")?.click();
	await sleep(30);
	add("a box's cross removes it", countBoxes(committed) === 1 && Object.keys(committed).join() === "pg-2", JSON.stringify(committed));
	buttonNamed(root, /Clear all/)?.click();
	await sleep(30);
	add("Clear all empties the set", countBoxes(committed) === 0);
	add("every control has an explanation for long press", [...root.querySelectorAll<HTMLElement>(".nb-redact-bar button, .nb-redact-tools button")].every((b) => !!b.dataset.help), [...root.querySelectorAll<HTMLElement>(".nb-redact-bar button, .nb-redact-tools button")].filter((b) => !b.dataset.help).map((b) => b.textContent).join());
	closeAll();

	// --- the export dialog ---
	const picked: ExportRequest[] = [];
	const state: { v: RedactState } = { v: { on: false, boxes: {} } };
	let edits = 0;
	const exportModal = (): ExportModal => new ExportModal({
		app, pageCount: 2, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Tax (PNG)", canPrint: false, pages: () => pages,
		redact: {
			state: () => state.v,
			save: (s) => { state.v = s; },
			edit: (closed) => { edits++; state.v = { on: state.v.on, boxes: { "pg-1": [BOX] } }; closed(); },
		},
		run: (request) => picked.push(request),
	});
	root = mount(exportModal());
	await sleep(60);
	add("the export dialog has the Redact row", !!row(root, /^Cover parts of the page/) && !!buttonNamed(root, /^Redact…/));
	add("the switch is hidden while there are no boxes", !shown(row(root, /^Apply the boxes/)));
	add("the Redact button has a long-press explanation", !!buttonNamed(root, /^Redact…/)?.dataset.help);
	buttonNamed(root, /^Redact…/)?.click();
	await sleep(60);
	add("after drawing boxes the switch is there and on", edits === 1 && shown(row(root, /^Apply the boxes/)) && state.v.on === true, JSON.stringify(state.v));
	add("the row says how many boxes", /1 box on 1 page/.test(row(root, /^Cover parts of the page/)?.textContent ?? ""), row(root, /^Cover parts of the page/)?.textContent ?? "");
	add("the note explains removal and the flattened background", /removed whole/.test(root.textContent ?? "") && /flat image/.test(root.textContent ?? ""));
	root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { if (b.textContent === "Export") b.click(); });
	await sleep(30);
	add("Export sends the boxes with the request", picked.length === 1 && countBoxes(picked[0]?.redact) === 1, JSON.stringify(picked[0]?.redact));
	root = mount(exportModal());
	await sleep(40);
	const toggle = row(root, /^Apply the boxes/)?.querySelector<HTMLInputElement>("input[type=checkbox], .checkbox-container");
	toggle?.click();
	await sleep(30);
	root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { if (b.textContent === "Export") b.click(); });
	await sleep(30);
	add("with the switch off the request carries no boxes", picked.length === 2 && picked[1]?.redact === undefined && state.v.on === false, JSON.stringify(picked[1]?.redact));

	// --- the remembered boxes ---
	saveRedactState(app, "doc-1", { on: true, boxes: { "pg-1": [BOX] } });
	add("the boxes are kept per notebook on this device", countBoxes(loadRedactState(app, "doc-1").boxes) === 1 && countBoxes(loadRedactState(app, "doc-2").boxes) === 0);
	add("the colour of a box is solid black", REDACT_COLOR === "#000000");

	root = mount(exportModal());
	await sleep(80);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** Puts one of the dialogs on screen for the screenshots. */
async function redactShot(api: RedactCheckApi, state: "export" | "editor" | "scan"): Promise<void> {
	closeAll();
	const store = new Map<string, unknown>();
	const app = standIn(api.app, [], store);
	const scanPage = demoPage("pg-1", true);
	const plainPage = demoPage("pg-2");
	const boxes: Redactions = { "pg-1": [BOX, { x: 60, y: 330, width: 330, height: 36 }], "pg-2": [BOX] };
	if (state === "export") {
		const s: { v: RedactState } = { v: { on: true, boxes } };
		mount(new ExportModal({
			app, pageCount: 2, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Tax (PNG)", canPrint: false, pages: () => [plainPage, scanPage],
			redact: { state: () => s.v, save: (v) => { s.v = v; }, edit: (closed) => closed() },
			run: () => undefined,
		}));
		await sleep(250);
		return;
	}
	const { media } = await fakeMedia(app, false);
	const m = new RedactModal({
		app, media, options: {}, pageIndex: 0, initial: boxes, pages: () => (state === "scan" ? [scanPage, plainPage] : [plainPage, scanPage]),
		commit: () => undefined,
	});
	const root = mount(m);
	await waitPreview(root);
	await sleep(200);
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function redactApi(api: RedactCheckApi): Record<string, unknown> {
	return {
		checkRedact: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkRedact(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`redact check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		redactShot: (state: "export" | "editor" | "scan") => redactShot(api, state),
		redactStates: ["export", "editor", "scan"],
		closeRedact: closeAll,
	};
}
