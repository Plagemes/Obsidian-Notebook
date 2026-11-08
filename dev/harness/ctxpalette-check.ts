/**
 * Smoke check of the context palette (0.26, roadmap #394) on the real view (HARNESS_DOC=ctxpalette npm run harness:check).
 * `doc=ctxpalette` is a PDF page: coloured bands are painted onto the rendered page bitmap (the fake PDF is pale), strokes in red,
 * blue, green and an area in yellow are written, one colour is kept as a recent colour, and the picker is opened: it must show
 * "On this page" (red first, most used; not the recent blue; no near duplicate) and "From the slide" (navy, orange, teal; not the
 * pale paper), a colour with a meaning shows its label, a tap sets the pen colour without adding it to the recent colours, a long
 * press explains the row, and opening the picker again shows the slide row at once (cached). `doc=ctxpalettew` is a written page
 * with no background: only the page row. The picker is left open for the screenshots (dist/shots/ctxpalette-*.png, ctxpalettew-*.png).
 */
import { AddElement, AddStroke, Batch } from "../../src/model/history";
import { createStroke } from "../../src/model/document";
import { deltaE } from "../../src/ink/context-palette";
import type { AreaElement, NotebookDocument, Page, Stroke } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface CtxpaletteCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface CtxView {
	document: NotebookDocument;
	currentPage(): number;
	applyCommand(command: unknown): void;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void };
	host: { settings: { recentColours: string[]; colourMeanings: Array<{ colour: string; label: string }> } };
	colour: { openPicker(): void; closePicker(): void };
	media: { pdf: { peek(asset: string, page: number): { canvas: HTMLCanvasElement } | null } } | null;
	renderer?: { invalidate(): void };
}

const RED = "#dc2626", BLUE = "#1d4ed8", GREEN = "#15803d", YELLOW = "#facc15";
const NAVY = "#1e3a8a", ORANGE = "#f97316", TEAL = "#0d9488";

export async function checkCtxpalette(api: CtxpaletteCheckApi, written = false): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as CtxView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const all = <T extends Element>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));
	const row = (title: string): HTMLElement | null => all<HTMLElement>(".notebook-colour-ctx-row").find((r) => r.querySelector(".notebook-colour-ctx-title")?.textContent === title) ?? null;
	const hexes = (r: HTMLElement | null): string[] => (r ? Array.from(r.querySelectorAll<HTMLElement>(".notebook-colour-ctx-dot")).map((d) => d.style.getPropertyValue("--c").trim().toLowerCase()) : []);
	const waitFor = async (fn: () => boolean, ms = 3000): Promise<boolean> => {
		for (let t = 0; t < ms; t += 50) {
			if (fn()) return true;
			await sleep(50);
		}
		return fn();
	};

	await api.frames(3);
	v.toolbar.update({ tool: "pen" });
	v.host.settings.colourMeanings = [];

	// --- the page: ink in three colours (red the most), an area, and a PDF bitmap with coloured bands ---
	const line = (color: string, y: number): Stroke => createStroke(color, 2, [[60, y, 0.5], [140, y - 10, 0.5], [220, y + 8, 0.5], [300, y - 6, 0.5], [380, y + 4, 0.5]], "pen");
	const strokes = [line(RED, 300), line(RED, 340), line(RED, 380), line(BLUE, 430), line(BLUE, 470), line(GREEN, 520)];
	v.applyCommand(new Batch("Specimen ink", strokes.map((s, i) => new AddStroke(page().id, s, page().strokes.length + i))));
	const area: AreaElement = { id: "cp-area", type: "area", x: 50, y: 560, width: 340, height: 28, color: YELLOW };
	v.applyCommand(new AddElement(page().id, area, page().elements?.length ?? 0));
	const bg = page().background;
	if (!written) {
		add("the page has a PDF background", bg?.kind === "pdf");
		if (bg?.kind === "pdf") {
			const ready = await waitFor(() => !!v.media?.pdf.peek(bg.asset, bg.page));
			const canvas = v.media?.pdf.peek(bg.asset, bg.page)?.canvas;
			add("the PDF page bitmap is ready", ready && !!canvas);
			if (canvas) {
				const g = canvas.getContext("2d")!;
				const w = canvas.width, h = canvas.height;
				g.fillStyle = NAVY;
				g.fillRect(0, h * 0.55, w, h * 0.3);
				g.fillStyle = ORANGE;
				g.fillRect(0, h * 0.85, w * 0.6, h * 0.1);
				g.fillStyle = TEAL;
				g.fillRect(w * 0.6, h * 0.85, w * 0.4, h * 0.1);
				v.renderer?.invalidate();
			}
		}
	} else add("the written page has no background", !bg);
	await api.frames(4);

	// --- the picker: recent blue is not repeated ---
	v.host.settings.recentColours = [BLUE];
	v.colour.openPicker();
	await api.frames(2);
	const pageRow = row("On this page");
	const pageHex = hexes(pageRow);
	add("the picker has the row On this page", !!pageRow, `${pageHex.join(" ")}`);
	add("the page row is ranked by use (red first) and has green and yellow", pageHex[0] === RED && pageHex.includes(GREEN) && pageHex.includes(YELLOW), pageHex.join(" "));
	add("a recent colour is not repeated in the page row", !pageHex.includes(BLUE));
	if (written) {
		add("no From the slide row on a written page", !row("From the slide"));
	} else {
		const got = await waitFor(() => !!row("From the slide"));
		const slideHex = hexes(row("From the slide"));
		add("the slide row shows the colours of the slide, biggest first", got && slideHex[0] === NAVY && slideHex.includes(ORANGE) && slideHex.includes(TEAL), slideHex.join(" "));
		add("the pale paper colour is not offered", slideHex.every((h) => deltaE(h, "#e8eef8") > 8));
	}
	const every = [...pageHex, ...hexes(row("From the slide")), BLUE];
	let near = 0;
	for (let i = 0; i < every.length; i++) for (let j = i + 1; j < every.length; j++) if (deltaE(every[i]!, every[j]!) < 8) near++;
	add("no two colours across the rows are near-identical", near === 0, `${near} pairs`);

	// --- a colour with a meaning shows its label ---
	v.colour.closePicker();
	v.host.settings.colourMeanings = [{ colour: RED, label: "Definition" }];
	v.colour.openPicker();
	await api.frames(2);
	const labelled = all<HTMLElement>(".notebook-colour-ctx-chip.has-label");
	add("the red chip carries the meaning Definition", labelled.length === 1 && labelled[0]!.textContent === "Definition" && /Definition/.test(labelled[0]!.getAttribute("aria-label") ?? ""), `${labelled.length}`);

	// --- the slide row is cached: it is there at once when the picker is opened again ---
	if (!written) {
		v.colour.closePicker();
		v.colour.openPicker();
		add("the slide row is there at once on the second opening (cached)", !!row("From the slide"));
	}

	// --- a tap sets the pen colour and does not touch the recent colours ---
	const chip = all<HTMLButtonElement>(".notebook-colour-ctx-chip").find((c) => c.getAttribute("aria-label")?.includes(GREEN));
	chip?.click();
	await api.frames(2);
	add("tapping a chip sets the pen colour", String(v.toolbar.state.penColor).toLowerCase() === GREEN, String(v.toolbar.state.penColor));
	add("and does not add it to the recent colours", v.host.settings.recentColours.length === 1 && v.host.settings.recentColours[0] === BLUE);

	// --- long press explains the row ---
	const target = all<HTMLButtonElement>(".notebook-colour-ctx-chip")[0];
	if (target) {
		const r = target.getBoundingClientRect();
		const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 11, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
		target.dispatchEvent(new PointerEvent("pointerdown", init));
		const shown = await waitFor(() => !!document.querySelector(".nb-help-bubble .nb-help-desc"), 1500);
		const text = document.querySelector(".nb-help-bubble .nb-help-desc")?.textContent ?? "";
		target.dispatchEvent(new PointerEvent("pointerup", init));
		add("a long press on a chip explains its row", shown && /used on this page/i.test(text), text.slice(0, 60));
	}
	await sleep(1500);

	// --- left open for the screenshot ---
	v.colour.closePicker();
	v.colour.openPicker();
	await sleep(400);
	await api.frames(3);
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { pageRow: pageHex, written } };
}
