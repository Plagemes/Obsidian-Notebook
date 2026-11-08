import { FileView, getLanguage, Scope, setIcon, type Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { pageFromState, pageIdFromState, regionFromState } from "../integration/links";
import { pageTargetFromEphemeralState, pageTargetFromSubpath, resolvePageTarget, type PageTarget } from "../integration/page-links";
import { checkConflicts, openRepair, type ReliabilityDeps } from "../integration/reliability";
import { scanFromCamera } from "../scan/scan-modal";
import { scannedPage } from "../scan/pages";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import { isHeic } from "../scan/image-bytes";
import { t } from "../i18n";
import { renderThumbnail } from "../library/thumbnail";
import { needsNextPage, needsPageOffer } from "../ink/auto-page";
import { deleteInkCommand, deleteSelectionCommands, inkOnRemoved, pinnedInk, withoutPinnedInk, withPinnedInk } from "../ink/attach";
import { hiddenStickyInk } from "../model/sticky";
import { captureClip, type ClipContent } from "../ink/clipboard";
import { cleanStampFormat, formatStamp, stampElement, stampSpot } from "../ink/date-stamp";
import {
	captureCrossPageClip, frameOffset, inkFollowers, pagesTouchedBy, partsBounds, planCrossPageTransform, selectAcrossPages, type PagePart,
} from "../ink/cross-page";
import { elementsInLasso, hitElement, hitLockedElement } from "../ink/elements";
import { eraseAreaCommand } from "../ink/erase-area";
import { filterErasable } from "../ink/erase-filter";
import { findHitStrokes, type BBox } from "../ink/hit-test";
import { growForInfinite } from "../ink/infinite";
import { InputPolicy } from "../ink/input-policy";
import { rectanglePolygon, strokesInLasso } from "../ink/lasso";
import { lineBreakTarget } from "../ink/line-break";
import type { SnapGuide } from "../model/snap";
import { ghostApplies, ghostSegments, ghostSpacingPt, inferGhostLines, MAX_STROKES as GHOST_MAX_STROKES, type GhostBox } from "../model/ghost-lines";
import { dragSnapSession, snapDragged, type SnapSession } from "./snap-glue";
import { SnapHold } from "./snap-hold";
import { applyPlacement, itemsBounds, uniformPlacement } from "../ink/selection-transform";
import { layoutPages, nearestPage, pageAt, toPageLocal, visiblePages, type Layout, type PageBox } from "../ink/layout";
import { HoldTracker } from "../ink/hold";
import { LastTool } from "../ink/last-tool";
import { MultiTap } from "../ink/multitap";
import { scribbleEraseSteps } from "../ink/scribble";
import { lineAt, TextLayoutCache, wordAt } from "../ink/words";
import { InkBuilder } from "../ink/ink-geometry";
import { OneEuroFilter, stabilizationParams } from "../ink/one-euro";
import { PointerController, type InkSample, type SampleBuffer } from "../ink/pointer-controller";
import { PressureModel } from "../ink/pressure";
import { recognizeShape } from "../ink/recognize";
import { drawElement, drawTextElement, measureText, Renderer, selectionCorners, selectionHandles } from "../ink/renderer";
import { projectToRuler, rulerFromTwoTouches, RULER_LENGTH, type Ruler } from "../ink/ruler";
import { eraseSegment } from "../ink/segment-erase";
import { analyseSpace, planSpaceChange, spacePreview } from "../ink/space";
import { heavyReasons, pageLoad, planPageSplit } from "../ink/heavy-page";
import { apply, IDENTITY, invert, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Matrix } from "../ink/transform";
import { clampToPage, fitWidth, pan, PAGE_MARGIN, screenToPage, zoomAt, type Size, type Viewport } from "../ink/viewport";
import { drawHeader, exportHeaderFor, headerLayout, pageTimesText, type HeaderLayout, type HeaderNotebook, type HeaderSettings } from "../ink/page-header";
import { pageTimes } from "../model/page-times";
import { layoutPagesHorizontal, type ScrollMode } from "../ink/page-mode";
import { capturePosition, positionFromState, restoreViewport, type SavedPosition } from "../ink/view-position";
import { PageMode } from "./page-mode";
import { cloneMeta, createId, createPage, createStroke } from "../model/document";
import { buildLecturePackPages, exercisePage } from "../model/lecture-pack";
import { backgroundRect } from "../model/margins";
import {
	AddAsset, AddElement, AddPage, AddStroke, Batch, History, InsertPages, MovePage, RemoveElement, ReplaceElement,
	ReplaceStroke, SetMeta, SetPageSize, type Command,
} from "../model/history";
import { pageContentCommand } from "../model/page-content";
import { checkContent, freezeStroke } from "../model/serialize";
import {
	DEFAULT_META, PAPER_SPACING,
	type Asset, type ImageElement, type NotebookDocument, type NotebookMeta, type Page, type PageElement,
	type PaperKind, type Point, type Stroke, type TextElement, type Tool, RENDER_FREEHAND, RENDER_INK,
} from "../model/types";
import type { JournalStore } from "../storage/journal";
import { DocumentSession, type SaveState, type SessionMode } from "../storage/session";
import { nextTask } from "../storage/idle";
import { isNotebookFile } from "../storage/format";
import { VaultDocumentIO, sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { SharedClipStore } from "../storage/shared-clip-store";
import { backupFolder, readSettings, type NotebookSettings } from "../settings";
import { defaultMarkdownFolder, exportMarkdown, siblingFolder } from "./export-markdown";
import { MakeTaskModal, runMakeTask, type TaskRequest } from "./selection-task";
import { runInsertIntoNote } from "./selection-insert";
import { taskCropRect } from "../model/selection-task";
import { Mentions } from "./mentions";
import { LookUpSheet, LookUpWordModal, runLookUp } from "./look-up";
import { AddToIndexModal, BookIndexModal, currentIndex, termSpellings } from "./book-index";
import { normalizeIndexPrefix } from "../model/book-index";
import { HighlightsDigestModal, digestCounts, runHighlightsDigest } from "./highlight-digest";
import { canPrint } from "./print";
import type { ExportFormat } from "../ink/export-layers";
import { ExportModal, MarkdownExportModal } from "./export-dialog";
import { SharePageModal, type ShareHost } from "./share-page"; // 0.20 (#30)
import { exportPdf, runExport, type ExportOptions } from "./export";
import { ViewDisplay, type DisplayHost } from "./display";
import { policySettings } from "./input-settings";
import { NotebookMedia, resolveAssetFile, storeAsset } from "./media";
import { FiguresModal } from "./figures";
import { HeavyPageBanner } from "./heavy-page-banner";
import { ViewSyncSafety, type SyncSafetyService } from "./sync-safety";
import { QuickTabsStrip } from "./quick-tabs";
import type { QuickTabsService, QuickTabsViewApi } from "./quick-tabs-service";
import { PageNavigator } from "./navigator";
import { NotebookMapCache } from "../model/notebook-map";
import { NotebookMapModal } from "./notebook-map-modal";
import type { NavController } from "./nav-controller";
import { FastScrollbar, type ScrollbarHost } from "./scrollbar";
import { Minimap, type MinimapHost } from "./minimap";
import type { StatusBarInfo } from "./status-bar-logic";
import type { NavPlace } from "../model/nav-history";
import { openPageOpsMenu, type PageOpsHost } from "./page-ops-menu";
import type { OutlineHost } from "./outline";
import { PAGE_AT_KEY, PageClock, pageAtFromState, pageState, startPosition } from "./position-sync";
import { positionAt, updatePosition } from "../model/position";
import { LocationKeeper } from "./last-location";
import { extractBookmarks } from "../library/scan";
import { GestureInput } from "./gesture-input";
import { PenRadial } from "./radial-menu";
// wave 0.8: pen gestures
import { DwellTracker, DWELL_MS, dwellMayStart, gestureStarts } from "../ink/gestures/trigger";
import { PenGestureLayer } from "./pen-gestures";
import { gestureWorld, runGesture, type PenGestureView } from "./pen-gesture-actions";
import { CustomGesturesModal, GestureCheatSheet, type PenGestureUiHost } from "./pen-gesture-ui";
import { editPageTags } from "./outline";
import { OutlineBuilder, type OutlineSources } from "../model/outline-builder";
import type { HeadingIndex } from "../model/heading-index";
import { HeadingThumbs } from "./outline-thumbs";
import { HeadingWarmer } from "./heading-warm";
import { askPdfRange } from "./pdf-range-modal";
import { attachDropFiles } from "./drop-files";
import { runBoardShot } from "./board-shot";
import { executeThenSettle, type EditContext } from "./edit-context";
import { runNewLecture } from "./lecture";
import { pickSlideRef } from "./lecture-logic";
import { LectureModeController, routeLectureEnd, type LectureEnd } from "./lecture-mode";
import { lectureSnapshot, type LectureSnapshot } from "../library/lecture-log-logic";
import { LECTURE_MEMORY_KEY } from "../timetable/lecture-memory";
import { findLecturePage } from "../timetable/lecture-open";
import type { LectureClass } from "../timetable/lecture-mode";
import { askExercisePaper, askLayoutOptions, loadExercisePaper } from "./lecture-pack-modal";
import { runMovePages } from "../library/move-pages";
import { runCopyWithLink } from "../library/copy-with-link";
import { TransferFlows } from "../library/transfer-flows";
import type { StorageEnv } from "../library/storage-actions";
import type { PdfActionHost } from "./pdf-actions";
import { pickFile } from "./pick";
import { pdfSideState, referencePane, referenceSlideOf, runPdfSideAction, type PageSyncHooks } from "./pdf-sync";
import { attachSlideBadges, linkToSlide, refreshSlideBadges } from "./slide-ink";
import { MarkerTools, translatedBoxLabel } from "./markers";
import { ExcerptTools } from "./excerpts";
import { PdfTextTools } from "./pdf-text";
import { PdfLinks } from "./pdf-links";
import { PdfOutlineSource } from "../pdf/outline-source";
import { pageLinkText } from "../integration/page-share";
import { layerCommand, type LayerMove } from "../model/layers";
import { SetPageLocked } from "../model/page-lock";
import { FindReplaceModal } from "./find-replace";
import { PageInfoModal } from "./page-info";
import { PageOffer } from "./page-offer";
import { SlideBack } from "./slide-back";
import { PageRefs } from "./page-refs";
import { SmartAddStrip } from "./smart-add";
import { nearbyPapers, type SmartAddChoice, type SmartAddInput } from "../model/smart-add";
import { createMarker, isRegion, visibleStrokes } from "../model/markers";
import type { PageToolsHost } from "./page-tools";
import { RulerGesture } from "./ruler-gesture";
import { BLANK_THUMBNAIL, ViewResilience, type ResilienceServices, type ResilienceViewHost } from "./resilience";
import { ObjectInk } from "./object-ink";
import { PenLinks } from "./pen-links";
import { RefWindow } from "./ref-window";
import type { ReferenceRequest } from "./ref-window-logic";
import { SelectionActions } from "./selection-actions";
import { statesAfterCuts } from "../model/states-erase";
import { StatesTools } from "./states-tools";
import { PresentationMode } from "./present-mode";
import { SelectionArrange } from "./selection-arrange";
import { StampPalette, type StampTarget } from "./stamp-palette";
import { SignDialog } from "./sign-dialog";
import { planSignature, signDateText } from "../ink/signature";
import { SymbolStrip } from "./symbol-strip";
import { TextEditor, type TextEditSession } from "./text-editor";
import { MathTools, type MathHost } from "./math-tools";
import { StickyTools, type StickyHost } from "./sticky-tools";
import { ChecklistTools, type ChecklistHost } from "./checklist-tools";
import { GroupTools, type GroupHost } from "./group-tools";
import { canGroup, expandToGroups, lockedElementsOf, selectableItems, strokePieces, unlockedElements } from "../model/groups";
import { CommentTools, pdfCommentLabels, type CommentsHost } from "./comments-tools";
import { equationNumbers } from "../model/math-elements";
import { eraserRadiusPt, stepEraserSize, type FavouritePen } from "./favourites";
import { PenControls, type PenStore } from "./pen-controls";
import { PenSetControls, setForOpen, type PenSetHost } from "./pen-set-controls";
import { favouritePatch } from "./favourites";
import { MAX_FOLDER_ASSIGNMENTS, MAX_NOTEBOOK_ASSIGNMENTS, normaliseAssignments, normalisePenSets, slotsOf, withSetPens, type PenSet } from "./pen-sets";
import { PdfReading, type ReadingHost } from "./pdf-reading";
import type { PracticeHooks, PracticeProvider, PracticeViewHost } from "./practice-types";
import { NotebookTabs } from "./notebook-tabs";
import { DEFAULT_TOOLS, Toolbar, type ToolName, type ToolbarState } from "./toolbar";
import { hasBackgrounds, hasPdfPages } from "./reading-logic";
import { ColourTools, type PageInk } from "./colour-tools";
import { commandApplies, runViewAction, sizeName, type ActionArg } from "./view-actions";
import { ViewUi } from "./view-ui";
import { pageKindOf } from "../ui/page-kind";
import { pageKeyAction, shouldTurnPage, takesKey, type KeyScene } from "./page-keys";
import { isTextField, penKeyMatches, penKeyMayAct } from "../ink/pen-hover";
import { hint } from "../ui/hints";
import { actionById, isEnabled, type UiContext } from "../ui/actions";
import { actionLabel } from "../ui/action-sheet";
import {
	centredPosition, imageElementSize, imagePageSize, mergeMeta, metaEquals, newTextBox, shapePoints, shouldGrabRuler, toggleBookmark,
	unionBounds,
} from "./view-helpers";
import { showErrorNotice, showNotice, type NoticeHandle } from "./notice";
import type { PdfCopyPort, PdfCopySource } from "../storage/pdf-copy-service";
import { isInTrash } from "../storage/trash-paths";
import { applyViewportClass, ViewportTracker } from "../ui/viewport-class";

export const VIEW_TYPE = "notebook-view";

/** Selection handle diameter in CSS px. */
/** The outline sources of a build that lists only the headings found in the handwriting (the notebook map). */
const HEADINGS_ONLY: OutlineSources = { bookmarks: false, slides: false, headings: true, markers: false, pdf: false };
const HANDLE_PX = 22;
/** A stroke may start this far outside the page (pt). */
const PAGE_TOLERANCE = 8;
/** Keeping the pen still this long (ms) at the end of a stroke turns it into a clean shape. */
const HOLD_MS = 600;
/** ...within this radius (CSS px). */
const HOLD_RADIUS_PX = 4;
/** A pen stroke that starts this close to the ruler edge (CSS px) is projected onto it. */
const RULER_SNAP_PX = 14;
/** Pen samples closer than this (CSS px) to the last stored point are not stored. */
const MIN_STEP_PX = 0.5;
/** A touch that moves less than this (CSS px) is a tap. */
const TAP_SLOP_PX = 8;
/** Double/triple tap with the lasso: how far from the ink (CSS px) a tap still picks a word or line. */
const WORD_TAP_PX = 12;
/** Below this width (CSS px) the page panel is a drawer over the page instead of a side panel. */
const NARROW_PX = 720;
/** PDF pages are rendered at this scale (device px per pt) for thumbnails of pages not in view. */
const THUMB_PDF_SCALE = 0.75;
/** Page thumbnails are this many CSS px wide. */
const THUMB_CSS_WIDTH = 120;

export interface NotebookHost {
	settings: NotebookSettings;
	/** Instant start: the reader is on this page (1-based) of this notebook. Called a moment after it changes. */
	remember?(path: string, page: number, pos?: SavedPosition | null): void;
	/** wave 0.7: a real edit on page `pageId` (`num`, 1-based) of notebook `nb`; feeds the per-device recent pages log. */
	edited?(nb: string, path: string, pageId: string, num: number): void;
	/** wave 0.9 (379): when this device last edited the page (ms since epoch), if it has a record. */
	pageEditedAt?(nb: string, pageId: string): number | null;
	/** Roadmap 18: the session's back/forward history of visited pages, across notebooks (view/nav-controller.ts). Optional: absent in tests. */
	nav?: NavController;
	/** 0.18 (#227): quick tabs, pages pinned in a notebook (view/quick-tabs-service.ts). Optional: absent in tests. */
	quickTabs?: QuickTabsService;
	/** Roadmap O15: the page in view or the save state of `view` changed (the status bar item follows the active view). Optional. */
	statusChanged?(view: NotebookView): void;
	/** Instant save journal shared by all views. */
	journal?: JournalStore;
	/** 0.17: where the instant-save journal is, so merge / split / extract in a view refuse to rewrite or trash a closed notebook with journal-only ink. Optional: absent in tests. */
	transferJournal?(): StorageEnv["journal"];
	/** Persists the plugin settings (favourite pens, eraser size, pen-only). Optional: absent in tests. */
	saveSettings?(): Promise<void>;
	/** Wave 0.9: practice copies of exercises (view/practice.ts). Optional: absent in tests and the harness. */
	practice?: PracticeProvider;
	/** ui redesign: the course of the class on now (timetable), for the lecture contextual bar. Optional. */
	classNow?(): string | null;
	/** 0.14 (401): the class in progress that belongs to this notebook (automatic lecture mode). Optional: absent in tests and the harness. */
	lectureClassFor?(path: string): LectureClass | null;
	/** 0.19 (222): a lecture ended in that notebook; the plugin takes the lecture snapshot from the saved file. Optional: absent in tests and the harness. */
	lectureEnded?(path: string, course: string, saved: boolean): void;
	/** 0.19 (#221): a lecture the user wrote in ended: its line goes into the daily note (library/lecture-log.ts). Optional: absent in tests and the harness. */
	logLecture?(file: TFile, cls: LectureClass, snap: LectureSnapshot, docId?: string): void;
	/** ui redesign: runs a plugin-level action of the registry (notebook menu). Optional. */
	runGlobal?(id: string): void;
	/** wave 0.7: sync safety (presence files, sync check). Optional: absent in tests and the harness. */
	syncSafety?: SyncSafetyService;
	/** wave 0.7: resilience: safe mode, storage-full warning, integrity ledger. Optional: absent in tests. */
	resilience?: ResilienceServices;
	/** wave 0.10 (362): the plugin's one store of the shared clipboard file (views must not each write it). Optional: absent in tests. */
	sharedClips?(): SharedClipStore;
	/** 0.17 (#23): the optional PDF copy next to each notebook. Optional: absent in tests and the harness. */
	pdfCopy?: PdfCopyPort;
	/** 0.20 (#79): a PDF dropped on a page was chosen to be annotated in a notebook of its own (a dropped file or a vault file). Optional: absent in tests and the harness. */
	annotateDropped?(source: File | TFile): void;
}

interface ActiveStroke {
	pageIndex: number;
	/** Style (and, once recognised as a shape, the points); while `wet`, the points are in the view's InkBuilder. */
	stroke: Stroke;
	/** Written as wet ink: points and geometry live in the InkBuilder until the pen lifts. */
	wet: boolean;
	/** The wet-ink layer was not available: the stroke in progress is shown on the live layer. */
	liveFallback: boolean;
	/** Last raw (unfiltered) pen position on the page and its pressure: the tip of the line, and its last point. */
	rawX: number;
	rawY: number;
	rawP: number;
	/** Samples closer than this (pt) to the last stored point are not stored (the tip still follows the pen). */
	minStep: number;
	/** Points are projected onto the ruler edge. */
	snap: boolean;
	/** The pen was held still and the stroke was replaced with a clean shape: further movement is ignored. */
	recognized: boolean;
	/** Further strokes of a recognised shape (none for the shapes that exist today). */
	extra: Point[][];
	/** Where the pen was when recognition last failed (do not retry until it moves). */
	tried: { x: number; y: number } | null;
}

interface ActiveErase {
	commands: Command[];
	/** Last eraser position in document coordinates. */
	last: [number, number];
	/** Ids of strokes this eraser never touches: the ink its own contact committed just before it (side button mid-stroke). */
	spare?: ReadonlySet<string>;
}

interface Lasso {
	pageIndex: number;
	points: Array<[number, number]>;
	/** The eraser's Area mode: the outline erases what is inside instead of selecting it. */
	erase?: boolean;
	/** wave 0.10 (63): rectangle selection: the outline is the box from `anchor` to the pen, not a freehand path. */
	anchor?: [number, number];
	/** Area erase: ids of strokes it never touches (the ink its own contact committed just before it). */
	spare?: ReadonlySet<string>;
}

/** Insert/remove space: the line touched (page coordinates) and how far it was dragged (pt; down > 0). */
interface SpaceDrag {
	pageIndex: number;
	y: number;
	delta: number;
}

/** A lasso-tool contact that may turn out to be a tap of a double/triple tap. */
interface LassoTap {
	pageIndex: number;
	local: [number, number];
	/** Stage px and time where it started. */
	x: number;
	y: number;
	t: number;
	moved: boolean;
}

interface ShapeDrag {
	pageIndex: number;
	a: [number, number];
	b: [number, number];
}

interface TextTap {
	pageIndex: number;
	local: [number, number];
	/** Stage px where the tap started. */
	x: number;
	y: number;
	moved: boolean;
}

interface Selection {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
	/** Bounds of `strokes` and `elements` before `matrix`, page coordinates. */
	bounds: BBox;
	/** Transform being dragged, not applied to the document yet. */
	matrix: Matrix;
	/**
	 * wave 0.10 (359): the selected items of other pages when the lasso crossed a page boundary (absent for the usual
	 * single-page selection). `pageIndex` is then the primary page: `bounds` and `matrix` are in its frame.
	 */
	others?: PagePart[];
	/** 0.17 (#71): the snap guides shown while the selection is dragged (passed on to the renderer). */
	guides?: SnapGuide[];
}

interface SelectionDrag {
	kind: "move" | "scale" | "rotate";
	start: [number, number];
	startMatrix: Matrix;
	/** 0.17 (#71): the lines this drag snaps to (absent: snap is off, the page has none, or the drag is a rotation) and the pointer that drags. */
	snap?: { session: SnapSession; pointerType: string };
}

export class NotebookView extends FileView {
	navigation = true;

	private session: DocumentSession | null = null;
	/**
	 * Every edit is checked strictly before it is kept (`checkContent`): an edit that the writer would refuse is undone
	 * with a notice, so a bad element can never stop every later save.
	 */
	private readonly history = new History(() => this.requireDoc(), 500, checkContent, (message, step) => {
		console.error(`[notebook] ${step ?? "edit"} refused, the notebook could not be saved with it:`, message);
		// 0.19: an undo or a redo that would leave a notebook the writer refuses is not done and leaves the history (the document is as before).
		showNotice(step ? t("history.stepRefused", { message }) : t("history.refused", { message }), 10000);
		if (step) this.updateHistoryButtons();
	},() => this.userReadOnly, (ids) => this.pagesLocked(ids), () => Date.now());
	/**
	 * wave 0.10 (51): the user switched this view to read-only mode. Nothing changes the document while it is on: `editable()`
	 * is false (tools, selection, insert, page operations and every registry action that needs editing), a finger only pans
	 * and zooms, and the history refuses to run, undo or redo anything. It is a view state only: no flag in the file, no
	 * backup, no write; it is not kept when the notebook is closed. Independent of the sync-safety "Open read-only" flag.
	 */
	private userReadOnly = false;
	private readonly policy: InputPolicy;
	private readonly pressure: PressureModel;
	/** Position filter (stabilization setting) and the geometry of the stroke being written. */
	private readonly filter = new OneEuroFilter();
	private readonly ink = new InkBuilder();

	private toolbar!: Toolbar;
	/** wave 0.10 (363): the strip of open notebooks and the swipe between them. */
	private tabs: NotebookTabs | null = null;
	private body!: HTMLElement;
	private stage!: HTMLElement;
	private messageEl!: HTMLElement;
	private perfEl!: HTMLElement;
	/** wave 0.7: resilience: banners (safe mode, not saved, unexpected change on disk) and the per-file opening marker. */
	private bannerHost!: HTMLElement;
	private resilience: ViewResilience | null = null;
	private renderer: Renderer | null = null;
	private headerRenderer: Renderer | null = null;
	private headerKey = "";
	private controller: PointerController | null = null;
	private resizeObserver: ResizeObserver | null = null;
	/** 0.14 layout: phone / tablet / desktop, portrait / landscape and short height of this view (classes nb-vp-* on contentEl). */
	private readonly vpClass = new ViewportTracker(() => ({ coarse: activeWindow.matchMedia("(pointer: coarse)").matches }));
	private media: NotebookMedia | null = null;
	/** 0.20 (#107): the floating reference window over the page (null until the view is open). */
	private refWindow: RefWindow | null = null;
	/** wave 0.7: sync safety (#342–#344). */
	private syncSafety: ViewSyncSafety | null = null;
	private pageNav: PageNavigator | null = null;
	/** 0.13: the generated outline and the pictures of its headings (cached per page). */
	private readonly outlineBuilder = new OutlineBuilder();
	private readonly headingThumbs = new HeadingThumbs();
	/** 0.20 (#102): headings are looked for in the background (idle), not when the outline or the map opens. */
	private readonly headingWarm = new HeadingWarmer(this.outlineBuilder, () => this.session?.doc?.pages ?? [], () => this.host.settings.outlineHeadings);
	/** Roadmap 50: the fast scrollbar with a page preview (view/scrollbar.ts). */
	private scrollbar: FastScrollbar | null = null;
	/** 0.17 (#173): the floating overview of the page in view (view/minimap.ts). */
	private minimap: Minimap | null = null;
	/** Roadmap 18: stops following the history's changes (the quick slots and the page sheet enable or disable Back and Forward). */
	private stopNav: (() => void) | null = null;
	/** 0.18 (#227): the strip of quick tabs and the subscription that keeps it current. */
	private quickStrip: QuickTabsStrip | null = null;
	private stopQuick: (() => void) | null = null;
	/** Roadmap 18: the next explicit arrival is the first load of this file, so the place left is the last one seen anywhere. */
	private navFresh = true;
	private arrivalFresh = false;
	/** Roadmap O15: what the status bar item shows. */
	private saveText = "";
	private saveKind: StatusBarInfo["kind"] = "pending";
	private statusKey = "";
	/** 0.17 (#23): counts the moments the notebook stopped being saved (an edit): a PDF copy built across one is thrown away. */
	private editTick = 0;
	private textEditor: TextEditor | null = null;
	/** v9: equations and graphs (editor, panel, typesetting, convert to ink). */
	private math: MathTools | null = null;
	/** 0.17 (#20): sticky notes (insert, edit, collapse). */
	private sticky: StickyTools | null = null;
	/** 0.19 (#103): handwritten checklists (taps, the square drawn by hand, send to tasks, the task lines). */
	private checklist: ChecklistTools | null = null;
	/** 0.20 (#39): groups and locked elements (Group, Ungroup, Lock, the Unlock chip, the list of locked elements). */
	private groups: GroupTools | null = null;
	/** 0.18 (#86): margin comments (markers, card, side panel). */
	private comments: CommentTools | null = null;
	private rulerGesture: RulerGesture | null = null;
	private radial: PenRadial | null = null;
	private colour: ColourTools | null = null;
	/** Pen gestures (roadmap 139, view/pen-gestures.ts): gesture mode and the gesture in progress. */
	private penGestures: PenGestureLayer | null = null;
	/** Long-press trigger: the ink stroke that may turn into a gesture if the pen rests, and its timer. */
	private dwell: { tracker: DwellTracker; timer: number } | null = null;
	/** Multi-finger taps and auto-scroll (wave 0.6: gestures), the previous tool, and when the stroke in progress began. */
	private gestures: GestureInput | null = null;
	private readonly lastTool = new LastTool<ToolName>();
	private strokeStart = 0;
	private readonly location = new LocationKeeper(
		{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
		(path, page, pos) => {
			this.host.remember?.(path, page, pos);
			this.app.workspace.requestSaveLayout();
		},
	);
	private selectionActions: SelectionActions | null = null;
	/** 0.15 (241): drawings with states: the state strip and the part editor (view/states-tools.ts). */
	private statesTools: StatesTools | null = null;
	/** 0.16 (#87): the presentation in progress, if any (view/present-mode.ts). */
	private presentation: PresentationMode | null = null;
	/** 0.16 (#87): whether the view was page-by-page before "write while presenting" put it there. */
	private presentWasPaged = false;
	private arrange: SelectionArrange | null = null;
	/** Links written with the pen (O8): note links in text boxes, on ink, and the `[[` suggester. */
	private penLinks: PenLinks | null = null;
	/** One page at a time (#14); its gestures and animation live in page-mode.ts. */
	private pageMode: PageMode | null = null;
	private stamps: StampPalette | null = null;
	private symbols: SymbolStrip | null = null;
	/** ui redesign: quick slots, contextual bar and sheets built from the action registry (view-ui.ts). */
	private ui: ViewUi | null = null;
	private readonly objectInk = new ObjectInk();
	/** v8 markers, boxes, invisible ink and the end-of-lecture panel (view/markers.ts). */
	private markers: MarkerTools | null = null;
	/** v10 anchored excerpts: making them, their badge taps and the jump back to the source (view/excerpts.ts). */
	private excerpts: ExcerptTools | null = null;
	/** wave 0.9 (389): the chip that offers a page after a page in the middle of the notebook (view/page-offer.ts). */
	private pageOffer: PageOffer | null = null;
	/** 0.21 (#225): the pill back to the place last written during a lecture (view/slide-back.ts). */
	slideBack: SlideBack | null = null;
	pageRefs: PageRefs | null = null;
	/** 0.14 (401): automatic lecture mode of this view (view/lecture-mode.ts). */
	lectureMode: LectureModeController | null = null;
	/** wave 0.14 (410): the Smart "+" strip (view/smart-add.ts). */
	private smartAdd: SmartAddStrip | null = null;

	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	private viewSize: Size = { width: 0, height: 0 };
	private layout: Layout | null = null;
	private fitMode = true;
	private tools: ToolbarState = { ...DEFAULT_TOOLS };
	private pens: PenControls | null = null;
	/** 0.15 pen sets: the switcher in the pen options and the set the strip shows now (null: the favourite pens); not saved. */
	private penSetUi: PenSetControls | null = null;
	private activePenSetId: string | null = null;
	/** Wave 0.6: PDF search, snapping highlighter, hide annotations, dimmed backgrounds (pdf-reading.ts). */
	private reading: PdfReading | null = null;
	/** 0.16: select and copy the text of a PDF page (#45), follow the links of PDF pages and list the PDF outline (#46). */
	private pdfText: PdfTextTools | null = null;
	private pdfLinks: PdfLinks | null = null;
	private pdfOutline: PdfOutlineSource | null = null;
	/** wave 0.9: night mode (367) and the cropped view of PDF pages (376). */
	private display: ViewDisplay | null = null;

	private active: ActiveStroke | null = null;
	private erasing: ActiveErase | null = null;
	/**
	 * The strokes the last pen gesture committed and the undo step that holds them, until the next gesture: the eraser
	 * that continues the same contact (side button pressed while writing) spares them, and a late button signal can
	 * retract them (`retractStroke`).
	 */
	private justCommitted: { ids: ReadonlySet<string>; cmd: Command } | null = null;
	private lasso: Lasso | null = null;
	/** wave 0.10 (362): the clipboard files shared between devices (made when first used). */
	private sharedClipStore: SharedClipStore | null = null;
	/** wave 0.10 (356): where the pen last touched a page (page coordinates), for the date and time stamp. */
	private lastPen: { pageId: string; x: number; y: number; at: number } | null = null;
	private spaceDrag: SpaceDrag | null = null;
	private selection: Selection | null = null;
	private drag: SelectionDrag | null = null;
	/** 0.17 (#71): a finger held on the screen, or Alt, lets a drag move freely. */
	private readonly snapHold = new SnapHold();
	/** 0.17 (#71): the Snap button of the selection bar paused the snap in this view. */
	private snapPaused = false;
	private shapeDrag: ShapeDrag | null = null;
	private textTap: TextTap | null = null;
	private lassoTap: LassoTap | null = null;
	private readonly multiTap = new MultiTap();
	private readonly textLayouts = new WeakMap<Page, TextLayoutCache>();
	private ruler: { pageId: string; ruler: Ruler } | null = null;
	private shiftDown = false;
	private readonly hold = new HoldTracker();
	private holdTimer: number | null = null;
	private snapFlashTimer: number | null = null;

	private navTimer: number | null = null;
	// wave 0.7: lod — heavy page warning
	private heavy: HeavyPageBanner | null = null;
	private heavyTimer: number | null = null;
	/** Pages the reader dismissed the warning for, until this view closes. */
	private readonly heavyDismissed = new Set<string>();
	/** ui redesign: id of the page in view when it is heavy and can be split (page sheet), else null. */
	private heavyPageId: string | null = null;
	private navCurrent = -1;
	/** Pages whose thumbnail was drawn without all its media; redrawn when media arrives. */
	private readonly thumbPending = new Set<string>();
	private readonly thumbRendering = new Set<string>();
	private thumbTimer: number | null = null;

	/** Wave 0.6 (#106): the synchronised PDF pane, when one is open (view/pdf-sync.ts). */
	syncHooks: PageSyncHooks | null = null;
	/** Wave 0.9 (#303): the practice banner and commands of this view (view/practice.ts). */
	practiceHooks: PracticeHooks | null = null;

	private lastBackupPath: string | null = null;
	private lastErrorAt = 0;

	private perfInput: number | null = null;
	private perfLastFrame = 0;
	private readonly perfFrames: number[] = [];
	private readonly perfLatency: number[] = [];
	private perfShownAt = 0;
	/** Per input event while writing: processing time and event timestamp → painted (ms). */
	private readonly perfProcess: number[] = [];
	private readonly perfPaint: number[] = [];
	private resolveClosed: (() => void) | null = null;
	/** Resolves once onClose has written (or backed up) everything; the library waits for it before moving the file. */
	readonly closed = new Promise<void>((resolve) => (this.resolveClosed = resolve));

	constructor(leaf: WorkspaceLeaf, private readonly host: NotebookHost) {
		super(leaf);
		const s = host.settings;
		this.policy = new InputPolicy(policySettings(s));
		this.tools = { ...this.tools, eraserSize: s.eraserSize };
		this.pressure = new PressureModel(s.pressureMode);
		this.filter.params = stabilizationParams(s.stabilization);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? t("plugin.name");
	}

	getIcon(): string {
		return "pencil";
	}

	canAcceptExtension(extension: string): boolean {
		return isNotebookFile({ extension });
	}

	/** Size of the drawing area, for the benchmark. */
	get stageSize(): Size {
		return this.viewSize;
	}

	/** The open document (null while loading or when the file could not be read). Do not mutate it: use commands. */
	get document(): NotebookDocument | null {
		return this.session?.doc ?? null;
	}

	/** Whether `content` (document text now in the file) was written by this view's own save, not by sync or another app. */
	isOwnWrite(content: string): boolean {
		return this.session?.isOwnWrite(content) ?? false;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("notebook-view");
		this.toolbar = new Toolbar(this.contentEl, this.tools, {
			change: (state) => this.onToolsChanged(state),
			undo: () => this.runAction("undo"),
			redo: () => this.runAction("redo"),
			toggleNavigator: () => this.runAction("toggle-pages-panel"),
			runAction: (id) => this.runAction(id),
			togglePin: (id) => this.ui?.togglePin(id),
			openSheet: (anchor) => this.ui?.openSheet("all", anchor),
			openPageSheet: (anchor) => this.ui?.openSheet("page", anchor, this.currentPageIndex()),
			...(this.host.quickTabs ? { quickTab: { pinned: () => this.host.quickTabs?.isPinned(this.quickApi()) ?? false, toggle: () => this.togglePageQuickTab() } } : {}),
		});
		this.tabs = new NotebookTabs(this.contentEl, this.toolbar.el, {
			app: this.app,
			viewType: VIEW_TYPE,
			leaf: () => this.leaf,
			enabled: () => this.host.settings.notebookTabs,
			register: (ref) => this.registerEvent(ref),
		}, [this.toolbar.el]);
		this.bannerHost = this.contentEl.createDiv({ cls: "notebook-resilience" });
		if (this.host.resilience) this.resilience = new ViewResilience(this.resilienceHost(), this.host.resilience);
		this.body = this.contentEl.createDiv({ cls: "notebook-body" });
		this.stage = this.body.createDiv({ cls: "notebook-stage" });
		this.perfEl = this.stage.createDiv({ cls: "notebook-perf" });
		this.pageNav = new PageNavigator(this.body, {
			pages: () => this.shownDoc()?.pages ?? [],
			current: () => this.currentPageIndex(),
			bookmarks: () => new Set(this.shownDoc()?.meta?.bookmarks ?? []),
			thumbnail: (page, width) => this.thumbnail(page, width),
			goTo: (index) => this.goToPage(index),
			move: (from, to) => this.movePage(from, to),
			toggleBookmark: (pageId) => this.toggleBookmarkOf(pageId),
			pageMenu: (index) => this.openPageMenu(index),
			outline: this.outlineHost(),
			selectionMenu: (ids, evt) => openPageOpsMenu(this.pageOpsHost(), ids, evt),
			openMap: () => this.openNotebookMap(),
			setLocked: (pageId, value) => this.setLockedById(pageId, value),
		});
		// The panel sits to the left of the page (a drawer over it on narrow views).
		this.body.insertBefore(this.pageNav.el, this.stage);
		this.scrollbar = new FastScrollbar(this.body, this.scrollbarHost());
		this.minimap = new Minimap(this.body, this.minimapHost());
		this.stopNav = this.host.nav?.onChange(() => this.refreshUi()) ?? null;
		this.mountQuickTabs();
		this.heavy = new HeavyPageBanner(this.body, {
			split: (index) => this.splitHeavyPage(index),
			dismiss: (index) => {
				const id = this.pageAtIndex(index)?.id;
				if (id) this.heavyDismissed.add(id);
			},
		});
		// 0.16 (#124): a locked page shows a small badge over the page area; a tap on it unlocks the page.
		const badge = this.body.createEl("button", { cls: "nb-ui nb-lock-badge", attr: { type: "button", "aria-label": t("lock.badge.aria") } });
		setIcon(badge.createSpan({ cls: "nb-lock-badge-icon", attr: { "aria-hidden": "true" } }), "lock");
		badge.createSpan({ cls: "nb-lock-badge-text", text: t("lock.badge") });
		for (const type of ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown"] as const) badge.addEventListener(type, (e) => e.stopPropagation());
		badge.addEventListener("click", (e) => {
			e.preventDefault();
			const page = this.session?.doc?.pages[this.currentPageIndex()];
			if (page) this.setPageLocked(page, false);
		});
		this.lockBadge = badge;
		// 0.20 (#79): pictures, PDFs and notes dragged onto a page (view/drop-files.ts; the pen and pointer input are not involved).
		this.dropFilesOff = attachDropFiles({
			app: this.app,
			stage: this.stage,
			overlayParent: this.body,
			listen: (el, type, handler) => this.registerDomEvent(el, type, handler),
			editable: () => this.editable(),
			context: () => this.editContext(),
			layout: () => this.layout,
			viewport: () => this.viewport,
			media: () => this.media,
			textStyle: () => ({ fontSize: this.tools.textSize, color: this.tools.penColor }),
			select: (pageIndex, elements) => this.selectItems(pageIndex, [], elements),
			insertPdfPages: (source, afterIndex) => this.insertPdfAfter(afterIndex, source),
			...(this.host.annotateDropped ? { annotate: (source: File | TFile) => this.host.annotateDropped?.(source) } : {}),
		});
		// 0.18 mentions (O7): a count of the notes that link to the page in view; a tap lists them.
		this.mentions = new Mentions({
			app: this.app, body: this.body, file: () => this.file, pages: () => this.shownDoc()?.pages ?? [],
			currentPageId: () => this.shownDoc()?.pages[this.currentPageIndex()]?.id ?? null,
			currentPageNumber: () => (this.shownDoc() ? this.currentPageIndex() + 1 : 0),
			register: (ref) => this.registerEvent(ref),
		});
		this.textEditor = new TextEditor(this.stage);
		this.math = new MathTools(this.mathHost());
		this.sticky = new StickyTools(this.stickyHost());
		this.checklist = new ChecklistTools(this.checklistHost());
		this.groups = new GroupTools(this.groupHost());
		this.comments = new CommentTools(this.commentsHost());
		this.penGestures = new PenGestureLayer({
			stage: this.stage,
			body: this.body,
			settings: () => this.host.settings,
			world: () => gestureWorld(this.gestureView()),
			run: (r, trail) => runGesture(this.gestureView(), r, trail),
			openCheatSheet: () => this.openGestureCheatSheet(),
			modeChanged: () => this.refreshUi(),
		});
		this.mountPenLinks(this.textEditor);
		this.pens = new PenControls(this.toolbar, this.stage, this.penStore());
		this.penSetUi = new PenSetControls(this.toolbar.penSetsEl, this.penSetHost());
		this.pens.onRefresh = () => this.penSetUi?.refresh();
		this.ui = new ViewUi({
			app: this.app, root: this.contentEl, body: this.body, toolbar: this.toolbar,
			context: (pageIndex) => this.uiContext(pageIndex),
			run: (id, arg) => this.runAction(id, arg),
			pageValues: (i) => {
				const page = this.session?.doc?.pages[i];
				return page ? { paper: page.paper.kind, size: sizeName(page) } : null;
			},
			dimControl: () => (this.reading?.dimmed ? this.reading.dimControl : null),
			toolbarSize: () => this.host.settings.toolbarSize,
			adapt: () => ({ pageType: this.host.settings.adaptPageType, learn: this.host.settings.adaptLearn, selection: this.host.settings.adaptSelection }),
			pinned: () => this.host.settings.pinnedQuick,
			setPinned: (ids) => {
				this.host.settings.pinnedQuick = ids;
				void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
			},
			notebookId: () => this.session?.doc?.id ?? null,
		});
		this.mountSelectionActions();
		this.mountStamps();
		this.mountSymbols();
		this.messageEl = this.contentEl.createDiv({ cls: "notebook-message" });
		this.syncSafety = new ViewSyncSafety({
			app: this.app, component: this, container: this.contentEl, before: this.body, service: this.host.syncSafety ?? null,
			file: () => this.file, session: () => this.session, assetFileChanged: (f) => this.media?.assetFileChanged(f),
			editingChanged: () => {
				this.applyInput();
				this.toolbar.setEditable(this.editable());
				this.symbols?.sync();
				this.updateHistoryButtons();
				this.refreshUi();
			},
			repair: () => {
				const file = this.file;
				if (file) void openRepair(this.reliabilityDeps(), file, { docId: this.session?.doc?.id ?? this.host.resilience?.ledger.records(file.path)[0]?.id ?? null });
			},
		});
		this.messageEl.hide();
		this.toolbar.setEditable(false);
		this.symbols?.sync();

		this.renderer = new Renderer(this.stage, { lowLatency: this.host.settings.lowLatencyInk });
		this.mountMarkers();
		this.mountStates();
		this.lectureMode = new LectureModeController({
			parent: () => this.body,
			path: () => this.file?.path ?? null,
			setting: () => this.host.settings.lectureMode,
			classFor: (path) => this.host.lectureClassFor?.(path) ?? null,
			busy: () => this.inContact(),
			editContext: () => this.editContext(),
			editable: () => this.editable(),
			goToLecturePage: (course, date) => {
				const i = findLecturePage(this.session?.doc?.pages ?? [], course, date);
				if (i >= 0) this.scrollToPage(i);
			},
			changed: () => this.refreshUi(),
			ended: (end) => this.onLectureEnd(end),
			memory: { load: (): unknown => this.app.loadLocalStorage(LECTURE_MEMORY_KEY), save: (v) => this.app.saveLocalStorage(LECTURE_MEMORY_KEY, v) },
		});
		this.mountExcerpts();
		this.pageOffer = new PageOffer({
			parent: () => this.body,
			insertAfter: (pageId) => this.insertPageAfterId(pageId),
		});
		this.slideBack = new SlideBack({
			parent: () => this.body,
			enabled: () => this.host.settings.slideBack && this.layout !== null,
			lectureOn: () => this.lectureMode?.on ?? false,
			doc: () => this.session?.doc ?? null,
			indexOf: (pageId) => this.session?.doc?.pages.findIndex((p) => p.id === pageId) ?? -1,
			box: (index) => this.layout?.boxes[index] ?? null,
			view: () => {
				const r = this.visibleRect();
				return this.viewSize.height > 0 ? { top: r.minY, bottom: r.maxY } : null;
			},
			goTo: (index, y) => {
				this.recordJump(index);
				this.scrollToPage(index, y);
			},
		});
		this.pageRefs = new PageRefs({
			parent: () => this.body,
			enabled: () => this.host.settings.pageRefs && this.layout !== null,
			pages: () => this.shownDoc()?.pages ?? [],
			path: () => this.file?.path ?? null,
			current: () => this.currentPageIndex(),
			goTo: (index) => this.goToPage(index),
		});
		this.smartAdd = new SmartAddStrip({
			app: this.app,
			parent: () => this.body,
			notebookId: () => (this.editable() ? (this.session?.doc?.id ?? null) : null),
			context: () => this.smartAddContext(),
			add: (choice) => this.addSmartChoice(choice),
			more: () => this.openPageMenu(this.currentPageIndex()),
		});
		// Registered before the pointer controller: the ruler gesture swallows the touches that move the ruler.
		this.rulerGesture = new RulerGesture(this.stage, {
			enabled: () => this.tools.ruler && !!this.ruler && this.editable(),
			grabs: (mid) => this.rulerGrabs(mid),
			update: (a, b) => this.moveRuler(a, b),
		});
		this.controller = new PointerController(this.stage, this.policy, {
			drawStart: (s, eraser, held, continued) => this.drawStart(s, eraser, held, continued),
			drawMove: (samples, predicted) => this.drawMove(samples, predicted),
			drawEnd: (cancelled) => this.drawEnd(cancelled),
			pan: (dx, dy) => (this.pageMode?.enabled ? this.pageMode.pan(dx, dy) : this.setViewport(pan(this.viewport, dx, dy), true)),
			zoom: (factor, fx, fy) => {
				this.fitMode = false;
				this.pageMode?.zoomed(factor);
				this.setViewport(zoomAt(this.viewport, factor, fx, fy), true);
			},
			penMenu: (x, y, source) => {
				this.radial?.open(x, y, source);
				// The menu swallows the lift of the contact that opened it: the gesture layer must not wait for it.
				window.setTimeout(() => this.gestures?.releaseContacts(), 0);
			},
			sideButtonSeen: () => this.noteSideButtonSeen(),
			restGestureArmed: () => this.host.settings.penGestureLongPress && !!this.penGestures && !this.penGestures.mode && (this.tools.tool === "pen" || this.tools.tool === "highlighter"),
			// 0.11.2: "next stroke erases" (pen button click while hovering, or the pen key) shows on the current-pen indicator.
			eraserNextChanged: (armed) => this.toolbar.setEraserNext(armed),
			retractStroke: () => this.retractStroke(),
		}, {
			rawUpdates: this.host.settings.lowLatencyInk,
			// 0.11.1: the side button is also watched at window level over the whole view (toolbar, bars, overlays).
			scope: this.contentEl,
		});
		this.pageMode = new PageMode(this.stage, {
			viewport: () => this.viewport,
			viewSize: () => this.viewSize,
			layout: () => this.layout,
			setViewport: (v, interactive) => this.setViewport(v, interactive),
			fitMode: () => this.fitMode,
		});
		this.radial = new PenRadial(this.stage, {
			toolbarSize: () => this.host.settings.toolbarSize,
			editable: () => this.editable() && !this.controller?.drawing,
			tools: () => this.tools,
			apply: (patch) => this.toolbar.apply(patch),
			canUndo: () => this.history.canUndo(),
			undo: () => this.runAction("undo"),
			// ui redesign: the dial's redo, favourites, save-as-favourite, ruler and eyedropper hint.
			canRedo: () => this.history.canRedo(),
			redo: () => this.runAction("redo"),
			favourites: () => this.penStore().favourites(),
			applyFavourite: (i) => this.runAction(`favourite-${i + 1}`),
			saveFavourite: (i) => this.pens?.saveCurrentTo(i),
			toggleRuler: () => this.runAction("toggle-ruler"),
			// wave 0.8: the shapes ring's Markers entry places a marker or box with the next contact.
			placeMarker: (kind) => this.runAction(kind === "box" ? "marker-box" : `marker-${kind}`),
			notify: (text) => showNotice(text, 2500),
			// wave 0.10 (7): the colour ring's custom colour and eyedropper use the free picker and the page eyedropper.
			openColourPicker: () => this.colour?.openPicker(),
			pickColour: () => this.colour?.armEyedropper("colour"),
		});
		this.colour = new ColourTools({
			stage: this.stage,
			editable: () => this.editable() && !this.controller?.drawing,
			tools: () => this.tools,
			apply: (patch) => this.toolbar.apply(patch),
			recent: () => this.host.settings.recentColours,
			setRecent: (list) => {
				this.host.settings.recentColours = list;
				void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
			},
			notify: (text) => showNotice(text, 2500),
			inkAt: (x, y) => this.inkAtPoint(x, y),
		});
		this.lastTool.note(this.tools.tool);
		this.gestures = new GestureInput(this.stage, {
			policy: this.policy,
			tapMode: () => this.host.settings.tapGestures,
			act: (action) => (action === "undo" ? this.undo() : this.redo()),
			snapshotView: () => {
				const { viewport, fitMode } = this;
				return () => {
					this.fitMode = fitMode;
					this.setViewport(viewport, true);
				};
			},
			drawing: () => !!this.controller?.drawing,
			autoScroll: {
				enabled: () => this.host.settings.autoScrollWriting && this.editable(),
				viewHeight: () => this.viewSize.height,
				offsetY: () => this.viewport.offsetY,
				panBy: (dy) => this.setViewport(pan(this.viewport, 0, dy), true),
			},
			lineBreak: {
				enabled: () => this.host.settings.autoLineBreak && this.editable(),
				viewport: () => this.viewport,
				setViewport: (v) => this.setViewport(v, true),
			},
		});
		this.reading = new PdfReading(this.readingHost());
		this.mountPdfText();
		this.display = new ViewDisplay(this.displayHost());
		this.display.applyNight();
		this.practiceHooks = this.host.practice?.attach(this.practiceHost()) ?? null;
		// 0.14 slides (#226): badges next to ink written beside a slide; a tap shows the slide again.
		attachSlideBadges(this, () => this.host.settings);
		this.applySettings(this.host.settings);

		this.resizeObserver = new ResizeObserver(() => this.measure());
		this.resizeObserver.observe(this.stage);
		this.registerDomEvent(window, "resize", () => this.measure());

		// Tapping anywhere else ends text editing. Pointer events on the canvas are cancelled, so the textarea would not blur.
		this.registerDomEvent(this.stage, "pointerdown", (e) => {
			// v9: the equation editor and the graph panel, and pan/zoom inside the graph being edited, keep them open.
			if ((e.target as HTMLElement | null)?.closest?.(".notebook-text-editor, .notebook-math-panel") || this.math?.ownsPointer(e)) return;
			this.commitText();
		}, true);

		// 0.17 (#71): a finger held on the screen (or Alt) is the temporary way out of the snap. Capture phase: nothing hides it.
		for (const type of ["pointerdown", "pointerup", "pointercancel"] as const) this.registerDomEvent(this.stage, type, (e) => this.snapHold.pointer(e), true);
		this.registerDomEvent(document, "keydown", (e) => this.snapHold.key(e));
		this.registerDomEvent(document, "keyup", (e) => this.snapHold.key(e));
		this.registerDomEvent(window, "blur", () => this.snapHold.reset());

		// Android may kill a backgrounded app without notice: save as soon as we are hidden.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState !== "hidden") return;
			this.resilience?.hidden();
			void this.flushNow().then((saved) => {
				if (saved && this.file) this.host.pdfCopy?.hidden(this.file.path, () => this.pdfCopySource());
			});
		});
		this.registerDomEvent(window, "pagehide", () => void this.flushNow());
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Shift") this.shiftDown = true;
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Shift") this.shiftDown = false;
		});
		this.registerDomEvent(window, "blur", () => (this.shiftDown = false));
		// wave 0.9 (372): the page turner (arrows, PageUp / PageDown, space, Bluetooth clickers).
		this.registerDomEvent(document, "keydown", (e) => this.onPageTurnKey(e));
		// 0.11.2: a key standing in for the S Pen button (mapped with Key Mapper + Shizuku). Capture phase: before Obsidian's hotkeys.
		this.registerDomEvent(window, "keydown", (e) => this.onPenKey(e), { capture: true });
		this.registerClipboardEvents();

		// 0.20 (#107): the floating reference window. Created with the view; its DOM exists only while a reference is shown.
		this.refWindow = new RefWindow({
			app: this.app,
			container: () => this.body,
			snap: () => this.host.settings.refWindowSnap,
			deps: {
				app: this.app,
				folder: () => this.host.settings.folder,
				live: (file) => {
					if (file === this.file && this.session) return { doc: () => this.shownDoc(), media: () => this.media };
					// 0.20 review (D9): a notebook shown as a reference that another pane has open is read from that pane's
					// document, so every save there does not make this pane read and parse the file again.
					for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
						const other = leaf.view;
						if (other instanceof NotebookView && other !== this && other.file?.path === file.path && other.session?.doc) {
							// Obsidian reuses a view when its pane opens another notebook: serve this document only while that pane still shows it.
							// Otherwise the window falls back to reading the file from disk instead of drawing a different notebook.
							return { doc: () => (other.file?.path === file.path ? other.session?.doc ?? null : null), media: () => null, redrawOnSave: true };
						}
					}
					return null;
				},
			},
		});
		this.registerEvent(this.app.vault.on("modify", (f) => this.refWindow?.fileChanged(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.refWindow?.fileGone(f.path)));

		this.registerEvent(this.app.vault.on("modify", (f) => {
			if (f === this.file && this.session) void this.session.handleExternalChange();
		}));
		this.registerEvent(this.app.vault.on("delete", (f) => {
			// Never write a deleted notebook back; unsaved changes go to a backup.
			if (f === this.file) void this.session?.markDeleted();
		}));

		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "z", () => (this.undo(), false));
		this.scope.register(["Mod", "Shift"], "z", () => (this.redo(), false));
		this.scope.register(["Mod"], "y", () => (this.redo(), false));
		this.scope.register([], "Delete", () => (this.deleteSelection(), false));
		this.scope.register([], "Backspace", () => (this.deleteSelection(), false));
		this.scope.register([], "Escape", () => (this.pdfText?.exit(), this.excerpts?.disarm(), this.controller?.disarmEraserNext(), this.clearSelection(), false));
	}

	async onClose(): Promise<void> {
		this.location.flush();
		try {
			await this.closeSession();
		} finally {
			this.resolveClosed?.();
		}
		this.resilience?.end();
		this.stopHold();
		this.clearDwell();
		this.penGestures?.destroy();
		this.dropFilesOff?.();
		this.dropFilesOff = null;
		this.penGestures = null;
		this.mentions?.destroy();
		this.mentions = null;
		this.headingWarm.dispose();
		for (const timer of [this.navTimer, this.thumbTimer, this.snapFlashTimer, this.heavyTimer]) if (timer !== null) window.clearTimeout(timer);
		this.navTimer = this.thumbTimer = this.snapFlashTimer = this.heavyTimer = null;
		this.pens?.destroy();
		this.pens = null;
		this.penSetUi = null;
		this.refWindow?.destroy();
		this.refWindow = null;
		this.pdfText?.destroy();
		this.pdfText = null;
		this.pdfLinks?.destroy();
		this.pdfLinks = null;
		this.pdfOutline = null;
		this.reading?.destroy();
		this.reading = null;
		this.display?.destroy();
		this.display = null;
		this.practiceHooks?.destroy();
		this.practiceHooks = null;
		this.presentation?.destroy();
		this.presentation = null;
		this.lectureMode?.destroy();
		this.lectureMode = null;
		this.statesTools?.destroy();
		this.statesTools = null;
		this.tabs?.destroy();
		this.tabs = null;
		this.toolbar?.destroy();
		this.controller?.destroy();
		this.controller = null;
		this.radial?.destroy();
		this.radial = null;
		this.colour?.destroy();
		this.colour = null;
		this.gestures?.destroy();
		this.gestures = null;
		this.rulerGesture?.destroy();
		this.rulerGesture = null;
		this.pageMode?.destroy();
		this.pageMode = null;
		this.scrollbar?.destroy();
		this.scrollbar = null;
		this.minimap?.destroy();
		this.minimap = null;
		this.comments?.destroy();
		this.comments = null;
		this.stopNav?.();
		this.stopNav = null;
		this.stopQuick?.();
		this.stopQuick = null;
		this.quickStrip?.el.remove();
		this.quickStrip = null;
		this.selectionActions?.destroy();
		this.selectionActions = null;
		this.arrange = null;
		this.checklist?.destroy();
		this.checklist = null;
		this.groups?.destroy();
		this.groups = null;
		this.penLinks?.destroy();
		this.penLinks = null;
		this.pageOffer?.destroy();
		this.pageOffer = null;
		this.slideBack?.destroy();
		this.slideBack = null;
		this.pageRefs?.destroy();
		this.pageRefs = null;
		this.smartAdd?.destroy();
		this.smartAdd = null;
		this.ui?.destroy();
		this.ui = null;
		this.stamps?.destroy();
		this.stamps = null;
		this.symbols?.destroy();
		this.symbols = null;
		this.objectInk.destroy();
		this.math?.destroy();
		this.excerpts?.destroy();
		this.math = null;
		this.textEditor?.destroy();
		this.textEditor = null;
		this.pageNav?.destroy();
		this.pageNav = null;
		this.renderer?.setMedia(null);
		this.media?.destroy();
		this.media = null;
		this.renderer?.destroy();
		this.renderer = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/** Page (1-based) requested by the view state, applied once the document is loaded. */
	private pendingPage: number | null = null;
	/** Zoom and scroll position to restore on `pendingPage` (O16). */
	private pendingPos: SavedPosition | null = null;
	/** Link target (`#p3`, `#p3&id=...`) requested through the ephemeral state: always wins over any restored position. */
	private pendingTarget: PageTarget | null = null;
	/** wave 0.6 (v7): when the reader was on `pendingPage` (workspace layout), null for an explicit request. */
	private pendingAt: string | null = null;
	/** wave 0.6 (v7): the next load is the first one of this file, so it may start at the stored reading position. */
	private startPending = false;
	/** wave 0.6 (v7): when the page in view last changed, for the `pageAt` of the layout. */
	private readonly pageClock = new PageClock();

	/** The page being read (and, v7, when) goes into the workspace layout, so reopening Obsidian shows the same page. */
	getState(): Record<string, unknown> {
		const state = super.getState();
		if (this.pendingPage !== null) {
			return {
				...state, page: this.pendingPage,
				...(this.pendingAt ? { [PAGE_AT_KEY]: this.pendingAt } : {}),
				...(this.pendingPos ? { view: this.pendingPos } : {}),
			};
		}
		const total = this.shownDoc()?.pages.length ?? 0;
		const index = this.currentPageIndex();
		// Where exactly (zoom and scroll) goes with the page; `pageAt` is when the reader arrived on it.
		const pos = this.currentPosition();
		return total > 0
			? { ...state, ...pageState(index + 1, this.pageClock.since(this.file?.path, index, new Date())), ...(pos ? { view: pos } : {}) }
			: state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		// wave 0.8 (388): a page id in the state (links the plugin made) wins over the number and over any stored position.
		const pageId = pageIdFromState(state);
		this.pendingPage = pageFromState(state) ?? (pageId ? 1 : null);
		this.pendingPos = pageId ? null : positionFromState(state);
		this.pendingAt = this.pendingPage !== null && !pageId ? pageAtFromState(state) : null;
		// v10: the jump back from an anchored excerpt also names the region to outline.
		this.pendingTarget = pageId ? { page: pageFromState(state), pageId, region: regionFromState(state) } : null;
		await super.setState(state, result);
		// Already loaded (the same file was shown): jump now; otherwise onDocumentLoaded applies it.
		if (this.pendingPage !== null && this.layout) this.applyPendingPage();
	}

	/** Following `[[Notebook.notebook#p3]]` passes the subpath here (after `setState` when the file was not open yet). */
	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const target = pageTargetFromEphemeralState(state);
		if (target === null) return;
		// A link to a page by id only has no number: any page keeps the request pending until it is resolved.
		this.pendingPage = target.page ?? 1;
		this.pendingTarget = target;
		this.pendingPos = null;
		this.pendingAt = null;
		if (this.layout) this.applyPendingPage();
	}

	/** wave 0.9 (372): keys that turn pages, only while this view is the active one and nothing else wants the key. */
	private onPageTurnKey(e: KeyboardEvent): void {
		const action = pageKeyAction(e);
		if (action === null) return;
		const scene: KeyScene = {
			enabled: this.host.settings.pageTurnerKeys,
			viewActive: this.app.workspace.getActiveViewOfType(NotebookView) === this,
			targetEditable: takesKey(e.target as HTMLElement | null, e.key),
			busy: this.active !== null || this.erasing !== null || this.drag !== null || this.shapeDrag !== null
				|| this.textEditor?.isOpen === true || this.radial?.isOpen === true,
			overlayOpen: !!activeDocument.querySelector(".modal-container, .menu, .suggestion-container"),
		};
		if (!shouldTurnPage(scene)) return;
		e.preventDefault();
		this.goToRelativePage(action === "next" ? 1 : -1);
	}

	/**
	 * 0.11.2: the pen key (setting `penButtonKey`): opens the radial menu or toggles "next stroke erases", only while this
	 * view is the active one, no text field has the focus and no modal is open. Only that key is cancelled; repeats are ignored.
	 */
	private onPenKey(e: KeyboardEvent): void {
		const s = this.host.settings;
		if (!penKeyMatches(e, s.penButtonKey)) return;
		const may = penKeyMayAct({
			viewActive: this.app.workspace.getActiveViewOfType(NotebookView) === this,
			textFocused: isTextField(activeDocument.activeElement) || isTextField(e.target as HTMLElement | null),
			modalOpen: !!activeDocument.querySelector(".modal-container"),
		});
		if (!may) return;
		e.preventDefault();
		if (!this.editable()) return;
		this.controller?.penKey(s.penButtonKeyAction);
	}

	private applyPendingPage(): void {
		const doc = this.shownDoc();
		const page = this.pendingPage;
		if (page === null || !doc || !this.layout) return;
		// A saved zoom needs the size of the view: wait for the first measurement.
		if (this.pendingPos && this.viewSize.width === 0) return;
		this.pendingPage = null;
		// Roadmap 18: a request from outside (a link, the switcher, Back/Forward) is a jump; restoring the workspace is not.
		const explicit = this.pendingAt === null;
		const pos = this.pendingPos;
		const target = this.pendingTarget;
		this.pendingPos = null;
		this.pendingTarget = null;
		this.pendingAt = null;
		if (target) {
			// A link to a page that was deleted says so and stays where it is.
			const found = resolvePageTarget(doc.pages, target);
			if ("missing" in found) {
				showNotice(t("links.pageDeleted", { name: this.file?.basename ?? "" }));
				return;
			}
			this.recordArrival(found.index);
			// v10: the jump back from an excerpt outlines the region (also while a large file is still loading).
			if (!target.region || !this.excerpts?.reveal(found.index, target.region)) this.scrollToPage(found.index);
			return;
		}
		const index = Math.min(doc.pages.length, Math.max(1, page)) - 1;
		if (explicit) this.recordArrival(index);
		if (pos && pos.page === index + 1 && this.restorePosition(pos)) return;
		this.scrollToPage(index);
	}

	/** Shows the page, zoom and scroll position of a saved place (O16). False if the view cannot show it yet. */
	private restorePosition(pos: SavedPosition): boolean {
		const layout = this.layout;
		const restored = layout ? restoreViewport(pos, this.pageMode?.enabled ? "pages" : "continuous", this.viewSize, layout) : null;
		if (!restored) return false;
		this.pageMode?.goTo(restored.pageIndex);
		this.fitMode = restored.fit;
		this.setViewport(restored.viewport);
		return true;
	}

	/** Page, zoom and scroll position in view now, or null while the view has no size or no document. */
	private currentPosition(): SavedPosition | null {
		const layout = this.layout;
		if (!layout) return null;
		return capturePosition(this.pageMode?.enabled ? "pages" : "continuous", this.viewport, this.viewSize, layout, this.currentPageIndex());
	}

	/** wave 0.6 (v7): the first load of a file starts at the requested page or at the stored reading position. */
	private applyStartPosition(): void {
		const doc = this.shownDoc();
		if (!doc || !this.layout) return;
		// Roadmap 18: the first request on a file that has just opened comes from wherever the reader was before.
		this.arrivalFresh = this.navFresh;
		this.navFresh = false;
		if (!this.startPending) return this.applyPendingPage();
		// A link (or search hit) always wins; it also needs no stored position.
		if (this.pendingTarget) {
			this.startPending = false;
			return this.applyPendingPage();
		}
		// A saved zoom needs the size of the view: wait for the first measurement.
		if (this.pendingPos && this.viewSize.width === 0) return;
		this.startPending = false;
		// An explicit page (Continue last notebook, search) wins; a restored layout page yields to a newer stored position.
		const start = startPosition(doc, this.pendingPage, this.pendingAt);
		const explicit = this.pendingPage !== null && this.pendingAt === null;
		const pos = this.pendingPos;
		this.pendingPage = null;
		this.pendingAt = null;
		this.pendingPos = null;
		if (!start) return;
		if (explicit) this.recordArrival(start.index);
		// The workspace position (zoom and scroll) applies when its page is the one chosen, at the page top.
		if (pos && pos.page === start.index + 1 && start.y === 0 && this.restorePosition(pos)) return;
		this.scrollToPage(start.index, start.y);
	}

	/** wave 0.6 (v7): stores where the reader is, just before a content save serializes (DocumentSession.beforeSerialize). */
	private storePosition(doc: NotebookDocument): void {
		if (!this.layout || doc !== this.session?.doc || this.pendingPage !== null) return;
		const index = this.currentPageIndex();
		const box = this.layout.boxes[index];
		if (!box) return;
		const top = screenToPage(this.viewport, 0, 0)[1];
		updatePosition(doc, positionAt(doc, index, top - box.y, new Date()));
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.startPending = true;
		this.navFresh = true;
		this.lastBackupPath = null;
		this.fitMode = true;
		this.viewport = { scale: 1, offsetX: 0, offsetY: 0 };
		this.pageMode?.reset();
		// Callbacks of a session that is no longer the current one (file switched while loading) are ignored.
		const current = () => this.session === session;
		// wave 0.7: resilience (#346): the opening marker is set before the file is read.
		this.resilience?.begin(file);
		const session: DocumentSession = new DocumentSession(
			new VaultDocumentIO(this.app, file, () => backupFolder(this.host.settings)),
			{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
			{
				onLoaded: (doc, mode, problem) => {
					if (current()) this.onDocumentLoaded(doc, mode, problem);
				},
				onPartial: () => {
					if (current()) this.showPartial();
				},
				onPartialProgress: (pages) => {
					if (current()) this.onPagesRead(pages);
				},
				onSaveState: (state) => {
					if (!current()) return;
					this.showSaveState(state);
					this.notePdfCopy(state);
				},
				onRecovered: ({ savedAt }) => {
					const when = new Date(savedAt);
					showNotice(t("notice.recovered", { time: Number.isNaN(when.getTime()) ? savedAt : when.toLocaleString() }), 8000);
				},
				onBackup: (path, reason) => {
					const key = reason === "conflict" ? "notice.conflict" : reason === "journal" ? "notice.journalBackup" : "notice.backup";
					showErrorNotice(t(key, { path }), 8000);
					if (!current()) return;
					this.lastBackupPath = path;
					if (session.mode === "broken" || session.mode === "readonly") this.showProblem();
				},
				onError: (message) => {
					if (current()) this.showError(message);
				},
				// wave 0.7: resilience (#347, #390)
				onWriteHealth: (state) => {
					if (current()) this.resilience?.writeHealth(state);
				},
				onWritten: (text) => {
					if (current()) this.resilience?.written(text);
				},
				onDiskContent: (info) => {
					if (current()) this.resilience?.diskContent(info);
				},
				// wave 0.7: sync safety (review)
				onAwaiting: (state) => {
					if (current()) this.syncSafety?.awaitingChanged(state);
				},
				onExternalNewer: (info) => {
					if (current()) this.resilience?.externalNewer(info);
				},
			},
			{
				busy: () => this.active !== null || this.erasing !== null || this.drag !== null || this.shapeDrag !== null
					|| this.textEditor?.isOpen === true,
				journal: this.host.journal,
				// The first slice waits for the frame that paints the page just shown (but not for long: no frames come while hidden).
				yieldTask: (fn, first) => {
					if (!first) return nextTask(fn);
					let ran = false;
					const go = (): void => {
						if (ran) return;
						ran = true;
						nextTask(fn);
					};
					window.requestAnimationFrame(go);
					window.setTimeout(go, 100);
				},
				beforeSerialize: (doc) => this.storePosition(doc),
				spaceProbe: this.host.resilience?.spaceProbe,
				ownWrite: () => this.host.resilience?.ledger.records(file.path)[0] ?? null,
			},
		);
		this.session = session;
		try {
			// A large notebook is shown as soon as the page asked for is read; the rest follows (see StagedParse).
			await session.load({ staged: true, page: this.pendingPage });
			this.loadPenSetForNotebook(file);
			hint("notebook-opened");
		} catch (e) {
			this.showError((e as Error).message);
		}
	}

	/** The snapshot a closing notebook asked for: made once closeSession has written the file (see onLectureEnd). */
	private snapshotAfterClose: { path: string; course: string } | null = null;

	/**
	 * 0.19 (#221, 222): the one lecture end. The log line comes first, from the open document in memory. The snapshot reads the
	 * saved file, so it waits for the flush: for a lecture left or over the view flushes here; for a closing notebook closeSession
	 * is the flush and onUnloadFile asks for the snapshot once it resolved.
	 */
	private onLectureEnd(end: LectureEnd): void {
		routeLectureEnd(end, {
			log: (cls) => this.logLecture(cls),
			snapshotAfterFlush: (path, course) => void this.snapshotAfterFlush(path, course),
			snapshotAfterClose: (path, course) => {
				this.snapshotAfterClose = { path, course };
			},
		});
	}

	/** The facts of the lecture in the open document, handed to the lecture log (a no-op without the lecture page or the log). */
	private logLecture(cls: LectureClass): void {
		const file = this.file;
		const doc = this.session?.doc;
		if (!file || !doc || !this.host.logLecture) return;
		const snap = lectureSnapshot(doc.pages, cls.course, new Date(cls.startsAt));
		if (snap) this.host.logLecture(file, cls, snap, doc.id);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		// 0.20 (#107): a reference that shows this very notebook reads its open document: it goes with it.
		if (this.refWindow?.file === file) this.refWindow.close();
		this.lectureMode?.closing();
		await this.closeSession();
		const pending = this.snapshotAfterClose;
		this.snapshotAfterClose = null;
		if (pending) this.host.lectureEnded?.(pending.path, pending.course, this.closedSaved);
		this.activePenSetId = null;
		// wave 0.10 (51): read-only mode belongs to the notebook being read; the next one opens editable.
		if (this.userReadOnly) this.setReadOnlyMode(false, false);
		this.syncSafety?.closed();
		this.resilience?.end();
		this.history.clear();
		this.clearSelection();
		this.layout = null;
		this.ruler = null;
		this.renderer?.setRuler(null);
		this.renderer?.setDocument(null, null);
		this.renderer?.setMedia(null);
		this.media?.destroy();
		this.media = null;
		this.reading?.reset();
		this.pdfText?.reset();
		this.pageNav?.invalidate();
		this.presentation?.destroy();
		this.lectureMode?.closed();
		await super.onUnloadFile(file);
	}

	/**
	 * Closes the stroke in progress and the text box being edited, and writes everything to disk.
	 * Resolves to true only if nothing is left unsaved in memory (callers such as the history restore
	 * must not go on when it is false).
	 */
	async flushNow(): Promise<boolean> {
		this.controller?.finishActiveStroke();
		this.commitText();
		// 0.19 (#103): the ticks of linked checkboxes that still wait for their task line are written now (the app may be killed).
		this.checklist?.flush();
		const session = this.session;
		if (!session) return true;
		const written = await session.flush();
		return written && (session.mode !== "ok" || !session.dirty);
	}

	/** Saved state of the session closeSession last detached (what a lecture snapshot at close may rely on). */
	private closedSaved = false;

	/**
	 * 0.19 (222): writes everything first and tells the plugin whether it all reached the file; the snapshot itself is made
	 * from the file on disk, never from this view's memory.
	 */
	private async snapshotAfterFlush(path: string, course: string): Promise<void> {
		let saved = this.closedSaved;
		const session = this.session;
		if (session) {
			try {
				saved = (await this.flushNow()) && session.isSaved();
			} catch (e) {
				console.error("[notebook] flush at the end of a lecture failed", e);
				saved = false;
			}
		}
		this.host.lectureEnded?.(path, course, saved);
	}

	/** Final flush (with retries and an "unsaved" backup as last resort), then detaches the session. */
	private async closeSession(): Promise<void> {
		this.controller?.finishActiveStroke();
		this.commitText();
		const session = this.session;
		this.closedSaved = false;
		if (!session) return;
		try {
			// Obsidian may close the view for a deleted file before our 'delete' handler runs.
			const file = this.file;
			if (file && !this.app.vault.getAbstractFileByPath(file.path)) await session.markDeleted();
			else {
				await session.flushForClose();
				// 0.17 (#23): the copy follows the saved notebook (it is built in the background, after the view is gone).
				if (file && session.mode === "ok" && !session.dirty) this.host.pdfCopy?.closing(file.path, this.pdfCopySource(session));
			}
		} finally {
			this.closedSaved = session.isSaved();
			session.dispose();
			if (this.session === session) this.session = null;
		}
	}

	/** A side-button signal reached the page: remember it for the device (it turns the automatic hold-still default off). */
	private noteSideButtonSeen(): void {
		const s = this.host.settings;
		if (s.penButtonSeen) return;
		s.penButtonSeen = true;
		this.applySettings(s);
		void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
	}

	applySettings(settings: NotebookSettings): void {
		this.applyInput(settings);
		refreshSlideBadges(this); // 0.14 slides: the badges setting
		this.pressure.mode = settings.pressureMode;
		if (this.toolbar && this.tools.eraserSize !== settings.eraserSize) this.toolbar.update({ eraserSize: settings.eraserSize });
		this.pens?.refresh();
		this.scrollbar?.update();
		this.minimap?.update();
		this.symbols?.sync();
		this.filter.params = stabilizationParams(settings.stabilization);
		// wave 0.7: resilience (#346): safe mode turns low-latency ink and prediction off for this view.
		const fast = this.resilience?.lowLatencyAllowed() !== false;
		if (this.controller) {
			this.controller.predictionEnabled = settings.inkPrediction && fast;
			if (!this.controller.drawing) this.controller.setRawUpdates(settings.lowLatencyInk && fast);
		}
		if (this.renderer && !this.active) this.renderer.setLowLatency(settings.lowLatencyInk && fast);
		this.setScrollMode(settings.scrollMode);
		this.applyPageHeader(settings);
		this.perfEl?.toggleClass("notebook-hidden", !settings.perfOverlay);
		if (this.renderer) this.renderer.onFrame = settings.perfOverlay ? (t) => this.onFrame(t) : null;
		this.reading?.settingsChanged();
		this.lectureMode?.settingsChanged();
		this.slideBack?.settingsChanged();
		this.pageRefs?.reset();
		// wave 0.9 (370): a new toolbar size changes the bar, the contextual bar and the number of quick slots.
		this.ui?.refresh();
		this.display?.settingsChanged();
		this.tabs?.refresh();
		// 0.13: the outline lists what the settings say.
		this.pageNav?.refresh();
	}

	/**
	 * Input policy from the settings; while annotations are hidden, or the user switched on read-only mode, the view is
	 * read-only and a finger only pans and zooms (a tap still opens a link).
	 */
	private applyInput(settings: NotebookSettings = this.host.settings): void {
		const base = policySettings(settings);
		const policy = this.reading ? this.reading.policy(base) : base;
		// 0.16: in the Select text mode a finger selects (it never writes there), also while the notebook is read-only.
		this.policy.settings = this.pdfText?.active ? { ...policy, fingerDrawing: true } : this.userReadOnly ? { ...policy, fingerDrawing: false } : policy;
	}

	/** wave 0.10 (51): read-only mode of this view is on. */
	get readOnlyMode(): boolean {
		return this.userReadOnly;
	}

	/**
	 * wave 0.10 (51): switches read-only mode of this view. Whatever is being written is finished first (a stroke, a text
	 * box, an open equation or graph, a selection, a pending marker), so nothing is lost, and saved normally if there was a
	 * change; after that nothing can change the document and nothing is written: no backup, no "write it back" flow.
	 * Needs an open document; a notebook that cannot be loaded is already read-only.
	 */
	setReadOnlyMode(on: boolean, notify = true): void {
		if (on === this.userReadOnly) return;
		if (on) {
			if (!this.session?.doc) return;
			this.controller?.finishActiveStroke();
			this.commitText();
			this.clearSelection();
			this.markers?.disarm();
			this.excerpts?.disarm();
			this.penLinks?.hideChip();
			this.pageOffer?.cancel();
			this.radial?.close();
			// What the stroke or the text box just added is saved as usual before the mode locks the document.
			void this.flushNow();
		}
		this.userReadOnly = on;
		this.body?.toggleClass("is-read-only", on);
		this.toolbar?.setReadOnly(on);
		this.applyInput();
		this.toolbar?.setEditable(this.editable());
		this.updateHistoryButtons();
		this.refreshUi();
		if (notify) showNotice(t(on ? "readonly.on" : "readonly.off"), 4000);
	}

	toggleReadOnlyMode(): void {
		this.setReadOnlyMode(!this.userReadOnly);
	}

	/**
	 * Changes the notebook metadata (tags, favourite, cover, bookmarks) through the undo history, for the library when
	 * the notebook is open. Returns false when the document cannot be edited (not loaded, read-only, being drawn on).
	 */
	applyMetaPatch(patch: Partial<NotebookMeta>): boolean {
		const doc = this.session?.doc;
		if (!doc || !this.editable() || this.controller?.drawing) return false;
		const before = doc.meta ?? cloneMeta(DEFAULT_META);
		const after = mergeMeta(before, patch);
		if (metaEquals(before, after)) return true;
		this.history.execute(new SetMeta(before, after));
		this.afterHistoryChange();
		return true;
	}

	undo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.commitText();
		this.clearSelection();
		this.penLinks?.hideChip();
		this.pageOffer?.cancel();
		if (this.history.undo()) this.afterHistoryChange();
	}

	/**
	 * The side button turned out to be held at the pen contact that has just lifted (its `contextmenu` came late): the
	 * stroke that contact committed is undone, one history step, so the contact can be replayed as the eraser. Only when
	 * that stroke's step is still the latest one (nothing was done since); false otherwise, and nothing changes.
	 */
	private retractStroke(): boolean {
		const c = this.justCommitted;
		this.justCommitted = null;
		if (!c || !this.editable() || this.controller?.drawing || this.history.canRedo()) return false;
		const steps = this.history.pending();
		if (steps[steps.length - 1] !== c.cmd) return false;
		this.penLinks?.hideChip();
		this.pageOffer?.cancel();
		if (this.history.undo() !== c.cmd) return false;
		this.renderer?.invalidate();
		this.afterHistoryChange();
		return true;
	}

	redo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.commitText();
		this.clearSelection();
		this.penLinks?.hideChip();
		this.pageOffer?.cancel();
		if (this.history.redo()) this.afterHistoryChange();
	}

	// --- pens: favourites, tools, pen-only (hotkey commands) ---

	/** Selects a tool, as the toolbar does. */
	selectTool(tool: ToolName): void {
		if (this.editable()) this.toolbar.setTool(tool);
	}

	/** Selects the shape tool with the given kind. */
	selectShape(shapeKind: ToolbarState["shapeKind"]): void {
		if (this.editable()) this.toolbar.update({ tool: "shape", shapeKind });
	}

	/** Selects favourite pen index (0-based). */
	selectFavourite(index: number): void {
		this.pens?.applyFavourite(index);
	}

	/** Eraser: whole strokes or parts of strokes. */
	selectEraserMode(eraserMode: ToolbarState["eraserMode"]): void {
		if (this.editable()) this.toolbar.update({ tool: "eraser", eraserMode });
	}

	/** Steps the eraser size to the next larger (1) or smaller (-1) preset. */
	stepEraserSize(direction: 1 | -1): void {
		if (this.editable()) this.toolbar.update({ eraserSize: stepEraserSize(this.tools.eraserSize, direction) });
	}

	/** wave 0.8 (378): opens the page panel in selection mode (action "pages-select"). */
	selectPages(): void {
		this.setNavigatorOpen(true);
		this.pageNav?.beginSelection();
	}

	toggleNavigator(): void {
		this.setNavigatorOpen(!this.pageNav?.open);
	}

	toggleRuler(): void {
		if (this.editable()) this.toolbar.update({ ruler: !this.tools.ruler });
	}

	/** Deletes the selection (lasso), if any. */
	removeSelection(): void {
		if (this.editable()) this.deleteSelection();
	}

	/**
	 * wave 0.9 (357): moves the selected strokes and elements in the layer order of their page (model/layers.ts), one undo
	 * step. The selection is released afterwards: a selection floats on its own layer, so the new order is only visible once
	 * it is dropped back on the page.
	 */
	moveSelectionLayer(move: LayerMove): void {
		const sel = this.selection;
		const page = sel && this.session?.doc?.pages[sel.pageIndex];
		if (!sel || !page || !this.editableDocument()) return;
		this.commitText();
		const bounds = { stroke: this.renderer?.boundsOf, measure: measureText };
		// wave 0.10 (359): on a selection across pages every page's items are reordered inside their own page.
		const doc = this.session!.doc!;
		const perPage = sel.others?.length
			? this.selectionParts(sel).flatMap((part) => {
				const target = doc.pages[part.pageIndex];
				const one = target ? layerCommand(target, part, move, bounds) : null;
				return one ? [one] : [];
			})
			: null;
		const cmd = perPage ? (perPage.length === 0 ? null : perPage.length === 1 ? perPage[0]! : new Batch("Change layer order", perPage)) : layerCommand(page, sel, move, bounds);
		if (!cmd) {
			showNotice(t("layer.nothing"));
			return;
		}
		this.clearSelection();
		this.history.execute(cmd);
		this.afterHistoryChange();
		this.renderer?.invalidate();
	}

	/** wave 0.9 (361): the find and replace panel for the text boxes of this notebook. */
	openFindReplace(): void {
		if (!this.session?.doc) return;
		this.commitText();
		new FindReplaceModal({
			app: this.app,
			doc: () => this.session?.doc ?? null,
			canEdit: () => this.editableDocument() !== null,
			run: (cmd) => this.applyCommand(cmd),
			goTo: (index) => this.goToPage(index),
		}).open();
	}

	/** wave 0.9 (379): the information panel of page `index`. */
	openPageInfo(index: number): void {
		if (!this.session?.doc?.pages[index]) return;
		new PageInfoModal({
			app: this.app,
			doc: () => this.session?.doc ?? null,
			editedAt: (pageId) => {
				const id = this.session?.doc?.id;
				return id ? (this.host.pageEditedAt?.(id, pageId) ?? null) : null;
			},
		}, index).open();
	}

	/** wave 0.9 (389): inserts a page (same size and paper) right after the page with this id; false when it is gone or the document cannot be edited. */
	private insertPageAfterId(pageId: string): boolean {
		const doc = this.session?.doc;
		const index = doc ? doc.pages.findIndex((p) => p.id === pageId) : -1;
		if (index < 0 || !this.editableDocument()) return false;
		this.addPageAfter(index);
		return true;
	}

	/** Pen only: fingers pan and zoom but do not draw. */
	togglePenOnly(): void {
		this.pens?.togglePenOnly();
	}

	/** Scrolls to the page delta pages away from the one in view. */
	goToRelativePage(delta: number): void {
		const n = this.shownDoc()?.pages.length ?? 0;
		if (n === 0) return;
		this.scrollToPage(Math.min(n - 1, Math.max(0, this.currentPageIndex() + delta)), 0, true);
	}

	private penStore(): PenStore {
		const s = (): NotebookSettings => this.host.settings;
		const save = (): void => void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
		return {
			// 0.15 pen sets: while a set is active the strip shows it and a saved slot is written into that set; the
			// user's own favourite pens are only touched when no set is active.
			favourites: () => {
				const set = this.activePenSet();
				return set ? slotsOf(set, s().favouritePens) : s().favouritePens;
			},
			saveFavourites: (favs: FavouritePen[]) => {
				const set = this.activePenSet();
				if (set) s().penSets = withSetPens(s().penSets, set.id, favs);
				else s().favouritePens = favs;
				save();
			},
			penOnly: () => !s().fingerDrawing,
			setPenOnly: (on) => {
				s().fingerDrawing = !on;
				this.applyInput();
				save();
			},
			eraserSize: () => s().eraserSize,
			saveEraserSize: (size) => {
				s().eraserSize = size;
				save();
			},
		};
	}

	// --- pen sets (0.15) ---

	private activePenSet(): PenSet | null {
		const id = this.activePenSetId;
		return id ? this.host.settings.penSets.find((x) => x.id === id) ?? null : null;
	}

	private penSetHost(): PenSetHost {
		const s = (): NotebookSettings => this.host.settings;
		return {
			app: this.app,
			data: () => ({ sets: s().penSets, folders: s().penSetFolders, notebooks: s().penSetNotebooks }),
			update: (next) => {
				s().penSets = normalisePenSets(next.sets);
				s().penSetFolders = normaliseAssignments(next.folders, MAX_FOLDER_ASSIGNMENTS);
				s().penSetNotebooks = normaliseAssignments(next.notebooks, MAX_NOTEBOOK_ASSIGNMENTS);
				if (this.activePenSetId && !this.activePenSet()) this.activePenSetId = null; // the set was deleted
				this.pens?.refresh();
				void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
			},
			activeId: () => this.activePenSetId,
			choose: (id) => {
				this.activePenSetId = id;
				this.pens?.refresh();
			},
			notebook: () => (this.file ? { id: this.session?.doc?.id ?? null, path: this.file.path } : null),
			strip: () => this.penStore().favourites().map((f) => ({ ...f })),
			editable: () => this.editable(),
		};
	}

	/** A notebook was opened: use the set of the notebook, else of its nearest folder, else the favourite pens. */
	private loadPenSetForNotebook(file: TFile): void {
		const s = this.host.settings;
		const set = setForOpen({ sets: s.penSets, folders: s.penSetFolders, notebooks: s.penSetNotebooks }, this.session?.doc?.id ?? null, file.path);
		this.activePenSetId = set?.id ?? null;
		// The first pen of the set is taken only when a pen or the highlighter is in use (an eraser or lasso stays).
		const first = set ? slotsOf(set, s.favouritePens)[0] : undefined;
		if (first && (this.tools.tool === "pen" || this.tools.tool === "highlighter")) this.toolbar.update(favouritePatch(first) as Partial<ToolbarState>);
		this.pens?.refresh();
	}

	/** Switches between continuous scrolling and one page at a time, staying on the page in view. */
	setScrollMode(mode: ScrollMode): void {
		const pm = this.pageMode;
		const on = mode === "pages";
		this.refreshUi(); // the page-by-page toggle shows its state
		if (!pm || pm.enabled === on) return;
		const index = this.currentPageIndex();
		pm.setEnabled(on);
		this.fitMode = true;
		this.refreshLayout();
		if (!this.layout) return;
		if (on) pm.goTo(index);
		else {
			this.refit(false);
			this.scrollToPage(index);
		}
	}

	/** Toolbar and command: flips the setting (saved with the plugin settings, applied to every open notebook). */
	togglePageMode(): void {
		const s = this.host.settings;
		s.scrollMode = s.scrollMode === "pages" ? "continuous" : "pages";
		this.setScrollMode(s.scrollMode);
		void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
	}

	fitToWidth(): void {
		this.fitMode = true;
		this.refit(false);
	}

	/** Inserts a blank page after the one in view and scrolls to it. */
	addPage(): void {
		this.addPageAfter(this.currentPageIndex());
	}

	/** wave 0.14 (410): the "+" slot: shows the likeliest new pages as one-tap chips (view/smart-add.ts); nothing is added until one is tapped. */
	openSmartAdd(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.smartAdd?.toggle();
	}

	private smartAddContext(): Omit<SmartAddInput, "history"> | null {
		const doc = this.session?.doc;
		const page = doc?.pages[this.currentPageIndex()];
		if (!doc || !page || !this.editable()) return null;
		return { paper: page.paper.kind, hasBackground: !!page.background, nearbyPapers: nearbyPapers(doc.pages, this.currentPageIndex()), slide: referenceSlideOf(this), exercisePaper: loadExercisePaper(this.app) };
	}

	private addSmartChoice(choice: SmartAddChoice): boolean {
		const index = this.currentPageIndex();
		const before = this.session?.doc?.pages.length ?? 0;
		if (choice.id === "slide") return runPdfSideAction(this, "pdf-side-add-page");
		if (choice.id === "same") this.addPageAfter(index);
		else if (choice.paper) this.addPageWithPaper(choice.paper, index);
		return (this.session?.doc?.pages.length ?? 0) > before;
	}

	/** Inserts a blank page (size and paper of the page at `index`) after it. */
	addPageAfter(index: number): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable() || this.controller?.drawing) return;
		this.commitText();
		this.clearSelection();
		const at = index + 1;
		const like = doc.pages[index];
		const page = like ? createPage({ width: like.width, height: like.height }, { ...like.paper }) : createPage();
		this.history.execute(new AddPage(page, at));
		this.afterHistoryChange();
		this.scrollToPage(at);
	}

	/** "Exercise page here": a blank page with the exercise paper right after the page at `index` (default: the one in view), one undo step. */
	exercisePageAfter(index: number = this.currentPageIndex()): void {
		this.addPageWithPaper(loadExercisePaper(this.app), index);
	}

	/** A blank page with this paper, the size of the page at `index`, right after it, one undo step. */
	addPageWithPaper(paper: PaperKind, index: number = this.currentPageIndex()): void {
		const doc = this.session?.doc;
		const like = doc?.pages[index];
		if (!doc || !like || !this.editable() || this.controller?.drawing) return;
		this.commitText();
		this.clearSelection();
		this.history.execute(new AddPage(exercisePage(like, paper), index + 1));
		this.afterHistoryChange();
		this.scrollToPage(index + 1);
	}

	/** Asks for the paper of exercise pages. */
	chooseExercisePaper(): void {
		void askExercisePaper(this.app);
	}


	/** Shows page `index` from its top, or (v7 reading position) with page y `y` at the top of the view. `animate`: page-by-page turn. */
	private scrollToPage(index: number, y = 0, animate = false): void {
		if (this.pageMode?.enabled) {
			this.pageMode.goTo(index, animate);
			if (y > 0) {
				const box = this.layout?.boxes[index];
				if (box) this.setViewport({ ...this.viewport, offsetY: -(box.y + y) * this.viewport.scale });
			}
			return;
		}
		const box = this.layout?.boxes[index];
		if (!box) return;
		const offsetY = y > 0 ? -(box.y + y) * this.viewport.scale : PAGE_MARGIN - box.y * this.viewport.scale;
		this.setViewport({ ...this.viewport, offsetY });
	}

	/** 0.20 (#102): to a line of a page (a heading of the outline or the map), a little above it so the line is not at the very edge. */
	private goToPageAt(index: number, y: number): void {
		this.recordJump(index);
		this.scrollToPage(index, Math.max(1, y - 24));
		if (this.body.hasClass("is-narrow")) this.setNavigatorOpen(false);
	}

	private goToPage(index: number): void {
		this.recordJump(index);
		this.scrollToPage(index);
		if (this.body.hasClass("is-narrow")) this.setNavigatorOpen(false);
	}

	private setNavigatorOpen(open: boolean): void {
		this.pageNav?.setOpen(open);
		this.toolbar.setNavigatorOpen(open);
	}

	/** The page sheet of page `index` (ui redesign: replaces the old page menu; its actions are in ui/actions.ts). */
	private openPageMenu(index: number): void {
		if (!this.session?.doc?.pages[index]) return;
		this.ui?.openSheet("page", null, index);
	}

	async exportNotebookPdf(): Promise<void> {
		const doc = this.session?.doc;
		if (doc && this.file) await exportPdf(this.app, this.file, this.renderPagesOf(doc), "", this.media, this.exportOptions());
	}

	/** wave 0.9 (381): the export dialog (format, page or notebook, ink and/or background). `pageIndex`: opened from that page's sheet. */
	openExportDialog(pageIndex?: number, initialFormat?: ExportFormat): void {
		const doc = this.session?.doc;
		const file = this.file;
		if (!doc || !file || doc.pages.length === 0) return;
		new ExportModal({
			app: this.app,
			pageCount: doc.pages.length,
			pageIndex: Math.min(doc.pages.length - 1, Math.max(0, pageIndex ?? this.currentPageIndex())),
			pageFirst: pageIndex !== undefined,
			// wave 0.10 (81): PNG images go to a folder next to the notebook by default; Print only where the device can print.
			defaultFolder: siblingFolder(file, "PNG"),
			canPrint: canPrint(),
			...(initialFormat ? { initialFormat } : {}),
			pages: () => this.renderPagesOf(doc),
			run: (request) => void runExport(this.app, file, this.renderPagesOf(doc), request, this.media, this.exportOptions()),
		}).open();
	}

	/** wave 0.9 (382): the dialog of the Markdown export (folder, resolution). */
	openMarkdownExport(): void {
		const doc = this.session?.doc;
		const file = this.file;
		if (!doc || !file || doc.pages.length === 0) return;
		new MarkdownExportModal({
			app: this.app,
			pageCount: doc.pages.length,
			defaultFolder: defaultMarkdownFolder(file),
			// 0.15 (241): like the PDF, PNG and SVG exports, the pages as the states in view show them.
			run: (folder, dpi) => void exportMarkdown(this.app, file, { ...doc, pages: [...this.renderPagesOf(doc)] }, this.media, { folder, dpi, ...this.exportOptions() }),
		}).open();
	}

	/**
	 * 0.20 (#30): "Share page…" / "Share selection…": the page (or the selection, or some pages) as a PNG or PDF through the system share sheet;
	 * where that is not available a copy is saved in the vault. `pageIndex`: opened from that page's sheet; `fromSelection`: open on the selection.
	 */
	openSharePage(pageIndex?: number, fromSelection = false): void {
		const doc = this.session?.doc;
		const file = this.file;
		if (!doc || !file || doc.pages.length === 0) return;
		let index = Math.min(doc.pages.length - 1, Math.max(0, pageIndex ?? this.currentPageIndex()));
		let crop: ShareHost["selection"] = null;
		const sel = this.selection;
		if (sel && !this.statesTools?.ownsSelection(sel) && (fromSelection || sel.pageIndex === index)) {
			// A collapsed sticky note keeps its ink out of view: it never widens the region.
			const bounds = itemsBounds(withoutPinnedInk(sel.strokes, sel.elements), sel.elements, measureText);
			const page = doc.pages[sel.pageIndex];
			if (bounds && page) {
				crop = taskCropRect(bounds, page);
				index = sel.pageIndex;
			}
		}
		if (fromSelection && !crop) return;
		const modal = new SharePageModal({
			app: this.app, file, pageCount: doc.pages.length, pageIndex: index, selection: crop,
			pages: () => this.renderPagesOf(doc), media: this.media, options: () => this.exportOptions(),
		});
		if (fromSelection) modal.startOnSelection();
		modal.open();
	}

	/** 0.18 (#59): the selected region as a picture (PNG or SVG) inserted into the Markdown note the user was last in, or into a chosen note. */
	insertSelectionIntoNote(kind: "png" | "svg"): void {
		const sel = this.selection;
		const doc = this.session?.doc;
		const file = this.file;
		if (!sel || !doc || !file || this.statesTools?.ownsSelection(sel)) return;
		// A collapsed sticky note keeps its ink out of view: it never widens the region.
		const bounds = itemsBounds(withoutPinnedInk(sel.strokes, sel.elements), sel.elements, measureText);
		const page = doc.pages[sel.pageIndex];
		const shown = this.renderPagesOf(doc)[sel.pageIndex];
		if (!bounds || !page || !shown) return;
		const options = this.exportOptions();
		void runInsertIntoNote({
			app: this.app, file, settings: this.host.settings, page: shown, pageNumber: sel.pageIndex + 1, crop: taskCropRect(bounds, page), media: this.media, kind,
			exportOptions: options,
			render: {
				...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
			},
		});
	}

	/** 0.17 (#57): "Make task" from the selection: a dialog, then the task (with a picture of the region and a link to the page) is added to a note. */
	makeTaskFromSelection(): void {
		const sel = this.selection;
		const doc = this.session?.doc;
		const file = this.file;
		if (!sel || !doc || !file || !this.editable() || this.statesTools?.ownsSelection(sel)) return;
		const bounds = itemsBounds(sel.strokes, sel.elements, measureText);
		const page = doc.pages[sel.pageIndex];
		const shown = this.renderPagesOf(doc)[sel.pageIndex];
		if (!bounds || !page || !shown) return;
		const crop = taskCropRect(bounds, page);
		const options = this.exportOptions();
		new MakeTaskModal(this.app, this.host.settings, sel.pageIndex + 1, (request) => void runMakeTask({
			app: this.app, file, settings: this.host.settings, page: shown, pageNumber: sel.pageIndex + 1, crop, media: this.media,
			render: {
				...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
			},
			...(options.prepare ? { prepare: options.prepare } : {}),
		}, request)).open();
	}

	/** 0.19 (#228): the Figures gallery: every picture and figure cut-out of the section, the notebook or some pages (read-only). */
	openFigures(): void {
		const file = this.file;
		if (!this.shownDoc() || !file) return;
		const docPages = () => this.shownDoc()?.pages ?? [];
		new FiguresModal({
			app: this.app,
			pages: docPages,
			assetIds: () => new Set(Object.values(this.shownDoc()?.assets ?? {}).filter((a) => a.kind === "image").map((a) => a.id)),
			current: () => this.currentPageIndex(),
			readAsset: (id) => (this.media ? this.media.readAsset(id) : Promise.reject(new Error("no media"))),
			goTo: (entry) => {
				const index = docPages().findIndex((p) => p.id === entry.pageId);
				if (index < 0) return;
				this.recordArrival(index);
				if (!this.excerpts?.reveal(index, { x: entry.x, y: entry.y, width: entry.width, height: entry.height })) this.scrollToPage(index);
			},
			insertIntoNote: (entry) => {
				const doc = this.session?.doc;
				const index = docPages().findIndex((p) => p.id === entry.pageId);
				const page = doc?.pages[index];
				const shown = doc ? this.renderPagesOf(doc)[index] : undefined;
				if (!page || !shown) return;
				const options = this.exportOptions();
				void runInsertIntoNote({
					app: this.app, file, settings: this.host.settings, page: shown, pageNumber: index + 1, media: this.media, kind: "png", exportOptions: options,
					crop: taskCropRect({ minX: entry.x, minY: entry.y, maxX: entry.x + entry.width, maxY: entry.y + entry.height }, page),
					render: {
						...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
						...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
					},
				});
			},
			openOriginal: (entry) => {
				const asset = this.shownDoc()?.assets?.[entry.asset];
				const stored = asset ? resolveAssetFile(this.app, asset, this.host.settings.folder) : null;
				if (!stored) return false;
				void this.app.workspace.getLeaf("tab").openFile(stored);
				return true;
			},
		}).open();
	}

	/** 0.19 (#213): "Look up later" from the selection: an optional typed word, then a picture of the region and a link to the page are appended to the list note. */
	lookUpFromSelection(): void {
		const sel = this.selection;
		const doc = this.session?.doc;
		const file = this.file;
		if (!sel || !doc || !file || this.statesTools?.ownsSelection(sel)) return;
		// A collapsed sticky note keeps its ink out of view: it never widens the region.
		const bounds = itemsBounds(withoutPinnedInk(sel.strokes, sel.elements), sel.elements, measureText);
		const page = doc.pages[sel.pageIndex];
		const shown = this.renderPagesOf(doc)[sel.pageIndex];
		if (!bounds || !page || !shown) return;
		const crop = taskCropRect(bounds, page);
		const options = this.exportOptions();
		new LookUpWordModal(this.app, sel.pageIndex + 1, (word) => void runLookUp({
			app: this.app, file, settings: this.host.settings, page: shown, pageNumber: sel.pageIndex + 1, crop, media: this.media,
			render: {
				...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
			},
			...(options.prepare ? { prepare: options.prepare } : {}),
		}, word)).open();
	}

	/** 0.19 (#213): the read-only sheet of this notebook's "Look up later" entries, each with a jump to its page. */
	openLookUpList(): void {
		const file = this.file;
		const doc = this.shownDoc();
		if (!file || !doc) return;
		new LookUpSheet({ app: this.app, file, settings: this.host.settings, pages: () => this.shownDoc()?.pages ?? [], goTo: (index) => this.goToPage(index) }).open();	}

	/** 0.21 (#187): "Add to index…" from the selection: a star marker over the selected region, labelled `<prefix> <term>` (one undoable step). */
	addToIndexFromSelection(): void {
		const sel = this.selection;
		const doc = this.session?.doc;
		if (!sel || !doc || !this.editable() || this.statesTools?.ownsSelection(sel)) return;
		const page = doc.pages[sel.pageIndex];
		const bounds = itemsBounds(withoutPinnedInk(sel.strokes, sel.elements), sel.elements, measureText);
		if (!page || !bounds) return;
		const prefix = normalizeIndexPrefix(this.host.settings.indexPrefix);
		const pageId = page.id;
		const x0 = Math.max(0, bounds.minX);
		const y0 = Math.max(0, bounds.minY);
		const rect = { x: x0, y: y0, width: Math.min(page.width, bounds.maxX) - x0, height: Math.min(page.height, bounds.maxY) - y0 };
		new AddToIndexModal(this.app, prefix, termSpellings(currentIndex(doc.pages, prefix)), (label) => {
			const live = this.session?.doc?.pages.find((p) => p.id === pageId);
			if (!live || !this.editable()) return;
			const region = isRegion(rect) ? rect : null;
			const marker = createMarker("star", rect.x + rect.width / 2, rect.y + rect.height / 2, { region, at: new Date().toISOString(), text: label });
			this.history.execute(new AddElement(pageId, marker, live.elements?.length ?? 0));
			this.afterHistoryChange();
			this.renderer?.invalidate();
			showNotice(t("bookindex.added"), 3000);
		}).open();
	}

	/** 0.21 (#187): the back-of-book index: terms A-Z with their pages, a jump on a tap, and a note written next to the notebook. */
	openBookIndex(): void {
		const file = this.file;
		if (!this.shownDoc() || !file) return;
		new BookIndexModal({
			app: this.app, file, docId: this.shownDoc()?.id, prefix: normalizeIndexPrefix(this.host.settings.indexPrefix),
			pages: () => this.shownDoc()?.pages ?? [], goTo: (index, y) => this.scrollToPage(index, y),
		}).open();
	}

	/** 0.18 (O7): the sheet of notes that link to the page in view. */
	openMentions(): void {
		this.mentions?.open();
	}

	/** 0.16 (#90): the Highlights digest dialog (grouping, picture quality); the note is written next to the notebook. */
	openHighlightsDigest(): void {
		const doc = this.session?.doc;
		const file = this.file;
		if (!doc || !file) return;
		const pages = [...this.renderPagesOf(doc)];
		if (digestCounts(pages).regions === 0) {
			showNotice(t("digest.none"), 6000);
			return;
		}
		const options = this.exportOptions();
		new HighlightsDigestModal({
			app: this.app, file, pages, group: this.host.settings.digestGroup,
			run: (request) => void runHighlightsDigest({
				app: this.app, file, pages, media: this.media,
				render: {
					...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
					...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
				},
				...(options.prepare ? { prepare: options.prepare } : {}),
			}, request),
		}).open();
	}

	/** wave 0.9: view-only night mode and cropped margins (null before the view is open). */
	/** wave 0.10 (363): the open notebooks (view actions). */
	get tabTools(): NotebookTabs | null {
		return this.tabs;
	}

	get displayTools(): ViewDisplay | null {
		return this.display;
	}

	/** 0.15 (#75): what the automatic header or footer needs from this notebook (read when drawn, so a rename or new page shows). */
	private headerNotebook(): HeaderNotebook {
		return { title: this.file?.basename ?? "", createdAt: this.session?.doc?.createdAt ?? "", locale: getLanguage() };
	}

	/** 0.15 (#75): hands the renderer the painter of the page header (null when off). Painted into the static layer only. */
	private applyPageHeader(s: HeaderSettings): void {
		const r = this.renderer;
		if (!r) return;
		const snap: HeaderSettings = { headerMode: s.headerMode, headerPageNumber: s.headerPageNumber, headerPageTotal: s.headerPageTotal, headerDate: s.headerDate, headerTitle: s.headerTitle, headerAlign: s.headerAlign, headerInExport: s.headerInExport, headerPageTimes: s.headerPageTimes };
		const key = JSON.stringify(snap);
		if (r === this.headerRenderer && key === this.headerKey) return;
		this.headerRenderer = r;
		this.headerKey = key;
		r.setPageDecor(snap.headerMode === "off" ? null : (ctx, page, index, night) => {
			const count = this.session?.doc?.pages.length ?? 0;
			const h = headerLayout(page, index, count, snap, this.headerNotebook());
			if (h) drawHeader(ctx, h, night);
		});
	}

	/** 0.15 (#75): the header of a page for exports and printing; undefined when it is off or kept out of exports. */
	private exportHeader(): ((page: Page) => HeaderLayout | null) | undefined {
		const s = this.host.settings;
		const doc = this.session?.doc;
		return doc ? exportHeaderFor(doc.pages, s, this.headerNotebook()) : undefined;
	}

	/** v8: exports draw hidden ink only where the solutions are shown, and label boxes in the reader's language. */
	exportOptions(): ExportOptions {
		const doc = this.session?.doc;
		const header = this.exportHeader();
		return {
			hiddenInk: (page) => this.markers?.isRevealed(page) ?? false, boxLabel: translatedBoxLabel,
			// v9: equations without a cached outline are typeset first; numbers count over the whole notebook.
			prepare: (pages) => this.math?.prepareExport(pages) ?? Promise.resolve(),
			...(doc ? { equationNumbers: equationNumbers(doc.pages) } : {}),
			...(header ? { header } : {}),
			// 0.18 (#86): the margin comments as notes in the PDF, when the setting asks for them.
			...(this.host.settings.commentsInPdf ? { comments: pdfCommentLabels() } : {}),
		};
	}

	/** v9: equations and graphs of this view (null before the view is open). */
	get mathTools(): MathTools | null {
		return this.math;
	}

	/** What the equation editor, the graph panel and their gestures need from the view. */
	private mathHost(): MathHost {
		const boxOf = (pageIndex: number) => this.layout?.boxes[pageIndex] ?? null;
		return {
			stage: this.stage,
			doc: () => this.session?.doc ?? null,
			editable: () => !!this.editableDocument(),
			renderer: () => this.renderer,
			execute: (cmd) => this.applyCommand(cmd),
			insertTarget: () => {
				const index = this.currentPageIndex();
				const box = boxOf(index);
				if (!box || !this.session?.doc?.pages[index]) return null;
				const [dx, dy] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
				const [x, y] = toPageLocal(box, dx, dy);
				const page = this.session.doc.pages[index];
				return { pageIndex: index, x: Math.min(page.width, Math.max(0, x)), y: Math.min(page.height, Math.max(0, y)) };
			},
			toStage: (pageIndex, x, y) => {
				const box = boxOf(pageIndex);
				if (!box) return null;
				const { scale, offsetX, offsetY } = this.viewport;
				return [offsetX + (box.x + x) * scale, offsetY + (box.y + y) * scale];
			},
			toPage: (pageIndex, clientX, clientY) => {
				const box = boxOf(pageIndex);
				if (!box) return null;
				const r = this.stage.getBoundingClientRect();
				const [dx, dy] = screenToPage(this.viewport, clientX - r.left, clientY - r.top);
				return toPageLocal(box, dx, dy);
			},
			scale: () => this.viewport.scale,
			selection: () => (this.selection ? { pageIndex: this.selection.pageIndex, elements: this.selection.elements } : null),
			select: (pageIndex, elements) => this.selectItems(pageIndex, [], elements),
			deselect: () => this.clearSelection(),
			pen: () => ({ color: this.tools.penColor, textSize: this.tools.textSize }),
			inkFollows: () => this.host.settings.inkFollowsObjects,
			refresh: () => this.refreshUi(),
		};
	}

	/** 0.17 (#20): sticky notes of this view (null before the view is open). */
	get stickyTools(): StickyTools | null {
		return this.sticky;
	}

	/** 0.18 (#86): margin comments of this view (null before the view is open). */
	get commentTools(): CommentTools | null {
		return this.comments;
	}

	/** What the comment tools need from the view. */
	private commentsHost(): CommentsHost {
		return {
			app: this.app,
			body: this.body,
			doc: () => this.session?.doc ?? null,
			editable: () => !!this.editableDocument(),
			execute: (cmd) => this.applyCommand(cmd),
			geometry: () => this.overlayGeometry(),
			addOverlayListener: (fn) => this.addOverlayListener(fn),
			selection: () => this.selectionRegion(),
			clearSelection: () => this.clearSelection(),
			currentPage: () => this.currentPageIndex(),
			deviceName: () => this.host.syncSafety?.presence.device().name ?? t("comments.thisDevice"),
			reveal: (pageIndex, y) => this.scrollToPage(pageIndex, y),
			markersOn: () => this.host.settings.commentMarkers,
			narrow: () => this.body.hasClass("is-narrow"),
			notify: (message) => void showNotice(message, 3500),
			refreshUi: () => this.refreshUi(),
		};
	}

	/** What the sticky note tools need from the view. */
	private stickyHost(): StickyHost {
		return {
			app: this.app,
			doc: () => this.session?.doc ?? null,
			editable: () => !!this.editableDocument(),
			execute: (cmd) => this.applyCommand(cmd),
			insertTarget: () => this.mathHost().insertTarget(),
			selection: () => (this.selection ? { pageIndex: this.selection.pageIndex, elements: this.selection.elements } : null),
			select: (pageIndex, elements) => this.selectItems(pageIndex, [], elements),
			refresh: () => this.refreshUi(),
		};
	}

	/** 0.20 (#39): groups and locked elements of this view (null before the view is open). */
	get groupTools(): GroupTools | null {
		return this.groups;
	}

	/** What the group tools need from the view (0.20, #39). */
	private groupHost(): GroupHost {
		return {
			app: this.app,
			stage: () => this.stage,
			doc: () => this.session?.doc ?? null,
			editable: () => !!this.editableDocument(),
			execute: (cmd) => this.applyCommand(cmd),
			selection: () => (this.selection ? this.selectionParts(this.selection) : null),
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
			toStage: (pageIndex, x, y) => {
				const box = this.layout?.boxes[pageIndex];
				if (!box) return null;
				const { scale, offsetX, offsetY } = this.viewport;
				return [offsetX + (box.x + x) * scale, offsetY + (box.y + y) * scale];
			},
			reveal: (pageIndex, y) => this.scrollToPage(pageIndex, y),
			measure: measureText,
			refresh: () => this.refreshUi(),
		};
	}

	/** What the checklist tools need from the view (0.19, #103). */
	private checklistHost(): ChecklistHost {
		return {
			app: this.app,
			stage: () => this.stage,
			doc: () => this.session?.doc ?? null,
			editable: () => !!this.editableDocument(),
			// One undo step. Unlike `applyCommand` it keeps the selection and the text being typed: a tap on a checkbox is not an edit session.
			execute: (cmd) => {
				const done = this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
				return done;
			},
			// Upkeep (a link that follows a renamed note, or is dropped): no undo step, but the document changed, so it is saved.
			maintain: (cmd) => {
				const done = this.history.applyQuietly(cmd);
				if (done) {
					this.afterHistoryChange();
					this.renderer?.invalidate();
				}
				return done;
			},
			settings: () => this.host.settings,
			tool: () => this.tools.tool,
			scale: () => this.viewport.scale,
			toStage: (pageIndex, x, y) => {
				const box = this.layout?.boxes[pageIndex];
				if (!box) return null;
				const { scale, offsetX, offsetY } = this.viewport;
				return [offsetX + (box.x + x) * scale, offsetY + (box.y + y) * scale];
			},
			pageAt: (clientX, clientY) => {
				const layout = this.layout;
				if (!layout) return null;
				const rect = this.stage.getBoundingClientRect();
				const [dx, dy] = this.toDoc({ x: clientX - rect.left, y: clientY - rect.top });
				const pageIndex = pageAt(layout, dx, dy, 0);
				const box = layout.boxes[pageIndex];
				return box ? { pageIndex, local: toPageLocal(box, dx, dy) } : null;
			},
			fingerNavigates: (e) => this.policy.route("touch", e.timeStamp, 0, Math.max(e.width || 0, e.height || 0), e.buttons) === "navigate",
			penBusy: (t) => this.policy.penRecentlyActive(t),
			register: (ref) => this.registerEvent(ref),
			insertTarget: () => this.mathHost().insertTarget(),
			selection: () => (this.selection ? { pageIndex: this.selection.pageIndex, strokes: this.selection.strokes, elements: this.selection.elements } : null),
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
			penColor: () => this.tools.penColor,
			inkOf: (page) => this.inkInView(page),
			sendTask: (pageIndex, bounds, request) => this.sendChecklistTask(pageIndex, bounds, request),
			refresh: () => this.refreshUi(),
		};
	}

	/** 0.19 (#103): handwritten checklists of this view (null before the view is open). */
	get checklistTools(): ChecklistTools | null {
		return this.checklist;
	}

	/**
	 * 0.19 (#103): writes the task line of a checkbox (with a picture of its handwriting and a link to the page) into the note the
	 * request names, the way "Make task" does for a selection (the same code, view/selection-task.ts). The path of the note, or null.
	 */
	private sendChecklistTask(pageIndex: number, bounds: BBox, request: TaskRequest): Promise<string | null> {
		const doc = this.session?.doc;
		const file = this.file;
		const page = doc?.pages[pageIndex];
		const shown = doc ? this.renderPagesOf(doc)[pageIndex] : undefined;
		if (!doc || !file || !page || !shown) return Promise.resolve(null);
		const options = this.exportOptions();
		return runMakeTask({
			app: this.app, file, settings: this.host.settings, page: shown, pageNumber: pageIndex + 1, crop: taskCropRect(bounds, page), media: this.media,
			render: {
				...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}), ...(options.header ? { header: options.header } : {}),
			},
			...(options.prepare ? { prepare: options.prepare } : {}),
		}, request);
	}

	/** Colour picker and eyedroppers of this view (null before the view is open). */
	get colourTools(): ColourTools | null {
		return this.colour;
	}

	/** The strokes in view of the page under a screen point, with the point in page coordinates (style eyedropper); null off the pages. */
	private inkAtPoint(clientX: number, clientY: number): PageInk | null {
		const layout = this.layout;
		if (!layout) return null;
		const r = this.stage.getBoundingClientRect();
		const [dx, dy] = screenToPage(this.viewport, clientX - r.left, clientY - r.top);
		const index = pageAt(layout, dx, dy, PAGE_TOLERANCE);
		const page = index < 0 ? null : this.pageAtIndex(index);
		const box = index < 0 ? null : layout.boxes[index];
		if (!page || !box) return null;
		const [x, y] = toPageLocal(box, dx, dy);
		return { strokes: this.inkInView(page), x, y, scale: this.viewport.scale };
	}

	/** Markers, boxes and invisible ink of this view (null before the view is open). */
	get stateTools(): StatesTools | null {
		return this.statesTools;
	}

	/** The pages the renderer and the exports draw: with the state each page is shown in (live views of pages that have states). */
	private renderPagesOf(doc: NotebookDocument): readonly Page[] {
		return this.statesTools ? this.statesTools.viewPages(doc.pages) : doc.pages;
	}

	/** The renderer draws the pages again with the states as they are now (a state was switched, no command ran). */
	private syncRenderPages(): void {
		const doc = this.shownDoc();
		this.renderer?.setDocument(doc ? this.renderPagesOf(doc) : null, this.layout);
	}

	private mountStates(): void {
		this.statesTools = new StatesTools({
			app: this.app,
			parent: () => this.body,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable(),
			pageIndex: () => this.currentPageIndex(),
			execute: (cmd) => this.applyCommand(cmd),
			repaint: () => this.syncRenderPages(),
			selection: () => (this.selection ? { pageIndex: this.selection.pageIndex, strokes: this.selection.strokes } : null),
			select: (pageIndex, strokes) => this.selectItems(pageIndex, strokes, []),
			deselect: () => this.clearSelection(),
			refreshUi: () => this.refreshUi(),
		});
	}

	get markerTools(): MarkerTools | null {
		return this.markers;
	}

	/** The strokes of `page` the reader can see (v8: hidden ink only while the solutions are shown). */
	private inkInView(page: Page): readonly Stroke[] {
		const shown = visibleStrokes(page.strokes, this.markers?.isRevealed(page) ?? false);
		// 0.17 (#20): the ink a collapsed sticky note keeps hidden is not there to erase, select or offer.
		const noteInk = hiddenStickyInk(page.elements);
		const ink = noteInk ? shown.filter((s) => !noteInk.has(s.id)) : shown;
		// 0.15 (241): a shown state moved some strokes away from where they were drawn: the ink tools leave them alone.
		const moved = this.statesTools?.displaced(page);
		return moved ? ink.filter((s) => !moved.has(s.id)) : ink;
	}

	/** v10: anchored excerpts of this view (null before the view is open). */
	get excerptTools(): ExcerptTools | null {
		return this.excerpts;
	}

	private mountExcerpts(): void {
		this.excerpts = new ExcerptTools({
			app: this.app,
			doc: () => this.session?.doc ?? null,
			shownDoc: () => this.shownDoc(),
			path: () => this.file?.path ?? null,
			folder: () => this.host.settings.folder,
			editable: () => !!this.editableDocument(),
			media: () => this.media,
			execute: (cmd) => {
				if (!this.editableDocument()) return false;
				this.commitText();
				this.clearSelection();
				const ok = this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
				return ok;
			},
			currentPageIndex: () => this.currentPageIndex(),
			scrollTo: (index, y) => this.scrollToPage(index, y),
			selection: () => {
				const sel = this.selection;
				return sel ? { pageIndex: sel.pageIndex, elements: sel.elements, bounds: sel.bounds, matrix: sel.matrix } : null;
			},
			select: (pageIndex, elements) => this.selectItems(pageIndex, [], elements),
			preview: (pageIndex, rect) => this.renderer?.setLasso(rect
				? { pageIndex, points: [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height], [rect.x, rect.y]] }
				: null),
			previewFree: () => this.lasso === null && (this.markers?.gesturePage ?? null) === null,
			scale: () => this.viewport.scale,
			gotoContext: () => this.gotoContext(),
			disarmOthers: () => this.markers?.disarm(),
			pageAtClient: (clientX, clientY) => {
				const layout = this.layout;
				if (!layout) return null;
				const r = this.stage.getBoundingClientRect();
				const [dx, dy] = screenToPage(this.viewport, clientX - r.left, clientY - r.top);
				const pageIndex = pageAt(layout, dx, dy, 0);
				return pageIndex < 0 ? null : { pageIndex, local: toPageLocal(layout.boxes[pageIndex]!, dx, dy) };
			},
		});
		// The jump back edits nothing: it also works while the notebook cannot be edited.
		this.excerpts.attachReadOnlyTaps(this.stage);
	}

	/** 0.16: the page and the page point under a position of the window, or null (between pages, nothing laid out). */
	private pageUnderClient(clientX: number, clientY: number): { pageIndex: number; local: [number, number] } | null {
		const layout = this.layout;
		if (!layout) return null;
		const r = this.stage.getBoundingClientRect();
		const [dx, dy] = screenToPage(this.viewport, clientX - r.left, clientY - r.top);
		const pageIndex = pageAt(layout, dx, dy, 0);
		return pageIndex < 0 ? null : { pageIndex, local: toPageLocal(layout.boxes[pageIndex]!, dx, dy) };
	}

	/** 0.16 (#45): a contact began in the Select text mode. */
	private pdfTextStart(sample: InkSample): boolean {
		const layout = this.layout;
		const text = this.pdfText;
		if (!layout || !text) return true;
		const [dx, dy] = this.toDoc(sample);
		const pageIndex = Number.isFinite(dx) && Number.isFinite(dy) ? pageAt(layout, dx, dy, PAGE_TOLERANCE) : -1;
		const box = pageIndex >= 0 ? layout.boxes[pageIndex] : undefined;
		return text.begin(pageIndex, box ? toPageLocal(box, dx, dy) : null, sample);
	}

	/** 0.16: the Select text mode (#45), the links of PDF pages and the PDF outline (#46). */
	private mountPdfText(): void {
		const pdf = () => {
			const media = this.media;
			if (!media) throw new Error("no media");
			return media.pdf;
		};
		this.pdfOutline = new PdfOutlineSource({
			storage: this.app,
			read: (asset) => pdf().outline(asset),
			changed: () => this.pageNav?.refresh(),
		});
		const links = new PdfLinks({
			app: this.app,
			stage: this.stage,
			enabled: () => this.host.settings.pdfLinks && !this.presentation?.isOpen,
			doc: () => this.shownDoc(),
			layout: () => this.layout,
			pageLinks: (asset, page) => pdf().pageLinks(asset, page),
			pageAtClient: (x, y) => this.pageUnderClient(x, y),
			fingerWrites: () => this.policy.settings.fingerDrawing,
			readOnly: () => !this.editable(),
			selecting: () => this.pdfText?.active === true,
			scale: () => this.viewport.scale,
			goTo: (index) => this.goToPage(index),
		});
		this.pdfLinks = links;
		this.pdfText = new PdfTextTools({
			stage: this.stage,
			body: this.body,
			doc: () => this.shownDoc(),
			layout: () => this.layout,
			viewport: () => this.viewport,
			viewSize: () => this.viewSize,
			visibleRect: () => this.visibleRect(),
			pageText: (asset, page) => pdf().pageText(asset, page),
			links,
			quoteLink: (pageIndex) => {
				const page = this.shownDoc()?.pages[pageIndex];
				return this.file && page ? pageLinkText(this.app, this.file, pageIndex + 1, "link", page.id) : "";
			},
			pdfName: (asset) => this.shownDoc()?.assets?.[asset]?.name ?? "",
			modeChanged: (on) => {
				if (on) {
					// Whatever was being written is finished first; a selection of ink or a pending placement would be in the way.
					this.controller?.finishActiveStroke();
					this.commitText();
					this.clearSelection();
					this.markers?.disarm();
					this.excerpts?.disarm();
					this.radial?.close();
					this.penLinks?.hideChip();
				}
				this.applyInput();
				this.refreshUi();
			},
			isNarrow: () => this.body.hasClass("is-narrow"),
		});
		// Ctrl/Cmd+C copies the selected PDF text.
		this.registerDomEvent(document, "copy", (e) => {
			if (!this.pdfText?.hasSelection || this.app.workspace.getActiveViewOfType(NotebookView) !== this) return;
			const target = e.target instanceof HTMLElement ? e.target : null;
			if (target?.closest("input, textarea, [contenteditable='true'], .modal")) return;
			const text = this.pdfText.copyText();
			if (text === null) return;
			e.clipboardData?.setData("text/plain", text);
			e.preventDefault();
		});
	}

	private mountMarkers(): void {
		this.markers = new MarkerTools({
			app: this.app,
			armed: () => this.excerpts?.disarm(),
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable(),
			execute: (cmd) => {
				this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
			},
			currentPageIndex: () => this.currentPageIndex(),
			scrollTo: (index, y) => {
				this.recordJump(index);
				this.scrollToPage(index, y);
			},
			referenceSlide: () => referenceSlideOf(this),
			preview: (pageIndex, rect) => this.renderer?.setLasso(rect
				? { pageIndex, points: [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height], [rect.x, rect.y]] }
				: null),
			repaint: () => this.renderer?.invalidate(),
			scale: () => this.viewport.scale,
		});
		this.renderer?.setHiddenInk((page) => this.markers?.isRevealed(page) ?? false);
		this.renderer?.setBoxLabel(translatedBoxLabel);
	}

	private pageCommand(cmd: Command, scrollTo: number, page: Page): void {
		// The menu may have stayed open while the file was reloaded (read-only, broken, or another document).
		if (this.controller?.drawing || !this.editable() || !this.session?.doc?.pages.includes(page)) return;
		this.commitText();
		this.clearSelection();
		this.history.execute(cmd);
		this.afterHistoryChange();
		this.scrollToPage(scrollTo);
	}

	private movePage(from: number, to: number): void {
		const page = this.session?.doc?.pages[from];
		if (page && to >= 0 && to < (this.session?.doc?.pages.length ?? 0)) this.pageCommand(new MovePage(page.id, from, to), to, page);
	}

	private toggleBookmarkOf(pageId: string): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable() || this.controller?.drawing || !doc.pages.some((p) => p.id === pageId)) return;
		const before = doc.meta ?? cloneMeta(DEFAULT_META);
		this.history.execute(new SetMeta(before, toggleBookmark(before, pageId)));
		this.afterHistoryChange();
	}

	/** wave 0.6 (v7): what the outline, the bookmark editor and the page tags editor need (outline.ts). */
	outlineHost(): OutlineHost {
		return {
			app: this.app,
			pages: () => this.session?.doc?.pages ?? [],
			meta: () => this.session?.doc?.meta,
			canEdit: () => this.editableDocument() !== null,
			execute: (cmd) => void this.applyCommand(cmd),
			goTo: (index) => this.goToPage(index),
			goToAt: (index, y) => this.goToPageAt(index, y),
			assets: () => this.session?.doc?.assets,
			outline: () => this.outlineBuilder,
			sources: () => ({
				bookmarks: this.host.settings.outlineBookmarks, slides: this.host.settings.outlineSlides,
				headings: this.host.settings.outlineHeadings, markers: this.host.settings.outlineMarkers, pdf: this.host.settings.outlinePdf === "merged",
			}),
			pdfOutlineMode: () => this.host.settings.outlinePdf,
			// 0.16 (#46): the outlines already known; the others are read in the background and the panel refreshed.
			pdfOutlines: () => {
				const assets = this.session?.doc?.assets;
				if (!assets || this.host.settings.outlinePdf === "off") return {};
				return this.pdfOutline?.known(Object.values(assets).filter((a) => a.kind === "pdf").map((a) => a.id)) ?? {};
			},
			headingImage: (item) => {
				const page = this.session?.doc?.pages.find((p) => p.id === item.pageId);
				return page ? this.headingThumbs.url(page, item) : null;
			},
		};
	}

	deleteSelection(): void {
		const sel = this.selection;
		const page = sel && this.session?.doc?.pages[sel.pageIndex];
		if (!sel || !page || !this.editable() || this.statesTools?.ownsSelection(sel)) return;
		if (sel.others?.length) {
			this.deleteAcrossPages(sel);
			return;
		}
		// 0.17 (#20): deleting a collapsed sticky note deletes the ink it keeps hidden (the same undo step), so none comes back alone.
		const { commands, removed: removedEls } = deleteSelectionCommands(page, sel.strokes, sel.elements);
		// Ink written on a deleted object stays unless the user takes the offer shown afterwards (setting "Ink follows objects").
		// v8: hidden ink is never offered (nor counted) while the solutions of the page are not shown.
		const owned = this.host.settings.inkFollowsObjects && removedEls.length > 0
			? inkOnRemoved(this.inkInView(page), page.elements ?? [], removedEls, new Set(sel.strokes), measureText)
			: [];
		this.clearSelection();
		if (commands.length === 0) return;
		this.history.execute(new Batch("Delete selection", commands));
		this.afterHistoryChange();
		if (owned.length > 0) this.offerDeleteInk([{ page, removed: removedEls, owned }]);
	}

	/**
	 * wave 0.10 (356): inserts the date and time as a text box where the pen last touched (or in the middle of the page in
	 * view), in the format of the setting; one undo step, and the box is selected so it can be nudged.
	 */
	insertDateStamp(): void {
		const doc = this.editableDocument();
		if (!doc) return;
		this.commitText();
		const pen = this.lastPen;
		const penIndex = pen ? doc.pages.findIndex((p) => p.id === pen.pageId) : -1;
		const spot = stampSpot(pen && penIndex >= 0 ? { pageIndex: penIndex, x: pen.x, y: pen.y, at: pen.at } : null, Date.now(), doc.pages, this.currentPageIndex());
		const page = spot ? doc.pages[spot.pageIndex] : undefined;
		if (!spot || !page) return;
		const text = formatStamp(new Date(), cleanStampFormat(this.host.settings.dateStampFormat), getLanguage());
		const el = stampElement(text, page, spot.x, spot.y, this.tools.textSize, this.tools.penColor, measureText);
		this.history.execute(new AddElement(page.id, el, page.elements?.length ?? 0));
		this.afterHistoryChange();
		this.renderer?.invalidate();
		this.selectItems(spot.pageIndex, [], [el]);
	}

	/**
	 * 0.21 (154): "Sign and date" opens the dialog with the saved signature; its Place puts the signature (and today's date
	 * under it) where the pen last touched, or in the middle of the page in view, as one undo step. The result is selected so it
	 * can be moved at once.
	 */
	openSignDialog(): void {
		if (!this.editableDocument()) return;
		this.commitText();
		new SignDialog(this.app, {
			app: this.app,
			folder: () => this.host.settings.folder,
			dateText: () => this.signDateNow(),
			place: (signature, withDate) => this.placeSignature(signature, withDate),
		}).open();
	}

	private signDateNow(): string {
		return signDateText(new Date(), this.host.settings.signDateMode, this.host.settings.signDateCustom, getLanguage());
	}

	private placeSignature(signature: ClipContent | null, withDate: boolean): void {
		const doc = this.editableDocument();
		if (!doc) return;
		const pen = this.lastPen;
		const penIndex = pen ? doc.pages.findIndex((p) => p.id === pen.pageId) : -1;
		const spot = stampSpot(pen && penIndex >= 0 ? { pageIndex: penIndex, x: pen.x, y: pen.y, at: pen.at } : null, Date.now(), doc.pages, this.currentPageIndex());
		const page = spot ? doc.pages[spot.pageIndex] : undefined;
		if (!spot || !page) return;
		const plan = planSignature(signature, doc, page, [spot.x, spot.y], {
			dateText: withDate ? this.signDateNow() : null, fontSize: this.tools.textSize, color: this.tools.penColor, measure: measureText,
		});
		if (!plan) return;
		// History refuses the step on a locked page (and says why).
		if (page.locked) {
			this.pagesLocked([page.id]);
			return;
		}
		this.history.execute(plan.command);
		this.afterHistoryChange();
		this.renderer?.invalidate();
		this.selectItems(spot.pageIndex, plan.strokes, plan.elements);
	}

	/**
	 * wave 0.10 (359): deletes a selection that spans several pages, one undo step. Like on a single page, the ink written
	 * on (or bound to) a deleted object stays unless the user takes the offer shown afterwards (setting "Ink follows objects").
	 */
	private deleteAcrossPages(sel: Selection): void {
		const doc = this.session?.doc;
		if (!doc) return;
		const commands: Command[] = [];
		const offers: Array<{ page: Page; removed: PageElement[]; owned: Stroke[] }> = [];
		for (const part of this.selectionParts(sel)) {
			const page = doc.pages[part.pageIndex];
			if (!page) continue;
			const planned = deleteSelectionCommands(page, part.strokes, part.elements);
			commands.push(...planned.commands);
			const removedEls = planned.removed;
			if (this.host.settings.inkFollowsObjects && removedEls.length > 0) {
				// v8: hidden ink is never offered (nor counted) while the solutions of the page are not shown.
				const visible = new Set(this.inkInView(page));
				const own = new Set(part.strokes);
				const owned = inkFollowers(page, part, true, measureText).map((f) => f.stroke).filter((s) => visible.has(s) && !own.has(s));
				if (owned.length > 0) offers.push({ page, removed: removedEls, owned });
			}
		}
		this.clearSelection();
		if (commands.length === 0) return;
		if (!this.history.execute(new Batch("Delete selection", commands))) return;
		this.afterHistoryChange();
		if (offers.length > 0) this.offerDeleteInk(offers);
	}

	/** The selected items page by page: the primary page first, then the other pages of a cross-page selection. */
	private selectionParts(sel: Selection): PagePart[] {
		return [{ pageIndex: sel.pageIndex, strokes: sel.strokes, elements: sel.elements }, ...(sel.others ?? [])];
	}

	// --- insert: PDF, image page, image element ---

	/** Stores a file chosen by the user as an asset (the same file twice is stored once) and makes it readable. */
	private async pickAndStore(kind: "pdf" | "image"): Promise<{ asset: Asset; bytes: ArrayBuffer } | null> {
		const file = await pickFile(this.app, kind);
		if (!file) return null;
		// Refuse HEIF/HEIC before storing it: the WebView cannot show it on a page anyway.
		if (kind === "image" && isHeic(file.bytes)) throw new PhotoDecodeError("heic");
		const asset = await storeAsset(this.app, this.host.settings.folder, file.bytes, file.name, kind);
		this.media?.addPending(asset);
		return { asset, bytes: file.bytes };
	}

	/** `pickAndStore` for a file that is already in hand (dropped on the page): same HEIC refusal, same asset store. */
	private async storeSource(kind: "pdf" | "image", file: { name: string; bytes: ArrayBuffer }): Promise<{ asset: Asset; bytes: ArrayBuffer }> {
		if (kind === "image" && isHeic(file.bytes)) throw new PhotoDecodeError("heic");
		const asset = await storeAsset(this.app, this.host.settings.folder, file.bytes, file.name, kind);
		this.media?.addPending(asset);
		return { asset, bytes: file.bytes };
	}

	/** Any pointer contact or gesture in progress on the canvas. */
	private inContact(): boolean {
		return this.active !== null || this.erasing !== null || this.lasso !== null || this.drag !== null || this.shapeDrag !== null
			|| this.spaceDrag !== null || this.lassoTap !== null || this.textTap !== null || this.controller?.navigating === true
			|| this.gestures?.touching === true || this.rulerGesture?.dragging === true || this.penGestures?.active === true;
	}

	private stillHere(session: DocumentSession | null): boolean {
		return !!session && this.session === session && this.editable() && !this.controller?.drawing;
	}

	/** Page menu: inserts a whole PDF or a page range after the page at `index` (one undo step). `source`: a PDF already in hand (a file dropped on the page) instead of the picker. Resolves with the number of pages inserted. */
	async insertPdfAfter(index: number, source?: { name: string; bytes: ArrayBuffer }): Promise<number> {
		const session = this.session;
		const media = this.media;
		const anchor = session?.doc?.pages[index];
		if (!session || !media || !anchor || !this.stillHere(session)) return 0;
		let asset: Asset | null = null;
		let working: NoticeHandle | null = null;
		try {
			const picked = source ? await this.storeSource("pdf", source) : await this.pickAndStore("pdf");
			if (!picked) return 0;
			asset = picked.asset;
			working = showNotice(t("insert.working"), 0);
			const sizes = await media.pdf.pageSizes(asset.id);
			working.hide();
			working = null;
			if (sizes.length === 0) throw new Error("the PDF has no pages");
			const range = sizes.length === 1 ? { from: 1, to: 1 } : await askPdfRange(this.app, sizes.length);
			if (!range || !this.stillHere(session)) return 0;
			// Lecture pack layout (#192, #193): on the slide, slide + notes area, notes page after every slide.
			const layout = await askLayoutOptions(this.app);
			if (!layout || !this.stillHere(session)) return 0;
			const doc = session.doc;
			const at = doc ? doc.pages.indexOf(anchor) : -1;
			if (!doc || at < 0) return 0;
			const pages = buildLecturePackPages(asset, sizes.slice(range.from - 1, range.to), range.from, layout);
			this.commitText();
			this.clearSelection();
			const done = this.history.execute(new Batch("Insert PDF", [new AddAsset(asset), new InsertPages(pages, at + 1)]));
			this.afterHistoryChange();
			this.scrollToPage(at + 1);
			showNotice(t("insert.pdfDone", { n: String(range.to - range.from + 1) }));
			return done ? pages.length : 0;
		} catch (e) {
			console.error("[notebook] insert PDF", e);
			showNotice(t("insert.failed", { error: (e as Error).message }), 8000);
			return 0;
		} finally {
			working?.hide();
			if (asset) media.removePending(asset.id);
		}
	}

	/** Page menu: a new page after `index` whose background is an image (A4 portrait or landscape by the image's aspect). */
	async insertImagePageAfter(index: number): Promise<void> {
		const session = this.session;
		const media = this.media;
		const anchor = session?.doc?.pages[index];
		if (!session || !media || !anchor || !this.stillHere(session)) return;
		let asset: Asset | null = null;
		try {
			const picked = await this.pickAndStore("image");
			if (!picked) return;
			asset = picked.asset;
			const dims = await photoSize(picked.bytes, "");
			if (!this.stillHere(session)) return;
			const doc = session.doc;
			const at = doc ? doc.pages.indexOf(anchor) : -1;
			if (!doc || at < 0) return;
			const page = createPage(imagePageSize(dims.width, dims.height), { kind: "blank", spacing: PAPER_SPACING.blank });
			page.background = { kind: "image", asset: asset.id };
			this.commitText();
			this.clearSelection();
			this.history.execute(new Batch("Insert image page", [new AddAsset(asset), new InsertPages([page], at + 1)]));
			this.afterHistoryChange();
			this.scrollToPage(at + 1);
		} catch (e) {
			console.error("[notebook] insert image page", e);
			showNotice(insertFailure(e), 8000);
		} finally {
			if (asset) media.removePending(asset.id);
		}
	}

	// --- wave p1b: reliability (repair, conflicted copies, page restore; see integration/reliability.ts) ---

	/** Page trash and templates (wave 0.6, see page-tools.ts). */
	/** wave 0.8 (378): what the navigator's multi-selection actions need (view/page-ops-menu.ts). */
	private pageOpsHost(): PageOpsHost {
		const base = this.pageToolsHost();
		const file = () => this.file;
		return {
			get app() { return base.app; },
			get settings() { return base.settings; },
			get file() { return file(); },
			editableDocument: () => base.editableDocument(),
			applyCommand: (cmd, scrollTo) => base.applyCommand(cmd, scrollTo),
			flush: () => base.flush(),
			moveToNotebook: async (ids) => {
				const ctx = this.editContext();
				const doc = this.session?.doc;
				if (!ctx || !doc) return;
				const indices = ids.map((id) => doc.pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
				if (indices.length > 0) await runMovePages(ctx, this.host.settings, indices);
			},
			exportPages: async (pages, suffix) => {
				if (this.file) await exportPdf(this.app, this.file, pages, suffix, this.media);
			},
		};
	}

	pageToolsHost(): PageToolsHost {
		const host = this.host;
		return {
			app: this.app,
			get settings() { return host.settings; },
			editableDocument: () => this.editableDocument(),
			applyCommand: (cmd, scrollTo) => this.applyCommand(cmd, scrollTo),
			flush: async () => (await this.flushNow()) && (this.session?.isSaved() ?? false),
		};
	}

	/** wave 0.7: resilience: what the safe-mode, storage and integrity banners need from the view. */
	private resilienceHost(): ResilienceViewHost {
		return {
			app: this.app,
			settings: () => this.host.settings,
			journal: this.host.journal,
			file: () => this.file,
			bannerHost: this.bannerHost,
			attachMedia: () => {
				if (this.media) this.renderer?.setMedia(this.media);
			},
			modeChanged: () => {
				this.applySettings(this.host.settings);
				this.pageNav?.invalidate();
			},
			reopen: async () => {
				const leaf = this.leaf;
				const state = leaf.getViewState();
				await leaf.setViewState({ type: "empty" });
				await leaf.setViewState(state);
			},
			flush: () => this.flushNow(),
			editableDocument: () => this.editableDocument(),
			applyCommand: (cmd) => this.applyCommand(cmd),
		};
	}

	reliabilityDeps(): ReliabilityDeps {
		return { app: this.app, settings: this.host.settings, journal: this.host.journal };
	}

	/** The loaded document when it can be edited (not read-only, broken or being drawn on), else null. */
	editableDocument(): NotebookDocument | null {
		return this.editable() && !this.controller?.drawing ? (this.session?.doc ?? null) : null;
	}

	/** Runs a command built outside the view (merge, page restore) as one undo step. */
	applyCommand(cmd: Command, scrollTo?: number): boolean {
		if (!this.editableDocument()) return false;
		this.commitText();
		this.clearSelection();
		// False when the history refused it (a locked page, or a change the writer would reject): the callers say so.
		const done = this.history.execute(cmd);
		this.afterHistoryChange();
		if (done && scrollTo !== undefined) this.scrollToPage(scrollTo);
		return done;
	}

	// --- page lock (0.16, #124; the guard itself is in model/history.ts + model/page-lock.ts) ---

	/** The last time the "Page locked" notice was shown (it lasts 5 s: one at a time). */
	private lockNoticeAt = 0;
	private lockBadge: HTMLButtonElement | null = null;
	private dropFilesOff: (() => void) | null = null;
	private mentions: Mentions | null = null;

	/** Locks or unlocks a page of this document (one undo step). False when it could not be done. */
	setPageLocked(page: Page, value: boolean): boolean {
		if (!this.editableDocument()) {
			showNotice(t("lock.readOnly"));
			return false;
		}
		if ((page.locked === true) === value) return true;
		const done = this.applyCommand(new SetPageLocked(page.id, value));
		if (done && !value) showNotice(t("lock.unlocked"), 2500);
		return done;
	}

	/** A locked page refused an edit (the history's guard, or a gate before one): says so once, with a button that unlocks the page. */
	private pagesLocked(pageIds: readonly string[]): void {
		const now = Date.now();
		if (now - this.lockNoticeAt < 5000) return;
		this.lockNoticeAt = now;
		const id = pageIds[0];
		let handle: NoticeHandle | null = null;
		const fragment = createFragment((f) => {
			f.createSpan({ text: t("lock.toast") });
			f.createSpan({ text: " · " });
			f.createEl("button", { text: t("lock.toast.unlock"), cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", (e) => {
				e.preventDefault();
				handle?.hide();
				this.lockNoticeAt = 0;
				const page = this.session?.doc?.pages.find((p) => p.id === id);
				if (page) this.setPageLocked(page, false);
			});
		});
		handle = showErrorNotice(fragment, 5000);
	}

	/** The lock badge over the page area follows the page in view; a tap unlocks it. */
	private syncLockBadge(locked: boolean): void {
		const badge = this.lockBadge;
		if (!badge) return;
		badge.toggleClass("is-visible", locked);
		badge.disabled = !locked || !this.editable();
	}

	/** Whether any page of the selection is locked (a locked page can be selected to copy from, not to change). */
	private lockedSelectionPage(sel: Selection): Page | null {
		const doc = this.session?.doc;
		if (!doc) return null;
		for (const part of this.selectionParts(sel)) {
			const page = doc.pages[part.pageIndex];
			if (page?.locked) return page;
		}
		return null;
	}

	/** wave 0.7 (366): what "Go to page number" needs. */
	gotoContext(): { total: number; current: number; bookmarks: Array<{ index: number; title: string }> } {
		const doc = this.session?.doc;
		return { total: doc?.pages.length ?? 0, current: this.currentPageIndex(), bookmarks: doc ? extractBookmarks(doc).map((b) => ({ index: b.page, title: b.title })) : [] };
	}

	/** wave 0.7 (366): scrolls to the page (0-based). */
	jumpToPage(index: number): void {
		const n = this.session?.doc?.pages.length ?? 0;
		if (n > 0) this.goToPage(Math.min(n - 1, Math.max(0, index)));
	}

	/** Index of the page in view (for commands). */
	currentPage(): number {
		return this.currentPageIndex();
	}

	// --- 0.18 (#227): quick tabs (view/quick-tabs.ts, view/quick-tabs-service.ts; the pins are in _meta, never in the notebook) ---

	/** What the quick tabs service reads from this view. */
	quickApi(): QuickTabsViewApi {
		return {
			docId: () => this.session?.doc?.id ?? null,
			path: () => this.file?.path ?? null,
			pageIds: () => (this.shownDoc()?.pages ?? []).map((p) => p.id),
			place: () => this.navPlace(),
			current: () => {
				const doc = this.shownDoc();
				const index = this.currentPageIndex();
				const page = doc?.pages[index];
				return doc && page ? { pageId: page.id, index, title: doc.meta?.bookmarkInfo?.[page.id]?.title ?? "" } : null;
			},
			jump: (index) => this.goToPage(index),
			show: (place) => this.showPlace(place),
		};
	}

	/** Pins the page in view as a quick tab, or unpins it (the page sheet, the command and a long press on the page number). */
	togglePageQuickTab(): void {
		void this.host.quickTabs?.togglePin(this.quickApi());
	}

	/** "Pin a page from another notebook…" */
	pinQuickTabFromOther(): void {
		this.host.quickTabs?.pinFromOther(this.quickApi());
	}

	private mountQuickTabs(): void {
		const service = this.host.quickTabs;
		if (!service) return;
		const KEY = "notebook-quicktabs-collapsed";
		const api = this.quickApi();
		const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
		const strip = new QuickTabsStrip({
			tabs: () => service.tabs(this.session?.doc?.id ?? null),
			view: () => {
				const pageIds = api.pageIds();
				return { path: this.file?.path ?? null, pageIds, currentPageId: pageIds[this.currentPageIndex()] ?? null };
			},
			back: () => {
				const place = service.back();
				if (!place) return null;
				const page = t("quicktabs.page", { n: String(place.page) });
				return { label: place.path === this.file?.path ? page : `${name(place.path)} ${page}` };
			},
			notebookName: name,
			open: (tab) => void service.open(api, tab),
			goBack: () => void service.goBack(api),
			unpin: (id) => service.unpin(id),
			move: (id, to) => {
				const scope = this.session?.doc?.id;
				if (scope) service.move(scope, id, to);
			},
			collapsed: () => {
				try {
					return this.app.loadLocalStorage(KEY) === "1";
				} catch {
					return false;
				}
			},
			setCollapsed: (value) => {
				try {
					this.app.saveLocalStorage(KEY, value ? "1" : null);
				} catch {
					/* a per-device convenience: it simply is not remembered */
				}
			},
		});
		this.quickStrip = strip;
		this.contentEl.insertBefore(strip.el, this.body);
		this.stopQuick = service.onChange(() => strip.refresh());
	}

	/** On a short landscape view the strip is a column beside the page; otherwise a row above it. */
	private placeQuickTabs(side: boolean): void {
		const strip = this.quickStrip;
		if (!strip || strip.isSide === side) return;
		if (side) this.body.insertBefore(strip.el, this.stage);
		else this.contentEl.insertBefore(strip.el, this.body);
		strip.setSide(side);
	}

	// --- roadmap 18: back/forward history of visited pages (model/nav-history.ts, view/nav-controller.ts) ---

	/** Page `index` (0-based) of this notebook as a place of the history, or null without a document. */
	private placeAt(index: number): NavPlace | null {
		const page = this.shownDoc()?.pages[index];
		return page && this.file ? { path: this.file.path, pageId: page.id, page: index + 1 } : null;
	}

	/** The page in view as a place of the history. */
	navPlace(): NavPlace | null {
		return this.layout ? this.placeAt(this.currentPageIndex()) : null;
	}

	/** Records a deliberate jump from the page in view to page `index` (links, the page panel, Go to, search, the scrollbar). */
	private recordJump(index: number): void {
		const to = this.placeAt(index);
		if (to) this.host.nav?.arrive(this.navPlace(), to);
	}

	/** A page was asked for by a link or a command from outside (the view is already loaded, or has just loaded). */
	private recordArrival(index: number): void {
		const to = this.placeAt(index);
		if (!to) return;
		const from = this.arrivalFresh ? null : this.navPlace();
		this.arrivalFresh = false;
		this.host.nav?.arrive(from, to);
	}

	/** Back/Forward: shows a place of this notebook without recording a jump. False when its page is gone. */
	showPlace(place: NavPlace): boolean {
		const pages = this.shownDoc()?.pages;
		if (!pages || !this.layout) return false;
		const index = pages.findIndex((p) => p.id === place.pageId);
		if (index < 0) return false;
		this.scrollToPage(index);
		return true;
	}

	/** Back and Forward through the visited pages. */
	navigate(dir: -1 | 1): void {
		void this.host.nav?.go(dir);
	}

	/** Back and Forward are possible (for the buttons). */
	navState(): { back: boolean; forward: boolean } {
		return { back: this.host.nav?.canBack ?? false, forward: this.host.nav?.canForward ?? false };
	}

	/** Opens the page panel (the status bar item). */
	openNavigator(): void {
		this.setNavigatorOpen(true);
	}

	/** 0.17 (#173): what the minimap reads from the page in view and how it moves the view. Nothing here writes the document. */
	private minimapHost(): MinimapHost {
		const KEY = "notebook-minimap";
		return {
			state: () => {
				const layout = this.layout, doc = this.shownDoc();
				if (!layout || !doc || this.viewSize.width <= 0) return null;
				const index = this.currentPageIndex();
				const page = doc.pages[index], box = layout.boxes[index];
				if (!page || !box) return null;
				return { pageId: page.id, page: { width: page.width, height: page.height, infinite: page.infinite === true }, box, viewport: this.viewport, view: this.viewSize };
			},
			mode: () => this.host.settings.minimapMode,
			busy: () => !!this.controller?.drawing || this.active !== null || this.erasing !== null || this.drag !== null || this.shapeDrag !== null,
			panTo: (v) => this.setViewport(v, true),
			render: (pageId, width) => {
				const page = this.shownDoc()?.pages.find((p) => p.id === pageId);
				if (!page || this.resilience?.thumbnailsAllowed() === false) return "";
				return renderThumbnail(this.statesTools?.viewPages([page])[0] ?? page, width, {
					mime: "image/jpeg",
					quality: 0.7,
					region: { x: 0, y: 0, width: page.width, height: page.height },
					drawBackground: (ctx, p) => this.drawThumbMedia(ctx, p),
				});
			},
			loadPrefs: () => this.app.loadLocalStorage(KEY) as unknown,
			savePrefs: (prefs) => this.app.saveLocalStorage(KEY, prefs),
		};
	}

	private scrollbarHost(): ScrollbarHost {
		const pageAtIndex = (i: number): Page | null => this.shownDoc()?.pages[i] ?? null;
		return {
			state: () => (this.layout && !this.pageMode?.enabled && this.viewSize.width > 0 ? { layout: this.layout, viewport: this.viewport, view: this.viewSize } : null),
			enabled: () => this.host.settings.fastScrollbar,
			busy: () => !!this.controller?.drawing || this.active !== null || this.erasing !== null || this.drag !== null || this.shapeDrag !== null,
			scrollTo: (offsetY) => this.setViewport({ ...this.viewport, offsetY }, true),
			pageRatio: (i) => {
				const p = pageAtIndex(i);
				return p && p.width > 0 ? p.height / p.width : 1.41;
			},
			cachedThumbnail: (i) => {
				const p = pageAtIndex(i);
				return p ? this.pageNav?.cachedThumbnail(p) ?? null : null;
			},
			drawThumbnail: (i) => {
				const p = pageAtIndex(i);
				return p && this.pageNav ? this.pageNav.thumbnailOf(p) : null;
			},
			dragged: (from, to) => {
				const a = this.placeAt(from), b = this.placeAt(to);
				if (a && b) this.host.nav?.arrive(a, b);
			},
		};
	}

	/** What the PDF reading tools (search, snapping highlighter, hide annotations, dimming) need from this view. */
	private readingHost(): ReadingHost {
		const save = (): void => void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
		return {
			stage: this.stage,
			body: this.body,
			toolbar: this.toolbar,
			settings: () => this.host.settings,
			save,
			doc: () => this.session?.doc ?? null,
			pageText: (asset, page) => {
				const media = this.media;
				return media ? media.pdf.pageText(asset, page) : Promise.reject(new Error("no media"));
			},
			viewport: () => this.viewport,
			viewSize: () => this.viewSize,
			layout: () => this.layout,
			visibleRect: () => this.visibleRect(),
			currentPage: () => this.currentPageIndex(),
			setViewport: (v) => this.setViewport(v),
			renderer: () => this.renderer,
			isNarrow: () => this.body.hasClass("is-narrow"),
			beforeHide: () => {
				this.controller?.finishActiveStroke();
				this.commitText();
				this.clearSelection();
				this.radial?.close();
			},
			prefetchAllowed: () => this.resilience?.prefetchAllowed() !== false,
			editingChanged: () => {
				this.applyInput();
				this.toolbar.setEditable(this.editable());
				this.symbols?.sync();
				this.updateHistoryButtons();
				this.refreshUi();
			},
		};
	}

	// --- ui redesign: the bridge to the action registry (view-actions.ts, view-ui.ts) ---

	/** Runs an action of the registry (toolbar, contextual bar, sheets, radial menu, commands) and counts the use. */
	runAction(id: string, arg: ActionArg = {}): void {
		if (actionById(id)?.scope === "global") {
			// A plugin-level action shown in a sheet (recent pages, sync check…).
			if (!this.host.runGlobal) return;
			this.host.runGlobal(id);
		} else if (!runViewAction(this, id, arg)) return;
		this.ui?.record(id);
		this.refreshUi();
	}

	// --- 0.20 (#107): the floating reference window ---

	/** Shows `file` (a notebook page, a PDF, a picture or a note) in the floating reference window. */
	openReference(file: TFile, request: Pick<ReferenceRequest, "page" | "pageId"> = { page: null, pageId: null }): Promise<void> {
		return this.refWindow?.open(file, request) ?? Promise.resolve();
	}

	/** Shows page `index` of this notebook in the reference window. */
	openPageAsReference(index: number): void {
		const file = this.file, page = this.shownDoc()?.pages[index];
		if (file && page) void this.openReference(file, { page: index + 1, pageId: page.id });
	}

	closeReference(): void {
		this.refWindow?.close();
	}

	get referenceOpen(): boolean {
		return this.refWindow?.isOpen === true;
	}

	/** Whether a command of the registry applies now (the palette hides it otherwise). */
	commandApplies(id: string): boolean {
		return commandApplies(this, id);
	}

	/** Recomputes the self-building UI (quick slots, contextual bar, open sheet) and the selection's restyle rows. */
	refreshUi(): void {
		this.selectionActions?.update();
		this.ui?.refresh();
		this.statesTools?.refresh();
		this.quickStrip?.refresh();
	}

	/** What the UI needs to know, for the page in view or page `pageIndex` (page sheet of a thumbnail). */
	uiContext(pageIndex?: number): UiContext {
		const doc = this.session?.doc ?? null;
		const pages = doc?.pages ?? [];
		const index = pageIndex ?? this.currentPageIndex();
		const page = pages[index];
		const sel = this.selection;
		return {
			editable: !!doc && this.editable() && !this.controller?.drawing,
			open: !!doc,
			tool: this.tools.tool,
			selection: sel && !this.statesTools?.ownsSelection(sel) ? this.selectionCounts(sel) : null,
			page: page ? {
				index, count: pages.length, background: page.background?.kind ?? "none", infinite: !!page.infinite, locked: page.locked === true,
				lockedElements: lockedElementsOf(page).length,
				bookmarked: doc?.meta?.bookmarks.includes(page.id) ?? false, splittable: page.id === this.heavyPageId,
				...(this.host.quickTabs ? { quickTab: this.host.quickTabs.isPinnedAt(this.quickApi(), index) } : {}),
				kind: pageKindOf({ background: page.background?.kind ?? "none", paper: page.paper.kind, width: page.width, height: page.height }),
			} : null,
			notebook: { pdfPages: hasPdfPages(pages), backgrounds: hasBackgrounds(pages) },
			lecture: this.lectureMode?.on ?? false,
			sidePane: pdfSideState(this),
			reading: { annotationsHidden: this.reading?.annotationsHidden ?? false, dim: this.reading?.dimmed ?? false, snap: this.reading?.snapping ?? false, selectText: this.pdfText?.active ?? false },
			display: { night: this.display?.night ?? false, crop: this.display?.crop ?? false },
			states: { open: !!this.statesTools?.open },
			comments: { panel: this.comments?.panelOpen ?? false, total: this.comments?.counts.total ?? 0, open: this.comments?.counts.open ?? 0, drawing: this.comments?.drawing ?? false },
			toggles: { ruler: this.tools.ruler, penOnly: !this.host.settings.fingerDrawing, navigator: !!this.pageNav?.open, pageMode: !!this.pageMode?.enabled, penGestures: this.penGestures?.mode === true, selectRectangle: this.tools.selectMode === "rectangle", readOnly: this.userReadOnly,
				snapAvailable: this.host.settings.snapMode !== "off", snap: !this.snapPaused },
			canPrint: canPrint(),
			markers: {
				invisibleInk: !!this.markers?.invisibleInk, solutions: !!this.markers?.solutionsShown,
				pageSolutions: !!page && (this.markers?.pageSolutionsShown(page) ?? false),
			},
			nav: this.navState(),
			narrow: this.body?.hasClass("is-narrow") ?? false,
			openNotebooks: this.tabs?.count ?? 0,
		};
	}

	/** What the UI knows about the selection (wave 0.10: the items of every page of a selection across pages count). */
	private selectionCounts(sel: Selection): NonNullable<UiContext["selection"]> {
		const parts = this.selectionParts(sel);
		const elements = parts.flatMap((p) => p.elements);
		return {
			strokes: parts.reduce((n, p) => n + p.strokes.length, 0),
			elements: elements.length,
			images: elements.filter((e) => e.type === "image").length,
			texts: elements.filter((e) => e.type === "text").length,
			links: this.penLinks?.linkIn(sel.elements) ? 1 : 0,
			// The maths actions (Edit, Convert to ink) work on the primary page's elements only (see mathTools).
			equations: sel.elements.filter((e) => e.type === "equation").length,
			graphs: sel.elements.filter((e) => e.type === "graph").length,
			// v10: "Go to source" acts on the first excerpt of the primary page's elements.
			excerpts: sel.elements.filter((e) => e.type === "excerpt").length,
			// 0.17 (#20): the sticky note actions (Edit, Collapse, Open) work on the primary page's notes (see stickyTools).
			stickies: sel.elements.filter((e) => e.type === "sticky").length,
			stickiesCollapsed: sel.elements.filter((e) => e.type === "sticky" && e.collapsed === true).length,
			// 0.19 (#103): the checkbox actions (Tick, Label, Send to tasks, Unlink) work on the primary page's checkboxes (see checklistTools).
			checkboxes: sel.elements.filter((e) => e.type === "checkbox").length,
			checkboxesLinked: sel.elements.filter((e) => e.type === "checkbox" && e.task !== undefined).length,
			// 0.20 (#39): Group works within one page (a group never spans pages); Ungroup and Lock work on every page of the selection.
			canGroup: !sel.others?.length && canGroup({ strokes: sel.strokes, elements: sel.elements }),
			grouped: parts.reduce((n, p) => n + p.strokes.filter((s) => s.group !== undefined).length + p.elements.filter((e) => e.group !== undefined).length, 0),
		};
	}

	/** wave 0.10: align, distribute, rotate, mirror, exact size and select similar / by colour or tool (contextual bar, sheet, commands). */
	get arrangeTools(): SelectionArrange | null {
		return this.arrange;
	}

	/** wave 0.10 (63): switches the lasso tool between the freehand outline and the rectangle (turning the lasso on). */
	toggleSelectRectangle(): void {
		if (this.editable()) this.toolbar.update({ tool: "lasso", selectMode: this.tools.selectMode === "rectangle" ? "lasso" : "rectangle" });
	}

	/** The selection's copy, cut, paste, duplicate and white-to-transparent (contextual bar). */
	get selectionTools(): SelectionActions | null {
		return this.selectionActions;
	}

	get stampPalette(): StampPalette | null {
		return this.stamps;
	}

	/** Media of the open notebook (PDF pages, images), for exports. */
	get mediaCache(): NotebookMedia | null {
		return this.media;
	}

	/** Obsidian's "More options" menu of the notebook tab: the notebook-wide actions of the registry. */
	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const c = this.uiContext();
		for (const id of ["export-pdf", "open-library"]) {
			const a = actionById(id);
			if (!a) continue;
			menu.addItem((i) => i.setTitle(actionLabel(a)).setIcon(a.icon).setSection("action").setDisabled(!isEnabled(a, c))
				.onClick(() => (a.scope === "global" ? this.host.runGlobal?.(id) : this.runAction(id))));
		}
		this.addPdfCopyItems(menu);
	}

	/** 0.17 (#23): "Keep a PDF copy" (this notebook's own choice) and, under it, when the copy was last updated. */
	private addPdfCopyItems(menu: Menu): void {
		const copy = this.host.pdfCopy;
		const file = this.file;
		if (!copy || !file || isInTrash(file.path)) return;
		const on = copy.enabled(file.path);
		menu.addItem((i) => i.setTitle(t("pdfCopy.menu")).setIcon("file-check").setSection("action").setChecked(on)
			.onClick(() => void copy.setEnabled(file.path, !on, () => this.pdfCopySource()).catch((e) => console.error("[notebook] PDF copy setting", e))));
		if (on || copy.status(file.path).kind !== "off") menu.addItem((i) => i.setTitle(copy.statusText(file.path)).setIcon("clock").setSection("action").setDisabled(true));
	}

	/** 0.16 (#87): true while the presentation is on (the Select text mode and PDF link taps stay off then). */
	get presenting(): boolean {
		return this.presentation?.isOpen === true;
	}

	/** 0.16 (#45): the Select text mode for the commands; null before the view is open. */
	get pdfTextTools(): PdfTextTools | null {
		return this.pdfText;
	}

	/** The PDF reading tools (search, hide annotations, dimming) for the commands; null before the view is open. */
	get readingTools(): PdfReading | null {
		return this.reading;
	}

	/** Wave p1a: what the PDF actions (margins, re-published slides, annotation export) need; null without a document. */
	pdfActionHost(): PdfActionHost | null {
		const session = this.session;
		const doc = session?.doc;
		const media = this.media;
		const file = this.file;
		if (!session || !doc || !media || !file) return null;
		return {
			app: this.app, file, doc, media, folder: this.host.settings.folder,
			editable: () => this.stillHere(session) && session.doc === doc,
			run: (cmd, scrollTo) => {
				if (!this.stillHere(session) || session.doc !== doc) return false;
				this.commitText();
				this.clearSelection();
				this.history.execute(cmd);
				this.afterHistoryChange();
				if (scrollTo !== undefined) this.scrollToPage(scrollTo);
				return true;
			},
		};
	}

	/** Scans sheets with the camera and inserts them as consecutive pages after `index` (one undo step). */
	async scanPagesAfter(index: number): Promise<void> {
		const session = this.session;
		const media = this.media;
		const anchor = session?.doc?.pages[index];
		if (!session || !media || !anchor || !this.stillHere(session)) return;
		const assets: Asset[] = [];
		try {
			const sheets = await scanFromCamera(this.app);
			if (sheets.length === 0 || !this.stillHere(session)) return;
			const pages: Page[] = [];
			for (const sheet of sheets) {
				const asset = await storeAsset(this.app, this.host.settings.folder, sheet.jpeg, `${sheet.name}.jpg`, "image");
				media.addPending(asset);
				assets.push(asset);
				pages.push(scannedPage(asset, sheet.width, sheet.height));
			}
			const doc = session.doc;
			const at = doc ? doc.pages.indexOf(anchor) : -1;
			if (!doc || at < 0 || !this.stillHere(session)) return;
			this.commitText();
			this.clearSelection();
			this.history.execute(new Batch("Insert scan", [...assets.map((a) => new AddAsset(a)), new InsertPages(pages, at + 1)]));
			this.afterHistoryChange();
			this.scrollToPage(at + 1);
			showNotice(t("scan.pagesDone", { n: String(pages.length) }));
		} catch (e) {
			console.error("[notebook] scan pages", e);
			showNotice(t("scan.failed", { error: (e as Error).message }), 8000);
		} finally {
			for (const a of assets) media.removePending(a.id);
		}
	}

	/** Scans one sheet and places it as an image element on the page at `index`. */
	async insertScanElement(index: number): Promise<void> {
		const session = this.session;
		const media = this.media;
		const anchor = session?.doc?.pages[index];
		if (!session || !media || !anchor || !this.stillHere(session)) return;
		let asset: Asset | null = null;
		try {
			const sheets = await scanFromCamera(this.app);
			const sheet = sheets[0];
			if (!sheet || !this.stillHere(session) || !session.doc?.pages.includes(anchor)) return;
			asset = await storeAsset(this.app, this.host.settings.folder, sheet.jpeg, `${sheet.name}.jpg`, "image");
			media.addPending(asset);
			const size = imageElementSize(sheet.width, sheet.height, anchor.width, anchor.height);
			const [x, y] = centredPosition(anchor.width / 2, anchor.height / 2, size, anchor);
			const element: ImageElement = { id: createId(), type: "image", asset: asset.id, x, y, width: size.width, height: size.height, rotation: 0 };
			this.commitText();
			this.clearSelection();
			this.history.execute(new Batch("Insert scan", [new AddAsset(asset), new AddElement(anchor.id, element, anchor.elements?.length ?? 0)]));
			this.afterHistoryChange();
			showNotice(t("scan.imageDone"));
		} catch (e) {
			console.error("[notebook] insert scan", e);
			showNotice(t("scan.failed", { error: (e as Error).message }), 8000);
		} finally {
			if (asset) media.removePending(asset.id);
		}
	}

	/** Toolbar: places a picked image in the middle of the view, sized to fit, and selects it so it can be moved. */
	async insertImageElement(): Promise<void> {
		const session = this.session;
		const media = this.media;
		const layout = this.layout;
		const anchorIndex = this.currentPageIndex();
		const anchor = session?.doc?.pages[anchorIndex];
		if (!session || !media || !layout || !anchor || !this.stillHere(session)) return;
		let asset: Asset | null = null;
		try {
			const picked = await this.pickAndStore("image");
			if (!picked) return;
			asset = picked.asset;
			const dims = await photoSize(picked.bytes, "");
			if (!this.stillHere(session) || !session.doc?.pages.includes(anchor)) return;
			const box = this.layout?.boxes[session.doc.pages.indexOf(anchor)];
			if (!box) return;
			const [dx, dy] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
			const [lx, ly] = toPageLocal(box, dx, dy);
			const size = imageElementSize(dims.width, dims.height, anchor.width, anchor.height);
			const [x, y] = centredPosition(lx, ly, size, anchor);
			const element: ImageElement = { id: createId(), type: "image", asset: asset.id, x, y, width: size.width, height: size.height, rotation: 0 };
			this.commitText();
			this.clearSelection();
			this.history.execute(new Batch("Insert image", [new AddAsset(asset), new AddElement(anchor.id, element, anchor.elements?.length ?? 0)]));
			this.afterHistoryChange();
			// Select it: the lasso then moves, scales and rotates it.
			this.toolbar.setTool("lasso");
			const placed = anchor.elements?.find((e) => e.id === element.id);
			const pageIndex = session.doc.pages.indexOf(anchor);
			if (placed && pageIndex >= 0) {
				const bounds = unionBounds([], [placed], measureText);
				if (bounds) this.selection = { pageIndex, strokes: [], elements: [placed], bounds, matrix: IDENTITY };
				this.pushSelection();
			}
		} catch (e) {
			console.error("[notebook] insert image", e);
			showNotice(insertFailure(e), 8000);
		} finally {
			if (asset) media.removePending(asset.id);
		}
	}

	// --- during the lecture: board shot, new lecture, move pages (logic in board-shot.ts, lecture.ts, library/move-pages.ts) ---

	/** What the flows of those modules may do to this document; null unless it is open, editable and not being written on. */
	editContext(): EditContext | null {
		// Every flow that takes this context edits the document, so a read-only view (the user's, sync safety's, a newer
		// format, hidden annotations) hands out none: `stillHere` below includes `editable()`.
		if (!this.editable()) return null;
		const session = this.session;
		const media = this.media;
		const doc = session?.doc;
		// A contact or gesture in progress (lasso drag, eraser, pan…) would lose its change to an edit from outside: busy.
		if (!session || !media || !doc || !this.stillHere(session) || this.inContact()) return null;
		return {
			app: this.app,
			folder: this.host.settings.folder,
			file: this.file,
			doc,
			measure: measureText,
			alive: () => this.stillHere(session) && session.doc === doc,
			addPending: (asset) => media.addPending(asset),
			removePending: (id) => media.removePending(id),
			slide: () => pickSlideRef({ pane: referencePane(this), paneSlide: referenceSlideOf(this), page: doc.pages[this.currentPageIndex()], assets: doc.assets }),
			currentPage: () => this.currentPageIndex(),
			visibleLocal: (i) => {
				const box = this.layout?.boxes[i];
				const page = doc.pages[i];
				if (!box || !page) return null;
				const v = this.visibleRect();
				const minY = Math.max(0, v.minY - box.y);
				const maxY = Math.min(page.height, v.maxY - box.y);
				return maxY > minY ? { minY, maxY } : null;
			},
			execute: (cmd, scrollTo) => {
				this.commitText();
				this.clearSelection();
				// The History step is recorded first; what follows can never turn it into a failure (see executeThenSettle).
				return executeThenSettle(() => this.history.execute(cmd), [
					() => this.afterHistoryChange(),
					(done) => {
						if (done && scrollTo !== undefined) this.scrollToPage(scrollTo);
					},
				]);
			},
			flush: async () => (await this.flushNow()) && this.session === session && session.isSaved(),
		};
	}

	/** Toolbar and command: photo of the board, cropped and filtered, placed under the writing with the time. */
	async boardShot(): Promise<void> {
		const ctx = this.editContext();
		if (ctx) await runBoardShot(ctx);
	}

	/** Command and page menu: a new page at the end with the course/title and the date as a header. */
	async newLecture(): Promise<void> {
		const ctx = this.editContext();
		if (ctx) await runNewLecture(ctx);
	}

	/** Command and page menu: moves pages to another notebook. `index` is the page ticked at first (the one in view by default). */
	async movePagesToNotebook(index = this.currentPageIndex()): Promise<void> {
		const ctx = this.editContext();
		if (ctx) await runMovePages(ctx, this.host.settings, [index]);
	}

	/** 0.18 (#186): copies pages to another notebook with a link chip back. `pageId` is the page ticked at first (the one in view by default). */
	async copyPageToNotebook(pageId?: string): Promise<void> {
		await this.copyToNotebook(pageId ? [pageId] : []);
	}

	private async copyToNotebook(ids: readonly string[]): Promise<void> {
		const ctx = this.editContext();
		if (ctx) await runCopyWithLink({ app: this.app, settings: () => this.host.settings, journal: this.host.transferJournal?.() }, ctx, ids);
	}

	/** Wave 0.9 (#303): what the practice flows may do with this view (view/practice*.ts). */
	practiceHost(): PracticeViewHost {
		return {
			app: this.app,
			file: this.file,
			body: this.body,
			doc: () => this.session?.doc ?? null,
			editContext: () => this.editContext(),
			currentPage: () => this.currentPageIndex(),
			goToPage: (index) => this.scrollToPage(index),
			selectedStrokes: () => (this.selection ? { pageIndex: this.selection.pageIndex, strokes: this.selection.strokes } : null),
			setPeek: (pageIndex, strokes) => this.renderer?.setPeek(strokes ? { pageIndex, strokes } : null),
		};
	}

	// --- document ---

	private requireDoc(): NotebookDocument {
		const doc = this.session?.doc;
		if (!doc) throw new Error("no document loaded");
		return doc;
	}

	private editable(): boolean {
		return this.session?.mode === "ok" && !!this.session.doc && !this.reading?.annotationsHidden && !this.syncSafety?.readOnly && !this.userReadOnly;
	}

	private pageAtIndex(i: number): Page | null {
		return this.session?.doc?.pages[i] ?? null;
	}

	private currentPageIndex(): number {
		if (!this.layout) return 0;
		if (this.pageMode?.enabled) return this.pageMode.current();
		const [, y] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
		return Math.max(0, nearestPage(this.layout, y));
	}

	/** The document to show: the complete one, or while a large notebook is still being read, the part-read one. */
	private shownDoc(): NotebookDocument | null {
		return this.session?.doc ?? this.session?.partialDoc ?? null;
	}

	/**
	 * Staged load (#329): the page asked for is in, the others are stand-ins. Show it read-only: the toolbar stays off
	 * and nothing can be edited or saved until `onDocumentLoaded` brings the complete document.
	 */
	private showPartial(): void {
		if (!this.shownDoc()) return;
		this.messageEl.hide();
		this.body.show();
		this.toolbar.setEditable(false);
		this.symbols?.sync();
		this.setStatus(t("status.loading"), "pending");
		if (!this.media) {
			this.media = new NotebookMedia(this.app, () => this.shownDoc(), () => this.host.settings.folder, () => this.onMediaChanged(), (page) => this.statesTools?.viewPages([page])[0] ?? page);
			if (this.resilience?.mediaAtLoad() !== false) this.renderer?.setMedia(this.media); // wave 0.7: resilience (#346)
		}
		this.refreshLayout();
		this.refit(true);
		this.pageNav?.invalidate();
		this.applyStartPosition();
	}

	/** Staged load: these pages have their ink now; repaint if one of them is on screen. */
	private onPagesRead(pages: number[]): void {
		const layout = this.layout;
		if (!layout) return;
		const visible = visiblePages(layout, this.visibleRect());
		if (visible.some((i) => pages.includes(i))) this.renderer?.invalidate();
	}

	private refreshLayout(): void {
		const doc = this.shownDoc();
		const plain = doc ? (this.pageMode?.enabled ? layoutPagesHorizontal(doc.pages) : layoutPages(doc.pages)) : null;
		// wave 0.9 (376): with the margins cropped, the PDF pages carry the window the view fits (nothing else changes).
		this.layout = plain && doc && this.display ? this.display.shape(plain, doc.pages) : plain;
		this.renderer?.setDocument(doc ? this.renderPagesOf(doc) : null, this.layout);
		this.pushRuler();
		this.reading?.docChanged();
		this.pdfText?.docChanged();
		this.display?.docChanged();
		this.minimap?.invalidate();
	}

	/** wave 0.9 (376): the windows of the cropped view changed (or the toggle did): lay the pages out again and fit. */
	private reflow(): void {
		if (!this.shownDoc()) return;
		this.refreshLayout();
		this.refit(true);
		this.pageNav?.invalidate();
	}

	private displayHost(): DisplayHost {
		return {
			settings: () => this.host.settings,
			save: () => void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e)),
			renderer: () => this.renderer,
			doc: () => this.shownDoc(),
			media: () => this.media,
			currentPage: () => this.currentPageIndex(),
			reflow: () => this.reflow(),
			refreshUi: () => this.refreshUi(),
		};
	}

	private onDocumentLoaded(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void {
		this.headingWarm.touch(8000);
		this.active = null;
		this.erasing = null;
		this.lasso = null;
		this.spaceDrag = null;
		this.drag = null;
		this.shapeDrag = null;
		this.textTap = null;
		this.lassoTap = null;
		this.penLinks?.reset();
		this.checklist?.reset();
		this.pageOffer?.reset();
		this.slideBack?.documentChanged();
		this.pageRefs?.reset();
		this.multiTap.reset();
		this.stopHold();
		this.textEditor?.close();
		this.renderer?.setHiddenElements(null);
		this.clearSelection();
		this.history.clear();
		this.renderer?.setLive(null);
		this.renderer?.cancelWet();
		this.renderer?.setLasso(null);
		this.renderer?.setSpacePreview(null);
		this.radial?.close();
		this.ruler = null;
		this.reading?.reset();
		this.pdfText?.reset();
		if (doc && mode === "ok") {
			this.messageEl.hide();
			this.body.show();
			this.toolbar.setEditable(true);
			this.symbols?.sync();
			if (!this.media) {
				this.media = new NotebookMedia(this.app, () => this.shownDoc(), () => this.host.settings.folder, () => this.onMediaChanged(), (page) => this.statesTools?.viewPages([page])[0] ?? page);
				// wave 0.7: resilience (#346): in safe mode the backgrounds come after the first paint.
				if (this.resilience?.mediaAtLoad() !== false) this.renderer?.setMedia(this.media);
			}
			this.refreshLayout();
			this.refit(true);
			this.pageNav?.invalidate();
			if (this.tools.ruler) this.placeRuler();
			this.applyStartPosition();
			if (this.file) this.location.note(this.file.path, this.currentPageIndex() + 1);
			void checkConflicts(this.reliabilityDeps(), this);
			this.syncHooks?.loaded();
			this.practiceHooks?.loaded();
			this.lectureMode?.opened();
		} else {
			this.body.hide();
			this.toolbar.setEditable(false);
			this.symbols?.sync();
			this.layout = null;
			this.renderer?.setDocument(null, null);
			this.showProblem(problem);
		}
		this.updateHistoryButtons();
		this.refreshUi();
		this.syncSafety?.loaded(doc, mode);
		this.resilience?.loaded(mode);
	}

	private showProblem(problem = this.session?.problem ?? null): void {
		if (this.session?.mode === "not-downloaded" && this.syncSafety) {
			this.syncSafety.renderNotDownloaded(this.messageEl);
			return this.setStatus(t("sync.status.notDownloaded"), "pending");
		}
		const readonly = this.session?.mode === "readonly";
		this.messageEl.empty();
		this.messageEl.createEl("h3", { text: t(readonly ? "view.readonly.title" : "view.broken.title") });
		this.messageEl.createEl("p", { text: t(readonly ? "view.readonly.body" : "view.broken.body") });
		if (problem) this.messageEl.createEl("pre", { text: problem });
		if (this.lastBackupPath) this.messageEl.createEl("p", { text: `${t("view.backup")}: ${this.lastBackupPath}` });
		const file = this.file;
		if (!readonly && file) {
			// #140: recover what can be read into a new notebook; this file is never written.
			this.messageEl.createEl("button", { text: t("view.broken.repair"), cls: "mod-cta" })
				.addEventListener("click", () => void openRepair(this.reliabilityDeps(), file));
		}
		this.messageEl.show();
		this.setStatus(t("status.readonly"), "error");
	}

	/** The save state shown in the toolbar and in the status bar item (roadmap O15). */
	private setStatus(text: string, kind: StatusBarInfo["kind"]): void {
		this.toolbar.setStatus(text, kind);
		this.saveText = text;
		this.saveKind = kind;
		this.notifyStatus();
	}

	/** What the status bar item shows for this view: the page in view and the save state; null while there is no document. */
	statusSnapshot(): StatusBarInfo | null {
		const total = this.shownDoc()?.pages.length ?? 0;
		if (total === 0 || !this.layout) return null;
		return { page: this.currentPageIndex() + 1, total, save: this.saveText, kind: this.saveKind };
	}

	private notifyStatus(): void {
		const snap = this.statusSnapshot();
		const key = snap ? `${snap.page}/${snap.total}|${snap.save}|${snap.kind}` : "";
		if (key === this.statusKey) return;
		this.statusKey = key;
		this.host.statusChanged?.(this);
	}

	/** 0.17 (#23): a save finished (the copy is brought up to date after a quiet moment) or an edit began (a build in progress is stale). */
	private notePdfCopy(state: SaveState): void {
		if (state !== "saved") {
			this.editTick++;
			return;
		}
		const path = this.file?.path;
		if (path && this.session?.mode === "ok") this.host.pdfCopy?.saved(path, () => this.pdfCopySource());
	}

	/**
	 * 0.17 (#23): the notebook as the PDF copy needs it: the pages as an export draws them, without hidden ink and without
	 * equation typesetting (the view may be gone when the copy is built). Null while the notebook is not open for editing.
	 */
	private pdfCopySource(from: DocumentSession | null = this.session): PdfCopySource | null {
		const doc = from?.doc;
		const file = this.file;
		if (!from || !doc || !file || from.mode !== "ok") return null;
		const header = this.exportHeader();
		return {
			file, doc, pages: [...this.renderPagesOf(doc)],
			options: { boxLabel: translatedBoxLabel, equationNumbers: equationNumbers(doc.pages), ...(header ? { header } : {}) },
			stamp: () => this.editTick,
			unsaved: () => from.dirty,
		};
	}

	private showSaveState(state: SaveState): void {
		if (this.session && this.session.mode !== "ok") {
			if (this.session.mode === "not-downloaded") return this.setStatus(t("sync.status.notDownloaded"), "pending");
			this.setStatus(t("status.readonly"), "error");
			return;
		}
		const text = { saved: "status.saved", pending: "status.pending", saving: "status.saving", error: "status.error" } as const;
		this.setStatus(t(text[state]), state === "error" ? "error" : state === "saved" ? "ok" : "pending");
	}

	private showError(message: string): void {
		console.error("[notebook]", message);
		const now = Date.now();
		if (now - this.lastErrorAt < 10000) return;
		this.lastErrorAt = now;
		// An error (a failed save) is shown at once, not after the pen is lifted.
		showErrorNotice(`Notebook: ${message}`, 8000);
	}

	/** Every real change of the document: schedules the save and logs the page as recently edited (365). */
	private markChanged(): void {
		// wave 0.10 (51): read-only mode never schedules a save (nothing changed; a stray call must not write the file).
		if (this.userReadOnly) return;
		this.session?.markChanged();
		this.followChange();
	}

	/** What follows a change besides scheduling the save (the save itself is `session.markChanged()`). */
	private followChange(): void {
		if (this.userReadOnly) return;
		this.headingWarm.touch();
		// 0.19 (#103): the task lines of linked checkboxes follow the ticks a moment later.
		this.checklist?.docChanged();
		// v10: live pictures of excerpts of this notebook's pages follow the edit (throttled).
		this.media?.excerptsChanged();
		const doc = this.session?.doc;
		if (!doc || !this.file || this.session?.mode !== "ok") return;
		const num = this.currentPageIndex() + 1;
		const page = doc.pages[num - 1];
		if (page) this.host.edited?.(doc.id, this.file.path, page.id, num);
	}

	private afterHistoryChange(): void {
		// The save is scheduled first (review W21 D6): if the layout or the viewport below throws, the recorded step is still written.
		if (!this.userReadOnly) this.session?.markChanged();
		this.renderer?.setGhost(null);
		this.refreshLayout();
		this.minimap?.invalidate();
		// The document may be shorter now (page deleted or made smaller): keep the view inside it.
		this.setViewport(this.viewport);
		this.followChange();
		this.updateHistoryButtons();
		this.updatePageIndicator();
		this.pageNav?.refresh();
		this.statesTools?.refresh();
	}

	/** The page panel shows thumbnails of what was just drawn, a moment after the pen lifts. */
	private scheduleNavRefresh(): void {
		this.scheduleHeavyCheck();
		this.minimap?.invalidate();
		if (!this.pageNav?.open || this.navTimer !== null) return;
		this.navTimer = window.setTimeout(() => {
			this.navTimer = null;
			// Thumbnails are rendered on the main thread: never while the pen is writing.
			if (this.active || this.erasing) this.scheduleNavRefresh();
			else this.pageNav?.refresh();
		}, 500);
	}

	private updateHistoryButtons(): void {
		this.toolbar.setHistory(this.editable() && this.history.canUndo(), this.editable() && this.history.canRedo());
	}

	private updatePageIndicator(): void {
		const n = this.shownDoc()?.pages.length ?? 0;
		const current = n ? this.currentPageIndex() : -1;
		const lockedPage = n ? this.shownDoc()?.pages[current]?.locked === true : false;
		this.toolbar.setPage(n ? current + 1 : 0, n, lockedPage);
		this.syncLockBadge(lockedPage);
		this.mentions?.sync();
		this.pageRefs?.sync();
		this.notifyStatus();
		if (n) this.practiceHooks?.page(current);
		if (n && this.file) this.pageClock.note(this.file.path, current, new Date());
		this.scheduleHeavyCheck();
		if (current !== this.navCurrent) {
			this.navCurrent = current;
			if (n && this.app.workspace.getActiveViewOfType(NotebookView) === this) {
				this.host.nav?.seen(this.navPlace());
				this.host.quickTabs?.seen(this.navPlace());
			}
			this.pageNav?.markCurrent(current);
			this.pageOffer?.cancel(); // an offer made for the page that was in view
			this.checklist?.cancelOffer();
			this.smartAdd?.hide();
			this.refreshUi(); // the contextual bar follows the kind of page in view
			if (n && this.file && this.pendingPage === null) this.location.note(this.file.path, current + 1, this.currentPosition());
			this.syncHooks?.page(current);
		} else if (n && this.file && this.pendingPage === null) {
			// Same page, but the zoom or the scroll position may have changed.
			this.location.note(this.file.path, current + 1, this.currentPosition());
		}
	}

	private onToolsChanged(state: ToolbarState): void {
		const before = this.tools;
		this.tools = state;
		this.pens?.onToolsChanged(state);
		this.radial?.noteTools(state);
		this.colour?.noteTools(state);
		this.lastTool.note(state.tool);
		// v10: an armed excerpt region is for the tool it was armed with.
		if (state.tool !== before.tool) this.excerpts?.disarm();
		// 0.16: choosing a tool leaves the Select text mode (the pen writes again).
		if (state.tool !== before.tool) this.pdfText?.exit();
		// 0.11.2: so is "next stroke erases".
		if (state.tool !== before.tool) this.controller?.disarmEraserNext();
		if (state.tool !== "lasso") this.clearSelection();
		this.refreshUi();
		if (before.tool === "text" && state.tool !== "text") this.commitText();
		if (state.ruler !== before.ruler) {
			if (state.ruler && !this.ruler) this.placeRuler();
			this.pushRuler();
		}
	}

	// --- media, thumbnails ---

	private onMediaChanged(): void {
		this.renderer?.invalidate();
		if (this.thumbPending.size === 0 || !this.pageNav?.open || this.thumbTimer !== null) return;
		this.thumbTimer = window.setTimeout(() => {
			this.thumbTimer = null;
			const ids = [...this.thumbPending];
			this.thumbPending.clear();
			this.pageNav?.invalidate(ids);
		}, 150);
	}

	// --- 0.16 (#87): presentation mode (logic in view/present-logic.ts, the overlay in view/present-mode.ts) ---

	/** Presents the notebook full screen from the page in view. Nothing is written to the document. */
	startPresentation(): void {
		if (this.presentation?.isOpen) return;
		if ((this.shownDoc()?.pages.length ?? 0) === 0) {
			showNotice(t("present.empty"), 3000);
			return;
		}
		// The Select text mode (#45) and the presentation both take every contact: leave the mode first.
		this.pdfText?.exit();
		this.presentation ??= new PresentationMode({
			container: () => this.contentEl,
			pages: () => this.shownDoc()?.pages ?? [],
			startIndex: () => this.currentPageIndex(),
			settings: () => this.host.settings,
			render: (page, widthPx) => this.renderPresentPage(page, widthPx),
			inkMode: (on, pos) => this.presentInk(on, pos),
			inkGo: (pos) => this.presentInkGo(pos.page, pos.state),
			closed: (index) => {
				if (index !== this.currentPageIndex()) this.goToPage(index);
			},
		});
		this.presentation.open();
	}

	/** The image of a page for the presentation: PDF pages are drawn at the size shown, images that are still loading are waited for a moment. */
	private async renderPresentPage(page: Page, widthPx: number): Promise<string> {
		const bg = page.background;
		let pdfCanvas: CanvasImageSource | undefined;
		if (bg && bg.kind === "pdf" && this.media) {
			try {
				pdfCanvas = await this.media.pdf.render(bg.asset, bg.page, widthPx / Math.max(1, page.width));
			} catch (e) {
				console.error("[notebook] presentation: rendering the PDF page failed", e);
			}
		}
		let url = "";
		for (let attempt = 0; attempt < 4; attempt++) {
			this.thumbPending.delete(page.id);
			url = renderThumbnail(page, widthPx, { mime: "image/jpeg", quality: 0.92, drawBackground: (ctx, p) => this.drawThumbMedia(ctx, p, pdfCanvas) });
			if (!this.thumbPending.has(page.id)) break;
			await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
		}
		return url;
	}

	/** "Write while presenting": the notebook's own page-by-page view shows the presented page behind the transparent overlay. */
	private presentInk(on: boolean, pos: { page: number; state: string | null }): number | null {
		if (on) {
			this.presentWasPaged = this.pageMode?.enabled ?? false;
			if (!this.presentWasPaged) this.setScrollMode("pages");
			this.presentInkGo(pos.page, pos.state);
			return null;
		}
		const index = this.currentPageIndex();
		if (!this.presentWasPaged) this.setScrollMode(this.host.settings.scrollMode);
		return index;
	}

	private presentInkGo(index: number, state: string | null): void {
		this.scrollToPage(index);
		const page = this.shownDoc()?.pages[index];
		if (page?.states && page.states.list.length > 0) this.statesTools?.switchTo(state);
	}

	/** 0.14 (408): the notebook map, with its per-page cache (one per open view). */
	private readonly mapCache = new NotebookMapCache();

	private openNotebookMap(): void {
		const pages = () => this.shownDoc()?.pages ?? [];
		new NotebookMapModal(this.app, {
			map: () => this.mapCache.build(pages()),
			pages,
			current: () => this.currentPageIndex(),
			thumbnail: (page) => this.pageNav?.thumbnailOf(page) ?? BLANK_THUMBNAIL,
			goTo: (index) => this.goToPage(index),
			// 0.20 (#102): the headings found in the handwriting, with their pictures, and a jump to the line.
			headings: this.host.settings.outlineHeadings ? () => this.outlineBuilder.build({ pages: pages() }, HEADINGS_ONLY).filter((i) => i.kind === "heading") : undefined,
			headingImage: (item) => {
				const page = pages().find((p) => p.id === item.pageId);
				return page ? this.headingThumbs.url(page, item) : null;
			},
			goToAt: (index, y) => this.goToPageAt(index, y),
			present: () => this.startPresentation(),
			// 0.21 (#217): when each page was written (empty: the page has no times, or the setting hides them).
			written: (page) => {
				const times = this.host.settings.headerPageTimes ? pageTimes(page) : null;
				return times ? pageTimesText(times, getLanguage()) : "";
			},

			setLocked: (pageId, value) => this.setLockedById(pageId, value),
			canLock: () => !!this.editableDocument(),
			// 0.17 (#77): extract pages / split from the map. The dialog and the run work on the file (an open view is used through its edit context).
			extract: (ids) => void this.extractFromMap(ids),
			split: (pageId) => void this.splitAtPage(pageId),
			copyTo: (ids) => void this.copyToNotebook(ids),
		}).open();
	}

	/** 0.17 (#77): the flows for this view's notebook (merge, split, extract). */
	private transferFlows(): TransferFlows | null {
		return this.file ? new TransferFlows({ app: this.app, settings: () => this.host.settings, journal: this.host.transferJournal?.() }) : null;
	}

	private async extractFromMap(ids: string[]): Promise<void> {
		if (this.file && ids.length > 0) await this.transferFlows()?.extract(this.file, ids);
	}

	private async splitAtPage(pageId: string): Promise<void> {
		const index = this.session?.doc?.pages.findIndex((p) => p.id === pageId) ?? -1;
		if (this.file && index > 0) await this.transferFlows()?.split(this.file, index);
	}

	/** Locks or unlocks the page with this id (the page strip and the notebook map). */
	private setLockedById(pageId: string, value: boolean): boolean {
		const page = this.session?.doc?.pages.find((p) => p.id === pageId);
		return page ? this.setPageLocked(page, value) : false;
	}

	private thumbnail(page: Page, width: number): string {
		if (this.resilience?.thumbnailsAllowed() === false) return BLANK_THUMBNAIL;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		return renderThumbnail(this.statesTools?.viewPages([page])[0] ?? page, Math.round(Math.min(width, THUMB_CSS_WIDTH) * dpr), {
			mime: "image/jpeg",
			quality: 0.8,
			drawBackground: (ctx, p) => this.drawThumbMedia(ctx, p),
		});
	}

	/** Background and elements of a thumbnail; whatever is not loaded yet is drawn as a placeholder and retried later. */
	private drawThumbMedia(ctx: CanvasRenderingContext2D, page: Page, pdfCanvas?: CanvasImageSource): void {
		const media = this.media;
		if (!media) return;
		let incomplete = false;
		const bg = page.background;
		if (bg) {
			let img: CanvasImageSource | null;
			if (pdfCanvas && bg.kind !== "image") img = pdfCanvas;
			else if (bg.kind === "image") img = media.image(bg.asset);
			else {
				// Never ask for another scale of a page the main view is drawing: a render in flight would be cancelled.
				img = (media.pdf.peek(bg.asset, bg.page)?.canvas as CanvasImageSource | undefined) ?? null;
				if (!img && !this.isPageVisible(page)) this.renderThumbPdf(bg.asset, bg.page);
			}
			const r = backgroundRect(page);
			if (img) ctx.drawImage(img, r.x, r.y, r.width, r.height);
			else {
				ctx.fillStyle = "#f1f5f9";
				ctx.fillRect(r.x, r.y, r.width, r.height);
				incomplete = true;
			}
		}
		const elements = page.elements ?? [];
		for (const el of elements) {
			if (el.type === "excerpt") {
				// v10: thumbnails show an excerpt's snapshot (cheap, and never another page's live picture).
				const img = el.asset !== undefined ? media.image(el.asset) : null;
				if (el.asset !== undefined && !img) incomplete = true;
				drawElement(ctx, el, img);
				continue;
			}
			if (el.type !== "image") continue;
			const img = media.image(el.asset);
			if (!img) incomplete = true;
			drawElement(ctx, el, img);
		}
		for (const el of elements) if (el.type === "text") drawTextElement(ctx, el);
		if (incomplete) this.thumbPending.add(page.id);
	}

	private renderThumbPdf(asset: string, pageNumber: number): void {
		const media = this.media;
		const key = `${asset}|${pageNumber}`;
		if (!media || this.thumbRendering.has(key)) return;
		this.thumbRendering.add(key);
		media.pdf.render(asset, pageNumber, THUMB_PDF_SCALE).then(() => this.onMediaChanged(), () => undefined)
			.finally(() => this.thumbRendering.delete(key));
	}

	private isPageVisible(page: Page): boolean {
		const layout = this.layout;
		const index = this.session?.doc?.pages.indexOf(page) ?? -1;
		if (!layout || index < 0) return false;
		return visiblePages(layout, this.visibleRect()).includes(index);
	}

	private visibleRect(): BBox {
		const { scale, offsetX, offsetY } = this.viewport;
		return { minX: -offsetX / scale, minY: -offsetY / scale, maxX: (this.viewSize.width - offsetX) / scale, maxY: (this.viewSize.height - offsetY) / scale };
	}

	// --- view geometry ---

	onResize(): void {
		this.measure();
	}

	private measure(): void {
		const rect = this.stage.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.viewSize = { width: rect.width, height: rect.height };
		this.body.toggleClass("is-narrow", this.contentEl.clientWidth < NARROW_PX);
		const vp = this.vpClass.update(this.contentEl.clientWidth, this.contentEl.clientHeight);
		if (vp) {
			applyViewportClass(this.contentEl, vp);
			this.placeQuickTabs(vp.shortHeight);
		}
		this.ui?.refresh();
		this.renderer?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
		this.refit(true);
		if (this.pendingPage !== null) this.applyStartPosition();
	}

	/** In fit mode, rescales to the view width; `keepTop` keeps the same document line at the top (rotation). */
	private refit(keepTop: boolean): void {
		const layout = this.layout;
		if (!layout || this.viewSize.width === 0) return;
		if (!this.fitMode) {
			this.setViewport(this.viewport);
			return;
		}
		if (this.pageMode?.enabled) {
			this.pageMode.refit(keepTop);
			return;
		}
		const topY = screenToPage(this.viewport, 0, 0)[1];
		const fitted = fitWidth(this.viewSize, layout);
		if (keepTop && topY > 0) fitted.offsetY = -topY * fitted.scale;
		this.setViewport(fitted);
	}

	private setViewport(v: Viewport, interactive = false): void {
		const layout = this.layout;
		this.viewport = layout ? (this.pageMode?.enabled ? this.pageMode.clamp(v) : clampToPage(v, this.viewSize, layout)) : v;
		this.renderer?.setViewport(this.viewport, interactive);
		this.penLinks?.viewChanged();
		this.checklist?.viewChanged();
		this.reading?.viewportChanged();
		this.pdfText?.viewportChanged();
		if (this.selection) this.pushSelection();
		this.placeTextEditor();
		this.math?.place();
		this.updatePageIndicator();
		this.scrollbar?.update();
		this.minimap?.update();
		this.slideBack?.viewChanged();
		this.symbols?.sync();
		this.overlayChanged?.();
		for (const fn of this.overlayListeners) fn();
	}

	// wave 0.6: zettelkasten — hooks for DOM overlays (card regions, src/zettel/overlay.ts)

	/** Called after every viewport or layout change, so overlays can follow the pages. */
	overlayChanged: (() => void) | null = null;

	// wave 0.8: processing — more than one overlay (textbook references, src/view/textbook-ref-ui.ts)
	private readonly overlayListeners = new Set<() => void>();

	/** Like `overlayChanged`, for any number of listeners. Returns the function that removes it. */
	addOverlayListener(fn: () => void): () => void {
		this.overlayListeners.add(fn);
		return () => this.overlayListeners.delete(fn);
	}

	/** The tool in use (for overlays that must not get in the way of the text tool). */
	activeTool(): string {
		return this.tools.tool;
	}

	/** Stage element, viewport and page boxes (document space) for DOM overlays; null without a document. */
	overlayGeometry(): { stage: HTMLElement; viewport: Viewport; boxes: readonly PageBox[] } | null {
		return this.layout && this.stage ? { stage: this.stage, viewport: this.viewport, boxes: this.layout.boxes } : null;
	}

	/** Page and bounds (page coordinates, any pending drag applied) of the lasso selection, or null. */
	selectionRegion(): { pageIndex: number; bounds: BBox } | null {
		const sel = this.selection;
		if (!sel) return null;
		const corners = selectionCorners(sel.bounds, sel.matrix);
		const xs = corners.map((c) => c[0]);
		const ys = corners.map((c) => c[1]);
		return { pageIndex: sel.pageIndex, bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } };
	}

	// --- text boxes ---

	/** Positions the textarea over the box being edited at the current zoom. */
	private placeTextEditor(): void {
		const session = this.textEditor?.session;
		if (!session || !this.layout) return;
		const index = this.session?.doc?.pages.findIndex((p) => p.id === session.pageId) ?? -1;
		const box = this.layout.boxes[index];
		if (!box) return;
		const { scale, offsetX, offsetY } = this.viewport;
		this.textEditor?.place(offsetX + (box.x + session.x) * scale, offsetY + (box.y + session.y) * scale, scale);
	}

	/** Text tool tap: edits the text box under the pen, or starts a new one at that point. */
	private beginText(pageIndex: number, local: [number, number]): void {
		const page = this.pageAtIndex(pageIndex);
		const editor = this.textEditor;
		if (!page || !editor) return;
		if (page.locked) {
			this.pagesLocked([page.id]);
			return;
		}
		this.clearSelection();
		const texts = (page.elements ?? []).filter((e): e is TextElement => e.type === "text");
		const hit = hitElement(texts, local[0], local[1], 4 / this.viewport.scale, measureText) as TextElement | null;
		if (!hit) {
			// 0.20 (#39): a locked text box is not edited, and no new box is started on top of it: the chip offers Unlock.
			const locked = hitLockedElement(texts, local[0], local[1], 4 / this.viewport.scale, measureText);
			if (locked) {
				this.groups?.showLocked(pageIndex, locked, local);
				return;
			}
		}
		let session: TextEditSession;
		if (hit) {
			session = { pageId: page.id, element: hit, x: hit.x, y: hit.y, width: hit.width, fontSize: hit.fontSize, color: hit.color };
			this.renderer?.setHiddenElements(new Set<PageElement>([hit]));
		} else {
			const box = newTextBox(page.width, local[0], local[1]);
			session = { pageId: page.id, element: null, ...box, fontSize: this.tools.textSize, color: this.tools.penColor };
		}
		editor.open(session, hit?.text ?? "", () => this.commitText());
		this.placeTextEditor();
		editor.focus();
	}

	/**
	 * Ends text editing: adds, changes or (when emptied) removes the text box, as one undo step. v9: also commits the
	 * equation editor and the graph panel when one is open (saving, closing, another command).
	 */
	private commitText(): void {
		this.math?.commitOpen();
		const result = this.textEditor?.close();
		if (!result) return;
		this.renderer?.setHiddenElements(null);
		const doc = this.session?.doc;
		const page = doc?.pages.find((p) => p.id === result.pageId);
		if (!doc || !page || !this.editable()) return;
		const text = result.text.replace(/\s+$/, "");
		let cmd: Command | null = null;
		if (result.element) {
			// The box may have been deleted or changed by undo while it was open.
			if (!page.elements?.includes(result.element)) return;
			if (text === "") cmd = new RemoveElement(page.id, result.element);
			else if (text !== result.element.text) cmd = new ReplaceElement(page.id, result.element, { ...result.element, text });
		} else if (text !== "") {
			const el: TextElement = {
				id: createId(), type: "text", x: result.x, y: result.y, width: result.width, text, fontSize: result.fontSize, color: result.color,
			};
			cmd = new AddElement(page.id, el, page.elements?.length ?? 0);
		}
		if (cmd) {
			this.history.execute(cmd);
			this.afterHistoryChange();
		} else {
			this.renderer?.invalidate();
		}
		// An external change seen while the box was open was postponed.
		this.session?.gestureEnded();
	}

	// --- ruler ---

	/** Puts the ruler in the middle of the view, on the page in view. */
	private placeRuler(): void {
		const doc = this.session?.doc;
		const layout = this.layout;
		if (!doc || !layout) return;
		const index = this.currentPageIndex();
		const page = doc.pages[index];
		const box = layout.boxes[index];
		if (!page || !box) return;
		const [dx, dy] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
		const [lx, ly] = toPageLocal(box, dx, dy);
		const length = Math.min(RULER_LENGTH, page.width * 0.9);
		const half = length / 2;
		const x = Math.min(Math.max(lx, half), Math.max(half, page.width - half));
		const y = Math.min(Math.max(ly, 0), page.height);
		this.ruler = { pageId: page.id, ruler: { x, y, angle: 0, length } };
	}

	private pushRuler(): void {
		const r = this.ruler;
		const index = r ? (this.session?.doc?.pages.findIndex((p) => p.id === r.pageId) ?? -1) : -1;
		this.renderer?.setRuler(this.tools.ruler && r && index >= 0 ? { pageIndex: index, ruler: r.ruler } : null);
	}

	/** Stage px to the ruler's page, in page coordinates. */
	private toRulerLocal(p: [number, number]): [number, number] | null {
		const r = this.ruler;
		const index = r ? (this.session?.doc?.pages.findIndex((pg) => pg.id === r.pageId) ?? -1) : -1;
		const box = this.layout?.boxes[index];
		if (!box) return null;
		const [dx, dy] = screenToPage(this.viewport, p[0], p[1]);
		return toPageLocal(box, dx, dy);
	}

	private rulerGrabs(mid: [number, number]): boolean {
		const r = this.ruler;
		const local = this.toRulerLocal(mid);
		if (!r || !local) return false;
		const index = this.session?.doc?.pages.findIndex((pg) => pg.id === r.pageId) ?? -1;
		const box = this.layout?.boxes[index];
		if (!box) return false;
		const { scale, offsetX, offsetY } = this.viewport;
		const sx = offsetX + (box.x + r.ruler.x) * scale;
		const sy = offsetY + (box.y + r.ruler.y) * scale;
		const visible = sx >= 0 && sx <= this.viewSize.width && sy >= 0 && sy <= this.viewSize.height;
		return shouldGrabRuler(r.ruler, local, scale, visible);
	}

	/** Two fingers hold the ruler: it sits between them, along the line through them. */
	private moveRuler(a: [number, number], b: [number, number]): void {
		const r = this.ruler;
		const la = this.toRulerLocal(a);
		const lb = this.toRulerLocal(b);
		if (!r || !la || !lb || Math.hypot(la[0] - lb[0], la[1] - lb[1]) < 1e-6) return;
		this.ruler = { pageId: r.pageId, ruler: rulerFromTwoTouches(la, lb, r.ruler.length) };
		this.pushRuler();
	}

	/** Does a pen stroke starting at `local` on this page latch onto the ruler edge? */
	private rulerLatches(page: Page, local: [number, number]): boolean {
		const r = this.ruler;
		return this.tools.ruler && !!r && r.pageId === page.id && projectToRuler(r.ruler, local, RULER_SNAP_PX / this.viewport.scale) !== null;
	}

	private snapToRuler(active: ActiveStroke, x: number, y: number): [number, number] {
		if (!active.snap || !this.ruler) return [x, y];
		return projectToRuler(this.ruler.ruler, [x, y], Infinity) ?? [x, y];
	}

	// --- input ---

	private toDoc(s: { x: number; y: number }): [number, number] {
		return screenToPage(this.viewport, s.x, s.y);
	}

	private toLocal(pageIndex: number, s: { x: number; y: number }): [number, number] | null {
		const box = this.layout?.boxes[pageIndex];
		if (!box) return null;
		const [x, y] = this.toDoc(s);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return toPageLocal(box, x, y);
	}

	/** Sample `i` of a buffer as a point object (for the tools that are not on the writing hot path). */
	private static at(b: SampleBuffer, i: number): { x: number; y: number } {
		return { x: b.x[i]!, y: b.y[i]! };
	}

	private drawStart(sample: InkSample, eraserButton: boolean, held?: "lasso" | "previous" | "gesture", continued = false): boolean {
		// The ink the same contact committed just before (side button pressed while writing) is kept: the eraser spares it.
		const spare = continued ? this.justCommitted?.ids : undefined;
		this.justCommitted = null;
		const layout = this.layout;
		// 0.16 (#45): in the Select text mode every contact selects text; nothing is drawn.
		if (layout && this.pdfText?.active) return this.pdfTextStart(sample);
		if (!layout || !this.editable()) return false;
		this.commitText();
		const [dx, dy] = this.toDoc(sample);
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
		// Pen gestures start only when asked for: gesture mode, or the side button held with its action set to gestures.
		// Normal writing never gets here. A selection is kept: the gesture may move it.
		if (this.penGestures && gestureStarts({ pointerType: sample.pointerType, eraser: eraserButton, buttonGesture: held === "gesture", modeOn: this.penGestures.mode })) {
			this.penGestures.start(sample.x, sample.y, sample.t);
			return true;
		}
		const tool = eraserButton ? "eraser" : held === "lasso" ? "lasso" : held === "previous" ? (this.lastTool.previous() ?? this.tools.tool) : this.tools.tool;

		// An armed marker or box takes the next contact whatever the tool (see below).
		if (tool === "eraser" && this.tools.eraserMode !== "area" && !((this.markers?.armed || this.excerpts?.armed) && !eraserButton)) {
			// The selection may contain strokes about to be erased (e.g. erasing with the pen button).
			this.clearSelection();
			this.erasing = { commands: [], last: [dx, dy], spare };
			this.eraseTo(dx, dy);
			return true;
		}

		const pageIndex = pageAt(layout, dx, dy, PAGE_TOLERANCE);
		if (pageIndex < 0) {
			this.clearSelection();
			return false;
		}
		const page = this.pageAtIndex(pageIndex);
		const local = toPageLocal(layout.boxes[pageIndex]!, dx, dy);
		// 0.16 (#124): a locked page takes no ink, text, shape, space or eraser: only the lasso, to select and copy from it.
		if (page?.locked && tool !== "lasso") {
			this.clearSelection();
			this.pagesLocked([page.id]);
			return false;
		}
		if (page) this.lastPen = { pageId: page.id, x: local[0], y: local[1], at: Date.now() };

		// v8: an armed marker or box is placed, a tap on a badge toggles it (eraser and lasso keep their own taps).
		if (page && !eraserButton && this.markers?.begin(pageIndex, page, local, sample, tool)) {
			this.clearSelection();
			return true;
		}
		// v10: an armed excerpt takes the drag of its region. A contact on an excerpt's badge is only noted: it is ink
		// unless it lifts soon without moving (then drawEnd drops the dot and jumps to the source).
		if (page && !eraserButton && this.excerpts?.begin(pageIndex, page, local, sample, tool)) {
			this.clearSelection();
			return true;
		}
		// 0.19 (#103): a contact on a checkbox is only noted, like the badge of an excerpt: it goes on as ink unless it lifts soon without
		// moving (then drawEnd drops the dot and ticks the checkbox).
		if (page && !eraserButton) this.checklist?.begin(page, local, sample, tool);

		if (tool === "eraser") {
			// Area mode: the outline drawn like a lasso erases what is inside it when the pen lifts.
			this.clearSelection();
			this.lasso = { pageIndex, points: [local], erase: true, spare };
			this.renderer?.setLasso(this.lasso);
			return true;
		}

		if (tool === "space") {
			this.clearSelection();
			this.spaceDrag = { pageIndex, y: local[1], delta: 0 };
			this.previewSpace(this.spaceDrag);
			return true;
		}

		if (tool === "lasso") {
			this.lassoTap = { pageIndex, local, x: sample.x, y: sample.y, t: sample.t, moved: false };
			const sel = this.selection;
			// A selection across pages is grabbed from any page: the point is taken in the frame of its primary page.
			const grab = sel?.others?.length ? this.toLocal(sel.pageIndex, sample) ?? local : local;
			const hit = sel && (sel.pageIndex === pageIndex || sel.others?.length) ? this.selectionHit(grab) : null;
			if (sel && hit) {
				// 0.16 (#124): a selection on a locked page can be copied, not moved, scaled or turned.
				const lockedPage = this.lockedSelectionPage(sel);
				if (lockedPage) {
					this.pagesLocked([lockedPage.id]);
					return false;
				}
				this.drag = { kind: hit, start: grab, startMatrix: sel.matrix };
				this.beginSnap(this.drag, sel, sample.pointerType);
				return true;
			}
			this.clearSelection();
			this.lasso = this.tools.selectMode === "rectangle" ? { pageIndex, points: [local], anchor: local } : { pageIndex, points: [local] };
			this.renderer?.setLasso(this.lasso);
			return true;
		}

		if (tool === "text") {
			this.clearSelection();
			this.textTap = { pageIndex, local, x: sample.x, y: sample.y, moved: false };
			return true;
		}

		if (tool === "shape") {
			this.clearSelection();
			this.shapeDrag = { pageIndex, a: local, b: local };
			return true;
		}

		// A selection made with the side button's lasso is not carried into new ink.
		this.clearSelection();
		this.penLinks?.strokeStarted();
		this.checklist?.strokeStarted();
		this.pageOffer?.penDown();
		this.smartAdd?.hide();
		this.strokeStart = sample.t;
		this.renderer?.touchGhost(performance.now());
		const snap = !!page && this.rulerLatches(page, local);
		const start = snap && this.ruler ? (projectToRuler(this.ruler.ruler, local, Infinity) ?? local) : local;
		this.filter.reset(sample.x, sample.y, sample.t);
		// Real or simulated pressure is decided here, for the whole stroke.
		this.pressure.begin(sample.pointerType, sample.pressure);
		const p = this.pressure.sample(sample.pointerType, sample.pressure, sample.x, sample.y, sample.t);
		const highlighter = tool === "highlighter";
		if (highlighter && page) this.reading?.prefetch(page);
		const inkTool = highlighter ? "highlighter" : "pen";
		const color = highlighter ? this.tools.highlighterColor : this.tools.penColor;
		const width = highlighter ? this.tools.highlighterWidth : this.tools.penWidth;
		this.ink.reset(inkTool, width);
		this.ink.add(start[0], start[1], p);
		this.active = {
			pageIndex,
			stroke: this.markers?.invisibleInk && inkTool === "pen"
				? { ...createStroke(color, width, [], inkTool, RENDER_INK), hidden: true }
				: createStroke(color, width, [], inkTool, RENDER_INK),
			wet: true,
			liveFallback: false,
			rawX: start[0],
			rawY: start[1],
			rawP: p,
			minStep: MIN_STEP_PX / this.viewport.scale,
			snap,
			recognized: false,
			extra: [],
			tried: null,
		};
		this.hold.clear();
		this.hold.push(sample.x, sample.y, performance.now());
		this.startHold();
		this.armDwell(sample, eraserButton, !!held, inkTool);
		// The first point shows as a dot right away.
		const painted = !!this.renderer?.beginWet(pageIndex, this.ink, inkTool, color) && this.renderer.paintWet();
		if (!painted) this.showLiveFallback(this.active);
		return true;
	}

	private drawMove(samples: SampleBuffer, predicted: SampleBuffer): void {
		const n = samples.count;
		if (n > 0) this.perfInput = samples.t[n - 1]!;
		// v10: a contact that started on an excerpt's badge and moves is ink, not a tap.
		if (this.excerpts) for (let i = 0; i < n; i++) this.excerpts.watch(NotebookView.at(samples, i));
		if (this.checklist) for (let i = 0; i < n; i++) this.checklist.watch(NotebookView.at(samples, i));
		if (this.pdfText?.dragging) {
			const textPage = this.pdfText.gesturePage;
			const last = n > 0 ? NotebookView.at(samples, n - 1) : null;
			if (textPage !== null && last) this.pdfText.move(this.toLocal(textPage, last), last);
			return;
		}

		if (this.penGestures?.active) {
			this.penGestures.move(samples);
			return;
		}
		if (this.dwell) this.watchDwell(samples);

		if (this.erasing) {
			for (let i = 0; i < n; i++) {
				const [x, y] = this.toDoc(NotebookView.at(samples, i));
				if (Number.isFinite(x) && Number.isFinite(y)) this.eraseTo(x, y);
			}
			return;
		}

		const markerPage = this.markers?.gesturePage ?? null;
		if (markerPage !== null) {
			const last = n > 0 ? NotebookView.at(samples, n - 1) : null;
			this.markers!.move(last ? this.toLocal(markerPage, last) : null, last);
			return;
		}
		const excerptPage = this.excerpts?.gesturePage ?? null;
		if (excerptPage !== null) {
			const last = n > 0 ? NotebookView.at(samples, n - 1) : null;
			this.excerpts!.move(last ? this.toLocal(excerptPage, last) : null, last);
			return;
		}

		const lt = this.lassoTap;
		if (lt && !lt.moved) {
			for (let i = 0; i < n; i++) if (Math.hypot(samples.x[i]! - lt.x, samples.y[i]! - lt.y) > TAP_SLOP_PX) lt.moved = true;
		}

		const lasso = this.lasso;
		if (lasso?.anchor) {
			// Rectangle selection: the box from where the pen went down to where it is now.
			const p = n > 0 ? this.toLocal(lasso.pageIndex, NotebookView.at(samples, n - 1)) : null;
			if (p) lasso.points = rectanglePolygon(lasso.anchor, p);
			this.renderer?.setLasso(lasso);
			return;
		}
		if (lasso) {
			const minStep = 2 / this.viewport.scale;
			for (let i = 0; i < n; i++) {
				const p = this.toLocal(lasso.pageIndex, NotebookView.at(samples, i));
				const last = lasso.points[lasso.points.length - 1]!;
				if (p && Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) lasso.points.push(p);
			}
			this.renderer?.setLasso(lasso);
			return;
		}

		const space = this.spaceDrag;
		if (space) {
			const page = this.pageAtIndex(space.pageIndex);
			const p = page && n > 0 ? this.toLocal(space.pageIndex, NotebookView.at(samples, n - 1)) : null;
			if (page && p) {
				space.delta = Math.max(-page.height, Math.min(page.height, p[1] - space.y));
				this.previewSpace(space);
			}
			return;
		}

		const lastSample = n > 0 ? NotebookView.at(samples, n - 1) : null;
		if (this.drag && this.selection && lastSample) {
			const p = this.toLocal(this.selection.pageIndex, lastSample);
			if (p) this.updateDrag(p);
			return;
		}

		const tap = this.textTap;
		if (tap) {
			for (let i = 0; i < n; i++) if (Math.hypot(samples.x[i]! - tap.x, samples.y[i]! - tap.y) > TAP_SLOP_PX) tap.moved = true;
			return;
		}

		const shape = this.shapeDrag;
		if (shape) {
			const p = lastSample ? this.toLocal(shape.pageIndex, lastSample) : null;
			if (p) {
				shape.b = p;
				this.pushShapeLive();
			}
			return;
		}

		const active = this.active;
		// After a shape was recognised the pen only has to be lifted.
		if (!active || active.recognized || !active.wet) return;
		this.writeSamples(active, samples, predicted);
	}

	/**
	 * The writing hot path: filter, convert to page coordinates, store, and paint the new ink right
	 * away (no animation frame). No object is created per sample (except with the ruler).
	 */
	private writeSamples(active: ActiveStroke, samples: SampleBuffer, predicted: SampleBuffer): void {
		const t0 = performance.now();
		const box = this.layout?.boxes[active.pageIndex];
		if (!box) return;
		const { scale, offsetX, offsetY } = this.viewport;
		const ink = this.ink;
		const type = samples.pointerType;
		const n = samples.count;
		for (let i = 0; i < n; i++) {
			const rx = samples.x[i]!, ry = samples.y[i]!, t = samples.t[i]!;
			let ax = (rx - offsetX) / scale - box.x;
			let ay = (ry - offsetY) / scale - box.y;
			// A single non-finite point would make every later save fail validation.
			if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
			this.filter.filter(rx, ry, t);
			let fx = (this.filter.x - offsetX) / scale - box.x;
			let fy = (this.filter.y - offsetY) / scale - box.y;
			if (active.snap) {
				[ax, ay] = this.snapToRuler(active, ax, ay);
				[fx, fy] = this.snapToRuler(active, fx, fy);
			}
			const p = this.pressure.sample(type, samples.p[i]!, rx, ry, t);
			active.rawX = ax;
			active.rawY = ay;
			active.rawP = p;
			if (ink.distanceToLast(fx, fy) >= active.minStep) ink.add(fx, fy, p);
			this.hold.push(rx, ry, t0);
			if (active.tried && Math.hypot(rx - active.tried.x, ry - active.tried.y) > HOLD_RADIUS_PX) active.tried = null;
		}
		const wet = this.renderer?.wetInk;
		if (!wet) {
			this.showLiveFallback(active);
			return;
		}
		// Tip: up to the raw pen position, then the predicted samples (drawn, never stored).
		wet.clearExtra();
		wet.pushExtra(active.rawX, active.rawY, active.rawP);
		if (!active.snap) {
			for (let i = 0; i < predicted.count; i++) {
				const px = (predicted.x[i]! - offsetX) / scale - box.x;
				const py = (predicted.y[i]! - offsetY) / scale - box.y;
				if (Number.isFinite(px) && Number.isFinite(py)) wet.pushExtra(px, py, active.rawP);
			}
		}
		if (!this.renderer!.paintWet()) this.showLiveFallback(active);
		if (this.host.settings.perfOverlay) {
			const now = performance.now();
			this.perfProcess.push(now - t0);
			if (n > 0) this.perfPaint.push(Math.max(0, now - samples.t[n - 1]!));
			this.renderer!.requestFrame();
		}
	}

	/**
	 * Safe path when wet ink is not available (it failed, or there is no page transform): the stroke
	 * in progress is drawn on the live layer at the next animation frame, like before the writing
	 * engine. Slower, but the pen always leaves ink.
	 */
	private showLiveFallback(active: ActiveStroke): void {
		if (!this.renderer) return;
		active.liveFallback = true;
		const points = this.ink.toPoints();
		points.push([active.rawX, active.rawY, active.rawP]);
		const { tool, color, width } = active.stroke;
		this.renderer.setLive({ pageIndex: active.pageIndex, tool, color, width, points, predicted: [] });
	}

	/**
	 * v10: how far (CSS px) what the contact in progress drew reaches: every point of the stroke and where the pen is
	 * now (the lift), a shape's drag, a text tap that moved. A badge tap is only a contact that reaches no further than
	 * a tap may move.
	 */
	private contactExtentPx(): number {
		const s = this.viewport.scale;
		const active = this.active;
		if (active) {
			const points = active.wet ? this.ink.toPoints() : active.stroke.points;
			let minX = active.rawX, maxX = active.rawX, minY = active.rawY, maxY = active.rawY;
			for (const [x, y] of points) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			return Math.hypot(maxX - minX, maxY - minY) * s;
		}
		const shape = this.shapeDrag;
		if (shape) return Math.hypot(shape.b[0] - shape.a[0], shape.b[1] - shape.a[1]) * s;
		if (this.textTap?.moved) return Infinity;
		return 0;
	}

	private drawEnd(cancelled: boolean): void {
		// Only what this gesture commits (addStrokes) is "just committed".
		this.justCommitted = null;
		// v10: a short unmoved contact on an excerpt's badge was a tap: what it drew (a dot) is dropped, then the jump.
		const badgeTap = this.excerpts?.takeBadgeTap(cancelled, performance.now(), () => this.contactExtentPx()) ?? null;
		// 0.19 (#103): the same for a checkbox: a short unmoved contact on it was a tap.
		const boxTap = this.checklist?.takeTap(cancelled, performance.now(), () => this.contactExtentPx()) ?? null;
		this.endGesture(cancelled || badgeTap !== null || boxTap !== null);
		if (boxTap) this.checklist?.toggle(boxTap);
		if (badgeTap) this.excerpts?.openSource(badgeTap);
		// An external change seen during the gesture was postponed; check it now.
		this.session?.gestureEnded();
		// 0.14: the first stroke written during an automatic lecture is what adds its page (view/lecture-mode.ts). Deferred past the
		// pointer handler so the contact is over; the document is only touched through the usual edit context.
		const committed = this.committedIds();
		if (!cancelled && badgeTap === null && boxTap === null && committed) {
			window.setTimeout(() => {
				this.lectureMode?.wrote();
				this.noteWrittenForSlideBack(committed);
			}, 0);
		}
	}

	/** Ids of the ink the last contact committed, or null (a method, so the callers' narrowing of the field does not apply). */
	private committedIds(): ReadonlySet<string> | null {
		return this.justCommitted?.ids ?? null;
	}

	/** 0.21 (#225): the ink just written (on the page in view or a neighbour) is the place the pill leads back to. */
	private noteWrittenForSlideBack(ids: ReadonlySet<string>): void {
		const pages = this.session?.doc?.pages;
		if (!pages || !this.slideBack) return;
		const at = this.currentPageIndex();
		for (const i of [at, at - 1, at + 1]) {
			const page = pages[i];
			if (page && page.strokes.some((s) => ids.has(s.id))) {
				this.slideBack.wrote(page, ids);
				return;
			}
		}
	}

	/** 0.21 (#225): the command; true when there was a place to go back to. */
	backToSlide(): boolean {
		return this.slideBack?.goBack() ?? false;
	}

	private endGesture(cancelled: boolean): void {
		if (this.pdfText?.end(cancelled)) return;
		if (this.markers?.end(cancelled)) return;
		if (this.excerpts?.end(cancelled)) return;
		if (this.penGestures?.active) {
			this.penGestures.end(cancelled);
			return;
		}
		this.clearDwell();
		const erasing = this.erasing;
		if (erasing) {
			this.erasing = null;
			if (erasing.commands.length > 0) {
				// 0.15 (241): the pieces a cut stroke left stay in its part, in the same undo step.
				const doc = this.session?.doc;
				const kept = doc ? statesAfterCuts(doc, erasing.commands) : [];
				if (doc) for (const c of kept) c.apply(doc);
				this.history.record(new Batch("Erase", [...erasing.commands, ...kept]));
				this.markChanged();
				this.updateHistoryButtons();
				this.scheduleNavRefresh();
			}
			return;
		}

		const space = this.spaceDrag;
		if (space) {
			this.spaceDrag = null;
			this.renderer?.setLasso(null);
			this.renderer?.setSpacePreview(null);
			if (!cancelled) this.commitSpace(space);
			return;
		}

		const lasso = this.lasso;
		if (lasso) {
			this.lasso = null;
			this.renderer?.setLasso(null);
			const page = this.pageAtIndex(lasso.pageIndex);
			if (cancelled || !page || (!lasso.erase && this.selectByTaps(cancelled))) {
				this.lassoTap = null;
				return;
			}
			if (lasso.erase) this.eraseArea(lasso, page);
			else this.selectFromLasso(lasso, page);
			return;
		}

		if (this.drag) {
			this.drag = null;
			this.endSnap();
			if (this.selectByTaps(cancelled)) return;
			this.commitSelectionTransform();
			return;
		}

		const tap = this.textTap;
		if (tap) {
			this.textTap = null;
			if (!cancelled && !tap.moved) this.beginText(tap.pageIndex, tap.local);
			return;
		}

		const shape = this.shapeDrag;
		if (shape) {
			this.shapeDrag = null;
			this.renderer?.setLive(null);
			if (!cancelled) this.commitShape(shape);
			return;
		}

		const active = this.active;
		this.active = null;
		this.stopHold();
		const page = active && this.pageAtIndex(active.pageIndex);
		if (!active || cancelled || !page) {
			this.renderer?.cancelWet();
			this.renderer?.setLive(null);
			return;
		}
		if (active.wet) {
			if (this.eraseByScribble(active, page)) return;
			// The line ends where the pen lifted (the filtered position may trail it slightly).
			this.ink.add(active.rawX, active.rawY, active.rawP);
			this.ink.finish();
			const stroke = freezeStroke({ ...active.stroke, points: this.ink.toPoints() });
			const snapped = this.reading?.snapStroke(page, stroke);
			if (snapped) {
				// Snap to text lines: straight highlights replace the hand-drawn stroke in the same undo step.
				this.renderer?.cancelWet();
				this.addStrokes(active.pageIndex, page, snapped);
				if (active.liveFallback) this.renderer?.setLive(null);
				return;
			}
			// The wet canvas shows exactly this geometry; the static layer takes it over without a change.
			this.renderer?.endWet(stroke);
			this.addStrokes(active.pageIndex, page, [stroke]);
			this.updateGhostLines(active.pageIndex, page, stroke.tool);
			if (active.liveFallback) this.renderer?.setLive(null);
			const box = this.layout?.boxes[active.pageIndex];
			if (box) {
				// wave 0.10 (353): on ruled or grid paper a stroke that ends at the right margin moves the view to the next line.
				const lineBreak = this.host.settings.autoLineBreak
					? lineBreakTarget({ tipX: active.rawX, tipY: active.rawY, box, paper: page.paper, viewport: this.viewport, view: this.viewSize })
					: null;
				this.gestures?.strokeEnded((box.y + active.rawY) * this.viewport.scale + this.viewport.offsetY, lineBreak);
			}
			return;
		}
		this.renderer?.setLive(null);
		const stroke = freezeStroke(active.stroke);
		const snapped = this.reading?.snapStroke(page, stroke);
		if (snapped) {
			this.addStrokes(active.pageIndex, page, snapped);
			return;
		}
		const extras = active.extra.map((points) => freezeStroke({ ...active.stroke, id: createId(), points }));
		this.addStrokes(active.pageIndex, page, [stroke, ...extras]);
		this.updateGhostLines(active.pageIndex, page, stroke.tool);
	}

	/**
	 * 0.20 (#94): after a pen stroke ends on blank paper, infers the line of writing from the newest strokes and shows the ghost
	 * guides (only on the live layer, never saved). Once per stroke, on the newest strokes only; nothing runs per frame.
	 */
	private updateGhostLines(pageIndex: number, page: Page, tool: Tool): void {
		const renderer = this.renderer;
		const mode = this.host.settings.ghostLines;
		if (!renderer || tool !== "pen") return;
		if (!ghostApplies(mode, page.paper.kind)) {
			renderer.setGhost(null);
			return;
		}
		const boxes: GhostBox[] = [];
		for (let i = page.strokes.length - 1; i >= 0 && boxes.length < GHOST_MAX_STROKES; i--) {
			const s = page.strokes[i]!;
			if (s.tool === "pen" && !s.hidden) boxes.push(renderer.boundsOf(s));
		}
		boxes.reverse();
		const lines = inferGhostLines(boxes, ghostSpacingPt(this.host.settings.ghostSpacing));
		const segments = lines ? ghostSegments(lines, page.width, page.height) : [];
		renderer.setGhost(segments.length > 0 ? { pageIndex, segments, mode, since: performance.now() } : null);
	}

	/**
	 * Scribble to erase (setting): a fast back-and-forth scratch over existing ink deletes the strokes it
	 * crosses, as one undo step, and the scribble itself is not kept. Returns true when it did.
	 */
	private eraseByScribble(active: ActiveStroke, page: Page): boolean {
		if (!this.host.settings.scribbleErase || active.stroke.tool !== "pen" || active.snap || active.recognized || !this.renderer) return false;
		const stroke = freezeStroke({ ...active.stroke, points: this.ink.toPoints() });
		// v8: hidden ink (the solutions) is never scratched out while it is not shown.
		const steps = scribbleEraseSteps(page, stroke, performance.now() - this.strokeStart, this.renderer.boundsOf, {}, this.markers?.isRevealed(page) ?? false);
		if (!steps) return false;
		this.clearSelection();
		this.renderer.cancelWet();
		this.renderer.setLive(null);
		// The scribble is in the history as the user's stroke, so Undo after a false positive gives it back.
		this.history.execute(steps.keep);
		this.history.execute(steps.erase);
		this.renderer.invalidate();
		this.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
		return true;
	}

	/** Commits strokes drawn on a page as one undo step; an infinite page grows in the same step. */
	private addStrokes(pageIndex: number, page: Page, drawn: Stroke[], offerChecklist = true): void {
		// 0.14 slides (#226): ink written while a slide is beside the notes remembers it, in the same undo step. The renderer
		// still gets the strokes it drew (`drawn`, same geometry): the wet ink hands over to exactly those objects.
		const linked = this.session?.doc ? linkToSlide(this, this.session.doc, drawn, this.host.settings.slideInkLink) : null;
		const strokes = linked?.strokes ?? drawn;
		const commands: Command[] = [...(linked?.commands ?? []), ...strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i))];
		let grew = false;
		if (page.infinite && this.renderer) {
			const maxY = Math.max(...strokes.map((s) => this.renderer!.boundsOf(s).maxY));
			const height = growForInfinite(page, { maxY });
			if (height !== null) {
				commands.push(new SetPageSize(page.id, { width: page.width, height: page.height }, { width: page.width, height }));
				grew = true;
			}
		}
		// Writing near the bottom of the last page appends a page in the same undo step.
		const doc = this.session?.doc;
		if (doc && this.renderer) {
			const maxY = Math.max(...strokes.map((s) => this.renderer!.boundsOf(s).maxY));
			if (needsNextPage(page, doc.pages[doc.pages.length - 1] === page, maxY, this.host.settings.autoNextPage)) {
				commands.push(new AddPage(createPage({ width: page.width, height: page.height }, { ...page.paper }), doc.pages.length));
				grew = true;
			}
		}
		const cmd = commands.length === 1 ? commands[0]! : new Batch("Draw", commands);
		this.justCommitted = this.history.execute(cmd) ? { ids: new Set(strokes.map((s) => s.id)), cmd } : null;
		this.penLinks?.strokesAdded(pageIndex);
		if (offerChecklist) this.checklist?.strokesAdded(pageIndex, strokes);
		// Reaching the bottom of a page in the middle: offer (never add) a page right after it.
		if (doc && this.renderer && !grew) {
			const maxY = Math.max(...strokes.map((s) => this.renderer!.boundsOf(s).maxY));
			if (needsPageOffer(page, doc.pages[doc.pages.length - 1] === page, maxY, this.host.settings.autoNextPage)) this.pageOffer?.offer(page.id);
		}
		if (grew) {
			this.afterHistoryChange();
			return;
		}
		for (const s of drawn) this.renderer?.appendStroke(pageIndex, s);
		this.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	private commitShape(shape: ShapeDrag): void {
		const page = this.pageAtIndex(shape.pageIndex);
		if (!page) return;
		const points = shapePoints(this.tools.shapeKind, shape.a, shape.b, this.tools.penWidth, this.shiftDown);
		if (points.length < 2) return;
		const stroke = freezeStroke(createStroke(this.tools.penColor, this.tools.penWidth, points, "shape"));
		this.addStrokes(shape.pageIndex, page, [stroke], false);
	}

	private pushLive(): void {
		const a = this.active;
		if (!a) return;
		this.renderer?.setLive({
			pageIndex: a.pageIndex, tool: a.stroke.tool, color: a.stroke.color, width: a.stroke.width,
			points: a.stroke.points, predicted: [],
		});
	}

	private pushShapeLive(): void {
		const s = this.shapeDrag;
		if (!s) return;
		this.renderer?.setLive({
			pageIndex: s.pageIndex, tool: "shape", color: this.tools.penColor, width: this.tools.penWidth,
			points: shapePoints(this.tools.shapeKind, s.a, s.b, this.tools.penWidth, this.shiftDown), predicted: [],
		});
	}

	// --- shape recognition ---

	private startHold(): void {
		if (this.holdTimer === null) this.holdTimer = window.setInterval(() => this.checkHold(), 100);
	}

	private stopHold(): void {
		if (this.holdTimer !== null) window.clearInterval(this.holdTimer);
		this.holdTimer = null;
		this.hold.clear();
	}

	/** The pen has been still for 0.6 s: if the stroke so far is clearly a shape, it becomes a clean one. */
	private checkHold(): void {
		const a = this.active;
		if (!a || a.recognized || a.tried || !a.wet) return;
		if (!this.hold.isHold(performance.now(), HOLD_MS, HOLD_RADIUS_PX)) return;
		a.tried = { x: this.hold.lastX(), y: this.hold.lastY() };
		const shape = recognizeShape(this.ink.toPoints());
		const first = shape?.points[0];
		if (!shape || !first || first.length < 2) return;
		// Highlighter shapes stay highlighter strokes (translucent); pen shapes become constant-width "shape" ink.
		// Shapes keep the perfect-freehand geometry (render 1), drawn whole on the live layer.
		a.stroke = { ...a.stroke, tool: a.stroke.tool === "highlighter" ? "highlighter" : "shape", points: first, render: RENDER_FREEHAND };
		a.extra = shape.points.slice(1);
		a.wet = false;
		a.recognized = true;
		this.renderer?.cancelWet();
		this.pushLive();
		this.flashSnap();
	}

	/** Brief outline around the page and a short vibration: the stroke was turned into a shape. */
	private flashSnap(): void {
		this.stage.removeClass("is-snapped");
		void this.stage.offsetWidth; // restart the CSS animation
		this.stage.addClass("is-snapped");
		if (this.snapFlashTimer !== null) window.clearTimeout(this.snapFlashTimer);
		this.snapFlashTimer = window.setTimeout(() => {
			this.snapFlashTimer = null;
			this.stage.removeClass("is-snapped");
		}, 400);
		try {
			window.navigator.vibrate?.(12);
		} catch {
			// Vibration is optional.
		}
	}

	/** Erases along the eraser's movement to the document point (x, y), on the page under it. */
	private eraseTo(x: number, y: number): void {
		const erasing = this.erasing;
		const doc = this.session?.doc;
		const layout = this.layout;
		if (!erasing || !doc || !layout || !this.renderer) return;
		const [px, py] = erasing.last;
		erasing.last = [x, y];
		const radius = eraserRadiusPt(this.tools.eraserSize, this.viewport.scale);
		const pageIndex = pageAt(layout, x, y, radius);
		const page = doc.pages[pageIndex];
		const box = layout.boxes[pageIndex];
		if (!page || !box) return;
		// 0.16 (#124): the eraser leaves a locked page alone.
		if (page.locked) {
			this.pagesLocked([page.id]);
			return;
		}
		const [ax, ay] = toPageLocal(box, px, py);
		const [bx, by] = toPageLocal(box, x, y);
		const hits = findHitStrokes(filterErasable(this.inkInView(page), this.eraseFilter()), ax, ay, bx, by, radius, this.renderer.boundsOf);
		let changed = false;
		for (const stroke of hits) {
			if (erasing.spare?.has(stroke.id)) continue;
			const index = page.strokes.indexOf(stroke);
			if (index < 0) continue;
			let after: Stroke[] = [];
			if (this.tools.eraserMode === "segment") {
				const runs = eraseSegment(stroke, ax, ay, bx, by, radius, this.renderer.boundsOf(stroke));
				if (runs === null) continue;
				after = strokePieces(page, stroke, runs);
			}
			const cmd = new ReplaceStroke(page.id, stroke, after, index);
			cmd.apply(doc);
			erasing.commands.push(cmd);
			changed = true;
		}
		if (changed) this.renderer.invalidate();
	}

	/** Which ink the eraser may touch (selective eraser). */
	private eraseFilter(): { kind: ToolbarState["eraserFilter"]; color: string } {
		return { kind: this.tools.eraserFilter, color: this.tools.eraserColor };
	}

	/** Eraser Area mode: erases everything inside the outline (one undo step); text and images only if the setting is on. */
	private eraseArea(lasso: Lasso, page: Page): void {
		const revealed = this.markers?.isRevealed(page) ?? false;
		const spare = lasso.spare;
		const cmd = eraseAreaCommand(page, lasso.points, {
			filter: this.eraseFilter(),
			skip: revealed && !spare ? undefined : (s) => (!revealed && !!s.hidden) || !!spare?.has(s.id),
			includeElements: this.host.settings.eraseAreaElements,
			measure: measureText,
		});
		if (!cmd) return;
		// 0.15 (241): the pieces a cut stroke left stay in its part, in the same undo step.
		const doc = this.session?.doc;
		const kept = doc ? statesAfterCuts(doc, [cmd]) : [];
		this.history.execute(kept.length > 0 ? new Batch("Erase area", [cmd, ...kept]) : cmd);
		this.renderer?.invalidate();
		this.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	// --- pen gestures (roadmap 139; recognition in ink/gestures/, overlay in view/pen-gestures.ts) ---

	/** Gesture mode on or off: while on, every pen stroke is a gesture (the toolbar menu, the command). */
	togglePenGestureMode(): void {
		this.penGestures?.toggleMode();
	}

	get penGestureMode(): boolean {
		return this.penGestures?.mode === true;
	}

	openGestureCheatSheet(): void {
		new GestureCheatSheet(this.gestureUiHost()).open();
	}

	openCustomGestures(): void {
		new CustomGesturesModal(this.gestureUiHost()).open();
	}

	/** What the gesture dialogs need: the app and the settings with a validated setter (the plugin saves and re-applies them). */
	gestureUiHost(): PenGestureUiHost {
		return {
			app: this.app,
			get: () => this.host.settings,
			set: async (key, value) => {
				// Same rule as the settings tab: readSettings drops values of the wrong type.
				this.host.settings = readSettings({ ...this.host.settings, [key]: value });
				await this.host.saveSettings?.();
			},
		};
	}

	/** The view as the gesture actions see it. */
	private gestureView(): PenGestureView {
		return {
			app: this.app,
			settings: () => this.host.settings,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable(),
			pageIndexAt: (p) => {
				const layout = this.layout;
				if (!layout) return -1;
				const [x, y] = this.toDoc(p);
				return Number.isFinite(x) && Number.isFinite(y) ? pageAt(layout, x, y, 0) : -1;
			},
			toLocal: (pageIndex, p) => this.toLocal(pageIndex, p),
			stageRect: () => this.stage.getBoundingClientRect(),
			boundsOf: () => this.renderer?.boundsOf,
			revealed: (page) => this.markers?.isRevealed(page) ?? false,
			selection: () => this.selection,
			selectionHit: (pageIndex, local) => this.selection?.pageIndex === pageIndex && this.selectionHit(local) !== null,
			selectPolygon: (pageIndex, polygon) => {
				const page = this.pageAtIndex(pageIndex);
				if (page) this.selectFromLasso({ pageIndex, points: polygon }, page);
			},
			clearSelection: () => this.clearSelection(),
			penStyle: () => ({ color: this.tools.penColor, width: this.tools.penWidth }),
			execute: (commands) => {
				this.commitText();
				for (const c of commands) this.history.execute(c);
				this.renderer?.invalidate();
				this.afterHistoryChange();
			},
			editTags: (page) => editPageTags(this.outlineHost(), page),
			openSearch: () => this.reading?.openSearch(),
		};
	}

	/**
	 * Long-press trigger (setting, off by default): an ink stroke whose nib stays within a few px of the first contact for
	 * about 0.65 s turns into a gesture the moment the timer fires; the dot written so far is dropped.
	 */
	private armDwell(sample: InkSample, eraser: boolean, held: boolean, inkTool: string): void {
		this.clearDwell();
		if (!dwellMayStart({
			enabled: this.host.settings.penGestureLongPress, pointerType: sample.pointerType, eraser, held,
			modeOn: this.penGestures?.mode === true, inking: inkTool === "pen" || inkTool === "highlighter",
		})) return;
		const tracker = new DwellTracker();
		tracker.begin(sample.x, sample.y, performance.now());
		this.dwell = { tracker, timer: window.setTimeout(() => this.dwellElapsed(sample), DWELL_MS) };
	}

	private watchDwell(samples: SampleBuffer): void {
		const d = this.dwell;
		if (!d) return;
		for (let i = 0; i < samples.count; i++) d.tracker.move(samples.x[i]!, samples.y[i]!);
		if (!d.tracker.resting) this.clearDwell();
	}

	private clearDwell(): void {
		if (!this.dwell) return;
		window.clearTimeout(this.dwell.timer);
		this.dwell.tracker.end();
		this.dwell = null;
	}

	private dwellElapsed(sample: InkSample): void {
		const d = this.dwell;
		this.dwell = null;
		if (!d || !d.tracker.ready(performance.now()) || !this.active || !this.penGestures) return;
		// The ink written so far is only the dot of the first contact: drop it, no undo step, nothing saved.
		this.active = null;
		this.stopHold();
		this.renderer?.cancelWet();
		this.renderer?.setLive(null);
		this.clearSelection();
		this.penGestures.start(sample.x, sample.y, performance.now());
		try {
			navigator.vibrate?.(20);
		} catch {
			// No haptics here.
		}
	}

	// --- heavy page warning (wave 0.7: lod) ---

	/** Looks at the page in view a moment from now (never while writing): too many strokes, points or image bytes show the banner. */
	private scheduleHeavyCheck(): void {
		if (this.heavyTimer !== null || !this.heavy) return;
		this.heavyTimer = window.setTimeout(() => {
			this.heavyTimer = null;
			if (this.active || this.erasing) this.scheduleHeavyCheck();
			else this.checkHeavyPage();
		}, 800);
	}

	private checkHeavyPage(): void {
		const doc = this.session?.doc;
		const heavy = this.heavy;
		if (!heavy) return;
		const index = this.currentPageIndex();
		const page = doc?.pages[index];
		const was = this.heavyPageId;
		this.heavyPageId = null;
		if (!doc || !page || this.session?.mode === "broken") return this.heavyChecked(was, () => heavy.hide());
		const load = pageLoad(page, doc.assets);
		const reasons = heavyReasons(load);
		if (reasons.length === 0) return this.heavyChecked(was, () => heavy.hide());
		const items = page.strokes.length + (page.elements?.length ?? 0);
		const canSplit = this.editable() && !page.background && items >= 2;
		// ui redesign: a heavy page offers "Split page" in its page sheet too, also after the banner was dismissed.
		if (canSplit) this.heavyPageId = page.id;
		this.heavyChecked(was, () => (this.heavyDismissed.has(page.id) ? heavy.hide() : heavy.show({ pageIndex: index, load, reasons, canSplit })));
	}

	/** Shows or hides the banner and refreshes the UI when the heavy page changed. */
	private heavyChecked(was: string | null, banner: () => void): void {
		banner();
		if (was !== this.heavyPageId) this.refreshUi();
	}

	/** Moves the lower half of the page to a new page after it, in one undo step (see planPageSplit). */
	/** Splits a heavy page in two (banner and page sheet). */
	splitHeavyPage(index: number): void {
		const doc = this.session?.doc;
		const page = doc?.pages[index];
		if (!doc || !page || !this.editable()) return;
		const plan = planPageSplit(page, index, doc.assets, measureText, this.renderer?.boundsOf);
		if (!plan) {
			showNotice(t("heavy.split.none"));
			return;
		}
		this.clearSelection();
		this.history.execute(pageContentCommand(doc, plan, "Split page"));
		this.renderer?.invalidate();
		this.afterHistoryChange();
		this.heavy?.hide();
		showNotice(t("heavy.split.done", { n: String(index + 2) }));
		this.scheduleHeavyCheck();
	}

	// --- insert or remove space ---

	/**
	 * Live preview: the content below the line is drawn shifted by the amount that will really be applied
	 * (limited when removing), with the band that is added or removed as a dashed rectangle.
	 */
	private previewSpace(drag: SpaceDrag): void {
		const doc = this.session?.doc;
		const page = this.pageAtIndex(drag.pageIndex);
		if (!doc || !page) return;
		const a = analyseSpace(doc.pages, drag.pageIndex, drag.y, drag.delta, measureText, this.renderer?.boundsOf);
		this.renderer?.setSpacePreview(a ? spacePreview(a) : null);
		const y1 = drag.y + (a ? a.delta : 0);
		this.renderer?.setLasso({
			pageIndex: drag.pageIndex,
			points: [[0, drag.y], [page.width, drag.y], [page.width, y1], [0, y1], [0, drag.y]],
		});
	}

	/** Moves everything below the line in one undo step (see planSpaceChange); overflow goes onto the next page, created if needed. */
	private commitSpace(drag: SpaceDrag): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable()) return;
		const plan = planSpaceChange(doc.pages, drag.pageIndex, drag.y, drag.delta, measureText, this.renderer?.boundsOf);
		if (!plan) {
			// A deliberate drag that moved nothing deserves an explanation; a tap does not.
			if (Math.abs(drag.delta) * this.viewport.scale >= TAP_SLOP_PX) showNotice(t("space.nothing"));
			return;
		}
		this.history.execute(pageContentCommand(doc, plan, plan.delta > 0 ? "Insert space" : "Remove space"));
		this.renderer?.invalidate();
		this.afterHistoryChange();
	}

	// --- selection ---

	private clearSelection(): void {
		if (!this.selection && !this.drag) return;
		this.selection = null;
		this.drag = null;
		this.renderer?.setSelection(null);
		this.refreshUi();
	}

	private pushSelection(): void {
		const sel = this.selection;
		// Ink written on the selected objects floats with them (setting "Ink follows objects").
		const across = sel?.others?.length ? this.crossPageInk(sel) : null;
		const pinnedHidden = sel ? hiddenStickyInk(this.pageAtIndex(sel.pageIndex)?.elements) : null;
		const floating = sel ? (across ? across[0] ?? [] : this.attachedInk(sel)) : [];
		// 0.17 (#20): the ink a collapsed note keeps hidden moves with it but is not drawn while it floats.
		const attached = pinnedHidden ? floating.filter((s) => !pinnedHidden.has(s.id)) : floating;
		const boxes = this.layout?.boxes ?? [];
		const parts = sel?.others?.map((o, i) => {
			const extra = across?.[i + 1] ?? [];
			return { ...o, strokes: extra.length > 0 ? [...o.strokes, ...extra] : o.strokes, offset: frameOffset(boxes, sel.pageIndex, o.pageIndex) };
		});
		this.renderer?.setSelection(sel ? { ...sel, parts, strokes: attached.length > 0 ? [...sel.strokes, ...attached] : sel.strokes, handle: HANDLE_PX } : null);
		this.refreshUi();
	}

	/**
	 * Lasso tool: a double tap selects the word under the finger or pen, a triple tap its line (found
	 * geometrically, see ink/words.ts). The result is an ordinary selection. Returns true when it
	 * made one; a single tap, a moved contact or a tap away from any ink falls through to the normal
	 * lasso/drag handling.
	 */
	private selectByTaps(cancelled: boolean): boolean {
		const tap = this.lassoTap;
		this.lassoTap = null;
		if (!tap || cancelled || tap.moved) {
			this.multiTap.reset();
			return false;
		}
		const count = this.multiTap.tap(tap.t, tap.x, tap.y);
		const page = this.pageAtIndex(tap.pageIndex);
		if (count < 2 || !page) return false;
		let cache = this.textLayouts.get(page);
		if (!cache) this.textLayouts.set(page, (cache = new TextLayoutCache()));
		const layout = cache.get(page.strokes);
		const tol = WORD_TAP_PX / this.viewport.scale;
		const [x, y] = tap.local;
		const ids = count === 2 ? wordAt(layout, x, y, tol)?.word.strokeIds : lineAt(layout, x, y, tol)?.strokeIds;
		if (!ids) return false;
		const wanted = new Set(ids);
		const strokes = this.inkInView(page).filter((s) => wanted.has(s.id));
		const bounds = unionBounds(strokes, [], measureText);
		if (!bounds) return false;
		this.drag = null;
		this.selection = { pageIndex: tap.pageIndex, strokes, elements: [], bounds, matrix: IDENTITY };
		this.pushSelection();
		return true;
	}

	/** Selects the strokes and elements inside the lasso; a tap (a lasso too small to enclose anything) picks the element under it. */
	private selectFromLasso(lasso: Lasso, page: Page): void {
		const xs = lasso.points.map((p) => p[0]);
		const ys = lasso.points.map((p) => p[1]);
		const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
		let strokes: Stroke[] = [];
		let elements: PageElement[] = [];
		if (extent * this.viewport.scale < TAP_SLOP_PX) {
			const p = lasso.points[0]!;
			const tol = 6 / this.viewport.scale;
			const el = hitElement(page.elements ?? [], p[0], p[1], tol, measureText);
			if (el) elements = [el];
			else {
				// 0.20 (#39): a member of a group that is hit by the tap is picked too (loose ink is not selected by a tap), and a locked
				// element is not selected: a chip says so and offers Unlock.
				const grouped = this.inkInView(page).filter((s) => s.group !== undefined);
				const hit = grouped.length > 0 ? findHitStrokes(grouped, p[0], p[1], p[0], p[1], tol).pop() : undefined;
				if (hit) strokes = [hit];
				else {
					const locked = hitLockedElement(page.elements ?? [], p[0], p[1], tol, measureText);
					if (locked) this.groups?.showLocked(lasso.pageIndex, locked, p);
				}
			}
		} else {
			// wave 0.10 (359): a lasso that reaches over a page boundary selects on every page it touches.
			const touched = pagesTouchedBy(this.layout?.boxes ?? [], lasso.points, lasso.pageIndex);
			if (touched.some((i) => i !== lasso.pageIndex) && this.selectAcrossPages(lasso)) return;
			strokes = strokesInLasso(this.inkInView(page), lasso.points);
			elements = elementsInLasso(page.elements ?? [], lasso.points, measureText);
		}
		// 0.20 (#39): picking one member of a group picks all of them.
		({ strokes, elements } = expandToGroups(page, { strokes, elements }, this.inkInView(page)));
		const bounds = unionBounds(strokes, elements, measureText);
		if (!bounds) return;
		this.groups?.hideChip();
		this.selection = { pageIndex: lasso.pageIndex, strokes, elements, bounds, matrix: IDENTITY };
		this.pushSelection();
		hint("lasso-selected");
	}

	/** wave 0.10 (359): the selection of a lasso over several pages. False when it encloses nothing on any of them. */
	private selectAcrossPages(lasso: Lasso): boolean {
		const doc = this.session?.doc;
		const boxes = this.layout?.boxes;
		if (!doc || !boxes) return false;
		const parts = selectAcrossPages({
			boxes, origin: lasso.pageIndex, polygon: lasso.points, measure: measureText,
			strokesOf: (i) => {
				const p = doc.pages[i];
				return p ? this.inkInView(p) : [];
			},
			elementsOf: (i) => doc.pages[i]?.elements ?? [],
		}).map((part) => {
			// 0.20 (#39): a group is picked whole on each page (a group never spans pages).
			const there = doc.pages[part.pageIndex];
			return there ? { ...part, ...expandToGroups(there, part, this.inkInView(there)) } : part;
		});
		const first = parts[0];
		if (!first) return false;
		const bounds = partsBounds(boxes, parts, first.pageIndex, measureText);
		if (!bounds) return false;
		this.selection = {
			pageIndex: first.pageIndex, strokes: first.strokes, elements: first.elements, bounds, matrix: IDENTITY,
			...(parts.length > 1 ? { others: parts.slice(1) } : {}),
		};
		this.pushSelection();
		return true;
	}

	private selectionHit(p: [number, number]): SelectionDrag["kind"] | null {
		const sel = this.selection;
		if (!sel) return null;
		const tol = HANDLE_PX / this.viewport.scale;
		const handles = selectionHandles(sel.bounds, sel.matrix, HANDLE_PX / this.viewport.scale);
		const near = (h: [number, number]) => Math.hypot(h[0] - p[0], h[1] - p[1]) <= tol;
		if (near(handles.scale)) return "scale";
		if (near(handles.rotate)) return "rotate";
		const [x, y] = apply(invert(sel.matrix), p[0], p[1]);
		const b = sel.bounds;
		const pad = tol / 2;
		return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad ? "move" : null;
	}

	private updateDrag(p: [number, number]): void {
		const sel = this.selection;
		const drag = this.drag;
		if (!sel || !drag) return;
		const b = sel.bounds;
		const m0 = drag.startMatrix;
		if (drag.kind === "move") {
			sel.matrix = multiply(translate(p[0] - drag.start[0], p[1] - drag.start[1]), m0);
		} else if (drag.kind === "scale") {
			const [ax, ay] = apply(m0, b.minX, b.minY);
			const d0 = Math.hypot(drag.start[0] - ax, drag.start[1] - ay);
			const d1 = Math.hypot(p[0] - ax, p[1] - ay);
			const k = d0 > 0 ? Math.min(20, Math.max(0.05, d1 / d0)) : 1;
			sel.matrix = multiply(scaleAbout(k, k, ax, ay), m0);
		} else {
			const [cx, cy] = apply(m0, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
			const angle = Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(drag.start[1] - cy, drag.start[0] - cx);
			sel.matrix = multiply(rotateAbout(angle, cx, cy), m0);
		}
		this.snapDrag(sel, drag, b);
		this.pushSelection();
	}

	// --- snap (0.17, #71) ---

	/** Builds the lines a drag snaps to when it starts: the grid of the paper and the edges and centres of the other items. */
	private beginSnap(drag: SelectionDrag, sel: Selection, pointerType: string): void {
		const strokes = new Set<Stroke>(sel.strokes);
		for (const s of this.attachedInk(sel)) strokes.add(s);
		// A rotation, a selection across pages, a switched-off snap and the states' part editor (pose drags) have nothing to snap to.
		const session = dragSnapSession({
			mode: this.host.settings.snapMode, kind: drag.kind, crossPage: !!sel.others?.length, ownedByStates: !!this.statesTools?.ownsSelection(sel),
			page: this.pageAtIndex(sel.pageIndex) ?? null, strokes, elements: new Set(sel.elements), measure: measureText,
		});
		if (session) drag.snap = { session, pointerType };
	}

	/** Pulls the dragged matrix onto the grid and the alignment lines, and sets the guides to draw. */
	private snapDrag(sel: Selection, drag: SelectionDrag, bounds: BBox): void {
		const snap = drag.snap;
		if (!snap || drag.kind === "rotate") return;
		if (this.snapPaused || this.snapHold.held(snap.pointerType)) {
			sel.guides = undefined;
			return;
		}
		const strength = this.host.settings.snapStrength;
		const r = snapDragged({
			kind: drag.kind, bounds, startMatrix: drag.startMatrix, matrix: sel.matrix, session: snap.session, mode: this.host.settings.snapMode,
			thr: strength / this.viewport.scale,
		});
		sel.matrix = r.matrix;
		sel.guides = r.guides.length > 0 ? r.guides : undefined;
	}

	/** The drag is over: the guides go (before the move is committed). */
	private endSnap(): void {
		const sel = this.selection;
		if (!sel?.guides) return;
		sel.guides = undefined;
		this.pushSelection();
	}

	/** The Snap button of the selection bar: snap on or paused for this view (the setting stays as it is). */
	toggleSnap(): void {
		this.snapPaused = !this.snapPaused;
		showNotice(t(this.snapPaused ? "snap.paused" : "snap.on"), 1800);
		this.refreshUi();
	}

	/** Applies the dragged transform to the document as one undoable step; the selection stays on the new strokes and elements. */
	private commitSelectionTransform(): void {
		const sel = this.selection;
		const page = sel && this.pageAtIndex(sel.pageIndex);
		if (!sel || !page || isIdentity(sel.matrix)) return;
		// 0.15 (241): the handles of a part in a state change the part's pose in that state, not the strokes.
		if (this.statesTools?.commitTransform(sel)) return;
		if (sel.others?.length) {
			this.commitCrossPageTransform(sel);
			return;
		}
		const present = sel.strokes.filter((s) => page.strokes.includes(s));
		const presentEls = sel.elements.filter((e) => page.elements?.includes(e));
		if (present.length === 0 && presentEls.length === 0) {
			this.clearSelection();
			return;
		}
		const onPage = new Set(page.strokes);
		const attached = this.attachedInk(sel).filter((s) => onPage.has(s));
		const plan = applyPlacement(page, present, presentEls, uniformPlacement(present, presentEls, attached, sel.matrix), measureText, "Transform selection");
		if (!plan) return;
		if (!this.history.execute(plan.command)) {
			// Refused (the content guard, or read-only): the document is unchanged, so the floating selection is dropped.
			this.clearSelection();
			this.renderer?.invalidate();
			return;
		}
		const moved = plan.strokes;
		const movedEls = plan.elements;
		sel.strokes = moved;
		sel.elements = movedEls;
		sel.matrix = IDENTITY;
		sel.bounds = unionBounds(moved, movedEls, measureText) ?? sel.bounds;
		this.pushSelection();
		this.renderer?.invalidate();
		this.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	/**
	 * wave 0.10 (359): applies the dragged transform to a selection across pages. Every item ends up on the page under it
	 * (items outside every page stay where they were); one undo step. The ink bound to a graph (and, with the setting "Ink
	 * follows objects", the ink written on an object) goes to the page its object goes to.
	 */
	private commitCrossPageTransform(sel: Selection): void {
		const doc = this.session?.doc;
		const boxes = this.layout?.boxes;
		if (!doc || !boxes) return;
		const plan = planCrossPageTransform({
			boxes, pages: doc.pages, primary: sel.pageIndex, parts: this.selectionParts(sel), matrix: sel.matrix, measure: measureText,
			followInk: this.host.settings.inkFollowsObjects,
		});
		if (!plan || !this.history.execute(plan.command)) {
			this.clearSelection();
			this.renderer?.invalidate();
			return;
		}
		const [first, ...rest] = plan.parts;
		const bounds = first ? partsBounds(boxes, plan.parts, first.pageIndex, measureText) : null;
		if (!first || !bounds) {
			this.clearSelection();
		} else {
			this.selection = {
				pageIndex: first.pageIndex, strokes: first.strokes, elements: first.elements, bounds, matrix: IDENTITY,
				...(rest.length > 0 ? { others: rest } : {}),
			};
			this.pushSelection();
		}
		this.renderer?.invalidate();
		this.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	// --- ink attached to objects (roadmap 149) ---

	/** wave 0.10 (359): per part of a selection across pages (the primary page first), the unselected ink that floats with its objects. */
	private crossPageInk(sel: Selection): Stroke[][] {
		return this.objectInk.attachedAcross(
			this.selectionParts(sel).map((part) => ({ part, page: this.pageAtIndex(part.pageIndex) ?? undefined })), this.host.settings.inkFollowsObjects,
		);
	}

	/** Strokes that float with the selection without being selected: the ink written on the selected objects (none when the setting is off). */
	private attachedInk(sel: Selection): Stroke[] {
		if (sel.others?.length) return [];
		const page = this.pageAtIndex(sel.pageIndex);
		if (!page) return [];
		// 0.17 (#20): the ink a collapsed sticky note keeps hidden is bound to it by the note's own list, whatever the setting says.
		if (!this.host.settings.inkFollowsObjects) return pinnedInk(page.strokes, sel.elements);
		return this.objectInk.attachedTo(page, sel);
	}

	/**
	 * After deleting objects that had ink on them: offers to delete that ink too (undone separately; ignored = the ink
	 * stays). One group per page; the offer is for all of them and skips a page whose object an undo brought back.
	 */
	private offerDeleteInk(groups: ReadonlyArray<{ page: Page; removed: readonly PageElement[]; owned: Stroke[] }>): void {
		this.objectInk.offerDelete(groups.reduce((n, g) => n + g.owned.length, 0), () => {
			const doc = this.session?.doc;
			if (!doc || !this.editable()) return;
			const commands: Command[] = [];
			for (const { page, removed, owned } of groups) {
				// Only while the objects are still deleted: an undo in between brings them back, and their ink stays where it is.
				if (!doc.pages.includes(page) || removed.some((e) => page.elements?.includes(e))) continue;
				const cmd = deleteInkCommand(page.id, page.strokes, owned);
				if (cmd) commands.push(cmd);
			}
			if (commands.length === 0) return;
			this.clearSelection();
			if (!this.history.execute(commands.length === 1 ? commands[0]! : new Batch("Delete ink on deleted objects", commands))) return;
			this.afterHistoryChange();
			this.renderer?.invalidate();
			showNotice(t("object.inkDeleted"));
		});
	}

	// --- stamps (roadmap 142) ---

	private mountStamps(): void {
		this.stamps = new StampPalette(this.body, {
			app: this.app,
			folder: () => this.host.settings.folder,
			editable: () => this.editable(),
			doc: () => this.session?.doc ?? null,
			captureSelection: () => this.captureSelectionClip(),
			penStyle: () => ({ color: this.tools.penColor, width: this.tools.penWidth }),
			viewTarget: () => this.pasteTarget(),
			pageAtClient: (x, y) => this.pageAtClient(x, y),
			execute: (cmd) => {
				this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
			},
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
		});
	}

	// --- symbols (roadmap 212) ---

	private mountSymbols(): void {
		this.symbols = new SymbolStrip(this.body, {
			app: this.app,
			folder: () => this.host.settings.folder,
			editable: () => this.editable(),
			doc: () => this.session?.doc ?? null,
			options: () => ({ show: this.host.settings.symbolStrip, count: this.host.settings.symbolCount }),
			style: () => ({ color: this.tools.penColor, width: this.tools.penWidth, textSize: this.tools.textSize }),
			pageAtClient: (x, y) => this.pageAtClient(x, y),
			policy: () => this.policy,
			captureSelection: () => this.captureSelectionClip(),
			execute: (cmd) => {
				this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
			},
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
		});
	}

	get symbolStripView(): SymbolStrip | null {
		return this.symbols;
	}

	private captureSelectionClip(): ClipContent | null {
		const sel = this.selection;
		const doc = this.session?.doc;
		const page = sel && doc?.pages[sel.pageIndex];
		if (!sel || !doc || !page) return null;
		if (sel.others?.length && this.layout) {
			return captureCrossPageClip(this.layout.boxes, doc.pages, this.selectionParts(sel), sel.pageIndex, doc.assets, measureText);
		}
		const elements = sel.elements.filter((e) => page.elements?.includes(e));
		return captureClip(withPinnedInk(page.strokes, sel.strokes.filter((s) => page.strokes.includes(s)), elements), elements, doc.assets, measureText);
	}

	/** The page under a screen point (CSS px of the window) and the point on it; null outside the page area. */
	private pageAtClient(clientX: number, clientY: number): StampTarget | null {
		const doc = this.session?.doc;
		const layout = this.layout;
		if (!doc || !layout) return null;
		const rect = this.stage.getBoundingClientRect();
		if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
		const [dx, dy] = screenToPage(this.viewport, clientX - rect.left, clientY - rect.top);
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
		let index = pageAt(layout, dx, dy);
		if (index < 0) index = nearestPage(layout, dy);
		const page = doc.pages[index];
		const box = layout.boxes[index];
		if (!page || !box) return null;
		const [x, y] = toPageLocal(box, dx, dy);
		return { pageIndex: index, page, x, y };
	}

	// --- selection actions: restyle, copy, cut, paste, duplicate, white to transparent ---

	private mountSelectionActions(): void {
		this.selectionActions = new SelectionActions(this.ui?.contextBar.extraEl ?? this.body, {
			app: this.app,
			folder: () => this.host.settings.folder,
			media: () => this.media,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable(),
			selection: () => this.selection,
			// 0.15 (241): the part editor's selection has no colour or width of its own (its handles set the pose).
			ownedByStates: (sel) => !!this.statesTools?.ownsSelection(sel),
			select: (pageIndex, strokes, elements, others) => this.selectItems(pageIndex, strokes, elements, others),
			execute: (cmd) => {
				if (!this.history.execute(cmd)) return false;
				this.afterHistoryChange();
				this.renderer?.invalidate();
				return true;
			},
			deleteSelection: () => this.deleteSelection(),
			boxes: () => this.layout?.boxes ?? [],
			sharedClips: () => this.host.sharedClips?.() ?? (this.sharedClipStore ??= new SharedClipStore(vaultDeviceFileAdapter(this.app), () => this.host.settings.folder, sidecarDeviceId(this.app))),
			pasteTarget: () => this.pasteTarget(),
			textStyle: () => ({ fontSize: this.tools.textSize, color: this.tools.penColor }),
			thumbnail: (page) => this.pageNav?.thumbnailOf(page) ?? BLANK_THUMBNAIL,
			goToPage: (index) => this.goToPage(index),
			clearSelection: () => this.clearSelection(),
			stillHere: (doc) => this.session?.doc === doc && this.editable() && !this.controller?.drawing,
		});
		this.arrange = new SelectionArrange({
			app: this.app,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable() && !this.controller?.drawing,
			selection: () => this.selection,
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
			execute: (cmd) => {
				if (!this.history.execute(cmd)) return false;
				this.afterHistoryChange();
				this.renderer?.invalidate();
				return true;
			},
			ink: (page) => this.inkInView(page),
			inkFollowsObjects: () => this.host.settings.inkFollowsObjects,
			currentPage: () => this.currentPageIndex(),
			anchor: (id) => {
				const el = this.ui?.contextBar.el.querySelector<HTMLElement>(`[data-action="${id}"]`);
				const r = el?.getBoundingClientRect();
				return r ? { x: r.left, y: r.top } : null;
			},
			run: (id) => this.runAction(id),
			commitText: () => this.commitText(),
		});
	}

	// --- links written with the pen (O8) ---

	private mountPenLinks(editor: TextEditor): void {
		this.penLinks = new PenLinks({
			app: this.app,
			sourcePath: () => this.file?.path ?? "",
			stage: () => this.stage,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable() && !this.controller?.drawing,
			execute: (cmd) => {
				this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
			},
			invalidate: () => this.renderer?.invalidate(),
			toStage: (pageIndex, x, y) => {
				const box = this.layout?.boxes[pageIndex];
				if (!box) return null;
				const { scale, offsetX, offsetY } = this.viewport;
				return [offsetX + (box.x + x) * scale, offsetY + (box.y + y) * scale];
			},
			pageAt: (clientX, clientY) => {
				const layout = this.layout;
				if (!layout) return null;
				const rect = this.stage.getBoundingClientRect();
				const [dx, dy] = this.toDoc({ x: clientX - rect.left, y: clientY - rect.top });
				const pageIndex = pageAt(layout, dx, dy, 0);
				const box = layout.boxes[pageIndex];
				return box ? { pageIndex, local: toPageLocal(box, dx, dy), scale: this.viewport.scale } : null;
			},
			fingerNavigates: (e) => this.policy.route("touch", e.timeStamp, 0, Math.max(e.width || 0, e.height || 0), e.buttons) === "navigate",
			tool: () => this.tools.tool,
			labelColor: () => this.tools.penColor,
			register: (ref) => this.registerEvent(ref),
		});
		this.penLinks.bindEditor(editor);
	}

	/** 0.20 (#107): "Open as reference" for the link in the selected text box: the note, notebook page, PDF or picture it names, in the floating window. */
	openSelectionReference(): void {
		const link = this.selection && this.penLinks?.linkIn(this.selection.elements);
		const file = link ? this.penLinks?.resolveFile(link) : null;
		if (!link || !file) {
			showNotice(t("refwin.linkMissing"));
			return;
		}
		const target = pageTargetFromSubpath(link.subpath);
		void this.openReference(file, { page: target?.page ?? null, pageId: target?.pageId ?? null });
	}

	/** Opens the link in the selected text box (the contextual bar's "Open link"). */
	openSelectionLink(): void {
		const link = this.selection && this.penLinks?.linkIn(this.selection.elements);
		if (link) this.penLinks?.open(link);
	}

	/** "Link…": attaches a note to the selected ink (a label above it that opens the note when tapped). */
	linkSelection(): void {
		const sel = this.selection;
		if (!sel || !this.editable() || this.controller?.drawing) {
			showNotice(t("penlinks.selectFirst"));
			return;
		}
		const bounds = unionBounds(sel.strokes, sel.elements, measureText);
		if (bounds) this.penLinks?.linkRegion(sel.pageIndex, bounds);
	}

	/** Selects exactly these items (the lasso tool is switched on, so they can be moved at once). */
	private selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[], others?: PagePart[]): void {
		this.commitText();
		this.toolbar.setTool("lasso");
		// 0.20 (#39): a locked element is never part of a selection, whoever asks (it cannot be moved, resized or erased).
		// A group it touches is completed (as the lasso does), so a move, cut or delete never splits one.
		const settle = (index: number, sel: { strokes: Stroke[]; elements: PageElement[] }): { strokes: Stroke[]; elements: PageElement[] } => {
			const page = this.pageAtIndex(index);
			return page ? selectableItems(page, sel, this.inkInView(page)) : { strokes: sel.strokes, elements: [...unlockedElements(sel.elements)] };
		};
		({ strokes, elements } = settle(pageIndex, { strokes, elements }));
		others = others?.map((o) => ({ ...o, ...settle(o.pageIndex, o) }));
		const boxes = this.layout?.boxes ?? [];
		const extra = others?.filter((o) => o.strokes.length + o.elements.length > 0);
		const bounds = extra?.length
			? partsBounds(boxes, [{ pageIndex, strokes, elements }, ...extra], pageIndex, measureText)
			: unionBounds(strokes, elements, measureText);
		if (!bounds) {
			this.clearSelection();
			return;
		}
		this.drag = null;
		this.selection = { pageIndex, strokes, elements, bounds, matrix: IDENTITY, ...(extra?.length ? { others: extra } : {}) };
		this.pushSelection();
	}

	/** The page in view and the centre of the view in its coordinates: where pasted things go. */
	private pasteTarget(): { pageIndex: number; page: Page; x: number; y: number } | null {
		const doc = this.session?.doc;
		const pageIndex = this.currentPageIndex();
		const page = doc?.pages[pageIndex];
		const box = this.layout?.boxes[pageIndex];
		if (!page || !box) return null;
		const [dx, dy] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
		const [x, y] = toPageLocal(box, dx, dy);
		return { pageIndex, page, x, y };
	}

	/** Copy, cut and paste with the keyboard (and the system's own menu): only while this notebook is the active view and no text field has the focus. */
	private registerClipboardEvents(): void {
		const mine = (e: Event): boolean => {
			if (!this.selectionActions || !this.editable() || this.app.workspace.getActiveViewOfType(NotebookView) !== this) return false;
			const target = e.target instanceof HTMLElement ? e.target : null;
			return !target?.closest("input, textarea, [contenteditable='true'], .modal");
		};
		this.registerDomEvent(document, "copy", (e) => {
			if (!mine(e) || !this.selection) return;
			const marker = this.selectionActions?.copySync();
			if (marker == null) return;
			e.clipboardData?.setData("text/plain", marker);
			e.preventDefault();
		});
		this.registerDomEvent(document, "cut", (e) => {
			if (!mine(e) || !this.selection) return;
			const marker = this.selectionActions?.copySync();
			if (marker == null) return;
			e.clipboardData?.setData("text/plain", marker);
			e.preventDefault();
			this.deleteSelection();
		});
		this.registerDomEvent(document, "paste", (e) => {
			if (!mine(e)) return;
			e.preventDefault();
			void this.selectionActions?.pasteFromEvent(e);
		});
	}

	// --- performance overlay ---

	private onFrame(time: number): void {
		if (this.perfLastFrame) this.perfFrames.push(time - this.perfLastFrame);
		this.perfLastFrame = time;
		if (this.perfInput !== null) {
			this.perfLatency.push(Math.max(0, time - this.perfInput));
			this.perfInput = null;
		}
		if (time - this.perfShownAt < 500 || !this.renderer) return;
		this.perfShownAt = time;
		const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
		const frames = this.perfFrames.splice(0).filter((f) => f < 250);
		const latency = this.perfLatency.splice(0);
		const proc = this.perfProcess.splice(0);
		const paint = this.perfPaint.splice(0);
		const st = this.renderer.stats;
		const ms = (a: number[]) => (a.length ? `${avg(a).toFixed(1)} ms` : "–");
		this.perfEl.setText(
			`frame ${avg(frames).toFixed(1)} ms · input→frame ${ms(latency)}\n`
			+ `ink: input→paint ${ms(paint)} · per event ${proc.length ? avg(proc).toFixed(2) + " ms" : "–"}${this.controller?.rawUpdates ? " · raw" : ""}\n`
			+ `redraw ${st.staticMs.toFixed(1)} ms · ${st.strokesDrawn} strokes · ${st.pagesDrawn} pages`,
		);
	}

	/** 0.20 review (D1): the heading analysis this view keeps warm (the companion headings reuse it instead of analysing again). */
	headingIndex(): HeadingIndex {
		return this.outlineBuilder.headingIndex();
	}

	/** Read-only: what this view holds in memory that can name an asset file (library check, roadmap 27): the document, its undo and redo history, media not yet in the document. */
	libraryCheckRoots(): unknown[] {
		return [this.session?.doc ?? null, this.history.pending(), this.media?.pendingAssets() ?? []];
	}
}

/** Notice text for a failed image insert: HEIF/HEIC gets its own, actionable message. */
function insertFailure(e: unknown): string {
	if (e instanceof PhotoDecodeError && e.reason === "heic") return t("scan.heic");
	return t("insert.failed", { error: e instanceof Error ? e.message : String(e) });
}
