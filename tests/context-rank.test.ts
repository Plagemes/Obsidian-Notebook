import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { contextBoost, forThisPage, HERE_COUNT } from "../src/ui/context-rank";
import { buildSheet } from "../src/ui/layout";
import { recordUse } from "../src/ui/usage";

const NOW = 1_800_000_000_000;
const label = (a: { id: string }) => a.id.replace(/-/g, " ");
const sheet = (c: ReturnType<typeof baseContext>, extra: { query?: string; usage?: Record<string, never> | ReturnType<typeof recordUse>; visible?: Set<string> } = {}) =>
	buildSheet(c, { kind: "all", usage: extra.usage ?? {}, now: NOW, label, groupLabel: (g) => g, ...(extra.query !== undefined ? { query: extra.query } : {}), ...(extra.visible ? { visible: extra.visible } : {}) });
const find = (id: string) => ACTIONS.find((a) => a.id === id)!;

describe("context ranking (#424)", () => {
	it("boosts nothing when no document is open", () => {
		const c = baseContext({ open: false, editable: false });
		for (const a of ACTIONS) expect(contextBoost(a, c)).toBe(0);
		expect(forThisPage(ACTIONS, c, {}, NOW)).toEqual([]);
	});

	it("puts selection actions first when something is selected", () => {
		const c = baseContext({ selection: { strokes: 3, elements: 0, images: 0 } });
		const here = sheet(c)[0]!;
		expect(here.id).toBe("here");
		expect(here.actions.length).toBeLessThanOrEqual(HERE_COUNT);
		expect(here.actions.every((a) => contextBoost(a, c) >= 20)).toBe(true);
		expect(here.actions.some((a) => a.group === "selection" || a.contexts?.includes("selection"))).toBe(true);
	});

	it("boosts reading actions on a PDF page and lecture actions during a lecture", () => {
		const pdf = baseContext({ page: { index: 0, count: 3, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } });
		const plain = baseContext();
		const reading = ACTIONS.find((a) => a.group === "reading")!;
		expect(contextBoost(reading, pdf)).toBeGreaterThan(contextBoost(reading, plain));
		const lec = baseContext({ lecture: true });
		const lecture = ACTIONS.find((a) => a.group === "lecture")!;
		expect(contextBoost(lecture, lec)).toBeGreaterThan(contextBoost(lecture, plain));
	});

	it("boosts the options of the tool in hand", () => {
		const lasso = baseContext({ tool: "lasso" });
		expect(contextBoost(find("select-same-tool"), lasso)).toBeGreaterThanOrEqual(20);
		expect(contextBoost(find("select-same-tool"), baseContext())).toBe(0);
		expect(sheet(lasso)[0]!.id).toBe("here");
	});

	it("boosts the present action while presenting", () => {
		const on = baseContext({ presenting: true });
		expect(contextBoost(find("present"), on)).toBeGreaterThanOrEqual(30);
		expect(contextBoost(find("present"), baseContext())).toBe(0);
	});

	it("search ranks the actions that fit the context above equal matches", () => {
		const lecture = baseContext({ lecture: true });
		const rank = (c: ReturnType<typeof baseContext>) => sheet(c, { query: "lecture" })[0]!.actions.map((a) => a.id);
		const lectureIds = ACTIONS.filter((a) => a.group === "lecture").map((a) => a.id);
		const inLecture = rank(lecture);
		const top = inLecture.slice(0, 2);
		expect(top.some((id) => lectureIds.includes(id))).toBe(true);
	});

	it("keeps recent use in the ranking and does not repeat 'here' entries in 'recent'", () => {
		const c = baseContext({ selection: { strokes: 2, elements: 0, images: 0 } });
		const here = forThisPage(ACTIONS.filter((a) => a.surfaces.includes("sheet")), c, {}, NOW);
		expect(here.length).toBeGreaterThan(0);
		const used = recordUse({}, here[0]!.id, NOW);
		const sections = sheet(c, { usage: used });
		const recent = sections.find((s) => s.id === "recent");
		expect(recent?.actions.some((a) => a.id === here[0]!.id) ?? false).toBe(false);
		expect(sections[0]!.actions[0]!.id).toBe(here[0]!.id);
	});

	it("leaves out disabled, checked and already visible actions from 'here'", () => {
		const c = baseContext({ selection: { strokes: 2, elements: 0, images: 0 } });
		const all = forThisPage(ACTIONS, c, {}, NOW, new Set(), 100);
		const hidden = new Set([all[0]!.id]);
		expect(forThisPage(ACTIONS, c, {}, NOW, hidden, 100).map((a) => a.id)).not.toContain(all[0]!.id);
		const ro = baseContext({ editable: false, selection: { strokes: 2, elements: 0, images: 0 } });
		for (const a of forThisPage(ACTIONS, ro, {}, NOW, new Set(), 100)) expect(a.readOnly).toBe(true);
	});

	it("is deterministic", () => {
		const c = baseContext({ selection: { strokes: 1, elements: 0, images: 0 } });
		expect(sheet(c).map((s) => s.actions.map((a) => a.id))).toEqual(sheet(c).map((s) => s.actions.map((a) => a.id)));
	});

	it("has a label for the new section in both languages", async () => {
		const { en } = await import("../src/i18n/en");
		const { it: ita } = await import("../src/i18n/it");
		expect(en["ui.group.here"]).toBeTruthy();
		expect((ita as Record<string, string>)["ui.group.here"]).toBeTruthy();
	});
});

describe("context ranking of the 0.24 actions", () => {
	const NEW_IDS = ["bookmarks-open", "page-global-bookmark", "hand-in", "selection-join"];
	const contexts = {
		closed: baseContext({ open: false, editable: false }),
		plain: baseContext(),
		readOnly: baseContext({ editable: false }),
		pdf: baseContext({ page: { index: 0, count: 3, background: "pdf", infinite: false, bookmarked: false, globalBookmark: true }, notebook: { pdfPages: true, backgrounds: true } }),
		oneStroke: baseContext({ selection: { strokes: 1, elements: 0, images: 0 } }),
		strokes: baseContext({ selection: { strokes: 3, elements: 0, images: 0 } }),
		shapeTool: baseContext({ tool: "shape" }),
		lasso: baseContext({ tool: "lasso" }),
	};

	it("scores, lists and builds the sheet for every context without errors", () => {
		for (const [name, c] of Object.entries(contexts)) {
			for (const id of NEW_IDS) {
				const a = find(id);
				expect(a, id).toBeDefined();
				expect(Number.isFinite(contextBoost(a, c)), `${id} in ${name}`).toBe(true);
			}
			expect(() => forThisPage(ACTIONS, c, {}, NOW, new Set(), 100), name).not.toThrow();
			expect(() => sheet(c), name).not.toThrow();
			for (const id of NEW_IDS) expect(() => sheet(c, { query: id.split("-")[0]! }), `${id} search in ${name}`).not.toThrow();
		}
	});

	it("join broken strokes is ranked for a selection of strokes, and only then", () => {
		const join = find("selection-join");
		expect(contextBoost(join, contexts.strokes)).toBeGreaterThanOrEqual(20);
		const here = forThisPage(ACTIONS, contexts.strokes, {}, NOW, new Set(), 100).map((a) => a.id);
		expect(here).toContain("selection-join");
		// One stroke cannot be joined with anything: not offered.
		expect(forThisPage(ACTIONS, contexts.oneStroke, {}, NOW, new Set(), 100).map((a) => a.id)).not.toContain("selection-join");
		// Nothing selected and no lasso: no boost to the selection group.
		expect(contextBoost(join, contexts.plain)).toBeLessThan(20);
		const sections = sheet(contexts.strokes);
		expect(sections[0]!.id).toBe("here");
	});

	it("the shape tool's own actions (the shape kinds) are ranked first with the shape tool in hand", () => {
		const kinds = ACTIONS.filter((a) => a.id.startsWith("shape-"));
		expect(kinds.length).toBeGreaterThan(0);
		for (const a of kinds) {
			expect(contextBoost(a, contexts.shapeTool), a.id).toBeGreaterThanOrEqual(22);
			expect(contextBoost(a, contexts.plain), a.id).toBe(0);
		}
	});

	it("bookmarks and hand-in never crowd a selection out of 'For this page'", () => {
		const here = sheet(contexts.strokes)[0]!.actions.map((a) => a.id);
		for (const id of ["bookmarks-open", "hand-in"]) expect(here, id).not.toContain(id);
		for (const id of ["bookmarks-open", "page-global-bookmark", "hand-in"]) expect(contextBoost(find(id), contexts.closed), id).toBe(0);
	});
});

describe("context ranking of Align to baseline (0.25, #93)", () => {
	const strokes = baseContext({ selection: { strokes: 4, elements: 0, images: 0 } });
	const ruled = baseContext({ selection: { strokes: 4, elements: 0, images: 0 }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, kind: "ruled" } });
	const blank = baseContext({ selection: { strokes: 4, elements: 0, images: 0 }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, kind: "plain" } });

	it("is ranked for a selection of strokes, a little higher on ruled paper, and not without a selection", () => {
		const a = find("selection-baseline");
		expect(contextBoost(a, strokes)).toBeGreaterThanOrEqual(20);
		expect(contextBoost(a, ruled)).toBeGreaterThan(contextBoost(a, blank));
		expect(contextBoost(a, baseContext())).toBeLessThan(20);
		expect(contextBoost(a, baseContext({ open: false, editable: false }))).toBe(0);
		expect(forThisPage(ACTIONS, strokes, {}, NOW, new Set(), 100).map((x) => x.id)).toContain("selection-baseline");
		expect(forThisPage(ACTIONS, baseContext({ selection: { strokes: 1, elements: 0, images: 0 } }), {}, NOW, new Set(), 100).map((x) => x.id)).not.toContain("selection-baseline");
	});

	it("is found by what a person would type, in both languages", () => {
		for (const query of ["baseline", "crooked", "allinea", "rigo"]) {
			const ids = sheet(strokes, { query }).flatMap((s) => s.actions.map((x) => x.id));
			expect(ids, query).toContain("selection-baseline");
		}
	});
});
