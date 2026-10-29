import { FileView, Menu, Notice, Scope, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { pageFromState } from "../integration/links";
import { pageFromEphemeralState } from "../integration/page-links";
import { addPageShareItems } from "../integration/page-share";
import { scanFromCamera } from "../scan/scan-modal";
import { scannedPage } from "../scan/pages";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import { isHeic } from "../scan/image-bytes";
import { t } from "../i18n";
import { renderThumbnail } from "../library/thumbnail";
import { needsNextPage } from "../ink/auto-page";
import { elementsInLasso, hitElement, transformElement } from "../ink/elements";
import { eraseAreaCommand } from "../ink/erase-area";
import { filterErasable } from "../ink/erase-filter";
import { findHitStrokes, type BBox } from "../ink/hit-test";
import { growForInfinite } from "../ink/infinite";
import { InputPolicy } from "../ink/input-policy";
import { strokesInLasso, transformStroke } from "../ink/lasso";
import { layoutPages, nearestPage, pageAt, toPageLocal, visiblePages, type Layout } from "../ink/layout";
import { HoldTracker } from "../ink/hold";
import { MultiTap } from "../ink/multitap";
import { lineAt, TextLayoutCache, wordAt } from "../ink/words";
import { InkBuilder } from "../ink/ink-geometry";
import { OneEuroFilter, stabilizationParams } from "../ink/one-euro";
import { PointerController, type InkSample, type SampleBuffer } from "../ink/pointer-controller";
import { PressureModel } from "../ink/pressure";
import { recognizeShape } from "../ink/recognize";
import { drawElement, drawTextElement, measureText, Renderer, selectionHandles } from "../ink/renderer";
import { projectToRuler, rulerFromTwoTouches, RULER_LENGTH, type Ruler } from "../ink/ruler";
import { eraseSegment } from "../ink/segment-erase";
import { analyseSpace, planSpaceChange, spacePreview } from "../ink/space";
import { apply, IDENTITY, invert, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Matrix } from "../ink/transform";
import { clampToPage, fitWidth, pan, PAGE_MARGIN, screenToPage, zoomAt, type Size, type Viewport } from "../ink/viewport";
import { cloneMeta, createId, createPage, createStroke } from "../model/document";
import { createPdfPages, duplicatePage } from "../model/pages";
import {
	AddAsset, AddElement, AddPage, AddStroke, Batch, DeletePage, History, InsertPages, MovePage, RemoveElement, ReplaceElement,
	ReplaceStroke, SetMeta, SetPageInfinite, SetPageSize, SetPaper, type Command,
} from "../model/history";
import { pageContentCommand } from "../model/page-content";
import { freezeStroke } from "../model/serialize";
import {
	DEFAULT_META, PAGE_SIZES, PAPER_KINDS, PAPER_SPACING,
	type Asset, type ImageElement, type NotebookDocument, type NotebookMeta, type Page, type PageElement, type PageSizeName,
	type PaperKind, type Point, type Stroke, type TextElement, RENDER_FREEHAND, RENDER_INK,
} from "../model/types";
import type { JournalStore } from "../storage/journal";
import { DocumentSession, type SaveState, type SessionMode } from "../storage/session";
import { isNotebookFile } from "../storage/format";
import { VaultDocumentIO } from "../storage/vault-io";
import { backupFolder, type NotebookSettings } from "../settings";
import { exportPdf, exportSvg } from "./export";
import { policySettings } from "./input-settings";
import { NotebookMedia, storeAsset } from "./media";
import { PageNavigator } from "./navigator";
import { LocationKeeper } from "./last-location";
import { PenRadial } from "./radial-menu";
import { askPdfRange } from "./pdf-range-modal";
import { runBoardShot } from "./board-shot";
import type { EditContext } from "./edit-context";
import { runNewLecture } from "./lecture";
import { runMovePages } from "../library/move-pages";
import { pickFile } from "./pick";
import { RulerGesture } from "./ruler-gesture";
import { SelectionActions } from "./selection-actions";
import { TextEditor, type TextEditSession } from "./text-editor";
import { eraserRadiusPt, stepEraserSize, type FavouritePen } from "./favourites";
import { PenControls, type PenStore } from "./pen-controls";
import { DEFAULT_TOOLS, Toolbar, type ToolName, type ToolbarState } from "./toolbar";
import {
	centredPosition, imageElementSize, imagePageSize, mergeMeta, metaEquals, newTextBox, shapePoints, shouldGrabRuler, toggleBookmark,
	unionBounds,
} from "./view-helpers";

export const VIEW_TYPE = "notebook-view";

/** Selection handle diameter in CSS px. */
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
	remember?(path: string, page: number): void;
	/** Instant save journal shared by all views. */
	journal?: JournalStore;
	/** Persists the plugin settings (favourite pens, eraser size, pen-only). Optional: absent in tests. */
	saveSettings?(): Promise<void>;
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
}

interface Lasso {
	pageIndex: number;
	points: Array<[number, number]>;
	/** The eraser's Area mode: the outline erases what is inside instead of selecting it. */
	erase?: boolean;
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
}

interface SelectionDrag {
	kind: "move" | "scale" | "rotate";
	start: [number, number];
	startMatrix: Matrix;
}

export class NotebookView extends FileView {
	navigation = true;

	private session: DocumentSession | null = null;
	private readonly history = new History(() => this.requireDoc());
	private readonly policy: InputPolicy;
	private readonly pressure: PressureModel;
	/** Position filter (stabilization setting) and the geometry of the stroke being written. */
	private readonly filter = new OneEuroFilter();
	private readonly ink = new InkBuilder();

	private toolbar!: Toolbar;
	private body!: HTMLElement;
	private stage!: HTMLElement;
	private messageEl!: HTMLElement;
	private perfEl!: HTMLElement;
	private renderer: Renderer | null = null;
	private controller: PointerController | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private media: NotebookMedia | null = null;
	private pageNav: PageNavigator | null = null;
	private textEditor: TextEditor | null = null;
	private rulerGesture: RulerGesture | null = null;
	private radial: PenRadial | null = null;
	private readonly location = new LocationKeeper(
		{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
		(path, page) => {
			this.host.remember?.(path, page);
			this.app.workspace.requestSaveLayout();
		},
	);
	private selectionActions: SelectionActions | null = null;

	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	private viewSize: Size = { width: 0, height: 0 };
	private layout: Layout | null = null;
	private fitMode = true;
	private tools: ToolbarState = { ...DEFAULT_TOOLS };
	private pens: PenControls | null = null;

	private active: ActiveStroke | null = null;
	private erasing: ActiveErase | null = null;
	private lasso: Lasso | null = null;
	private spaceDrag: SpaceDrag | null = null;
	private selection: Selection | null = null;
	private drag: SelectionDrag | null = null;
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
	private navCurrent = -1;
	/** Pages whose thumbnail was drawn without all its media; redrawn when media arrives. */
	private readonly thumbPending = new Set<string>();
	private readonly thumbRendering = new Set<string>();
	private thumbTimer: number | null = null;

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

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("notebook-view");
		this.toolbar = new Toolbar(this.contentEl, this.tools, {
			change: (state) => this.onToolsChanged(state),
			undo: () => this.undo(),
			redo: () => this.redo(),
			addPage: () => this.addPageAfter(this.currentPageIndex()),
			pageMenu: (evt) => this.openPageMenu(evt, this.currentPageIndex()),
			deleteSelection: () => this.deleteSelection(),
			fit: () => this.fitToWidth(),
			toggleNavigator: () => this.setNavigatorOpen(!this.pageNav?.open),
			insertImage: () => void this.insertImageElement(),
			boardShot: () => void this.boardShot(),
		});
		this.toolbar.setSelection(false);
		this.body = this.contentEl.createDiv({ cls: "notebook-body" });
		this.stage = this.body.createDiv({ cls: "notebook-stage" });
		this.perfEl = this.stage.createDiv({ cls: "notebook-perf" });
		this.pageNav = new PageNavigator(this.body, {
			pages: () => this.session?.doc?.pages ?? [],
			current: () => this.currentPageIndex(),
			bookmarks: () => new Set(this.session?.doc?.meta?.bookmarks ?? []),
			thumbnail: (page, width) => this.thumbnail(page, width),
			goTo: (index) => this.goToPage(index),
			move: (from, to) => this.movePage(from, to),
			toggleBookmark: (pageId) => this.toggleBookmarkOf(pageId),
			pageMenu: (index, evt) => this.openPageMenu(evt, index),
		});
		// The panel sits to the left of the page (a drawer over it on narrow views).
		this.body.insertBefore(this.pageNav.el, this.stage);
		this.textEditor = new TextEditor(this.stage);
		this.pens = new PenControls(this.toolbar, this.stage, this.penStore());
		this.mountSelectionActions();
		this.messageEl = this.contentEl.createDiv({ cls: "notebook-message" });
		this.messageEl.hide();
		this.toolbar.setEditable(false);

		this.renderer = new Renderer(this.stage, { lowLatency: this.host.settings.lowLatencyInk });
		// Registered before the pointer controller: the ruler gesture swallows the touches that move the ruler.
		this.rulerGesture = new RulerGesture(this.stage, {
			enabled: () => this.tools.ruler && !!this.ruler && this.editable(),
			grabs: (mid) => this.rulerGrabs(mid),
			update: (a, b) => this.moveRuler(a, b),
		});
		this.controller = new PointerController(this.stage, this.policy, {
			drawStart: (s, eraser) => this.drawStart(s, eraser),
			drawMove: (samples, predicted) => this.drawMove(samples, predicted),
			drawEnd: (cancelled) => this.drawEnd(cancelled),
			pan: (dx, dy) => this.setViewport(pan(this.viewport, dx, dy), true),
			zoom: (factor, fx, fy) => {
				this.fitMode = false;
				this.setViewport(zoomAt(this.viewport, factor, fx, fy), true);
			},
			penMenu: (x, y) => this.radial?.open(x, y),
		}, { rawUpdates: this.host.settings.lowLatencyInk });
		this.radial = new PenRadial(this.stage, {
			editable: () => this.editable() && !this.controller?.drawing,
			tools: () => this.tools,
			apply: (patch) => this.toolbar.apply(patch),
			canUndo: () => this.history.canUndo(),
			undo: () => this.undo(),
		});
		this.applySettings(this.host.settings);

		this.resizeObserver = new ResizeObserver(() => this.measure());
		this.resizeObserver.observe(this.stage);
		this.registerDomEvent(window, "resize", () => this.measure());

		// Tapping anywhere else ends text editing. Pointer events on the canvas are cancelled, so the textarea would not blur.
		this.registerDomEvent(this.stage, "pointerdown", (e) => {
			if (!(e.target as HTMLElement | null)?.closest?.(".notebook-text-editor")) this.commitText();
		}, true);

		// Android may kill a backgrounded app without notice: save as soon as we are hidden.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.flushNow();
		});
		this.registerDomEvent(window, "pagehide", () => void this.flushNow());
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Shift") this.shiftDown = true;
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Shift") this.shiftDown = false;
		});
		this.registerDomEvent(window, "blur", () => (this.shiftDown = false));
		this.registerClipboardEvents();

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
		this.scope.register([], "Escape", () => (this.clearSelection(), false));
	}

	async onClose(): Promise<void> {
		this.location.flush();
		await this.closeSession();
		this.stopHold();
		for (const timer of [this.navTimer, this.thumbTimer, this.snapFlashTimer]) if (timer !== null) window.clearTimeout(timer);
		this.navTimer = this.thumbTimer = this.snapFlashTimer = null;
		this.pens?.destroy();
		this.pens = null;
		this.controller?.destroy();
		this.controller = null;
		this.radial?.destroy();
		this.radial = null;
		this.rulerGesture?.destroy();
		this.rulerGesture = null;
		this.selectionActions?.destroy();
		this.selectionActions = null;
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

	/** The page being read goes into the workspace layout, so reopening Obsidian shows the same page. */
	getState(): Record<string, unknown> {
		const state = super.getState();
		const total = this.session?.doc?.pages.length ?? 0;
		const page = this.pendingPage ?? (total > 0 ? this.currentPageIndex() + 1 : null);
		return page !== null ? { ...state, page } : state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		this.pendingPage = pageFromState(state);
		await super.setState(state, result);
		// Already loaded (the same file was shown): jump now; otherwise onDocumentLoaded applies it.
		if (this.pendingPage !== null && this.layout) this.applyPendingPage();
	}

	/** Following `[[Notebook.notebook#p3]]` passes the subpath here (after `setState` when the file was not open yet). */
	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const page = pageFromEphemeralState(state);
		if (page === null) return;
		this.pendingPage = page;
		if (this.layout) this.applyPendingPage();
	}

	private applyPendingPage(): void {
		const doc = this.session?.doc;
		const page = this.pendingPage;
		if (page === null || !doc || !this.layout) return;
		this.pendingPage = null;
		this.scrollToPage(Math.min(doc.pages.length, Math.max(1, page)) - 1);
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.lastBackupPath = null;
		this.fitMode = true;
		this.viewport = { scale: 1, offsetX: 0, offsetY: 0 };
		// Callbacks of a session that is no longer the current one (file switched while loading) are ignored.
		const current = () => this.session === session;
		const session: DocumentSession = new DocumentSession(
			new VaultDocumentIO(this.app, file, () => backupFolder(this.host.settings)),
			{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
			{
				onLoaded: (doc, mode, problem) => {
					if (current()) this.onDocumentLoaded(doc, mode, problem);
				},
				onSaveState: (state) => {
					if (current()) this.showSaveState(state);
				},
				onRecovered: ({ savedAt }) => {
					const when = new Date(savedAt);
					new Notice(t("notice.recovered", { time: Number.isNaN(when.getTime()) ? savedAt : when.toLocaleString() }), 8000);
				},
				onBackup: (path, reason) => {
					const key = reason === "conflict" ? "notice.conflict" : reason === "journal" ? "notice.journalBackup" : "notice.backup";
					new Notice(t(key, { path }), 8000);
					if (!current()) return;
					this.lastBackupPath = path;
					if (session.mode === "broken" || session.mode === "readonly") this.showProblem();
				},
				onError: (message) => {
					if (current()) this.showError(message);
				},
			},
			{
				busy: () => this.active !== null || this.erasing !== null || this.drag !== null || this.shapeDrag !== null
					|| this.textEditor?.isOpen === true,
				journal: this.host.journal,
			},
		);
		this.session = session;
		try {
			await session.load();
		} catch (e) {
			this.showError((e as Error).message);
		}
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.closeSession();
		this.history.clear();
		this.clearSelection();
		this.layout = null;
		this.ruler = null;
		this.renderer?.setRuler(null);
		this.renderer?.setDocument(null, null);
		this.renderer?.setMedia(null);
		this.media?.destroy();
		this.media = null;
		this.pageNav?.invalidate();
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
		const session = this.session;
		if (!session) return true;
		const written = await session.flush();
		return written && (session.mode !== "ok" || !session.dirty);
	}

	/** Final flush (with retries and an "unsaved" backup as last resort), then detaches the session. */
	private async closeSession(): Promise<void> {
		this.controller?.finishActiveStroke();
		this.commitText();
		const session = this.session;
		if (!session) return;
		try {
			// Obsidian may close the view for a deleted file before our 'delete' handler runs.
			const file = this.file;
			if (file && !this.app.vault.getAbstractFileByPath(file.path)) await session.markDeleted();
			else await session.flushForClose();
		} finally {
			session.dispose();
			if (this.session === session) this.session = null;
		}
	}

	applySettings(settings: NotebookSettings): void {
		this.policy.settings = policySettings(settings);
		this.pressure.mode = settings.pressureMode;
		if (this.toolbar && this.tools.eraserSize !== settings.eraserSize) this.toolbar.update({ eraserSize: settings.eraserSize });
		this.pens?.refresh();
		this.filter.params = stabilizationParams(settings.stabilization);
		if (this.controller) {
			this.controller.predictionEnabled = settings.inkPrediction;
			if (!this.controller.drawing) this.controller.setRawUpdates(settings.lowLatencyInk);
		}
		if (this.renderer && !this.active) this.renderer.setLowLatency(settings.lowLatencyInk);
		this.perfEl?.toggleClass("notebook-hidden", !settings.perfOverlay);
		if (this.renderer) this.renderer.onFrame = settings.perfOverlay ? (t) => this.onFrame(t) : null;
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
		if (this.history.undo()) this.afterHistoryChange();
	}

	redo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.commitText();
		this.clearSelection();
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

	/** Pen only: fingers pan and zoom but do not draw. */
	togglePenOnly(): void {
		this.pens?.togglePenOnly();
	}

	/** Scrolls to the page delta pages away from the one in view. */
	goToRelativePage(delta: number): void {
		const n = this.session?.doc?.pages.length ?? 0;
		if (n === 0) return;
		this.scrollToPage(Math.min(n - 1, Math.max(0, this.currentPageIndex() + delta)));
	}

	private penStore(): PenStore {
		const s = (): NotebookSettings => this.host.settings;
		const save = (): void => void this.host.saveSettings?.().catch((e) => console.error("[notebook] saving settings failed", e));
		return {
			favourites: () => s().favouritePens,
			saveFavourites: (favs: FavouritePen[]) => {
				s().favouritePens = favs;
				save();
			},
			penOnly: () => !s().fingerDrawing,
			setPenOnly: (on) => {
				s().fingerDrawing = !on;
				this.policy.settings = { ...this.policy.settings, fingerDrawing: !on };
				save();
			},
			eraserSize: () => s().eraserSize,
			saveEraserSize: (size) => {
				s().eraserSize = size;
				save();
			},
		};
	}

	fitToWidth(): void {
		this.fitMode = true;
		this.refit(false);
	}

	/** Inserts a blank page after the one in view and scrolls to it. */
	addPage(): void {
		this.addPageAfter(this.currentPageIndex());
	}

	/** Inserts a blank page (size and paper of the page at `index`) after it. */
	private addPageAfter(index: number): void {
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

	private scrollToPage(index: number): void {
		const box = this.layout?.boxes[index];
		if (box) this.setViewport({ ...this.viewport, offsetY: PAGE_MARGIN - box.y * this.viewport.scale });
	}

	private goToPage(index: number): void {
		this.scrollToPage(index);
		if (this.body.hasClass("is-narrow")) this.setNavigatorOpen(false);
	}

	private setNavigatorOpen(open: boolean): void {
		this.pageNav?.setOpen(open);
		this.toolbar.setNavigatorOpen(open);
	}

	/** Page menu: insert, reorder, duplicate, delete, bookmark, paper, size, infinite, export. Every change is undoable. */
	private openPageMenu(evt: MouseEvent, index: number): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable()) return;
		const page = doc.pages[index];
		if (!page) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("page.insertPdf")).setIcon("file-input").onClick(() => void this.insertPdfAfter(index)));
		menu.addItem((i) => i.setTitle(t("page.insertBlank")).setIcon("file-plus").onClick(() => this.addPageAfter(index)));
		menu.addItem((i) => i.setTitle(t("page.insertImage")).setIcon("image-plus").onClick(() => void this.insertImagePageAfter(index)));
		menu.addItem((i) => i.setTitle(t("page.scanAfter")).setIcon("scan").onClick(() => void this.scanPagesAfter(index)));
		menu.addItem((i) => i.setTitle(t("page.scanInsert")).setIcon("scan-line").onClick(() => void this.insertScanElement(index)));
		menu.addItem((i) => i.setTitle(t("page.newLecture")).setIcon("graduation-cap").onClick(() => void this.newLecture()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("page.duplicate")).setIcon("copy").onClick(() => this.pageCommand(new AddPage(duplicatePage(page), index + 1), index + 1, page)));
		menu.addItem((i) => i.setTitle(t("page.moveUp")).setIcon("arrow-up").setDisabled(index === 0)
			.onClick(() => this.pageCommand(new MovePage(page.id, index, index - 1), index - 1, page)));
		menu.addItem((i) => i.setTitle(t("page.moveDown")).setIcon("arrow-down").setDisabled(index >= doc.pages.length - 1)
			.onClick(() => this.pageCommand(new MovePage(page.id, index, index + 1), index + 1, page)));
		const marked = doc.meta?.bookmarks.includes(page.id) ?? false;
		menu.addItem((i) => i.setTitle(t(marked ? "page.unbookmark" : "page.bookmark")).setIcon("bookmark").onClick(() => this.toggleBookmarkOf(page.id)));
		menu.addItem((i) => i.setTitle(t("page.moveToNotebook")).setIcon("folder-input").onClick(() => void this.movePagesToNotebook(index)));
		menu.addItem((i) => i.setTitle(t("page.delete")).setIcon("trash-2").setSection("danger").setDisabled(doc.pages.length <= 1)
			.onClick(() => this.pageCommand(new DeletePage(page, index), Math.max(0, index - 1), page)));
		menu.addSeparator();
		for (const kind of PAPER_KINDS) {
			menu.addItem((i) => i.setTitle(t("page.paper", { kind: t(`paper.${kind}`) })).setChecked(page.paper.kind === kind)
				.onClick(() => this.setPaper(page, kind, index)));
		}
		menu.addSeparator();
		const landscape = page.width > page.height;
		for (const name of Object.keys(PAGE_SIZES) as PageSizeName[]) {
			const base = PAGE_SIZES[name];
			const current = Math.min(page.width, page.height) === base.width && Math.max(page.width, page.height) === base.height;
			menu.addItem((i) => i.setTitle(t("page.size", { size: t(`size.${name}`) })).setChecked(current)
				.onClick(() => this.setSize(page, name, landscape, index)));
		}
		const sizeName = (Object.keys(PAGE_SIZES) as PageSizeName[]).find((n) =>
			Math.min(page.width, page.height) === PAGE_SIZES[n].width && Math.max(page.width, page.height) === PAGE_SIZES[n].height);
		if (sizeName) {
			menu.addItem((i) => i.setTitle(t(landscape ? "page.portrait" : "page.landscape")).setIcon("rotate-cw")
				.onClick(() => this.setSize(page, sizeName, !landscape, index)));
		}
		menu.addItem((i) => i.setTitle(t("page.infinite")).setIcon("infinity").setChecked(!!page.infinite)
			.onClick(() => this.pageCommand(new SetPageInfinite(page.id, !page.infinite), index, page)));
		menu.addSeparator();
		const file = this.file;
		if (file) {
			addPageShareItems(menu, this.app, file, index + 1);
			menu.addItem((i) => i.setTitle(t("export.pagePdf")).setIcon("file-output")
				.onClick(() => void exportPdf(this.app, file, [page], ` p${index + 1}`, this.media)));
			menu.addItem((i) => i.setTitle(t("export.notebookPdf")).setIcon("file-output").onClick(() => void this.exportNotebookPdf()));
			menu.addItem((i) => i.setTitle(t("export.pageSvg")).setIcon("image")
				.onClick(() => void exportSvg(this.app, file, page, ` p${index + 1}`, this.media)));
		}
		menu.showAtMouseEvent(evt);
	}

	async exportNotebookPdf(): Promise<void> {
		const doc = this.session?.doc;
		if (doc && this.file) await exportPdf(this.app, this.file, doc.pages, "", this.media);
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

	private setPaper(page: Page, kind: PaperKind, index: number): void {
		if (page.paper.kind === kind) return;
		const after = { kind, spacing: PAPER_SPACING[kind] };
		this.pageCommand(new SetPaper(page.id, { ...page.paper }, after), index, page);
	}

	private setSize(page: Page, name: PageSizeName, landscape: boolean, index: number): void {
		const base = PAGE_SIZES[name];
		const after = landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
		if (after.width === page.width && after.height === page.height) return;
		this.pageCommand(new SetPageSize(page.id, { width: page.width, height: page.height }, after), index, page);
	}

	deleteSelection(): void {
		const sel = this.selection;
		const page = sel && this.session?.doc?.pages[sel.pageIndex];
		if (!sel || !page || !this.editable()) return;
		const commands: Command[] = [];
		const strokes = [...sel.strokes]
			.map((stroke) => ({ stroke, index: page.strokes.indexOf(stroke) }))
			.filter((it) => it.index >= 0)
			.sort((a, b) => b.index - a.index);
		for (const it of strokes) commands.push(new ReplaceStroke(page.id, it.stroke, [], it.index));
		for (const el of sel.elements) if (page.elements?.includes(el)) commands.push(new RemoveElement(page.id, el));
		this.clearSelection();
		if (commands.length === 0) return;
		this.history.execute(new Batch("Delete selection", commands));
		this.afterHistoryChange();
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

	/** True when the view still shows the same editable document (the picker and the import are asynchronous). */
	private stillHere(session: DocumentSession | null): boolean {
		return !!session && this.session === session && this.editable() && !this.controller?.drawing;
	}

	/** Page menu: inserts a whole PDF or a page range after the page at `index` (one undo step). */
	async insertPdfAfter(index: number): Promise<void> {
		const session = this.session;
		const media = this.media;
		const anchor = session?.doc?.pages[index];
		if (!session || !media || !anchor || !this.stillHere(session)) return;
		let asset: Asset | null = null;
		let working: Notice | null = null;
		try {
			const picked = await this.pickAndStore("pdf");
			if (!picked) return;
			asset = picked.asset;
			working = new Notice(t("insert.working"), 0);
			const sizes = await media.pdf.pageSizes(asset.id);
			working.hide();
			working = null;
			if (sizes.length === 0) throw new Error("the PDF has no pages");
			const range = sizes.length === 1 ? { from: 1, to: 1 } : await askPdfRange(this.app, sizes.length);
			if (!range || !this.stillHere(session)) return;
			const doc = session.doc;
			const at = doc ? doc.pages.indexOf(anchor) : -1;
			if (!doc || at < 0) return;
			const pages = createPdfPages(asset, sizes.slice(range.from - 1, range.to), range.from);
			this.commitText();
			this.clearSelection();
			this.history.execute(new Batch("Insert PDF", [new AddAsset(asset), new InsertPages(pages, at + 1)]));
			this.afterHistoryChange();
			this.scrollToPage(at + 1);
			new Notice(t("insert.pdfDone", { n: String(pages.length) }));
		} catch (e) {
			console.error("[notebook] insert PDF", e);
			new Notice(t("insert.failed", { error: (e as Error).message }), 8000);
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
			new Notice(insertFailure(e), 8000);
		} finally {
			if (asset) media.removePending(asset.id);
		}
	}

	/** Index of the page in view (for commands). */
	currentPage(): number {
		return this.currentPageIndex();
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
			new Notice(t("scan.pagesDone", { n: String(pages.length) }));
		} catch (e) {
			console.error("[notebook] scan pages", e);
			new Notice(t("scan.failed", { error: (e as Error).message }), 8000);
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
			new Notice(t("scan.imageDone"));
		} catch (e) {
			console.error("[notebook] insert scan", e);
			new Notice(t("scan.failed", { error: (e as Error).message }), 8000);
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
			new Notice(insertFailure(e), 8000);
		} finally {
			if (asset) media.removePending(asset.id);
		}
	}

	// --- during the lecture: board shot, new lecture, move pages (logic in board-shot.ts, lecture.ts, library/move-pages.ts) ---

	/** What the flows of those modules may do to this document; null unless it is open, editable and not being written on. */
	editContext(): EditContext | null {
		const session = this.session;
		const media = this.media;
		const doc = session?.doc;
		if (!session || !media || !doc || !this.stillHere(session)) return null;
		return {
			app: this.app,
			folder: this.host.settings.folder,
			file: this.file,
			doc,
			measure: measureText,
			alive: () => this.stillHere(session) && session.doc === doc,
			addPending: (asset) => media.addPending(asset),
			removePending: (id) => media.removePending(id),
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
				this.history.execute(cmd);
				this.afterHistoryChange();
				if (scrollTo !== undefined) this.scrollToPage(scrollTo);
			},
			flush: () => this.flushNow(),
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

	// --- document ---

	private requireDoc(): NotebookDocument {
		const doc = this.session?.doc;
		if (!doc) throw new Error("no document loaded");
		return doc;
	}

	private editable(): boolean {
		return this.session?.mode === "ok" && !!this.session.doc;
	}

	private pageAtIndex(i: number): Page | null {
		return this.session?.doc?.pages[i] ?? null;
	}

	private currentPageIndex(): number {
		if (!this.layout) return 0;
		const [, y] = screenToPage(this.viewport, this.viewSize.width / 2, this.viewSize.height / 2);
		return Math.max(0, nearestPage(this.layout, y));
	}

	private refreshLayout(): void {
		const doc = this.session?.doc;
		this.layout = doc ? layoutPages(doc.pages) : null;
		this.renderer?.setDocument(doc?.pages ?? null, this.layout);
		this.pushRuler();
	}

	private onDocumentLoaded(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void {
		this.active = null;
		this.erasing = null;
		this.lasso = null;
		this.spaceDrag = null;
		this.drag = null;
		this.shapeDrag = null;
		this.textTap = null;
		this.lassoTap = null;
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
		if (doc && mode === "ok") {
			this.messageEl.hide();
			this.body.show();
			this.toolbar.setEditable(true);
			if (!this.media) {
				this.media = new NotebookMedia(this.app, () => this.session?.doc ?? null, () => this.host.settings.folder, () => this.onMediaChanged());
				this.renderer?.setMedia(this.media);
			}
			this.refreshLayout();
			this.refit(true);
			this.pageNav?.invalidate();
			if (this.tools.ruler) this.placeRuler();
			this.applyPendingPage();
			if (this.file) this.location.note(this.file.path, this.currentPageIndex() + 1);
		} else {
			this.body.hide();
			this.toolbar.setEditable(false);
			this.layout = null;
			this.renderer?.setDocument(null, null);
			this.showProblem(problem);
		}
		this.updateHistoryButtons();
		this.selectionActions?.update();
	}

	private showProblem(problem = this.session?.problem ?? null): void {
		const readonly = this.session?.mode === "readonly";
		this.messageEl.empty();
		this.messageEl.createEl("h3", { text: t(readonly ? "view.readonly.title" : "view.broken.title") });
		this.messageEl.createEl("p", { text: t(readonly ? "view.readonly.body" : "view.broken.body") });
		if (problem) this.messageEl.createEl("pre", { text: problem });
		if (this.lastBackupPath) this.messageEl.createEl("p", { text: `${t("view.backup")}: ${this.lastBackupPath}` });
		this.messageEl.show();
		this.toolbar.setStatus(t("status.readonly"), "error");
	}

	private showSaveState(state: SaveState): void {
		if (this.session && this.session.mode !== "ok") {
			this.toolbar.setStatus(t("status.readonly"), "error");
			return;
		}
		const text = { saved: "status.saved", pending: "status.pending", saving: "status.saving", error: "status.error" } as const;
		this.toolbar.setStatus(t(text[state]), state === "error" ? "error" : state === "saved" ? "ok" : "pending");
	}

	private showError(message: string): void {
		console.error("[notebook]", message);
		const now = Date.now();
		if (now - this.lastErrorAt < 10000) return;
		this.lastErrorAt = now;
		new Notice(`Notebook: ${message}`, 8000);
	}

	private afterHistoryChange(): void {
		this.refreshLayout();
		// The document may be shorter now (page deleted or made smaller): keep the view inside it.
		this.setViewport(this.viewport);
		this.session?.markChanged();
		this.updateHistoryButtons();
		this.updatePageIndicator();
		this.pageNav?.refresh();
	}

	/** The page panel shows thumbnails of what was just drawn, a moment after the pen lifts. */
	private scheduleNavRefresh(): void {
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
		const n = this.session?.doc?.pages.length ?? 0;
		const current = n ? this.currentPageIndex() : -1;
		this.toolbar.setPage(n ? current + 1 : 0, n);
		if (current !== this.navCurrent) {
			this.navCurrent = current;
			this.pageNav?.markCurrent(current);
			if (n && this.file && this.pendingPage === null) this.location.note(this.file.path, current + 1);
		}
	}

	private onToolsChanged(state: ToolbarState): void {
		const before = this.tools;
		this.tools = state;
		this.pens?.onToolsChanged(state);
		this.radial?.noteTools(state);
		if (state.tool !== "lasso") this.clearSelection();
		this.selectionActions?.update();
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

	private thumbnail(page: Page, width: number): string {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		return renderThumbnail(page, Math.round(Math.min(width, THUMB_CSS_WIDTH) * dpr), {
			mime: "image/jpeg",
			quality: 0.8,
			drawBackground: (ctx, p) => this.drawThumbMedia(ctx, p),
		});
	}

	/** Background and elements of a thumbnail; whatever is not loaded yet is drawn as a placeholder and retried later. */
	private drawThumbMedia(ctx: CanvasRenderingContext2D, page: Page): void {
		const media = this.media;
		if (!media) return;
		let incomplete = false;
		const bg = page.background;
		if (bg) {
			let img: CanvasImageSource | null;
			if (bg.kind === "image") img = media.image(bg.asset);
			else {
				// Never ask for another scale of a page the main view is drawing: a render in flight would be cancelled.
				img = (media.pdf.peek(bg.asset, bg.page)?.canvas as CanvasImageSource | undefined) ?? null;
				if (!img && !this.isPageVisible(page)) this.renderThumbPdf(bg.asset, bg.page);
			}
			if (img) ctx.drawImage(img, 0, 0, page.width, page.height);
			else {
				ctx.fillStyle = "#f1f5f9";
				ctx.fillRect(0, 0, page.width, page.height);
				incomplete = true;
			}
		}
		const elements = page.elements ?? [];
		for (const el of elements) {
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
		this.renderer?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
		this.refit(true);
	}

	/** In fit mode, rescales to the view width; `keepTop` keeps the same document line at the top (rotation). */
	private refit(keepTop: boolean): void {
		const layout = this.layout;
		if (!layout || this.viewSize.width === 0) return;
		if (!this.fitMode) {
			this.setViewport(this.viewport);
			return;
		}
		const topY = screenToPage(this.viewport, 0, 0)[1];
		const fitted = fitWidth(this.viewSize, layout);
		if (keepTop && topY > 0) fitted.offsetY = -topY * fitted.scale;
		this.setViewport(fitted);
	}

	private setViewport(v: Viewport, interactive = false): void {
		const layout = this.layout;
		this.viewport = layout ? clampToPage(v, this.viewSize, layout) : v;
		this.renderer?.setViewport(this.viewport, interactive);
		if (this.selection) this.pushSelection();
		this.placeTextEditor();
		this.updatePageIndicator();
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
		this.clearSelection();
		const texts = (page.elements ?? []).filter((e): e is TextElement => e.type === "text");
		const hit = hitElement(texts, local[0], local[1], 4 / this.viewport.scale, measureText) as TextElement | null;
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

	/** Ends text editing: adds, changes or (when emptied) removes the text box, as one undo step. */
	private commitText(): void {
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

	private drawStart(sample: InkSample, eraserButton: boolean): boolean {
		const layout = this.layout;
		if (!layout || !this.editable()) return false;
		this.commitText();
		const [dx, dy] = this.toDoc(sample);
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
		const tool = eraserButton ? "eraser" : this.tools.tool;

		if (tool === "eraser" && this.tools.eraserMode !== "area") {
			// The selection may contain strokes about to be erased (e.g. erasing with the pen button).
			this.clearSelection();
			this.erasing = { commands: [], last: [dx, dy] };
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

		if (tool === "eraser") {
			// Area mode: the outline drawn like a lasso erases what is inside it when the pen lifts.
			this.clearSelection();
			this.lasso = { pageIndex, points: [local], erase: true };
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
			const hit = sel && sel.pageIndex === pageIndex ? this.selectionHit(local) : null;
			if (sel && hit) {
				this.drag = { kind: hit, start: local, startMatrix: sel.matrix };
				return true;
			}
			this.clearSelection();
			this.lasso = { pageIndex, points: [local] };
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

		const snap = !!page && this.rulerLatches(page, local);
		const start = snap && this.ruler ? (projectToRuler(this.ruler.ruler, local, Infinity) ?? local) : local;
		this.filter.reset(sample.x, sample.y, sample.t);
		// Real or simulated pressure is decided here, for the whole stroke.
		this.pressure.begin(sample.pointerType, sample.pressure);
		const p = this.pressure.sample(sample.pointerType, sample.pressure, sample.x, sample.y, sample.t);
		const highlighter = tool === "highlighter";
		const inkTool = highlighter ? "highlighter" : "pen";
		const color = highlighter ? this.tools.highlighterColor : this.tools.penColor;
		const width = highlighter ? this.tools.highlighterWidth : this.tools.penWidth;
		this.ink.reset(inkTool, width);
		this.ink.add(start[0], start[1], p);
		this.active = {
			pageIndex,
			stroke: createStroke(color, width, [], inkTool, RENDER_INK),
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
		// The first point shows as a dot right away.
		const painted = !!this.renderer?.beginWet(pageIndex, this.ink, inkTool, color) && this.renderer.paintWet();
		if (!painted) this.showLiveFallback(this.active);
		return true;
	}

	private drawMove(samples: SampleBuffer, predicted: SampleBuffer): void {
		const n = samples.count;
		if (n > 0) this.perfInput = samples.t[n - 1]!;

		if (this.erasing) {
			for (let i = 0; i < n; i++) {
				const [x, y] = this.toDoc(NotebookView.at(samples, i));
				if (Number.isFinite(x) && Number.isFinite(y)) this.eraseTo(x, y);
			}
			return;
		}

		const lt = this.lassoTap;
		if (lt && !lt.moved) {
			for (let i = 0; i < n; i++) if (Math.hypot(samples.x[i]! - lt.x, samples.y[i]! - lt.y) > TAP_SLOP_PX) lt.moved = true;
		}

		const lasso = this.lasso;
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

	private drawEnd(cancelled: boolean): void {
		this.endGesture(cancelled);
		// An external change seen during the gesture was postponed; check it now.
		this.session?.gestureEnded();
	}

	private endGesture(cancelled: boolean): void {
		const erasing = this.erasing;
		if (erasing) {
			this.erasing = null;
			if (erasing.commands.length > 0) {
				this.history.record(new Batch("Erase", erasing.commands));
				this.session?.markChanged();
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
			// The line ends where the pen lifted (the filtered position may trail it slightly).
			this.ink.add(active.rawX, active.rawY, active.rawP);
			this.ink.finish();
			const stroke = freezeStroke({ ...active.stroke, points: this.ink.toPoints() });
			// The wet canvas shows exactly this geometry; the static layer takes it over without a change.
			this.renderer?.endWet(stroke);
			this.addStrokes(active.pageIndex, page, [stroke]);
			if (active.liveFallback) this.renderer?.setLive(null);
			return;
		}
		this.renderer?.setLive(null);
		const stroke = freezeStroke(active.stroke);
		const extras = active.extra.map((points) => freezeStroke({ ...active.stroke, id: createId(), points }));
		this.addStrokes(active.pageIndex, page, [stroke, ...extras]);
	}

	/** Commits strokes drawn on a page as one undo step; an infinite page grows in the same step. */
	private addStrokes(pageIndex: number, page: Page, strokes: Stroke[]): void {
		const commands: Command[] = strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i));
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
		this.history.execute(commands.length === 1 ? commands[0]! : new Batch("Draw", commands));
		if (grew) {
			this.afterHistoryChange();
			return;
		}
		for (const s of strokes) this.renderer?.appendStroke(pageIndex, s);
		this.session?.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	private commitShape(shape: ShapeDrag): void {
		const page = this.pageAtIndex(shape.pageIndex);
		if (!page) return;
		const points = shapePoints(this.tools.shapeKind, shape.a, shape.b, this.tools.penWidth, this.shiftDown);
		if (points.length < 2) return;
		const stroke = freezeStroke(createStroke(this.tools.penColor, this.tools.penWidth, points, "shape"));
		this.addStrokes(shape.pageIndex, page, [stroke]);
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
		const [ax, ay] = toPageLocal(box, px, py);
		const [bx, by] = toPageLocal(box, x, y);
		const hits = findHitStrokes(filterErasable(page.strokes, this.eraseFilter()), ax, ay, bx, by, radius, this.renderer.boundsOf);
		let changed = false;
		for (const stroke of hits) {
			const index = page.strokes.indexOf(stroke);
			if (index < 0) continue;
			let after: Stroke[] = [];
			if (this.tools.eraserMode === "segment") {
				const runs = eraseSegment(stroke, ax, ay, bx, by, radius, this.renderer.boundsOf(stroke));
				if (runs === null) continue;
				after = runs.map((points) => freezeStroke({ ...stroke, id: createId(), points }));
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
		const cmd = eraseAreaCommand(page, lasso.points, {
			filter: this.eraseFilter(),
			includeElements: this.host.settings.eraseAreaElements,
			measure: measureText,
		});
		if (!cmd) return;
		this.history.execute(cmd);
		this.renderer?.invalidate();
		this.session?.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
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
			if (Math.abs(drag.delta) * this.viewport.scale >= TAP_SLOP_PX) new Notice(t("space.nothing"));
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
		this.toolbar?.setSelection(false);
		this.selectionActions?.update();
	}

	private pushSelection(): void {
		const sel = this.selection;
		this.toolbar.setSelection(!!sel);
		this.renderer?.setSelection(sel ? { ...sel, handle: HANDLE_PX } : null);
		this.selectionActions?.update();
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
		const strokes = page.strokes.filter((s) => wanted.has(s.id));
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
			const el = hitElement(page.elements ?? [], p[0], p[1], 6 / this.viewport.scale, measureText);
			if (el) elements = [el];
		} else {
			strokes = strokesInLasso(page.strokes, lasso.points);
			elements = elementsInLasso(page.elements ?? [], lasso.points, measureText);
		}
		const bounds = unionBounds(strokes, elements, measureText);
		if (!bounds) return;
		this.selection = { pageIndex: lasso.pageIndex, strokes, elements, bounds, matrix: IDENTITY };
		this.pushSelection();
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
		this.pushSelection();
	}

	/** Applies the dragged transform to the document as one undoable step; the selection stays on the new strokes and elements. */
	private commitSelectionTransform(): void {
		const sel = this.selection;
		const page = sel && this.pageAtIndex(sel.pageIndex);
		if (!sel || !page || isIdentity(sel.matrix)) return;
		const present = sel.strokes.filter((s) => page.strokes.includes(s));
		const presentEls = sel.elements.filter((e) => page.elements?.includes(e));
		if (present.length === 0 && presentEls.length === 0) {
			this.clearSelection();
			return;
		}
		const moved = present.map((s) => freezeStroke(transformStroke(s, sel.matrix)));
		const movedEls = presentEls.map((e) => transformElement(e, sel.matrix, measureText));
		const commands: Command[] = [
			...present.map((s, i) => new ReplaceStroke(page.id, s, [moved[i]!], page.strokes.indexOf(s))),
			...presentEls.map((e, i) => new ReplaceElement(page.id, e, movedEls[i]!)),
		];
		this.history.execute(new Batch("Transform selection", commands));
		sel.strokes = moved;
		sel.elements = movedEls;
		sel.matrix = IDENTITY;
		sel.bounds = unionBounds(moved, movedEls, measureText) ?? sel.bounds;
		this.pushSelection();
		this.renderer?.invalidate();
		this.session?.markChanged();
		this.updateHistoryButtons();
		this.scheduleNavRefresh();
	}

	// --- selection actions: restyle, copy, cut, paste, duplicate, white to transparent ---

	private mountSelectionActions(): void {
		this.selectionActions = new SelectionActions(this.body, {
			app: this.app,
			folder: () => this.host.settings.folder,
			media: () => this.media,
			doc: () => this.session?.doc ?? null,
			editable: () => this.editable(),
			lassoActive: () => this.tools.tool === "lasso",
			selection: () => this.selection,
			select: (pageIndex, strokes, elements) => this.selectItems(pageIndex, strokes, elements),
			execute: (cmd) => {
				this.history.execute(cmd);
				this.afterHistoryChange();
				this.renderer?.invalidate();
			},
			deleteSelection: () => this.deleteSelection(),
			pasteTarget: () => this.pasteTarget(),
			textStyle: () => ({ fontSize: this.tools.textSize, color: this.tools.penColor }),
			stillHere: (doc) => this.session?.doc === doc && this.editable() && !this.controller?.drawing,
		});
	}

	/** Selects exactly these items (the lasso tool is switched on, so they can be moved at once). */
	private selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void {
		this.commitText();
		this.toolbar.setTool("lasso");
		const bounds = unionBounds(strokes, elements, measureText);
		if (!bounds) {
			this.clearSelection();
			return;
		}
		this.drag = null;
		this.selection = { pageIndex, strokes, elements, bounds, matrix: IDENTITY };
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
}

/** Notice text for a failed image insert: HEIF/HEIC gets its own, actionable message. */
function insertFailure(e: unknown): string {
	if (e instanceof PhotoDecodeError && e.reason === "heic") return t("scan.heic");
	return t("insert.failed", { error: e instanceof Error ? e.message : String(e) });
}
