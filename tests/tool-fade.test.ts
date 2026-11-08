import { describe, expect, it } from "vitest";
import { cleanFadeSeconds, restoresOnPointer, swallowsFirstTouch, ToolFadeMachine } from "../src/ui/tool-fade";

const on = () => new ToolFadeMachine({ mode: "writing", delayMs: 2000 });

describe("ToolFadeMachine", () => {
	it("never fades when off", () => {
		const m = new ToolFadeMachine({ mode: "off", delayMs: 1000 });
		m.strokeStart(0);
		expect(m.faded(5000)).toBe(false);
		expect(m.nextChange(5000)).toBeNull();
	});

	it("fades after a stroke has lasted the delay, and wakes up exactly then", () => {
		const m = on();
		m.strokeStart(0);
		expect(m.faded(1999)).toBe(false);
		expect(m.nextChange(500)).toBe(1500);
		expect(m.faded(2000)).toBe(true);
		expect(m.nextChange(2500)).toBeNull(); // faded and still writing: nothing pending
	});

	it("keeps faded between strokes and returns the delay after the last one", () => {
		const m = on();
		m.strokeStart(0);
		m.strokeEnd(2500);
		expect(m.faded(2600)).toBe(true);
		expect(m.nextChange(2600)).toBe(1900);
		m.strokeStart(3000); // within the delay: same run
		m.strokeEnd(3500);
		expect(m.faded(5499)).toBe(true);
		expect(m.faded(5500)).toBe(false);
	});

	it("a short note does not flicker the bars", () => {
		const m = on();
		m.strokeStart(0);
		m.strokeEnd(300);
		expect(m.nextChange(1000)).toBe(1300);
		expect(m.faded(2000)).toBe(false);
		expect(m.faded(2400)).toBe(false);
	});

	it("a pause longer than the delay ends the run: the next stroke starts a new one", () => {
		const m = on();
		m.strokeStart(0);
		m.strokeEnd(3000);
		expect(m.faded(6000)).toBe(false);
		m.strokeStart(6000);
		expect(m.faded(6500)).toBe(false);
		expect(m.faded(8000)).toBe(true);
	});

	it("restore brings the bars back and the same stroke does not fade them again", () => {
		const m = on();
		m.strokeStart(0);
		expect(m.faded(2500)).toBe(true);
		m.restore();
		expect(m.faded(2600)).toBe(false);
		m.strokeEnd(2700);
		m.strokeStart(2800); // a new run
		expect(m.faded(3000)).toBe(false);
		expect(m.faded(4800)).toBe(true);
	});

	it("a selection or dialog blocks fading and ends a fade in progress", () => {
		const m = on();
		m.strokeStart(0);
		expect(m.faded(3000)).toBe(true);
		m.setBlocked(true);
		expect(m.faded(3100)).toBe(false);
		m.strokeStart(3200);
		expect(m.faded(9000)).toBe(false);
		m.setBlocked(false);
		m.strokeEnd(9000);
		m.strokeStart(9100);
		expect(m.faded(9500)).toBe(false);
	});

	it("turning the mode off clears the fade", () => {
		const m = on();
		m.strokeStart(0);
		expect(m.faded(3000)).toBe(true);
		m.configure({ mode: "off", delayMs: 2000 });
		expect(m.faded(3100)).toBe(false);
	});

	it("a stroke end without a start is ignored", () => {
		const m = on();
		m.strokeEnd(100);
		expect(m.faded(5000)).toBe(false);
		expect(m.nextChange(5000)).toBeNull();
	});
});

describe("restore rules", () => {
	it("pen hover over a bar restores, pen over the canvas does not", () => {
		expect(restoresOnPointer("pen", true, false, 0)).toBe(true);
		expect(restoresOnPointer("pen", false, true, 0)).toBe(false);
		expect(restoresOnPointer("pen", true, false, 1)).toBe(false);
	});
	it("a finger restores outside the canvas or on a bar, not on the canvas", () => {
		expect(restoresOnPointer("touch", false, false, 1)).toBe(true);
		expect(restoresOnPointer("touch", true, false, 1)).toBe(true);
		expect(restoresOnPointer("touch", false, true, 1)).toBe(false);
	});
	it("only a finger or mouse press on a faded bar is swallowed, and only when the setting says so", () => {
		expect(swallowsFirstTouch(true, true, "touch")).toBe(true);
		expect(swallowsFirstTouch(true, true, "mouse")).toBe(true);
		expect(swallowsFirstTouch(true, true, "pen")).toBe(false);
		expect(swallowsFirstTouch(true, false, "touch")).toBe(false);
		expect(swallowsFirstTouch(false, true, "touch")).toBe(false);
	});
	it("cleans stored delays", () => {
		expect(cleanFadeSeconds(3.4)).toBe(3);
		expect(cleanFadeSeconds(99)).toBe(6);
		expect(cleanFadeSeconds(0)).toBe(1);
		expect(cleanFadeSeconds("x")).toBe(2);
	});
});
