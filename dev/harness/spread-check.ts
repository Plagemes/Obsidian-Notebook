/**
 * Smoke check of the two-page spread (0.27, roadmap #49) on the `doc=spread` notebook (the blank "New" notebook;
 * HARNESS_DOC=spread npm run harness:check): the real view with synthetic pen events. On a wide landscape view (the tablet held
 * sideways) the pages sit in pairs, the first alone on the right like a book; both pages of a pair are in view at fit; a stroke
 * starts on the page under the pen and stays on it (also one that wanders over the other page); "next page" turns by pair; the
 * page panel highlights both pages of the pair; a saved view and the zoomed minimap work on the right page; the page sheet toggle
 * and the settings switch it off and on, the automatic setting does it by itself. On a phone the same setting shows one column
 * and the toggle is not offered. `spreadShot(state)` leaves the view for the screenshots (light and dark, tablet and phone).
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SpreadCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface SpreadSettings {
	scrollMode: string;
	spreadAuto: boolean;
	spreadFirstAlone: boolean;
	minimapMode: string;
}

interface SpreadView extends Omit<HarnessView, "layout"> {
	layout: { boxes: Box[]; rows?: number[][]; width: number; height: number } | null;
	viewSize: { width: number; height: number };
	spreadOn: boolean;
	setViewport(v: { scale: number; offsetX: number; offsetY: number }, interactive?: boolean): void;
	openNavigator(): void;
	captureViewRegion(): { pageId: string; region: { x: number; y: number; width: number; height: number; zoom: number } } | null;
	showViewRegion(pageIndex: number, region: { x: number; y: number; width: number; height: number; zoom: number }): void;
	toggleSpread(): void;
	minimap: { el: HTMLElement; update(): void } | null;
}

const WIDE = 720;

/** The pen path for page points `pts` of page `index`, as fractions of the stage. */
function onPage(v: SpreadView, index: number, pts: Array<[number, number]>): Array<[number, number]> {
	const box = v.layout!.boxes[index]!;
	const r = document.querySelector<HTMLElement>(".notebook-stage")!.getBoundingClientRect();
	const { scale, offsetX, offsetY } = v.viewport;
	return pts.map(([x, y]) => [((box.x + x) * scale + offsetX) / r.width, ((box.y + y) * scale + offsetY) / r.height]);
}

/** A few pen strokes that look like handwriting on a page of width `w`. */
const lines = (w: number): Array<Array<[number, number]>> => [
	[[0.12 * w, 90], [0.4 * w, 80], [0.7 * w, 92]],
	[[0.12 * w, 150], [0.5 * w, 160], [0.8 * w, 148]],
	[[0.15 * w, 220], [0.45 * w, 212], [0.62 * w, 226]],
];

async function build(api: SpreadCheckApi, pages: number): Promise<SpreadView> {
	const v = api.view as SpreadView;
	const s = v.host.settings as unknown as SpreadSettings;
	s.scrollMode = "spread";
	s.spreadAuto = false;
	s.spreadFirstAlone = true;
	s.minimapMode = "auto";
	v.applySettings(v.host.settings);
	await api.frames(3);
	while (v.document.pages.length < pages) {
		v.addPage();
		await api.frames(2);
	}
	return v;
}

export async function checkSpread(api: SpreadCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames, penStroke, setTool } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = await build(api, 6);
	const s = v.host.settings as unknown as SpreadSettings;
	const wide = v.viewSize.width >= WIDE && v.viewSize.width >= v.viewSize.height;
	const apply = async () => {
		v.applySettings(v.host.settings);
		await frames(3);
	};
	const boxes = () => v.layout!.boxes;
	const stageRect = () => document.querySelector<HTMLElement>(".notebook-stage")!.getBoundingClientRect();
	/** Is the page's box fully inside the stage at the current viewport? */
	const inView = (i: number): boolean => {
		const b = boxes()[i]!;
		const { scale, offsetX, offsetY } = v.viewport;
		const r = stageRect();
		return b.x * scale + offsetX >= -1 && (b.x + b.width) * scale + offsetX <= r.width + 1 && b.y * scale + offsetY >= -1;
	};

	add("the view is a spread only where there is room", v.spreadOn === wide, `${Math.round(v.viewSize.width)}x${Math.round(v.viewSize.height)} spread=${v.spreadOn}`);

	if (!wide) {
		// --- phone: one column, nothing side by side ---
		const xs = new Set(boxes().map((b) => Math.round(b.x)));
		add("a phone keeps one column of pages", xs.size === 1 && v.layout!.rows === undefined, [...xs].join(","));
		add("the setting still says spread", s.scrollMode === "spread");
		add("no spread toggle is offered", (v.uiContext() as unknown as { toggles: { spreadRoom?: boolean } }).toggles.spreadRoom === false);
		setTool("pen");
		v.scrollToPage(2);
		await frames(3);
		await penStroke(onPage(v, 2, lines(boxes()[2]!.width)[0]!));
		add("writing works as before", v.document.pages[2]!.strokes.length === 1);
		return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { wide, pages: v.document.pages.length } };
	}

	// --- the pairs ---
	const rows = v.layout!.rows ?? [];
	add("six pages: the first alone, then pairs", JSON.stringify(rows) === JSON.stringify([[0], [1, 2], [3, 4], [5]]), JSON.stringify(rows));
	add("the first page is on the right of the binding", boxes()[0]!.x > boxes()[1]!.x && boxes()[1]!.x < boxes()[2]!.x);
	add("the two pages of a pair are on the same line and top aligned", boxes()[1]!.y === boxes()[2]!.y);
	v.scrollToPage(1);
	await frames(3);
	add("both pages of the pair are in view at once", inView(1) && inView(2));
	add("the page in view is on the pair", [1, 2].includes(v.currentPage()), String(v.currentPage()));

	// --- writing on both pages ---
	setTool("pen");
	const w = boxes()[1]!.width;
	await penStroke(onPage(v, 1, lines(w)[0]!));
	await penStroke(onPage(v, 2, lines(w)[1]!));
	add("a stroke on the left page is on the left page", v.document.pages[1]!.strokes.length === 1 && v.document.pages[2]!.strokes.length === 1);
	const before = v.document.pages[2]!.strokes.length;
	// Starts on the left page and wanders over the right one.
	await penStroke(onPage(v, 1, [[w - 40, 400], [w + 60, 410], [w + 120, 420]]));
	add("a stroke started on one page never spills onto the other", v.document.pages[1]!.strokes.length === 2 && v.document.pages[2]!.strokes.length === before);
	const stroke = v.document.pages[1]!.strokes[1]!;
	add("its points are in the coordinates of the page it started on", stroke.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0), `first x ${Math.round(stroke.points[0]![0])}`);

	// --- the page panel highlights the pair ---
	v.openNavigator();
	await frames(4);
	const current = [...document.querySelectorAll<HTMLElement>(".notebook-navigator-item.is-current")].map((el) => Number(el.dataset.index)).sort();
	add("the page panel highlights both pages of the pair", current.length === 2 && current[0] === 1 && current[1] === 2, current.join(","));
	v.toggleNavigator();
	await frames(3);

	// --- next page turns by pair ---
	v.goToRelativePage(1);
	await frames(4);
	add("next page turns by pair", [3, 4].includes(v.currentPage()) && inView(3) && inView(4), String(v.currentPage()));
	v.goToRelativePage(-1);
	await frames(4);
	add("previous page turns back by pair", [1, 2].includes(v.currentPage()), String(v.currentPage()));
	v.scrollToPage(5);
	await frames(3);
	add("the odd last page sits alone on the left", boxes()[5]!.x < boxes()[3]!.x + 1 && v.currentPage() === 5);

	// --- zoom in on the right page: the minimap and a saved view ---
	v.scrollToPage(2);
	await frames(3);
	const box = boxes()[2]!;
	const fit = v.viewport.scale;
	v.setViewport({ scale: fit * 2.4, offsetX: v.viewSize.width / 2 - (box.x + box.width / 2) * fit * 2.4, offsetY: 16 - box.y * fit * 2.4 });
	await frames(3);
	add("zoomed in, the page in view is the right one", v.currentPage() === 2, String(v.currentPage()));
	s.minimapMode = "always";
	await apply();
	v.minimap?.update();
	await frames(2);
	add("the minimap follows the page in view", !!v.minimap && !v.minimap.el.classList.contains("notebook-hidden"));
	const saved = v.captureViewRegion();
	add("a view can be saved on the right page", !!saved && saved.pageId === v.document.pages[2]!.id);
	v.scrollToPage(5);
	await frames(3);
	if (saved) v.showViewRegion(2, saved.region);
	await frames(3);
	add("recalling it comes back to the same page and zoom", v.currentPage() === 2 && Math.abs(v.viewport.scale - fit * 2.4) / (fit * 2.4) < 0.02, `scale ${v.viewport.scale.toFixed(3)} vs ${(fit * 2.4).toFixed(3)}`);
	s.minimapMode = "auto";
	await apply();

	// --- first page alone, off ---
	s.spreadFirstAlone = false;
	await apply();
	add("without the book layout the pairs are 1-2, 3-4", JSON.stringify(v.layout!.rows) === JSON.stringify([[0, 1], [2, 3], [4, 5]]), JSON.stringify(v.layout!.rows));
	s.spreadFirstAlone = true;
	await apply();

	// --- toggle from the registry, and the automatic setting ---
	const ctx = () => (v.uiContext() as unknown as { toggles: { spread?: boolean; spreadRoom?: boolean } }).toggles;
	add("the toggle shows the spread is on", ctx().spread === true && ctx().spreadRoom === true);
	v.runAction("toggle-spread");
	await frames(4);
	add("the toggle turns it off: one column again, on the same page", !v.spreadOn && v.layout!.rows === undefined && ctx().spread === false, String(v.currentPage()));
	v.runAction("toggle-spread");
	await frames(4);
	add("...and on again", v.spreadOn && (v.layout!.rows?.length ?? 0) > 0);
	s.scrollMode = "continuous";
	s.spreadAuto = false;
	await apply();
	add("continuous scrolling without the automatic setting is one column", !v.spreadOn);
	s.spreadAuto = true;
	await apply();
	add("the automatic setting shows the spread on a landscape tablet", v.spreadOn);
	s.spreadAuto = false;
	s.scrollMode = "spread";
	await apply();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { wide, pages: v.document.pages.length, rows: JSON.stringify(v.layout!.rows ?? null) } };
}

/** Rebuilds the view for a screenshot: the spread with writing on both pages (`pair`), zoomed on the right page with the minimap (`zoom`), or the page sheet (`sheet`). */
export async function spreadShot(api: SpreadCheckApi, state: "pair" | "zoom" | "sheet"): Promise<void> {
	await api.open("spread");
	const v = await build(api, 5);
	const s = v.host.settings as unknown as SpreadSettings;
	api.setTool("pen");
	const wide = v.viewSize.width >= WIDE && v.viewSize.width >= v.viewSize.height;
	v.scrollToPage(1);
	await api.frames(3);
	const w = v.layout!.boxes[1]!.width;
	// Handwriting on page 2 and, in a spread, on its neighbour (page 3) too.
	for (const page of wide ? [1, 2] : [1]) {
		for (const pts of lines(w)) await api.penStroke(onPage(v, page, pts));
	}
	if (state === "zoom" && wide) {
		const box = v.layout!.boxes[2]!;
		const k = v.viewport.scale * 2.2;
		v.setViewport({ scale: k, offsetX: v.viewSize.width / 2 - (box.x + box.width / 2) * k, offsetY: 16 - box.y * k });
		s.minimapMode = "always";
		v.applySettings(v.host.settings);
	}
	if (state === "sheet") {
		document.querySelector<HTMLElement>(".notebook-page-indicator")?.click();
	}
	await api.frames(6);
}
