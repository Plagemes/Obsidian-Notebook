/**
 * Smoke check of the actions suggested by the geometry of a selection (0.28, roadmap #403) on the `doc=geosuggest` notebook (the blank
 * "New" notebook; HARNESS_DOC=geosuggest npm run harness:check): the real view, selection bar and History. A row of handwriting offers
 * two chips (Highlight, Insert into note) above the bar; a paragraph offers none; two clusters of ink joined by an arrow offer Link; a loop
 * around ink offers Group; the chips never move a slot of the bar; Highlight puts an area behind the words as one undo step; the setting
 * "Suggest actions from the selection" turns them off. `geosuggestShot` leaves the page for the screenshots.
 */
import { AddStroke, Batch, EraseStrokes } from "../../src/model/history";
import { areasOf } from "../../src/model/area";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface GeosuggestCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface GeoView extends Omit<HarnessView, "host"> {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	host: { settings: { suggestSelection: boolean } };
}

const pt = (x: number, y: number): Point => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.55];
const line = (a: [number, number], b: [number, number], n = 8): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
const ring = (cx: number, cy: number, r: number, n = 36): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)));
let seq = 0;
const make = (points: Point[], tool: Stroke["tool"] = "pen"): Stroke => ({ id: `gs-${++seq}`, tool, color: "#1f2933", width: 2, render: RENDER_INK, points });

/** A "word": three letters, each a small loop with a stem, about 20 pt tall. */
function word(x: number, y: number): Stroke[] {
	return [0, 1, 2].flatMap((k) => [make(ring(x + 8 + k * 22, y + 12, 7, 18)), make(line([x + 16 + k * 22, y + 2], [x + 16 + k * 22, y + 22], 4))]);
}
const row = (x: number, y: number): Stroke[] => [...word(x, y), ...word(x + 90, y), ...word(x + 180, y)];

export type GeosuggestState = "row" | "paragraph" | "arrow" | "loop";

function scene(state: GeosuggestState): Stroke[] {
	switch (state) {
		case "row": return row(60, 200);
		case "paragraph": return [...row(60, 200), ...row(60, 236), ...row(60, 272)];
		case "arrow": return [...word(60, 200), ...word(330, 200), make(line([130, 212], [321, 212], 16), "shape"), make(line([309, 204], [321, 212], 3), "shape"), make(line([309, 220], [321, 212], 3), "shape")];
		case "loop": return [...word(100, 210), ...word(100, 240), make(ring(150, 235, 90), "shape")];
	}
}

async function draw(api: GeosuggestCheckApi, state: GeosuggestState): Promise<{ v: GeoView; strokes: Stroke[] }> {
	const v = api.view as GeoView;
	const page = v.document.pages[v.currentPage()] as Page;
	if (page.strokes.length > 0) v.applyCommand(new EraseStrokes(page.id, [...page.strokes].reverse().map((stroke) => ({ stroke, index: page.strokes.indexOf(stroke) }))));
	const strokes = scene(state);
	v.applyCommand(new Batch("Draw", strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i))));
	await api.frames(3);
	v.selectItems(v.currentPage(), strokes, []);
	await api.frames(4);
	return { v, strokes };
}

const chips = (): string[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-context-suggest .notebook-suggest-chip")).map((b) => b.dataset.action ?? "");
const slots = (): string[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-context-main > .notebook-tool, .notebook-context-second > .notebook-tool")).map((b) => b.dataset.action ?? b.getAttribute("aria-label") ?? "");

export async function checkGeosuggest(api: GeosuggestCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v0 = api.view as GeoView;
	const page = (): Page => v0.document.pages[v0.currentPage()]!;

	// --- a row of words ---
	let { v } = await draw(api, "row");
	add("a row of handwriting offers Highlight and Insert into note", JSON.stringify(chips()) === JSON.stringify(["selection-highlight", "selection-insert-note"]), chips().join(","));
	const withChips = slots();
	v.host.settings.suggestSelection = false;
	await draw(api, "row");
	add("the chips are gone with the setting off", chips().length === 0, chips().join(","));
	add("the chips move no slot of the bar", JSON.stringify(slots()) === JSON.stringify(withChips), `${slots().length} vs ${withChips.length}`);
	v.host.settings.suggestSelection = true;
	await draw(api, "row");
	const areasBefore = areasOf(page()).length;
	document.querySelector<HTMLElement>('.notebook-suggest-chip[data-action="selection-highlight"]')?.click();
	await api.frames(4);
	add("Highlight puts one area behind the words", areasOf(page()).length === areasBefore + 1, String(areasOf(page()).length));
	v.undo();
	await api.frames(3);
	add("one undo takes the area away", areasOf(page()).length === areasBefore);

	// --- a paragraph ---
	await draw(api, "paragraph");
	add("a multi-line paragraph offers no chips", chips().length === 0, chips().join(","));

	// --- an arrow between two clusters ---
	await draw(api, "arrow");
	add("two clusters joined by an arrow offer Link", chips()[0] === "link-selection", chips().join(","));

	// --- a loop ---
	await draw(api, "loop");
	add("a loop around ink offers Group", chips().includes("selection-group"), chips().join(","));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { chips: chips() } };
}

/** Rebuilds the page for a screenshot of one of the four selections. */
export async function geosuggestShot(api: GeosuggestCheckApi, state: GeosuggestState): Promise<void> {
	await draw(api, state);
}
