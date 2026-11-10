/**
 * Smoke check of rotating and cropping a PDF page (0.28, roadmap #76, format v26) on the `doc=pdfrotate` notebook (the slides notebook: three pages of
 * a fake PDF with a frame and a red mark in the top-left corner of each sheet; HARNESS_DOC=pdfrotate npm run harness:check): the real view, page
 * sheet actions, History and renderer. *Rotate PDF page right* turns the sheet (the red mark goes to the top-right corner of the composited canvas),
 * the page becomes landscape, the ink written on it is carried with it and Undo/Redo put everything back; the crop dialog opens with its handles, a
 * drag of a handle changes the frame and Apply stores `crop` (the page shrinks, the ink keeps its place on the sheet); *All N pages* applies one crop to
 * every page of the PDF as one step; a locked page refuses both; the writer and the reader keep the fields. The crop dialog is left open on a
 * turned page with the frame moved in, for the screenshot (tablet and phone, light and dark).
 */
import { parse, serialize } from "../../src/model/serialize";
import { SetPageLocked } from "../../src/model/page-lock";
import type { NotebookDocument, Page } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface PdfrotateCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface RotateView {
	document: NotebookDocument;
	currentPage(): number;
	runAction(id: string): void;
	goToPage?(index: number): void;
	applyCommand(command: unknown): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkPdfrotate(api: PdfrotateCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as RotateView;
	// The page the check works on (the page in view can change when the layout does, on a phone).
	const index = v.currentPage();
	const page = (): Page => v.document.pages[index]!;
	/** A page action, on the page the check works on (the page in view can change when the layout does). */
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const trace: string[] = [];
	const act = async (id: string): Promise<void> => {
		trace.push(`${id}: in view ${v.currentPage()}, goToPage ${typeof v.goToPage}`);
		for (let i = 0; i < 20 && v.currentPage() !== index; i++) {
			v.goToPage?.(index);
			await sleep(150);
		}
		trace.push(`now ${v.currentPage()}`);
		v.runAction(id);
	};
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const near = (a: number, b: number, eps = 0.06) => Math.abs(a - b) <= eps;
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[index]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	/** The colour of the composited static canvas at a point of the current page. */
	const pixel = (x: number, y: number): [number, number, number] => {
		const canvas = q<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
		const r = canvas.getBoundingClientRect();
		const stage = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[index]!;
		const cx = ((v.viewport.offsetX + (box.x + x) * v.viewport.scale) + stage.left - r.left) * (canvas.width / r.width);
		const cy = ((v.viewport.offsetY + (box.y + y) * v.viewport.scale) + stage.top - r.top) * (canvas.height / r.height);
		const d = canvas.getContext("2d")!.getImageData(Math.round(cx), Math.round(cy), 1, 1).data;
		return [d[0]!, d[1]!, d[2]!];
	};
	const isRed = (c: [number, number, number]) => c[0] > 170 && c[1] < 100 && c[2] < 100;
	const settle = async () => {
		await api.frames(3);
		await sleep(450);
		await api.frames(2);
		// A closed dialog leaves its (empty) dimmed layer behind in the harness.
		for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
	};
	/** Opens the crop dialog, in the dimmed layer that stands in for Obsidian's modal container. */
	const openCrop = async () => {
		await act("pdf-crop");
		await sleep(500);
		await api.frames(2);
		const box = q(".nb-pdfview");
		if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
		await api.frames(2);
	};
	const fire = (el: Element, type: string, x: number, y: number) =>
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
	const centre = (el: Element): [number, number] => {
		const r = el.getBoundingClientRect();
		return [r.left + r.width / 2, r.top + r.height / 2];
	};
	/** A finger on a handle of the crop frame, moved by (dx, dy) CSS px. */
	const dragHandle = async (name: string, dx: number, dy: number) => {
		const h = q(`.nb-pdfview .nb-pdfview-handle.is-${name}`)!;
		const [x, y] = centre(h);
		fire(h, "pointerdown", x, y);
		fire(h, "pointermove", x + dx / 2, y + dy / 2);
		fire(h, "pointermove", x + dx, y + dy);
		fire(h, "pointerup", x + dx, y + dy);
		await api.frames(2);
	};
	const dialogButton = (cls: string) => q<HTMLButtonElement>(`.nb-pdfview .nb-modal-foot button.${cls}`);

	// --- a PDF page with ink on it ---
	add("the page is a PDF page of 595 x 842 pt, upright", page().background?.kind === "pdf" && near(page().width, 595.28) && near(page().height, 841.89));
	const bgOf = () => page().background as { kind: "pdf"; rotate?: number; crop?: { x: number; y: number; width: number; height: number } };
	// One page at a time: a turned page is short, and with several pages in view the page in view (the one the page actions mean) would not be this one.
	v.runAction("toggle-page-mode");
	await settle();
	v.goToPage?.(index);
	await settle();
	api.setTool("pen");
	await api.frames(2);
	await api.penStroke([frac(100, 400), frac(200, 410), frac(300, 400)], { steps: 12 });
	await sleep(150);
	const ink = () => page().strokes[page().strokes.length - 1]!;
	const first = ink().points[0]!;
	add("a stroke was written on the sheet", page().strokes.length === 1 && near(first[0], 100, 3) && near(first[1], 400, 3), JSON.stringify(first));
	add("the red mark of the sheet is at the top-left of the page", isRed(pixel(15, 15)), JSON.stringify(pixel(15, 15)));

	// --- Rotate right ---
	const W = page().width, H = page().height;
	await act("pdf-rotate-right");
	await settle();
	v.runAction("fit-width");
	await settle();
	add("Rotate PDF page right stores rotate 90 and swaps the page size", bgOf().rotate === 90 && bgOf().crop === undefined && near(page().width, H) && near(page().height, W), JSON.stringify(page().background));
	const turned = ink().points[0]!;
	add("the ink is carried with the sheet: (x, y) goes to (height - y, x)", near(turned[0], H - first[1], 0.02) && near(turned[1], first[0], 0.02), JSON.stringify(turned));
	add("the red mark is now at the top-right of the composited canvas", isRed(pixel(H - 15, 15)) && !isRed(pixel(15, 15)), `${JSON.stringify(pixel(H - 15, 15))} ${JSON.stringify(pixel(15, 15))}`);
	const stroke = ink();
	v.runAction("undo");
	await settle();
	add("Undo puts the page, the background and the very same stroke back", bgOf().rotate === undefined && near(page().width, W) && near(page().height, H) && page().strokes[0]!.points[0]![0] === first[0], JSON.stringify(page().background));
	add("the red mark is back at the top-left", isRed(pixel(15, 15)));
	v.runAction("redo");
	await settle();
	add("Redo turns it again, to the same stroke", bgOf().rotate === 90 && ink().points[0]![0] === stroke.points[0]![0]);
	await act("pdf-rotate-left");
	await settle();
	add("Rotate left brings it upright exactly", bgOf().rotate === undefined && near(ink().points[0]![0], first[0], 0.02) && near(ink().points[0]![1], first[1], 0.02) && near(page().width, W), `${JSON.stringify(page().background)} ${page().width}x${page().height} ink ${JSON.stringify(ink().points[0])} was ${JSON.stringify(first)} page in view ${v.currentPage()} notices ${api.notices.join("|")} trace ${trace.join(" ; ")}`);

	// --- a locked page refuses ---
	v.applyCommand(new SetPageLocked(page().id, true));
	await api.frames(2);
	await act("pdf-rotate-right");
	await settle();
	add("a locked page is not turned", bgOf().rotate === undefined && near(page().width, W));
	v.runAction("undo");
	await api.frames(2);
	add("the lock was undone to go on", page().locked !== true);

	// --- the crop dialog ---
	await openCrop();
	add("Crop PDF page opens a dialog with a preview and eight handles", visible(q(".nb-pdfview")) && visible(q(".nb-pdfview canvas.nb-pdfview-canvas")) && document.querySelectorAll(".nb-pdfview .nb-pdfview-handle").length === 8);
	const applyButton = () => dialogButton("is-primary");
	add("Apply waits for a change", applyButton()?.disabled === true);
	const handle = q<HTMLElement>(".nb-pdfview .nb-pdfview-handle.is-se")!;
	const hr = handle.getBoundingClientRect();
	add("the handles are finger-sized", hr.width >= 40 && hr.height >= 40, `${hr.width} x ${hr.height}`);
	const modal = q<HTMLElement>(".nb-pdfview")!.getBoundingClientRect();
	add("the dialog fits the window", modal.left >= 0 && modal.right <= window.innerWidth + 1 && modal.bottom <= window.innerHeight + 1, `${Math.round(modal.left)}..${Math.round(modal.right)} x ..${Math.round(modal.bottom)} in ${window.innerWidth} x ${window.innerHeight}`);
	const readoutBefore = q(".nb-pdfview .nb-pdfview-readout")?.textContent ?? "";
	const stage = q(".nb-pdfview .nb-pdfview-page")!.getBoundingClientRect();
	await dragHandle("se", -stage.width * 0.2, -stage.height * 0.15);
	await dragHandle("nw", stage.width * 0.1, stage.height * 0.1);
	add("dragging handles changes the frame and the readout", (q(".nb-pdfview .nb-pdfview-readout")?.textContent ?? "") !== readoutBefore && applyButton()?.disabled === false, q(".nb-pdfview .nb-pdfview-readout")?.textContent ?? "");
	applyButton()!.click();
	await settle();
	const crop = bgOf().crop;
	add("Apply stores a crop and the page shrinks to it", !!crop && near(page().width, crop.width, 0.02) && near(page().height, crop.height, 0.02) && crop.width < W * 0.8, JSON.stringify(page().background));
	add("the ink keeps its place on the sheet (shifted by the crop corner)", !!crop && near(ink().points[0]![0], first[0] - crop.x, 0.02) && near(ink().points[0]![1], first[1] - crop.y, 0.02), JSON.stringify(ink().points[0]));
	v.runAction("undo");
	await settle();
	add("Undo brings the whole page and the stroke back", bgOf().crop === undefined && near(page().width, W) && near(page().height, H) && near(ink().points[0]![0], first[0], 0.02));
	v.runAction("redo");
	await settle();
	add("Redo crops it again", !!bgOf().crop);

	// --- the file keeps it ---
	const text = serialize(v.document);
	const read = parse(text);
	add("the writer and the reader keep the turn and the crop", read.ok && read.dropped === undefined && JSON.stringify(read.doc.pages[index]!.background) === JSON.stringify(page().background), read.ok ? "" : read.message);
	v.runAction("undo");
	await settle();

	// --- all the pages of this PDF ---
	await openCrop();
	const all =q<HTMLInputElement>(".nb-pdfview .nb-modal-check input");
	add("with three pages of one PDF the dialog offers all of them", !!all && /3/.test(q(".nb-pdfview .nb-modal-check")?.textContent ?? ""), q(".nb-pdfview .nb-modal-check")?.textContent ?? "");
	if (all) {
		all.checked = true;
		all.dispatchEvent(new Event("change", { bubbles: true }));
	}
	await dragHandle("e", -stage.width * 0.3, 0);
	applyButton()!.click();
	await settle();
	const cropped = v.document.pages.filter((p) => p.background?.kind === "pdf" && (p.background as { crop?: unknown }).crop !== undefined);
	add("one Apply cropped all three pages", cropped.length === 3 && new Set(cropped.map((p) => JSON.stringify((p.background as { crop?: unknown }).crop))).size === 1, String(cropped.length));
	v.runAction("undo");
	await settle();
	add("one Undo brings all three back", v.document.pages.every((p) => (p.background as { crop?: unknown }).crop === undefined));

	// --- a turn inside the dialog, and the specimen left for the screenshot ---
	await act("pdf-rotate-right");
	await settle();
	await openCrop();
	const bar =Array.from(document.querySelectorAll<HTMLButtonElement>(".nb-pdfview .nb-pdfview-bar .nb-icon-btn"));
	const canvas = q<HTMLCanvasElement>(".nb-pdfview canvas.nb-pdfview-canvas")!;
	const landscape = canvas.width > canvas.height;
	bar[1]?.click();
	await sleep(500);
	await api.frames(2);
	add("the turn buttons turn the preview (landscape becomes portrait)", bar.length === 2 && landscape && canvas.width < canvas.height, `${canvas.width} x ${canvas.height}`);
	bar[0]?.click();
	await sleep(500);
	await api.frames(2);
	await dragHandle("sw", stage.width * 0.08, -stage.height * 0.06);
	await dragHandle("ne", -stage.width * 0.05, stage.height * 0.08);
	add("every control of the dialog is real: handles, turn buttons, Whole page, Apply, Cancel", bar.length === 2 && !!q(".nb-pdfview .nb-pdfview-bar .nb-modal-btn") && !!applyButton() && !!dialogButton("is-secondary"));
	add("no error was logged", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { page: index, width: page().width, height: page().height } };
}
