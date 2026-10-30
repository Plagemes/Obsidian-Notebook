/**
 * Smoke check of the PDF reading tools on the `doc=pdf` notebook (npm run harness:check): search and its marks, the
 * snapping highlighter, hidden annotations and dimmed backgrounds, driven through the real view, toolbar and renderer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

/** What the harness lends to the check. */
export interface ReadingCheckApi {
	view: any;
	stage(): HTMLElement;
	penStroke(points: Array<[number, number]>, opts?: { pointerType?: string }): Promise<void>;
	setTool(tool: string): void;
	strokeCount(): number;
	staticPixel(fx: number, fy: number): number[];
	inkNear(fx: number, fy: number): boolean;
	frames(n: number): Promise<void>;
	openMore(): Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkReading(api: ReadingCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { view: v, stage, penStroke, setTool, strokeCount, staticPixel, inkNear, frames, openMore } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const reading = v.readingTools;
	const settings = v.host.settings;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const text = (sel: string): string => document.querySelector(sel)?.textContent ?? "";
	const search = async (query: string): Promise<void> => {
		const input = document.querySelector(".notebook-search-input") as HTMLInputElement;
		input.value = query;
		input.dispatchEvent(new Event("input"));
		await sleep(700);
	};
	/** Fractions of the stage for a point of the first page (pt). */
	const at = (x: number, y: number): [number, number] => {
		const r = stage().getBoundingClientRect();
		const vp = v.viewport;
		return [(vp.offsetX + x * vp.scale) / r.width, (vp.offsetY + y * vp.scale) / r.height];
	};
	const overlayPixels = (): number => {
		const c = document.querySelector(".notebook-reading-overlay") as HTMLCanvasElement | null;
		if (!c) return 0;
		const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
		return n;
	};
	const lastStroke = (): any => {
		const strokes = v.document.pages[0].strokes;
		return strokes[strokes.length - 1];
	};

	add("the reading tools are in the view", !!reading && !!document.querySelector(".notebook-search") && !!document.querySelector(".notebook-reading-banner"));
	v.refreshUi();
	await sleep(50);
	const bar = document.querySelector(".notebook-context-bar") as HTMLElement;
	const barActions = [...bar.querySelectorAll("[data-action]")].map((b) => b.getAttribute("aria-label") ?? "");
	add("a PDF page shows the PDF contextual bar with search, hide annotations and dim", !bar.classList.contains("notebook-hidden") && bar.dataset.context === "pdf"
		&& ["Search PDF text", "Hide annotations", "Dim backgrounds"].every((l) => barActions.includes(l)), `${bar.dataset.context}: ${barActions.join(" | ")}`);
	await openMore();
	const entries = [...document.querySelectorAll(".notebook-sheet .notebook-menu-item")].map((b) => b.textContent ?? "");
	add("the All actions sheet offers search, hide annotations and dim", ["Search PDF text", "Hide annotations", "Dim backgrounds"].every((l) => entries.some((e) => e.includes(l))), entries.join(" | "));
	v.ui.sheet.close();
	/** The content of the notebook (the modification time moves with every save and is not compared). */
	const content = (): string => JSON.stringify([v.document.pages, v.document.assets]);
	const before = content();

	// 1. Search.
	reading.openSearch();
	await search("quick");
	add("search finds every match across the pages, ignoring case", text(".notebook-search-count") === "1 / 5", text(".notebook-search-count"));
	add("the matches are listed with their page", document.querySelectorAll(".notebook-search-row").length === 5);
	add("the matches are marked on the page", overlayPixels() > 200, `${overlayPixels()} marked pixels`);
	reading.step(1);
	reading.step(1);
	await sleep(250);
	add("next moves to the third match and keeps it in view", text(".notebook-search-count") === "3 / 5" && overlayPixels() > 200, `${text(".notebook-search-count")}, ${overlayPixels()} marked pixels, offsetY ${Math.round(v.viewport.offsetY)}`);
	await search("CAFFE");
	add("search ignores accents and case", text(".notebook-search-count") === "1 / 1", text(".notebook-search-count"));
	await search("q");
	add("a one-letter query is refused with a message", text(".notebook-search-status").includes("2 characters"), text(".notebook-search-status"));
	reading.closeSearch();
	await sleep(100);
	add("closing the search clears the marks", overlayPixels() === 0 && document.querySelector(".notebook-search")?.classList.contains("notebook-hidden") === true);
	add("searching changes nothing in the notebook", content() === before);

	// 2. Snapping highlighter.
	v.scrollToPage(0);
	await sleep(300);
	settings.snapHighlighter = true;
	reading.settingsChanged();
	setTool("highlighter");
	await sleep(300);
	const strokes0 = strokeCount();
	await penStroke([at(150, 135), at(330, 137)]);
	const snapped = lastStroke();
	add("a highlighter stroke over text becomes one straight stroke as high as the line",
		strokeCount() === strokes0 + 1 && snapped?.tool === "highlighter" && snapped.width > 14 && snapped.width < 17
			&& Math.abs(snapped.points[0][1] - snapped.points[snapped.points.length - 1][1]) < 0.01,
		snapped ? `width ${snapped.width}, ${snapped.points.length} points` : "no stroke");
	v.undo();
	add("the snap is one undo step", strokeCount() === strokes0);
	await penStroke([at(100, 133), at(260, 133), at(100, 154), at(260, 154)]);
	add("a stroke across two lines gives one highlight per line", strokeCount() === strokes0 + 2, `${strokeCount() - strokes0} strokes`);
	v.undo();
	add("one undo removes both highlights", strokeCount() === strokes0);
	await penStroke([at(100, 500), at(300, 505)]);
	const kept = lastStroke();
	add("a highlighter stroke over no text stays as drawn", strokeCount() === strokes0 + 1 && kept?.width === 14 && kept.points.length > 4, `width ${kept?.width}, ${kept?.points.length} points`);
	v.undo();
	settings.snapHighlighter = false;
	reading.settingsChanged();
	await penStroke([at(150, 135), at(330, 137)]);
	const plain = lastStroke();
	add("with the option off the stroke is not snapped", strokeCount() === strokes0 + 1 && plain?.width === 14, `width ${plain?.width}`);
	v.undo();

	// 3. Hide the annotations (a finger draws in this scenario, so that scrolling with it shows the read-only input).
	settings.fingerDrawing = true;
	v.applySettings(settings);
	setTool("pen");
	await penStroke([at(100, 300), at(400, 320), at(450, 360)]);
	await frames(3);
	const [ix, iy] = at(250, 310);
	const hadInk = inkNear(ix, iy);
	reading.toggleAnnotations();
	await sleep(300);
	const stillInk = inkNear(ix, iy);
	const banner = document.querySelector(".notebook-reading-banner") as HTMLElement;
	add("hiding the annotations removes the ink from a PDF page", hadInk && !stillInk, `ink before ${hadInk}, after ${stillInk}`);
	add("a banner says the view is read-only", !banner.classList.contains("notebook-hidden") && (banner.textContent ?? "").includes("View only"));
	const hiddenStrokes = strokeCount();
	await penStroke([[0.3, 0.6], [0.6, 0.62]]);
	add("nothing can be drawn while the annotations are hidden", strokeCount() === hiddenStrokes);
	const tools = [...document.querySelectorAll(".notebook-toolbar-tools .notebook-tool")] as HTMLButtonElement[];
	add("the tools are disabled while hidden", tools.slice(1).every((b) => b.disabled));
	const y0 = v.viewport.offsetY;
	await penStroke([[0.5, 0.7], [0.5, 0.4]], { pointerType: "touch" });
	add("a finger still scrolls while hidden", v.viewport.offsetY < y0 - 50 && strokeCount() === hiddenStrokes, `offsetY ${Math.round(y0)} -> ${Math.round(v.viewport.offsetY)}`);
	await sleep(1500); // a finger scroll flings on for a while
	(banner.querySelector("button") as HTMLButtonElement).click();
	await sleep(300);
	v.scrollToPage(0);
	await sleep(300);
	add("the banner's button shows the annotations again and editing works again", !reading.annotationsHidden && inkNear(ix, iy) && tools.slice(1).every((b) => !b.disabled), `ink ${inkNear(ix, iy)}`);
	v.undo();
	settings.fingerDrawing = false;
	v.applySettings(settings);

	// 4. Dim the background.
	const paper = (): number[] => staticPixel(0.08, 0.3);
	const normal = paper();
	reading.toggleDim();
	await sleep(300);
	const dimmed = paper();
	add("dimming makes the PDF background lighter", settings.dimBackground === true && dimmed[0]! > normal[0]! && dimmed[1]! > normal[1]! && dimmed[2]! > normal[2]!, `${normal.slice(0, 3)} -> ${dimmed.slice(0, 3)}`);
	await openMore();
	const range = document.querySelector(".notebook-menu-range input") as HTMLInputElement;
	range.value = "75";
	range.dispatchEvent(new Event("input", { bubbles: true }));
	range.dispatchEvent(new Event("change", { bubbles: true }));
	await sleep(300);
	const lighter = paper();
	add("the slider sets the strength and keeps the menu open", settings.dimStrength === 0.75 && lighter[0]! > dimmed[0]! && v.ui.sheet.isOpen, `strength ${settings.dimStrength}, ${dimmed.slice(0, 3)} -> ${lighter.slice(0, 3)}`);
	v.ui.sheet.close();
	reading.toggleDim();
	await sleep(300);
	const restored = paper();
	add("turning it off restores the background", restored.every((c, i) => c === normal[i]), `${restored.slice(0, 3)}`);
	add("none of this changed the notebook content", content() === before);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio || 1 } };
}
