import { describe, expect, it } from "vitest";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { InputPolicy } from "../src/ink/input-policy";

describe("stress document", () => {
	it("is deterministic and valid", () => {
		const a = stressDocument(500, 3, 7);
		const b = stressDocument(500, 3, 7);
		expect(serialize(a)).toBe(serialize(b));
		expect(a.pages).toHaveLength(3);
		expect(a.pages.reduce((n, p) => n + p.strokes.length, 0)).toBe(500);
		const r = parse(serialize(a));
		expect(r.ok).toBe(true);
		expect(serializeChecked(a).ok).toBe(true);
	});

	it("different seeds give different documents", () => {
		expect(serialize(stressDocument(50, 1, 1))).not.toBe(serialize(stressDocument(50, 1, 2)));
	});
});

describe("palm contact size", () => {
	it("ignores large touches when enabled", () => {
		const p = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500, palmContactPx: 40 });
		expect(p.route("touch", 1000, 0, 20)).toBe("navigate");
		expect(p.route("touch", 1000, 0, 60)).toBe("ignore");
		p.settings = { ...p.settings, palmContactPx: 0 };
		expect(p.route("touch", 1000, 0, 60)).toBe("navigate");
	});
});
