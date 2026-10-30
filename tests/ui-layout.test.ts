import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { buildLayout, buildSheet, contextBar, contextCapacity, fold, MAX_QUICK, ranked, RECENT_COUNT, toolbarPlan } from "../src/ui/layout";
import { HALF_LIFE_MS, MAX_BOOST, normaliseUsage, recordUse, usageBoost, type UsageMap } from "../src/ui/usage";
import {
	angleOf, arcAngles, bubbleDot, colourSlot, ERASER_STEPS, formatWidth, nearestStep, paletteFor, PEN_STEPS, polar, ringAngles, stepAtAngle,
	stepDotRadius, widthScale,
} from "../src/ui/radial-model";

const NOW = 1_800_000_000_000;
const label = (a: { id: string }) => a.id.replace(/-/g, " ");

describe("toolbar plan", () => {
	it("uses two rows and no quick slots on a phone", () => {
		expect(toolbarPlan(360)).toEqual({ singleRow: false, quickSlots: 0 });
		expect(toolbarPlan(412).quickSlots).toBe(0);
	});
	it("fits quick slots on a tablet and one row on desktop", () => {
		const tablet = toolbarPlan(800);
		expect(tablet.singleRow).toBe(false);
		expect(tablet.quickSlots).toBeGreaterThanOrEqual(4);
		const desk = toolbarPlan(1280);
		expect(desk.singleRow).toBe(true);
		expect(desk.quickSlots).toBe(MAX_QUICK);
	});
	it("never offers more slots on a narrower view", () => {
		let prev = -1;
		let prevSingle = false;
		for (let w = 300; w <= 2000; w += 10) {
			const p = toolbarPlan(w);
			if (p.singleRow === prevSingle) expect(p.quickSlots).toBeGreaterThanOrEqual(prev);
			prev = p.quickSlots;
			prevSingle = p.singleRow;
		}
	});
});

describe("layout engine", () => {
	it("fills the quick slots by priority on a plain page", () => {
		const l = buildLayout(baseContext(), 1280, {}, NOW);
		expect(l.quick).toEqual(["insert-image", "add-page", "stamps", "board-shot", "toggle-ruler", "toggle-page-mode"]);
		expect(l.context).toBeNull();
	});

	it("moves often-used actions up and keeps the order stable without use", () => {
		let usage: UsageMap = {};
		for (let i = 0; i < 20; i++) usage = recordUse(usage, "fit-width", NOW - 1000);
		const l = buildLayout(baseContext(), 800, usage, NOW);
		// Not in the five slots of a tablet without use; with use it comes second, after the designed first choice.
		expect(buildLayout(baseContext(), 800, {}, NOW).quick).not.toContain("fit-width");
		expect(l.quick.indexOf("fit-width")).toBe(1);
		expect(buildLayout(baseContext(), 800, {}, NOW).quick).toEqual(buildLayout(baseContext(), 800, {}, NOW).quick);
	});

	it("shows the selection bar for a selection, and paste only for the lasso without one", () => {
		const sel = contextBar(baseContext({ tool: "lasso", selection: { strokes: 3, elements: 1, images: 1 } }), 800, {}, NOW)!;
		expect(sel.kind).toBe("selection");
		expect(sel.actions).toContain("selection-copy");
		expect(sel.actions).toContain("selection-white-transparent");
		expect(sel.actions).toContain("delete-selection");
		const lasso = contextBar(baseContext({ tool: "lasso" }), 800, {}, NOW)!;
		// wave 0.10 (362): pasting from another device is offered next to the plain paste.
		// v10: then the excerpt actions (the next drag outlines the region), after the pastes.
		expect(lasso).toEqual({ kind: "lasso", actions: ["selection-paste", "selection-paste-device", "excerpt-to-page", "excerpt-copy"] });
		const noImage = contextBar(baseContext({ tool: "lasso", selection: { strokes: 3, elements: 0, images: 0 } }), 800, {}, NOW)!;
		expect(noImage.actions).not.toContain("selection-white-transparent");
	});

	it("changes the contextual bar with the page and the situation", () => {
		const pdf = baseContext({ page: { index: 0, count: 2, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } });
		expect(contextBar(pdf, 800, {}, NOW)).toEqual({ kind: "pdf", actions: ["pdf-search", "toggle-annotations", "toggle-dim-background", "pdf-side-open", "crop-margins", "pdf-margins"] });
		const side = contextBar({ ...pdf, sidePane: { available: true, open: true } }, 800, {}, NOW)!;
		expect(side.kind).toBe("side-pane");
		expect(side.actions).toEqual(["pdf-side-link", "pdf-side-add-page", "pdf-side-show-slide", "pdf-side-close"]);
		const lecture = contextBar(baseContext({ lecture: true }), 800, {}, NOW)!;
		expect(lecture.kind).toBe("lecture");
		// wave 0.8: the markers and the End of lecture panel follow the class-time tools, as far as the width allows.
		expect(lecture.actions).toEqual(["new-lecture", "board-shot", "exercise-page", "marker-gap", "marker-question", "end-of-lecture", "marker-homework", "marker-important"]);
		expect(contextBar(baseContext(), 800, {}, NOW)).toBeNull();
		expect(contextBar(baseContext({ open: false, lecture: true }), 800, {}, NOW)).toBeNull();
	});

	it("does not repeat a contextual action in the quick slots", () => {
		const l = buildLayout(baseContext({ lecture: true }), 1280, {}, NOW);
		expect(l.context?.actions).toContain("board-shot");
		expect(l.quick).not.toContain("board-shot");
	});

	it("cuts the contextual bar to the width", () => {
		expect(contextCapacity(360)).toBe(5);
		expect(contextCapacity(1280)).toBe(8);
		const sel = contextBar(baseContext({ tool: "lasso", selection: { strokes: 3, elements: 1, images: 1 } }), 300, {}, NOW)!;
		expect(sel.actions.length).toBe(contextCapacity(300));
		expect(sel.actions[0]).toBe("selection-copy");
	});

	it("offers no insert quick actions on a read-only document", () => {
		const l = buildLayout(baseContext({ editable: false }), 1280, {}, NOW);
		expect(l.quick).toEqual(["toggle-page-mode", "pen-only", "fit-width"]);
	});

	it("ranks with a stable order for equal scores", () => {
		const r = ranked("options", baseContext(), {}, NOW).map((a) => a.id);
		expect(r.slice(0, 4)).toEqual(["shape-line", "shape-arrow", "shape-rectangle", "shape-ellipse"]);
	});
});

describe("sheets", () => {
	it("groups the All actions sheet in a fixed order and includes the page actions", () => {
		const s = buildSheet(baseContext(), { kind: "all", usage: {}, now: NOW, label });
		expect(s.map((x) => x.id)).toEqual(["navigate", "insert", "page", "reading", "side", "lecture", "view", "share", "app", "zettel"]);
		expect(s.find((x) => x.id === "page")!.actions.map((a) => a.id)).toContain("page-delete");
	});

	it("adds PDF sections only with PDF pages", () => {
		const pdf = baseContext({ page: { index: 0, count: 2, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } });
		const ids = buildSheet(pdf, { kind: "all", usage: {}, now: NOW, label }).map((x) => x.id);
		expect(ids).toContain("reading");
		expect(ids).toContain("side");
	});

	it("shows recently used actions first, except those visible elsewhere", () => {
		let usage: UsageMap = {};
		for (const id of ["page-duplicate", "page-duplicate", "export-pdf", "insert-image", "page-tags", "scan-into"]) usage = recordUse(usage, id, NOW - 10);
		const s = buildSheet(baseContext(), { kind: "all", usage, now: NOW, label, visible: new Set(["insert-image"]) });
		expect(s[0]!.id).toBe("recent");
		expect(s[0]!.actions[0]!.id).toBe("page-duplicate");
		expect(s[0]!.actions.map((a) => a.id)).not.toContain("insert-image");
		expect(s[0]!.actions.length).toBeLessThanOrEqual(RECENT_COUNT);
	});

	it("limits the page sheet to page actions", () => {
		const s = buildSheet(baseContext(), { kind: "page", usage: {}, now: NOW, label });
		const ids = s.flatMap((x) => x.actions.map((a) => a.id));
		expect(ids).toContain("page-duplicate");
		expect(ids).toContain("insert-blank-page");
		expect(ids).not.toContain("insert-image");
		expect(ids).not.toContain("pen-only");
		expect(s.map((x) => x.id)).not.toContain("recent");
		expect(s.map((x) => x.id).slice(0, 2)).toEqual(["navigate", "page"]);
		expect(ids).toContain("goto-page-number");
		expect(ids).not.toContain("page-split");
		const heavy = buildSheet(baseContext({ page: { index: 0, count: 2, background: "none", infinite: false, bookmarked: false, splittable: true } }), { kind: "page", usage: {}, now: NOW, label });
		expect(heavy.flatMap((x) => x.actions.map((a) => a.id))).toContain("page-split");
	});

	it("searches labels, keywords and groups, ignoring case and accents", () => {
		const search = (query: string) => buildSheet(baseContext(), { kind: "all", usage: {}, now: NOW, query, label: (a) => (a.id === "page-tags" ? "Tag della pàgina" : label(a)) });
		expect(search("PAGINA")[0]!.actions.map((a) => a.id)).toEqual(["page-tags"]);
		expect(search("photo")[0]!.actions.map((a) => a.id)).toContain("insert-image");
		expect(search("zzzz")).toEqual([]);
		expect(fold("  Àbc  Déf ")).toBe("abc def");
	});

	it("hides actions that are not relevant", () => {
		const ids = buildSheet(baseContext(), { kind: "all", usage: {}, now: NOW, label }).flatMap((x) => x.actions.map((a) => a.id));
		expect(ids).not.toContain("pdf-search");
		expect(ids).not.toContain("page-edit-bookmark");
		expect(ACTIONS.filter((a) => a.scope === "external").every((a) => !ids.includes(a.id))).toBe(true);
	});
});

describe("usage", () => {
	it("counts, decays and caps", () => {
		let m: UsageMap = {};
		m = recordUse(m, "add-page", NOW);
		m = recordUse(m, "add-page", NOW + 5);
		expect(m["add-page"]).toEqual({ n: 2, last: NOW + 5 });
		expect(usageBoost(m["add-page"], NOW + 5)).toBeCloseTo(10 * Math.log2(3));
		expect(usageBoost(m["add-page"], NOW + 5 + HALF_LIFE_MS)).toBeCloseTo(5 * Math.log2(3));
		expect(usageBoost({ n: 1e6, last: NOW }, NOW)).toBe(MAX_BOOST);
		expect(usageBoost(undefined, NOW)).toBe(0);
	});
	it("normalises whatever was stored", () => {
		expect(normaliseUsage(null)).toEqual({});
		expect(normaliseUsage([1, 2])).toEqual({});
		expect(normaliseUsage({ "add-page": { n: 3.7, last: 5 }, "Bad Id": { n: 1, last: 1 }, x: "y", zero: { n: 0, last: 1 }, neg: { n: -4, last: 2 } }))
			.toEqual({ "add-page": { n: 3, last: 5 } });
		expect(recordUse({}, "__proto__", NOW)).toEqual({});
		const many: Record<string, unknown> = {};
		for (let i = 0; i < 300; i++) many[`a${i}`] = { n: 1, last: i };
		const kept = normaliseUsage(many);
		expect(Object.keys(kept)).toHaveLength(200);
		expect(kept.a299).toBeDefined();
		expect(kept.a0).toBeUndefined();
	});
});

describe("radial model", () => {
	it("offers twelve colours and the right colour slot per tool", () => {
		expect(paletteFor("pen")).toHaveLength(12);
		expect(paletteFor("highlighter")).toHaveLength(12);
		expect(new Set(paletteFor("pen")).size).toBe(12);
		expect(colourSlot("shape")).toBe("pen");
		expect(colourSlot("highlighter")).toBe("highlighter");
		expect(colourSlot("eraser")).toBeNull();
		expect(colourSlot("lasso")).toBeNull();
	});
	it("maps tools to their size scale", () => {
		expect(widthScale("pen")?.field).toBe("penWidth");
		expect(widthScale("shape")?.field).toBe("penWidth");
		expect(widthScale("eraser")?.steps).toBe(ERASER_STEPS);
		expect(widthScale("text")?.field).toBe("textSize");
		expect(widthScale("lasso")).toBeNull();
		expect(nearestStep(PEN_STEPS, 2.1)).toBe(PEN_STEPS.indexOf(2));
		expect(formatWidth(3.2)).toBe("3.2");
		expect(formatWidth(2)).toBe("2");
	});
	it("maps angles to slider steps, clamped to the arc", () => {
		expect(stepAtAngle(-130, 11)).toBe(0);
		expect(stepAtAngle(0, 11)).toBe(5);
		expect(stepAtAngle(130, 11)).toBe(10);
		expect(stepAtAngle(-170, 11)).toBe(0);
		expect(stepAtAngle(175, 11)).toBe(10);
		expect(stepAtAngle(10, 1)).toBe(0);
		expect(stepDotRadius(0, 5)).toBeLessThan(stepDotRadius(4, 5));
	});
	it("places items on the ring", () => {
		const [x, y] = polar(100, 100, 50, 90);
		expect(x).toBeCloseTo(150);
		expect(y).toBeCloseTo(100);
		expect(angleOf(0, -1)).toBeCloseTo(0);
		expect(angleOf(1, 0)).toBeCloseTo(90);
		expect(angleOf(-1, 0)).toBeCloseTo(-90);
		expect(angleOf(0, 1)).toBeCloseTo(180);
		expect(arcAngles(3, -90, 90)).toEqual([-90, 0, 90]);
		expect(arcAngles(1, -90, 90)).toEqual([0]);
		expect(ringAngles(4)).toEqual([0, 90, 180, 270]);
		expect(bubbleDot("pen", 0.5)).toBeGreaterThanOrEqual(4);
		expect(bubbleDot("pen", 8)).toBeLessThanOrEqual(24);
	});
});
