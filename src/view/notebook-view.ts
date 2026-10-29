import { FileView, Notice, Scope, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { findHitStrokes } from "../ink/hit-test";
import { InputPolicy } from "../ink/input-policy";
import { PointerController, type InkSample } from "../ink/pointer-controller";
import { PressureModel } from "../ink/pressure";
import { Renderer } from "../ink/renderer";
import { clampToPage, fitWidth, pan, screenToPage, zoomAt, type Size, type Viewport } from "../ink/viewport";
import { createStroke, findPage, quantizePoint } from "../model/document";
import { AddStroke, EraseStrokes, History, type ErasedItem } from "../model/history";
import { FILE_EXTENSION, type NotebookDocument, type Page, type Point, type Stroke } from "../model/types";
import { DocumentSession, type SaveState, type SessionMode } from "../storage/session";
import { VaultDocumentIO } from "../storage/vault-io";
import { backupFolder, type NotebookSettings } from "../settings";
import { COLORS, Toolbar, WIDTHS, type ToolbarState } from "./toolbar";

export const VIEW_TYPE = "notebook-view";

/** Eraser radius in CSS px, converted to pt at the current zoom. */
const ERASER_RADIUS_PX = 10;
/** A stroke may start this far outside the page (pt). */
const PAGE_TOLERANCE = 8;

export interface NotebookHost {
	settings: NotebookSettings;
}

interface ActiveStroke {
	pageId: string;
	stroke: Stroke;
	predicted: Point[];
}

interface ActiveErase {
	pageId: string;
	items: ErasedItem[];
	last: [number, number];
}

export class NotebookView extends FileView {
	navigation = true;

	private session: DocumentSession | null = null;
	private readonly history = new History(() => this.requireDoc());
	private readonly policy: InputPolicy;
	private readonly pressure: PressureModel;

	private toolbar!: Toolbar;
	private stage!: HTMLElement;
	private messageEl!: HTMLElement;
	private renderer: Renderer | null = null;
	private controller: PointerController | null = null;
	private resizeObserver: ResizeObserver | null = null;

	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	private viewSize: Size = { width: 0, height: 0 };
	private fitMode = true;
	private tools: ToolbarState = { tool: "pen", color: COLORS[0], width: WIDTHS[1]!.width };

	private active: ActiveStroke | null = null;
	private erasing: ActiveErase | null = null;
	private lastBackupPath: string | null = null;
	private lastErrorAt = 0;

	constructor(leaf: WorkspaceLeaf, private readonly host: NotebookHost) {
		super(leaf);
		this.policy = new InputPolicy({
			fingerDrawing: host.settings.fingerDrawing,
			palmRejectionMs: host.settings.palmRejectionMs,
		});
		this.pressure = new PressureModel(host.settings.pressureMode);
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

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("notebook-view");
		this.toolbar = new Toolbar(this.contentEl, this.tools, {
			change: (state) => (this.tools = state),
			undo: () => this.undo(),
			redo: () => this.redo(),
			fit: () => this.fitToWidth(),
		});
		this.stage = this.contentEl.createDiv({ cls: "notebook-stage" });
		this.messageEl = this.contentEl.createDiv({ cls: "notebook-message" });
		this.messageEl.hide();
		this.toolbar.setEditable(false);

		this.renderer = new Renderer(this.stage);
		this.controller = new PointerController(this.stage, this.policy, {
			drawStart: (s, eraser) => this.drawStart(s, eraser),
			drawMove: (samples, predicted) => this.drawMove(samples, predicted),
			drawEnd: (cancelled) => this.drawEnd(cancelled),
			pan: (dx, dy) => this.setViewport(pan(this.viewport, dx, dy)),
			zoom: (factor, fx, fy) => {
				this.fitMode = false;
				this.setViewport(zoomAt(this.viewport, factor, fx, fy));
			},
		});
		this.controller.predictionEnabled = this.host.settings.prediction;

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
			{ busy: () => this.active !== null || this.erasing !== null },
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
		this.renderer?.setPage(null);
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
		this.policy.settings = { fingerDrawing: settings.fingerDrawing, palmRejectionMs: settings.palmRejectionMs };
		this.pressure.mode = settings.pressureMode;
		if (this.controller) this.controller.predictionEnabled = settings.prediction;
	}

	undo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		if (this.history.undo()) this.afterHistoryChange();
	}

	redo(): void {
		if (!this.editable() || this.controller?.drawing) return;
		if (this.history.redo()) this.afterHistoryChange();
	}

	fitToWidth(): void {
		this.fitMode = true;
		this.refit(false);
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

	private currentPage(): Page | null {
		return this.session?.doc?.pages[0] ?? null;
	}

	private onDocumentLoaded(doc: NotebookDocument | null, mode: SessionMode, problem: string | null): void {
		this.active = null;
		this.erasing = null;
		this.history.clear();
		this.renderer?.setLive(null);
		if (doc && mode === "ok") {
			this.messageEl.hide();
			this.stage.show();
			this.toolbar.setEditable(true);
			this.renderer?.setPage(doc.pages[0] ?? null);
			this.refit(true);
		} else {
			this.stage.hide();
			this.toolbar.setEditable(false);
			this.renderer?.setPage(null);
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
		this.renderer?.invalidate();
		this.session?.markChanged();
		this.updateHistoryButtons();
	}

	private updateHistoryButtons(): void {
		this.toolbar.setHistory(this.editable() && this.history.canUndo(), this.editable() && this.history.canRedo());
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

	/** In fit mode, rescales to the view width; `keepTop` keeps the same page line at the top (rotation). */
	private refit(keepTop: boolean): void {
		const page = this.currentPage();
		if (!page || this.viewSize.width === 0) return;
		if (!this.fitMode) {
			this.setViewport(this.viewport);
			return;
		}
		const topY = screenToPage(this.viewport, 0, 0)[1];
		const fitted = fitWidth(this.viewSize, page);
		if (keepTop && topY > 0) fitted.offsetY = -topY * fitted.scale;
		this.setViewport(fitted);
	}

	private setViewport(v: Viewport): void {
		const page = this.currentPage();
		this.viewport = page ? clampToPage(v, this.viewSize, page) : v;
		this.renderer?.setViewport(this.viewport);
	}

	// --- input ---

	private toPage(s: InkSample): [number, number] {
		return screenToPage(this.viewport, s.x, s.y);
	}

	private drawStart(sample: InkSample, eraserButton: boolean): boolean {
		const page = this.currentPage();
		if (!page || !this.editable()) return false;
		const [x, y] = this.toPage(sample);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
		if (x < -PAGE_TOLERANCE || y < -PAGE_TOLERANCE || x > page.width + PAGE_TOLERANCE || y > page.height + PAGE_TOLERANCE) {
			return false;
		}
		if (eraserButton || this.tools.tool === "eraser") {
			this.erasing = { pageId: page.id, items: [], last: [x, y] };
			this.eraseAlong(x, y);
			return true;
		}
		this.pressure.begin();
		const p = this.pressure.sample(sample.pointerType, sample.pressure, sample.x, sample.y, sample.t);
		this.active = {
			pageId: page.id,
			stroke: createStroke(this.tools.color, this.tools.width, [quantizePoint(x, y, p)]),
			predicted: [],
		};
		this.pushLive();
		return true;
	}

	private drawMove(samples: InkSample[], predicted: InkSample[]): void {
		if (this.erasing) {
			for (const s of samples) {
				const [x, y] = this.toPage(s);
				if (Number.isFinite(x) && Number.isFinite(y)) this.eraseAlong(x, y);
			}
			return;
		}
		const active = this.active;
		if (!active) return;
		const points = active.stroke.points;
		for (const s of samples) {
			const [x, y] = this.toPage(s);
			// A single non-finite point would make every later save fail validation.
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			const p = this.pressure.sample(s.pointerType, s.pressure, s.x, s.y, s.t);
			const q = quantizePoint(x, y, p);
			const last = points[points.length - 1];
			if (last && last[0] === q[0] && last[1] === q[1]) {
				last[2] = Math.max(last[2], q[2]);
				continue;
			}
			points.push(q);
		}
		const lastP = points[points.length - 1]?.[2] ?? 0.5;
		active.predicted = predicted
			.map((s): Point => [...this.toPage(s), lastP])
			.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
		this.pushLive();
	}

	private drawEnd(cancelled: boolean): void {
		const erasing = this.erasing;
		if (erasing) {
			this.erasing = null;
			if (erasing.items.length > 0) {
				this.history.record(new EraseStrokes(erasing.pageId, erasing.items));
				this.session?.markChanged();
				this.updateHistoryButtons();
			}
			return;
		}
		const active = this.active;
		this.active = null;
		this.renderer?.setLive(null);
		if (!active || cancelled || !this.session?.doc) return;
		const page = findPage(this.session.doc, active.pageId);
		if (!page) return;
		this.history.execute(new AddStroke(page.id, active.stroke, page.strokes.length));
		this.renderer?.appendStroke(active.stroke);
		this.session.markChanged();
		this.updateHistoryButtons();
	}

	private pushLive(): void {
		const a = this.active;
		if (!a) return;
		this.renderer?.setLive({ color: a.stroke.color, width: a.stroke.width, points: a.stroke.points, predicted: a.predicted });
	}

	private eraseAlong(x: number, y: number): void {
		const erasing = this.erasing;
		const doc = this.session?.doc;
		if (!erasing || !doc || !this.renderer) return;
		const page = findPage(doc, erasing.pageId);
		if (!page) return;
		const [ax, ay] = erasing.last;
		erasing.last = [x, y];
		const radius = ERASER_RADIUS_PX / this.viewport.scale;
		const hits = findHitStrokes(page.strokes, ax, ay, x, y, radius, this.renderer.boundsOf);
		if (hits.length === 0) return;
		for (const stroke of hits) {
			const index = page.strokes.indexOf(stroke);
			if (index < 0) continue;
			page.strokes.splice(index, 1);
			erasing.items.push({ stroke, index });
		}
		this.renderer.invalidate();
	}
}
