/**
 * Smoke check of the timeline element (0.30, roadmap #148) on the `doc=timeline` notebook (the blank "New" notebook; HARNESS_DOC=timeline npm
 * run harness:check): the real view. "Timeline" in the insert sheet opens the dialog (title, events as lines of text, colours, size, a picture
 * of the timeline and what was read, with the lines it does not understand); inserting draws shape strokes and text boxes of ONE group in ONE
 * undo step and selects it; with it selected "Edit timeline" opens the dialog again with what the timeline says, redraws it in place in ONE undo
 * step, says so when nothing changed, and is refused on a locked page. `timelineShot` leaves the dialog / the edit dialog / the timeline for the
 * screenshots (dist/shots/design/timeline-<state>-<theme>-<device>.png).
 */
import { parseTimelineGroup } from "../../src/ink/timeline";
import { AddElement, Batch, RemoveElement, removeStrokes } from "../../src/model/history";
import type { Page, PageElement, Stroke, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface TimelineCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TimelineView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	clearSelection(): void;
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const SAMPLE = "753 BC: Rome founded\n44 BC: Caesar killed\n5th century: Fall of Rome\n1492: Columbus\n1914-1918: Great War";

async function waitFor(sel: string): Promise<HTMLElement | null> {
	for (let i = 0; i < 40 && !q(sel); i++) await sleep(50);
	const all = document.querySelectorAll<HTMLElement>(sel);
	return all[all.length - 1] ?? null;
}

/** Closes every dialog that is open (one left by an earlier screenshot belongs to a view that is gone). */
async function closeDialogs(api: TimelineCheckApi): Promise<void> {
	for (const b of Array.from(document.querySelectorAll<HTMLElement>(".nb-modal-close"))) b.click();
	await api.frames(2);
}

const press = async (api: TimelineCheckApi, el: Element | null | undefined): Promise<void> => {
	(el as HTMLElement | null)?.click();
	await api.frames(3);
};

const pageOf = (v: TimelineView): Page => v.document.pages[v.currentPage()]!;

const isTimeline = (group: string | undefined): boolean => parseTimelineGroup(group) !== null;

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Removes everything from the page (a notebook that was opened again may hold what an earlier run left). */
async function clearPage(api: TimelineCheckApi): Promise<void> {
	const v = api.view as TimelineView;
	const page = pageOf(v);
	const clear = removeStrokes(page.id, page.strokes, page.strokes, "Clear");
	const commands = [...(clear ? [clear] : []), ...(page.elements ?? []).map((e) => new RemoveElement(page.id, e))];
	if (commands.length > 0) v.history.execute(new Batch("Clear", commands));
	v.renderer.invalidate();
	v.clearSelection();
	await api.frames(2);
}

/** Opens the insert dialog, types a title and events, and presses Insert; returns the dialog's picture and notes before pressing. */
async function insertTimeline(api: TimelineCheckApi, title: string, text: string): Promise<void> {
	const v = api.view as TimelineView;
	await closeDialogs(api);
	v.clearSelection();
	await api.frames(2);
	v.runAction("insert-timeline");
	const dlg = await waitFor(".nb-timeline-dialog");
	if (!dlg) throw new Error("the timeline dialog did not open");
	setValue(dlg.querySelector<HTMLInputElement>("#nb-timeline-title")!, title);
	setValue(dlg.querySelector<HTMLTextAreaElement>("#nb-timeline-events")!, text);
	await api.frames(2);
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await api.frames(4);
}

export async function checkTimeline(api: TimelineCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as TimelineView;
	const { frames } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sel = (): { timeline?: boolean } => (v.uiContext() as unknown as { selection?: { timeline?: boolean } | null }).selection ?? {};
	const strokes = (): Stroke[] => pageOf(v).strokes.filter((s) => isTimeline(s.group));
	const texts = (): TextElement[] => (pageOf(v).elements ?? []).filter((e): e is TextElement => e.type === "text" && isTimeline(e.group));
	const labelsOf = (): string[] => texts().filter((e) => e.fontSize === 10).map((e) => e.text);
	const points = (): string => JSON.stringify(strokes().map((s) => s.points));
	const selectTimeline = (): void => {
		const page = pageOf(v);
		const group = [...page.strokes].reverse().find((s) => isTimeline(s.group))?.group;
		v.selectItems(v.currentPage(), page.strokes.filter((s) => s.group === group), (page.elements ?? []).filter((e) => e.group === group));
	};

	await closeDialogs(api);
	await clearPage(api);
	add("with nothing selected Edit timeline is not offered", sel().timeline !== true);
	const base = pageOf(v).strokes.length;

	// --- the dialog ---
	v.runAction("insert-timeline");
	const dlg = await waitFor(".nb-timeline-dialog");
	add("Timeline opens the dialog", !!dlg);
	if (!dlg) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	add("it asks a title, the events, a colour and a size", !!dlg.querySelector("#nb-timeline-title") && !!dlg.querySelector("textarea#nb-timeline-events") && dlg.querySelectorAll(".nb-timeline-swatch").length === 8 && dlg.querySelectorAll(".nb-timeline-seg button").length === 3);
	const insertButton = dlg.querySelector<HTMLButtonElement>(".nb-modal-foot .mod-cta")!;
	add("with no events Insert is disabled and says what to type", insertButton.disabled && /date/i.test(dlg.querySelector(".nb-timeline-notes")?.textContent ?? ""), dlg.querySelector(".nb-timeline-notes")?.textContent ?? "");
	const area = dlg.querySelector<HTMLTextAreaElement>("#nb-timeline-events")!;
	setValue(area, `${SAMPLE}\nsomething with no date`);
	await frames(2);
	add("it shows a picture with one dot per event", dlg.querySelectorAll(".nb-timeline-preview-svg circle").length === 5, String(dlg.querySelectorAll(".nb-timeline-preview-svg circle").length));
	add("it says what was read and which line it left out", /5/.test(dlg.querySelector(".nb-timeline-notes")?.textContent ?? "") && /6/.test(dlg.querySelector(".nb-timeline-notes")?.textContent ?? ""), dlg.querySelector(".nb-timeline-notes")?.textContent ?? "");
	add("Insert is enabled", !insertButton.disabled);
	const dotsBefore = dlg.querySelectorAll(".nb-timeline-preview-svg circle").length;
	setValue(area, `${SAMPLE}\n1969: Moon landing`);
	await frames(2);
	add("the picture follows the text", dlg.querySelectorAll(".nb-timeline-preview-svg circle").length === dotsBefore + 1);
	setValue(dlg.querySelector<HTMLInputElement>("#nb-timeline-title")!, "History");
	await frames(2);
	add("the title shows in the picture", Array.from(dlg.querySelectorAll(".nb-timeline-preview-svg text")).some((tx) => tx.textContent === "History"));
	const swatches = dlg.querySelectorAll<HTMLElement>(".nb-timeline-swatch");
	await press(api, swatches[3]);
	add("a colour dot becomes the active one", swatches[3]!.classList.contains("is-active"));
	await press(api, insertButton);
	await sleep(100);
	await frames(4);

	// --- the timeline ---
	const made = strokes();
	const group = made[0]?.group;
	add("inserting draws shape strokes and text boxes of one timeline group", made.length > 12 && new Set(made.map((s) => s.group)).size === 1 && texts().length > 6 && texts().every((e) => e.group === group), `${made.length} strokes, ${texts().length} texts`);
	add("the group id carries the colour", parseTimelineGroup(group)?.colour === 3);
	add("every event is a text box (date, then label)", labelsOf().length === 6 && labelsOf().includes("44 BC\nCaesar killed"), labelsOf().join(" | "));
	add("a tick label says BC for a year before our era", texts().some((e) => e.fontSize === 8 && / BC$/.test(e.text)), texts().filter((e) => e.fontSize === 8).map((e) => e.text).join(","));
	add("the timeline is selected, with Edit timeline offered", sel().timeline === true);
	const inside = made.every((s) => s.points.every((p) => p[0] >= 0 && p[0] <= pageOf(v).width && p[1] >= 0 && p[1] <= pageOf(v).height));
	add("it is inside the page", inside);
	v.undo();
	await frames(2);
	add("one undo removes the whole timeline", strokes().length === 0 && texts().length === 0 && pageOf(v).strokes.length === base);
	v.redo();
	await frames(2);
	add("one redo draws it again", strokes().length === made.length);

	// --- editing ---
	selectTimeline();
	await frames(2);
	api.notices.length = 0;
	const original = points();
	v.runAction("timeline-edit");
	const edit = await waitFor(".nb-timeline-dialog");
	add("Edit timeline opens the dialog with what the timeline says", !!edit && (edit.querySelector<HTMLInputElement>("#nb-timeline-title")?.value === "History") && (edit.querySelector<HTMLTextAreaElement>("#nb-timeline-events")?.value ?? "").split("\n").length === 6, edit?.querySelector<HTMLTextAreaElement>("#nb-timeline-events")?.value ?? "");
	add("its button says Update", /Update|Aggiorna/.test(edit?.querySelector(".nb-modal-foot .mod-cta")?.textContent ?? ""));
	await press(api, edit?.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await frames(3);
	add("updating with nothing changed says so and changes nothing", /already|già/.test(api.notices.join(" ")) && points() === original, api.notices.join(" | "));
	const before = points();
	selectTimeline();
	await frames(2);
	v.runAction("timeline-edit");
	const edit2 = await waitFor(".nb-timeline-dialog");
	if (edit2) {
		const text = edit2.querySelector<HTMLTextAreaElement>("#nb-timeline-events")!;
		setValue(text, `${text.value}\n1066: Hastings`);
		await frames(2);
		await press(api, edit2.querySelector(".nb-modal-foot .mod-cta"));
	}
	await sleep(100);
	await frames(4);
	add("after a change the timeline is redrawn with the new event", labelsOf().length === 7 && labelsOf().some((l) => l.startsWith("1066")), labelsOf().length.toString());
	add("it keeps its place", JSON.stringify(strokes()[0]?.points[0]) === JSON.stringify(made[0]?.points[0]));
	add("it stays selected", sel().timeline === true);
	v.undo();
	await frames(2);
	add("one undo puts the old timeline back exactly", points() === before && labelsOf().length === 6);
	v.redo();
	await frames(2);
	add("one redo redraws the new one", labelsOf().length === 7);

	// --- locked page: refused ---
	selectTimeline();
	await frames(2);
	const edited = points();
	pageOf(v).locked = true;
	v.runAction("timeline-edit");
	const edit3 = await waitFor(".nb-timeline-dialog");
	if (edit3) {
		setValue(edit3.querySelector<HTMLTextAreaElement>("#nb-timeline-events")!, "1900: only one");
		await frames(2);
		await press(api, edit3.querySelector(".nb-modal-foot .mod-cta"));
	}
	await sleep(100);
	await frames(3);
	add("a locked page refuses an edit", points() === edited);
	delete pageOf(v).locked;
	await closeDialogs(api);

	// --- edited label text is read back ---
	selectTimeline();
	await frames(2);
	const page = pageOf(v);
	const box = (page.elements ?? []).find((e): e is TextElement => e.type === "text" && isTimeline(e.group) && e.text.startsWith("1492"));
	if (box) v.history.execute(new Batch("edit label", [new RemoveElement(page.id, box), new AddElement(page.id, { ...box, text: "1500\nColumbus again" }, (page.elements ?? []).length)]));
	v.renderer.invalidate();
	selectTimeline();
	await frames(2);
	v.runAction("timeline-edit");
	const edit4 = await waitFor(".nb-timeline-dialog");
	add("an edited label shows in the dialog as typed", !!edit4 && (edit4.querySelector<HTMLTextAreaElement>("#nb-timeline-events")?.value ?? "").includes("1500: Columbus again"), edit4?.querySelector<HTMLTextAreaElement>("#nb-timeline-events")?.value ?? "");
	await closeDialogs(api);

	v.clearSelection();
	await frames(2);
	add("with nothing selected Edit timeline is not offered again", sel().timeline !== true);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: pageOf(v).strokes.length } };
}

/** Leaves the harness notebook with the dialog (`dialog`), the dialog of an edit (`edit`) or a timeline (`timeline`) for the screenshot. */
export async function timelineShot(api: TimelineCheckApi, state: "dialog" | "edit" | "timeline"): Promise<void> {
	await closeDialogs(api);
	await api.open("timeline");
	const v = api.view as TimelineView;
	await clearPage(api);
	const frame = async (): Promise<void> => {
		const dlg = await waitFor(".nb-timeline-dialog");
		if (!dlg) throw new Error("the timeline dialog did not open");
		// The stand-in appends the modal at the end of the body; the harness frames it as a centred overlay.
		if (!dlg.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(dlg);
		await api.frames(3);
		if (!dlg.isConnected || dlg.getBoundingClientRect().height < 50) throw new Error(`the timeline dialog is not on screen (${dlg.getBoundingClientRect().height}px)`);
	};
	if (state === "dialog") {
		v.runAction("insert-timeline");
		const dlg = await waitFor(".nb-timeline-dialog");
		if (!dlg) throw new Error("the timeline dialog did not open");
		setValue(dlg.querySelector<HTMLInputElement>("#nb-timeline-title")!, "From Rome to the Moon");
		setValue(dlg.querySelector<HTMLTextAreaElement>("#nb-timeline-events")!, `${SAMPLE}\n1969: Moon landing\nsome words`);
		await api.frames(2);
		await frame();
		return;
	}
	await insertTimeline(api, "From Rome to the Moon", `${SAMPLE}\n1969: Moon landing`);
	const n = pageOf(v).strokes.filter((s) => isTimeline(s.group)).length;
	if (n === 0) throw new Error(`no timeline was drawn (${pageOf(v).strokes.length} strokes, dialog open: ${!!q(".nb-timeline-dialog")}, notes: ${q(".nb-timeline-notes")?.textContent ?? ""})`);
	if (state === "edit") {
		v.runAction("timeline-edit");
		await frame();
		return;
	}
	v.clearSelection();
	await api.frames(3);
}
