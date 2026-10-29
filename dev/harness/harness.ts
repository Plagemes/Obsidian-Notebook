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
import { serialize } from "../../src/model/serialize";
import { WetInk } from "../../src/ink/wet-ink";
import { Renderer } from "../../src/ink/renderer";

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

	// A stroke to erase, away from the ones the screenshot checks.
	setTool("pen");
	await penStroke([[0.3, 0.75], [0.7, 0.75]]);
	setTool("eraser");
	const eb = strokeCount();
	await penStroke([[0.5, 0.7], [0.5, 0.8]]);
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

(window as any).harness = { app, open, penStroke, setTool, check, staticPixel, strokeCount, errors, notices, applyTheme, get view() {
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
