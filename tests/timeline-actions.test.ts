import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, forThisPage, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { placementsOf } from "../src/ui/layout";
import { LABELS } from "../src/model/history-describe";
import { en } from "../src/i18n/en";
import { it as itStrings } from "../src/i18n/it";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";

const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
const sel = (extra: Record<string, unknown>) => baseContext({ tool: "lasso", selection: { strokes: 9, elements: 4, images: 0, ...extra } });
const IDS = ["insert-timeline", "timeline-edit"] as const;

describe("timeline actions (#148)", () => {
	it("Timeline is in the insert sheet; Edit timeline shows for one selected timeline only", () => {
		expect(isRelevant(by("insert-timeline"), baseContext())).toBe(true);
		expect(by("insert-timeline").group).toBe("insert");
		const tl = sel({ timeline: true });
		expect(isRelevant(by("timeline-edit"), tl)).toBe(true);
		expect(isRelevant(by("timeline-edit"), baseContext())).toBe(false);
		expect(isRelevant(by("timeline-edit"), sel({}))).toBe(false);
		expect(isRelevant(by("timeline-edit"), sel({ chart: true, table: true }))).toBe(false);
		for (const id of IDS) for (const w of [360, 800, 1280]) {
			const places = placementsOf(id, id === "timeline-edit" ? tl : baseContext(), w);
			expect(places, `${id} at ${w}`).toContain("sheet");
			// the selection bar keeps its rows: these live in the sheet (and as commands)
			expect(places, `${id} at ${w}`).not.toContain("context");
		}
	});

	it("are disabled on a locked page and on a read-only notebook", () => {
		const locked = baseContext({ tool: "lasso", selection: { strokes: 9, elements: 4, images: 0, timeline: true }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		const ro = baseContext({ editable: false, tool: "lasso", selection: { strokes: 9, elements: 4, images: 0, timeline: true } });
		for (const id of IDS) {
			expect(isEnabled(by(id), locked), id).toBe(false);
			expect(isEnabled(by(id), ro), id).toBe(false);
		}
		expect(isEnabled(by("timeline-edit"), sel({ timeline: true }))).toBe(true);
		expect(isEnabled(by("insert-timeline"), baseContext())).toBe(true);
	});

	it("Edit timeline comes first under 'For this page' for a selected timeline, and not otherwise", () => {
		expect(contextBoost(by("timeline-edit"), sel({ timeline: true }))).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(by("timeline-edit"), sel({ timeline: true })) - contextBoost(by("timeline-edit"), sel({}))).toBe(HERE_MIN_BOOST + 5);
		expect(contextBoost(by("timeline-edit"), sel({ chart: true }))).toBe(contextBoost(by("timeline-edit"), sel({})));
		expect(forThisPage(ACTIONS, sel({ timeline: true }), {}, 0, new Set<string>(), 200).map((a) => a.id)).toContain("timeline-edit");
		// inserting never reaches "For this page" on its own
		for (const kind of ["grid", "plain", "ruled"] as const) {
			const c = baseContext({ page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, kind } });
			expect(contextBoost(by("insert-timeline"), c), kind).toBeLessThan(HERE_MIN_BOOST);
			expect(forThisPage(ACTIONS, c, {}, 0, new Set<string>(), 200).map((a) => a.id), kind).not.toContain("insert-timeline");
		}
		const grid = baseContext({ page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, kind: "grid" } });
		expect(contextBoost(by("insert-timeline"), grid)).toBeGreaterThan(0);
	});

	it("have help text, command names, and Italian strings", () => {
		for (const id of IDS) {
			const key = ACTION_HELP[id];
			expect(key, id).toBeTruthy();
			expect(enSrc.includes(`"${key}":`), `${id} en`).toBe(true);
			expect(itSrc.includes(`"${key}":`), `${id} it`).toBe(true);
			expect(typeof by(id).command).toBe("string");
			expect(en[by(id).command as keyof typeof en], `${id} command en`).toBeTruthy();
			expect(itStrings[by(id).command as keyof typeof itStrings], `${id} command it`).toBeTruthy();
			expect(en[by(id).label], `${id} label en`).toBeTruthy();
			expect(itStrings[by(id).label], `${id} label it`).toBeTruthy();
		}
	});

	it("every timeline message has an Italian text", () => {
		const keys = Object.keys(en).filter((k) => k.startsWith("timeline.") || k.startsWith("help.timeline.") || k.startsWith("histpanel.t.timeline"));
		expect(keys.length).toBeGreaterThan(30);
		for (const k of keys) expect(itStrings[k as keyof typeof itStrings], k).toBeTruthy();
	});

	it("names its two History steps in the history panel", () => {
		expect(LABELS["Insert timeline"]).toBeTruthy();
		expect(LABELS["Update timeline"]).toBeTruthy();
	});
});
