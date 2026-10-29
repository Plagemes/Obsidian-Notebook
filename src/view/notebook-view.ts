import { FileView, Menu, Notice, Scope, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { findHitStrokes, type BBox } from "../ink/hit-test";
import { InputPolicy } from "../ink/input-policy";
import { selectionBounds, strokesInLasso, transformStroke } from "../ink/lasso";
import { layoutPages, nearestPage, pageAt, toPageLocal, type Layout } from "../ink/layout";
import { PointerController, type InkSample } from "../ink/pointer-controller";
import { PressureModel } from "../ink/pressure";
import { Renderer, selectionHandles } from "../ink/renderer";
import { eraseSegment } from "../ink/segment-erase";
import { Stabilizer } from "../ink/stabilizer";
import { apply, IDENTITY, invert, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Matrix } from "../ink/transform";
import { clampToPage, fitWidth, pan, PAGE_MARGIN, screenToPage, zoomAt, type Size, type Viewport } from "../ink/viewport";
import { createId, createPage, createStroke, quantizePoint } from "../model/document";
import { duplicatePage } from "../model/pages";
import {
	AddPage, AddStroke, Batch, DeletePage, History, MovePage, removeStrokes, ReplaceStroke, SetPageSize, SetPaper, type Command,
} from "../model/history";
import { freezeStroke } from "../model/serialize";
import {
	FILE_EXTENSION, PAGE_SIZES, PAPER_KINDS, PAPER_SPACING,
	type NotebookDocument, type Page, type PageSizeName, type PaperKind, type Point, type Stroke,
} from "../model/types";
import { DocumentSession, type SaveState, type SessionMode } from "../storage/session";
import { VaultDocumentIO } from "../storage/vault-io";
import { backupFolder, type NotebookSettings } from "../settings";
import { exportPdf, exportSvg } from "./export";
import { DEFAULT_TOOLS, Toolbar, type ToolbarState } from "./toolbar";

export const VIEW_TYPE = "notebook-view";

/** Eraser radius in CSS px, converted to pt at the current zoom. */
const ERASER_RADIUS_PX = 10;
/** Selection handle diameter in CSS px. */
const HANDLE_PX = 22;
/** A stroke may start this far outside the page (pt). */
const PAGE_TOLERANCE = 8;

export interface NotebookHost {
	settings: NotebookSettings;
}

interface ActiveStroke {
	pageIndex: number;
	stroke: Stroke;
	predicted: Point[];
}

interface ActiveErase {
	commands: Command[];
	/** Last eraser position in document coordinates. */
	last: [number, number];
}

interface Lasso {
	pageIndex: number;
	points: Array<[number, number]>;
}

interface Selection {
	pageIndex: number;
	strokes: Stroke[];
	/** Bounds of `strokes` before `matrix`, page coordinates. */
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
	private readonly stabilizer: Stabilizer;

	private toolbar!: Toolbar;
	private stage!: HTMLElement;
	private messageEl!: HTMLElement;
	private perfEl!: HTMLElement;
	private renderer: Renderer | null = null;
	private controller: PointerController | null = null;
	private resizeObserver: ResizeObserver | null = null;

	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	private viewSize: Size = { width: 0, height: 0 };
	private layout: Layout | null = null;
	private fitMode = true;
	private tools: ToolbarState = { ...DEFAULT_TOOLS };

	private active: ActiveStroke | null = null;
	private erasing: ActiveErase | null = null;
	private lasso: Lasso | null = null;
	private selection: Selection | null = null;
	private drag: SelectionDrag | null = null;

	private lastBackupPath: string | null = null;
	private lastErrorAt = 0;

	private perfInput: number | null = null;
	private perfLastFrame = 0;
	private readonly perfFrames: number[] = [];
	private readonly perfLatency: number[] = [];
	private perfShownAt = 0;

	constructor(leaf: WorkspaceLeaf, private readonly host: NotebookHost) {
		super(leaf);
		const s = host.settings;
		this.policy = new InputPolicy({ fingerDrawing: s.fingerDrawing, palmRejectionMs: s.palmRejectionMs, palmContactPx: s.palmContactPx });
		this.pressure = new PressureModel(s.pressureMode);
		this.stabilizer = new Stabilizer(s.stabilization);
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
		return extension === FILE_EXTENSION;
	}

	/** Size of the drawing area, for the benchmark. */
	get stageSize(): Size {
		return this.viewSize;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("notebook-view");
		this.toolbar = new Toolbar(this.contentEl, this.tools, {
			change: (state) => this.onToolsChanged(state),
			undo: () => this.undo(),
			redo: () => this.redo(),
			addPage: () => this.addPage(),
			pageMenu: (evt) => this.openPageMenu(evt),
			deleteSelection: () => this.deleteSelection(),
			fit: () => this.fitToWidth(),
		});
		this.toolbar.setSelection(false);
		this.stage = this.contentEl.createDiv({ cls: "notebook-stage" });
		this.perfEl = this.stage.createDiv({ cls: "notebook-perf" });
		this.messageEl = this.contentEl.createDiv({ cls: "notebook-message" });
		this.messageEl.hide();
		this.toolbar.setEditable(false);

		this.renderer = new Renderer(this.stage);
		this.controller = new PointerController(this.stage, this.policy, {
			drawStart: (s, eraser) => this.drawStart(s, eraser),
			drawMove: (samples, predicted) => this.drawMove(samples, predicted),
			drawEnd: (cancelled) => this.drawEnd(cancelled),
			pan: (dx, dy) => this.setViewport(pan(this.viewport, dx, dy), true),
			zoom: (factor, fx, fy) => {
				this.fitMode = false;
				this.setViewport(zoomAt(this.viewport, factor, fx, fy), true);
			},
		});
		this.applySettings(this.host.settings);

		this.resizeObserver = new ResizeObserver(() => this.measure());
		this.resizeObserver.observe(this.stage);
		this.registerDomEvent(window, "resize", () => this.measure());

		// Android may kill a backgrounded app without notice: save as soon as we are hidden.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.flushNow();
		});
		this.registerDomEvent(window, "pagehide", () => void this.flushNow());

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
		await this.closeSession();
		this.controller?.destroy();
		this.controller = null;
		this.renderer?.destroy();
		this.renderer = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
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
				onBackup: (path, reason) => {
					new Notice(t(reason === "conflict" ? "notice.conflict" : "notice.backup", { path }), 8000);
					if (!current()) return;
					this.lastBackupPath = path;
					if (session.mode === "broken" || session.mode === "readonly") this.showProblem();
				},
				onError: (message) => {
					if (current()) this.showError(message);
				},
			},
			{ busy: () => this.active !== null || this.erasing !== null || this.drag !== null },
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
		this.renderer?.setDocument(null, null);
		await super.onUnloadFile(file);
	}

	/** Closes the stroke in progress and writes everything to disk. */
	async flushNow(): Promise<void> {
		this.controller?.finishActiveStroke();
		await this.session?.flush();
	}

	/** Final flush (with retries and an "unsaved" backup as last resort), then detaches the session. */
	private async closeSession(): Promise<void> {
		this.controller?.finishActiveStroke();
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
		this.policy.settings = {
			fingerDrawing: settings.fingerDrawing,
			palmRejectionMs: settings.palmRejectionMs,
			palmContactPx: settings.palmContactPx,
		};
		this.pressure.mode = settings.pressureMode;
		this.stabilizer.level = settings.stabilization;
		if (this.controller) this.controller.predictionEnabled = settings.prediction;
		this.perfEl?.toggleClass("notebook-hidden", !settings.perfOverlay);
		if (this.renderer) this.renderer.onFrame = settings.perfOverlay ? (t) => this.onFrame(t) : null;
	}

	undo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.clearSelection();
		if (this.history.undo()) this.afterHistoryChange();
	}

	redo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		this.clearSelection();
		if (this.history.redo()) this.afterHistoryChange();
	}

	fitToWidth(): void {
		this.fitMode = true;
		this.refit(false);
	}

	/** Inserts a blank page after the one in view and scrolls to it. */
	addPage(): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable() || this.controller?.drawing) return;
		this.clearSelection();
		const index = this.currentPageIndex() + 1;
		// A new page takes the size and paper of the page in view.
		const like = doc.pages[index - 1];
		const page = like ? createPage({ width: like.width, height: like.height }, { ...like.paper }) : createPage();
		this.history.execute(new AddPage(page, index));
		this.afterHistoryChange();
		this.scrollToPage(index);
	}

	private scrollToPage(index: number): void {
		const box = this.layout?.boxes[index];
		if (box) this.setViewport({ ...this.viewport, offsetY: PAGE_MARGIN - box.y * this.viewport.scale });
	}

	/** Page menu: reorder, duplicate, delete, paper, size, export. Every change is undoable. */
	private openPageMenu(evt: MouseEvent): void {
		const doc = this.session?.doc;
		if (!doc || !this.editable()) return;
		const index = this.currentPageIndex();
		const page = doc.pages[index];
		if (!page) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("page.duplicate")).setIcon("copy").onClick(() => this.pageCommand(new AddPage(duplicatePage(page), index + 1), index + 1, page)));
		menu.addItem((i) => i.setTitle(t("page.moveUp")).setIcon("arrow-up").setDisabled(index === 0)
			.onClick(() => this.pageCommand(new MovePage(page.id, index, index - 1), index - 1, page)));
		menu.addItem((i) => i.setTitle(t("page.moveDown")).setIcon("arrow-down").setDisabled(index >= doc.pages.length - 1)
			.onClick(() => this.pageCommand(new MovePage(page.id, index, index + 1), index + 1, page)));
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
		menu.addSeparator();
		const file = this.file;
		if (file) {
			menu.addItem((i) => i.setTitle(t("export.pagePdf")).setIcon("file-output")
				.onClick(() => void exportPdf(this.app, file, [page], ` p${index + 1}`)));
			menu.addItem((i) => i.setTitle(t("export.notebookPdf")).setIcon("file-output").onClick(() => void this.exportNotebookPdf()));
			menu.addItem((i) => i.setTitle(t("export.pageSvg")).setIcon("image")
				.onClick(() => void exportSvg(this.app, file, page, ` p${index + 1}`)));
		}
		menu.showAtMouseEvent(evt);
	}

	async exportNotebookPdf(): Promise<void> {
		const doc = this.session?.doc;
		if (doc && this.file) await exportPdf(this.app, this.file, doc.pages);
	}

	private pageCommand(cmd: Command, scrollTo: number, page: Page): void {
		// The menu may have stayed open while the file was reloaded (read-only, broken, or another document).
		if (this.controller?.drawing || !this.editable() || !this.session?.doc?.pages.includes(page)) return;
		this.clearSelection();
		this.history.execute(cmd);
		this.afterHistoryChange();
		this.scrollToPage(scrollTo);
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
		const batch = removeStrokes(page.id, page.strokes, sel.strokes, "Delete selection");
		this.clearSelection();
		if (!batch) return;
		this.history.execute(batch);
		this.afterHistoryChange();
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
	}

	private onDocumentLoaded(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void {
		this.active = null;
		this.erasing = null;
		this.lasso = null;
		this.drag = null;
		this.clearSelection();
		this.history.clear();
		this.renderer?.setLive(null);
		this.renderer?.setLasso(null);
		if (doc && mode === "ok") {
			this.messageEl.hide();
			this.stage.show();
			this.toolbar.setEditable(true);
			this.refreshLayout();
			this.refit(true);
		} else {
			this.stage.hide();
			this.toolbar.setEditable(false);
			this.layout = null;
			this.renderer?.setDocument(null, null);
			this.showProblem(problem);
		}
		this.updateHistoryButtons();
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
	}

	private updateHistoryButtons(): void {
		this.toolbar.setHistory(this.editable() && this.history.canUndo(), this.editable() && this.history.canRedo());
	}

	private updatePageIndicator(): void {
		const n = this.session?.doc?.pages.length ?? 0;
		this.toolbar.setPage(n ? this.currentPageIndex() + 1 : 0, n);
	}

	private onToolsChanged(state: ToolbarState): void {
		if (state.tool !== "lasso") this.clearSelection();
		this.tools = state;
	}

	// --- view geometry ---

	onResize(): void {
		this.measure();
	}

	private measure(): void {
		const rect = this.stage.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.viewSize = { width: rect.width, height: rect.height };
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
		this.updatePageIndicator();
	}

	// --- input ---

	private toDoc(s: InkSample): [number, number] {
		return screenToPage(this.viewport, s.x, s.y);
	}

	private toLocal(pageIndex: number, s: InkSample): [number, number] | null {
		const box = this.layout?.boxes[pageIndex];
		if (!box) return null;
		const [x, y] = this.toDoc(s);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return toPageLocal(box, x, y);
	}

	private drawStart(sample: InkSample, eraserButton: boolean): boolean {
		const layout = this.layout;
		if (!layout || !this.editable()) return false;
		const [dx, dy] = this.toDoc(sample);
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
		const tool = eraserButton ? "eraser" : this.tools.tool;

		if (tool === "eraser") {
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
		const local = toPageLocal(layout.boxes[pageIndex]!, dx, dy);

		if (tool === "lasso") {
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

		this.stabilizer.reset(local[0], local[1]);
		this.pressure.begin();
		const p = this.pressure.sample(sample.pointerType, sample.pressure, sample.x, sample.y, sample.t);
		const highlighter = tool === "highlighter";
		this.active = {
			pageIndex,
			stroke: createStroke(
				highlighter ? this.tools.highlighterColor : this.tools.penColor,
				highlighter ? this.tools.highlighterWidth : this.tools.penWidth,
				[quantizePoint(local[0], local[1], p)],
				highlighter ? "highlighter" : "pen",
			),
			predicted: [],
		};
		this.pushLive();
		return true;
	}

	private drawMove(samples: InkSample[], predicted: InkSample[]): void {
		const lastSample = samples[samples.length - 1];
		if (lastSample) this.perfInput = lastSample.t;

		if (this.erasing) {
			for (const s of samples) {
				const [x, y] = this.toDoc(s);
				if (Number.isFinite(x) && Number.isFinite(y)) this.eraseTo(x, y);
			}
			return;
		}

		const lasso = this.lasso;
		if (lasso) {
			const minStep = 2 / this.viewport.scale;
			for (const s of samples) {
				const p = this.toLocal(lasso.pageIndex, s);
				const last = lasso.points[lasso.points.length - 1]!;
				if (p && Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) lasso.points.push(p);
			}
			this.renderer?.setLasso(lasso);
			return;
		}

		if (this.drag && this.selection && lastSample) {
			const p = this.toLocal(this.selection.pageIndex, lastSample);
			if (p) this.updateDrag(p);
			return;
		}

		const active = this.active;
		if (!active) return;
		const points = active.stroke.points;
		for (const s of samples) {
			const local = this.toLocal(active.pageIndex, s);
			// A single non-finite point would make every later save fail validation.
			if (!local) continue;
			const [x, y] = this.stabilizer.push(local[0], local[1]);
			const p = this.pressure.sample(s.pointerType, s.pressure, s.x, s.y, s.t);
			this.pushPoint(points, quantizePoint(x, y, p));
		}
		const lastP = points[points.length - 1]?.[2] ?? 0.5;
		active.predicted = predicted
			.map((s) => this.toLocal(active.pageIndex, s))
			.filter((p): p is [number, number] => p !== null)
			.map(([x, y]): Point => [x, y, lastP]);
		this.pushLive();
	}

	private pushPoint(points: Point[], q: Point): void {
		const last = points[points.length - 1];
		if (last && last[0] === q[0] && last[1] === q[1]) {
			last[2] = Math.max(last[2], q[2]);
			return;
		}
		points.push(q);
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
			}
			return;
		}

		const lasso = this.lasso;
		if (lasso) {
			this.lasso = null;
			this.renderer?.setLasso(null);
			const page = this.pageAtIndex(lasso.pageIndex);
			if (cancelled || !page) return;
			const strokes = strokesInLasso(page.strokes, lasso.points);
			const bounds = selectionBounds(strokes);
			if (bounds) {
				this.selection = { pageIndex: lasso.pageIndex, strokes, bounds, matrix: IDENTITY };
				this.pushSelection();
			}
			return;
		}

		if (this.drag) {
			this.drag = null;
			this.commitSelectionTransform();
			return;
		}

		const active = this.active;
		this.active = null;
		this.renderer?.setLive(null);
		const tail = this.stabilizer.finish();
		const page = active && this.pageAtIndex(active.pageIndex);
		if (!active || cancelled || !page) return;
		for (const [x, y] of tail) {
			const last = active.stroke.points[active.stroke.points.length - 1]!;
			this.pushPoint(active.stroke.points, quantizePoint(x, y, last[2]));
		}
		const stroke = freezeStroke(active.stroke);
		this.history.execute(new AddStroke(page.id, stroke, page.strokes.length));
		this.renderer?.appendStroke(active.pageIndex, stroke);
		this.session?.markChanged();
		this.updateHistoryButtons();
	}

	private pushLive(): void {
		const a = this.active;
		if (!a) return;
		this.renderer?.setLive({
			pageIndex: a.pageIndex, tool: a.stroke.tool, color: a.stroke.color, width: a.stroke.width,
			points: a.stroke.points, predicted: a.predicted,
		});
	}

	/** Erases along the eraser's movement to the document point (x, y), on the page under it. */
	private eraseTo(x: number, y: number): void {
		const erasing = this.erasing;
		const doc = this.session?.doc;
		const layout = this.layout;
		if (!erasing || !doc || !layout || !this.renderer) return;
		const [px, py] = erasing.last;
		erasing.last = [x, y];
		const radius = ERASER_RADIUS_PX / this.viewport.scale;
		const pageIndex = pageAt(layout, x, y, radius);
		const page = doc.pages[pageIndex];
		const box = layout.boxes[pageIndex];
		if (!page || !box) return;
		const [ax, ay] = toPageLocal(box, px, py);
		const [bx, by] = toPageLocal(box, x, y);
		const hits = findHitStrokes(page.strokes, ax, ay, bx, by, radius, this.renderer.boundsOf);
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

	// --- selection ---

	private clearSelection(): void {
		if (!this.selection && !this.drag) return;
		this.selection = null;
		this.drag = null;
		this.renderer?.setSelection(null);
		this.toolbar?.setSelection(false);
	}

	private pushSelection(): void {
		const sel = this.selection;
		this.toolbar.setSelection(!!sel);
		this.renderer?.setSelection(sel ? { ...sel, handle: HANDLE_PX } : null);
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

	/** Applies the dragged transform to the document as one undoable step; the selection stays on the new strokes. */
	private commitSelectionTransform(): void {
		const sel = this.selection;
		const page = sel && this.pageAtIndex(sel.pageIndex);
		if (!sel || !page || isIdentity(sel.matrix)) return;
		const present = sel.strokes.filter((s) => page.strokes.includes(s));
		if (present.length === 0) {
			this.clearSelection();
			return;
		}
		const moved = present.map((s) => freezeStroke(transformStroke(s, sel.matrix)));
		const commands = present.map((s, i) => new ReplaceStroke(page.id, s, [moved[i]!], page.strokes.indexOf(s)));
		this.history.execute(new Batch("Transform selection", commands));
		sel.strokes = moved;
		sel.matrix = IDENTITY;
		sel.bounds = selectionBounds(moved) ?? sel.bounds;
		this.pushSelection();
		this.renderer?.invalidate();
		this.session?.markChanged();
		this.updateHistoryButtons();
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
		const st = this.renderer.stats;
		this.perfEl.setText(
			`frame ${avg(frames).toFixed(1)} ms · input→frame ${latency.length ? avg(latency).toFixed(1) + " ms" : "–"}\n`
			+ `redraw ${st.staticMs.toFixed(1)} ms · ${st.strokesDrawn} strokes · ${st.pagesDrawn} pages`,
		);
	}
}
