/**
 * Smoke check of the start and end time of a page (0.21, roadmap #217, format v19) on the `doc=pagetime` notebook (the blank "New"
 * notebook; npm run harness:check): the real view with synthetic pen events. A page nobody wrote on has no times; the first stroke
 * stamps both, a later stroke moves only the end; Undo takes the ink away and leaves the times; the header line shows them and the
 * setting hides them; the notebook map shows them on the card (label, tooltip and the quiet line). The final state (the map open
 * on a page written over about an hour, set by the check so the screenshot shows a range) is left for the screenshot.
 */
import { pageTimes } from "../../src/model/page-times";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PagetimeCheckApi {
	view: unknown;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}


export async function checkPagetime(api: PagetimeCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const page = () => v.document.pages[v.currentPage()]!;
	const settings = v.host.settings as unknown as Record<string, unknown>;
	const set = async (o: Record<string, unknown>): Promise<void> => {
		Object.assign(settings, o);
		v.applySettings(v.host.settings);
		await frames(3);
	};
	const pt = (n: number) => (n * v.viewport.scale) / api.stage().getBoundingClientRect().width;
	const ptY = (n: number) => (n * v.viewport.scale) / api.stage().getBoundingClientRect().height;
	const line = (y: number) => penStroke([[pt(80), ptY(y)], [pt(160), ptY(y + 6)], [pt(240), ptY(y)]]);
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-map-modal");
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-map-modal .nb-map-card"));

	setTool("pen");
	await set({ headerMode: "off", headerPageTimes: true });
	add("a page nobody wrote on has no times", pageTimes(page()) === null);

	const t0 = Date.now();
	await line(120);
	await frames(3);
	const first = pageTimes(page());
	add("the first stroke starts and ends the page", !!first && first.startAt === first.endAt && first.startAt >= t0 - 50 && first.startAt <= Date.now() + 50, JSON.stringify(first));

	await sleep(60);
	await line(160);
	await frames(3);
	const second = pageTimes(page());
	add("a later stroke moves only the end", !!first && !!second && second.startAt === first.startAt && second.endAt > first.endAt, JSON.stringify(second));

	v.undo();
	await frames(3);
	const undone = pageTimes(page());
	add("undo takes the ink away and leaves the times", page().strokes.length === 1 && !!second && !!undone && undone.startAt === second.startAt && undone.endAt === second.endAt, JSON.stringify(undone));
	v.redo();
	await frames(3);
	add("redo gives the ink back and does not move the times", page().strokes.length === 2 && JSON.stringify(pageTimes(page())) === JSON.stringify(second));

	// The header line (only when the header is on) shows the times; the setting hides them.
	await set({ headerMode: "header", headerPageNumber: true, headerPageTotal: true, headerDate: false, headerTitle: false, headerAlign: "centre", headerPageTimes: true });
	const withTimes = page().strokes.length > 0 ? document.querySelector<HTMLCanvasElement>("canvas.notebook-canvas-static") : null;
	add("the header is drawn with the times on", withTimes !== null);
	await set({ headerPageTimes: false });
	await set({ headerPageTimes: true });

	// A range for the screenshot: the page written over about an hour (set by the check, only so that the picture shows a span).
	const p = page();
	const span = pageTimes(p);
	if (span) {
		p.startAt = span.startAt - 62 * 60 * 1000;
		v.renderer.invalidate();
		await frames(3);
	}

	// The notebook map: the card shows when the page was written; the setting hides it.
	if (!v.pageNav.open) v.toggleNavigator();
	await frames(2);
	const open = (): void => document.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Notebook map']")?.click();
	open();
	await frames(3);
	const m = modal();
	if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
	await frames(2);
	const card = cards()[0];
	const when = card?.querySelector(".nb-map-when")?.textContent ?? "";
	add("the map card shows when the page was written", /\d{1,2}:\d{2}\s–\s\d{1,2}:\d{2}/.test(when), when);
	add("its tooltip and label carry it", (card?.title ?? "").includes(when) && (card?.getAttribute("aria-label") ?? "").includes(when), card?.title ?? "");
	add("the line stays inside the card", !!card && (() => { const r = card.getBoundingClientRect(); const w = card.querySelector(".nb-map-when")!.getBoundingClientRect(); return w.left >= r.left - 1 && w.right <= r.right + 1; })());

	cards()[0]?.click();
	await sleep(300);
	await set({ headerPageTimes: false });
	open();
	await frames(3);
	add("the setting hides it from the map", cards()[0] !== undefined && cards()[0]!.querySelector(".nb-map-when") === null);
	cards()[0]?.click();
	await sleep(300);
	await set({ headerPageTimes: true });
	open();
	await frames(3);
	const again = modal();
	if (again && !again.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(again);
	await frames(2);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
