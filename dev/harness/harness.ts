/**
 * Browser harness: the real NotebookView (renderer, pointer controller, session, toolbar,
 * navigator) running in a plain web page on top of dev/harness/obsidian-stub.ts.
 *
 * URL parameters (all optional):
 *   doc=v3|new       notebook to open (v3: written by 0.3.0, grid paper and a few strokes; new: empty)
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
import { App, notices, WorkspaceLeaf, type TFile } from "./obsidian-stub";
import { NotebookView } from "../../src/view/notebook-view";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../../src/settings";
import { createDocument } from "../../src/model/document";
import { parse, serialize } from "../../src/model/serialize";
import { WetInk } from "../../src/ink/wet-ink";
import { Renderer } from "../../src/ink/renderer";
import { DocumentSession } from "../../src/storage/session";
import { stressDocument } from "../../src/model/stress";

/* eslint-disable @typescript-eslint/no-explicit-any */

const errors: string[] = [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
	errors.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a))).join(" "));
	origError(...args);
};
window.addEventListener("error", (e) => errors.push(`uncaught: ${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${String((e.reason as Error)?.stack ?? e.reason)}`));

const params = new URLSearchParams(location.search);

/** Injected faults: the guards must keep the page drawn and the pen writing. */
const fault = params.get("fault");
if (fault === "wet") {
	WetInk.prototype.paint = function () {
		throw new Error("harness: injected wet ink failure");
	};
} else if (fault === "stroke") {
	const proto = Renderer.prototype as any;
	const fill = proto.fillStroke as (ctx: CanvasRenderingContext2D, stroke: { id: string }) => void;
	proto.fillStroke = function (ctx: CanvasRenderingContext2D, stroke: { id: string }) {
		if (stroke.id === "s1") throw new Error("harness: injected stroke failure");
		fill.call(this, ctx, stroke);
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
}

function settings(): NotebookSettings {
	const s: NotebookSettings = { ...DEFAULT_SETTINGS };
	if (params.get("lowLatency") === "1") s.lowLatencyInk = true;
	return s;
}

async function open(doc = params.get("doc") ?? "v3"): Promise<void> {
	const root = document.getElementById("harness-app")!;
	if (view) await (view as any).onClose();
	root.empty();
	leaf = new WorkspaceLeaf(app, root);
	view = new NotebookView(leaf as any, { settings: settings() });
	await view.onOpen();
	const file = app.vault.getFileByPath(doc === "new" ? "Notebooks/New.notebook" : "Notebooks/Old v3.notebook") as TFile;
	await (view as any).loadFile(file);
	view.onResize();
	await frames(3);
}

function frames(n = 1): Promise<void> {
	return new Promise((resolve) => {
		const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
		requestAnimationFrame(step);
	});
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stage(): HTMLElement {
	return document.querySelector(".notebook-stage") as HTMLElement;
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
	(view as any).toolbar.setTool(tool);
}

/** RGBA of the static canvas at a point given as fractions of the stage. */
function staticPixel(fx: number, fy: number, canvasCls = "notebook-canvas-static"): number[] {
	const c = stage().querySelector(`canvas.${canvasCls}`) as HTMLCanvasElement;
	const ctx = c.getContext("2d")!;
	const x = Math.min(c.width - 1, Math.floor(fx * c.width)), y = Math.min(c.height - 1, Math.floor(fy * c.height));
	return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

/** Dark ink in a short vertical band around the point (the toolbar may wrap and move the page a little). */
function inkNear(fx: number, fy: number): boolean {
	const c = stage().querySelector("canvas.notebook-canvas-static") as HTMLCanvasElement;
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
	const leafRect = (document.querySelector(".workspace-leaf") as HTMLElement).getBoundingClientRect();
	const r = st.getBoundingClientRect();
	add("stage has a size", r.width >= leafRect.width * 0.5 && r.height >= leafRect.height * 0.5,
		`stage ${Math.round(r.width)}×${Math.round(r.height)} in leaf ${Math.round(leafRect.width)}×${Math.round(leafRect.height)}`);
	const dpr = window.devicePixelRatio || 1;
	const canvases = Array.from(st.querySelectorAll("canvas")) as HTMLCanvasElement[];
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
	const wet = st.querySelector("canvas.notebook-canvas-wet") as HTMLCanvasElement | null;
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
	const v = view as any;
	const wasOpen = !!v.pageNav?.open;
	v.setNavigatorOpen(true);
	let thumb: HTMLImageElement | null = null;
	for (let i = 0; i < 40; i++) {
		await frames(1);
		thumb = document.querySelector("img.notebook-navigator-thumb");
		if (thumb && thumb.complete && thumb.naturalWidth > 0) break;
		await wait(25);
	}
	const navRect = (document.querySelector(".notebook-navigator") as HTMLElement | null)?.getBoundingClientRect();
	add("navigator shows thumbnails", !!thumb && thumb.naturalWidth > 0 && !!navRect && navRect.width > 0 && navRect.height > 0,
		`${thumb ? `${thumb.naturalWidth}×${thumb.naturalHeight}` : "no thumbnail"}, panel ${navRect ? `${Math.round(navRect.width)}×${Math.round(navRect.height)}` : "missing"}`);
	if (!wasOpen) v.setNavigatorOpen(false);
	await frames(4);

	// Reaching the radial menu without the side button: pen hold-still, finger long-press, and the Samsung button
	// (a pressure-0 primary press while hovering: click = menu on release, touch while held = erase). None draws ink.
	{
		const v = view as any;
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
		const ring = st.querySelector(".notebook-radial") as HTMLElement | null;
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
		v.host.settings.penButtonSeen = false;
		v.applySettings(v.host.settings);
		setTool("pen");
	}

	// Radial menu: the pen's side button opens it without drawing; lifting on a sector chooses it.
	{
		setTool("pen");
		const rb = strokeCount();
		const r3 = st.getBoundingClientRect();
		const cx = r3.left + r3.width * 0.5, cy = r3.top + r3.height * 0.5;
		const pen = (name: string, x: number, y: number, extra: PointerEventInit = {}) =>
			new PointerEvent(name, {
				bubbles: true, cancelable: true, composed: true, pointerId: 77, pointerType: "pen", isPrimary: true,
				pressure: 0.5, width: 1, height: 1, button: 0, buttons: 1, clientX: x, clientY: y, ...extra,
			});
		st.dispatchEvent(pen("pointerdown", cx, cy, { button: 2, buttons: 3 }));
		await frames(1);
		const menu = st.querySelector(".notebook-radial");
		add("radial menu opens on the pen side button", !!menu && menu.querySelectorAll(".notebook-radial-item").length === 8,
			menu ? `${menu.querySelectorAll(".notebook-radial-item").length} items` : "no menu");
		st.dispatchEvent(pen("pointerup", cx, cy, { button: 2, buttons: 0, pressure: 0 }));
		await frames(1);
		add("lifting in the middle keeps the menu open", !!st.querySelector(".notebook-radial"), "");
		// Sector 2 (eraser) is to the right of the middle.
		st.dispatchEvent(pen("pointerdown", cx + 72, cy));
		st.dispatchEvent(pen("pointerup", cx + 72, cy, { buttons: 0, pressure: 0 }));
		await frames(2);
		add("tapping a sector chooses its tool and closes the menu", !st.querySelector(".notebook-radial") && (view as any).tools.tool === "eraser",
			`tool ${(view as any).tools.tool}, menu ${st.querySelector(".notebook-radial") ? "open" : "closed"}`);
		add("the radial menu draws nothing", strokeCount() === rb, `${rb} → ${strokeCount()}`);
		setTool("pen");
		await frames(2);
	}

	await checkToolbar(add);

	const unexpected = errors.filter((e) => !expectedError?.test(e));
	if (fault) add("injected fault was reported", errors.some((e) => expectedError!.test(e)), errors[0]?.split("\n")[0] ?? "no error logged");
	const ok = results.every((x) => x.ok) && unexpected.length === 0;
	/** Viewport CSS px where the composited page must show paper and ink (checked on a screenshot by check.mjs). */
	const r2 = st.getBoundingClientRect();
	const points = {
		paper: [r2.left + r2.width * 0.5, r2.top + r2.height * 0.3],
		ink: [r2.left + r2.width * 0.5, r2.top + r2.height * 0.52],
	};
	const env = {
		userAgent: navigator.userAgent, dpr, rawUpdates: (view as any)?.controller?.rawUpdates ?? null, fault,
		theme: document.body.className, doc: params.get("doc") ?? "v3",
		wetDesynchronized: (wet?.getContext("2d") as any)?.getContextAttributes?.()?.desynchronized ?? null,
	};
	return { ok, results, errors: unexpected, notices: [...notices], env, points };
}

/** Fraction of the stage height that is still on the first page, a little above its bottom edge (at most 0.75). */
function lowOnPage(): number {
	const v = view as any;
	const box = v.layout?.boxes?.[0];
	const h = stage().getBoundingClientRect().height;
	if (!box || !h) return 0.75;
	return Math.max(0.55, Math.min(0.75, ((box.y + box.height) * v.viewport.scale + v.viewport.offsetY - 30) / h));
}

/** Buttons of the bar itself (not those inside a popover) that are laid out. */
function barButtons(): HTMLButtonElement[] {
	const bar = document.querySelector(".notebook-toolbar") as HTMLElement;
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
	const tb = (view as any).toolbar;
	tb.closePopover();
	tb.setTool(tool);
	click(byLabel(document, TOOL_LABELS[tool] ?? tool), `tool ${tool}`);
	await frames(3);
}

/** Opens the "more" menu. For screenshots. */
async function openMore(): Promise<void> {
	const tb = (view as any).toolbar;
	tb.closePopover();
	click(byLabel(document, "More actions"), "more button");
	await frames(3);
}

/**
 * Toolbar: it fits the width without sideways overflow, touch targets are at least 40 px, the options popover and the
 * "more" menu open inside the view, choosing in them works, and tapping them, or outside them, draws nothing.
 */
async function checkToolbar(add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const v = view as any;
	const tb = v.toolbar;
	const bar = document.querySelector(".notebook-toolbar") as HTMLElement;
	const width = window.innerWidth;
	const label = `toolbar ${width}px`;
	const inView = (r: DOMRect) => r.left >= -0.5 && r.right <= width + 0.5;

	// 1. Layout.
	const doc = document.documentElement;
	add(`${label}: no sideways overflow`, doc.scrollWidth <= width && bar.scrollWidth <= bar.clientWidth + 1,
		`page ${doc.scrollWidth}, toolbar scroll ${bar.scrollWidth} / client ${bar.clientWidth}, view ${width}`);
	const strays = barButtons().filter((b) => !b.closest(".notebook-favs") && !inView(b.getBoundingClientRect()));
	add(`${label}: every control is inside the view`, strays.length === 0, strays.map((b) => b.getAttribute("aria-label")).join(", "));
	const favs = bar.querySelector(".notebook-favs") as HTMLElement;
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
	const opts = bar.querySelector(".notebook-options") as HTMLElement;
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
	const chip = bar.querySelector(".notebook-chip-dot") as HTMLElement;
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

	// 3. "More" menu: opens inside the view, an item works and closes it.
	click(byLabel(bar, "More actions"), "more button");
	await frames(2);
	const menu = bar.querySelector(".notebook-more") as HTMLElement;
	r = menu.getBoundingClientRect();
	const items = Array.from(menu.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
	add(`${label}: the more menu opens inside the view with its 7 actions`, tb.openPopover === "more" && inView(r) && r.bottom <= window.innerHeight && items.length === 7,
		`menu ${Math.round(r.left)}–${Math.round(r.right)}, bottom ${Math.round(r.bottom)} of ${window.innerHeight}, ${items.length} items, ${tb.openPopover}`);
	add(`${label}: more menu rows are at least 40 px`, items.every((b) => b.offsetHeight >= 40), items.map((b) => b.offsetHeight).join(","));
	click(byText(menu, "Ruler"), "Ruler");
	await frames(2);
	add(`${label}: a more-menu action works and closes the menu`, v.tools.ruler === true && tb.openPopover === null, `ruler ${v.tools.ruler}, popover ${tb.openPopover}`);
	tb.update({ ruler: false });
	await frames(2);
	tb.update({ tool: "pen", penColor: "#1e1e1e", penWidth: 2 });
	tb.closePopover();
	await frames(2);
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
 */
async function measureOpen(
	strokes = 10_000, pages = 10, reps = 5, goTo = 7, restore = true, snapshot: "none" | "eager" | "deferred" = "none",
): Promise<{ samples: OpenSample[]; bytes: number; strokes: number }> {
	const text = serialize(stressDocument(strokes, pages));
	const path = `Notebooks/Bench ${strokes}x${pages}.notebook`;
	if (!app.vault.getFileByPath(path)) await app.vault.create(path, text);
	const file = app.vault.getFileByPath(path) as TFile;

	const proto = NotebookView.prototype as any;
	const origLoaded = proto.onDocumentLoaded as (...a: unknown[]) => void;
	const origLoad = DocumentSession.prototype.load;
	let sessionMs = 0, viewMs = 0;
	proto.onDocumentLoaded = function (this: unknown, ...a: unknown[]) {
		const t = performance.now();
		origLoaded.apply(this, a);
		viewMs = performance.now() - t;
	};
	DocumentSession.prototype.load = async function (this: DocumentSession) {
		const t = performance.now();
		await origLoad.call(this);
		sessionMs = performance.now() - t;
	};
	const samples: OpenSample[] = [];
	try {
		for (let rep = 0; rep < reps + 1; rep++) {
			const root = document.getElementById("harness-app")!;
			if (view) await (view as any).onClose();
			root.empty();
			await frames(2);
			leaf = new WorkspaceLeaf(app, root);
			view = new NotebookView(leaf as any, { settings: settings() });
			await view.onOpen();
			const v = view as any;
			let firstPaint = -1, targetPaint = -1;
			const t0 = performance.now();
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
			if (restore) await v.setState({ file: path, page: goTo }, {});
			// The stub's FileView does not load the file from setState: do what Obsidian does after it.
			await v.loadFile(file);
			const loadMs = performance.now() - t0;
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
			samples.push({ loadMs, sessionMs, viewMs, firstPaintMs: firstPaint, targetPaintMs: targetPaint, page: v.currentPageIndex() + 1 });
		}
	} finally {
		proto.onDocumentLoaded = origLoaded;
		DocumentSession.prototype.load = origLoad;
	}
	return { samples, bytes: text.length, strokes };
}

function applyTheme(theme = params.get("theme") ?? "light"): void {
	document.body.classList.toggle("theme-dark", theme === "dark");
	document.body.classList.toggle("theme-light", theme !== "dark");
}

function applySize(): void {
	const w = params.get("w"), h = params.get("h");
	const root = document.getElementById("harness-app")!;
	if (w) root.style.width = `${Number(w)}px`;
	if (h) root.style.height = `${Number(h)}px`;
}

(window as any).harness = { app, open, measureOpen, penStroke, setTool, openOptions, openMore, check, staticPixel, strokeCount, errors, notices, applyTheme, get view() {
	return view;
} };

async function main(): Promise<void> {
	applyTheme();
	applySize();
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

(window as any).harness.ready = main();
