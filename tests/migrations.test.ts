import { describe, expect, it } from "vitest";
import { detectVersion, MIGRATIONS } from "../src/model/migrations";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION, FORMAT_ID } from "../src/model/types";

const v0 = {
	strokes: [
		{ color: "#ff0000", size: 3, points: [{ x: 10.123, y: 20.456, p: 0.25 }, { x: 11, y: 21 }] },
		{ color: "#0000ff", size: 1.5, points: [{ x: 100, y: 100, p: 0.9 }] },
	],
};

describe("migrations", () => {
	it("has a step for every version below the current one", () => {
		for (let v = 0; v < CURRENT_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf("function");
	});

	it("detects versions", () => {
		expect(detectVersion(v0)).toBe(0);
		expect(detectVersion({ version: 1 })).toBe(1);
		expect(detectVersion({})).toBeNull();
		expect(detectVersion({ version: "1" })).toBeNull();
	});

	it("migrates v0 to v1", () => {
		const r = parse(JSON.stringify(v0));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.migratedFrom).toBe(0);
		expect(r.doc.format).toBe(FORMAT_ID);
		expect(r.doc.version).toBe(1);
		expect(r.doc.pages).toHaveLength(1);
		const [a, b] = r.doc.pages[0]!.strokes;
		expect(a).toMatchObject({ tool: "pen", color: "#ff0000", width: 3, points: [[10.12, 20.46, 0.25], [11, 21, 0.5]] });
		expect(b).toMatchObject({ color: "#0000ff", width: 1.5, points: [[100, 100, 0.9]] });
		expect(a!.id).not.toBe(b!.id);
	});

	it("migrated documents round-trip at the current version", () => {
		const r = parse(JSON.stringify(v0));
		if (!r.ok) throw new Error(r.message);
		const again = parse(serialize(r.doc));
		expect(again.ok && again.doc).toEqual(r.doc);
		expect(again.ok && again.migratedFrom).toBeNull();
	});

	it("reports malformed v0 data as invalid instead of throwing", () => {
		const r = parse(JSON.stringify({ strokes: [{ color: "#000000", size: 2, points: [{ x: "a", y: 1 }] }] }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("invalid");
		const bad = parse(JSON.stringify({ strokes: [{ color: "nope", size: 2, points: [{ x: 1, y: 1 }] }] }));
		expect(bad.ok).toBe(false);
	});
});
