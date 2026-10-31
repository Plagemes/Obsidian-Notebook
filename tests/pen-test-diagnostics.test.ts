import { describe, expect, it } from "vitest";
import { describeDecision } from "../src/ink/button-contact";
import { EventLog, type LoggedEvent } from "../src/ink/pen-button";

// 0.12.5: the Pen button test writes what a developer needs from one pasted log: times relative to the pen's landing and lift,
// the pointer type, button / buttons and pressure of every line, the plugin's signal and decision beside the event that caused
// them, a tap / drag summary at the lift, and whether a menu would come from a tap or from the hover-click timer.

const ev = (e: Partial<LoggedEvent> & { kind: string; t: number }): LoggedEvent => ({ pointerType: "pen", button: -1, buttons: 0, pressure: 0, x: 400, y: 300, ...e });
const down = (t: number, over: Partial<LoggedEvent> = {}) => ev({ kind: "pointerdown", t, button: 0, buttons: 1, pressure: 0.5, ...over });
const move = (t: number, x: number, over: Partial<LoggedEvent> = {}) => ev({ kind: "pointermove", t, buttons: 1, pressure: 0.5, x, ...over });
const up = (t: number, x = 400) => ev({ kind: "pointerup", t, button: 0, x });
const bare = (t: number) => ev({ kind: "contextmenu", t, pointerType: "", pressure: undefined, button: -1 });

describe("Pen button test log: relative times", () => {
	it("every line after the landing carries the time since it, and every line after the lift the time since the lift", () => {
		const log = new EventLog();
		log.add(down(1000));
		log.add(move(1040, 401));
		log.add(up(1090));
		log.add(bare(1200));
		const lines = log.text().split("\n");
		expect(lines[0]).toContain("dDown=+0ms");
		expect(lines[1]).toContain("dDown=+40ms");
		expect(lines[2]).toContain("dDown=+90ms");
		expect(lines[2]).not.toContain("dUp");
		expect(lines[3]).toContain("contextmenu");
		expect(lines[3]).toContain("dDown=+200ms");
		expect(lines[3]).toContain("dUp=+110ms");
	});

	it("keeps the pointer type, button, buttons and pressure on the line", () => {
		const log = new EventLog();
		log.add(down(1000, { buttons: 3, button: 2, pressure: 0.42 }));
		const line = log.text();
		expect(line).toContain("type=pen");
		expect(line).toContain("button=2");
		expect(line).toContain("buttons=3");
		expect(line).toContain("pressure=0.42");
	});

	it("a lift says how long the contact lasted and whether the nib stayed within the still radius (tap) or went beyond it (drag)", () => {
		const tap = new EventLog();
		tap.add(down(1000));
		tap.add(move(1030, 403));
		tap.add(up(1090));
		expect(tap.text()).toContain("contact 90 ms, farthest 3 px from where it landed: still (a tap)");
		const drag = new EventLog();
		drag.add(down(1000));
		drag.add(move(1030, 450));
		drag.add(up(1090, 460));
		expect(drag.text()).toContain("farthest 50 px from where it landed: moved (a drag)");
	});

	it("a new landing starts the clock again", () => {
		const log = new EventLog();
		log.add(down(1000));
		log.add(up(1090));
		log.add(down(2000));
		const last = log.text().split("\n").pop()!;
		expect(last).toContain("dDown=+0ms");
		expect(last).not.toContain("dUp");
	});
});

describe("Pen button test log: signal and decision next to the event", () => {
	it("a contextmenu before a tap: the decision changes are written at the events that caused them", () => {
		const log = new EventLog();
		log.add(bare(1000));
		log.add(down(1100));
		log.add(up(1190));
		const text = log.text();
		expect(text).toContain("decision: waiting (tap: menu, drag: eraser)");
		expect(text).toContain("decision: menu (tap)");
		expect(log.decisionText).toBe("menu (tap)");
	});

	it("a drag shows eraser (drag) at the move that left the still radius", () => {
		const log = new EventLog();
		log.add(bare(1000));
		log.add(down(1100));
		log.add(move(1130, 440));
		const lines = log.text().split("\n");
		expect(lines[lines.length - 1]).toContain("decision: eraser (drag)");
	});
});

describe("Pen button test log: a menu from the hover-click timer is told apart from a tap", () => {
	it("a bare contextmenu with no pen contact: after the before-window the log says it opens the menu as a hover click", () => {
		const log = new EventLog(80, { beforeMs: 500, afterMs: 350 });
		log.add(bare(1000));
		expect(log.hoverWaiting).toBe(true);
		log.tick(1400);
		expect(log.hoverWaiting).toBe(true);
		expect(log.decisionText).toBe("waiting (tap: menu, drag: eraser)");
		log.tick(1600);
		expect(log.hoverWaiting).toBe(false);
		expect(log.decisionText).toBe("menu (hover click: no pen contact within 500 ms of the contextmenu)");
		expect(log.text()).toContain("plugin: no pen contact within 500 ms of the contextmenu at 1.000s => decision: menu (hover click");
	});

	it("a pen contact that lands within the window is the contact the contextmenu belongs to: no hover click", () => {
		const log = new EventLog(80, { beforeMs: 500, afterMs: 350 });
		log.add(bare(1000));
		log.add(down(1300));
		log.tick(2000);
		expect(log.text()).not.toContain("hover click");
		expect(log.hoverWaiting).toBe(false);
	});

	it("a contextmenu that arrives later than the window after the pen landing is a hover click even when a contact was just before", () => {
		const log = new EventLog(80, { beforeMs: 500, afterMs: 350 });
		log.add(down(1000));
		log.add(move(1100, 500));
		log.add(up(1200, 500));
		log.add(bare(2500));
		log.tick(3100);
		expect(log.decisionText).toContain("hover click");
	});

	it("with the side button set to a tool without a menu the timer decides nothing to open", () => {
		const log = new EventLog(80, { beforeMs: 500, afterMs: 350 }, { enabled: true, menuAllowed: false });
		log.add(bare(1000));
		log.tick(1600);
		expect(log.decisionText).toBe("ignored: no pen contact");
	});

	it("describeDecision names the three ways a menu is reached", () => {
		expect(describeDecision({ kind: "menu", via: "tap" })).toBe("menu (tap)");
		expect(describeDecision({ kind: "menu", via: "late-tap" })).toBe("menu (tap, contextmenu after the lift)");
		expect(describeDecision({ kind: "menu", via: "hover", ms: 500 })).toContain("hover click");
	});
});
