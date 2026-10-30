import { describe, expect, it } from "vitest";
import { movePlan } from "../src/ink/gestures/move";
import { InputPolicy, heldToolOf, opensRadial, PEN_BUTTON_ACTIONS } from "../src/ink/input-policy";
import { createPage, createStroke } from "../src/model/document";
import { pageContentCommand } from "../src/model/page-content";
import { History } from "../src/model/history";
import { RENDER_INK, type NotebookDocument, type Stroke } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { policySettings } from "../src/view/input-settings";

function stroke(x: number, y: number): Stroke {
	return createStroke("#000", 2, [[x, y, 0.5], [x + 20, y + 5, 0.5]], "pen", RENDER_INK);
}

function docWith(pages: number): NotebookDocument {
	const doc = {
		version: 7, id: "d", created: 0, modified: 0, assets: [], pages: Array.from({ length: pages }, () => createPage({ width: 300, height: 400 })),
	} as unknown as NotebookDocument;
	return doc;
}

describe("move a selection to another page", () => {
	it("moves the strokes, keeps their place, and undo puts everything back", () => {
		const doc = docWith(3);
		const a = stroke(10, 20), b = stroke(50, 60), other = stroke(90, 100);
		doc.pages[0]!.strokes.push(a, b);
		doc.pages[2]!.strokes.push(other);
		const plan = movePlan(doc, { pageIndex: 0, strokes: [b], elements: [] }, 2)!;
		const history = new History(() => doc);
		history.execute(pageContentCommand(doc, plan, "Move to page"));
		expect(doc.pages[0]!.strokes).toEqual([a]);
		expect(doc.pages[2]!.strokes).toEqual([other, b]);
		history.undo();
		expect(doc.pages[0]!.strokes).toEqual([a, b]);
		expect(doc.pages[2]!.strokes).toEqual([other]);
	});
	it("shifts content that would stick out of a smaller page; refuses the same page or an empty selection", () => {
		const doc = docWith(2);
		doc.pages[1]!.width = 100;
		const wide = createStroke("#000", 2, [[200, 20, 0.5], [280, 30, 0.5]], "pen", RENDER_INK);
		doc.pages[0]!.strokes.push(wide);
		const plan = movePlan(doc, { pageIndex: 0, strokes: [wide], elements: [] }, 1)!;
		const moved = plan.changes[1]!.strokes[0]!;
		expect(Math.max(...moved.points.map((p) => p[0]))).toBeLessThanOrEqual(100);
		expect(movePlan(doc, { pageIndex: 0, strokes: [wide], elements: [] }, 0)).toBeNull();
		expect(movePlan(doc, { pageIndex: 0, strokes: [], elements: [] }, 1)).toBeNull();
		expect(movePlan(doc, { pageIndex: 0, strokes: [wide], elements: [] }, 7)).toBeNull();
	});
});

describe("the side button gesture actions", () => {
	it("are offered, parsed and open no menu / hold the gesture tool", () => {
		expect(PEN_BUTTON_ACTIONS).toContain("gesture");
		expect(PEN_BUTTON_ACTIONS).toContain("radial-gesture");
		expect(readSettings({ penSideButton: "gesture" }).penSideButton).toBe("gesture");
		expect(readSettings({ penSideButton: "radial-gesture" }).penSideButton).toBe("radial-gesture");
		expect(opensRadial("gesture")).toBe(false);
		expect(opensRadial("radial-gesture")).toBe(true);
		expect(heldToolOf("gesture")).toBe("gesture");
		expect(heldToolOf("radial-gesture")).toBe("gesture");
		expect(DEFAULT_SETTINGS.penSideButton).toBe("radial-eraser");
	});
	it("a contact with the barrel bit held draws as the gesture tool; without it the pen writes normally", () => {
		const p = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500, penButton: "gesture" });
		expect(p.penHeld(0, 3)).toBe("gesture");
		expect(p.penHeld(0, 1)).toBeNull();
		expect(p.route("pen", 0, 0, 0, 1)).toBe("draw");
		expect(p.penErases(0, 3)).toBe(false);
	});
	it("the long-press gesture turns off the hold-still radial menu, and is off by default", () => {
		const off = policySettings(readSettings({ penHoldStill: true }));
		expect(off.penLongPress).toBe(true);
		const on = policySettings(readSettings({ penHoldStill: true, penGestureLongPress: true }));
		expect(on.penLongPress).toBe(false);
	});
});
