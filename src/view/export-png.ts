// wave 0.10 (81): "Export pages as PNG images". One PNG per chosen page, into a vault folder through the vault API, at a
// chosen scale. Nothing is ever overwritten (a name that exists gets " 2", " 3"…) and nothing is deleted when it fails: the
// images written so far stay and the notice says how many. The document is only read.
import { normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { planPageImages, scaleDpi } from "../model/export-pages";
import type { Page } from "../model/types";
import type { ExportOptions } from "./export";
import { prepareExportFolder } from "./export-markdown";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";

export interface PngExportRequest {
	/** Vault folder the images go in (created when missing). */
	folder: string;
	/** Pixels per pt (see `PNG_SCALES`). */
	scale: number;
	/** 0-based indices of the pages to write, ascending. */
	pages: readonly number[];
}

/** Writes the images; returns the folder they went to, or null when nothing was written because it failed at once. */
export async function exportPngPages(app: App, pages: readonly Page[], request: PngExportRequest, media: NotebookMedia | null, options: ExportOptions = {}): Promise<string | null> {
	const working = showNotice(t("export.working"), 0);
	let written = 0;
	const renderer = new PageImageRenderer(media, {
		...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}),
		...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.layers ? { layers: options.layers } : {}),
	});
	try {
		const chosen = request.pages.filter((i) => i >= 0 && i < pages.length);
		if (chosen.length === 0) return null;
		const { dir, prefix, exists } = await prepareExportFolder(app, request.folder);
		const names = planPageImages(dir, chosen, pages.length, exists);
		await options.prepare?.(chosen.map((i) => pages[i]!));
		let skipped = 0;
		for (let k = 0; k < chosen.length; k++) {
			working.setMessage(t("export.progress", { done: String(k), total: String(chosen.length) }));
			const image = await renderer.render(pages[chosen[k]!]!, scaleDpi(request.scale));
			skipped += image.skipped;
			await app.vault.createBinary(normalizePath(`${prefix}${names[k]!}`), await image.blob.arrayBuffer());
			written++;
		}
		const path = dir === "" ? "/" : dir;
		showNotice(t("export.png.done", { n: String(written), path }), 8000);
		if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
		return path;
	} catch (e) {
		showNotice(t("export.png.failed", { done: String(written), error: (e as Error).message }), 10000);
		return null;
	} finally {
		renderer.close();
		working.hide();
	}
}
