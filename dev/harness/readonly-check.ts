/**
 * Smoke check of read-only mode (roadmap 51) and of PNG export, page ranges and Print (roadmap 81) on the `doc=readonly`
 * notebook (npm run harness:check): the real view, toolbar, sheet, export dialog and vault stand-in, with synthetic pen,
 * touch and mouse events. The system print dialog is replaced by a stub of `window.print`.
 */

import { exportPngPages } from "../../src/view/export-png";
import { canPrint, printPages } from "../../src/view/print";
import type { HarnessApp, HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ReadOnlyCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	/** The stand-in app (a `HarnessApp`). */
	app: unknown;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	openMore: () => Promise<void>;
	errors: string[];
	notices: string[];
}

const SWIPE: Array<[number, number]> = [[0.3, 0.3], [0.5, 0.35], [0.7, 0.4]];
const CROSS: Array<[number, number]> = [[0.2, 0.4], [0.5, 0.4], [0.8, 0.4]];

export async function checkReadOnly(api: ReadOnlyCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames, openMore } = api;
	const v = api.view as HarnessView;
	const app = api.app as HarnessApp;
	const vault = app.vault;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const content = (): string => JSON.stringify(v.document.pages);
	const chip = (): HTMLElement | null => document.querySelector(".notebook-readonly-chip");
	const shown = (el: Element | null): boolean => !!el && !el.classList.contains("notebook-hidden") && getComputedStyle(el).display !== "none" && (el as HTMLElement).offsetWidth > 0;
	const noticeCount = (re: RegExp): number => api.notices.filter((n) => re.test(n)).length;

	// Writes done through the vault from now on (a saved change, a backup, a "write it back").
	let writes = 0;
	const writable = vault as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
	for (const name of ["modify", "modifyBinary", "process", "create", "createBinary", "rename", "delete"]) {
		const orig = writable[name]?.bind(vault);
		if (orig) writable[name] = (...args: unknown[]) => (writes++, orig(...args));
	}

	// --- 51: read-only mode ---
	const base = strokeCount();
	await penStroke(CROSS);
	add("a pen stroke is written before the mode is switched on", strokeCount() === base + 1, `${base} -> ${strokeCount()}`);
	add("the chip is hidden while the mode is off", !shown(chip()));
	await v.flushNow();
	setTool("eraser");
	const files = vault.getFiles().length;
	const written = writes;
	const noticesBefore = api.notices.length;

	v.runAction("toggle-read-only");
	await frames(3);
	add("the action switches the mode on", v.readOnlyMode === true && v.uiContext().toggles.readOnly === true && v.uiContext().editable === false);
	add("a notice says what changed", api.notices.slice(noticesBefore).some((n) => /Read-only mode on/.test(n)), api.notices.slice(noticesBefore).join(" | "));
	add("the toolbar shows the read-only indicator", shown(chip()), chip()?.className ?? "missing");
	const tb = document.querySelector(".notebook-toolbar") as HTMLElement;
	add("the indicator replaces the pen indicator and the favourites", !shown(document.querySelector(".notebook-chip")) && !shown(document.querySelector(".notebook-favs")));
	add("the toolbar does not overflow", tb.scrollWidth <= tb.clientWidth + 1, `${tb.scrollWidth} > ${tb.clientWidth}`);
	const chipBox = chip()?.getBoundingClientRect();
	add("the indicator is a touch target of at least 40 px", !!chipBox && chipBox.height >= 39.5 && chipBox.width >= 39.5, chipBox ? `${chipBox.width}x${chipBox.height}` : "missing");
	const toolButtons = [...document.querySelectorAll<HTMLButtonElement>(".notebook-tool-button")];
	add("the writing tools are disabled", toolButtons.length > 0 && toolButtons.every((b) => b.disabled));

	const snapshot = content();
	await penStroke(CROSS, { pointerType: "pen" });
	add("the eraser (pen) removes nothing", strokeCount() === base + 1 && content() === snapshot);
	await penStroke(SWIPE, { pointerType: "pen" });
	await penStroke(SWIPE, { pointerType: "touch" });
	await penStroke(SWIPE, { pointerType: "mouse" });
	add("pen, finger and mouse leave the page as it was", strokeCount() === base + 1 && content() === snapshot);
	v.runAction("tool-pen");
	await penStroke(SWIPE, { pointerType: "pen" });
	add("a tool cannot be chosen and the pen draws nothing", v.uiContext().tool === "eraser" && content() === snapshot, `tool ${v.uiContext().tool}`);
	v.undo();
	v.redo();
	v.runAction("undo");
	add("undo and redo do nothing (the history is kept)", content() === snapshot && v.history.canUndo());
	const pages = v.document.pages.length;
	v.runAction("add-page");
	v.addPage();
	add("no page can be added", v.document.pages.length === pages);
	v.removeSelection();
	v.applyCommand({ label: "probe", apply() { throw new Error("must not run"); }, revert() { /* none */ } });
	add("a command from outside is refused", content() === snapshot);

	// Reading still works: zoom to fit, the page panel, the sheet with the switch.
	let navigation = true;
	try {
		v.runAction("fit-width");
		v.toggleNavigator();
		await frames(3);
		v.toggleNavigator();
	} catch (e) {
		navigation = false;
		add("navigation threw", false, String(e));
	}
	add("fit and the page panel still work", navigation);
	await openMore();
	const sheetText = document.querySelector(".notebook-sheet")?.textContent ?? "";
	add("the sheet has the switch, checked", /Read-only mode/.test(sheetText) && !!document.querySelector(".notebook-sheet [aria-pressed='true']"), sheetText.slice(0, 80));
	v.ui.sheet.close();

	await sleep(2300);
	add("nothing was written or backed up while it was on", writes === written && vault.getFiles().length === files, `writes ${writes - written}, files ${vault.getFiles().length - files}`);
	add("the document is still saved", v.session.isSaved());

	// Back to editing with the indicator.
	chip()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	await frames(3);
	add("tapping the indicator switches the mode off", v.readOnlyMode === false && !shown(chip()) && noticeCount(/Read-only mode off/) === 1);
	setTool("pen");
	await penStroke(SWIPE);
	add("writing works again", strokeCount() === base + 2, `${base + 1} -> ${strokeCount()}`);
	v.undo();
	add("and so does undo", strokeCount() === base + 1);
	v.redo();

	// The toggle is also a command, and the mode is lost with the notebook.
	v.runAction("toggle-read-only");
	add("the mode can be switched on again", v.readOnlyMode === true);
	v.setReadOnlyMode(false, false);

	// --- 81: export dialog, PNG images and ranges ---
	v.addPage();
	v.addPage();
	await frames(2);
	const total = v.document.pages.length;
	add("the notebook has three pages for the range tests", total === 3, String(total));
	v.openExportDialog(undefined, "png");
	const modal = document.querySelector<HTMLElement>(".modal");
	const selects = modal ? [...modal.querySelectorAll("select")] as HTMLSelectElement[] : [];
	const row = (name: RegExp): HTMLElement | null => [...(modal?.querySelectorAll<HTMLElement>(".setting-item") ?? [])].find((s) => name.test(s.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;
	const visible = (el: HTMLElement | null): boolean => !!el && el.style.display !== "none";
	add("the dialog starts on PNG images with a folder and a scale", selects[0]?.value === "png" && visible(row(/^Folder/)) && visible(row(/^Scale/)) && !visible(row(/^Pages/)),
		`format ${selects[0]?.value}, folder ${visible(row(/^Folder/))}, scale ${visible(row(/^Scale/))}, pages ${visible(row(/^Pages/))}`);
	const formats = [...(selects[0]?.options ?? [])].map((o) => o.value);
	add("Print is offered exactly where the device can print", formats.includes("print") === canPrint(), formats.join(","));
	const folderInput = row(/^Folder/)?.querySelector("input") as HTMLInputElement | undefined;
	add("the suggested folder is next to the notebook", folderInput?.value === "Notebooks/New (PNG)", folderInput?.value ?? "missing");
	if (selects[1]) {
		selects[1].value = "range";
		selects[1].dispatchEvent(new Event("change"));
	}
	add("choosing some pages shows the range field", visible(row(/^Pages/)));
	const rangeInput = row(/^Pages/)?.querySelector("input") as HTMLInputElement | undefined;
	const exportButton = [...(modal?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Export");
	const filesBefore = vault.getFiles().length;
	if (rangeInput) {
		rangeInput.value = "9";
		rangeInput.dispatchEvent(new Event("input"));
	}
	exportButton?.click();
	await sleep(100);
	add("a page that does not exist is refused in the dialog", !!document.querySelector(".modal") && /Page 9 does not exist/.test(document.querySelector(".notebook-export-problem")?.textContent ?? "") && vault.getFiles().length === filesBefore,
		document.querySelector(".notebook-export-problem")?.textContent ?? "");
	if (rangeInput) {
		rangeInput.value = "2-3";
		rangeInput.dispatchEvent(new Event("input"));
	}
	if (selects[3]) {
		selects[3].value = "1";
		selects[3].dispatchEvent(new Event("change"));
	}
	exportButton?.click();
	for (let i = 0; i < 40 && !vault.getFileByPath("Notebooks/New (PNG)/page-003.png"); i++) await sleep(100);
	const names = vault.getFiles().map((f) => f.path).filter((p) => p.startsWith("Notebooks/New (PNG)/")).sort();
	add("the range 2-3 writes page-002.png and page-003.png only", names.join("|") === "Notebooks/New (PNG)/page-002.png|Notebooks/New (PNG)/page-003.png", names.join("|"));
	add("the dialog closed", !document.querySelector(".modal"));

	const png = async (path: string) => new Uint8Array(await vault.readBinary(vault.getFileByPath(path)!));
	const first = await png("Notebooks/New (PNG)/page-002.png");
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => first[i] === b);
	const dv = new DataView(first.buffer, first.byteOffset);
	const page = v.document.pages[1]!;
	add("it is a PNG of the page at scale 1", signature && dv.getUint32(16) === Math.round(page.width) && dv.getUint32(20) === Math.round(page.height),
		`${dv.getUint32(16)}x${dv.getUint32(20)} for ${page.width}x${page.height}`);

	// Never overwritten; scale 2 doubles the size; ink only is transparent.
	await exportPngPages(app as unknown as Parameters<typeof exportPngPages>[0], v.document.pages, { folder: "Notebooks/New (PNG)", scale: 2, pages: [1] }, v.mediaCache, { layers: "ink" });
	const second = vault.getFileByPath("Notebooks/New (PNG)/page-002 2.png");
	add("an existing image is never replaced", !!second && vault.getFileByPath("Notebooks/New (PNG)/page-002.png"));
	if (second) {
		const bytes = await png(second.path);
		const dv2 = new DataView(bytes.buffer, bytes.byteOffset);
		add("scale 2 doubles the size", Math.abs(dv2.getUint32(16) - 2 * dv.getUint32(16)) <= 1 && Math.abs(dv2.getUint32(20) - 2 * dv.getUint32(20)) <= 1, `${dv2.getUint32(16)}x${dv2.getUint32(20)}`);
		const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const cv = createEl("canvas");
		cv.width = bmp.width;
		cv.height = bmp.height;
		const ctx = cv.getContext("2d")!;
		ctx.drawImage(bmp, 0, 0);
		add("ink only is transparent where nothing is written", ctx.getImageData(2, 2, 1, 1).data[3] === 0);
	}
	const whole = await png("Notebooks/New (PNG)/page-003.png");
	const wbmp = await createImageBitmap(new Blob([whole], { type: "image/png" }));
	const wc = createEl("canvas");
	wc.width = wbmp.width;
	wc.height = wbmp.height;
	const wctx = wc.getContext("2d")!;
	wctx.drawImage(wbmp, 0, 0);
	add("with the background the sheet is white", wctx.getImageData(2, 2, 1, 1).data[3] === 255);

	// --- 81: print ---
	const filesPrint = vault.getFiles().length;
	let printed: { pages: number; decoded: boolean; hiddenOnScreen: boolean; bodyClass: boolean } | null = null;
	const realPrint = window.print.bind(window);
	window.print = () => {
		const imgs = [...document.querySelectorAll<HTMLImageElement>(".notebook-print-root .notebook-print-page > img")];
		const root = document.querySelector(".notebook-print-root");
		printed = {
			pages: imgs.length, decoded: imgs.every((i) => i.naturalWidth > 0), hiddenOnScreen: !!root && getComputedStyle(root).display === "none",
			bodyClass: document.body.classList.contains("notebook-printing"),
		};
		window.dispatchEvent(new Event("afterprint"));
	};
	try {
		const ok = await printPages(v.document.pages, [0, 2], v.mediaCache);
		if (canPrint()) {
			const p = printed as { pages: number; decoded: boolean; hiddenOnScreen: boolean; bodyClass: boolean } | null;
			add("print puts the chosen pages in a container and opens the dialog", ok && p?.pages === 2 && p.decoded && p.bodyClass, JSON.stringify(p));
			add("the container is never visible on screen", p?.hiddenOnScreen === true);
			add("the container is removed afterwards", !document.querySelector(".notebook-print-root") && !document.body.classList.contains("notebook-printing"));
			add("printing writes nothing to the vault", vault.getFiles().length === filesPrint);
		} else {
			add("without a print dialog nothing is printed and the user is told", !ok && printed === null && noticeCount(/Printing is not available/) >= 1);
			add("no container is left", !document.querySelector(".notebook-print-root"));
		}
	} finally {
		window.print = realPrint;
	}
	await openMore();
	const sheet = document.querySelector(".notebook-sheet")?.textContent ?? "";
	add("the sheet lists PNG images, and Print only where it works", /Export pages as PNG images/.test(sheet) && /Print…/.test(sheet) === canPrint(), `print listed ${/Print…/.test(sheet)}, canPrint ${canPrint()}`);
	v.ui.sheet.close();

	// The screenshot of the scenario shows the toolbar with the read-only indicator.
	v.setReadOnlyMode(true, false);
	await frames(3);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { canPrint: canPrint() } };
}
