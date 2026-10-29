import { describe, expect, it } from "vitest";
import { FULL_CHECK_LIMIT, freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import { CURRENT_VERSION, FORMAT_ID } from "../src/model/types";
import { createStroke } from "../src/model/document";
import { line, sampleDocument } from "./helpers";

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

describe("highlighter (v2)", () => {
	it("round-trips highlighter strokes", () => {
		const doc = sampleDocument(1);
		doc.pages[0]!.strokes.push(createStroke("#facc15", 10, [[10, 10, 0.5], [50, 10, 0.5]], "highlighter"));
		const r = parse(serialize(doc));
		expect(r.ok && r.doc).toEqual(doc);
	});
});

describe("serializeChecked", () => {
	it("produces exactly serialize() output", () => {
		const doc = sampleDocument(20);
		const r = serializeChecked(doc);
		expect(r.ok && r.text).toBe(serialize(doc));
	});

	it("parsed strokes are frozen", () => {
		const r = parse(serialize(sampleDocument(1)));
		if (!r.ok) throw new Error(r.message);
		const s = r.doc.pages[0]!.strokes[0]!;
		expect(Object.isFrozen(s)).toBe(true);
		expect(() => { (s.points as unknown as number[][])[0]![0] = 5; }).toThrow();
	});

	it("rejects a document with duplicate stroke ids", () => {
		const doc = sampleDocument(1);
		const a = doc.pages[0]!.strokes[0]!;
		doc.pages[0]!.strokes.push({ ...a, points: [[1, 1, 0.5]] });
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("rejects invalid strokes and NaN", () => {
		const doc = sampleDocument(1);
		doc.pages[0]!.strokes.push({ ...line(0, 0, 1, 1), points: [[Number.NaN, 1, 0.5]] });
		expect(serializeChecked(doc).ok).toBe(false);
		const doc2 = sampleDocument(1);
		doc2.pages[0]!.strokes.push({ ...line(0, 0, 1, 1), color: "red" });
		expect(serializeChecked(doc2).ok).toBe(false);
	});

	it("incremental check on a large document matches the full parse", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		// Enough strokes to pass FULL_CHECK_LIMIT.
		while (serialize(doc).length < FULL_CHECK_LIMIT * 1.2) {
			for (let i = 0; i < 200; i++) page.strokes.push(freezeStroke(line(i % 500, (i * 7) % 800, (i % 500) + 30, ((i * 7) % 800) + 10, 30)));
		}
		const first = serializeChecked(doc);
		const again = serializeChecked(doc); // second run uses the per-stroke cache
		expect(first.ok && again.ok).toBe(true);
		if (!first.ok || !again.ok) return;
		expect(first.text.length).toBeGreaterThan(FULL_CHECK_LIMIT);
		expect(again.text).toBe(first.text);
		const full = parse(first.text);
		expect(full.ok && serialize(full.doc)).toBe(first.text);
		// A bad stroke added later is still caught by the incremental path.
		page.strokes.push({ ...line(0, 0, 1, 1), width: -1 });
		expect(serializeChecked(doc).ok).toBe(false);
	});
});
