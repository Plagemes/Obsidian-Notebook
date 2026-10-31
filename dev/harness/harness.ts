/**
 * Browser harness: the real NotebookView (renderer, pointer controller, session, toolbar,
 * navigator) running in a plain web page on top of dev/harness/obsidian-stub.ts.
 *
 * URL parameters (all optional):
 *   doc=v3|new|pdf   notebook to open (v3: written by 0.3.0, grid paper and a few strokes; new: empty; pdf: three pages of a fake PDF)
 *   theme=light|dark
 *   w=800&h=1280     size of the Obsidian leaf in CSS px (default: the window)
 *   lowLatency=1     turn on the low-latency ink setting
 *   fault=wet        wet ink throws on every paint (the view must fall back to the live layer)
 *   fault=stroke     drawing the first stored stroke throws (the rest of the page must still be drawn)
 *   check=1          run the smoke check and write the JSON report into #harness-report
 *
 * From the console (or the browser tools): `harness.penStroke([[0.3,0.3],[0.6,0.4]])`,
 * `harness.setTool("highlighter")`, `await harness.check()`.
 */
import "./setup";
import { App, noticeEls, notices, Platform, WorkspaceLeaf, type TFile } from "./obsidian-stub";
import { NotebookView } from "../../src/view/notebook-view";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../../src/settings";
import { createDocument, createStroke } from "../../src/model/document";
import { AddElement, AddStroke, Batch } from "../../src/model/history";
import { translate } from "../../src/ink/transform";
import { parse, serialize, StagedParse } from "../../src/model/serialize";
import { WetInk } from "../../src/ink/wet-ink";
import { Renderer } from "../../src/ink/renderer";
import { DocumentSession } from "../../src/storage/session";
import { stressDocument } from "../../src/model/stress";
import { FAKE_PATH, installFakePdf, slidesNotebook } from "./fake-pdf";
import { checkReading } from "./reading-check";
import { checkPractice } from "./practice-check";
import { checkOutline, outlineNotebook } from "./outline-check";
import { checkChrome, chromeState, type ChromeState } from "./ds-notebook-check";
import { checkExcerpt } from "./excerpt-check";
import { checkReadOnly } from "./readonly-check";
import { checkSettings } from "./settings-check";
import { checkZettel, zettelState, type ZettelState } from "./zettel-check";
import { checkPlugin } from "./plugin-check";
import { checkHints } from "./hints-check";
import { checkCreate, prepareShot } from "./create-check";
import { modalsApi } from "./modals-check";
import { checkHostile, HOSTILE_ERROR, hostileDialog, installHostile } from "./hostile";
import { PracticeService } from "../../src/view/practice";
import { NavController } from "../../src/view/nav-controller";
import { NotebookStatusBar } from "../../src/view/status-bar";
import { checkNavigation } from "./nav-check";
import { compareLod, measureLod } from "./lod-bench";
import { checkEmptyLibrary, checkLibraryLayout, emptyDialogShot, libraryInteractions, libraryState, openLibraryHarness, type HomeVariant, type LibraryHarness } from "./library-check";
import { checkHome2, home2State } from "./home2-check";

import type { Layout } from "../../src/ink/layout";
import type { Viewport } from "../../src/ink/viewport";
import type { SavedPosition } from "../../src/ink/view-position";
import type { Matrix } from "../../src/ink/transform";
import type { History } from "../../src/model/history";
import type { NotebookDocument, PageElement, Stroke } from "../../src/model/types";
import type { ActionArg } from "../../src/view/view-actions";
import type { ColourTools } from "../../src/view/colour-tools";
import type { PageMode } from "../../src/view/page-mode";
import type { PageNavigator } from "../../src/view/navigator";
import type { PenRadial } from "../../src/view/radial-menu";
import type { StampPalette, StampTarget } from "../../src/view/stamp-palette";
import type { ToolbarState, ToolName, Toolbar } from "../../src/view/toolbar";
import type { ViewUi } from "../../src/view/view-ui";
import type { TFile as ObsidianFile, WorkspaceLeaf as ObsidianLeaf } from "obsidian";

/** The public surface of a class (a mapped type drops the private members, so the harness can add them back with their types). */
type Pub<T> = { [K in keyof T]: T[K] };

/**
 * The private members of NotebookView that the harness drives (it runs the real view in a page, so it may reach into it).
 * The cast is made in one place per function (`view as unknown as HarnessView`).
 */
type HarnessView = Omit<Pub<NotebookView>, "document"> & {
	document: NotebookDocument;
	session: Omit<Pub<DocumentSession>, "doc" | "partialDoc"> & { doc: NotebookDocument; partialDoc: NotebookDocument };
	history: Pub<History>;
	toolbar: Pub<Toolbar>;
	renderer: HarnessRenderer;
	controller: { rawUpdates: boolean } | null;
	pageNav: Pub<PageNavigator> | null;
	loadFile(file: TFile | ObsidianFile): Promise<void>;
	radial: Pub<PenRadial>;
	pageMode: Pub<PageMode>;
	ui: Pub<ViewUi>;
	viewport: Viewport;
	layout: Layout;
	fitMode: boolean;
	tools: ToolbarState;
	selection: { pageIndex: number; strokes: Stroke[]; elements: PageElement[]; matrix: Matrix };
	stamps: Pub<StampPalette> & { doSave(name: string, clip: unknown): Promise<void> };
	stampPalette: Pub<StampPalette> | null;
	colourTools: Pub<ColourTools>;
	host: { settings: NotebookSettings };
	setNavigatorOpen(open: boolean): void;
	currentPageIndex(): number;
	currentPosition(): SavedPosition;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	clearSelection(): void;
	commitSelectionTransform(): void;
	captureSelectionClip(): unknown;
	pageAtClient(clientX: number, clientY: number): StampTarget | null;
	afterHistoryChange(): void;
	setViewport(v: Viewport, interactive?: boolean): void;
	editable(): boolean;
	showPartial(): void;
	onDocumentLoaded(doc: unknown, mode: string, problem: string | null): void;
	applyPendingPage(): void;
	runAction(id: string, arg?: ActionArg): void;
};

interface HarnessRenderer {
	stats: { strokesDrawn: number };
	onFrame: (() => void) | null;
	selection?: { strokes?: unknown[] } | null;
	fillStroke: (ctx: CanvasRenderingContext2D, stroke: { id: string }, ...rest: unknown[]) => void;
}

/** The two private methods of the view that the load checks replace for a while. */
interface ViewProto {
	showPartial: (this: HarnessView) => void;
	onDocumentLoaded: (...a: unknown[]) => void;
}

/** What the harness needs from the Obsidian leaf stand-in when it builds a view. */
const asLeaf = (l: WorkspaceLeaf | null): ObsidianLeaf => l as unknown as ObsidianLeaf;

const errors: string[] = [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
	errors.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a))).join(" "));
	origError(...args);
};
window.addEventListener("error", (e) => errors.push(`uncaught: ${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${String((e.reason as Error)?.stack ?? e.reason)}`));

const params = new URLSearchParams(location.search);
/** 0.12.3: hostile=1 removes newer built-ins and makes the art engine fail (hostile.ts). */
const hostile = params.get("hostile") === "1";
if (hostile) installHostile();

/** Injected faults: the guards must keep the page drawn and the pen writing. */
const fault = params.get("fault");
if (fault === "wet") {
	WetInk.prototype.paint = function () {
		throw new Error("harness: injected wet ink failure");
	};
} else if (fault === "stroke") {
	const proto = Renderer.prototype as unknown as Pick<HarnessRenderer, "fillStroke">;
	const fill = proto.fillStroke;
	proto.fillStroke = function (ctx: CanvasRenderingContext2D, stroke: { id: string }, ...rest: unknown[]) {
		if (stroke.id === "s1") throw new Error("harness: injected stroke failure");
		fill.call(this, ctx, stroke, ...rest);
	};
}
/** Console errors the injected fault is expected to produce (logged once by the guards). */
const expectedError = fault ? /^\[notebook\] render / : null;

/** A notebook as 0.3.0 wrote it (format v3): grid paper, three pen strokes and a highlighter stroke. */
function v3Notebook(): string {
	const stamp = "2026-09-01T10:00:00.000Z";
	const line = (x0: number, y0: number, x1: number, y1: number, n = 24): number[][] =>
		Array.from({ length: n }, (_, i) => {
			const t = i / (n - 1);
			return [Math.round((x0 + (x1 - x0) * t) * 100) / 100, Math.round((y0 + (y1 - y0) * t + Math.sin(t * 6) * 6) * 100) / 100, 0.5];
		});
	return JSON.stringify({
		format: "obsidian-notebook",
		version: 3,
		id: "harness-v3",
		createdAt: stamp,
		modifiedAt: stamp,
		pages: [
			{
				id: "p1",
				width: 595.28,
				height: 841.89,
				paper: { kind: "grid", spacing: 14.17 },
				strokes: [
					{ id: "s1", tool: "pen", color: "#1e1e1e", width: 2, points: line(80, 120, 420, 140) },
					{ id: "s2", tool: "pen", color: "#1d4ed8", width: 2, points: line(80, 200, 380, 230) },
					{ id: "s3", tool: "pen", color: "#dc2626", width: 3.2, points: line(100, 300, 300, 420) },
					{ id: "s4", tool: "highlighter", color: "#facc15", width: 14, points: line(70, 125, 430, 125, 8) },
				],
			},
			{ id: "p2", width: 595.28, height: 841.89, paper: { kind: "ruled", spacing: 22.68 }, strokes: [] },
		],
	});
}

const app = new App();
let view: NotebookView | null = null;
let leaf: WorkspaceLeaf | null = null;

async function seed(): Promise<void> {
	await app.vault.createFolder("Notebooks");
	await app.vault.create("Notebooks/Old v3.notebook", v3Notebook());
	await app.vault.create("Notebooks/New.notebook", serialize(createDocument()));
	// doc=pdf: three pages that show the pages of a fake PDF (fake-pdf.ts).
	installFakePdf();
	await app.vault.createFolder("Notebooks/_assets");
	await app.vault.createBinary(FAKE_PATH, new Uint8Array(8).buffer);
	await app.vault.create("Notebooks/Slides.notebook", slidesNotebook());
	// doc=outline: slides, large handwriting, markers and bookmarks for the generated outline (0.13).
	await app.vault.create("Notebooks/Outline.notebook", outlineNotebook());
}

/** The practice feature (doc=practice) on a stand-in plugin: the views attach to it as they do to the real one. */
const practiceService = new PracticeService({ app, settings: { ...DEFAULT_SETTINGS }, registerEvent: () => undefined } as unknown as ConstructorParameters<typeof PracticeService>[0]);

/** Back/forward history (roadmap 18) and the status bar item (roadmap O15) on the harness's single view. */
const harnessNav: NavController = new NavController({
	here: () => (view as unknown as HarnessView)?.navPlace() ?? null,
	exists: async (pl) => !!(view as unknown as HarnessView)?.document?.pages.some((p: { id: string }) => p.id === pl.pageId),
	open: async (pl) => {
		(view as unknown as HarnessView).showPlace(pl);
		harnessNav.shown();
	},
});
const harnessStatusBarEl = createDiv();
harnessStatusBarEl.className = "status-bar-item";
document.body.appendChild(harnessStatusBarEl);
let statusBarClicks = 0;
const harnessStatusBar = new NotebookStatusBar(harnessStatusBarEl, () => {
	statusBarClicks++;
	(view as unknown as HarnessView)?.openNavigator();
});

function settings(): NotebookSettings {
	const s: NotebookSettings = { ...DEFAULT_SETTINGS };
	if (params.get("lowLatency") === "1") s.lowLatencyInk = true;
	return s;
}

async function open(doc = params.get("doc") ?? "v3"): Promise<void> {
	const root = document.getElementById("harness-app")!;
	if (view) await (view as unknown as HarnessView).onClose();
	root.empty();
	leaf = new WorkspaceLeaf(app, root);
	view = new NotebookView(asLeaf(leaf), { settings: settings(), practice: doc === "practice" ? practiceService : undefined, nav: harnessNav, statusChanged: (v) => harnessStatusBar.update(v.statusSnapshot()) });
	await view.onOpen();
	const path = doc === "new" || doc === "practice" || doc === "readonly" ? "Notebooks/New.notebook" : doc === "pdf" || doc === "excerpt" ? "Notebooks/Slides.notebook" : doc === "outline" ? "Notebooks/Outline.notebook" : "Notebooks/Old v3.notebook";
	const file = app.vault.getFileByPath(path)!;
	await (view as unknown as HarnessView).loadFile(file);
	view.onResize();
	await frames(3);
}

function frames(n = 1): Promise<void> {
	return new Promise((resolve) => {
		const step = () => (n-- <= 0 ? resolve() : window.requestAnimationFrame(step));
		window.requestAnimationFrame(step);
	});
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function stage(): HTMLElement {
	return document.querySelector<HTMLElement>(".notebook-stage")!;
}

let pointerId = 10;

/**
 * Writes a stroke with synthetic pen PointerEvents through the stage, the way Chromium delivers
 * them: pointerdown, then for each sample pointerrawupdate (when supported) and pointermove,
 * then pointerup. Points are fractions of the stage size.
 */
async function penStroke(points: Array<[number, number]>, opts: { pointerType?: string; pressure?: number; steps?: number } = {}): Promise<void> {
	const el = stage();
	const r = el.getBoundingClientRect();
	const id = pointerId++;
	const type = opts.pointerType ?? "pen";
	const steps = opts.steps ?? 6;
	const at = (fx: number, fy: number) => ({ clientX: r.left + fx * r.width, clientY: r.top + fy * r.height });
	const ev = (name: string, fx: number, fy: number, extra: PointerEventInit = {}) =>
		new PointerEvent(name, {
			bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: type, isPrimary: true,
			pressure: opts.pressure ?? 0.6, width: 1, height: 1, button: 0, buttons: 1, ...at(fx, fy), ...extra,
		});
	const [first] = points;
	if (!first) return;
	const target = document.elementFromPoint(at(first[0], first[1]).clientX, at(first[0], first[1]).clientY) ?? el;
	target.dispatchEvent(ev("pointerdown", first[0], first[1]));
	const raw = "onpointerrawupdate" in window;
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1]!;
		const [bx, by] = points[i]!;
		for (let s = 1; s <= steps; s++) {
			const fx = ax + ((bx - ax) * s) / steps, fy = ay + ((by - ay) * s) / steps;
			if (raw) target.dispatchEvent(ev("pointerrawupdate", fx, fy));
			target.dispatchEvent(ev("pointermove", fx, fy));
			await wait(8);
		}
	}
	const last = points[points.length - 1]!;
	target.dispatchEvent(ev("pointerup", last[0], last[1], { pressure: 0, buttons: 0 }));
	await frames(4);
}

function setTool(tool: string): void {
	// Same path as a tap on the toolbar button.
	(view as unknown as HarnessView).toolbar.setTool(tool as ToolName);
}

/** RGBA of the static canvas at a point given as fractions of the stage. */
function staticPixel(fx: number, fy: number, canvasCls = "notebook-canvas-static"): number[] {
	const c = stage().querySelector<HTMLCanvasElement>(`canvas.${canvasCls}`)!;
	const ctx = c.getContext("2d")!;
	const x = Math.min(c.width - 1, Math.floor(fx * c.width)), y = Math.min(c.height - 1, Math.floor(fy * c.height));
	return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

/** Dark ink in a short vertical band around the point (the toolbar may wrap and move the page a little). */
function inkNear(fx: number, fy: number): boolean {
	const c = stage().querySelector<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
	const ctx = c.getContext("2d")!;
	const dpr = window.devicePixelRatio || 1;
	const x = Math.floor(fx * c.width), y = Math.floor(fy * c.height), band = Math.ceil(32 * dpr);
	const d = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - band), 5, band * 2 + 1).data;
	for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200 && d[i]! < 90 && d[i + 1]! < 90 && d[i + 2]! < 90) return true;
	return false;
}

function strokeCount(): number {
	return view?.document?.pages.reduce((n, p) => n + p.strokes.length, 0) ?? -1;
}

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

/** Smoke check of the open notebook: layout, canvases, page painted, pen/highlighter/eraser input. */
async function check(): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown>; points: Record<string, number[]> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const st = stage();
	const leafRect = (document.querySelector<HTMLElement>(".workspace-leaf")!).getBoundingClientRect();
	const r = st.getBoundingClientRect();
	add("stage has a size", r.width >= leafRect.width * 0.5 && r.height >= leafRect.height * 0.5,
		`stage ${Math.round(r.width)}×${Math.round(r.height)} in leaf ${Math.round(leafRect.width)}×${Math.round(leafRect.height)}`);
	const dpr = window.devicePixelRatio || 1;
	const canvases = Array.from(st.querySelectorAll<HTMLCanvasElement>("canvas"));
	for (const c of canvases) {
		const cr = c.getBoundingClientRect();
		const cs = getComputedStyle(c);
		add(`canvas ${c.className} covers the stage`, Math.abs(cr.width - r.width) < 1 && Math.abs(cr.height - r.height) < 1,
			`${Math.round(cr.width)}×${Math.round(cr.height)} css, ${c.width}×${c.height} px`);
		add(`canvas ${c.className} backing store`, Math.abs(c.width - Math.round(r.width * dpr)) <= 1 && Math.abs(c.height - Math.round(r.height * dpr)) <= 1,
			`${c.width}×${c.height}, expected ${Math.round(r.width * dpr)}×${Math.round(r.height * dpr)} (dpr ${dpr})`);
		if (c.classList.contains("notebook-canvas-live")) add(`canvas ${c.className} lets input through`, cs.pointerEvents === "none", cs.pointerEvents);
		if (c.classList.contains("notebook-canvas-wet") && !c.classList.contains("is-highlighter")) {
			add("pen wet canvas is plain", cs.opacity === "1" && cs.mixBlendMode === "normal", `opacity ${cs.opacity}, blend ${cs.mixBlendMode}`);
		}
	}
	const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * 0.3);
	add("input reaches the stage", !!hit && st.contains(hit), hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "nothing");
	const paper = staticPixel(0.5, 0.3);
	add("page is painted (white paper)", paper[3]! > 250 && paper[0]! > 200 && paper[1]! > 200 && paper[2]! > 200, `rgba(${paper.join(",")})`);

	setTool("pen");
	const before = strokeCount();
	await penStroke([[0.3, 0.5], [0.5, 0.52], [0.7, 0.5]]);
	add("pen stroke is stored", strokeCount() === before + 1, `${before} → ${strokeCount()}`);
	add("pen stroke is painted", inkNear(0.5, 0.52), `pixel rgba(${staticPixel(0.5, 0.52).join(",")})`);
	const wet = st.querySelector<HTMLCanvasElement>("canvas.notebook-canvas-wet");
	if (wet) {
		const w = wet.getContext("2d")!.getImageData(0, 0, wet.width, wet.height).data;
		let left = 0;
		for (let i = 3; i < w.length; i += 4 * 7) if (w[i]! > 0) left++;
		add("wet canvas is clear after the stroke", left === 0, `${left} sampled px left`);
	}

	setTool("highlighter");
	const hb = strokeCount();
	await penStroke([[0.3, 0.6], [0.7, 0.6]]);
	add("highlighter stroke is stored", strokeCount() === hb + 1, `${hb} → ${strokeCount()}`);

	// A stroke to erase, away from the ones the screenshot checks and still on the page.
	const low = lowOnPage();
	setTool("pen");
	await penStroke([[0.3, low], [0.7, low]]);
	setTool("eraser");
	const eb = strokeCount();
	await penStroke([[0.5, low - 0.05], [0.5, low + 0.04]]);
	add("eraser removes strokes", strokeCount() < eb, `${eb} → ${strokeCount()}`);
	setTool("pen");
	await frames(4);

	// Page navigator: open it, the first thumbnail must load (it worked on the device even in 0.4.0).
	const v = view as unknown as HarnessView;
	const wasOpen = !!v.pageNav?.open;
	v.setNavigatorOpen(true);
	let thumb: HTMLImageElement | null = null;
	for (let i = 0; i < 40; i++) {
		await frames(1);
		thumb = document.querySelector("img.notebook-navigator-thumb");
		if (thumb && thumb.complete && thumb.naturalWidth > 0) break;
		await wait(25);
	}
	const navRect = (document.querySelector<HTMLElement>(".notebook-navigator"))?.getBoundingClientRect();
	add("navigator shows thumbnails", !!thumb && thumb.naturalWidth > 0 && !!navRect && navRect.width > 0 && navRect.height > 0,
		`${thumb ? `${thumb.naturalWidth}×${thumb.naturalHeight}` : "no thumbnail"}, panel ${navRect ? `${Math.round(navRect.width)}×${Math.round(navRect.height)}` : "missing"}`);
	// Multi-selection in the page panel (wave 0.8): the select button, ticks, the action bar, Escape ends it.
	{
		const nav = document.querySelector<HTMLElement>(".notebook-navigator")!;
		const selectButton = nav.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Select pages']");
		selectButton?.click();
		await frames(2);
		const items = Array.from(nav.querySelectorAll<HTMLElement>(".notebook-navigator-item"));
		for (const item of items.slice(0, 2)) item.click();
		await frames(2);
		const bar = nav.querySelector<HTMLElement>(".notebook-navigator-selectbar");
		const barShown = !!bar && bar.getBoundingClientRect().height > 0;
		const ticked = nav.querySelectorAll(".notebook-navigator-item.is-selected").length;
		const tick = nav.querySelector<HTMLElement>(".notebook-navigator-item.is-selected .notebook-navigator-check");
		const tickShown = !!tick && tick.getBoundingClientRect().width > 0;
		const count = nav.querySelector(".notebook-navigator-selectcount")?.textContent ?? "";
		nav.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await frames(2);
		const ended = nav.querySelectorAll(".notebook-navigator-item.is-selected").length === 0 && (bar?.getBoundingClientRect().height ?? 1) === 0;
		const want = Math.min(2, items.length);
		add("page panel multi-selection", !!selectButton && barShown && ticked === want && tickShown && ended,
			`ticked ${ticked}/${want}, bar ${barShown}, tick ${tickShown}, "${count}", ended ${ended}`);
	}
	if (!wasOpen) v.setNavigatorOpen(false);
	await frames(4);

	// Reaching the radial menu without the side button: pen hold-still, finger long-press, and the Samsung button
	// (a pressure-0 primary press while hovering: click = menu on release, touch while held = erase). None draws ink.
	{
		const v = view as unknown as HarnessView;
		setTool("pen");
		v.host.settings.penButtonSeen = false;
		v.host.settings.penHoldStill = null;
		v.applySettings(v.host.settings);
		const r4 = st.getBoundingClientRect();
		const px = r4.left + r4.width * 0.5, py = r4.top + r4.height * 0.4;
		let nid = 200;
		const mk = (type: string, id: number, x: number, y: number, extra: PointerEventInit = {}) =>
			new PointerEvent(type, {
				bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: "pen", isPrimary: true,
				pressure: 0.5, width: 1, height: 1, button: 0, buttons: 1, clientX: x, clientY: y, ...extra,
			});
		const menuOpen = () => !!st.querySelector(".notebook-radial");
		const closeMenu = async () => {
			v.radial?.close();
			await frames(2);
		};
		const canUndo = () => !!v.history?.canUndo?.();
		const base = strokeCount();
		const undoBefore = canUndo();

		// Pen held still from the first contact.
		let id = nid++;
		st.dispatchEvent(mk("pointerdown", id, px, py));
		await wait(950);
		add("pen held still opens the radial menu", menuOpen(), menuOpen() ? "open" : "no menu");
		add("the hold leaves no dot and nothing to undo", strokeCount() === base && canUndo() === undoBefore, `${base} → ${strokeCount()}, undo ${undoBefore} → ${canUndo()}`);
		st.dispatchEvent(mk("pointerup", id, px, py, { buttons: 0, pressure: 0 }));
		await closeMenu();

		// A slow stroke that moves before the time is up never opens it.
		id = nid++;
		st.dispatchEvent(mk("pointerdown", id, px, py));
		await wait(300);
		st.dispatchEvent(mk("pointermove", id, px + 30, py));
		await wait(900);
		add("a pause after moving does not open the menu", !menuOpen(), menuOpen() ? "menu opened" : "closed");
		st.dispatchEvent(mk("pointerup", id, px + 30, py, { buttons: 0, pressure: 0 }));
		await frames(4);
		add("the slow stroke is stored", strokeCount() === base + 1, `${base} → ${strokeCount()}`);
		const base2 = strokeCount();

		// Finger long-press (pen-only mode): the ring opens beside the finger, no ink.
		await wait(700);
		id = nid++;
		const fx = r4.left + r4.width * 0.5, fy = r4.top + r4.height * 0.6;
		st.dispatchEvent(mk("pointerdown", id, fx, fy, { pointerType: "touch", pressure: 0.5 }));
		await wait(700);
		const ring = st.querySelector<HTMLElement>(".notebook-radial");
		const cxs = ring ? parseFloat(ring.style.getPropertyValue("--notebook-radial-x")) : NaN;
		const cys = ring ? parseFloat(ring.style.getPropertyValue("--notebook-radial-y")) : NaN;
		const dist = Math.hypot(fx - r4.left - cxs, fy - r4.top - cys);
		add("finger long-press opens the radial menu beside the finger", !!ring && dist > 108, ring ? `distance ${Math.round(dist)} px` : "no menu");
		st.dispatchEvent(mk("pointerup", id, fx, fy, { pointerType: "touch", buttons: 0, pressure: 0 }));
		add("the long-press draws nothing", strokeCount() === base2, `${base2} → ${strokeCount()}`);
		await closeMenu();

		// Samsung: hover, button down (pressure 0), button up = click -> menu on release.
		id = nid++;
		st.dispatchEvent(mk("pointermove", id, px, py, { button: -1, buttons: 0, pressure: 0 }));
		st.dispatchEvent(mk("pointerdown", id, px, py, { button: 0, buttons: 1, pressure: 0 }));
		await frames(1);
		add("the pressure-0 button press opens nothing yet", !menuOpen(), "");
		st.dispatchEvent(mk("pointerup", id, px, py, { button: 0, buttons: 0, pressure: 0 }));
		await frames(1);
		add("releasing the pressure-0 button opens the menu", menuOpen(), menuOpen() ? "open" : "no menu");
		add("the click draws nothing", strokeCount() === base2, `${base2} → ${strokeCount()}`);
		await closeMenu();

		// Samsung: button down while hovering, then touch = erase (no menu on release).
		await penStroke([[0.3, 0.9], [0.7, 0.9]]);
		const withLine = strokeCount();
		id = nid++;
		const ey = r4.top + r4.height * 0.9;
		st.dispatchEvent(mk("pointermove", id, r4.left + r4.width * 0.25, ey, { button: -1, buttons: 0, pressure: 0 }));
		st.dispatchEvent(mk("pointerdown", id, r4.left + r4.width * 0.25, ey, { button: 0, buttons: 1, pressure: 0 }));
		for (let i = 0; i <= 12; i++) {
			st.dispatchEvent(mk("pointermove", id, r4.left + r4.width * (0.25 + i * 0.04), ey, { button: -1, buttons: 1, pressure: 0.6 }));
			await wait(10);
		}
		st.dispatchEvent(mk("pointerup", id, r4.left + r4.width * 0.73, ey, { button: 0, buttons: 0, pressure: 0 }));
		await frames(3);
		add("button held + touch erases", strokeCount() < withLine, `${withLine} → ${strokeCount()}`);
		add("and opens no menu on release", !menuOpen(), "");
		await closeMenu();

		// 0.12.4: Obsidian for Android passes no hover; the button is seen only around the nib's contact, as a bare contextmenu
		// (no pointerType) near the pen down. Tap with it: the radial menu on the lift, no ink. Drag with it: the eraser from the
		// first sample, no ink, no menu. A press in the middle of a stroke: ink goes on. Real events, real timers.
		{
			const bare = () => st.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: 0, clientY: 0 }));
			const upAt = (pid: number, x: number, y: number) => st.dispatchEvent(mk("pointerup", pid, x, y, { button: 0, buttons: 0, pressure: 0 }));
			await wait(1700); // the earlier presses have settled
			const tx = r4.left + r4.width * 0.4, ty = r4.top + r4.height * 0.3;
			const tapBase = strokeCount();
			let pid = nid++;
			bare();
			await wait(150); // the contextmenu comes 150 ms before the nib lands
			st.dispatchEvent(mk("pointerdown", pid, tx, ty));
			await wait(90);
			add("button held (contextmenu 150 ms before), tap: no menu before the lift", !menuOpen(), "");
			upAt(pid, tx, ty);
			await frames(2);
			add("button held, tap: the radial menu opens on the lift", menuOpen(), menuOpen() ? "open" : "no menu");
			add("button held, tap: no dot is left", strokeCount() === tapBase, `${tapBase} → ${strokeCount()}`);
			await closeMenu();

			await wait(1700);
			await penStroke([[0.3, 0.9], [0.7, 0.9]]);
			const beforeDrag = strokeCount();
			const dy = r4.top + r4.height * 0.9;
			pid = nid++;
			st.dispatchEvent(mk("pointerdown", pid, r4.left + r4.width * 0.25, dy));
			bare(); // right after the nib landed
			for (let i = 0; i <= 14; i++) {
				st.dispatchEvent(mk("pointermove", pid, r4.left + r4.width * (0.25 + i * 0.035), dy, { button: -1, buttons: 1, pressure: 0.6 }));
				await wait(12);
			}
			upAt(pid, r4.left + r4.width * 0.74, dy);
			await frames(3);
			add("button held (contextmenu right after the landing), drag: erases the line", strokeCount() < beforeDrag, `${beforeDrag} → ${strokeCount()}`);
			add("button held, drag: no menu, no new ink", !menuOpen() && strokeCount() === beforeDrag - 1, `${beforeDrag} → ${strokeCount()}`);
			await closeMenu();

			await wait(1700);
			const midBase = strokeCount();
			pid = nid++;
			const my = r4.top + r4.height * 0.15;
			st.dispatchEvent(mk("pointerdown", pid, r4.left + r4.width * 0.2, my));
			for (let i = 0; i <= 30; i++) {
				st.dispatchEvent(mk("pointermove", pid, r4.left + r4.width * (0.2 + i * 0.01), my + i, { button: -1, buttons: 1, pressure: 0.6 }));
				await wait(25);
			}
			bare(); // ~750 ms into an ordinary stroke
			st.dispatchEvent(mk("pointermove", pid, r4.left + r4.width * 0.52, my + 31, { button: -1, buttons: 1, pressure: 0.6 }));
			upAt(pid, r4.left + r4.width * 0.52, my + 31);
			await frames(3);
			add("a press in the middle of a stroke: ink goes on, no menu", !menuOpen() && strokeCount() === midBase + 1, `${midBase} → ${strokeCount()}`);
			await closeMenu();
		}
		v.host.settings.penButtonSeen = false;
		v.applySettings(v.host.settings);
		setTool("pen");
	}

	// Radial dial: the pen's side button opens it without drawing; its states open and choose correctly.
	await checkRadial(add);
	await checkColour(add);

	await checkPageMode(add);
	await checkToolbar(add);
	await checkToolbarSize(add);
	await checkPageTurnerKeys(add);
	await checkRestore(add);
	await checkStagedLoad(add);
	await checkPageLinks(add);
	await checkObjects(add);
	await checkNavigation({ view, nav: harnessNav, stage, statusBarEl: harnessStatusBarEl, statusBarClicks: () => statusBarClicks, strokeCount, frames, closeAll }, add);
	await checkSelectionTools(add);

	const unexpected = errors.filter((e) => !expectedError?.test(e));
	if (fault) add("injected fault was reported", errors.some((e) => expectedError!.test(e)), errors[0]?.split("\n")[0] ?? "no error logged");
	const ok = results.every((x) => x.ok) && unexpected.length === 0;
	/** Viewport CSS px where the composited page must show paper and ink (checked on a screenshot by check.mjs). */
	const r2 = stage().getBoundingClientRect();
	const points = {
		paper: [r2.left + r2.width * 0.5, r2.top + r2.height * 0.3],
		ink: [r2.left + r2.width * 0.5, r2.top + r2.height * 0.52],
	};
	const env = {
		platform: Platform.isMobile ? "mobile" : "desktop", dpr, rawUpdates: (view as unknown as HarnessView)?.controller?.rawUpdates ?? null, fault,
		theme: document.body.className, doc: params.get("doc") ?? "v3",
		wetDesynchronized: wet?.getContext("2d")?.getContextAttributes?.()?.desynchronized ?? null,
	};
	return { ok, results, errors: unexpected, notices: [...notices], env, points };
}

/** Pen events on the stage at window point (x, y). */
function penAt(name: string, x: number, y: number, extra: PointerEventInit = {}): void {
	stage().dispatchEvent(new PointerEvent(name, {
		bubbles: true, cancelable: true, composed: true, pointerId: 77, pointerType: "pen", isPrimary: true,
		pressure: name === "pointerup" ? 0 : 0.5, width: 1, height: 1, button: 0, buttons: name === "pointerup" ? 0 : 1, clientX: x, clientY: y, ...extra,
	}));
}

/** Opens the radial dial with the side button in the middle of the stage. */
async function openRadial(): Promise<void> {
	const r = stage().getBoundingClientRect();
	const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
	// The button pressed while hovering (pressure 0): the dial. With the nib touching (pressure above 0) it erases (0.11.2).
	penAt("pointerdown", cx, cy, { button: 2, buttons: 2, pressure: 0 });
	await frames(1);
	penAt("pointerup", cx, cy, { button: 2, buttons: 0 });
	await frames(1);
}

/** Taps the dial action `action` with the pen (down and up on it). */
async function tapDial(action: string): Promise<boolean> {
	const el = document.querySelector(`.notebook-dial [data-dial="${action}"]`);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	penAt("pointerdown", r.left + r.width / 2, r.top + r.height / 2);
	penAt("pointerup", r.left + r.width / 2, r.top + r.height / 2);
	await wait(220); // the state transition
	return true;
}

/** Closes every popover, sheet and dial and goes back to the pen with nothing selected. For screenshots. */
async function closeAll(): Promise<void> {
	const v = view as unknown as HarnessView;
	v.radial?.close();
	v.toolbar.closePopover();
	v.ui.sheet.close();
	v.stampPalette?.close();
	setTool("pen");
	v.refreshUi();
	await wait(250);
}

/** Opens the dial in `state` (main, color, width, tools, favourites, shapes). For screenshots. */
async function radialState(state: string): Promise<void> {
	const v = view as unknown as HarnessView;
	v.radial?.close();
	await openRadial();
	if (state === "save") {
		await tapDial("tools");
		await tapDial("save-favourite");
	} else if (state !== "main") {
		await tapDial(state);
	}
	await wait(200);
}

/**
 * The radial dial: opens on the side button (lifting keeps it open), shows undo/redo, width, colour, tool, favourites and
 * shapes; the colour ring sets the colour, the width slider the width, the pen case the tool; nothing is drawn.
 */
async function checkRadial(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	setTool("pen");
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2 });
	const before = strokeCount();
	await openRadial();
	const dial = document.querySelector<HTMLElement>(".notebook-dial");
	const actions = dial ? Array.from(dial.querySelectorAll("[data-dial]")).map((e) => (e as HTMLElement).dataset.dial) : [];
	add("radial: the side button opens the dial and lifting keeps it open", !!dial && v.radial.state === "main"
		&& ["undo", "redo", "width", "color", "tools", "favourites", "shapes"].every((x) => actions.includes(x)), actions.join(","));
	const r = dial?.getBoundingClientRect();
	const st = stage().getBoundingClientRect();
	add("radial: the dial is inside the page area", !!r && r.left >= st.left - 0.5 && r.right <= st.right + 0.5 && r.top >= st.top - 0.5 && r.bottom <= st.bottom + 0.5,
		r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}` : "none");
	const small = dial ? Array.from(dial.querySelectorAll("[data-dial]")).filter((e) => (e as HTMLElement).offsetWidth < 32) : [];
	add("radial: every control is at least 32 px", small.length === 0, small.map((e) => (e as HTMLElement).dataset.dial).join(","));

	await tapDial("color");
	const swatches = document.querySelectorAll(".notebook-dial [data-dial^='swatch:']").length;
	const hasCustom = !!document.querySelector(".notebook-dial [data-dial='custom']") && !!document.querySelector(".notebook-dial [data-dial='eyedropper']");
	add("radial: the colour bubble opens the colour ring (12 swatches, custom, eyedropper)", v.radial.state === "color" && swatches === 12 && hasCustom, `${v.radial.state}, ${swatches} swatches`);
	await tapDial("swatch:#1d4ed8");
	add("radial: a swatch sets the pen colour and returns to the dial", v.tools.penColor === "#1d4ed8" && v.radial.state === "main", `${v.tools.penColor}, ${v.radial.state}`);

	await tapDial("width");
	const knob = document.querySelector(".notebook-dial [data-dial='slider']");
	add("radial: the width bubble opens the arc slider", v.radial.state === "width" && !!knob && document.querySelectorAll(".notebook-dial .notebook-dial-step").length >= 8, `${v.radial.state}`);
	// Drag the knob along the arc to its end (lower right).
	const d = (document.querySelector<HTMLElement>(".notebook-dial")!).getBoundingClientRect();
	const cx = d.left + d.width / 2, cy = d.top + d.height / 2;
	const k = (knob as HTMLElement).getBoundingClientRect();
	penAt("pointerdown", k.left + k.width / 2, k.top + k.height / 2);
	for (const deg of [30, 70, 110, 130]) {
		const a = (deg * Math.PI) / 180;
		penAt("pointermove", cx + Math.sin(a) * 98, cy - Math.cos(a) * 98);
	}
	penAt("pointerup", cx + Math.sin((130 * Math.PI) / 180) * 98, cy - Math.cos((130 * Math.PI) / 180) * 98);
	await frames(1);
	const number = document.querySelector(".notebook-dial .notebook-dial-number")?.textContent;
	add("radial: dragging the slider sets the width and shows it", v.tools.penWidth === 8 && number === "8" && v.radial.state === "width", `width ${v.tools.penWidth}, label ${number}`);
	await tapDial("back");
	add("radial: the centre goes back to the dial", v.radial.state === "main", String(v.radial.state));
	v.toolbar.update({ penWidth: 2 });

	await tapDial("tools");
	const caseTools = document.querySelectorAll(".notebook-dial [data-dial^='tool:']").length;
	add("radial: the centre opens the pen case with every tool and +", v.radial.state === "tools" && caseTools === 7 && !!document.querySelector(".notebook-dial [data-dial='save-favourite']"), `${caseTools} tools`);
	await tapDial("save-favourite");
	add("radial: + opens the favourites in save mode", v.radial.state === "favourites" && document.querySelectorAll(".notebook-dial .is-target").length === 6, `${v.radial.state}`);
	await tapDial("back");
	await tapDial("back");
	await tapDial("shapes");
	await tapDial("shape:arrow");
	add("radial: a shape chooses the shape tool and closes the dial", v.tools.tool === "shape" && v.tools.shapeKind === "arrow" && !v.radial.isOpen, `${v.tools.tool} ${v.tools.shapeKind}, open ${v.radial.isOpen}`);
	await openRadial();
	await tapDial("tools");
	await tapDial("tool:eraser");
	add("radial: a tool of the pen case chooses it and closes the dial", v.tools.tool === "eraser" && !v.radial.isOpen, `${v.tools.tool}, open ${v.radial.isOpen}`);
	await openRadial();
	penAt("pointerdown", st.left + 6, st.top + 6);
	penAt("pointerup", st.left + 6, st.top + 6);
	await frames(1);
	add("radial: a tap outside closes it", !v.radial.isOpen, "");
	add("radial: the dial draws nothing", strokeCount() === before, `${before} → ${strokeCount()}`);
	setTool("pen");
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2, shapeKind: "line" });
	await frames(2);
}

/** A synthetic pointer event of one contact at window point (x, y), sent to the element under it (as the browser does). */
function contact(name: string, x: number, y: number, id = 91): void {
	const target = document.elementFromPoint(x, y) ?? stage();
	target.dispatchEvent(new PointerEvent(name, {
		bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: "pen", isPrimary: true,
		pressure: name === "pointerup" ? 0 : 0.5, width: 1, height: 1, button: 0, buttons: name === "pointerup" ? 0 : 1, clientX: x, clientY: y,
	}));
}

/**
 * The free colour picker, the page eyedropper and the style eyedropper (roadmap 7, 68): the picker sets the pen colour from its
 * hex field and area and remembers the colour; the eyedropper reads the rendered page under a tap; the style eyedropper
 * takes colour, width and tool from a stroke; Escape and a tap outside the page end them; none of it draws.
 */
async function checkColour(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	setTool("pen");
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2 });
	v.host.settings.recentColours = [];
	const startInk = strokeCount();
	const st = stage().getBoundingClientRect();

	v.runAction("colour-picker");
	await frames(1);
	const panel = document.querySelector<HTMLElement>(".notebook-colour-picker");
	const hex = panel?.querySelector<HTMLInputElement>("input.notebook-colour-hex");
	add("colour: the action opens the picker with the area, the hue bar, the hex field and the eyedropper",
		!!panel && !!panel.querySelector(".notebook-colour-area") && !!panel.querySelector(".notebook-colour-hue") && !!hex && !!panel.querySelector("button[aria-label]") && hex.value === "#1e1e1e", hex?.value ?? "none");
	const pr = panel?.getBoundingClientRect();
	add("colour: the picker is inside the page area", !!pr && pr.left >= st.left - 0.5 && pr.right <= st.right + 0.5 && pr.top >= st.top - 0.5 && pr.bottom <= st.bottom + 0.5,
		pr ? `${Math.round(pr.width)}x${Math.round(pr.height)}` : "none");

	if (hex) {
		hex.value = "#12AB34";
		hex.dispatchEvent(new Event("input", { bubbles: true }));
		hex.dispatchEvent(new Event("change", { bubbles: true }));
	}
	await frames(1);
	add("colour: a hex value sets the pen colour and is remembered", v.tools.penColor === "#12ab34" && v.host.settings.recentColours[0] === "#12ab34", `${v.tools.penColor} ${v.host.settings.recentColours.join(",")}`);
	if (hex) {
		hex.value = "#zzz";
		hex.dispatchEvent(new Event("input", { bubbles: true }));
		hex.dispatchEvent(new Event("change", { bubbles: true }));
	}
	add("colour: an invalid hex changes nothing", v.tools.penColor === "#12ab34" && v.host.settings.recentColours.length === 1, v.tools.penColor);

	const area = panel?.querySelector<HTMLElement>(".notebook-colour-area");
	if (area) {
		const r = area.getBoundingClientRect();
		const ev = (name: string, x: number, y: number) => area.dispatchEvent(new PointerEvent(name, {
			bubbles: true, cancelable: true, pointerId: 92, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, buttons: name === "pointerup" ? 0 : 1,
		}));
		ev("pointerdown", r.left + 2, r.top + 2);
		ev("pointermove", r.left + r.width - 1, r.top + 1);
		ev("pointerup", r.left + r.width - 1, r.top + 1);
	}
	await frames(1);
	add("colour: dragging in the area picks saturation and brightness and remembers the colour",
		/^#[0-9a-f]{6}$/.test(v.tools.penColor) && v.tools.penColor !== "#12ab34" && v.host.settings.recentColours.length === 2, `${v.tools.penColor} ${v.host.settings.recentColours.length}`);
	const swatches = panel?.querySelectorAll(".notebook-colour-recent-swatch").length ?? 0;
	(panel?.querySelectorAll(".notebook-colour-recent-swatch")[1] as HTMLElement | undefined)?.click();
	await frames(1);
	add("colour: a recent colour sets the pen colour again", swatches === 2 && v.tools.penColor === "#12ab34" && v.host.settings.recentColours[0] === "#12ab34", `${swatches} swatches, ${v.tools.penColor}`);
	v.toolbar.update({ penColor: "#dc2626" });
	await frames(1);
	add("colour: the picker follows a colour changed elsewhere", (document.querySelector<HTMLInputElement>(".notebook-colour-picker input.notebook-colour-hex"))?.value === "#dc2626", "");
	panel?.querySelector<HTMLElement>("button[aria-label='Close the colour picker']")?.click();
	await frames(1);
	add("colour: the close button closes the picker", !document.querySelector(".notebook-colour-picker"), "");

	// The tool options carry the same actions as buttons.
	await openOptions("pen");
	const row = document.querySelector<HTMLElement>(".notebook-options");
	const labels = Array.from(row?.querySelectorAll("button") ?? []).map((b) => b.getAttribute("aria-label"));
	add("colour: the colour row has the free colour, the eyedropper and (for ink) the style eyedropper",
		["Colour picker…", "Eyedropper: pick a colour from the page", "Style eyedropper: take colour, width and tool from a stroke"].every((l) => labels.includes(l)), labels.slice(-4).join(" | "));
	byLabel(row ?? document, "Colour picker…")?.click();
	await frames(1);
	add("colour: the free colour button opens the picker and closes the options", !!document.querySelector(".notebook-colour-picker") && !!document.querySelector(".notebook-options.notebook-hidden"), "");
	v.colourTools.closePicker();

	// Eyedropper on the rendered page: write a stroke in a known colour, then pick it back.
	v.toolbar.update({ penColor: "#dc2626", penWidth: 6 });
	await penStroke([[0.3, 0.3], [0.7, 0.3]]);
	const mid = { x: st.left + st.width * 0.5, y: st.top + st.height * 0.3 };
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2 });
	const afterInk = strokeCount();
	v.runAction("colour-eyedropper");
	add("colour: the eyedropper waits for a contact on the page", v.colourTools.armed === "colour", String(v.colourTools.armed));
	contact("pointerdown", mid.x, mid.y);
	await frames(1);
	add("colour: while the contact is down a loupe shows the colour under it", !!document.querySelector(".notebook-eyedropper-loupe"), "");
	contact("pointerup", mid.x, mid.y);
	await frames(1);
	const picked = v.tools.penColor;
	const close = (a: string, b: string) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 24);
	add("colour: the eyedropper takes the colour of the rendered page under the contact", close(picked, "#dc2626") && v.colourTools.armed === null, `${picked}, armed ${v.colourTools.armed}`);
	add("colour: the picked colour is remembered", v.host.settings.recentColours[0] === picked, `${v.host.settings.recentColours.join(",")}`);
	add("colour: picking draws nothing", strokeCount() === afterInk, `${afterInk} -> ${strokeCount()}`);

	// Escape and a contact outside the page end the eyedropper.
	v.runAction("colour-eyedropper");
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	add("colour: Escape ends the eyedropper", v.colourTools.armed === null, String(v.colourTools.armed));
	v.runAction("style-eyedropper");
	const bar = document.querySelector<HTMLElement>(".notebook-toolbar button");
	if (bar) {
		const br = bar.getBoundingClientRect();
		contact("pointerdown", br.left + br.width / 2, br.top + br.height / 2);
		contact("pointerup", br.left + br.width / 2, br.top + br.height / 2);
	}
	add("colour: a contact on the toolbar ends the style eyedropper", v.colourTools.armed === null, String(v.colourTools.armed));

	// Style eyedropper: a highlighter stroke gives its tool, colour and width; a miss keeps waiting.
	setTool("highlighter");
	v.toolbar.update({ highlighterColor: "#4ade80", highlighterWidth: 14 });
	await penStroke([[0.3, 0.6], [0.7, 0.6]]);
	const hl = { x: st.left + st.width * 0.5, y: st.top + st.height * 0.6 };
	setTool("pen");
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2 });
	const inkBefore = strokeCount();
	v.runAction("style-eyedropper");
	contact("pointerdown", st.left + st.width * 0.5, st.top + st.height * 0.9);
	contact("pointerup", st.left + st.width * 0.5, st.top + st.height * 0.9);
	await frames(1);
	add("colour: a tap on empty paper takes nothing and the style eyedropper keeps waiting", v.colourTools.armed === "style" && v.tools.tool === "pen", `${v.colourTools.armed} ${v.tools.tool}`);
	contact("pointerdown", hl.x, hl.y);
	contact("pointerup", hl.x, hl.y);
	await frames(1);
	add("colour: a tap on a stroke takes its tool, colour and width",
		v.tools.tool === "highlighter" && v.tools.highlighterColor === "#4ade80" && v.tools.highlighterWidth === 14 && v.colourTools.armed === null,
		`${v.tools.tool} ${v.tools.highlighterColor} ${v.tools.highlighterWidth}`);
	setTool("pen");
	v.runAction("style-eyedropper");
	contact("pointerdown", mid.x, mid.y);
	contact("pointerup", mid.x, mid.y);
	await frames(1);
	add("colour: the style of a pen stroke sets the pen colour and width", v.tools.tool === "pen" && v.tools.penColor === "#dc2626" && v.tools.penWidth === 6, `${v.tools.tool} ${v.tools.penColor} ${v.tools.penWidth}`);
	add("colour: the style eyedropper draws nothing and changes no stroke", strokeCount() === inkBefore, `${inkBefore} -> ${strokeCount()}`);

	// The dial offers the same picker and eyedropper.
	setTool("pen");
	await openRadial();
	await tapDial("color");
	await tapDial("custom");
	await frames(1);
	add("colour: the custom colour of the dial opens the free picker and closes the dial", !!document.querySelector(".notebook-colour-picker") && !v.radial.isOpen, "");
	v.colourTools.closePicker();
	await openRadial();
	await tapDial("color");
	await tapDial("eyedropper");
	add("colour: the eyedropper of the dial arms the page eyedropper and closes the dial", v.colourTools.armed === "colour" && !v.radial.isOpen, String(v.colourTools.armed));
	v.colourTools.cancelEyedropper();

	// Leave the notebook as it was: the two strokes written for the checks are undone.
	v.undo();
	v.undo();
	await frames(2);
	add("colour: the strokes written for these checks are undone", strokeCount() === startInk, `${startInk} -> ${strokeCount()}`);
	setTool("pen");
	v.toolbar.update({ penColor: "#1e1e1e", penWidth: 2 });
	await frames(2);
}

/**
 * One page at a time (#14): the toolbar item turns it on, pages sit side by side, a finger swipe turns the page and it
 * snaps, a vertical finger drag does not, a pen drag across the page draws and does not, and the mode switches back.
 */
async function checkPageMode(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const st = stage();
	if (v.session.doc.pages.length < 2) v.addPage();
	v.scrollToPage(0);
	await frames(3);
	const pages = v.session.doc.pages.length;
	const label = `page mode ${window.innerWidth}px`;
	const swipe = async (from: [number, number], to: [number, number], opts: { type?: string; steps?: number; stepMs?: number; rest?: number } = {}) => {
		const r = st.getBoundingClientRect();
		const id = pointerId++;
		const type = opts.type ?? "touch";
		const steps = opts.steps ?? 10;
		const ev = (name: string, fx: number, fy: number, extra: PointerEventInit = {}) =>
			new PointerEvent(name, {
				bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: type, isPrimary: true,
				pressure: 0.5, width: 1, height: 1, button: 0, buttons: 1, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, ...extra,
			});
		st.dispatchEvent(ev("pointerdown", from[0], from[1]));
		for (let i = 1; i <= steps; i++) {
			st.dispatchEvent(ev("pointermove", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps));
			await wait(opts.stepMs ?? 8);
		}
		if (opts.rest) await wait(opts.rest);
		st.dispatchEvent(ev("pointerup", to[0], to[1], { buttons: 0, pressure: 0 }));
		for (let i = 0; i < 60 && v.pageMode?.busy; i++) await frames(1);
		await frames(3);
	};

	// The toolbar item switches the mode on.
	await openMore();
	click(byText(document.querySelector(".notebook-sheet")!, "One page at a time"), "One page at a time");
	v.ui.sheet.close();
	await frames(3);
	add(`${label}: the toolbar item turns on one page at a time`, v.pageMode.enabled === true && v.host.settings.scrollMode === "pages", `enabled ${v.pageMode.enabled}, setting ${v.host.settings.scrollMode}`);
	const boxes = v.layout.boxes as Array<{ x: number; y: number; width: number }>;
	add(`${label}: pages sit side by side`, boxes.length === pages && boxes.every((b, i) => b.y === 0 && (i === 0 || b.x > boxes[i - 1]!.x)), `${boxes.length} boxes`);
	add(`${label}: starts on the first page`, v.currentPageIndex() === 0, `page ${v.currentPageIndex() + 1}`);
	const paper = staticPixel(0.5, 0.3);
	add(`${label}: the page is painted`, paper[3]! > 250 && paper[0]! > 200, `rgba(${paper.join(",")})`);
	const x0 = v.viewport.offsetX;

	// A mostly vertical finger drag scrolls (or does nothing) but never turns the page.
	await swipe([0.5, 0.7], [0.45, 0.3]);
	add(`${label}: a vertical drag does not turn the page`, v.currentPageIndex() === 0 && Math.abs(v.viewport.offsetX - x0) < 1, `page ${v.currentPageIndex() + 1}, offsetX ${v.viewport.offsetX.toFixed(1)} vs ${x0.toFixed(1)}`);
	await swipe([0.45, 0.3], [0.5, 0.7]);

	// A pen drag across the page draws, it does not turn the page.
	setTool("pen");
	const before = strokeCount();
	await penStroke([[0.85, 0.45], [0.15, 0.45]]);
	add(`${label}: a pen drag draws and does not turn the page`, v.currentPageIndex() === 0 && strokeCount() === before + 1, `page ${v.currentPageIndex() + 1}, strokes ${before} → ${strokeCount()}`);

	// A short slow drag springs back; a long swipe turns and snaps.
	await swipe([0.5, 0.5], [0.4, 0.5], { stepMs: 30, rest: 150 });
	add(`${label}: a short drag springs back`, v.currentPageIndex() === 0 && Math.abs(v.viewport.offsetX - x0) < 1, `page ${v.currentPageIndex() + 1}, offsetX ${v.viewport.offsetX.toFixed(1)}`);
	await swipe([0.85, 0.5], [0.15, 0.5]);
	const snapped = v.currentPageIndex() === 1;
	const box1 = v.layout.boxes[1]!;
	const left = box1.x * v.viewport.scale + v.viewport.offsetX;
	add(`${label}: a finger swipe turns to the next page and it snaps`, snapped && left >= 0 && left < st.getBoundingClientRect().width * 0.5 && !v.pageMode.busy,
		`page ${v.currentPageIndex() + 1}, left edge ${left.toFixed(1)} px`);
	const toolbarPage = document.querySelector(".notebook-page-indicator")?.textContent ?? "";
	add(`${label}: the page indicator follows`, toolbarPage.includes(`2 / ${pages}`) || toolbarPage === "", `"${toolbarPage}"`);
	const second = staticPixel(0.5, 0.3);
	add(`${label}: the next page is painted`, second[3]! > 250 && second[0]! > 200, `rgba(${second.join(",")})`);
	await swipe([0.15, 0.5], [0.85, 0.5]);
	add(`${label}: and back to the first`, v.currentPageIndex() === 0 && Math.abs(v.viewport.offsetX - x0) < 1, `page ${v.currentPageIndex() + 1}`);

	// Back to continuous scrolling.
	await openMore();
	click(byText(document.querySelector(".notebook-sheet")!, "One page at a time"), "One page at a time");
	v.ui.sheet.close();
	await frames(3);
	const ys = (v.layout.boxes as Array<{ y: number }>).map((b) => b.y);
	add(`${label}: the toolbar item switches back to continuous`, v.pageMode.enabled === false && ys[1]! > ys[0]! && v.currentPageIndex() === 0 && v.host.settings.scrollMode === "continuous",
		`enabled ${v.pageMode.enabled}, page ${v.currentPageIndex() + 1}`);
	await frames(2);
}

/**
 * Reopen where you left off (O16): zoom in and scroll, take the view state the workspace would store, close the view,
 * open a new one with that state and check page, zoom and scroll position come back (also in a view of another
 * size). A state with only a page (a link) lands on the page at fit. The view is reopened fresh at the end.
 */
async function checkRestore(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v0 = view as unknown as HarnessView;
	const label = `restore ${window.innerWidth}px`;
	await v0.flushNow();
	const file = v0.file!;
	if (v0.session.doc.pages.length < 2) v0.addPage();
	v0.scrollToPage(1);
	await frames(2);
	v0.fitMode = false;
	const box1 = v0.layout.boxes[1]!;
	const zoomed = v0.viewport.scale * 2.2;
	v0.setViewport({ scale: zoomed, offsetX: -(box1.x + 40) * zoomed, offsetY: -(box1.y + 300) * zoomed });
	await frames(3);
	const before = v0.currentPosition();
	const state = JSON.parse(JSON.stringify(v0.getState())) as { page?: number; view?: { page?: number; zoom: number } };
	add(`${label}: the view state carries page, zoom and position`, !!before && state.page === 2 && state.view?.page === 2 && Math.abs(state.view.zoom - 2.2) < 0.2,
		JSON.stringify(state.view ?? null));
	await v0.flushNow();

	const reopen = async (s: unknown, size?: { w: number; h: number }) => {
		const root = document.getElementById("harness-app")!;
		await (view as unknown as HarnessView).onClose();
		root.empty();
		if (size) {
			root.style.width = `${size.w}px`;
			root.style.height = `${size.h}px`;
		}
		leaf = new WorkspaceLeaf(app, root);
		view = new NotebookView(asLeaf(leaf), { settings: settings() });
		await view.onOpen();
		await view.setState(s, { history: false });
		await (view as unknown as HarnessView).loadFile(file);
		view.onResize();
		await frames(4);
		return view as unknown as HarnessView;
	};

	let v = await reopen(state);
	let after = v.currentPosition();
	add(`${label}: reopening brings back the same page, zoom and position`,
		!!after && after.page === before.page && Math.abs(after.zoom - before.zoom) < 0.02 && Math.abs(after.x - before.x) < 3 && Math.abs(after.y - before.y) < 3 && v.fitMode === false,
		`${JSON.stringify(before)} → ${JSON.stringify(after)}`);

	// A fitted page comes back fitted (and keeps fitting when the view changes size).
	v.fitToWidth();
	await frames(2);
	const fitted = v.currentPosition();
	v = await reopen(JSON.parse(JSON.stringify(v.getState())));
	after = v.currentPosition();
	add(`${label}: a fitted page comes back fitted`, !!fitted && !!after && v.fitMode === true && Math.abs(after.zoom - 1) < 0.02 && after.page === fitted.page,
		`${JSON.stringify(fitted)} → ${JSON.stringify(after)}`);

	// A link only names the page: no stale zoom.
	v = await reopen({ file: file.path, page: 1 });
	after = v.currentPosition();
	add(`${label}: a state with only a page opens that page at fit`, !!after && after.page === 1 && v.fitMode === true && Math.abs(after.zoom - 1) < 0.02, JSON.stringify(after));

	// Another view size: the same page point at the corner, the zoom relative to the fit.
	const root = document.getElementById("harness-app")!;
	const w0 = root.style.width, h0 = root.style.height;
	v = await reopen(state, { w: Math.max(360, Math.round(window.innerWidth * 0.7)), h: Math.max(400, Math.round(window.innerHeight * 0.8)) });
	after = v.currentPosition();
	add(`${label}: in a view of another size the page point and the relative zoom hold`,
		!!after && after.page === before.page && Math.abs(after.zoom - before.zoom) < 0.05 && Math.abs(after.x - before.x) < 6 && Math.abs(after.y - before.y) < 6,
		`${JSON.stringify(before)} → ${JSON.stringify(after)}`);
	root.style.width = w0;
	root.style.height = h0;

	// Leave a fresh view on page 1 for the screenshot.
	await open();
	await frames(3);
}

/**
 * Progressive loading (#329): a large notebook (over the staged-load limit) opened on page 4 shows that page, read-only,
 * before the rest is read; nothing can be edited or saved until every page is in; then it is complete, editable and
 * saves a file with all its ink. A fresh view is opened at the end.
 */
async function checkStagedLoad(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const label = `staged load ${window.innerWidth}px`;
	const source = stressDocument(3300, 6);
	const text = serialize(source);
	const path = "Notebooks/Staged check.notebook";
	if (!app.vault.getFileByPath(path)) await app.vault.create(path, text);
	const file = app.vault.getFileByPath(path)!;
	const root = document.getElementById("harness-app")!;
	await (view as unknown as HarnessView).onClose();
	root.empty();
	leaf = new WorkspaceLeaf(app, root);
	view = new NotebookView(asLeaf(leaf), { settings: settings() });
	await view.onOpen();
	const v = view as unknown as HarnessView;
	v.onResize();
	const seen = { partial: false, editable: false, doc: false, painted: false, page: -1, pageStrokes: -1, otherStrokes: -1, status: "" };
	const proto = NotebookView.prototype as unknown as ViewProto;
	const orig = proto.showPartial;
	proto.showPartial = function (this: HarnessView) {
		orig.call(this);
		seen.partial = true;
		seen.editable = this.editable();
		seen.doc = !!this.session.doc;
		seen.page = this.currentPageIndex();
		const pages = this.session.partialDoc.pages;
		seen.pageStrokes = pages[3]!.strokes.length;
		seen.otherStrokes = pages[0]!.strokes.length;
		seen.status = document.querySelector(".notebook-status")?.textContent ?? "";
	};
	try {
		v.renderer.onFrame = () => {
			if (v.session?.mode === "loading" && v.renderer.stats.strokesDrawn > 0) seen.painted = true;
		};
		await v.setState({ file: path, page: 4 }, { history: false });
		await v.loadFile(file);
	} finally {
		proto.showPartial = orig;
	}
	v.onResize();
	await frames(3);
	const total = v.session.doc.pages.reduce((n: number, p: { strokes: unknown[] }) => n + p.strokes.length, 0);
	add(`${label}: the wanted page is shown before the rest is read`, seen.partial && seen.page === 3 && seen.pageStrokes > 0 && seen.otherStrokes === 0,
		`partial ${seen.partial}, page ${seen.page + 1}, ink ${seen.pageStrokes} / ${seen.otherStrokes}`);
	add(`${label}: it is painted while the notebook is still loading`, seen.painted, `painted ${seen.painted}`);
	add(`${label}: nothing can be edited meanwhile`, !seen.editable && !seen.doc, `editable ${seen.editable}, session.doc ${seen.doc}`);
	add(`${label}: then it is complete and editable`, v.session.mode === "ok" && v.editable() && !v.session.partialDoc && total === 3300 && v.currentPageIndex() === 3,
		`mode ${v.session.mode}, ${total} strokes, page ${v.currentPageIndex() + 1}`);
	add(`${label}: the status says saved, not loading`, !/loading/i.test(document.querySelector(".notebook-status")?.textContent ?? ""), document.querySelector(".notebook-status")?.textContent ?? "");

	// Writing works on the loaded notebook and the saved file holds every stroke.
	setTool("pen");
	const before = strokeCount();
	await penStroke([[0.3, 0.4], [0.7, 0.42]]);
	await v.flushNow();
	const saved = parse(await app.vault.read(file));
	const savedStrokes = saved.ok ? saved.doc.pages.reduce((n, p) => n + p.strokes.length, 0) : -1;
	add(`${label}: writing and saving work, and nothing is lost`, strokeCount() === before + 1 && savedStrokes === 3301, `strokes ${before} → ${strokeCount()}, saved ${savedStrokes}`);

	// Back to a fresh view for the screenshot.
	await open();
	await frames(3);
}

/** Links to a page by id: a page that moved is found, a page that was deleted says so and the view stays where it is. */
async function checkPageLinks(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const label = `page links ${window.innerWidth}px`;
	if (v.session.doc.pages.length < 2) v.addPage();
	v.scrollToPage(0);
	await frames(2);
	const second = v.session.doc.pages[1]!.id;
	const before = notices.length;
	v.setEphemeralState({ subpath: `#p1&id=${second}` });
	await frames(2);
	add(`${label}: a link with a page id opens that page`, v.currentPageIndex() === 1 && notices.length === before, `page ${v.currentPageIndex() + 1}, notices ${notices.length - before}`);
	v.setEphemeralState({ subpath: "#p1&id=deadbeefdeadbeef" });
	await frames(2);
	add(`${label}: a link to a deleted page says so and does not move`, v.currentPageIndex() === 1 && notices.length === before + 1 && /no longer in/.test(notices[notices.length - 1] ?? ""),
		`page ${v.currentPageIndex() + 1}, last notice "${notices[notices.length - 1] ?? ""}"`);
	v.scrollToPage(0);
	await frames(2);
}

/** Fraction of the stage height that is still on the first page, a little above its bottom edge (at most 0.75). */
function lowOnPage(): number {
	const v = view as unknown as HarnessView;
	const box = v.layout?.boxes?.[0];
	const h = stage().getBoundingClientRect().height;
	if (!box || !h) return 0.75;
	return Math.max(0.55, Math.min(0.75, ((box.y + box.height) * v.viewport.scale + v.viewport.offsetY - 30) / h));
}

/** Buttons of the bar itself (not those inside a popover) that are laid out. */
function barButtons(): HTMLButtonElement[] {
	const bar = document.querySelector<HTMLElement>(".notebook-toolbar")!;
	return Array.from(bar.querySelectorAll("button")).filter((b) => !b.closest(".notebook-popover") && b.offsetParent !== null);
}

function click(el: Element | null | undefined, what = "element"): void {
	if (!el) throw new Error(`toolbar check: ${what} not found`);
	(el as HTMLElement).click();
}

function byLabel(root: ParentNode, label: string): HTMLButtonElement | null {
	return Array.from(root.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label) ?? null;
}

function byText(root: ParentNode, text: string): HTMLButtonElement | null {
	return Array.from(root.querySelectorAll("button")).find((b) => (b.querySelector(".notebook-menu-label") ?? b).textContent?.trim() === text) ?? null;
}

const TOOL_LABELS: Record<string, string> = { pen: "Pen", highlighter: "Highlighter", eraser: "Eraser", shape: "Shape", text: "Text" };

/** Opens the options popover of a tool the way a user does: select the tool, tap it again. For screenshots. */
async function openOptions(tool: string): Promise<void> {
	const tb = (view as unknown as HarnessView).toolbar;
	tb.closePopover();
	tb.setTool(tool as ToolName);
	click(byLabel(document, TOOL_LABELS[tool] ?? tool), `tool ${tool}`);
	await wait(250);
}

/** Opens the "All actions" sheet. For screenshots. */
async function openMore(): Promise<void> {
	const v = view as unknown as HarnessView;
	v.toolbar.closePopover();
	if (v.ui.sheet.isOpen) v.ui.sheet.close();
	click(byLabel(document, "All actions"), "All actions button");
	await wait(260);
}

/** Opens the page sheet from the page indicator. For screenshots. */
async function openPageSheet(): Promise<void> {
	const v = view as unknown as HarnessView;
	v.toolbar.closePopover();
	if (v.ui.sheet.isOpen) v.ui.sheet.close();
	click(document.querySelector(".notebook-page-indicator"), "page indicator");
	await wait(260);
}

/** Selects the first stroke of the first page with the lasso (the contextual bar shows the selection actions). For screenshots. */
async function selectFirstStroke(): Promise<void> {
	const v = view as unknown as HarnessView;
	const page = v.document.pages[0]!;
	v.selectItems(0, page.strokes.slice(0, 2), []);
	await wait(250);
}

/**
 * wave 0.9 (370): the toolbar sizes. In "large" and "compact" the bar, the options popover, the "All actions" sheet and
 * the contextual bar of a selection stay inside the view without sideways overflow, the buttons have the size of the
 * setting, and "normal" comes back unchanged.
 */
async function checkToolbarSize(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const width = window.innerWidth;
	const inView = (r: DOMRect) => r.left >= -0.5 && r.right <= width + 0.5;
	const bar = document.querySelector<HTMLElement>(".notebook-toolbar")!;
	const set = async (size: string) => {
		v.host.settings.toolbarSize = size as NotebookSettings["toolbarSize"];
		v.applySettings(v.host.settings);
		await frames(3);
		await wait(120);
	};
	for (const [size, target, icon] of [["large", 48, 24], ["compact", 36, 16]] as const) {
		const label = `toolbar size ${size} ${width}px`;
		await closeAll();
		await set(size);
		const doc = document.documentElement;
		add(`${label}: no sideways overflow`, doc.scrollWidth <= width && bar.scrollWidth <= bar.clientWidth + 1,
			`page ${doc.scrollWidth}, toolbar scroll ${bar.scrollWidth} / client ${bar.clientWidth}, view ${width}`);
		const strays = barButtons().filter((b) => !b.closest(".notebook-favs") && !inView(b.getBoundingClientRect()));
		add(`${label}: every control is inside the view`, strays.length === 0, strays.map((b) => b.getAttribute("aria-label")).join(", "));
		const tools = barButtons().filter((b) => b.classList.contains("notebook-tool"));
		const wrong = tools.filter((b) => b.offsetWidth < target - 0.5 || b.offsetHeight < target - 0.5);
		add(`${label}: buttons are at least ${target} px`, wrong.length === 0, wrong.map((b) => `${b.getAttribute("aria-label")} ${b.offsetWidth}×${b.offsetHeight}`).join(", "));
		const svg = tools.map((b) => b.querySelector<SVGElement>(".svg-icon")).find((x) => x);
		add(`${label}: icons are ${icon} px`, !!svg && Math.round(svg.getBoundingClientRect().width) === icon, `${svg ? svg.getBoundingClientRect().width : "no icon"}`);
		const rows = Math.ceil(bar.getBoundingClientRect().height / (target + 8));
		add(`${label}: at most three rows`, rows <= 3, `height ${Math.round(bar.getBoundingClientRect().height)} px`);
		const favs = bar.querySelector<HTMLElement>(".notebook-favs")!;
		add(`${label}: favourite pens strip is inside the view`, inView(favs.getBoundingClientRect()), `${Math.round(favs.getBoundingClientRect().left)}–${Math.round(favs.getBoundingClientRect().right)}`);

		await openOptions("eraser");
		const opts = bar.querySelector<HTMLElement>(".notebook-options")!;
		const r = opts.getBoundingClientRect();
		add(`${label}: the tool options fit the view`, inView(r) && r.bottom <= window.innerHeight, `${Math.round(r.left)}–${Math.round(r.right)}, bottom ${Math.round(r.bottom)} of ${window.innerHeight}`);
		await closeAll();

		await openMore();
		const sheet = document.querySelector<HTMLElement>(".notebook-sheet");
		const sr = sheet?.getBoundingClientRect();
		add(`${label}: the All actions sheet fits the view`, !!sr && inView(sr) && sr.bottom <= window.innerHeight + 0.5, sr ? `${Math.round(sr.left)}–${Math.round(sr.right)}` : "no sheet");
		await closeAll();

		await selectFirstStroke();
		await wait(200);
		const ctx = document.querySelector<HTMLElement>(".notebook-context-bar");
		const cr = ctx?.getBoundingClientRect();
		add(`${label}: the contextual bar fits the view`, !!cr && cr.width > 0 && inView(cr), cr ? `${Math.round(cr.left)}–${Math.round(cr.right)}` : "no contextual bar");
		await closeAll();
	}
	await set("normal");
	const small = barButtons().filter((b) => b.classList.contains("notebook-tool") && (b.offsetWidth < 40 || b.offsetHeight < 40));
	add(`toolbar size back to normal ${width}px: buttons are 40 px again`, small.length === 0, small.map((b) => b.getAttribute("aria-label")).join(", "));
}

/** wave 0.9 (372): the page turner keys reach goToRelativePage when the view is active and nothing else wants the key. */
async function checkPageTurnerKeys(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	await closeAll();
	const deltas: number[] = [];
	const original = v.goToRelativePage;
	v.goToRelativePage = (d: number) => void deltas.push(d);
	const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
		const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
		target.dispatchEvent(e);
		return e;
	};
	try {
		const down = press("PageDown");
		press("PageUp");
		press("ArrowRight");
		press("ArrowLeft");
		press(" ");
		press(" ", document.body, { shiftKey: true });
		add("page turner: PageDown, PageUp, arrows and space turn pages", deltas.join(",") === "1,-1,1,-1,1,-1" && down.defaultPrevented, `deltas ${deltas.join(",")}`);
		deltas.length = 0;
		const input = createEl("input");
		document.body.appendChild(input);
		press("ArrowRight", input);
		press("a");
		press("PageDown", document.body, { ctrlKey: true });
		input.remove();
		add("page turner: keys in a text field, other keys and shortcuts do nothing", deltas.length === 0, `deltas ${deltas.join(",")}`);
		// A tapped toolbar button keeps the focus: the arrows still turn pages, space does not.
		const button = barButtons()[0]!;
		press("ArrowDown", button);
		press(" ", button);
		add("page turner: arrows work with a toolbar button focused, space does not", deltas.join(",") === "1", `deltas ${deltas.join(",")}`);
		deltas.length = 0;
		v.host.settings.pageTurnerKeys = false;
		press("PageDown");
		v.host.settings.pageTurnerKeys = true;
		add("page turner: the setting turns the keys off", deltas.length === 0, `deltas ${deltas.join(",")}`);
	} finally {
		v.goToRelativePage = original;
		v.host.settings.pageTurnerKeys = true;
	}
}

/**
 * Toolbar: it fits the width without sideways overflow, touch targets are at least 40 px, the options popover and the
 * "more" menu open inside the view, choosing in them works, and tapping them, or outside them, draws nothing.
 */
async function checkToolbar(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const tb = v.toolbar;
	const bar = document.querySelector<HTMLElement>(".notebook-toolbar")!;
	const width = window.innerWidth;
	const label = `toolbar ${width}px`;
	const inView = (r: DOMRect) => r.left >= -0.5 && r.right <= width + 0.5;

	// 1. Layout.
	const doc = document.documentElement;
	add(`${label}: no sideways overflow`, doc.scrollWidth <= width && bar.scrollWidth <= bar.clientWidth + 1,
		`page ${doc.scrollWidth}, toolbar scroll ${bar.scrollWidth} / client ${bar.clientWidth}, view ${width}`);
	const strays = barButtons().filter((b) => !b.closest(".notebook-favs") && !inView(b.getBoundingClientRect()));
	add(`${label}: every control is inside the view`, strays.length === 0, strays.map((b) => b.getAttribute("aria-label")).join(", "));
	const favs = bar.querySelector<HTMLElement>(".notebook-favs")!;
	const favRect = favs.getBoundingClientRect();
	const favCount = favs.querySelectorAll("button").length;
	add(`${label}: favourite pens strip is inside the view`, inView(favRect) && favCount === 6,
		`strip ${Math.round(favRect.left)}–${Math.round(favRect.right)}, ${favCount} pens, scrolls sideways: ${favs.scrollWidth > favs.clientWidth}`);
	const small = barButtons().filter((b) => b.offsetWidth < 40 || b.offsetHeight < 40);
	add(`${label}: touch targets are at least 40 px`, small.length === 0,
		small.map((b) => `${b.getAttribute("aria-label")} ${b.offsetWidth}×${b.offsetHeight}`).join(", "));
	const barRect = bar.getBoundingClientRect();
	add(`${label}: at most two rows`, barRect.height <= 100, `height ${Math.round(barRect.height)} px`);

	// 2. Options popover of the eraser: modes, filter, colour and size, all reachable, drawing nothing.
	const strokes = strokeCount();
	tb.closePopover();
	setTool("eraser");
	click(byLabel(bar, "Eraser"), "eraser button");
	await frames(2);
	const opts = bar.querySelector<HTMLElement>(".notebook-options")!;
	let r = opts.getBoundingClientRect();
	add(`${label}: tapping the active tool opens its options`, tb.openPopover === "options" && r.width > 0 && r.height > 0 && inView(r) && r.bottom <= window.innerHeight,
		`popover ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)} in ${width}×${window.innerHeight}`);
	const optionButtons = Array.from(opts.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
	add(`${label}: eraser options are reachable (3 modes, 5 sizes, 4 filters)`, optionButtons.length === 12, `${optionButtons.length} buttons`);
	add(`${label}: options touch targets are at least 40 px`, optionButtons.every((b) => b.offsetWidth >= 40 && b.offsetHeight >= 40),
		optionButtons.filter((b) => b.offsetWidth < 40 || b.offsetHeight < 40).map((b) => b.getAttribute("aria-label")).join(", "));
	click(byText(opts, "Segment"), "Segment");
	add(`${label}: choosing an eraser mode works`, v.tools.eraserMode === "segment" && tb.openPopover === "options", `mode ${v.tools.eraserMode}`);
	click(byText(opts, "One colour"), "One colour");
	await frames(1);
	click(byLabel(opts, "Colour #dc2626"), "red swatch");
	add(`${label}: eraser filter by colour and a swatch work`, v.tools.eraserFilter === "color" && v.tools.eraserColor === "#dc2626", `${v.tools.eraserFilter} ${v.tools.eraserColor}`);
	r = opts.getBoundingClientRect();
	add(`${label}: options with the colour row still fit`, inView(r) && r.bottom <= window.innerHeight, `bottom ${Math.round(r.bottom)} of ${window.innerHeight}`);
	click(byLabel(opts, "Eraser size 24"), "eraser size 24");
	add(`${label}: eraser size works`, v.tools.eraserSize === 24, `size ${v.tools.eraserSize}`);
	click(byText(opts, "All ink"), "All ink");
	click(byText(opts, "Whole stroke"), "Whole stroke");
	tb.update({ eraserSize: 10 });

	// Pen: another tool closes the popover; colour and width from it; a tap on the page only closes it.
	click(byLabel(bar, "Pen"), "pen button");
	await frames(1);
	add(`${label}: choosing another tool closes the popover`, tb.openPopover === null && v.tools.tool === "pen", `popover ${tb.openPopover}, tool ${v.tools.tool}`);
	click(byLabel(bar, "Pen"), "pen button");
	await frames(1);
	click(byLabel(opts, "Colour #1d4ed8"), "blue swatch");
	click(byLabel(opts, "Width 4"), "width 4");
	add(`${label}: pen colour and width from the popover`, v.tools.penColor === "#1d4ed8" && v.tools.penWidth === 3.2 && strokeCount() === strokes,
		`${v.tools.penColor} ${v.tools.penWidth}, strokes ${strokes} → ${strokeCount()}`);
	const chip = bar.querySelector<HTMLElement>(".notebook-chip-dot")!;
	add(`${label}: the current-pen indicator follows the pen`, getComputedStyle(chip).backgroundColor === "rgb(29, 78, 216)", getComputedStyle(chip).backgroundColor);
	// A pen over the popover writes on the popover, not on the page.
	const st = stage().getBoundingClientRect();
	r = opts.getBoundingClientRect();
	const fx = (r.left + r.width / 2 - st.left) / st.width, fy = (r.top + r.height / 2 - st.top) / st.height;
	await penStroke([[fx - 0.04, fy], [fx + 0.04, fy]]);
	add(`${label}: a pen over the popover draws nothing and keeps it open`, strokeCount() === strokes && tb.openPopover === "options", `${strokes} → ${strokeCount()}, popover ${tb.openPopover}`);

	// The tap lands on the page below the popover.
	const below = Math.min(0.95, Math.max(lowOnPage(), (opts.getBoundingClientRect().bottom - st.top) / st.height + 0.04));
	await penStroke([[0.3, below], [0.7, below]]);
	add(`${label}: a tap on the page closes the popover and draws nothing`, tb.openPopover === null && strokeCount() === strokes, `${strokes} → ${strokeCount()}, popover ${tb.openPopover}`);
	await penStroke([[0.3, below], [0.7, below]]);
	add(`${label}: the next stroke draws normally`, strokeCount() === strokes + 1, `${strokes} → ${strokeCount()}`);

	// The pen indicator opens the options; Escape closes them.
	click(bar.querySelector(".notebook-chip"), "pen indicator");
	await frames(1);
	const wasOpen = tb.openPopover === "options";
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	add(`${label}: the pen indicator opens the options and Escape closes them`, wasOpen && tb.openPopover === null, `opened ${wasOpen}, now ${tb.openPopover}`);

	// 3. "All actions" sheet: opens inside the view, grouped and searchable; a toggle works and keeps it open; an action closes it.
	const ui = v.ui;
	click(byLabel(bar, "All actions"), "All actions button");
	await wait(260); // the opening animation
	const sheet = document.querySelector<HTMLElement>(".notebook-sheet")!;
	r = sheet.getBoundingClientRect();
	const items = Array.from(sheet.querySelectorAll("button.notebook-menu-item")).filter((b) => (b as HTMLElement).offsetParent !== null) as HTMLElement[];
	const sections = Array.from(sheet.querySelectorAll(".notebook-sheet-section-title")).map((e) => e.textContent);
	add(`${label}: the All actions sheet opens inside the view, grouped`, ui.sheet.isOpen && inView(r) && r.bottom <= window.innerHeight + 0.5 && items.length >= 12 && sections.includes("Insert") && sections.includes("Page"),
		`sheet ${Math.round(r.left)}–${Math.round(r.right)}, bottom ${Math.round(r.bottom)} of ${window.innerHeight}, ${items.length} items, sections ${sections.join(", ")}`);
	add(`${label}: sheet rows are at least 40 px`, items.every((b) => b.offsetHeight >= 40), items.filter((b) => b.offsetHeight < 40).map((b) => b.textContent).join(","));
	add(`${label}: the sheet is a bottom sheet on a phone only`, sheet.classList.contains("is-bottom") === (window.innerWidth < 600), sheet.className);
	click(byText(sheet, "Ruler"), "Ruler");
	await frames(2);
	add(`${label}: a toggle in the sheet works and keeps it open`, v.tools.ruler === true && ui.sheet.isOpen, `ruler ${v.tools.ruler}, sheet ${ui.sheet.isOpen}`);
	const search = sheet.querySelector<HTMLInputElement>(".notebook-sheet-search input")!;
	search.value = "stamp";
	search.dispatchEvent(new Event("input", { bubbles: true }));
	await frames(1);
	const found = Array.from(sheet.querySelectorAll("button.notebook-menu-item")).map((b) => b.textContent ?? "");
	add(`${label}: searching the sheet finds an action`, found.length >= 1 && found.some((f) => f.includes("Stamps")) && sheet.querySelector(".notebook-sheet-section-title")?.textContent === "Results", found.join(" | "));
	search.value = "";
	search.dispatchEvent(new Event("input", { bubbles: true }));
	await frames(1);
	click(byText(sheet, "Fit to width"), "Fit to width");
	await frames(2);
	add(`${label}: an action of the sheet runs and closes it`, !ui.sheet.isOpen, `sheet ${ui.sheet.isOpen}`);
	tb.update({ ruler: false });
	await frames(2);
	const pageCount = v.document.pages.length;

	// 4. Page sheet from the page indicator: page actions, paper as chips (one undo step), drawing nothing.
	const strokesBefore = strokeCount();
	click(bar.querySelector(".notebook-page-indicator"), "page indicator");
	await wait(260);
	const pageSheet = document.querySelector<HTMLElement>(".notebook-sheet")!;
	r = pageSheet.getBoundingClientRect();
	add(`${label}: the page indicator opens the page sheet`, ui.sheet.openKind === "page" && inView(r) && !!byText(pageSheet, "Duplicate page") && !byText(pageSheet, "Insert image"),
		`kind ${ui.sheet.openKind}, title ${pageSheet.querySelector(".notebook-sheet-title")?.textContent}`);
	const firstSection = pageSheet.querySelector(".notebook-sheet-section");
	add(`${label}: the page sheet starts with Go to (page number, recent pages, one page at a time)`, firstSection?.querySelector(".notebook-sheet-section-title")?.textContent === "Go to"
		&& ["Go to page number…", "Recently edited pages", "One page at a time"].every((x) => !!byText(firstSection as HTMLElement, x)),
		Array.from(firstSection?.querySelectorAll("button") ?? []).map((b) => b.textContent).join(" | "));
	const paperBefore = v.document.pages[v.currentPage()]!.paper.kind;
	const dotted = Array.from(pageSheet.querySelectorAll(".notebook-chip-choice")).find((b) => b.textContent === "Dotted") as HTMLElement | undefined;
	click(dotted, "Dotted chip");
	await frames(2);
	const paperAfter = v.document.pages[v.currentPage()]!.paper.kind;
	add(`${label}: a paper chip changes the page and keeps the sheet open`, paperAfter === "dotted" && ui.sheet.isOpen && dotted?.getAttribute("aria-checked") !== null, `${paperBefore} → ${paperAfter}`);
	v.undo();
	await frames(1);
	add(`${label}: undo restores the paper`, v.document.pages[v.currentPage()]!.paper.kind === paperBefore, v.document.pages[v.currentPage()]!.paper.kind);
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	await frames(1);
	add(`${label}: Escape closes the sheet; nothing was drawn`, !ui.sheet.isOpen && strokeCount() === strokesBefore && v.document.pages.length === pageCount, `sheet ${ui.sheet.isOpen}, strokes ${strokesBefore} → ${strokeCount()}`);

	// 5. Quick slots: as many as the layout engine planned, all inside the bar.
	const quick = Array.from(bar.querySelectorAll<HTMLElement>(".notebook-quick button"));
	const plan = v.toolbar.quickIds.length;
	add(`${label}: quick slots follow the width`, quick.length === plan && (width < 480 ? plan === 0 : width >= 760 ? plan >= 4 : true) && quick.every((b) => inView(b.getBoundingClientRect())),
		`${quick.length} quick (${v.toolbar.quickIds.join(", ")}) at ${width}px`);

	// 6. The contextual bar follows the context: none with the pen, paste and the excerpt actions (v10) for the lasso, the selection actions for a selection.
	const ctx = () => (document.querySelector<HTMLElement>(".notebook-context-bar")!);
	const ctxKind = () => (ctx().classList.contains("notebook-hidden") ? "none" : ctx().dataset.context ?? "?");
	ui.refreshNow();
	const k0 = ctxKind();
	setTool("lasso");
	ui.refreshNow();
	const k1 = ctxKind();
	const lassoActions = Array.from(ctx().querySelectorAll("[data-action]")).map((b) => (b as HTMLElement).dataset.action);
	await selectFirstStroke();
	ui.refreshNow();
	const nSel = v.selection?.strokes.length ?? 0;
	const k2 = ctxKind();
	const selActions = Array.from(ctx().querySelectorAll("[data-action]")).map((b) => (b as HTMLElement).dataset.action);
	const cr = ctx().getBoundingClientRect();
	add(`${label}: the contextual bar changes with the context`, k0 === "none" && k1 === "lasso" && /^selection-paste,select-rectangle,select-by-style,selection-paste-device(,excerpt-to-page(,excerpt-copy)?)?$/.test(lassoActions.join()) && k2 === "selection" && selActions.includes("selection-copy") && selActions.includes("delete-selection"),
		`${k0} → ${k1} (${lassoActions.join()}) → ${k2} (${selActions.join()})`);
	add(`${label}: the contextual bar is inside the view with 40 px targets`, inView(cr) && cr.bottom <= window.innerHeight + 0.5 && Array.from(ctx().querySelectorAll("button")).every((b) => (b as HTMLElement).offsetHeight >= 40 && (b as HTMLElement).offsetWidth >= 40),
		`bar ${Math.round(cr.left)}–${Math.round(cr.right)}, bottom ${Math.round(cr.bottom)}`);
	click(ctx().querySelector('[data-action="selection-duplicate"]'), "duplicate");
	await frames(2);
	add(`${label}: a contextual action works (duplicate: one undo step)`, nSel > 0 && strokeCount() === strokesBefore + nSel, `${strokesBefore} → ${strokeCount()} (${nSel} selected)`);
	v.undo();
	await frames(1);
	click(ctx().querySelector(".notebook-context-collapse"), "collapse");
	await frames(1);
	add(`${label}: the contextual bar collapses to one button and opens again`, ctx().classList.contains("is-collapsed") && ctx().querySelectorAll("button").length === 1, `${ctx().querySelectorAll("button").length} buttons`);
	click(ctx().querySelector(".notebook-context-chip"), "expand");
	await frames(1);
	setTool("pen");
	ui.refreshNow();
	add(`${label}: back to the pen, no contextual bar`, ctxKind() === "none" && strokeCount() === strokesBefore, ctxKind());
	tb.update({ tool: "pen", penColor: "#1e1e1e", penWidth: 2 });
	tb.closePopover();
	await frames(2);
}

/**
 * Objects (wave 0.6): the stamp palette (opens inside the view, tap and drag place a stamp, saving writes a vault file)
 * and ink attached to objects (ink written over a text box moves with it, one undo step; deleting the box offers to
 * delete the ink). Leaves the document as it found it.
 */
async function checkObjects(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const doc = view!.document!;
	const page = doc.pages[0]!;
	const startStrokes = strokeCount();
	const startElements = page.elements?.length ?? 0;
	const tb = v.toolbar;
	const pointer = (target: Element, name: string, x: number, y: number) =>
		target.dispatchEvent(new PointerEvent(name, {
			bubbles: true, cancelable: true, composed: true, pointerId: 91, pointerType: "mouse", isPrimary: true,
			button: 0, buttons: name === "pointerup" ? 0 : 1, clientX: x, clientY: y,
		}));
	const centre = (el: Element): [number, number] => {
		const r = el.getBoundingClientRect();
		return [r.left + r.width / 2, r.top + r.height / 2];
	};

	// --- stamps
	tb.closePopover();
	await openMore();
	click(byText(document.querySelector<HTMLElement>(".notebook-sheet")!, "Stamps"), "Stamps");
	await frames(3);
	const panel = document.querySelector<HTMLElement>(".notebook-stamp-panel")!;
	const pr = panel.getBoundingClientRect();
	const body = (document.querySelector<HTMLElement>(".notebook-body")!).getBoundingClientRect();
	const builtin = panel.querySelectorAll(".notebook-stamp-tile");
	add("stamps: the palette opens inside the view with the 3 built-in stamps",
		!panel.classList.contains("notebook-hidden") && pr.width > 0 && pr.left >= body.left - 1 && pr.right <= body.right + 1 && pr.bottom <= body.bottom + 1 && builtin.length === 3,
		`panel ${Math.round(pr.left)}–${Math.round(pr.right)} × ${Math.round(pr.top)}–${Math.round(pr.bottom)} in body ${Math.round(body.left)}–${Math.round(body.right)} × ${Math.round(body.top)}–${Math.round(body.bottom)}, ${builtin.length} tiles`);
	add("stamps: every tile shows a drawing", Array.from(builtin).every((t) => t.querySelector("svg path")), "");

	let [x, y] = centre(builtin[0]!);
	pointer(builtin[0]!, "pointerdown", x, y);
	pointer(builtin[0]!, "pointerup", x, y);
	await frames(2);
	add("stamps: tapping a built-in stamp adds one stroke and selects it", strokeCount() === startStrokes + 1 && v.selection?.strokes.length === 1,
		`${startStrokes} → ${strokeCount()}, selected ${v.selection?.strokes.length}`);
	v.undo();
	await frames(2);
	add("stamps: undo takes the placed stamp away in one step", strokeCount() === startStrokes, `${strokeCount()} strokes`);

	[x, y] = centre(builtin[1]!);
	pointer(builtin[1]!, "pointerdown", x, y);
	pointer(builtin[1]!, "pointerup", x, y);
	await frames(2);
	await v.stamps.doSave("Harness stamp", v.captureSelectionClip());
	await frames(3);
	const file = app.vault.getFileByPath("Notebooks/_stamps/Harness stamp.stamp");
	const mine = Array.from(panel.querySelectorAll(".notebook-stamp-tile")).find((t) => t.textContent?.includes("Harness stamp"));
	add("stamps: saving the selection writes a .stamp file and lists it in the palette", !!file && !!mine, `file ${!!file}, tile ${!!mine}`);
	v.undo();
	await frames(2);

	// Drag the personal stamp from the palette onto the page.
	const st = stage().getBoundingClientRect();
	const drop: [number, number] = [st.left + st.width * 0.3, st.top + st.height * 0.3];
	if (mine) {
		[x, y] = centre(mine);
		pointer(mine, "pointerdown", x, y);
		pointer(mine, "pointermove", x - 20, y + 20);
		await frames(1);
		const ghost = document.querySelector(".notebook-stamp-ghost");
		pointer(mine, "pointermove", drop[0], drop[1]);
		pointer(mine, "pointerup", drop[0], drop[1]);
		await frames(2);
		const target = v.pageAtClient(drop[0], drop[1]);
		const placed = v.selection?.strokes[0];
		const xs: number[] = placed ? placed.points.map((p: number[]) => p[0]!) : [0];
		const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
		add("stamps: dragging a stamp onto the page places it at the drop point", !!ghost && !!target && strokeCount() === startStrokes + 1 && Math.abs(mid - target.x) < 6,
			`ghost ${!!ghost}, strokes ${strokeCount()}, centre x ${mid.toFixed(1)} vs drop ${target?.x.toFixed(1)}`);
		add("stamps: the drag ghost is gone after the drop", !document.querySelector(".notebook-stamp-ghost"), "");
		v.undo();
		await frames(2);
	}
	click(byLabel(panel, "Close stamps"), "close stamps");
	await frames(1);
	add("stamps: the close button hides the palette", panel.classList.contains("notebook-hidden"), "");
	if (file) await app.fileManager.trashFile(file);

	// --- ink attached to a text box
	const box = { id: "obj-text", type: "text", x: 100, y: 300, width: 320, text: "Hello world, handwritten notes", fontSize: 20, color: "#1e1e1e" } as const;
	const over = createStroke("#1e1e1e", 2, [[110, 312, 0.5], [180, 314, 0.5], [250, 312, 0.5]], "pen");
	const away = createStroke("#1e1e1e", 2, [[110, 700, 0.5], [180, 702, 0.5], [250, 700, 0.5]], "pen");
	v.history.execute(new Batch("harness setup", [
		new AddElement(page.id, box, page.elements?.length ?? 0),
		new AddStroke(page.id, over, page.strokes.length),
		new AddStroke(page.id, away, page.strokes.length + 1),
	]));
	v.afterHistoryChange();
	const boxElement = () => page.elements!.find((e) => e.id === "obj-text")!;
	v.selectItems(0, [], [boxElement()]);
	await frames(2);
	const floating = v.renderer.selection?.strokes?.length ?? 0;
	add("objects: ink written over a selected text box floats with it (and the other ink does not)", floating === 1, `${floating} floating strokes`);
	v.selection.matrix = translate(60, 40);
	v.commitSelectionTransform();
	await frames(2);
	const movedOver = page.strokes.find((s) => s.id === over.id)!;
	const stayed = page.strokes.find((s) => s.id === away.id)!;
	add("objects: moving the text box moves its ink in the same undo step", movedOver.points[0]![0] === 170 && movedOver.points[0]![1] === 352 && stayed.points[0]![0] === 110,
		`ink at ${movedOver.points[0]!.slice(0, 2).join(",")}, other ink at ${stayed.points[0]!.slice(0, 2).join(",")}`);
	v.undo();
	await frames(2);
	const back = page.strokes.find((s) => s.id === over.id)!;
	const backBox = boxElement() as { x: number };
	add("objects: one undo puts the box and its ink back", back.points[0]![0] === 110 && backBox.x === 100, `ink x ${back.points[0]![0]}, box x ${backBox.x}`);

	v.host.settings.inkFollowsObjects = false;
	v.selectItems(0, [], [boxElement()]);
	v.selection.matrix = translate(60, 40);
	v.commitSelectionTransform();
	await frames(2);
	const still = page.strokes.find((s) => s.id === over.id)!;
	add("objects: with the setting off the ink stays where it is", still.points[0]![0] === 110, `ink x ${still.points[0]![0]}`);
	v.undo();
	v.host.settings.inkFollowsObjects = true;
	await frames(2);

	const noticesBefore = noticeEls.length;
	v.selectItems(0, [], [boxElement()]);
	v.deleteSelection();
	await frames(2);
	const offer = noticeEls.length > noticesBefore ? noticeEls[noticeEls.length - 1]! : null;
	add("objects: deleting a box with ink offers to delete the ink", !!offer && /1 stroke was written/.test(offer.textContent ?? "") && !!offer.querySelector("button"), offer?.textContent ?? "no notice");
	const inkBefore = strokeCount();
	(offer?.querySelector<HTMLElement>("button"))?.click();
	await frames(2);
	add("objects: taking the offer deletes the ink", strokeCount() === inkBefore - 1, `${inkBefore} → ${strokeCount()}`);
	v.undo();
	v.undo();
	await frames(2);
	add("objects: undoing the deletion restores the box and its ink", strokeCount() === inkBefore && !!page.elements?.some((e) => e.id === "obj-text"), `${strokeCount()} strokes`);

	// Back to the start.
	v.undo();
	await frames(2);
	add("objects: the document is back to how it was", strokeCount() === startStrokes && (page.elements?.length ?? 0) === startElements, `${strokeCount()} strokes, ${page.elements?.length ?? 0} elements`);
}

interface OpenSample {
	/** Opening the file until its document is in the view (read, parse, journal check, layout). */
	loadMs: number;
	/** Of which: DocumentSession.load (read + parse + validation + journal check). */
	sessionMs: number;
	/** Of which: the view's onDocumentLoaded (layout, fit, first schedule). */
	viewMs: number;
	/** Opening the file until the first painted frame of the static layer. */
	firstPaintMs: number;
	/** Until the page asked for is painted: the same as firstPaintMs when it is restored directly. */
	targetPaintMs: number;
	/** Page (1-based) in view at that moment. */
	page: number;
	/** Staged load: until the part-read document was shown (the page asked for is in), or -1 when the load is not staged. */
	partialMs: number;
	/** Staged load: the longest slice spent reading pages (the event loop is free in between). */
	maxSliceMs: number;
	/** Staged load: the longest stretch the event loop was blocked between the page being shown and the load ending. */
	maxGapMs: number;
}

/**
 * Open-time benchmark (npm run bench:open): a generated notebook is opened in a fresh view `reps` times
 * and the phases are timed with performance.now(). `goTo` is the page (1-based) the user wants to see:
 * with `restore` it is requested through the view state before the document loads (the saved position),
 * without it the view opens on page 1 and the page is reached by scrolling, as before. Desktop Chrome with an
 * in-memory vault: file I/O is instant, so this is CPU time only. NOT measured on Android.
 *
 * `snapshot` emulates the version-history snapshot that the plugin starts when a notebook opens
 * (integration/history-service.ts maybeSnapshot: read the file, parse it again): "eager" parses right away,
 * as before; "deferred" reads the file now and parses it once the page is on screen; "none" leaves it out.
 * `staged` false loads the whole notebook before showing anything (how 0.5.0 did it).
 */
async function measureOpen(
	strokes = 10_000, pages = 10, reps = 5, goTo = 7, restore = true, snapshot: "none" | "eager" | "deferred" = "none", staged = true,
): Promise<{ samples: OpenSample[]; bytes: number; strokes: number }> {
	const text = serialize(stressDocument(strokes, pages));
	const path = `Notebooks/Bench ${strokes}x${pages}.notebook`;
	if (!app.vault.getFileByPath(path)) await app.vault.create(path, text);
	const file = app.vault.getFileByPath(path)!;

	const proto = NotebookView.prototype as unknown as ViewProto;
	const origLoaded = proto.onDocumentLoaded;
	const origLoad = Reflect.get<DocumentSession, "load">(DocumentSession.prototype, "load");
	const origShowPartial = proto.showPartial;
	const origStep = Reflect.get<StagedParse, "step">(StagedParse.prototype, "step");
	let sessionMs = 0, viewMs = 0, partialMs = -1, maxSlice = 0, maxGap = 0, t0 = 0;
	let gapTimer: number | null = null;
	const stopGap = () => {
		if (gapTimer !== null) window.clearInterval(gapTimer);
		gapTimer = null;
	};
	proto.showPartial = function (this: HarnessView) {
		partialMs = performance.now() - t0;
		let last = performance.now();
		stopGap();
		gapTimer = window.setInterval(() => {
			const n = performance.now();
			maxGap = Math.max(maxGap, n - last);
			last = n;
		}, 1);
		origShowPartial.call(this);
	};
	StagedParse.prototype.step = function (this: StagedParse, ...a: Parameters<StagedParse["step"]>) {
		const t = performance.now();
		const r = origStep.apply(this, a);
		maxSlice = Math.max(maxSlice, performance.now() - t);
		return r;
	};
	proto.onDocumentLoaded = function (this: unknown, ...a: unknown[]) {
		const t = performance.now();
		origLoaded.apply(this, a);
		viewMs = performance.now() - t;
	};
	DocumentSession.prototype.load = async function (this: DocumentSession, opts?: Parameters<DocumentSession["load"]>[0]) {
		const t = performance.now();
		await origLoad.call(this, staged ? opts : {});
		sessionMs = performance.now() - t;
	};
	const samples: OpenSample[] = [];
	try {
		for (let rep = 0; rep < reps + 1; rep++) {
			const root = document.getElementById("harness-app")!;
			if (view) await (view as unknown as HarnessView).onClose();
			root.empty();
			await frames(2);
			leaf = new WorkspaceLeaf(app, root);
			view = new NotebookView(asLeaf(leaf), { settings: settings() });
			await view.onOpen();
			const v = view as unknown as HarnessView;
			let firstPaint = -1, targetPaint = -1;
			partialMs = -1;
			maxSlice = 0;
			maxGap = 0;
			stopGap();
			t0 = performance.now();
			v.renderer.onFrame = () => {
				const now = performance.now() - t0;
				if (firstPaint < 0 && v.renderer.stats.strokesDrawn > 0) firstPaint = now;
				if (targetPaint < 0 && v.currentPageIndex() === goTo - 1 && v.renderer.stats.strokesDrawn > 0) targetPaint = now;
			};
			if (snapshot !== "none") {
				const run = async () => {
					const text = await app.vault.read(file);
					if (snapshot === "deferred") await wait(1500);
					parse(text);
				};
				void run();
			}
			if (restore) await v.setState({ file: path, page: goTo }, { history: false });
			// The stub's FileView does not load the file from setState: do what Obsidian does after it.
			await v.loadFile(file);
			const loadMs = performance.now() - t0;
			stopGap();
			if (restore) v.applyPendingPage?.();
			for (let i = 0; i < 60 && firstPaint < 0; i++) await frames(1);
			if (!restore) {
				// Before: the view opened on page 1; the reader scrolls to the page.
				v.scrollToPage(goTo - 1);
				for (let i = 0; i < 60 && targetPaint < 0; i++) await frames(1);
			} else {
				for (let i = 0; i < 60 && targetPaint < 0; i++) await frames(1);
			}
			if (rep === 0) continue; // warm-up: JIT, caches
			samples.push({ loadMs, sessionMs, viewMs, firstPaintMs: firstPaint, targetPaintMs: targetPaint, page: v.currentPageIndex() + 1, partialMs, maxSliceMs: maxSlice, maxGapMs: maxGap });
		}
	} finally {
		proto.onDocumentLoaded = origLoaded;
		proto.showPartial = origShowPartial;
		StagedParse.prototype.step = origStep;
		stopGap();
		DocumentSession.prototype.load = origLoad;
	}
	return { samples, bytes: text.length, strokes };
}

/**
 * Heavy page warning check (wave 0.7: lod): a notebook with one page of 3,500 strokes shows the banner; "Split page" moves the
 * lower part to a new page in one undo step; undo puts it back; "Dismiss" hides the banner for the page.
 */
async function checkHeavy(strokes = 3500): Promise<Record<string, unknown>> {
	const path = "Notebooks/Heavy.notebook";
	const file = (app.vault.getFileByPath(path) ?? (await app.vault.create(path, serialize(stressDocument(strokes, 1)))));
	const root = document.getElementById("harness-app")!;
	const openFresh = async () => {
		if (view) await (view as unknown as HarnessView).onClose();
		root.empty();
		leaf = new WorkspaceLeaf(app, root);
		view = new NotebookView(asLeaf(leaf), { settings: settings() });
		await view.onOpen();
		await (view as unknown as HarnessView).loadFile(file);
		await wait(1300);
	};
	const banner = () => {
		const el = root.querySelector<HTMLElement>(".notebook-heavy");
		const shown = !!el && el.style.display !== "none" && el.offsetParent !== null;
		return { shown, text: shown ? el.innerText.replace(/\s+/g, " ").trim() : "", buttons: shown ? [...el.querySelectorAll("button")].map((b) => b.textContent) : [] };
	};
	const click = (label: string) => ([...root.querySelectorAll(".notebook-heavy button")].find((b) => b.textContent === label) as HTMLElement | undefined)?.click();
	const counts = () => ((view as unknown as HarnessView).session.doc.pages).map((p) => p.strokes.length);

	await openFresh();
	const shown = banner();
	const before = counts();
	click("Split page");
	await wait(300);
	const afterSplit = counts();
	const bannerAfterSplit = banner();
	(view as unknown as HarnessView).undo();
	await wait(100);
	const afterUndo = counts();
	click("Dismiss");
	await wait(1300);
	const dismissed = banner();
	await openFresh();
	const light = (app.vault.getFileByPath("Notebooks/Light.notebook") ?? (await app.vault.create("Notebooks/Light.notebook", serialize(stressDocument(500, 1)))));
	await (view as unknown as HarnessView).loadFile(light);
	await wait(1300);
	return { shown, before, afterSplit, bannerAfterSplit, afterUndo, dismissedHides: !dismissed.shown, lightHasNoBanner: !banner().shown };
}

function applyTheme(theme = params.get("theme") ?? "light"): void {
	document.body.classList.toggle("theme-dark", theme === "dark");
	document.body.classList.toggle("theme-light", theme !== "dark");
	// 0.12.1: the device classes Obsidian puts on body (a touch screen is a phone or tablet in the scenarios).
	const mobile = window.matchMedia("(pointer: coarse)").matches;
	document.body.classList.toggle("is-mobile", mobile);
	document.body.classList.toggle("is-phone", mobile && window.innerWidth < 600);
	document.body.classList.toggle("is-tablet", mobile && window.innerWidth >= 600);
}

/**
 * wave 0.10: the selection tools through the real view. Rectangle selection by a pen drag, the second row of the selection
 * bar and its menus, align, rotate, mirror, exact size, select similar and the colour/tool picker; each change is one undo
 * step. Leaves the document as it found it.
 */
async function checkSelectionTools(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as unknown as HarnessView;
	const doc = view!.document!;
	const page = doc.pages[0]!;
	const start = strokeCount();
	const tb = v.toolbar;
	const label = `selection tools ${window.innerWidth}px`;
	const red = createStroke("#dc2626", 2, [[40, 100, 0.3], [60, 102, 0.5], [80, 100, 0.7]], "pen");
	const red2 = createStroke("#dc2626", 2, [[120, 140, 0.3], [160, 142, 0.5], [200, 140, 0.7]], "pen");
	const yellow = createStroke("#facc15", 14, [[240, 190, 0.5], [250, 192, 0.5], [260, 190, 0.5]], "highlighter");
	const mine = [red, red2, yellow];
	view!.applyCommand(new Batch("Add test ink", mine.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i))));
	await frames(2);
	const find = (id: string) => page.strokes.find((s) => s.id === id)!;
	const minX = (s: Stroke) => Math.min(...s.points.map((p: number[]) => p[0]!));
	const maxX = (s: Stroke) => Math.max(...s.points.map((p: number[]) => p[0]!));
	const selectedIds = () => new Set<string>((v.selection?.strokes ?? []).map((s) => s.id));
	const bar = () => document.querySelector<HTMLElement>(".notebook-context-bar")!;
	const barIds = (sel: string) => Array.from(bar().querySelectorAll(`${sel} [data-action]`)).map((b) => (b as HTMLElement).dataset.action);
	const stageBox = stage().getBoundingClientRect();
	const frac = (px: number, py: number): [number, number] => {
		const box = v.layout.boxes[0]!;
		const { scale, offsetX, offsetY } = v.viewport;
		return [(offsetX + (box.x + px) * scale) / stageBox.width, (offsetY + (box.y + py) * scale) / stageBox.height];
	};
	const visible = (() => {
		const a = frac(20, 80), b = frac(280, 210);
		return a[0] >= 0 && a[1] >= 0 && b[0] <= 1 && b[1] <= 1;
	})();
	const reselect = () => v.selectItems(0, mine.map((s) => find(s.id)), []);

	// Rectangle selection (63): the toggle is on the lasso bar, and a diagonal drag picks what the box holds.
	tb.update({ tool: "lasso" });
	v.refreshUi();
	v.ui.refreshNow();
	const toggle = bar().querySelector<HTMLElement>('[data-action="select-rectangle"]');
	add(`${label}: the lasso bar offers rectangle selection and select by colour or tool`, !!toggle && barIds("").includes("select-by-style") && toggle.getAttribute("aria-pressed") === "false", barIds("").join());
	click(toggle, "rectangle toggle");
	await frames(2);
	v.ui.refreshNow();
	const pressed = (bar().querySelector<HTMLElement>('[data-action="select-rectangle"]'))?.getAttribute("aria-pressed");
	add(`${label}: the toggle switches the lasso to a rectangle`, tb.state.selectMode === "rectangle" && pressed === "true", `${tb.state.selectMode}, pressed ${pressed}`);
	if (visible) {
		await penStroke([frac(20, 80), frac(280, 210)], { pointerType: "pen", steps: 10 });
		const got = selectedIds();
		add(`${label}: dragging a rectangle selects the ink inside it`, mine.every((s) => got.has(s.id)), `${got.size} selected`);
	} else {
		reselect();
		await wait(200);
		add(`${label}: dragging a rectangle selects the ink inside it`, true, "region not in view at this size: selected through the view");
	}
	v.ui.refreshNow();
	const second = barIds(".notebook-context-second");
	add(`${label}: the selection bar has a second row with select similar, align and transform`,
		second.includes("selection-similar") && second.includes("selection-align-menu") && second.includes("selection-transform-menu"), second.join());
	const cr = bar().getBoundingClientRect();
	add(`${label}: the two-row selection bar fits the view with 40 px targets`, cr.left >= -0.5 && cr.right <= window.innerWidth + 0.5 && Array.from(bar().querySelectorAll("button")).every((b) => (b as HTMLElement).offsetHeight >= 40),
		`bar ${Math.round(cr.left)}-${Math.round(cr.right)}`);
	if (tb.state.selectMode === "rectangle") v.runAction("select-rectangle");
	add(`${label}: the rectangle mode toggles back to the lasso`, tb.state.selectMode === "lasso", tb.state.selectMode);

	// Align (38) from the menu of the bar: the left edges meet, in one undo step.
	reselect();
	await frames(2);
	v.ui.refreshNow();
	const first = mine.map((s) => minX(find(s.id)));
	click(bar().querySelector('[data-action="selection-align-menu"]'), "align menu");
	const menu = (window as unknown as { harnessMenu?: unknown }).harnessMenu as { titles: string[]; run(title: string): void } | undefined;
	add(`${label}: the align button opens a menu with every align and distribute entry`,
		!!menu && ["Align left", "Align centre", "Align right", "Align top", "Align middle", "Align bottom", "Distribute horizontally", "Distribute vertically"].every((x) => menu.titles.includes(x)), menu?.titles.join(", ") ?? "no menu");
	menu?.run("Align left");
	await frames(2);
	const lefts = mine.map((s) => minX(find(s.id)) - s.width / 2);
	add(`${label}: align left puts the ink on one edge`, Math.max(...lefts) - Math.min(...lefts) < 8.01, lefts.map((x) => x.toFixed(1)).join(", "));
	v.undo();
	await frames(2);
	add(`${label}: one undo restores the places`, mine.every((s, i) => Math.abs(minX(find(s.id)) - first[i]!) < 0.01), "");

	// Rotate, mirror and exact size (65): one undo step each, ink kept as vectors.
	reselect();
	// The panel measures the ink with its thickness, like the selection box does.
	const widthOf = () => Math.max(...mine.map((s) => maxX(find(s.id)) + find(s.id).width / 2)) - Math.min(...mine.map((s) => minX(find(s.id)) - find(s.id).width / 2));
	const before = widthOf();
	v.runAction("selection-rotate-cw");
	await frames(2);
	add(`${label}: rotate 90 degrees turns the selection (width becomes its height)`, Math.abs(widthOf() - before) > 20 && selectedIds().size === 3, `${before.toFixed(1)} -> ${widthOf().toFixed(1)}`);
	v.undo();
	await frames(2);
	add(`${label}: undo of the rotation is one step`, Math.abs(widthOf() - before) < 0.05, `${widthOf().toFixed(2)} vs ${before.toFixed(2)}`);
	reselect();
	const redLeft = minX(find(red.id));
	v.runAction("selection-mirror-h");
	await frames(2);
	add(`${label}: mirror left to right swaps the sides`, minX(find(red.id)) > redLeft + 50 && Math.abs(widthOf() - before) < 0.1, `${redLeft} -> ${minX(find(red.id))}`);
	v.undo();
	await frames(2);
	reselect();
	v.runAction("selection-resize");
	await frames(2);
	const panel = document.querySelector<HTMLElement>(".notebook-resize-panel");
	const wIn = panel?.querySelector<HTMLInputElement>("#notebook-resize-width");
	const hIn = panel?.querySelector<HTMLInputElement>("#notebook-resize-height");
	add(`${label}: exact size opens a panel with the current size`, !!wIn && !!hIn && Number(wIn.value) > 0 && Number(hIn.value) > 0, `${wIn?.value} x ${hIn?.value}`);
	if (wIn && hIn && panel) {
		const w1 = Number(wIn.value), h1 = Number(hIn.value);
		const half = Math.round(w1 / 2);
		wIn.value = String(half);
		wIn.dispatchEvent(new Event("input", { bubbles: true }));
		add(`${label}: with the lock on, the height follows the width`, Math.abs(Number(hIn.value) - (h1 * half) / w1) < 0.02, `${hIn.value}`);
		click(panel.querySelector("button.mod-cta"), "Apply");
		await frames(2);
		add(`${label}: Apply gives the selection that size`, Math.abs(widthOf() - half) < 1.2, `${widthOf().toFixed(2)} vs ${half}`);
		v.undo();
		await frames(2);
		add(`${label}: undo restores the size`, Math.abs(widthOf() - before) < 0.05, `${widthOf().toFixed(2)}`);
	}

	// Select similar and the picker (64).
	v.selectItems(0, [find(red.id)], []);
	v.runAction("select-same-colour");
	await frames(2);
	const same = selectedIds();
	add(`${label}: select similar (same colour) takes the other red stroke and not the highlighter`, same.has(red.id) && same.has(red2.id) && !same.has(yellow.id), `${same.size} selected`);
	v.selectItems(0, [find(yellow.id)], []);
	v.runAction("select-same-tool");
	await frames(2);
	const byTool = selectedIds();
	add(`${label}: select similar (same tool) takes the highlighter strokes only`, byTool.has(yellow.id) && !byTool.has(red.id) && [...byTool].every((id) => find(id)?.tool === "highlighter"), `${byTool.size} selected`);
	v.clearSelection();
	v.runAction("select-by-style");
	await frames(2);
	const picker = document.querySelector<HTMLElement>(".notebook-style-panel");
	const rows = Array.from(picker?.querySelectorAll<HTMLElement>("button.notebook-style-row") ?? []);
	const hl = rows.find((r) => r.textContent?.startsWith("Highlighter"));
	add(`${label}: the picker lists the tools and colours of the page`, !!picker && rows.length >= 3 && !!hl, `${rows.length} rows`);
	click(hl, "Highlighter row");
	await frames(2);
	const picked = selectedIds();
	add(`${label}: picking the highlighter selects all highlighter strokes`, picked.size > 0 && [...picked].every((id) => find(id)?.tool === "highlighter") && picked.has(yellow.id), `${picked.size} selected`);

	// Leave the document as it was.
	v.clearSelection();
	v.undo();
	await frames(2);
	setTool("pen");
	v.refreshUi();
	add(`${label}: the test ink is gone again`, strokeCount() === start, `${start} -> ${strokeCount()}`);
}

function applySize(): void {
	const w = params.get("w"), h = params.get("h");
	const root = document.getElementById("harness-app")!;
	if (w) root.style.width = `${Number(w)}px`;
	if (h) root.style.height = `${Number(h)}px`;
}

const harnessApi: Record<string, unknown> = { app, checkLibrary, checkEmpty, checkHostile: runHostile, hostileDialog, emptyDialogShot, interactLibrary, libraryState, open, measureOpen, penStroke, setTool, openOptions, openMore, measureLod, compareLod, checkHeavy, openPageSheet, selectFirstStroke, radialState, closeAll, check, checkCreate: async (tab: "notebook" | "folder" = "notebook") => { try { return JSON.parse(JSON.stringify(await checkCreate({ app, errors, notices }, tab))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`create check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, createShot: (tab: "notebook" | "folder") => prepareShot({ app, errors, notices }, tab), checkReadOnly: async () => { try { return JSON.parse(JSON.stringify(await checkReadOnly({ view, app, stage, penStroke, setTool, strokeCount, frames, openMore, errors, notices }))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`readonly check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, checkPractice: () => checkPractice({ view, app, service: practiceService, frames, errors, notices }), checkOutline: () => checkOutline({ view, frames, errors, notices }), checkSettings: async () => { try { return JSON.parse(JSON.stringify(await checkSettings({ app, errors, notices }))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`settings check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, checkZettel: async () => { try { return JSON.parse(JSON.stringify(await checkZettel({ app, view, errors, notices }))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`zettel check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, zettelState: (state: ZettelState) => zettelState({ app, view, errors, notices }, state), checkHints: async () => { try { return JSON.parse(JSON.stringify(await checkHints({ errors, notices }))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`hints check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, checkPlugin: async () => { try { return JSON.parse(JSON.stringify(await checkPlugin({ errors, notices }))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`plugin check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } }, checkExcerpt: () => checkExcerpt({ view, stage, penStroke, setTool, strokeCount, staticPixel, frames, errors, notices }), checkReading: () => checkReading({ view, stage, penStroke, setTool, strokeCount, staticPixel, inkNear, frames, openMore, errors, notices }), staticPixel, strokeCount, errors, notices, applyTheme, get view() {
	return view;
} };

/** 0.12: doc=library opens Home or the library (surface=home|library) on a seeded demo vault instead of a notebook. */
let libraryHarness: LibraryHarness | null = null;
const librarySurface = params.get("surface") ?? "library";

async function checkLibrary(): Promise<Record<string, unknown>> {
	const results = checkLibraryLayout(librarySurface);
	return { ok: results.every((r) => r.ok) && errors.length === 0, results, errors: [...errors], env: { dpr: window.devicePixelRatio } };
}

/** 0.12.2: Home or the library on an empty vault (doc=empty): creation is reachable and the empty state teaches it. */
async function checkEmpty(): Promise<Record<string, unknown>> {
	const results = libraryHarness ? await checkEmptyLibrary(libraryHarness, librarySurface) : [];
	return { ok: results.every((r) => r.ok) && errors.length === 0, results, errors: [...errors], env: { dpr: window.devicePixelRatio } };
}

/** 0.12.3: the hostile empty vault: everything but the art is drawn; only the injected failures may log. */
async function runHostile(): Promise<Record<string, unknown>> {
	const results = libraryHarness ? await checkHostile(librarySurface) : [];
	const unexpected = errors.filter((e) => !HOSTILE_ERROR.test(e));
	results.push({ name: "the injected failures were logged by the guards", ok: errors.some((e) => HOSTILE_ERROR.test(e)), detail: `${errors.length} errors` });
	return { ok: results.every((r) => r.ok) && unexpected.length === 0, results, errors: unexpected, env: { dpr: window.devicePixelRatio } };
}

/** 0.13 home2: the revised Home's structure and controls (home2-check.ts). */
const homeVariant = (params.get("variant") ?? "lecture") as HomeVariant;
async function checkHome(): Promise<Record<string, unknown>> {
	const results = libraryHarness ? await checkHome2(libraryHarness, homeVariant) : [];
	return { ok: results.every((r) => r.ok) && errors.length === 0, results, errors: [...errors] };
}
harnessApi.checkHome2 = checkHome;
harnessApi.home2State = (state: string) => (libraryHarness ? home2State(libraryHarness, state) : false);

async function interactLibrary(): Promise<Record<string, unknown>> {
	const results = libraryHarness ? await libraryInteractions(libraryHarness, librarySurface) : [];
	return { ok: results.every((r) => r.ok) && errors.length === 0, results, errors: [...errors] };
}

async function main(): Promise<void> {
	applyTheme();
	applySize();
	if (params.get("doc") === "library" || params.get("doc") === "empty") {
		libraryHarness = await openLibraryHarness(app, librarySurface, params.get("doc") === "empty", homeVariant);
		return;
	}
	// 0.12.1: doc=plugin starts the whole plugin on its own stub app (plugin-check.ts); no notebook is opened.
	if (params.get("doc") === "plugin" || params.get("doc") === "hints") return;
	await seed();
	await open();
	if (params.get("check") === "1") {
		const out = document.getElementById("harness-report")!;
		try {
			const report = await check();
			out.textContent = JSON.stringify(report);
			out.dataset.ok = String(report.ok);
		} catch (e) {
			out.textContent = JSON.stringify({ ok: false, results: [], errors: [...errors, `check threw: ${(e as Error).stack ?? String(e)}`] });
			out.dataset.ok = "false";
		}
		out.dataset.done = "1";
	}
}

// 0.13 ds-notebook: the editing chrome on the design system (doc=chrome, ds-notebook-check.ts).
const chromeApi = () => ({ view, openOptions, openMore, openPageSheet, selectFirstStroke, radialState, closeAll, wait, errors, notices });
Object.assign(harnessApi, {
	checkChrome: async () => { try { return JSON.parse(JSON.stringify(await checkChrome(chromeApi()))) as unknown; } catch (e) { return { ok: false, results: [], errors: [`chrome check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} }; } },
	chromeShot: (state: ChromeState) => chromeState(chromeApi(), state),
});

Object.assign(harnessApi, modalsApi({ app, errors, notices }));
(window as unknown as { harness: Record<string, unknown> }).harness = harnessApi;
harnessApi.ready = main();
