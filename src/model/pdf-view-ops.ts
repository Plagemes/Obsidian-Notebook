// 0.28 (#76, format v26): rotating and cropping PDF pages as commands. Pure: the caller supplies the size of each PDF page (read from the PDF).
// One edit applies to one page or to every page that shows a page of the same PDF; each page becomes one `SetPdfView`, the group one undo step.
// Review fixes: pages that cannot take the change (locked, with redaction boxes, ink that would end up above the page, an excerpt of them on a
// locked page) are skipped and counted, never half done; same-notebook excerpts and saved views that point into a changed page follow it in the
// same step.
import type { Matrix } from "../ink/transform";
import { clampSourceRegion } from "./excerpts";
import { ReplaceElement, type Command } from "./history";
import { cropView, mapRect, rotateView, sameView, viewOf, type PdfCrop, type PdfView } from "./pdf-view";
import { planPageView, SetPdfView } from "./pdf-view-command";
import { freezeElement } from "./serialize";
import type { ExcerptElement, NotebookDocument, Page, SavedView } from "./types";
import { SetViews } from "./views";

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

/** What `buildViewCommands` may need to know beyond the pages. */
export interface ViewBuildOptions {
	/** The notebook: same-notebook excerpts and saved views that point into a changed page are carried with it. */
	doc?: Pick<NotebookDocument, "id" | "pages" | "views">;
	/** Pages that must not be turned or cropped because they have redaction boxes (or the boxes cannot be read): their boxes would stay where the old page was. */
	redacted?: (pageId: string) => boolean;
}

export interface ViewBuild {
	/** One `SetPdfView` per page that changes. */
	commands: SetPdfView[];
	/** Everything to run, in order, as ONE undo step: the excerpts that follow the pages first, the page changes, the saved views last. */
	ordered: Command[];
	/** Pages left as they are because ink or notes would end up above their top edge (a page has no top margin): move the items first. */
	blocked: number;
	/** Pages left as they are because they are locked. */
	locked: number;
	/** Pages left as they are because they have redaction boxes. */
	redacted: number;
	/** Pages left as they are because an excerpt of them is on a locked page (it could not follow). */
	sources: number;
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

export type SkipReason = "blocked" | "locked" | "redacted" | "sources";

/** The pages of `build` that were not changed, by the reason the reader can act on. */
export function skippedReasons(build: ViewBuild): Array<[SkipReason, number]> {
	const out: Array<[SkipReason, number]> = [];
	if (build.blocked > 0) out.push(["blocked", build.blocked]);
	if (build.locked > 0) out.push(["locked", build.locked]);
	if (build.redacted > 0) out.push(["redacted", build.redacted]);
	if (build.sources > 0) out.push(["sources", build.sources]);
	return out;
}

type Rect = { x: number; y: number; width: number; height: number };

/** A rectangle carried by `m` and kept inside a page of `size` (the whole page when nothing of it is left). */
function carriedRect(m: Matrix, r: Rect, size: { width: number; height: number }): Rect {
	const c = mapRect(m, r);
	const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y);
	const x1 = Math.min(size.width, c.x + c.width), y1 = Math.min(size.height, c.y + c.height);
	if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return { x: 0, y: 0, width: size.width, height: size.height };
	const round = (n: number): number => Math.round(n * 100) / 100;
	return { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
}

/** The commands that apply `edit` to `targets` (pages with a PDF background; others are skipped). */
export function buildViewCommands(targets: readonly ViewTarget[], edit: ViewEdit, options: ViewBuildOptions = {}): ViewBuild {
	const out: ViewBuild = { commands: [], ordered: [], blocked: 0, locked: 0, redacted: 0, sources: 0, grown: 0, unchanged: 0 };
	const doc = options.doc;
	const before: readonly SavedView[] = doc?.views ?? [];
	let views: SavedView[] = [...before];
	const followers: Command[] = [];
	for (const { page, source } of targets) {
		if (page.background?.kind !== "pdf") continue;
		const next = editedView(viewOf(page.background), edit);
		if (sameView(next, viewOf(page.background))) {
			out.unchanged++;
			continue;
		}
		if (options.redacted?.(page.id)) {
			out.redacted++;
			continue;
		}
		if (page.locked === true) {
			out.locked++;
			continue;
		}
		const plan = planPageView(page, source, next);
		if (!plan) continue;
		if (plan.above > 0) {
			out.blocked++;
			continue;
		}
		// Same-notebook excerpts whose source is this page follow it (the live picture and the jump back would show another part otherwise).
		const follow: Command[] = [];
		let lockedHost = false;
		const newSize = { width: plan.width, height: plan.height };
		if (doc) {
			for (const host of doc.pages) {
				for (const el of host.elements ?? []) {
					if (el.type !== "excerpt" || el.source.doc !== doc.id || el.source.page !== page.id) continue;
					if (host.locked === true) lockedHost = true;
					const r = carriedRect(plan.matrix, el.source, newSize);
					const region = clampSourceRegion({ ...el.source, ...r }, newSize) ?? { x: 0, y: 0, width: newSize.width, height: newSize.height };
					const after = freezeElement<ExcerptElement>({ ...el, source: { ...el.source, ...region } });
					follow.push(new ReplaceElement(host.id, el, after));
				}
			}
		}
		if (lockedHost) {
			out.sources++;
			continue;
		}
		followers.push(...follow);
		// Saved views of this page follow it too.
		views = views.map((v) => (v.page === page.id ? { ...v, ...carriedRect(plan.matrix, v, newSize) } : v));
		if (plan.grown.left || plan.grown.right || plan.grown.bottom) out.grown++;
		out.commands.push(new SetPdfView(page.id, plan, edit.crop === undefined ? "rotate" : "crop"));
	}
	out.ordered.push(...followers, ...out.commands);
	if (out.commands.length > 0 && JSON.stringify(views) !== JSON.stringify(before)) out.ordered.push(new SetViews(before, views));
	return out;
}

/** The pages (in document order) that show a page of the same PDF as `page`, or just `page` when it does not show a PDF page. */
export function pagesOfSamePdf(pages: readonly Page[], page: Page): Page[] {
	const bg = page.background;
	if (bg?.kind !== "pdf") return [page];
	return pages.filter((p) => p.background?.kind === "pdf" && p.background.asset === bg.asset);
}
