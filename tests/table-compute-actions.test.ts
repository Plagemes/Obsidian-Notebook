import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { placementsOf } from "../src/ui/layout";
import { LABELS } from "../src/model/history-describe";
import { CLASSIFIED } from "../src/model/page-undo";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";

const action = ACTIONS.find((a) => a.id === "table-compute")!;
const sel = (extra: Record<string, unknown>) => baseContext({ tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, ...extra } });

describe("Compute table action (#147)", () => {
	it("shows for a selected table only, in the All actions sheet", () => {
		expect(isRelevant(action, sel({ table: true }))).toBe(true);
		expect(isRelevant(action, sel({}))).toBe(false);
		expect(isRelevant(action, baseContext())).toBe(false);
		for (const w of [360, 800, 1280]) {
			const places = placementsOf("table-compute", sel({ table: true }), w);
			expect(places, `at ${w}`).toContain("sheet");
			expect(places, `at ${w}`).not.toContain("context");
		}
	});

	it("is disabled on a locked page and on a read-only notebook", () => {
		const locked = baseContext({ tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, table: true }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		const ro = baseContext({ editable: false, tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, table: true } });
		expect(isEnabled(action, locked)).toBe(false);
		expect(isEnabled(action, ro)).toBe(false);
		expect(isEnabled(action, sel({ table: true }))).toBe(true);
	});

	it("ranks above the other table actions of a selected table, and not otherwise", () => {
		const stats = ACTIONS.find((a) => a.id === "table-stats")!;
		expect(contextBoost(action, sel({ table: true }))).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(action, sel({ table: true }))).toBeGreaterThan(contextBoost(stats, sel({ table: true })));
		expect(contextBoost(action, sel({}))).toBe(contextBoost(stats, sel({})));
	});

	it("has a help text and a command name in English and Italian, and names its History step", () => {
		const key = ACTION_HELP["table-compute"];
		expect(key).toBeTruthy();
		for (const src of [enSrc, itSrc]) {
			expect(src.includes(`"${key}":`)).toBe(true);
			expect(src.includes(`"${action.label}":`)).toBe(true);
			expect(src.includes(`"${action.command as string}":`)).toBe(true);
			expect(src.includes('"histpanel.t.tableCompute":')).toBe(true);
		}
		expect(LABELS["Compute table"]).toBeTruthy();
	});

	it("uses only History commands that are already classified for per-page undo", () => {
		expect(CLASSIFIED).toContain("Batch");
		expect(CLASSIFIED).toContain("ReplaceElement");
	});
});
