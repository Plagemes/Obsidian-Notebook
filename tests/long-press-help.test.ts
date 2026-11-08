import { describe, expect, it } from "vitest";
import { cleanHelp, HELP_PRESS_MS, HELP_SLOP_PX, LongPressTracker, placeBubble, startsHelp } from "../src/ui/long-press-logic";
import { ACTION_HELP, TOOL_HELP } from "../src/ui/help-text";
import { ACTIONS, actionById } from "../src/ui/actions";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { DEFAULT_SETTINGS } from "../src/settings";
import { settingSpecs } from "../src/view/settings-schema";

describe("who may ask for the explanation", () => {
	it("only a primary finger", () => {
		expect(startsHelp("touch", true)).toBe(true);
		expect(startsHelp("touch", false)).toBe(false);
	});
	it("never the pen and never the mouse", () => {
		expect(startsHelp("pen", true)).toBe(false);
		expect(startsHelp("mouse", true)).toBe(false);
	});
});

describe("LongPressTracker", () => {
	it("is due after the hold time and not before", () => {
		const t = new LongPressTracker();
		t.begin(10, 10, 1000);
		expect(t.due(1000 + HELP_PRESS_MS - 1)).toBe(false);
		expect(t.due(1000 + HELP_PRESS_MS)).toBe(true);
		expect(t.remaining(1100)).toBe(HELP_PRESS_MS - 100);
	});
	it("tolerates a small drift", () => {
		const t = new LongPressTracker();
		t.begin(10, 10, 0);
		expect(t.move(10 + HELP_SLOP_PX - 1, 10)).toBe(false);
		expect(t.due(HELP_PRESS_MS)).toBe(true);
	});
	it("a swipe cancels it for good, even if the finger comes back", () => {
		const t = new LongPressTracker();
		t.begin(0, 0, 0);
		expect(t.move(HELP_SLOP_PX + 5, 0)).toBe(true);
		expect(t.move(0, 0)).toBe(false);
		expect(t.due(HELP_PRESS_MS * 2)).toBe(false);
		expect(t.active).toBe(false);
		expect(t.remaining(0)).toBe(0);
	});
	it("a released press is not due", () => {
		const t = new LongPressTracker();
		t.begin(0, 0, 0);
		t.end();
		expect(t.due(10_000)).toBe(false);
		expect(t.active).toBe(false);
	});
	it("a new press starts clean after a swipe", () => {
		const t = new LongPressTracker();
		t.begin(0, 0, 0);
		t.move(100, 100);
		t.begin(5, 5, 50);
		expect(t.active).toBe(true);
		expect(t.due(50 + HELP_PRESS_MS)).toBe(true);
	});
});

describe("placeBubble", () => {
	const vp = { width: 400, height: 800 };
	it("sits below an icon near the top, centred on it", () => {
		const p = placeBubble({ left: 180, top: 10, right: 220, bottom: 50 }, 200, 80, vp);
		expect(p.above).toBe(false);
		expect(p.top).toBe(60);
		expect(p.left).toBe(100);
		expect(p.arrowX).toBe(100);
	});
	it("goes above an icon near the bottom", () => {
		const p = placeBubble({ left: 180, top: 740, right: 220, bottom: 780 }, 200, 80, vp);
		expect(p.above).toBe(true);
		expect(p.top).toBe(740 - 10 - 80);
	});
	it("stays inside the viewport at the edges and points the arrow at the icon", () => {
		const left = placeBubble({ left: 0, top: 10, right: 40, bottom: 50 }, 200, 80, vp);
		expect(left.left).toBe(8);
		expect(left.arrowX).toBeGreaterThanOrEqual(14);
		expect(left.arrowX).toBeLessThanOrEqual(200 - 14);
		const right = placeBubble({ left: 360, top: 10, right: 400, bottom: 50 }, 200, 80, vp);
		expect(right.left + 200).toBeLessThanOrEqual(400 - 8);
		expect(right.arrowX).toBeLessThanOrEqual(200 - 14);
	});
	it("never leaves the viewport vertically", () => {
		const p = placeBubble({ left: 0, top: 0, right: 40, bottom: 20 }, 100, 900, vp);
		expect(p.top).toBeGreaterThanOrEqual(8);
	});
});

describe("cleanHelp", () => {
	it("drops blank parts and refuses a nameless control", () => {
		expect(cleanHelp({ name: "  ", description: "x" })).toBeNull();
		expect(cleanHelp({ name: " Undo ", description: " ", hint: "" })).toEqual({ name: "Undo" });
		expect(cleanHelp({ name: "Pen", description: "Writes", hint: "Tap again" })).toEqual({ name: "Pen", description: "Writes", hint: "Tap again" });
	});
});

describe("the explanations", () => {
	it("belong to registry actions and exist in English and Italian", () => {
		for (const [id, key] of Object.entries(ACTION_HELP)) {
			expect(actionById(id), id).toBeDefined();
			expect(en[key], key).toBeTruthy();
			expect(itMessages[key], key).toBeTruthy();
		}
		for (const key of Object.values(TOOL_HELP)) {
			expect(en[key], key).toBeTruthy();
			expect(itMessages[key], key).toBeTruthy();
		}
	});
	it("cover every fixed toolbar action", () => {
		for (const a of ACTIONS.filter((x) => x.surfaces.includes("toolbar") && !x.id.startsWith("tool-"))) expect(ACTION_HELP[a.id], a.id).toBeDefined();
	});
	it("the setting is on by default and listed", () => {
		expect(DEFAULT_SETTINGS.iconHelp).toBe(true);
		expect(settingSpecs().some((s) => s.id === "iconHelp")).toBe(true);
	});
});
