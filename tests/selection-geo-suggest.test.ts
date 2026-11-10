import { describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS, suggestFromGeometry, suggestionActions, type GeoStroke } from "../src/ui/selection-kind";

/** A stroke boxed by (x, y, w, h), as a zig-zag from its top-left to its bottom-right corner. */
function box(x: number, y: number, w: number, h: number, handwriting = true): GeoStroke {
	return { minX: x, minY: y, maxX: x + w, maxY: y + h, pts: [[x, y], [x + w / 2, y + h], [x + w, y + h]], handwriting };
}
/** A straight stroke from (x1, y1) to (x2, y2). */
function seg(x1: number, y1: number, x2: number, y2: number, handwriting = false): GeoStroke {
	return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2), pts: [[x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x2, y2]], handwriting };
}
/** A closed loop (circle) around (cx, cy). */
function loop(cx: number, cy: number, r: number): GeoStroke {
	const pts = Array.from({ length: 21 }, (_, i): [number, number] => [cx + r * Math.cos((i / 20) * 2 * Math.PI), cy + r * Math.sin((i / 20) * 2 * Math.PI)]);
	return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r, pts, handwriting: false };
}
const word = (x: number, y: number): GeoStroke[] => [box(x, y, 14, 18), box(x + 18, y, 14, 18), box(x + 36, y + 4, 14, 14)];

describe("geometry suggestions (403)", () => {
	it("suggests highlight and a note for one row of words", () => {
		const row = [...word(10, 100), ...word(70, 100), ...word(130, 102)];
		expect(suggestFromGeometry(row, 0)).toEqual(["row"]);
		expect(suggestionActions(["row"])).toEqual(["selection-highlight", "selection-insert-note"]);
	});

	it("suggests nothing for a multi-line paragraph", () => {
		const para = [...word(10, 100), ...word(70, 100), ...word(10, 130), ...word(70, 130), ...word(10, 160)];
		expect(suggestFromGeometry(para, 0)).toEqual([]);
	});

	it("suggests nothing for a single stroke, a tall column, or non-handwriting", () => {
		expect(suggestFromGeometry([box(10, 10, 200, 20)], 0)).toEqual([]);
		expect(suggestFromGeometry([box(10, 10, 20, 100), box(40, 10, 20, 100), box(70, 10, 20, 100)], 0)).toEqual([]);
		expect(suggestFromGeometry([box(10, 10, 60, 20, false), box(80, 10, 60, 20, false)], 0)).toEqual([]);
	});

	it("suggests a link for two clusters joined by an arrow", () => {
		const left = word(10, 100), right = word(300, 100);
		const arrow = seg(66, 109, 296, 109);
		expect(suggestFromGeometry([...left, ...right, arrow], 0)).toEqual(["link"]);
		expect(suggestionActions(["link"])).toEqual(["link-selection", "selection-group"]);
	});

	it("takes the small strokes of an arrow head as part of the arrow", () => {
		const left = word(10, 100), right = word(300, 100);
		const head = [seg(286, 103, 296, 109), seg(286, 115, 296, 109)];
		expect(suggestFromGeometry([...left, ...right, seg(66, 109, 296, 109), ...head], 0)).toEqual(["link"]);
	});

	it("does not call it a link when the long stroke touches only one cluster", () => {
		const left = word(10, 100), right = word(300, 100);
		expect(suggestFromGeometry([...left, ...right, seg(66, 109, 200, 109)], 0)).toEqual([]);
		// an underline below one row is not an arrow between two clusters
		expect(suggestFromGeometry([...word(10, 100), seg(10, 124, 70, 124)], 0)).not.toContain("link");
	});

	it("suggests grouping for a loop around content", () => {
		const content = [...word(40, 90), ...word(40, 120)];
		expect(suggestFromGeometry([...content, loop(70, 115, 80)], 0)).toEqual(["loop"]);
		expect(suggestionActions(["loop"])).toEqual(["selection-group"]);
	});

	it("does not call a loop that leaves content outside it", () => {
		expect(suggestFromGeometry([...word(40, 90), ...word(400, 90), loop(70, 100, 60)], 0)).toEqual([]);
	});

	it("stays silent for mixed selections (pictures, text, objects), an empty one and a huge one", () => {
		const row = [...word(10, 100), ...word(70, 100)];
		expect(suggestFromGeometry(row, 1)).toEqual([]);
		expect(suggestFromGeometry([], 0)).toEqual([]);
		expect(suggestFromGeometry(Array.from({ length: 300 }, (_, i) => box(i * 5, 0, 4, 10)), 0)).toEqual([]);
	});

	it("shows at most two chips, without repeats", () => {
		expect(suggestionActions(["link", "loop"])).toEqual(["link-selection", "selection-group"]);
		expect(suggestionActions(["row", "link", "loop"]).length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
		expect(suggestionActions([])).toEqual([]);
	});
});

import { baseContext, type UiContext } from "../src/ui/actions";
import { contextBar } from "../src/ui/layout";
import { suggestForSelection } from "../src/ui/selection-suggest";
import { readSettings } from "../src/settings";
import { createStroke, quantizePoint } from "../src/model/document";

const selCtx = (suggest?: string[]): UiContext =>
	baseContext({ tool: "lasso", selection: { strokes: 5, elements: 0, images: 0, ...(suggest ? { suggest } : {}) } });

describe("suggestion chips in the selection bar (403)", () => {
	it("keeps every slot where it was: chips are a separate list of the plan", () => {
		for (const width of [360, 800, 1280]) {
			const plain = contextBar(selCtx(), width, {}, 0)!;
			const chipped = contextBar(selCtx(["selection-highlight", "selection-insert-note"]), width, {}, 0)!;
			expect(chipped.actions, String(width)).toEqual(plain.actions);
			expect(chipped.second, String(width)).toEqual(plain.second);
			expect(chipped.suggest).toEqual(["selection-highlight", "selection-insert-note"]);
			expect(plain).not.toHaveProperty("suggest");
		}
	});

	it("shows at most two chips and drops ids that are not usable actions", () => {
		const bar = contextBar(selCtx(["nope", "link-selection", "selection-group", "selection-highlight"]), 800, {}, 0)!;
		expect(bar.suggest!.length).toBeLessThanOrEqual(2);
		expect(bar.suggest).not.toContain("nope");
	});

	it("builds the ids from real strokes, and the setting is on by default", () => {
		const s = (x: number): ReturnType<typeof createStroke> => createStroke("#1e1e1e", 2, [quantizePoint(x, 100, 0.5), quantizePoint(x + 8, 112, 0.5), quantizePoint(x + 14, 100, 0.5)]);
		expect(suggestForSelection([s(10), s(30), s(50), s(70)], [])).toEqual(["selection-highlight", "selection-insert-note"]);
		expect(suggestForSelection([s(10), s(30)], [{ id: "x", type: "text", x: 0, y: 0, width: 10, text: "a", fontSize: 12, color: "#000" }])).toEqual([]);
		expect(readSettings({}).suggestSelection).toBe(true);
		expect(readSettings({ suggestSelection: false }).suggestSelection).toBe(false);
	});
});
