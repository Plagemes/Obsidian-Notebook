import { describe, expect, it } from "vitest";
import { CTX_LIFT_GAP, MAP_BL_GAP, contextLift, mapOffset } from "../src/ui/dock-metrics";

// Review fix: the floating pieces of the bottom corners read the contextual bar and the minimap sizes instead of overlapping them.
describe("dock metrics", () => {
	it("lifts the bottom-left pieces by the height of the contextual bar, and not at all when it is hidden", () => {
		expect(contextLift(0)).toBe(0);
		expect(contextLift(52)).toBe(52 + CTX_LIFT_GAP);
		expect(contextLift(52.2)).toBe(53 + CTX_LIFT_GAP);
	});

	it("offsets the pieces to the right of a minimap parked at the bottom left only", () => {
		expect(mapOffset("bl", true, 195)).toBe(195 + MAP_BL_GAP);
		expect(mapOffset("br", true, 195)).toBe(0);
		expect(mapOffset("tl", true, 195)).toBe(0);
		expect(mapOffset("bl", false, 195)).toBe(0);
		expect(mapOffset("bl", true, 0)).toBe(0);
	});
});
