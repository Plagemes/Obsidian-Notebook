import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, type UiContext } from "../src/ui/actions";
import { adaptBoost, MAX_PINNED, NO_ADAPT, normalisePinned, pageVariant, selectionVariant, suggestedTools, togglePinned, type LayoutAdapt } from "../src/ui/adapt";
import { buildLayout, contextBar, ranked } from "../src/ui/layout";
import { PAGE_KINDS, pageKindOf, SLIDE_MIN_RATIO, type PageKind } from "../src/ui/page-kind";
import { mixFromCounts, selectionKindOf } from "../src/ui/selection-kind";
import { recordUse, type UsageMap } from "../src/ui/usage";
import {
	clearStoredUsage, effectiveUsage, loadDeviceUsage, loadNotebookUsage, MAX_ACTIONS_PER_NOTEBOOK, MAX_NOTEBOOKS, MIN_NOTEBOOK_USES, normaliseNotebookUsage,
	NOTEBOOK_USAGE_KEY, recordNotebookUse, recordStoredUse, totalUses, usageGeneration, type LocalStore, type NotebookUsage,
} from "../src/ui/usage-store";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";

const NOW = 1_800_000_000_000;
const ON: LayoutAdapt = { pageType: true, selection: true, pinned: [] };

function page(kind: PageKind, background: "none" | "pdf" | "image" = "none"): Partial<UiContext> {
	return { page: { index: 0, count: 3, background, infinite: false, bookmarked: false, kind }, notebook: { pdfPages: background === "pdf", backgrounds: background !== "none" } };
}

describe("page kind (392)", () => {
	it("tells slides, PDF pages, image pages, ruled, grid and plain paper apart", () => {
		expect(pageKindOf({ background: "pdf", paper: "blank", width: 960, height: 540 })).toBe("slide");
		expect(pageKindOf({ background: "pdf", paper: "blank", width: 595, height: 842 })).toBe("pdf");
		expect(pageKindOf({ background: "pdf", paper: "blank", width: 100 * SLIDE_MIN_RATIO, height: 100 })).toBe("slide");
		expect(pageKindOf({ background: "pdf", paper: "blank", width: 100 * SLIDE_MIN_RATIO - 1, height: 100 })).toBe("pdf");
		expect(pageKindOf({ background: "image", paper: "ruled", width: 595, height: 842 })).toBe("image");
		expect(pageKindOf({ background: "none", paper: "ruled", width: 595, height: 842 })).toBe("ruled");
		expect(pageKindOf({ background: "none", paper: "cornell", width: 595, height: 842 })).toBe("ruled");
		for (const paper of ["grid", "dotted", "millimetre", "isometric", "hexagonal"] as const) expect(pageKindOf({ background: "none", paper, width: 595, height: 842 })).toBe("grid");
		for (const paper of ["blank", "music", "planner-day"] as const) expect(pageKindOf({ background: "none", paper, width: 595, height: 842 })).toBe("plain");
		expect(pageKindOf({ background: "pdf", paper: "blank", width: 100, height: 0 })).toBe("pdf");
	});
	it("only ever returns a known kind", () => {
		for (const paper of ["blank", "ruled", "grid", "music"] as const)
			for (const background of ["none", "pdf", "image"] as const) expect(PAGE_KINDS).toContain(pageKindOf({ background, paper, width: 800, height: 600 }));
	});
});

describe("toolbar by page type (392)", () => {
	it("puts the snapping highlighter, search and margins first on a slide, and says Slide", () => {
		const c = baseContext(page("slide", "pdf"));
		const off = contextBar(c, 1000, {}, NOW)!;
		const on = contextBar(c, 1000, {}, NOW, undefined, undefined, ON)!;
		expect(on.actions.slice(0, 3).sort()).toEqual(["pdf-margins", "pdf-search", "toggle-snap-highlighter"]);
		expect(on.variant).toBe("slide");
		expect(off.variant).toBeUndefined();
		expect(off.actions[0]).toBe("pdf-search");
		expect(off.actions.indexOf("pdf-margins")).toBeGreaterThan(on.actions.indexOf("pdf-margins"));
	});
	it("keeps the PDF page of a document without the slide label and the margins boost", () => {
		const c = baseContext(page("pdf", "pdf"));
		const on = contextBar(c, 1000, {}, NOW, undefined, undefined, ON)!;
		expect(on.variant).toBeUndefined();
		expect(on.actions.slice(0, 2)).toEqual(["pdf-search", "toggle-snap-highlighter"]);
	});
	it("marks pen and text on ruled paper, shapes on grid, the highlighter on slides; nothing on plain pages", () => {
		expect(suggestedTools(baseContext(page("ruled")), ON)).toEqual(["pen", "text"]);
		expect(suggestedTools(baseContext(page("grid")), ON)).toEqual(["shape"]);
		expect(suggestedTools(baseContext(page("slide", "pdf")), ON)).toEqual(["highlighter"]);
		expect(suggestedTools(baseContext(page("plain")), ON)).toEqual([]);
		expect(suggestedTools(baseContext(), ON)).toEqual([]);
	});
	it("ranks the ruler first among the quick actions of a grid page", () => {
		const grid = buildLayout(baseContext(page("grid")), 1280, {}, NOW, undefined, undefined, ON);
		expect(grid.quick[0]).toBe("toggle-ruler");
		expect(grid.suggested).toEqual(["shape"]);
		const plain = buildLayout(baseContext(page("plain")), 1280, {}, NOW, undefined, undefined, ON);
		expect(plain.quick[0]).not.toBe("toggle-ruler");
	});
	it("changes nothing when its switch is off, and is deterministic", () => {
		const c = baseContext(page("grid"));
		const base = buildLayout(c, 1280, {}, NOW);
		const off = buildLayout(c, 1280, {}, NOW, undefined, undefined, { ...ON, pageType: false });
		expect(off).toEqual(base);
		expect(off.suggested).toEqual([]);
		expect(buildLayout(c, 1280, {}, NOW, undefined, undefined, ON)).toEqual(buildLayout(c, 1280, {}, NOW, undefined, undefined, ON));
		expect(pageVariant(baseContext(page("slide", "pdf")), { pageType: false })).toBeNull();
	});
});

describe("selection bar by content type (402)", () => {
	const sel = (s: Partial<NonNullable<UiContext["selection"]>>): UiContext => baseContext({
		tool: "lasso", selection: { strokes: 0, elements: 0, images: 0, texts: 0, ...s },
	});
	it("classifies a selection", () => {
		expect(selectionKindOf({ strokes: 3, images: 0, texts: 0, others: 0 })).toBe("ink");
		expect(selectionKindOf({ strokes: 0, images: 2, texts: 0, others: 0 })).toBe("image");
		expect(selectionKindOf({ strokes: 0, images: 0, texts: 1, others: 0 })).toBe("text");
		expect(selectionKindOf({ strokes: 1, images: 1, texts: 0, others: 0 })).toBe("mixed");
		expect(selectionKindOf({ strokes: 0, images: 1, texts: 1, others: 0 })).toBe("mixed");
		expect(selectionKindOf({ strokes: 0, images: 0, texts: 0, others: 2 })).toBe("object");
		expect(selectionKindOf({ strokes: 0, images: 0, texts: 0, others: 0 })).toBeNull();
		expect(mixFromCounts({ strokes: 0, elements: 3, images: 1, texts: 1 })).toEqual({ strokes: 0, images: 1, texts: 1, others: 1 });
	});
	it("shows each kind's own actions first", () => {
		const ink = contextBar(sel({ strokes: 4 }), 600, {}, NOW, undefined, undefined, ON)!;
		const image = contextBar(sel({ elements: 1, images: 1 }), 600, {}, NOW, undefined, undefined, ON)!;
		const text = contextBar(sel({ elements: 1, texts: 1 }), 600, {}, NOW, undefined, undefined, ON)!;
		const mixed = contextBar(sel({ strokes: 2, elements: 1, images: 1 }), 600, {}, NOW, undefined, undefined, ON)!;
		expect([ink.variant, image.variant, text.variant, mixed.variant]).toEqual(["ink", "image", "text", "mixed"]);
		expect(ink.actions.slice(0, 4)).toContain("stamps-save-selection");
		expect(ink.actions).not.toContain("layer-front");
		expect(ink.second).toContain("selection-similar");
		expect(image.actions.slice(0, 3)).toContain("selection-white-transparent");
		expect(image.actions.slice(0, 5)).toContain("layer-front");
		expect(text.actions.slice(0, 3)).toContain("link-selection");
		expect(text.actions).not.toContain("stamps-save-selection");
		expect(mixed.second?.[0]).toBe("selection-align-menu");
		expect(mixed.actions.slice(0, 5)).toContain("layer-front");
	});
	it("is the designed order when its switch is off", () => {
		const c = sel({ strokes: 4 });
		const off = contextBar(c, 600, {}, NOW, undefined, undefined, { ...ON, selection: false })!;
		expect(off).toEqual(contextBar(c, 600, {}, NOW)!);
		expect(off.variant).toBeUndefined();
		expect(selectionVariant(c, { selection: false })).toBeNull();
	});
	it("only reorders: the same actions stay relevant, and the bar never shows more than its capacity", () => {
		const c = sel({ elements: 1, images: 1 });
		const ids = (adapt: LayoutAdapt) => ranked("context", c, {}, NOW, undefined, adapt).map((a) => a.id).sort();
		expect(ids(ON)).toEqual(ids(NO_ADAPT));
		expect(contextBar(c, 1400, {}, NOW, undefined, undefined, ON)!.actions).toHaveLength(contextBar(c, 1400, {}, NOW)!.actions.length);
	});
});

describe("pinned quick slots (393)", () => {
	it("keeps only actions that can be quick slots, once each, at most three", () => {
		expect(normalisePinned(["fit-width", "tool-pen", "fit-width", 4, "add-page-suggest", "insert-image", "stamps"])).toEqual(["fit-width", "add-page-suggest", "insert-image"]);
		expect(normalisePinned("x")).toEqual([]);
		expect(MAX_PINNED).toBe(3);
	});
	it("toggles, refuses a fourth, and ignores unknown ids", () => {
		let p: string[] = [];
		p = togglePinned(p, "fit-width");
		p = togglePinned(p, "add-page-suggest");
		p = togglePinned(p, "stamps");
		expect(p).toEqual(["fit-width", "add-page-suggest", "stamps"]);
		expect(togglePinned(p, "insert-image")).toEqual(p);
		expect(togglePinned(p, "add-page-suggest")).toEqual(["fit-width", "stamps"]);
		expect(togglePinned([], "tool-pen")).toEqual([]);
	});
	it("puts pinned actions first, in the order chosen, whatever the ranking and the page say", () => {
		let usage: UsageMap = {};
		for (let i = 0; i < 40; i++) usage = recordUse(usage, "insert-image", NOW - 1000);
		const pinned = ["fit-width", "pen-only"];
		const l = buildLayout(baseContext(page("grid")), 1280, usage, NOW, undefined, undefined, { ...ON, pinned });
		expect(l.quick.slice(0, 2)).toEqual(pinned);
		const again = buildLayout(baseContext(page("ruled")), 1280, {}, NOW + 1e9, undefined, undefined, { ...ON, pinned });
		expect(again.quick.slice(0, 2)).toEqual(pinned);
		expect(new Set(l.quick).size).toBe(l.quick.length);
	});
	it("skips a pinned action that does not apply now and brings it back when it does", () => {
		const pinned = ["nav-back"];
		expect(buildLayout(baseContext(), 1280, {}, NOW, undefined, undefined, { ...NO_ADAPT, pinned }).quick).not.toContain("nav-back");
		const withNav = baseContext({ nav: { back: true, forward: false } });
		expect(buildLayout(withNav, 1280, {}, NOW, undefined, undefined, { ...NO_ADAPT, pinned }).quick[0]).toBe("nav-back");
	});
	it("keeps editing actions out of a read-only view even when pinned", () => {
		const ro = baseContext({ editable: false });
		const l = buildLayout(ro, 1280, {}, NOW, undefined, undefined, { ...NO_ADAPT, pinned: ["add-page-suggest", "fit-width"] });
		expect(l.quick).not.toContain("add-page-suggest");
	});
	it("is saved in the settings, cleaned on load", () => {
		expect(DEFAULT_SETTINGS.pinnedQuick).toEqual([]);
		expect(readSettings({ pinnedQuick: ["fit-width", "tool-pen", 3] }).pinnedQuick).toEqual(["fit-width"]);
		expect(readSettings({}).adaptLearn).toBe(true);
		expect(readSettings({ adaptLearn: false, adaptPageType: false, adaptSelection: false })).toMatchObject({ adaptLearn: false, adaptPageType: false, adaptSelection: false });
	});
});

describe("usage per notebook (393)", () => {
	function fakeStore(initial: Record<string, unknown> = {}): LocalStore & { data: Record<string, unknown> } {
		const data = { ...initial };
		return { data, loadLocalStorage: (k) => data[k] ?? null, saveLocalStorage: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
	}
	it("counts each notebook on its own and bounds the store", () => {
		let store: NotebookUsage = {};
		for (let i = 0; i < 5; i++) store = recordNotebookUse(store, "nb-a", "fit-width", NOW + i);
		store = recordNotebookUse(store, "nb-b", "add-page-suggest", NOW);
		expect(totalUses(store["nb-a"])).toBe(5);
		expect(totalUses(store["nb-b"])).toBe(1);
		expect(recordNotebookUse(store, "bad id/..", "x", NOW)).toBe(store);
		let big: NotebookUsage = {};
		for (let i = 0; i < MAX_NOTEBOOKS + 20; i++) big = recordNotebookUse(big, `nb-${i}`, "fit-width", NOW + i);
		expect(Object.keys(big)).toHaveLength(MAX_NOTEBOOKS);
		expect(Object.keys(big)).toContain(`nb-${MAX_NOTEBOOKS + 19}`);
		expect(Object.keys(big)).not.toContain("nb-0");
		const many: Record<string, { n: number; last: number }> = {};
		for (let i = 0; i < 300; i++) many[`action-${i}`] = { n: 1, last: i + 1 };
		expect(Object.keys(normaliseNotebookUsage({ "nb-x": many })["nb-x"]!)).toHaveLength(MAX_ACTIONS_PER_NOTEBOOK);
	});
	it("drops garbage from storage", () => {
		expect(normaliseNotebookUsage("x")).toEqual({});
		expect(normaliseNotebookUsage([1])).toEqual({});
		expect(normaliseNotebookUsage({ "../evil": { a: { n: 1, last: 1 } }, ok: { "fit-width": { n: "2", last: 1 } }, empty: {} })).toEqual({});
	});
	it("ranks by the notebook once it has history, by the device before, and not at all when learning is off", () => {
		const device = recordUse({}, "fit-width", NOW);
		let store: NotebookUsage = {};
		for (let i = 0; i < MIN_NOTEBOOK_USES - 1; i++) store = recordNotebookUse(store, "nb-a", "add-page-suggest", NOW);
		expect(effectiveUsage(device, store, "nb-a", true)).toBe(device);
		store = recordNotebookUse(store, "nb-a", "add-page-suggest", NOW);
		expect(effectiveUsage(device, store, "nb-a", true)).toBe(store["nb-a"]);
		expect(effectiveUsage(device, store, "nb-other", true)).toBe(device);
		expect(effectiveUsage(device, store, null, true)).toBe(device);
		expect(effectiveUsage(device, store, "nb-a", false)).toEqual({});
	});
	it("gives different notebooks different quick slots", () => {
		let store: NotebookUsage = {};
		for (let i = 0; i < 12; i++) {
			store = recordNotebookUse(store, "nb-a", "fit-width", NOW - 1000);
			store = recordNotebookUse(store, "nb-b", "pen-only", NOW - 1000);
		}
		const slots = (id: string) => buildLayout(baseContext(), 800, effectiveUsage({}, store, id, true), NOW).quick;
		expect(slots("nb-a")).toContain("fit-width");
		expect(slots("nb-a")).not.toContain("pen-only");
		expect(slots("nb-b")).toContain("pen-only");
	});
	it("writes both maps to local storage, re-reading it first, and forgets everything on reset", () => {
		const app = fakeStore();
		recordStoredUse(app, "fit-width", "nb-a", true, NOW);
		const r = recordStoredUse(app, "fit-width", "nb-a", true, NOW + 1);
		expect(r.device["fit-width"]?.n).toBe(2);
		expect(loadNotebookUsage(app)["nb-a"]?.["fit-width"]?.n).toBe(2);
		recordStoredUse(app, "add-page-suggest", "nb-a", false, NOW);
		expect(loadNotebookUsage(app)["nb-a"]?.["add-page-suggest"]).toBeUndefined();
		expect(loadDeviceUsage(app)["add-page-suggest"]?.n).toBe(1);
		const gen = usageGeneration();
		clearStoredUsage(app);
		expect(usageGeneration()).toBe(gen + 1);
		expect(loadDeviceUsage(app)).toEqual({});
		expect(app.data[NOTEBOOK_USAGE_KEY]).toEqual({});
	});
	it("survives a storage that throws", () => {
		const bad: LocalStore = { loadLocalStorage: () => { throw new Error("no"); }, saveLocalStorage: () => { throw new Error("no"); } };
		expect(loadDeviceUsage(bad)).toEqual({});
		expect(() => recordStoredUse(bad, "fit-width", "nb-a", true, NOW)).not.toThrow();
	});
});

describe("texts of the generative interface", () => {
	it("has an English and an Italian string for every label it can show", () => {
		const keys = ["ui.context.selection.ink", "ui.context.selection.image", "ui.context.selection.text", "ui.context.selection.mixed", "ui.context.pdf.slide",
			"ui.pin.pin", "ui.pin.unpin", "ui.pin.full", "command.snapHighlighter", "settings.adaptPageType", "settings.adaptLearn", "settings.adaptSelection", "settings.toolbarReset"] as const;
		for (const k of keys) {
			expect(en[k], k).toBeTruthy();
			expect(itMessages[k], k).toBeTruthy();
		}
	});
	it("registers the snap toggle for PDF pages only", () => {
		const a = ACTIONS.find((x) => x.id === "toggle-snap-highlighter")!;
		expect(a.contexts).toEqual(["pdf"]);
		expect(a.when?.(baseContext())).toBe(false);
		expect(a.when?.(baseContext({ notebook: { pdfPages: true, backgrounds: true } }))).toBe(true);
		expect(a.checked?.(baseContext({ reading: { annotationsHidden: false, dim: false, snap: true } }))).toBe(true);
		expect(adaptBoost(a, baseContext(), ON)).toBe(0);
	});
});
