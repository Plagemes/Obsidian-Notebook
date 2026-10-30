// wave 0.10 (81): Print. The chosen pages are drawn to images (the same drawing as the PNG export), put one per sheet in a
// print-friendly container that is only visible when printing (styles.css, `body.notebook-printing`), and the system print
// dialog is opened with `window.print()`. Nothing is written to the vault. Desktop only: a phone or tablet WebView has no
// print dialog, so the action is hidden there (`canPrint`) and the export dialog does not offer it.
import { Platform } from "obsidian";
import { t } from "../i18n";
import type { Page } from "../model/types";
import type { ExportOptions } from "./export";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";

/** Resolution of the printed images: sharp on paper, light enough for a notebook of some dozens of pages. */
export const PRINT_DPI = 150;
/** A page taller than this many times its width is printed over several sheets instead of being shrunk onto one. */
const LONG_PAGE_RATIO = 1.9;

/** Whether this device can print: desktop, with a print function. Always false on Android and iOS. */
export function canPrint(): boolean {
	return Platform.isDesktop && !Platform.isMobile && typeof window !== "undefined" && typeof window.print === "function";
}

/** Printing is in progress (the container exists): a second print waits for the first. */
let printing = false;

/**
 * Builds the print container for `pages` (0-based indices of `all`), prints it and removes it. Returns true when the print
 * dialog was opened. The container is removed when the dialog closes (`afterprint`), and anyway when `print()` returns.
 */
export async function printPages(all: readonly Page[], indices: readonly number[], media: NotebookMedia | null, options: ExportOptions = {}): Promise<boolean> {
	if (!canPrint()) {
		showNotice(t("export.print.unavailable"), 8000);
		return false;
	}
	if (printing) return false;
	const chosen = indices.filter((i) => i >= 0 && i < all.length);
	if (chosen.length === 0) return false;
	printing = true;
	const doc = activeDocument;
	const win = activeWindow;
	const working = showNotice(t("export.working"), 0);
	const renderer = new PageImageRenderer(media, {
		...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}),
		...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.layers ? { layers: options.layers } : {}),
	});
	const urls: string[] = [];
	const root = doc.body.createDiv({ cls: "notebook-print-root", attr: { "aria-hidden": "true" } });
	const cleanup = (): void => {
		root.remove();
		doc.body.removeClass("notebook-printing");
		for (const url of urls) URL.revokeObjectURL(url);
		urls.length = 0;
		printing = false;
	};
	try {
		await options.prepare?.(chosen.map((i) => all[i]!));
		let skipped = 0;
		const images: HTMLImageElement[] = [];
		for (let k = 0; k < chosen.length; k++) {
			working.setMessage(t("export.print.preparing", { done: String(k), total: String(chosen.length) }));
			const page = all[chosen[k]!]!;
			const image = await renderer.render(page, PRINT_DPI);
			skipped += image.skipped;
			const url = URL.createObjectURL(image.blob);
			urls.push(url);
			const sheet = root.createDiv({ cls: "notebook-print-page" });
			// A page much taller than a sheet (an infinite page) keeps its size and flows over several sheets.
			if (image.height > image.width * LONG_PAGE_RATIO) sheet.addClass("is-long");
			const img = sheet.createEl("img", { attr: { src: url, alt: "" } });
			images.push(img);
		}
		// The images must be decoded before the dialog opens, or the preview shows blanks.
		await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
		renderer.close();
		working.hide();
		if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
		doc.body.addClass("notebook-printing");
		// print() blocks until the dialog is closed on a desktop; if it returns earlier the container must stay until
		// `afterprint`, with a long timer as the last resort so it can never stay in the page.
		const done = new Promise<void>((resolve) => {
			const finish = (): void => {
				win.removeEventListener("afterprint", finish);
				resolve();
			};
			win.addEventListener("afterprint", finish);
			win.setTimeout(finish, 10 * 60 * 1000);
		});
		win.print();
		await done;
		cleanup();
		return true;
	} catch (e) {
		working.hide();
		cleanup();
		showNotice(t("export.print.failed", { error: (e as Error).message }), 8000);
		return false;
	} finally {
		renderer.close();
	}
}
