import { describe, expect, it } from "vitest";
import {
	ALL_INPUT_CLASSES, effectiveToolbarSize, formatHotkey, InputDetector, inputClass, isInputPref, kindOfPointer, labelWithHotkey, PALM_MS,
	resolveInput, showsShortcutHints, SWITCH_AFTER,
} from "../src/ui/input-layout";

describe("InputDetector", () => {
	it("starts as the pen layout and ignores unknown pointer types", () => {
		const d = new InputDetector();
		expect(d.current).toBe("pen");
		expect(d.feed("", 0, false)).toBeNull();
		expect(d.feed("unknown", 1, false)).toBeNull();
	});

	it("switches only after consistent events in a row", () => {
		const d = new InputDetector();
		for (let i = 0; i < SWITCH_AFTER - 1; i++) expect(d.feed("mouse", 5000 + i, false)).toBeNull();
		expect(d.feed("mouse", 5100, false)).toBe("mouse");
		expect(d.current).toBe("mouse");
		expect(d.feed("mouse", 5200, false)).toBeNull();
	});

	it("a different device in between starts the count again", () => {
		const d = new InputDetector("mouse");
		d.feed("touch", 5000, false);
		d.feed("touch", 5001, false);
		d.feed("pen", 5002, false); // pen run begins; touch run is broken
		d.feed("touch", 9000, false);
		expect(d.feed("touch", 9001, false)).toBeNull();
		expect(d.feed("touch", 9002, false)).toBe("touch");
	});

	it("never switches mid-stroke and forgets the run it had", () => {
		const d = new InputDetector("pen");
		d.feed("mouse", 5000, false);
		d.feed("mouse", 5001, false);
		expect(d.feed("mouse", 5002, true)).toBeNull(); // busy: ignored, run reset
		expect(d.feed("mouse", 5003, false)).toBeNull();
		expect(d.feed("mouse", 5004, false)).toBeNull();
		expect(d.feed("mouse", 5005, false)).toBe("mouse");
	});

	it("a palm touching right after the pen neither switches nor breaks the pen", () => {
		const d = new InputDetector("pen");
		for (let i = 0; i < 20; i++) {
			d.feed("pen", 1000 + i * 100, false);
			expect(d.feed("touch", 1000 + i * 100 + 10, false)).toBeNull();
		}
		expect(d.current).toBe("pen");
	});

	it("a finger counts again once the pen has been away for the palm window", () => {
		const d = new InputDetector("pen");
		d.feed("pen", 1000, false);
		const t = 1000 + PALM_MS + 1;
		d.feed("touch", t, false);
		d.feed("touch", t + 10, false);
		expect(d.feed("touch", t + 20, false)).toBe("touch");
	});

	it("a pen hover returns the layout to the pen after a few events", () => {
		const d = new InputDetector("touch");
		d.feed("pen", 10, false);
		d.feed("pen", 20, false);
		expect(d.feed("pen", 30, false)).toBe("pen");
	});
});

describe("layout decisions", () => {
	it("a pinned device wins over the detected one", () => {
		expect(resolveInput("auto", "mouse")).toBe("mouse");
		expect(resolveInput("touch", "mouse")).toBe("touch");
		expect(resolveInput("pen", "touch")).toBe("pen");
	});

	it("classes are nb-input-<kind> and the full list covers them", () => {
		expect(inputClass("touch")).toBe("nb-input-touch");
		expect(ALL_INPUT_CLASSES).toEqual(["nb-input-pen", "nb-input-touch", "nb-input-mouse"]);
	});

	it("a finger gets a size more, the pen and the mouse keep the chosen size", () => {
		expect(effectiveToolbarSize("compact", "touch")).toBe("normal");
		expect(effectiveToolbarSize("normal", "touch")).toBe("large");
		expect(effectiveToolbarSize("large", "touch")).toBe("large");
		for (const k of ["pen", "mouse"] as const) for (const s of ["compact", "normal", "large"] as const) expect(effectiveToolbarSize(s, k)).toBe(s);
	});

	it("only the mouse shows shortcut hints", () => {
		expect(showsShortcutHints("mouse")).toBe(true);
		expect(showsShortcutHints("pen")).toBe(false);
		expect(showsShortcutHints("touch")).toBe(false);
	});

	it("validates the setting and pointer types", () => {
		expect(isInputPref("auto") && isInputPref("pen") && isInputPref("touch") && isInputPref("mouse")).toBe(true);
		expect(isInputPref("finger")).toBe(false);
		expect(isInputPref(3)).toBe(false);
		expect(kindOfPointer("pen")).toBe("pen");
		expect(kindOfPointer("")).toBeNull();
	});
});

describe("hotkey hints", () => {
	it("formats modifiers in a fixed order for Windows and Mac", () => {
		expect(formatHotkey({ modifiers: ["Shift", "Mod"], key: "z" }, false)).toBe("Ctrl+Shift+Z");
		expect(formatHotkey({ modifiers: ["Mod", "Shift"], key: "z" }, true)).toBe("⌘⇧Z");
		expect(formatHotkey({ modifiers: ["Alt"], key: "ArrowLeft" }, false)).toBe("Alt+ArrowLeft");
		expect(formatHotkey({ key: " " }, false)).toBe("Space");
	});

	it("gives nothing for a hotkey without a key and ignores unknown modifiers", () => {
		expect(formatHotkey({ modifiers: ["Mod"], key: "" }, false)).toBeNull();
		expect(formatHotkey({ modifiers: ["Hyper"], key: "k" }, false)).toBe("K");
	});

	it("adds the first usable hotkey to a label, else leaves it alone", () => {
		expect(labelWithHotkey("Undo", [{ modifiers: ["Mod"], key: "z" }], false)).toBe("Undo (Ctrl+Z)");
		expect(labelWithHotkey("Undo", [{ key: "" }, { key: "u" }], false)).toBe("Undo (U)");
		expect(labelWithHotkey("Undo", [], false)).toBe("Undo");
	});
});
