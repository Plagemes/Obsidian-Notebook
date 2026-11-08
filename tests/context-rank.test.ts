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
