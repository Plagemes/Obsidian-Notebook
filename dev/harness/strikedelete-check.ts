/**
 * Smoke check of "strike-through as logical deletion" (0.29, roadmap #96) on the `doc=strikedelete` notebook (the blank "New" notebook;
 * HARNESS_DOC=strikedelete npm run harness:check): the real view, History and export dialog. A page holds three lines of synthetic
 * handwriting: one word is struck through, one is underlined, two words share a long line. The setting is off by default and then the
 * page is drawn as written; the registry action (All actions / command) switches it on, the view finds the struck words (and only those,
 * not the underlined one) and its cache names exactly their strokes and the lines, and the document keeps every stroke; the action
 * again brings them back. The export dialog offers "Leave out struck-out words", off at first, and carries `clean.struck` only when
 * it is on. `strikedeleteShot` leaves the page for the screenshots (struck words shown, then hidden).
 */
import type { App } from "obsidian";
import { AddStroke, Batch, EraseStrokes } from "../../src/model/history";
import { createPage } from "../../src/model/document";
import { PAGE_SIZES, RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { ExportRequest } from "../../src/view/export";
import { ExportModal } from "../../src/view/export-dialog";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface StrikedeleteCheckApi {
	view: unknown;
	app: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface StrikeView extends Omit<HarnessView, "host"> {
	host: { settings: { hideStruck: boolean; exportHideStruck: boolean } };
	strikeTools: { on: boolean; hiddenFor(pageId: string): ReadonlySet<string> | null } | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pt = (x: number, y: number): Point => [r2(x), r2(y), 0.55];
const line = (a: [number, number], b: [number, number], n = 12): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n + Math.sin(i * 1.7) * 0.4));
const loop = (cx: number, cy: number, rx: number, ry: number, n = 24): Point[] => Array.from({ length: n + 1 }, (_, i) => {
	const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
	return pt(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
});

let seq = 0;
const make = (points: Point[], id?: string): Stroke => ({ id: id ?? `sd-${++seq}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points });

/** A "word" of `n` round letters (each a loop 14 pt tall), starting at x, sitting on `base`. */
function word(tag: string, x: number, base: number, n: number): { strokes: Stroke[]; x0: number; x1: number } {
	const strokes = Array.from({ length: n }, (_, k) => make(loop(x + 6 + k * 14, base - 7, 5.5, 7), `${tag}-${k}`));
	return { strokes, x0: x, x1: x + 12 + (n - 1) * 14 };
}

interface Scene {
	strokes: Stroke[];
	/** Everything that hides: the struck words' strokes and their lines. */
	hidden: Set<string>;
	/** The words that stay. */
	kept: Set<string>;
}

function scene(): Scene {
	const strokes: Stroke[] = [];
	const hidden = new Set<string>();
	const kept = new Set<string>();
	const put = (w: { strokes: Stroke[] }, into: Set<string>): void => {
		for (const s of w.strokes) {
			strokes.push(s);
			into.add(s.id);
		}
	};
	// Line 1: "keep STRUCK keep"
	const a1 = word("a1", 60, 220, 4), a2 = word("a2", 140, 220, 6), a3 = word("a3", 250, 220, 4);
	put(a1, kept);
	put(a2, hidden);
	put(a3, kept);
	const strike1 = make(line([a2.x0 - 6, 213], [a2.x1 + 6, 213]), "strike-1");
	strokes.push(strike1);
	hidden.add(strike1.id);
	// Line 2: "keep UNDERLINED keep" (an underline is not a strike)
	const b1 = word("b1", 60, 270, 4), b2 = word("b2", 140, 270, 6), b3 = word("b3", 250, 270, 4);
	put(b1, kept);
	put(b2, kept);
	put(b3, kept);
	const under = make(line([b2.x0 - 4, 276], [b2.x1 + 4, 276]), "underline");
	strokes.push(under);
	kept.add(under.id);
	// Line 3: two words under one long strike
	const c1 = word("c1", 60, 320, 5), c2 = word("c2", 150, 320, 5), c3 = word("c3", 240, 320, 5);
	put(c1, hidden);
	put(c2, hidden);
	put(c3, kept);
	const strike2 = make(line([c1.x0 - 6, 313], [c2.x1 + 6, 313]), "strike-2");
	strokes.push(strike2);
	hidden.add(strike2.id);
	return { strokes, hidden, kept };
}

async function draw(api: StrikedeleteCheckApi): Promise<{ v: StrikeView; page: Page; sc: Scene }> {
	const v = api.view as StrikeView;
	const page = v.document.pages[v.currentPage()] as Page;
	if (page.strokes.length > 0) v.applyCommand(new EraseStrokes(page.id, [...page.strokes].reverse().map((stroke) => ({ stroke, index: page.strokes.indexOf(stroke) }))));
	const sc = scene();
	v.applyCommand(new Batch("Draw", sc.strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i))));
	await api.frames(3);
	return { v, page, sc };
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const same = (a: ReadonlySet<string> | null, b: ReadonlySet<string>): boolean => !!a && a.size === b.size && [...b].every((id) => a.has(id));
const shown = (el: Element | null): boolean => !!el && (el as HTMLElement).getBoundingClientRect().width > 0;
const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;

let dialog: { root: HTMLElement; close: () => void } | null = null;
function closeDialog(): void {
	const d = dialog;
	dialog = null;
	if (!d) return;
	try {
		d.close();
	} catch {
		// Already closed.
	}
	d.root.remove();
}
function openDialog(api: StrikedeleteCheckApi, picked: ExportRequest[], struckDefault?: boolean): HTMLElement {
	closeDialog();
	const pages = [createPage(PAGE_SIZES.a4)];
	const m = new ExportModal({
		app: api.app as App, pageCount: pages.length, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Demo (PNG)", canPrint: false,
		pages: () => pages, run: (request) => picked.push(request), ...(struckDefault !== undefined ? { struckDefault } : {}),
	});
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	dialog = { root, close: () => m.close() };
	return m.modalEl;
}
const exportButton = (root: HTMLElement): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Export");

export async function checkStrikedelete(api: StrikedeleteCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });

	// --- off by default: the page is drawn as written ---
	const first = await draw(api);
	const { v, sc } = first;
	let page = first.page;
	add("the view exists", !!v.strikeTools);
	add("hide struck words is off by default", v.host.settings.hideStruck === false && v.strikeTools?.on === false);
	add("nothing is hidden while it is off", v.strikeTools?.hiddenFor(page.id) === null);

	// --- switched on through the registry action ---
	v.runAction("toggle-hide-struck");
	await sleep(900);
	await api.frames(3);
	page = v.document.pages[v.currentPage()] as Page;
	const ink = v.strikeTools?.hiddenFor(page.id) ?? null;
	add("the action switches the setting on", v.host.settings.hideStruck === true && v.strikeTools?.on === true);
	add("the struck words and their lines are found, nothing else", same(ink, sc.hidden), `${ink?.size ?? 0} of ${sc.hidden.size}`);
	add("an underlined word is not struck", [...sc.kept].every((id) => !ink?.has(id)));
	add("the document keeps every stroke", page.strokes.length === sc.strokes.length, `${page.strokes.length}/${sc.strokes.length}`);

	// --- a new strike is picked up after a change ---
	const w = word("d", 60, 370, 5);
	const extra = make(line([w.x0 - 6, 363], [w.x1 + 6, 363]), "strike-3");
	v.applyCommand(new Batch("Strike", [...w.strokes, extra].map((s, i) => new AddStroke(page.id, s, page.strokes.length + i))));
	await sleep(900);
	await api.frames(3);
	add("a word struck later is hidden too", [...w.strokes, extra].every((s) => v.strikeTools?.hiddenFor(page.id)?.has(s.id)));

	// --- off again: all there ---
	v.runAction("toggle-hide-struck");
	await sleep(100);
	await api.frames(2);
	add("the action again shows them struck through", v.host.settings.hideStruck === false && v.strikeTools?.hiddenFor(page.id) === null);
	add("every stroke is still in the notebook", (v.document.pages[v.currentPage()] as Page).strokes.length === sc.strokes.length + w.strokes.length + 1);

	// --- the export dialog ---
	const picked: ExportRequest[] = [];
	let root = openDialog(api, picked);
	await sleep(60);
	const r = row(root, /^Leave out struck-out words/);
	add("the export dialog offers the switch", shown(r));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	exportButton(root)?.click();
	await sleep(50);
	add("a plain export leaves struck words in (no clean option)", picked[0] !== undefined && picked[0].clean === undefined, JSON.stringify(picked[0]?.clean));
	root = openDialog(api, picked);
	await sleep(60);
	row(root, /^Leave out struck-out words/)?.querySelector<HTMLElement>(".checkbox-container")?.click();
	await sleep(50);
	exportButton(root)?.click();
	await sleep(50);
	add("with the switch on, Export carries clean.struck and no study-layer cleaning", picked[1]?.clean?.struck === true && picked[1].clean.markers === false, JSON.stringify(picked[1]?.clean));
	closeDialog();
	// The switch is remembered for the session; it starts from the setting only before the first choice.
	return { ok: results.every((x) => x.ok), results, errors: api.errors, notices: api.notices, env: { hidden: sc.hidden.size } };
}

export type StrikedeleteState = "shown" | "hidden" | "dialog";

/** Rebuilds the page for a screenshot: the struck words shown, hidden, or the export dialog with its switch. */
export async function strikedeleteShot(api: StrikedeleteCheckApi, state: StrikedeleteState): Promise<void> {
	const { v } = await draw(api);
	const want = state === "hidden";
	if (v.host.settings.hideStruck !== want) v.runAction("toggle-hide-struck");
	await sleep(want ? 900 : 100);
	await api.frames(3);
	if (state === "dialog") openDialog(api, [], false);
	else closeDialog();
	await sleep(60);
}
