// The scenes of dev/harness/geosuggest-check.ts as real strokes, through the real conversion (strokeBounds, point sampling).
import { describe, expect, it } from "vitest";
import { suggestForSelection } from "../src/ui/selection-suggest";
import { RENDER_INK, type Point, type Stroke } from "../src/model/types";

const pt = (x: number, y: number): Point => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.55];
const line = (a: [number, number], b: [number, number], n = 8): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
const ring = (cx: number, cy: number, r: number, n = 36): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)));
let seq = 0;
const make = (points: Point[], tool: Stroke["tool"] = "pen"): Stroke => ({ id: `gs-${++seq}`, tool, color: "#1f2933", width: 2, render: RENDER_INK, points });
function word(x: number, y: number): Stroke[] {
	return [0, 1, 2].flatMap((k) => [make(ring(x + 8 + k * 22, y + 12, 7, 18)), make(line([x + 16 + k * 22, y + 2], [x + 16 + k * 22, y + 22], 4))]);
}

describe("the harness scenes of the geometry suggestions", () => {
	it("two words joined by a shape-tool arrow with a head offer Link and Group", () => {
		const strokes = [...word(60, 200), ...word(330, 200), make(line([130, 212], [321, 212], 16), "shape"), make(line([309, 204], [321, 212], 3), "shape"), make(line([309, 220], [321, 212], 3), "shape")];
		expect(suggestForSelection(strokes, [])).toEqual(["link-selection", "selection-group"]);
	});
});
