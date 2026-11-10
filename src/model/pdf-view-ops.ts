// 0.28 (#76, format v26): rotating and cropping PDF pages as commands. Pure: the caller supplies the size of each PDF page (read from the PDF).
// One edit applies to one page or to every page that shows a page of the same PDF; each page becomes one `SetPdfView`, the group one undo step.
import { cropView, rotateView, sameView, viewOf, type PdfCrop, type PdfView } from "./pdf-view";
import { planPageView, SetPdfView } from "./pdf-view-command";
import type { Page } from "./types";

/** What to do to the view of each target page. `turns`: quarter turns clockwise added to its rotation. `crop`: undefined keeps the page's crop, null removes it, a rectangle sets it (PDF points; clamped to each page). */
export interface ViewEdit {
	turns: number;
	crop?: PdfCrop | null;
}

export interface ViewTarget {
	page: Page;
	/** The PDF page's size, pt at scale 1 (`PdfStore.pageSizes`). */
	source: { width: number; height: number };
}

export interface ViewBuild {
	commands: SetPdfView[];
	/** Pages left as they are because ink or notes would end up above their top edge (a page has no top margin): move the items first. */
	blocked: number;
	/** Pages whose margins grew so that what lay beyond the new edge stays on the page. */
	grown: number;
	/** Pages the edit would not change. */
	unchanged: number;
}

/** The view a page gets from `edit`. */
export function editedView(current: PdfView | undefined, edit: ViewEdit): PdfView | undefined {
	const turned = edit.turns % 4 === 0 ? current : rotateView(current, edit.turns);
	return edit.crop === undefined ? turned : cropView(turned, edit.crop ?? undefined);
}

/** The commands that apply `edit` to `targets` (pages with a PDF background; others are skipped). */
export function buildViewCommands(targets: readonly ViewTarget[], edit: ViewEdit): ViewBuild {
	const out: ViewBuild = { commands: [], blocked: 0, grown: 0, unchanged: 0 };
	for (const { page, source } of targets) {
		if (page.background?.kind !== "pdf") continue;
		const next = editedView(viewOf(page.background), edit);
		if (sameView(next, viewOf(page.background))) {
			out.unchanged++;
			continue;
		}
		const plan = planPageView(page, source, next);
		if (!plan) continue;
		if (plan.above > 0) {
			out.blocked++;
			continue;
		}
		if (plan.grown.left || plan.grown.right || plan.grown.bottom) out.grown++;
		out.commands.push(new SetPdfView(page.id, plan, edit.crop === undefined ? "rotate" : "crop"));
	}
	return out;
}

/** The pages (in document order) that show a page of the same PDF as `page`, or just `page` when it does not show a PDF page. */
export function pagesOfSamePdf(pages: readonly Page[], page: Page): Page[] {
	const bg = page.background;
	if (bg?.kind !== "pdf") return [page];
	return pages.filter((p) => p.background?.kind === "pdf" && p.background.asset === bg.asset);
}
