import { describe, expect, it } from "vitest";
import { InputPolicy } from "../src/ink/input-policy";
import { PressureModel } from "../src/ink/pressure";

describe("InputPolicy (palm rejection)", () => {
	it("pen and mouse draw, touch navigates by default", () => {
		const p = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500 });
		expect(p.route("pen", 0)).toBe("draw");
		expect(p.route("mouse", 0, 0)).toBe("draw");
		expect(p.route("mouse", 0, 1)).toBe("navigate");
		expect(p.route("mouse", 0, 2)).toBe("ignore");
		expect(p.route("touch", 10_000)).toBe("navigate");
	});

	it("with finger drawing on, touch draws only if the pen was not seen recently", () => {
		const p = new InputPolicy({ fingerDrawing: true, palmRejectionMs: 500 });
		expect(p.route("touch", 1000)).toBe("draw");
		p.notePen(2000); // hover
		expect(p.route("touch", 2300)).toBe("navigate");
		expect(p.route("touch", 2600)).toBe("draw");
	});

	it("ignores touch while the pen is down", () => {
		const p = new InputPolicy({ fingerDrawing: true, palmRejectionMs: 0 });
		p.setPenDown(true, 100);
		expect(p.route("touch", 5000)).toBe("ignore");
		p.setPenDown(false, 5000);
		expect(p.route("touch", 5001)).toBe("draw");
	});
});

describe("PressureModel", () => {
	const run = (m: PressureModel, type: string, values: number[]) => {
		m.begin();
		return values.map((v, i) => m.sample(type, v, i * 2, 0, i * 8));
	};

	it("uses real pen pressure once it varies", () => {
		const m = new PressureModel("auto");
		const out = run(m, "pen", [0.2, 0.35, 0.6, 0.8, 0.7]);
		expect(m.penPressureTrusted).toBe(true);
		expect(out.slice(2)).toEqual([0.6, 0.8, 0.7]);
	});

	it.each([0, 0.5, 1])("simulates pressure when the pen always reports %f", (c) => {
		const m = new PressureModel("auto");
		const out = run(m, "pen", Array<number>(30).fill(c));
		expect(m.penPressureTrusted).toBe(false);
		for (const p of out) {
			expect(p).toBeGreaterThan(0);
			expect(p).toBeLessThanOrEqual(1);
		}
	});

	it("simulated pressure is lower when moving fast", () => {
		const m = new PressureModel("auto");
		const last = (step: number) => {
			m.begin();
			let p = 0;
			for (let i = 0; i < 8; i++) p = m.sample("mouse", 0.5, i * step, 0, i * 16);
			return p;
		};
		expect(last(60)).toBeLessThan(last(0.1));
	});

	it("'simulated' mode ignores the pen pressure", () => {
		const m = new PressureModel("simulated");
		expect(run(m, "pen", [0.2, 0.4, 0.6, 0.8])).not.toEqual([0.2, 0.4, 0.6, 0.8]);
	});
});
