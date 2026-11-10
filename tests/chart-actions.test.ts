import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, forThisPage, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { placementsOf } from "../src/ui/layout";
import { LABELS } from "../src/model/history-describe";
import { chartDataFromCells } from "../src/math/chart-layout";
import { readNotes } from "../src/view/chart-logic";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";

const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
const sel = (extra: Record<string, unknown>) => baseContext({ tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, ...extra } });

describe("chart actions (#244)", () => {
	it("show for a selected table and a selected chart only, in the All actions sheet", () => {
		const table = sel({ chartable: true });
		const chart = sel({ chart: true });
		expect(isRelevant(by("chart-from-table"), table)).toBe(true);
		expect(isRelevant(by("chart-update"), table)).toBe(false);
		expect(isRelevant(by("chart-update"), chart)).toBe(true);
		expect(isRelevant(by("chart-from-table"), chart)).toBe(false);
		for (const id of ["chart-from-table", "chart-update"]) {
			expect(isRelevant(by(id), baseContext()), id).toBe(false);
			expect(isRelevant(by(id), sel({})), id).toBe(false);
			// the selection bar keeps its rows: these two live in the sheet (and as commands)
			for (const w of [360, 800, 1280]) {
				const places = placementsOf(id, id === "chart-update" ? chart : table, w);
				expect(places, `${id} at ${w}`).toContain("sheet");
				expect(places, `${id} at ${w}`).not.toContain("context");
			}
		}
	});

	it("are disabled on a locked page and on a read-only notebook", () => {
		const locked = baseContext({ tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, chartable: true, chart: true }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		const ro = baseContext({ editable: false, tool: "lasso", selection: { strokes: 9, elements: 0, images: 0, chartable: true, chart: true } });
		for (const id of ["chart-from-table", "chart-update"]) {
			expect(isEnabled(by(id), locked), id).toBe(false);
			expect(isEnabled(by(id), ro), id).toBe(false);
			expect(isEnabled(by(id), sel({ chartable: true, chart: true })), id).toBe(true);
		}
	});

	it("come first under 'For this page' for the selection they fit, and not otherwise", () => {
		expect(contextBoost(by("chart-from-table"), sel({ chartable: true }))).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(by("chart-update"), sel({ chart: true }))).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		// the rule adds to what any selection action already has, and only for its own kind of selection
		expect(contextBoost(by("chart-from-table"), sel({ chartable: true })) - contextBoost(by("chart-from-table"), sel({}))).toBe(HERE_MIN_BOOST + 5);
		expect(contextBoost(by("chart-update"), sel({ chart: true })) - contextBoost(by("chart-update"), sel({}))).toBe(HERE_MIN_BOOST + 6);
		expect(contextBoost(by("chart-update"), sel({ chartable: true }))).toBe(contextBoost(by("chart-update"), sel({})));
		expect(contextBoost(by("chart-from-table"), sel({ chart: true }))).toBe(contextBoost(by("chart-from-table"), sel({})));
		// (the section shows the best five by score; with room for all of them both qualify)
		const none = new Set<string>();
		expect(forThisPage(ACTIONS, sel({ chart: true }), {}, 0, none, 200).map((a) => a.id)).toContain("chart-update");
		expect(forThisPage(ACTIONS, sel({ chartable: true, table: true }), {}, 0, none, 200).map((a) => a.id)).toContain("chart-from-table");
	});

	it("have help text, command names, and Italian strings", () => {
		for (const id of ["chart-from-table", "chart-update"]) {
			const key = ACTION_HELP[id];
			expect(key, id).toBeTruthy();
			expect(enSrc.includes(`"${key}":`), `${id} en`).toBe(true);
			expect(itSrc.includes(`"${key}":`), `${id} it`).toBe(true);
			expect(typeof by(id).command).toBe("string");
		}
	});

	it("names its two History steps in the history panel", () => {
		expect(LABELS["Insert chart"]).toBeTruthy();
		expect(LABELS["Update chart"]).toBeTruthy();
	});
});

describe("what the dialog says about the numbers (#244)", () => {
	it("says there is nothing to show when there are no numbers", () => {
		expect(readNotes(chartDataFromCells([["a", "b"], ["c", "d"]]), "bar")).toEqual(["chart.read.none"]);
		expect(readNotes(chartDataFromCells([]), "pie")).toEqual(["chart.read.none"]);
	});

	it("notes left-out cells, and that a pie shows one column", () => {
		const d = chartDataFromCells([["h", "x", "y"], ["a", "1", "2"], ["b", "oops", "3"]]);
		expect(readNotes(d, "bar")).toEqual(["chart.read.skipped"]);
		expect(readNotes(d, "pie")).toEqual(["chart.read.skipped", "chart.read.pie"]);
		expect(readNotes(chartDataFromCells([["h", "x"], ["a", "1"]]), "line")).toEqual([]);
	});

	it("notes columns beyond the limit for bars and lines only", () => {
		const head = ["h", ...Array.from({ length: 10 }, (_, i) => `s${i}`)];
		const row = ["a", ...Array.from({ length: 10 }, () => "1")];
		const d = chartDataFromCells([head, row]);
		expect(readNotes(d, "bar")).toContain("chart.read.dropped");
		expect(readNotes(d, "pie")).not.toContain("chart.read.dropped");
	});
});
