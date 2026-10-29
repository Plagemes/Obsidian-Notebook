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

	it("migrates v0 to the current version", () => {
		const r = parse(JSON.stringify(v0));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.migratedFrom).toBe(0);
		expect(r.doc.format).toBe(FORMAT_ID);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages).toHaveLength(1);
		const [a, b] = r.doc.pages[0]!.strokes;
		expect(a).toMatchObject({ tool: "pen", color: "#ff0000", width: 3, points: [[10.12, 20.46, 0.25], [11, 21, 0.5]] });
		expect(b).toMatchObject({ color: "#0000ff", width: 1.5, points: [[100, 100, 0.9]] });
		expect(a!.id).not.toBe(b!.id);
	});

	it("migrates v1 to v2 without changing strokes", () => {
		const v1 = {
			format: FORMAT_ID, version: 1, id: "doc", createdAt: "2026-10-29T10:00:00.000Z", modifiedAt: "2026-10-29T10:00:00.000Z",
			pages: [{ id: "p", width: 595.28, height: 841.89, paper: { kind: "grid", spacing: 14.17 },
				strokes: [{ id: "s", tool: "pen", color: "#1e1e1e", width: 2, points: [[1, 2, 0.5]] }] }],
		};
		const r = parse(JSON.stringify(v1));
		if (!r.ok) throw new Error(r.message);
		expect(r.migratedFrom).toBe(1);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes[0]).toEqual(v1.pages[0]!.strokes[0]);
	});

	it("accepts a v1 file that already uses a v2 tool, after migration", () => {
		const v1 = {
			format: FORMAT_ID, version: 1, id: "doc", createdAt: "x", modifiedAt: "x",
			pages: [{ id: "p", width: 1, height: 1, paper: { kind: "grid", spacing: 1 },
				strokes: [{ id: "s", tool: "highlighter", color: "#ffff00", width: 8, points: [[1, 2, 0.5]] }] }],
		};
		// Widening the tool set is what v2 is for; a v1 file with a v2 tool is still accepted after migration.
		expect(parse(JSON.stringify(v1)).ok).toBe(true);
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
