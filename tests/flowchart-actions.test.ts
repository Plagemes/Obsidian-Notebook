import { describe, expect, it } from "vitest";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";
import { LABELS } from "../src/model/history-describe";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { contextBar, placementsOf } from "../src/ui/layout";
import { FLOWCHART_LABEL } from "../src/ink/flowchart";
import viewActionsSource from "../src/view/view-actions.ts?raw";

const def = ACTIONS.find((a) => a.id === "selection-flowchart")!;
const sel = (strokes: number, elements = 0) => baseContext({ tool: "lasso", selection: { strokes, elements, images: 0 } });

describe("Tidy flowchart action (0.30, #245)", () => {
	it("is in the sheet for a selection of ink, with a command, and not on the selection bar rows", () => {
		expect(def.surfaces).toEqual(["sheet"]);
		expect(def.command).toBe("command.flowchart");
		expect(isRelevant(def, sel(4))).toBe(true);
		expect(isRelevant(def, sel(1))).toBe(false);
		expect(isRelevant(def, sel(0, 3))).toBe(false);
		expect(isRelevant(def, baseContext())).toBe(false);
		for (const width of [360, 800, 1280]) {
			expect(placementsOf("selection-flowchart", sel(8), width)).toContain("sheet");
			expect(placementsOf("selection-flowchart", sel(8), width)).not.toContain("context");
			const bar = contextBar(sel(8), width, {}, 0);
			expect(bar?.second ?? []).not.toContain("selection-flowchart");
		}
	});

	it("is disabled on a locked page and in a read-only notebook", () => {
		const locked = baseContext({ tool: "lasso", selection: { strokes: 6, elements: 0, images: 0 }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		expect(isEnabled(def, locked)).toBe(false);
		expect(isEnabled(def, baseContext({ editable: false, tool: "lasso", selection: { strokes: 6, elements: 0, images: 0 } }))).toBe(false);
		expect(isEnabled(def, sel(6))).toBe(true);
	});

	it("is ranked up for a selection of a good many strokes, and not for none", () => {
		expect(contextBoost(def, sel(10))).toBeGreaterThan(contextBoost(def, sel(3)));
		expect(contextBoost(def, baseContext())).toBe(0);
	});

	it("has help, a handler, every text in English and Italian, and a history title", () => {
		expect(ACTION_HELP["selection-flowchart"]).toBe("help.flowchart");
		expect(viewActionsSource).toContain("\"selection-flowchart\"");
		for (const key of [
			def.label, String(def.command), "help.flowchart", "flowchart.done", "flowchart.few", "flowchart.nested", "flowchart.ambiguous", "flowchart.none",
			"flowchart.redacted", "flowchart.tape", "flowchart.edge", "histpanel.t.flowchart",
		]) {
			expect(enSrc, key).toContain(`"${key}"`);
			expect(itSrc, key).toContain(`"${key}"`);
		}
		expect(LABELS[FLOWCHART_LABEL]).toEqual(["histpanel.t.flowchart", "workflow"]);
	});
});
