import { describe, expect, it } from "vitest";
import { InputPolicy } from "../src/ink/input-policy";
import { symbolTapPlaces, type SymbolTap } from "../src/ink/symbols";

const policy = (extra: Partial<ConstructorParameters<typeof InputPolicy>[0]> = {}): InputPolicy =>
	new InputPolicy({ fingerDrawing: true, palmRejectionMs: 600, penButton: "radial-eraser", ...extra });

const tap = (extra: Partial<SymbolTap> = {}): SymbolTap => ({
	pointerType: "touch", timeStamp: 10_000, button: 0, buttons: 1, pressure: 0.5, contact: 20, x: 300, y: 300, width: 800, height: 1000, ...extra,
});

describe("symbol tap and palm rejection", () => {
	it("a finger places when nothing else is going on", () => {
		expect(symbolTapPlaces(policy(), tap())).toBe(true);
	});

	it("a finger does not place while the pen is down", () => {
		const p = policy();
		p.setPenDown(true, 9_900);
		expect(symbolTapPlaces(p, tap())).toBe(false);
		p.setPenDown(false, 9_950);
		// ... nor right after it: the palm rejection time still runs.
		expect(symbolTapPlaces(p, tap({ timeStamp: 10_000 }))).toBe(false);
		expect(symbolTapPlaces(p, tap({ timeStamp: 9_950 + 599 }))).toBe(false);
		expect(symbolTapPlaces(p, tap({ timeStamp: 9_950 + 600 }))).toBe(true);
	});

	it("a pen hovering over the catcher keeps fingers from placing", () => {
		const p = policy();
		p.notePen(9_800);
		expect(symbolTapPlaces(p, tap())).toBe(false);
		expect(symbolTapPlaces(p, tap({ timeStamp: 10_500 }))).toBe(true);
	});

	it("the rejection time is the setting", () => {
		const p = policy({ palmRejectionMs: 2_000 });
		p.notePen(9_000);
		expect(symbolTapPlaces(p, tap())).toBe(false);
		expect(symbolTapPlaces(p, tap({ timeStamp: 11_100 }))).toBe(true);
	});

	it("a finger does not place in pen-only mode (write with finger off), a pen does", () => {
		const p = policy({ fingerDrawing: false });
		expect(symbolTapPlaces(p, tap())).toBe(false);
		expect(symbolTapPlaces(p, tap({ pointerType: "pen", timeStamp: 12_000, pressure: 0.4 }))).toBe(true);
	});

	it("a pen tap places even right after a pen event, and a mouse click places", () => {
		const p = policy();
		p.notePen(9_999);
		expect(symbolTapPlaces(p, tap({ pointerType: "pen", pressure: 0.3 }))).toBe(true);
		expect(symbolTapPlaces(policy(), tap({ pointerType: "mouse", buttons: 1 }))).toBe(true);
	});

	it("the side button, the middle and the right mouse button do not place", () => {
		expect(symbolTapPlaces(policy(), tap({ pointerType: "pen", button: 0, buttons: 3, pressure: 0 }))).toBe(false);
		expect(symbolTapPlaces(policy(), tap({ pointerType: "mouse", button: 1, buttons: 4 }))).toBe(false);
		expect(symbolTapPlaces(policy(), tap({ pointerType: "mouse", button: 2, buttons: 2 }))).toBe(false);
	});

	it("a palm-sized contact and an edge touch do not place", () => {
		const p = policy({ palmContactPx: 60, edge: { enabled: true, widthPx: 24, left: true, right: true, top: false, bottom: false } });
		expect(symbolTapPlaces(p, tap({ contact: 90 }))).toBe(false);
		expect(symbolTapPlaces(p, tap({ x: 10 }))).toBe(false);
		expect(symbolTapPlaces(p, tap({ x: 790 }))).toBe(false);
		expect(symbolTapPlaces(p, tap({ x: 400 }))).toBe(true);
		// The edge zones are for touch only.
		expect(symbolTapPlaces(p, tap({ pointerType: "pen", x: 10, pressure: 0.5 }))).toBe(true);
	});

	it("an unknown pointer type places nothing", () => {
		expect(symbolTapPlaces(policy(), tap({ pointerType: "" }))).toBe(false);
	});
});
