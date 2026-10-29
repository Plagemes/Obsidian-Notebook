import { describe, expect, it } from "vitest";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION, FORMAT_ID } from "../src/model/types";
import { sampleDocument } from "./helpers";

describe("serialize / parse", () => {
	it("round-trips a document exactly", () => {
		const doc = sampleDocument(5);
		const text = serialize(doc);
		const result = parse(text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.doc).toEqual(doc);
		expect(result.migratedFrom).toBeNull();
		expect(serialize(result.doc)).toBe(text);
	});

	it("round-trips an empty page", () => {
		const doc = sampleDocument(0);
		const result = parse(serialize(doc));
		expect(result.ok && result.doc).toEqual(doc);
	});

	it("is valid JSON with format and version first", () => {
		const raw = JSON.parse(serialize(sampleDocument(1)));
		expect(Object.keys(raw).slice(0, 2)).toEqual(["format", "version"]);
		expect(raw.format).toBe(FORMAT_ID);
		expect(raw.version).toBe(CURRENT_VERSION);
	});

	it("writes one stroke per line", () => {
		const text = serialize(sampleDocument(4));
		expect(text.split("\n").filter((l) => l.includes('"tool":"pen"'))).toHaveLength(4);
	});

	it("drops unknown fields", () => {
		const raw = JSON.parse(serialize(sampleDocument(1)));
		raw.extra = 1;
		raw.pages[0].strokes[0].foo = "bar";
		const result = parse(JSON.stringify(raw));
		expect(result.ok).toBe(true);
		if (result.ok) expect(serialize(result.doc)).not.toContain("foo");
	});
});

describe("parse rejects corrupt files", () => {
	const valid = () => JSON.parse(serialize(sampleDocument(2)));
	const reason = (text: string) => {
		const r = parse(text);
		return r.ok ? "ok" : r.reason;
	};

	it.each([
		["empty file", ""],
		["whitespace only", "  \n"],
	])("%s", (_, text) => expect(reason(text)).toBe("empty"));

	it("truncated JSON (e.g. interrupted write)", () => {
		const text = serialize(sampleDocument(3));
		expect(reason(text.slice(0, text.length / 2))).toBe("json");
	});

	it("binary garbage", () => expect(reason("\u0000\u0001PK\u0003")).toBe("json"));

	it.each([
		["a JSON array", "[]"],
		["a number", "42"],
		["another JSON file", JSON.stringify({ name: "x" })],
		["wrong format id", JSON.stringify({ ...valid(), format: "excalidraw" })],
	])("%s", (_, text) => expect(reason(text)).toBe("not-notebook"));

	it("future version is reported, not parsed", () => {
		const r = parse(JSON.stringify({ ...valid(), version: CURRENT_VERSION + 1 }));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("future-version");
			expect(r.version).toBe(CURRENT_VERSION + 1);
		}
	});

	type Raw = ReturnType<typeof valid>;
	const mutations: Array<[string, (d: Raw) => void]> = [
		["no pages", (d) => { d.pages = []; }],
		["page without strokes array", (d) => { delete d.pages[0].strokes; }],
		["string coordinate", (d) => { d.pages[0].strokes[0].points[0][0] = "NaN"; }],
		["pressure > 1", (d) => { d.pages[0].strokes[0].points[0][2] = 1.5; }],
		["point with 2 values", (d) => { d.pages[0].strokes[0].points[0] = [1, 2]; }],
		["stroke without points", (d) => { d.pages[0].strokes[0].points = []; }],
		["bad colour", (d) => { d.pages[0].strokes[0].color = "red"; }],
		["zero width", (d) => { d.pages[0].strokes[0].width = 0; }],
		["unknown tool", (d) => { d.pages[0].strokes[0].tool = "laser"; }],
		["duplicate stroke id", (d) => { d.pages[0].strokes[1].id = d.pages[0].strokes[0].id; }],
		["unknown paper", (d) => { d.pages[0].paper = { kind: "dots" }; }],
		["missing id", (d) => { delete d.id; }],
		["non-integer version", (d) => { d.version = 0.5; }],
	];
	it.each(mutations)("%s", (_, mutate) => {
		const d = valid();
		mutate(d);
		expect(reason(JSON.stringify(d))).not.toBe("ok");
	});
});
