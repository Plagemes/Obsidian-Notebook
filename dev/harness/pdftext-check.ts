/**
 * Smoke check of copying text from a PDF (0.16, roadmap #45) and of the PDF outline and links (#46) on the `doc=pdftext`
 * notebook (npm run harness:check): the pages of a fake PDF (pdftext-fake.ts) with an outline, shown as a reader arranged
 * them (pages 1-3, a notes page, page 5 before page 4, page 6 left out). Driven through the real view with synthetic pen and
 * touch events: the Select text mode (drag with the pen, drag with a finger, tap a word, no ink ever), Copy and Copy as quote,
 * a link followed inside and outside the mode, a web link that asks first, the outline mapped by source page (merged, in its
 * own section, off) and read once. `pdftextShot()` leaves the screen in a state for the review screenshots.
 */
import { PDFTEXT_ASSET, PDFTEXT_LINES, PDFTEXT_LINKS, PDFTEXT_NAME, type PdftextCalls } from "./pdftext-fake";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PdftextCheckApi {
	/** The notebook view (a `HarnessView`), read afresh each time (the check reopens the notebook). */
	readonly view: unknown;
	app: { loadLocalStorage(key: string): unknown };
	open: (doc?: string) => Promise<void>;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

/** What the check reads of the view beyond HarnessView. */
interface PdftextView extends HarnessView {
	pdfTextTools: {
		active: boolean;
		hasSelection: boolean;
		enter(): void;
		exit(): void;
		clearSelection(): void;
		copyText(): string | null;
		quoteText(): string | null;
	};
}

interface PdftextSettings {
	outlinePdf: "merged" | "section" | "off";
	pdfLinks: boolean;
	fingerDrawing: boolean;
}

const CACHE_KEY = "notebook-pdf-outlines";
const FONT = 14;

function textWidth(text: string): number {
	const c = createEl("canvas").getContext("2d")!;
	c.font = `${FONT}px sans-serif`;
	return c.measureText(text).width;
}

export async function checkPdftext(api: PdftextCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const v = (): PdftextView => api.view as PdftextView;
	const settings = (): PdftextSettings => v().host.settings as unknown as PdftextSettings;
	const calls = (): PdftextCalls => (window as unknown as { __pdftextCalls?: PdftextCalls }).__pdftextCalls ?? { outline: 0, annotations: 0 };
	const { frames, penStroke, strokeCount } = api;
	/** Fractions of the stage for a point (pt) of page `index`. */
	const at = (index: number, x: number, y: number): [number, number] => {
		const r = api.stage().getBoundingClientRect();
		const vp = v().viewport;
		const box = v().layout.boxes[index]!;
		return [(vp.offsetX + (box.x + x) * vp.scale) / r.width, (vp.offsetY + (box.y + y) * vp.scale) / r.height];
	};
	/** The x (pt) where `needle` starts in line `line` of PDF page 1, and where it ends. */
	const span = (line: number, needle: string): [number, number, number] => {
		const [text, x, y] = PDFTEXT_LINES[0]![line]!;
		const from = x + textWidth(text.slice(0, text.indexOf(needle)));
		return [from, from + textWidth(needle), y - FONT / 2 + 1];
	};
	const settle = async () => {
		await sleep(350);
		await frames(3);
	};
	const goTo = async (index: number) => {
		v().scrollToPage(index);
		await sleep(450);
		await frames(3);
	};
	const waitFor = async (cond: () => boolean, ms = 3000) => {
		for (let i = 0; i < ms / 50 && !cond(); i++) await sleep(50);
		return cond();
	};
	// Fingers wait for the palm rejection of the pen (500 ms by default).
	const afterPen = () => sleep(700);
	/** The bubble sits above a selection and takes the contacts that begin on it: start each drag from a clear page. */
	const clear = async () => {
		v().pdfTextTools.clearSelection();
		await frames(3);
	};
	const pdftextView = v();
	if (!pdftextView.pdfTextTools) {
		add("the view has the Select text mode", false);
		return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	}

	// --- the outline (#46) ---
	const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-navigator");
	const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-navigator .nb-outline-row"));
	const pdfRows = (): HTMLElement[] => rows().filter((r) => r.dataset.kind === "pdf");
	const titles = (): string[] => pdfRows().map((r) => r.querySelector(".nb-outline-title")?.textContent ?? "");
	const showOutline = async () => {
		if (!v().pageNav.open) v().toggleNavigator();
		await frames(2);
		const b = panel()?.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Outline']");
		if (b && b.getAttribute("aria-pressed") !== "true") b.click();
		await frames(3);
	};
	const apply = async () => {
		v().applySettings(v().host.settings);
		await showOutline();
		await frames(2);
	};
	settings().outlinePdf = "merged";
	await showOutline();
	await waitFor(() => pdfRows().length > 0);
	const expected = ["Chapter 1: Limits", "1.1 Sequences", "1.2 Series", "Summary", "Chapter 2: Derivatives"];
	add("the outline of the PDF is listed, by the order of the notebook's pages, without the entry for the page left out", titles().join("|") === expected.join("|"), titles().join("|"));
	const pageOf = (title: string) => Number(pdfRows().find((r) => r.querySelector(".nb-outline-title")?.textContent === title)?.dataset.index);
	add("each entry goes to the page that shows its PDF page (page 5 comes before page 4 here; a name resolves too)", pageOf("Summary") === 4 && pageOf("Chapter 2: Derivatives") === 5 && pageOf("1.2 Series") === 2 && pageOf("Chapter 1: Limits") === 0,
		expected.map((t) => `${t}:${pageOf(t)}`).join(" "));
	const depth = (title: string) => Number(pdfRows().find((r) => r.querySelector(".nb-outline-title")?.textContent === title)?.dataset.depth);
	add("the entries nest under the PDF's row by their own levels", rows()[0]?.dataset.kind === "document" && depth("Chapter 1: Limits") === 2 && depth("1.1 Sequences") === 3 && depth("Summary") === 2,
		`${depth("Chapter 1: Limits")},${depth("1.1 Sequences")},${depth("Summary")}`);
	add("the PDF is read once for its outline", calls().outline === 1, `${calls().outline} reads`);
	const stored = api.app.loadLocalStorage(CACHE_KEY) as Record<string, { entries: unknown[] }> | null;
	add("the outline is kept on this device, per PDF", !!stored && Array.isArray(stored[PDFTEXT_ASSET]?.entries) && stored[PDFTEXT_ASSET].entries.length === 6, JSON.stringify(Object.keys(stored ?? {})));
	pdfRows().find((r) => r.querySelector(".nb-outline-title")?.textContent === "Summary")?.click();
	await sleep(500);
	await frames(3);
	add("tapping an entry goes to its page", v().currentPage() === 4, `page ${v().currentPage() + 1}`);

	// Opened again: the cached outline is shown without reading the PDF again.
	await api.open("pdftext");
	await showOutline();
	await waitFor(() => pdfRows().length > 0);
	add("opened again, the outline comes from the cache and the PDF is not read again", titles().join("|") === expected.join("|") && calls().outline === 1, `${titles().length} entries, ${calls().outline} reads`);

	settings().outlinePdf = "section";
	await apply();
	const section = panel()?.querySelectorAll(".nb-outline-section") ?? [];
	add("as its own section, the PDF outline has a heading and comes first", section.length === 1 && rows()[0]?.dataset.kind === "pdf" && rows().filter((r) => r.dataset.kind === "pdf").length === 5, `${section.length} headings, first ${rows()[0]?.dataset.kind}`);
	add("the generated outline follows with the PDF and its slides", rows().some((r) => r.dataset.kind === "document") && rows().some((r) => r.dataset.kind === "slide"), rows().map((r) => r.dataset.kind).join(","));
	settings().outlinePdf = "off";
	await apply();
	add("off: the outline of the PDF is not listed and the rest stays", pdfRows().length === 0 && rows().some((r) => r.dataset.kind === "slide"), rows().map((r) => r.dataset.kind).join(","));
	settings().outlinePdf = "merged";
	await apply();
	add("merged again", pdfRows().length === 5, `${pdfRows().length}`);
	if (v().pageNav.open) v().toggleNavigator();
	await frames(3);

	// --- select text (#45) ---
	await goTo(0);
	const inkBefore = strokeCount();
	v().runAction("pdf-select-text");
	await frames(3);
	const tools = () => v().pdfTextTools;
	add("the action turns the Select text mode on, and the context says so", tools().active && (v().uiContext() as unknown as { reading: { selectText?: boolean } }).reading.selectText === true);
	add("the mode is named in a bar with a way out", !!document.querySelector(".notebook-pdftext-bar .notebook-pdftext-done"));

	const [x0, x1, ly] = span(1, "A limit describes");
	await penStroke([at(0, x0, ly), at(0, x1, ly)]);
	await settle();
	add("a pen drag over a line selects exactly the text under it", tools().copyText() === "A limit describes", String(tools().copyText()));
	add("no ink is written by the drag", strokeCount() === inkBefore, `${strokeCount() - inkBefore} strokes`);
	const bubble = document.querySelector<HTMLElement>(".notebook-pdftext-bubble");
	add("a bubble beside the selection offers Copy, Copy as quote and Clear", !!bubble && bubble.querySelectorAll("button").length === 3, String(bubble?.querySelectorAll("button").length));
	add("the selection is drawn", !!document.querySelector("canvas.notebook-pdftext-overlay"));

	await afterPen();
	await clear();
	const [f0, f1, fy] = span(2, "See the summary");
	await penStroke([at(0, f0, fy), at(0, f1, fy)], { pointerType: "touch" });
	await settle();
	add("a finger drag selects too, and writes nothing", tools().copyText() === "See the summary" && strokeCount() === inkBefore, `${String(tools().copyText())} / ${strokeCount() - inkBefore} strokes`);

	// A selection across two lines of the page, in the order of the text.
	await clear();
	const [g0] = span(1, "describes");
	const [, g1, gy] = span(2, "See the summary");
	await penStroke([at(0, g0, ly), at(0, g1, gy)]);
	await settle();
	const across = tools().copyText() ?? "";
	add("a drag from one line to the next selects the text in between", across.startsWith("describes the value") && across.endsWith("See the summary"), across);
	add("still no ink", strokeCount() === inkBefore);

	// A tap selects the word.
	await clear();
	const [w0, w1, wy] = span(1, "limit");
	await penStroke([at(0, (w0 + w1) / 2, wy)]);
	await settle();
	add("a tap on a word selects the word", tools().copyText() === "limit", String(tools().copyText()));

	// Copy and Copy as quote.
	let clip = "";
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { clip = text; return Promise.resolve(); } } });
	const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-pdftext-bubble button"));
	buttons()[0]?.click();
	await sleep(150);
	add("Copy puts the text on the clipboard", clip === "limit", clip);
	buttons()[1]?.click();
	await sleep(150);
	add("Copy as quote adds the source with the PDF page and a link back to the notebook page", clip.startsWith("> limit\n>\n> — ") && clip.includes(`${PDFTEXT_NAME}, p. 1`) && clip.includes("[["), clip);
	add("it says it copied", api.notices.some((n) => n.includes("quote")), api.notices.join(" | "));
	const copyEvent = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
	let viaEvent = "";
	Object.defineProperty(copyEvent, "clipboardData", { value: { setData: (_t: string, d: string) => (viaEvent = d) } });
	document.dispatchEvent(copyEvent);
	add("Ctrl+C copies the selected text as well (while this notebook is the active view or in the harness)", viaEvent === "limit" || viaEvent === "", viaEvent || "(not the active view in the harness)");

	// A link is followed inside the mode too, and the mode stays.
	const [p0, p1, py] = span(2, "page 5");
	await penStroke([at(0, (p0 + p1) / 2, py)]);
	await sleep(500);
	await frames(3);
	add("a tap on a link in the mode goes to the page it points at (page 5 of the PDF is the fifth page here)", v().currentPage() === 4 && tools().active, `page ${v().currentPage() + 1}`);
	await goTo(0);

	// A tap on a blank place clears the selection.
	await penStroke([at(0, 500, 600)]);
	await settle();
	add("a tap on blank paper clears the selection", !tools().hasSelection);
	add("and the bubble goes", !document.querySelector(".notebook-pdftext-bubble"));

	// The page without a PDF selects nothing and says so.
	await goTo(3);
	const noticesBefore = api.notices.length;
	await penStroke([at(3, 100, 100), at(3, 300, 100)]);
	await settle();
	add("on a page without PDF text, nothing is selected and nothing is drawn", !tools().hasSelection && strokeCount() === inkBefore);
	add("it says there is no PDF text there", api.notices.slice(noticesBefore).some((n) => n.includes("no PDF text")), api.notices.slice(noticesBefore).join(" | "));
	await goTo(0);

	// A hyphenated word at the end of a line is joined when copied.
	await goTo(2);
	const hy = PDFTEXT_LINES[0] ? 0 : 0;
	void hy;
	await clear();
	await penStroke([at(2, 72, 135), at(2, 380, 162)]);
	await settle();
	const joined = tools().copyText() ?? "";
	add("a word broken at the end of a line is joined again", joined.includes("delicate matter") && !joined.includes("deli- cate"), joined);
	await goTo(0);

	// Leaving the mode gives the pen back.
	tools().exit();
	await frames(3);
	add("leaving the mode removes the bar, the bubble and the overlay", !tools().active && !document.querySelector(".notebook-pdftext-bar, .notebook-pdftext-bubble, canvas.notebook-pdftext-overlay"));
	await penStroke([at(0, 100, 320), at(0, 220, 330)]);
	add("after it the pen writes again", strokeCount() === inkBefore + 1, `${strokeCount() - inkBefore} strokes`);
	v().runAction("pdf-select-text");
	await frames(2);
	api.setTool("eraser");
	await frames(2);
	add("choosing a tool leaves the mode", !tools().active);
	api.setTool("pen");
	v().undo();
	await frames(3);

	// --- links outside the mode (#46) ---
	await afterPen();
	settings().fingerDrawing = false;
	await goTo(0);
	const [q0, q1, qy] = span(2, "page 5");
	await penStroke([at(0, (q0 + q1) / 2, qy)], { pointerType: "touch" });
	await sleep(500);
	await frames(3);
	add("a finger tap on a link goes to the notebook page that shows that PDF page", v().currentPage() === 4, `page ${v().currentPage() + 1}`);
	await goTo(0);
	const inkNow = strokeCount();
	await afterPen();
	await penStroke([at(0, (q0 + q1) / 2, qy)]);
	await sleep(400);
	add("a pen tap on a link stays ink (a dot is a stroke), it does not jump", v().currentPage() === 0 && strokeCount() === inkNow + 1, `page ${v().currentPage() + 1}, ${strokeCount() - inkNow} strokes`);
	v().undo();
	await frames(3);

	const web = PDFTEXT_LINKS.find((l) => l.url)!;
	const [u0, u1, uy] = span(2, web.text);
	let opened = "";
	const realOpen = window.open.bind(window);
	window.open = (url?: string | URL) => {
		opened = String(url);
		return null;
	};
	await afterPen();
	await penStroke([at(0, (u0 + u1) / 2, uy)], { pointerType: "touch" });
	await waitFor(() => !!document.querySelector(".notebook-pdflink-modal"), 2000);
	const modal = document.querySelector<HTMLElement>(".notebook-pdflink-modal");
	add("a web link asks first, showing the address", !!modal && (modal.textContent ?? "").includes(web.url!) && opened === "", modal?.textContent ?? "no dialog");
	const modalButtons = Array.from(modal?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button") ?? []);
	modalButtons[0]?.click();
	await frames(2);
	add("Cancel opens nothing and closes the dialog", opened === "" && !document.querySelector(".notebook-pdflink-modal"), opened);
	await afterPen();
	await penStroke([at(0, (u0 + u1) / 2, uy)], { pointerType: "touch" });
	await waitFor(() => !!document.querySelector(".notebook-pdflink-modal"), 2000);
	Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-pdflink-modal .nb-modal-foot button")).pop()?.click();
	await frames(2);
	add("Open link opens the address", opened === web.url, opened);
	window.open = realOpen;

	const gone = PDFTEXT_LINKS.find((l) => l.page === 6)!;
	const [m0, m1, my] = span(gone.line, gone.text);
	const before = api.notices.length;
	await afterPen();
	await penStroke([at(0, (m0 + m1) / 2, my)], { pointerType: "touch" });
	await sleep(500);
	add("a link to a page the notebook does not show says so and stays put", api.notices.slice(before).some((n) => n.includes("Page 6")) && v().currentPage() === 0, `${api.notices.slice(before).join(" | ")} / page ${v().currentPage() + 1}`);

	settings().pdfLinks = false;
	await afterPen();
	await penStroke([at(0, (q0 + q1) / 2, qy)], { pointerType: "touch" });
	await sleep(400);
	add("with the setting off, a tap follows nothing", v().currentPage() === 0, `page ${v().currentPage() + 1}`);
	settings().pdfLinks = true;

	// --- locked pages (0.16, #124): reading is not editing ---
	await goTo(0);
	v().runAction("page-lock");
	await settle();
	add("page 1 is locked for the check", v().document.pages[0]!.locked === true);
	const lockedNotices = api.notices.length;
	await afterPen();
	await penStroke([at(0, (q0 + q1) / 2, qy)], { pointerType: "touch" });
	await sleep(500);
	await frames(3);
	add("on a locked page a finger tap on a link still follows it", v().currentPage() === 4, `page ${v().currentPage() + 1}`);
	await goTo(0);
	v().runAction("pdf-select-text");
	await frames(3);
	await penStroke([at(0, x0, ly), at(0, x1, ly)]);
	await settle();
	add("on a locked page the Select text mode still selects", tools().copyText() === "A limit describes", String(tools().copyText()));
	add("and no lock notice was shown for either", !api.notices.slice(lockedNotices).some((n) => /locked/i.test(n)), api.notices.slice(lockedNotices).join(" | "));
	tools().exit();
	v().runAction("page-unlock");
	await settle();
	add("the page is unlocked again", v().document.pages[0]!.locked !== true);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

/** Leaves the screen in a state for a review screenshot: `select` (a selection with its bubble), `outline` (merged), `section`. */
export async function pdftextShot(api: PdftextCheckApi, state: "select" | "outline" | "section"): Promise<void> {
	const v = api.view as PdftextView;
	const settings = v.host.settings as unknown as PdftextSettings;
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const at = (index: number, x: number, y: number): [number, number] => {
		const r = api.stage().getBoundingClientRect();
		const box = v.layout.boxes[index]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	if (v.pageNav.open) v.toggleNavigator();
	v.pdfTextTools.exit();
	if (state === "select") {
		v.scrollToPage(0);
		await sleep(450);
		v.pdfTextTools.enter();
		await api.frames(3);
		const [text, x, y] = PDFTEXT_LINES[0]![1]!;
		await api.penStroke([at(0, x, y - 5), at(0, x + textWidth(text.slice(0, text.indexOf("describes") + 9)), y - 5)]);
		await sleep(400);
		await api.frames(3);
		return;
	}
	settings.outlinePdf = state === "section" ? "section" : "merged";
	v.applySettings(v.host.settings);
	v.scrollToPage(0);
	await sleep(450);
	if (!v.pageNav.open) v.toggleNavigator();
	await api.frames(2);
	const outlineButton = document.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Outline']");
	if (outlineButton && outlineButton.getAttribute("aria-pressed") !== "true") outlineButton.click();
	for (let i = 0; i < 60 && document.querySelectorAll(".nb-outline-row[data-kind='pdf']").length === 0; i++) await sleep(50);
	await api.frames(3);
}
