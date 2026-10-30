// ui redesign: what each view action of the registry (ui/actions.ts) does. One place for the toolbar quick slots, the
// contextual bar, the sheets, the radial menu and the commands. Page actions take the page they act on (`arg.page`,
// default: the page in view); choices take their value (`arg.value`).
import { Notice } from "obsidian";
import { t } from "../i18n";
import { copyPageLink, insertPageIntoNote } from "../integration/page-share";
import { openPageRestore } from "../integration/reliability";
import { cloneMeta } from "../model/document";
import { AddPage, DeletePage, MovePage, SetMeta, SetPageInfinite, SetPageSize, SetPaper } from "../model/history";
import { duplicatePage } from "../model/pages";
import { DEFAULT_META, PAGE_SIZES, PAPER_KINDS, PAPER_SPACING, type Page, type PageSizeName, type PaperKind } from "../model/types";
import { actionById } from "../ui/actions";
import { exportPdf, exportSvg } from "./export";
import { GotoPageModal } from "./goto-page";
import type { NotebookView } from "./notebook-view";
import { editBookmark, editPageTags } from "./outline";
import { exportPdfAnnotations, openMarginsModal, updatePdfFromNewVersion } from "./pdf-actions";
import { pdfSideState, runPdfSideAction, type PdfSideAction } from "./pdf-sync";
import { deletePageKeepingCopy, newPageFromTemplate, openDeletedPages, savePageAsTemplate } from "./page-tools";
import { toggleBookmark } from "./view-helpers";

export interface ActionArg {
	page?: number;
	value?: string;
}

/** The size preset of a page (either orientation), or null for a custom size. */
export function sizeName(page: Page): PageSizeName | null {
	const short = Math.min(page.width, page.height), long = Math.max(page.width, page.height);
	return (Object.keys(PAGE_SIZES) as PageSizeName[]).find((n) => PAGE_SIZES[n].width === short && PAGE_SIZES[n].height === long) ?? null;
}

/** Whether a command of the registry applies to this view now (the palette hides it otherwise). */
export function commandApplies(view: NotebookView, id: string): boolean {
	if (id === "pdf-side-open") return pdfSideState(view).available;
	if (id.startsWith("pdf-side-")) return pdfSideState(view).open;
	return true;
}

type Runner = (view: NotebookView, arg: ActionArg) => void;

/** Runs `fn` with page `arg.page` (default: the page in view) of the open document. */
function onPage(fn: (view: NotebookView, page: Page, index: number) => void): Runner {
	return (view, arg) => {
		const doc = view.document;
		const index = arg.page ?? view.currentPage();
		const page = doc?.pages[index];
		if (page) fn(view, page, index);
	};
}

function setSize(view: NotebookView, page: Page, index: number, name: PageSizeName, landscape: boolean): void {
	const base = PAGE_SIZES[name];
	const after = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
	if (after.width === page.width && after.height === page.height) return;
	view.applyCommand(new SetPageSize(page.id, { width: page.width, height: page.height }, after), index);
}

function exportPage(view: NotebookView, page: Page, index: number, kind: "pdf" | "svg"): void {
	const file = view.file;
	if (!file) return;
	if (kind === "pdf") void exportPdf(view.app, file, [page], ` p${index + 1}`, view.mediaCache);
	else void exportSvg(view.app, file, page, ` p${index + 1}`, view.mediaCache);
}

const side = (id: PdfSideAction): Runner => (view) => void runPdfSideAction(view, id);

const RUNNERS: Readonly<Record<string, Runner>> = {
	// tools
	"tool-pen": (v) => v.selectTool("pen"),
	"tool-highlighter": (v) => v.selectTool("highlighter"),
	"tool-eraser": (v) => v.selectTool("eraser"),
	"tool-lasso": (v) => v.selectTool("lasso"),
	"tool-shape": (v) => v.selectTool("shape"),
	"tool-text": (v) => v.selectTool("text"),
	"tool-space": (v) => v.selectTool("space"),
	"shape-line": (v) => v.selectShape("line"),
	"shape-arrow": (v) => v.selectShape("arrow"),
	"shape-rectangle": (v) => v.selectShape("rectangle"),
	"shape-ellipse": (v) => v.selectShape("ellipse"),
	"eraser-stroke": (v) => v.selectEraserMode("stroke"),
	"eraser-segment": (v) => v.selectEraserMode("segment"),
	"eraser-area": (v) => v.selectEraserMode("area"),
	"eraser-larger": (v) => v.stepEraserSize(1),
	"eraser-smaller": (v) => v.stepEraserSize(-1),
	"favourite-1": (v) => v.selectFavourite(0),
	"favourite-2": (v) => v.selectFavourite(1),
	"favourite-3": (v) => v.selectFavourite(2),
	"favourite-4": (v) => v.selectFavourite(3),
	"favourite-5": (v) => v.selectFavourite(4),
	"favourite-6": (v) => v.selectFavourite(5),
	"undo": (v) => v.undo(),
	"redo": (v) => v.redo(),

	// selection
	"selection-copy": (v) => void v.selectionTools?.copy(),
	"selection-cut": (v) => void v.selectionTools?.cut(),
	"selection-duplicate": (v) => v.selectionTools?.duplicate(),
	"selection-paste": (v) => void v.selectionTools?.paste(),
	"selection-white-transparent": (v) => void v.selectionTools?.makeWhiteTransparent(),
	"stamps-save-selection": (v) => v.stampPalette?.saveSelection(),
	"delete-selection": (v) => v.removeSelection(),

	// navigation (wave 0.7)
	"goto-page-number": (v) => new GotoPageModal(v.app, v).open(),
	"toggle-page-mode": (v) => v.togglePageMode(),

	// insert
	"insert-image": (v) => void v.insertImageElement(),
	"stamps": (v) => v.stampPalette?.toggle(),
	"board-shot": (v) => void v.boardShot(),
	"add-page": (v) => v.addPage(),
	"insert-blank-page": onPage((v, _p, i) => v.addPageAfter(i)),
	"exercise-page": onPage((v, _p, i) => v.exercisePageAfter(i)),
	"page-from-template": onPage((v, _p, i) => newPageFromTemplate(v.pageToolsHost(), i)),
	"insert-pdf-pages": onPage((v, _p, i) => void v.insertPdfAfter(i)),
	"insert-image-page": onPage((v, _p, i) => void v.insertImagePageAfter(i)),
	"scan-into": onPage((v, _p, i) => void v.scanPagesAfter(i)),
	"scan-element": onPage((v, _p, i) => void v.insertScanElement(i)),

	// page
	"page-duplicate": onPage((v, p, i) => v.applyCommand(new AddPage(duplicatePage(p), i + 1), i + 1)),
	"page-move-up": onPage((v, p, i) => {
		if (i > 0) v.applyCommand(new MovePage(p.id, i, i - 1), i - 1);
	}),
	"page-move-down": onPage((v, p, i) => {
		if (i < (v.document?.pages.length ?? 0) - 1) v.applyCommand(new MovePage(p.id, i, i + 1), i + 1);
	}),
	"page-bookmark": onPage((v, p) => {
		const doc = v.editableDocument();
		if (!doc) return;
		const before = doc.meta ?? cloneMeta(DEFAULT_META);
		v.applyCommand(new SetMeta(before, toggleBookmark(before, p.id)));
	}),
	"page-edit-bookmark": onPage((v, p) => editBookmark(v.outlineHost(), p.id)),
	"page-tags": onPage((v, p) => editPageTags(v.outlineHost(), p)),
	"page-paper": (v, arg) => onPage((view, p, i) => {
		const kind = arg.value as PaperKind | undefined;
		if (!kind || !(PAPER_KINDS as readonly string[]).includes(kind) || p.paper.kind === kind) return;
		view.applyCommand(new SetPaper(p.id, { ...p.paper }, { kind, spacing: PAPER_SPACING[kind] }), i);
	})(v, arg),
	"page-size": (v, arg) => onPage((view, p, i) => {
		const name = arg.value as PageSizeName | undefined;
		if (!name || !(name in PAGE_SIZES)) return;
		setSize(view, p, i, name, p.width > p.height);
	})(v, arg),
	"page-orientation": onPage((v, p, i) => {
		const name = sizeName(p);
		if (name) setSize(v, p, i, name, !(p.width > p.height));
		else v.applyCommand(new SetPageSize(p.id, { width: p.width, height: p.height }, { width: p.height, height: p.width }), i);
	}),
	"page-infinite": onPage((v, p, i) => v.applyCommand(new SetPageInfinite(p.id, !p.infinite), i)),
	"move-pages": onPage((v, _p, i) => void v.movePagesToNotebook(i)),
	"page-save-template": onPage((v, p) => {
		const doc = v.document;
		if (doc) savePageAsTemplate(v.pageToolsHost(), doc, p, v.file?.basename ?? "");
	}),
	"page-restore-version": onPage((v, _p, i) => openPageRestore(v.reliabilityDeps(), v, i)),
	"page-deleted-pages": (v) => void openDeletedPages(v.pageToolsHost()),
	// practice copies (wave 0.9, view/practice.ts)
	"practice-redo": onPage((v, _p, i) => void v.practiceHooks?.redo(i)),
	"practice-peek": (v) => v.practiceHooks?.togglePeek(),
	"practice-original": (v) => void v.practiceHooks?.goToOriginal(),
	"practice-attempts": (v) => void v.practiceHooks?.attempts(),
	"practice-timer": (v) => v.practiceHooks?.toggleTimer(),
	"page-split": onPage((v, _p, i) => v.splitHeavyPage(i)),
	"page-delete": onPage((v, p, i) => {
		const doc = v.editableDocument();
		if (!doc || doc.pages.length <= 1) return;
		// A copy goes to the page trash first; the page is deleted only once that copy is on disk.
		void deletePageKeepingCopy(v.pageToolsHost(), doc, p, i, (at) => void v.applyCommand(new DeletePage(p, at), Math.max(0, at - 1)));
	}),

	// PDF and reading
	"pdf-search": (v) => v.readingTools?.openSearch(),
	"pdf-search-next": (v) => v.readingTools?.step(1),
	"pdf-search-previous": (v) => v.readingTools?.step(-1),
	"toggle-annotations": (v) => v.readingTools?.toggleAnnotations(),
	"toggle-dim-background": (v) => v.readingTools?.toggleDim(),
	"pdf-margins": onPage((v, p) => {
		const host = v.pdfActionHost();
		if (!host || !p.background || !host.editable()) new Notice(t("pdf.noPdfPage"));
		else openMarginsModal(host, p);
	}),
	"pdf-update": onPage((v, _p, i) => {
		const host = v.pdfActionHost();
		if (host) void updatePdfFromNewVersion(host, i);
	}),
	"pdf-annotations": (v) => {
		const host = v.pdfActionHost();
		if (host) void exportPdfAnnotations(host);
	},

	// side by side
	"pdf-side-open": side("pdf-side-open"),
	"pdf-side-link": side("pdf-side-link"),
	"pdf-side-show-slide": side("pdf-side-show-slide"),
	"pdf-side-add-page": side("pdf-side-add-page"),
	"pdf-side-close": side("pdf-side-close"),

	// lecture
	"new-lecture": (v) => void v.newLecture(),
	"exercise-paper": (v) => v.chooseExercisePaper(),

	// view and input
	"toggle-pages-panel": (v) => v.toggleNavigator(),
	"toggle-ruler": (v) => v.toggleRuler(),
	"pen-only": (v) => v.togglePenOnly(),
	"fit-width": (v) => v.fitToWidth(),
	"next-page": (v) => v.goToRelativePage(1),
	"previous-page": (v) => v.goToRelativePage(-1),

	// export and share
	"share-copy-link": onPage((v, _p, i) => {
		if (v.file) void copyPageLink(v.app, v.file, i + 1);
	}),
	"share-insert-link": onPage((v, _p, i) => {
		if (v.file) insertPageIntoNote(v.app, v.file, i + 1, "link");
	}),
	"share-insert-embed": onPage((v, _p, i) => {
		if (v.file) insertPageIntoNote(v.app, v.file, i + 1, "embed");
	}),
	"export-page-pdf": onPage((v, p, i) => exportPage(v, p, i, "pdf")),
	"export-page-svg": onPage((v, p, i) => exportPage(v, p, i, "svg")),
	"export-pdf": (v) => void v.exportNotebookPdf(),
};

/** Ids of the view actions that have a runner (tests: every view action of the registry must have one). */
export function viewActionIds(): string[] {
	return Object.keys(RUNNERS);
}

/** Runs view action `id`; false when it is unknown or not a view action. */
export function runViewAction(view: NotebookView, id: string, arg: ActionArg = {}): boolean {
	const run = RUNNERS[id];
	if (!run || actionById(id)?.scope !== "view") return false;
	run(view, arg);
	return true;
}
