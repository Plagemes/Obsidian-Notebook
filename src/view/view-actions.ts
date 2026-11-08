// ui redesign: what each view action of the registry (ui/actions.ts) does. One place for the toolbar quick slots, the
// contextual bar, the sheets, the radial menu and the commands. Page actions take the page they act on (`arg.page`,
// default: the page in view); choices take their value (`arg.value`).

import { t } from "../i18n";
import { addPageToObsidianBookmarks } from "../integration/obsidian-bookmarks";
import { PageQrModal, pageQrUri } from "./qr-modal";
import { copyPageLink, insertPageIntoNote } from "../integration/page-share";
import { openCompare, openPageRestore } from "../integration/reliability";
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
import { openSlideStripOf, pdfSideState, runPdfSideAction, type PdfSideAction } from "./pdf-sync";
import { saveNotebookAsTemplate } from "./notebook-templates";
import { ReferencePickerModal } from "./ref-window-picker";
import { deletePageKeepingCopy, newPageFromTemplate, openDeletedPages, savePageAsTemplate } from "./page-tools";
import { insertReference, openPage, removeTextbook, setTextbook } from "./textbook-ref-ui";
import { toggleBookmark } from "./view-helpers";
import { showNotice } from "./notice";
import { canPrint } from "./print";

export interface ActionArg {
	page?: number;
	value?: string;
}

/** The size preset of a page (either orientation), or null for a custom size. */
export function sizeName(page: Page): PageSizeName | null {
	const short = Math.min(page.width, page.height), long = Math.max(page.width, page.height);
	return (Object.keys(PAGE_SIZES) as PageSizeName[]).find((n) => PAGE_SIZES[n].width === short && PAGE_SIZES[n].height === long) ?? null;
}

/** The commands that work on a selection (layer order; wave 0.10: align, distribute, rotate, mirror, size, select similar). */
const SELECTION_ONLY = /^(layer-|comment-selection$|selection-(move-page|copy-page|align|distribute|rotate|mirror|resize|transform|similar|part|group|ungroup|lock)|select-same-)/;

/** Whether a command of the registry applies to this view now (the palette hides it otherwise). */
export function commandApplies(view: NotebookView, id: string): boolean {
	// wave 0.10 (363): there has to be another notebook open to go to
	if (id === "notebook-next" || id === "notebook-previous") return (view.tabTools?.count ?? 0) > 1;
	if (id === "pdf-side-open") return pdfSideState(view).available;
	if (id.startsWith("pdf-side-")) return pdfSideState(view).open;
	// 0.20 (#107): closing needs a reference window to close.
	if (id === "ref-close") return view.referenceOpen;
	// wave 0.9 (357): the layer order needs something selected. Wave 0.10: so do arranging it and selecting similar ink.
	if (SELECTION_ONLY.test(id)) return !!view.uiContext().selection;
	// v10: "Go to source" needs a selected excerpt.
	if (id === "excerpt-open-source") return (view.uiContext().selection?.excerpts ?? 0) > 0;
	// wave 0.10 (362): copying to the other devices needs a selection (pasting does not).
	if (id === "selection-copy-devices") return !!view.uiContext().selection;
	// 0.20 (#39): there has to be a locked element on the page in view.
	if (id === "locked-elements") return (view.uiContext().page?.lockedElements ?? 0) > 0;
	// 0.21 (#225): there has to be a place written during a lecture to go back to.
	if (id === "slide-back") return view.slideBack?.available ?? false;
	// 0.18 (#86): there has to be an open comment to go to.
	if (id === "comment-next") return (view.uiContext().comments?.open ?? 0) > 0;
	// wave 0.10 (81): there is no print dialog on a phone or tablet.
	if (id === "print") return canPrint();
	// wave 0.10 (18): back and forward need a place to go to.
	if (id === "nav-back") return view.navState().back;
	if (id === "nav-forward") return view.navState().forward;
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
	// v8: hidden ink only where the solutions are shown; boxes labelled in the reader's language.
	// 0.15 (241): a page with states is exported in the state it shows.
	const shown = view.stateTools?.viewPages([page])[0] ?? page;
	if (kind === "pdf") void exportPdf(view.app, file, [shown], ` p${index + 1}`, view.mediaCache, view.exportOptions());
	else void exportSvg(view.app, file, shown, ` p${index + 1}`, view.mediaCache, view.exportOptions());
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
	// wave 0.10 (7, 68): colour picker, page eyedropper, style eyedropper
	"colour-picker": (v) => v.colourTools?.togglePicker(),
	"colour-eyedropper": (v) => v.colourTools?.armEyedropper("colour"),
	"style-eyedropper": (v) => v.colourTools?.armEyedropper("style"),
	"undo": (v) => v.undo(),
	"redo": (v) => v.redo(),
	"history-panel": (v) => v.openHistoryPanel(),

	// selection
	"selection-copy": (v) => void v.selectionTools?.copy(),
	"selection-cut": (v) => void v.selectionTools?.cut(),
	"selection-duplicate": (v) => v.selectionTools?.duplicate(),
	"selection-paste": (v) => void v.selectionTools?.paste(),
	"selection-copy-devices": (v) => void v.selectionTools?.copyToDevices(),
	// 0.16 (78): move or copy the selection to another page
	"selection-move-page": (v) => v.selectionTools?.moveToPage("move"),
	"selection-copy-page": (v) => v.selectionTools?.moveToPage("copy"),
	// 0.18 (#86): margin comments
	"comment-selection": (v) => v.commentTools?.commentOnSelection(),
	"comment-region": (v) => v.commentTools?.commentOnRegion(),
	"comments-panel": (v) => v.commentTools?.togglePanel(),
	"comment-next": (v) => void v.commentTools?.step(1),
	// 0.17 (#57): a task from the selection
	"selection-make-task": (v) => v.makeTaskFromSelection(),
	// 0.19 (#213): look up later
	"selection-look-up": (v) => v.lookUpFromSelection(),
	"look-up-list": (v) => v.openLookUpList(),
	"selection-add-to-index": (v) => v.addToIndexFromSelection(),
	"book-index": (v) => v.openBookIndex(),
	"formula-sheet": (v) => v.openFormulaSheet(),
	// 0.18 (#59): the selection as a picture in a note
	"selection-insert-note": (v) => v.insertSelectionIntoNote("png"),
	"selection-insert-note-svg": (v) => v.insertSelectionIntoNote("svg"),
	"selection-paste-device": (v) => void v.selectionTools?.pasteFromDevices(),
	"selection-white-transparent": (v) => void v.selectionTools?.makeWhiteTransparent(),
	"link-selection": (v) => v.linkSelection(),
	"selection-open-link": (v) => v.openSelectionLink(),
	"stamps-save-selection": (v) => v.stampPalette?.saveSelection(),
	"symbols-save-selection": (v) => v.symbolStripView?.saveSelection(),
	// v10: anchored excerpts
	"excerpt-to-page": (v) => v.excerptTools?.excerptToPage(),
	"excerpt-copy": (v) => v.excerptTools?.copyAsExcerpt(),
	"excerpt-open-source": (v) => v.excerptTools?.openSelectedSource(),
	"layer-front": (v) => v.moveSelectionLayer("front"),
	"layer-forward": (v) => v.moveSelectionLayer("forward"),
	"layer-backward": (v) => v.moveSelectionLayer("backward"),
	"layer-back": (v) => v.moveSelectionLayer("back"),
	"delete-selection": (v) => v.removeSelection(),
	// wave 0.10: rectangle selection (63), select by colour or tool (64), align and distribute (38), rotate, mirror, size (65)
	"select-rectangle": (v) => v.toggleSelectRectangle(),
	"snap-toggle": (v) => v.toggleSnap(),
	"select-by-style": (v) => v.arrangeTools?.pickStyle(),
	"selection-similar": (v) => v.arrangeTools?.menu("similar"),
	"selection-cleanup": (v) => v.selectionTools?.cleanUp(),
	"selection-join": (v) => v.selectionTools?.joinBroken(),
	"selection-baseline": (v) => v.selectionTools?.alignBaseline(),
	// 0.15 (241): drawings with states
	"selection-part": (v) => v.stateTools?.makePartFromSelection(),
	"states-toggle": (v) => v.stateTools?.toggle(),
	"select-same-colour": (v) => v.arrangeTools?.similar("colour"),
	"select-same-tool": (v) => v.arrangeTools?.similar("tool"),
	"selection-align-menu": (v) => v.arrangeTools?.menu("align"),
	"selection-align-left": (v) => v.arrangeTools?.align("left"),
	"selection-align-centre": (v) => v.arrangeTools?.align("centre"),
	"selection-align-right": (v) => v.arrangeTools?.align("right"),
	"selection-align-top": (v) => v.arrangeTools?.align("top"),
	"selection-align-middle": (v) => v.arrangeTools?.align("middle"),
	"selection-align-bottom": (v) => v.arrangeTools?.align("bottom"),
	"selection-distribute-h": (v) => v.arrangeTools?.distribute("horizontal"),
	"selection-distribute-v": (v) => v.arrangeTools?.distribute("vertical"),
	"selection-transform-menu": (v) => v.arrangeTools?.menu("transform"),
	"selection-rotate-cw": (v) => v.arrangeTools?.rotate(true),
	"selection-rotate-ccw": (v) => v.arrangeTools?.rotate(false),
	"selection-mirror-h": (v) => v.arrangeTools?.mirror("horizontal"),
	"selection-mirror-v": (v) => v.arrangeTools?.mirror("vertical"),
	"selection-resize": (v) => v.arrangeTools?.resize(),

	// navigation (wave 0.7)
	"goto-page-number": (v) => new GotoPageModal(v.app, v).open(),
	"nav-back": (v) => v.navigate(-1),
	"nav-forward": (v) => v.navigate(1),
	"toggle-page-mode": (v) => v.togglePageMode(),
	"find-replace": (v) => v.openFindReplace(),

	// insert
	"insert-image": (v) => void v.insertImageElement(),
	// wave 0.9: math
	"insert-equation": (v) => v.mathTools?.insertEquation(),
	"insert-graph": (v) => v.mathTools?.insertGraph(),
	"math-edit": (v) => v.mathTools?.editSelected(),
	"math-convert-ink": (v) => void v.mathTools?.convertSelectedToInk(),
	"chem-balance": (v) => v.chemTools?.balanceSelected(),
	// 0.17 (#20): sticky notes
	"insert-sticky": (v) => v.stickyTools?.insert(),
	"sticky-edit": (v) => v.stickyTools?.editSelected(),
	"sticky-collapse": (v) => v.stickyTools?.setCollapsed(true),
	"sticky-expand": (v) => v.stickyTools?.setCollapsed(false),
	// 0.19 (#103): handwritten checklists
	"insert-checkbox": (v) => v.checklistTools?.insert(),
	"insert-axes": (v) => v.axesTools?.insert(),
	"checkbox-toggle": (v) => v.checklistTools?.toggleSelected(),
	"checkbox-select-label": (v) => v.checklistTools?.selectWithLabel(),
	"checkbox-label": (v) => v.checklistTools?.editLabel(),
	"checkbox-task": (v) => v.checklistTools?.sendTask(),
	"checkbox-unlink": (v) => v.checklistTools?.unlinkSelected(),
	// 0.20 (#39): groups and locked elements
	"selection-group": (v) => v.groupTools?.group(),
	"selection-ungroup": (v) => v.groupTools?.ungroup(),
	"selection-lock": (v) => v.groupTools?.lockSelected(),
	"locked-elements": onPage((v, _p, index) => v.groupTools?.openList(index)),
	"insert-date-stamp": (v) => v.insertDateStamp(),
	"sign-and-date": (v) => v.openSignDialog(),
	"stamps": (v) => v.stampPalette?.toggle(),
	"board-shot": (v) => void v.boardShot(),
	"add-page": (v) => v.addPage(),
	"add-page-suggest": (v) => v.openSmartAdd(),
	"insert-blank-page": onPage((v, _p, i) => v.addPageAfter(i)),
	"exercise-page": onPage((v, _p, i) => v.exercisePageAfter(i)),
	"page-from-template": onPage((v, _p, i) => newPageFromTemplate(v.pageToolsHost(), i)),
	"insert-pdf-pages": onPage((v, _p, i) => void v.insertPdfAfter(i)),
	"insert-image-page": onPage((v, _p, i) => void v.insertImagePageAfter(i)),
	"scan-into": onPage((v, _p, i) => void v.scanPagesAfter(i)),
	"scan-element": onPage((v, _p, i) => void v.insertScanElement(i)),

	// page
	"pages-select": (v) => v.selectPages(),
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
	"copy-with-link": onPage((v, p) => void v.copyPageToNotebook(p.id)),
	"notebook-save-template": (v) => {
		const doc = v.document;
		if (doc) saveNotebookAsTemplate(v.app, v.pageToolsHost().settings, doc, v.file?.basename ?? "");
	},
	"page-save-template": onPage((v, p) => {
		const doc = v.document;
		if (doc) savePageAsTemplate(v.pageToolsHost(), doc, p, v.file?.basename ?? "");
	}),
	"page-restore-version": onPage((v, _p, i) => openPageRestore(v.reliabilityDeps(), v, i)),
	"page-compare-version": (v) => openCompare(v.reliabilityDeps(), v, false),
	"page-deleted-pages": (v) => void openDeletedPages(v.pageToolsHost()),
	// practice copies (wave 0.9, view/practice.ts)
	"practice-redo": onPage((v, _p, i) => void v.practiceHooks?.redo(i)),
	"practice-peek": (v) => v.practiceHooks?.togglePeek(),
	"practice-original": (v) => void v.practiceHooks?.goToOriginal(),
	"practice-attempts": (v) => void v.practiceHooks?.attempts(),
	"practice-timer": (v) => v.practiceHooks?.toggleTimer(),
	"page-info": onPage((v, _p, i) => v.openPageInfo(i)),
	"page-split": onPage((v, _p, i) => v.splitHeavyPage(i)),
	// 0.16 (#124): lock a finished page. The history refuses every edit of a locked page; these only flip the flag (one undo step).
	"page-quick-tab": (v) => v.togglePageQuickTab(),
	"page-quick-tab-other": (v) => v.pinQuickTabFromOther(),
	"page-global-bookmark": (v) => v.toggleGlobalBookmark(),
	"page-lock": onPage((v, p) => void v.setPageLocked(p, true)),
	"page-unlock": onPage((v, p) => void v.setPageLocked(p, false)),
	"page-lock-toggle": onPage((v, p) => void v.setPageLocked(p, !p.locked)),
	"page-delete": onPage((v, p, i) => {
		const doc = v.editableDocument();
		if (!doc || doc.pages.length <= 1) return;
		// 0.16 (#124): a locked page is unlocked first (deleting it would be an edit; the copy in the page trash would be left over).
		if (p.locked) {
			showNotice(t("lock.needsUnlock", { n: String(i + 1) }));
			return;
		}
		// A copy goes to the page trash first; the page is deleted only once that copy is on disk.
		void deletePageKeepingCopy(v.pageToolsHost(), doc, p, i, (at) => v.applyCommand(new DeletePage(p, at), Math.max(0, at - 1)));
	}),

	// PDF and reading
	"pdf-search": (v) => v.readingTools?.openSearch(),
	"pdf-search-next": (v) => v.readingTools?.step(1),
	"pdf-search-previous": (v) => v.readingTools?.step(-1),
	"toggle-annotations": (v) => v.readingTools?.toggleAnnotations(),
	"toggle-snap-highlighter": (v) => v.readingTools?.toggleSnap(),
	"highlighter-area": (v) => v.toggleHighlighterArea(),
	"opacity": (v) => v.revealOpacity(),
	"pdf-select-text": (v) => { if (!v.presenting) v.pdfTextTools?.toggle(); },
	"toggle-dim-background": (v) => v.readingTools?.toggleDim(),
	"pdf-margins": onPage((v, p) => {
		const host = v.pdfActionHost();
		if (!host || !p.background || !host.editable()) showNotice(t("pdf.noPdfPage"));
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
	// 0.20 refwindow (#107)
	"ref-open": (v) => new ReferencePickerModal(v.app, (file) => void v.openReference(file)).open(),
	"ref-page": onPage((v, _p, i) => v.openPageAsReference(i)),
	"ref-close": (v) => v.closeReference(),
	"selection-open-reference": (v) => v.openSelectionReference(),
	// 0.14 slides (#417)
	"slide-strip": (v) => void openSlideStripOf(v),

	// lecture
	"new-lecture": (v) => void v.newLecture(),
	"lecture-mode": (v) => v.lectureMode?.toggle(),
	"slide-back": (v) => void v.backToSlide(),
	"lecture-header": (v) => v.lectureHeader?.runCommand(),
	"exercise-paper": (v) => v.chooseExercisePaper(),

	// markers, boxes, invisible ink (wave 0.8)
	"marker-gap": (v) => v.markerTools?.arm("gap"),
	"marker-question": (v) => v.markerTools?.arm("question"),
	"marker-important": (v) => v.markerTools?.arm("important"),
	"marker-critical": (v) => v.markerTools?.arm("critical"),
	"marker-star": (v) => v.markerTools?.arm("star"),
	"marker-homework": (v) => v.markerTools?.arm("homework"),
	"marker-box": (v) => v.markerTools?.arm("box"),
	"end-of-lecture": (v) => v.markerTools?.openPanel(),
	"invisible-ink": (v) => v.markerTools?.toggleInvisibleInk(),
	"show-solutions": (v) => v.markerTools?.toggleSolutions(),
	"show-page-solutions": (v, arg) => v.markerTools?.togglePageSolutions(arg.page),

	// view and input
	"toggle-pages-panel": (v) => v.toggleNavigator(),
	"toggle-ruler": (v) => v.toggleRuler(),
	"pen-only": (v) => v.togglePenOnly(),
	"profile-lecture": (v) => v.applyWritingProfile("lecture"),
	"profile-study": (v) => v.applyWritingProfile("study"),
	"profile-next": (v) => v.applyNextWritingProfile(),
	"pen-gesture-mode": (v) => v.togglePenGestureMode(),
	"pen-gesture-sheet": (v) => v.openGestureCheatSheet(),
	"pen-gesture-custom": (v) => v.openCustomGestures(),
	"fit-width": (v) => v.fitToWidth(),
	"next-page": (v) => v.goToRelativePage(1),
	"previous-page": (v) => v.goToRelativePage(-1),

	// export and share
	"share-copy-link": onPage((v, p, i) => {
		if (v.file) void copyPageLink(v.app, v.file, i + 1, p.id);
	}),
	"share-qr": onPage((v, p, i) => {
		if (v.file) new PageQrModal(v.app, pageQrUri(v.app.vault.getName(), v.file, i + 1, p.id), i + 1).open();
	}),
	"share-insert-link": onPage((v, p, i) => {
		if (v.file) insertPageIntoNote(v.app, v.file, i + 1, "link", p.id);
	}),
	"share-insert-embed": onPage((v, p, i) => {
		if (v.file) insertPageIntoNote(v.app, v.file, i + 1, "embed", p.id);
	}),
	"obsidian-bookmark-page": onPage((v, p, i) => {
		if (v.file) addPageToObsidianBookmarks(v.app, v.file, i + 1, p.id);
	}),
	"export-page-pdf": onPage((v, p, i) => exportPage(v, p, i, "pdf")),
	"export-page-svg": onPage((v, p, i) => exportPage(v, p, i, "svg")),
	// 0.20 (#30): share the page (from a page's sheet it starts on that page) or the selection through the share sheet
	"share-page": (v, arg) => v.openSharePage(arg.page),
	"share-selection": (v) => v.openSharePage(undefined, true),
	"export-pdf": (v) => void v.exportNotebookPdf(),
	// wave 0.9: export dialog (381, from a page's sheet it starts on that page), Markdown export (382), night mode (367), cropped margins (376)
	"export-dialog": (v, arg) => v.openExportDialog(arg.page),
	"export-markdown": (v) => v.openMarkdownExport(),
	// 0.16 (#90): the highlights digest note
	"highlights-digest": (v) => v.openHighlightsDigest(),
	// 0.22 (#101): colours with meaning
	"meaning-filter": (v) => v.openMeaningFilter(),
	"meaning-legend": (v) => v.openMeaningLegend(),
	"meaning-digest": (v) => v.openMeaningDigest(),
	// 0.23 (#264): saved views
	"saved-view-save": (v) => v.openSavedViews(true),
	"saved-view-go": (v) => v.openSavedViews(),
	// 0.18 mentions (O7): the notes that link to this page
	"mentions": (v) => v.openMentions(),
	// 0.19 (#228): the Figures gallery
	"figures": (v) => v.openFigures(),
	// wave 0.10: PNG images (81) and Print (81) are choices of the same dialog; read-only mode (51)
	"export-png": (v) => v.openExportDialog(undefined, "png"),
	// 0.23 (#280): written area and selection as transparent pictures
	"export-area": (v) => v.openAreaExport("page"),
	"hand-in": (v) => v.openHandIn(),
	"selection-export-area": (v) => v.openAreaExport("selection"),
	"selection-copy-image": (v) => v.copyAsImage("selection"),
	"page-copy-image": (v) => v.copyAsImage("page"),
	"print": (v) => {
		if (canPrint()) v.openExportDialog(undefined, "print");
		else showNotice(t("export.print.unavailable"), 8000);
	},
	"toggle-read-only": (v) => v.toggleReadOnlyMode(),
	"night-mode": (v) => v.displayTools?.toggleNight(),
	"present": (v) => v.startPresentation(),
	"crop-margins": (v) => v.displayTools?.toggleCrop(),
	// wave 0.10 (363): next / previous open notebook
	"notebook-next": (v) => void v.tabTools?.step(1),
	"notebook-previous": (v) => void v.tabTools?.step(-1),
	// wave 0.8: quick textbook reference (view/textbook-ref-ui.ts)
	"textbook-set": (v) => setTextbook(v),
	"textbook-open": (v) => openPage(v),
	"textbook-remove": (v) => removeTextbook(v),
	"textbook-insert": (v) => insertReference(v),
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
