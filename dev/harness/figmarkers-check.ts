/**
 * Smoke check of numbered markers on a figure (0.30, roadmap #247) on the `doc=figmarkers` notebook (the blank "New" notebook; HARNESS_DOC=figmarkers
 * npm run harness:check): the real view, History and renderer. A cell is drawn in ink (shape strokes) and a picture is placed below it. With the
 * drawing selected the sheet offers *Add numbered marker*; each use puts the next numbered circle on it and its line in a legend under it, in ONE
 * undo step, and leaves the new marker selected (so the next use joins the same figure without selecting it again). After a marker is deleted, the
 * selected markers of that figure offer *Renumber markers*, which closes the gap and updates the legend (the typed descriptions stay with their
 * markers) in ONE undo step. A picture gets its own set, a locked page refuses, markers of two figures at once are refused. `figmarkersShot` leaves
 * the figure with its markers and legend (and one marker selected) for the screenshots (dist/shots/design/figmarkers-<state>-<theme>-<device>.png).
 */
import { markerSets, parseMarkerGroup } from "../../src/ink/figure-markers";
import { ellipsePoints } from "../../src/ink/shapes";
import { AddAsset, AddElement, AddStroke, Batch, RemoveElement, removeStrokes, ReplaceElement } from "../../src/model/history";
import { RENDER_FREEHAND, type ImageElement, type Page, type PageElement, type Stroke, type TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface FigmarkersCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface MarkersView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	clearSelection(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const pageOf = (v: MarkersView): Page => v.document.pages[v.currentPage()]!;

const FIG = "fmfig";
const shape = (id: string, cx: number, cy: number, rx: number, ry: number, color = "#1f2933", width = 2): Stroke =>
	({ id: `${FIG}-${id}`, tool: "shape", color, width, render: RENDER_FREEHAND, points: ellipsePoints([cx, cy], rx, ry) });

/** The drawing of a cell: the wall, the nucleus and a vacuole. */
function cellStrokes(): Stroke[] {
	return [shape("wall", 300, 230, 170, 110), shape("nucleus", 260, 220, 42, 36, "#3a5a98"), shape("vacuole", 360, 270, 36, 24, "#2f7d5b")];
}

const picture = (): ImageElement => ({ id: "fm-picture-1", type: "image", asset: "fm-missing", x: 100, y: 430, width: 320, height: 200, rotation: 0 });

/** Empties the page and draws the cell and the picture. */
async function prepare(api: FigmarkersCheckApi): Promise<Stroke[]> {
	const v = api.view as MarkersView;
	v.clearSelection();
	const page = pageOf(v);
	const clear = removeStrokes(page.id, page.strokes, page.strokes, "Clear");
	const commands = [...(clear ? [clear] : []), ...(page.elements ?? []).map((e) => new RemoveElement(page.id, e))];
	if (commands.length > 0) v.history.execute(new Batch("Clear", commands));
	const strokes = cellStrokes();
	v.history.execute(new Batch("Draw figure", [new AddAsset({ id: "fm-missing", kind: "image", path: "Notebooks/_assets/fm-missing.png", name: "fm-missing.png", bytes: 0 }), ...strokes.map((s, i) => new AddStroke(page.id, s, i)), new AddElement(page.id, picture(), 0)]));
	v.renderer.invalidate();
	await api.frames(3);
	return strokes;
}

const marks = (v: MarkersView, set?: string) => [...markerSets(pageOf(v)).values()].filter((s) => set === undefined || s.set === set);

export async function checkFigmarkers(api: FigmarkersCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as MarkersView;
	const { frames } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sel = (): { markers?: { kind: string; stale: boolean } | null } => (v.uiContext() as unknown as { selection?: { markers?: { kind: string; stale: boolean } | null } | null }).selection ?? {};
	const numbers = (set: string): number[] => (marks(v, set)[0]?.markers ?? []).map((m) => m.number);
	const legendOf = (set: string): string => marks(v, set)[0]?.legend?.text.text ?? "";

	const drawing = await prepare(api);
	add("nothing is selected: neither action is offered", sel().markers === undefined || sel().markers === null);
	v.selectItems(v.currentPage(), drawing, []);
	await frames(2);
	add("a selected drawing offers Add numbered marker", sel().markers?.kind === "region", JSON.stringify(sel().markers));

	// --- adding ---
	const base = pageOf(v).strokes.length;
	api.notices.length = 0;
	v.runAction("figure-marker-add");
	await frames(3);
	const sets1 = marks(v);
	add("the first use puts marker 1 on the drawing and a legend under it", sets1.length === 1 && sets1[0]!.markers.length === 1 && sets1[0]!.markers[0]!.number === 1 && sets1[0]!.legend?.text.text === "1.", JSON.stringify(sets1.map((s) => ({ n: s.markers.length, l: s.legend?.text.text }))));
	const set = sets1[0]!.set;
	const m1 = sets1[0]!.markers[0]!;
	add("the marker is a tinted ring and its number, one group; the legend a rule and a text box, one group", m1.circle.tool === "shape" && m1.circle.fillTint === true && m1.text.group === m1.group && parseMarkerGroup(m1.group)?.role === "m" && parseMarkerGroup(sets1[0]!.legend!.group)?.role === "l" && sets1[0]!.legend!.rule !== null);
	add("it is one step: 2 strokes and 2 text boxes came in", pageOf(v).strokes.length === base + 2);
	add("the new marker is selected, so the next use joins the same figure", sel().markers?.kind === "set");
	v.undo();
	await frames(2);
	add("one undo takes the marker and the legend away", marks(v).length === 0 && pageOf(v).strokes.length === base);
	v.redo();
	await frames(2);
	// undo and redo clear the selection: select the marker again, as a person would
	v.selectItems(v.currentPage(), [marks(v, set)[0]!.markers[0]!.circle], [marks(v, set)[0]!.markers[0]!.text]);
	await frames(2);
	add("one redo brings them back", numbers(set).join() === "1" && legendOf(set) === "1.");
	v.runAction("figure-marker-add");
	await frames(3);
	v.runAction("figure-marker-add");
	await frames(3);
	add("the next uses number 2 and 3 on the same figure", marks(v).length === 1 && numbers(set).join() === "1,2,3" && legendOf(set) === "1.\n2.\n3.", `${numbers(set).join()} | ${JSON.stringify(legendOf(set))}`);
	add("a notice says what was done", api.notices.some((n) => /Marker \d added/.test(n)), api.notices.join(" | "));

	// --- typed descriptions, then a deletion ---
	const legend = marks(v, set)[0]!.legend!;
	v.history.execute(new ReplaceElement(pageOf(v).id, legend.text, { ...legend.text, text: "1. Cell wall\n2. Nucleus\n3. Vacuole" }));
	const two = marks(v, set)[0]!.markers[1]!;
	v.history.execute(new Batch("Delete marker", [removeStrokes(pageOf(v).id, pageOf(v).strokes, [two.circle], "Delete marker")!, new RemoveElement(pageOf(v).id, two.text)]));
	v.renderer.invalidate();
	await frames(2);
	add("deleting a marker leaves a gap", numbers(set).join() === "1,3");
	const three = marks(v, set)[0]!.markers[1]!;
	v.selectItems(v.currentPage(), [three.circle], [three.text]);
	await frames(2);
	add("the selected markers offer Renumber, and say the figure is out of order", sel().markers?.kind === "set" && sel().markers?.stale === true);
	api.notices.length = 0;
	v.runAction("figure-markers-renumber");
	await frames(3);
	add("Renumber closes the gap and the legend follows, descriptions kept", numbers(set).join() === "1,2" && legendOf(set) === "1. Cell wall\n2. Vacuole", `${numbers(set).join()} | ${JSON.stringify(legendOf(set))}`);
	add("it says so, and the figure is in order", api.notices.some((x) => /renumbered/.test(x)) && sel().markers?.stale === false, api.notices.join(" | "));
	v.undo();
	await frames(2);
	add("one undo puts the old numbers and legend back", numbers(set).join() === "1,3" && legendOf(set) === "1. Cell wall\n2. Nucleus\n3. Vacuole");
	v.redo();
	await frames(2);
	v.selectItems(v.currentPage(), [marks(v, set)[0]!.markers[0]!.circle], [marks(v, set)[0]!.markers[0]!.text]);
	await frames(2);
	api.notices.length = 0;
	v.runAction("figure-markers-renumber");
	await frames(2);
	add("renumbering again changes nothing and says so", numbers(set).join() === "1,2" && api.notices.some((x) => /already numbered/.test(x)), api.notices.join(" | "));

	// --- a picture ---
	const pic = (pageOf(v).elements ?? []).find((e) => e.id === "fm-picture-1")!;
	v.selectItems(v.currentPage(), [], [pic]);
	await frames(2);
	add("a selected picture offers Add numbered marker as a figure", sel().markers?.kind === "figure");
	v.runAction("figure-marker-add");
	await frames(3);
	const ps = marks(v, "fm-picture-1")[0];
	add("a picture has its own set, named by the picture, with its own legend", marks(v).length === 2 && ps?.markers.length === 1 && ps.legend?.text.text === "1." && numbers(set).join() === "1,2");
	add("the marker lies on the picture and its legend under it", !!ps && ps.markers[0]!.cy > 430 && ps.markers[0]!.cy < 630 && ps.legend!.text.y > 630);

	// --- refusals ---
	const m = marks(v, set)[0]!.markers[0]!;
	const pm = ps!.markers[0]!;
	v.selectItems(v.currentPage(), [m.circle, pm.circle], [m.text, pm.text]);
	await frames(2);
	const count = pageOf(v).strokes.length;
	api.notices.length = 0;
	v.runAction("figure-marker-add");
	await frames(2);
	add("markers of two figures at once are refused with a notice", pageOf(v).strokes.length === count && api.notices.some((x) => /more than one figure/.test(x)), api.notices.join(" | "));
	v.selectItems(v.currentPage(), drawing, []);
	await frames(2);
	pageOf(v).locked = true;
	v.runAction("figure-marker-add");
	await frames(2);
	add("a locked page refuses", pageOf(v).strokes.length === count);
	delete pageOf(v).locked;
	v.clearSelection();
	await frames(2);
	add("with nothing selected neither action is offered", sel().markers === undefined || sel().markers === null);
	const text = (pageOf(v).elements ?? []).filter((e): e is TextElement => e.type === "text");
	add("the page is still a valid, savable document", text.length > 0 && v.session.doc === v.document);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: pageOf(v).strokes.length } };
}

/** Leaves the cell with three markers and a described legend (`figure`), or with one marker selected (`selected`), for the screenshot. */
export async function figmarkersShot(api: FigmarkersCheckApi, state: "figure" | "selected"): Promise<void> {
	await api.open("figmarkers");
	const v = api.view as MarkersView;
	const drawing = await prepare(api);
	v.selectItems(v.currentPage(), drawing, []);
	await api.frames(2);
	for (let i = 0; i < 3; i++) {
		v.runAction("figure-marker-add");
		await api.frames(3);
	}
	const set = marks(v)[0]!;
	v.history.execute(new ReplaceElement(pageOf(v).id, set.legend!.text, { ...set.legend!.text, text: "1. Cell wall\n2. Nucleus\n3. Vacuole" }));
	// spread the three markers over the parts they name (moved as a drag would: a new position of the circle and of the number)
	const spots: Array<[number, number]> = [[190, 190], [262, 222], [362, 270]];
	set.markers.forEach((m, i) => {
		const [x, y] = spots[i]!;
		const dx = x - m.cx;
		const dy = y - m.cy;
		const moved: Stroke = { ...m.circle, points: m.circle.points.map(([px, py, p]) => [Math.round((px + dx) * 100) / 100, Math.round((py + dy) * 100) / 100, p]) };
		v.history.execute(new Batch("Move marker", [new RemoveElement(pageOf(v).id, m.text), removeStrokes(pageOf(v).id, pageOf(v).strokes, [m.circle], "Move marker")!, new AddStroke(pageOf(v).id, moved, pageOf(v).strokes.length), new AddElement(pageOf(v).id, { ...m.text, x: Math.round((m.text.x + dx) * 100) / 100, y: Math.round((m.text.y + dy) * 100) / 100 }, (pageOf(v).elements ?? []).length)]));
	});
	v.renderer.invalidate();
	v.clearSelection();
	await api.frames(3);
	if (state === "selected") {
		const m = marks(v)[0]!.markers[1]!;
		v.selectItems(v.currentPage(), [m.circle], [m.text]);
		await api.frames(3);
	}
	await sleep(100);
	if (marks(v)[0]?.markers.length !== 3) throw new Error(`expected 3 markers, found ${marks(v)[0]?.markers.length ?? 0}`);
}
