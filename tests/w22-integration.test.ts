// Wave 0.22 integration: the new pens (format v20) against the features that read the ink by tool or by colour.
import { describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import { meaningCounts, meaningRegions, strokeDimmer, type Meaning } from "../src/model/colour-meaning";
import { TOOLS, isLinePen, isNewPen, isWritingPen, type Stroke, type Tool } from "../src/model/types";

const RED = "#dc2626";
const legend: Meaning[] = [{ colour: RED, label: "Definition" }];

function line(tool: Tool, y: number): Stroke {
	const points: Array<[number, number, number]> = [];
	for (let x = 20; x <= 120; x += 5) points.push([x, y, 0.5]);
	return createStroke(RED, 2, points, tool);
}

describe("the new pens in the tool predicates", () => {
	it("every tool is classified: line pens write lines, the marker marks, the highlighter and the shape do neither", () => {
		const table = TOOLS.map((tool) => [tool, isWritingPen(tool), isLinePen(tool), isNewPen(tool)] as const);
		expect(table).toEqual([
			["pen", true, true, false],
			["highlighter", false, false, false],
			["shape", false, false, false],
			["fountain", true, true, true],
			["brush", true, true, true],
			["marker", true, false, true],
		]);
	});
});

describe("colour meanings read the ink of every tool", () => {
	it("counts and gathers fountain, brush and marker strokes like pen strokes", () => {
		const page = createPage({ width: 600, height: 800 });
		page.strokes = [line("pen", 100), line("fountain", 300), line("brush", 500), line("marker", 700), line("highlighter", 900)];
		expect(meaningCounts([page], legend)).toEqual({ perMeaning: [5], none: 0 });
		const regions = meaningRegions([page], legend);
		expect(regions.flatMap((r) => r.strokeIds).sort()).toEqual(page.strokes.map((s) => s.id).sort());
	});

	it("the filter dims strokes of other colours whatever the tool, and none of the matching ones", () => {
		const dim = strokeDimmer(legend, 0);
		expect(dim).not.toBeNull();
		for (const tool of TOOLS) {
			expect(dim!({ color: RED }), tool).toBe(false);
			expect(dim!({ color: "#16a34a" }), tool).toBe(true);
		}
	});
});
