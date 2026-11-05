// docs/schema/notebook-v18.schema.json against what the serializer really writes (roadmap #167).
// The schema is a published contract for other tools: a document the plugin writes must always satisfy it, and a document that
// breaks one of the writer's rules must not. The validator is a small dependency-free one (tests/json-schema-lite.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDocument, createStroke } from "../src/model/document";
import { formatOutline } from "../src/math/outline";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import {
	BOX_KINDS, CURRENT_VERSION, MARKER_KINDS, PAPER_KINDS, TOOLS,
	type GraphElement, type NotebookDocument, type Page, type PageElement, type Stroke,
} from "../src/model/types";
import { sampleDocument } from "./helpers";
import { delAt, getAt, parseRaw, setAt, type Raw, type RawPath } from "./raw-json";
import { SchemaValidator, type Json } from "./json-schema-lite";

const schemaText = readFileSync(new URL("../docs/schema/notebook-v18.schema.json", import.meta.url), "utf8");
const schema = JSON.parse(schemaText) as { [key: string]: Json };
const validator = new SchemaValidator(schema);

function errorsOf(text: string): string[] {
	return validator.validate(JSON.parse(text));
}

/** The text the plugin would write for `doc` (checked: re-parsed strictly), which must satisfy the schema. */
function written(doc: NotebookDocument): string {
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(`the serializer refused the test document: ${checked.message}`);
	return checked.text;
}

function stroke(id: string, extra: Partial<Stroke> = {}): Stroke {
	return { ...createStroke("#1e1e1e", 2, [[10, 10, 0.2], [20.5, 12.25, 0.5], [30, 15, 1]]), id, ...extra };
}

/** One document that uses every element type, every optional field and every enum value the format has. */
function fullDocument(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.id = "doc-full";
	const hex = "0123456789abcdef".repeat(4);
	const hex2 = "fedcba9876543210".repeat(4);
	const hex3 = "00112233445566778899aabbccddeeff".repeat(2);
	doc.assets = {
		[hex]: { id: hex, kind: "pdf", path: "Notebooks/_assets/" + hex + ".pdf", name: "Lecture 1.pdf", bytes: 123456 },
		[hex2]: { id: hex2, kind: "image", path: "Notebooks/_assets/" + hex2 + ".png", name: "scan.png", bytes: 2048 },
		[hex3]: { id: hex3, kind: "image", path: "Notebooks/_assets/" + hex3 + ".png", name: "cover.png", bytes: 0 },
	};
	doc.meta = {
		tags: ["physics", "year-2"],
		favorite: true,
		cover: "#3B82F6",
		bookmarks: ["p-ink", "p-pdf"],
		bookmarkInfo: {
			"p-ink": { title: "Start", color: "#ef4444", category: "important" },
			"p-pdf": { category: "my custom category" },
		},
		description: "Lecture notes",
		coverArt: { kind: "image", asset: hex3 },
	};
	doc.slides = [{ id: "s1", source: hex, page: 3, path: "Courses/lecture-1.pdf" }, { id: "s2", source: hex, page: 4 }];

	// Page 1: ink of every tool and render version, flags, groups, every element type.
	const strokes: Stroke[] = [
		stroke("st-pen", { slide: "s1", group: "g1" }),
		stroke("st-hl", { tool: "highlighter", color: "#facc15", width: 14, render: 2, group: "g1" }),
		stroke("st-shape", { tool: "shape", render: 2, hidden: true, slide: "s2" }),
		stroke("st-a"), stroke("st-b"), stroke("st-c"),
	];
	const graph: GraphElement = {
		id: "el-graph", type: "graph", x: 40, y: 400, width: 300, height: 200,
		view: { xMin: -10, xMax: 10, yMin: -5, yMax: 5 },
		functions: [
			{ id: "f1", kind: "cartesian", color: "#2563eb", expr: "a*sin(x)", min: -3, max: 3, width: 2, roots: true, extrema: true, intersections: true, tangent: 1, area: { from: 0, to: 2 }, label: "f" },
			{ id: "f2", kind: "parametric", color: "#dc2626", x: "cos(t)", y: "sin(t)", min: 0, max: 6.28, hidden: true },
			{ id: "f3", kind: "polar", color: "#16a34a", expr: "1+cos(t)" },
			{ id: "f4", kind: "implicit", color: "#9333ea", expr: "x^2+y^2=4" },
			{ id: "f5", kind: "piecewise", color: "#ea580c", pieces: [{ expr: "x", when: "x<0" }, { expr: "-x" }] },
		],
		params: [{ name: "a", value: 2, min: 0, max: 5, step: 0.5 }, { name: "b", value: 1, min: -1, max: 1 }],
		axes: false, grid: false, xStep: 2, yStep: 1, xLabel: "time", yLabel: "height", degrees: true,
		table: { fn: "f1", from: -2, step: 0.5, rows: 10 },
		group: "g2", locked: true, lockAt: 1_700_000_000_000,
	};
	const elements: PageElement[] = [
		{ id: "el-text", type: "text", x: 10, y: 20, width: 200, text: "Hello\nworld", fontSize: 14, color: "#000000", group: "g2" },
		{ id: "el-image", type: "image", asset: hex2, x: 10, y: 100, width: 120, height: 80, rotation: 0.5 },
		{ id: "el-m-min", type: "marker", kind: "star", x: 5, y: 5 },
		{ id: "el-m-full", type: "marker", kind: "homework", x: 5, y: 40, width: 100, height: 30, at: "2026-10-29T10:00:00.000Z", done: true, slide: 2, due: "2026-11-02", text: "Exercise 4" },
		{ id: "el-box", type: "box", kind: "theorem", x: 20, y: 200, width: 300, height: 90, title: "Pythagoras" },
		{ id: "el-eq-min", type: "equation", x: 20, y: 300, width: 80, height: 30, latex: "x^2", fontSize: 18, color: "#111111" },
		{ id: "el-eq-full", type: "equation", x: 120, y: 300, width: 90, height: 40, latex: "\\int_0^1 x\\,dx", fontSize: 20, color: "#111111", inline: true, numbered: true, outline: formatOutline([[[0, 0], [10, 0], [10, 10]]]) },
		graph,
		{ id: "el-ex", type: "excerpt", x: 350, y: 20, width: 150, height: 100, source: { notebook: "Notebooks/Other.notebook", doc: "doc-other", page: "pg-other", x: 10, y: 20, width: 150, height: 100 }, asset: hex2 },
		{ id: "el-ex-min", type: "excerpt", x: 350, y: 140, width: 150, height: 100, source: { notebook: "Notebooks/Other.notebook", doc: "doc-other", page: "pg-other", x: 0, y: 0, width: 50, height: 40 } },
		{ id: "el-sticky", type: "sticky", x: 400, y: 300, width: 150, height: 120, color: "#F59E0B", text: "Remember", fontSize: 14, collapsed: true, ink: ["st-a", "st-b"] },
		{ id: "el-sticky-min", type: "sticky", x: 400, y: 450, width: 150, height: 120, color: "#F59E0B", fontSize: 14 },
		{ id: "el-cb", type: "checkbox", x: 30, y: 650, size: 20, color: "#1f2430", checked: true, at: 1_700_000_000_001, taskAt: 1_700_000_000_002, label: "Read chapter 2", task: { path: "Notes/Tasks.md", block: "nb-abc123" } },
		{ id: "el-cb-min", type: "checkbox", x: 30, y: 690, size: 20, color: "#1f2430" },
	];
	const page1: Page = {
		id: "p-ink", width: 595.28, height: 841.89, paper: { kind: "cornell", spacing: 22.68 },
		tags: ["exam", "chapter-1"], infinite: false, strokes, elements,
		states: {
			parts: [{ id: "part1", name: "Block", pivot: [100, 100], items: ["st-a"] }, { id: "part2", pivot: [0, 0], items: ["st-b", "st-c"] }],
			list: [
				{ id: "state1", name: "Start", poses: [] },
				{ id: "state2", name: "Moved", poses: [{ part: "part1", dx: 10, dy: -5, rot: 45, scale: 1.5, hidden: true, color: "#ff0000" }, { part: "part2" }] },
			],
			active: "state2",
		},
		comments: [
			{ id: "c1", region: { x: 10, y: 10.5, width: 80, height: 24 }, text: "Check this", sketch: { strokes: [[0, 0, 100, 50, 200, 100]] }, author: "Tablet", created: 1_700_000_000_000, edited: 1_700_000_100_000, resolved: true },
			{ id: "c2", parent: "c1", text: "Done", author: "Phone", created: 1_700_000_200_000, edited: 1_700_000_300_000 },
			{ id: "c3", region: { x: 100, y: 100, width: 40, height: 40 }, text: "", sketch: { strokes: [[1, 1, 2, 2]] }, author: "", created: 0 },
		],
	};
	// Page 2: a PDF page with margins, locked, landscape, every other paper kind.
	const page2: Page = {
		id: "p-pdf", width: 841.89, height: 595.28, paper: { kind: "blank", spacing: 14.17 },
		background: { kind: "pdf", asset: hex, page: 3 }, margins: { left: 20, right: 0, bottom: 10 }, locked: true,
		infinite: true, strokes: [],
	};
	const page3: Page = {
		id: "p-img", width: 419.53, height: 595.28, paper: { kind: "millimetre", spacing: 2.83 },
		background: { kind: "image", asset: hex2 }, strokes: [stroke("st-img")],
	};
	const papers = PAPER_KINDS.map((kind, i): Page => ({ id: `p-paper-${i}`, width: 612, height: 792, paper: { kind, spacing: 14 }, strokes: [] }));
	doc.pages = [page1, page2, page3, ...papers];
	doc.position = { page: "p-ink", y: 250.5, at: "2026-10-29T12:00:00.000Z" };
	return doc;
}

describe("notebook-v18.schema.json: what the serializer writes validates", () => {
	it("is a well-formed draft 2020-12 schema for the current format version", () => {
		expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect((getAt(schema as Raw, ["properties", "version", "const"]))).toBe(CURRENT_VERSION);
		// The enums the schema repeats must be the ones the code has (a new tool, paper kind or marker kind needs a schema edit).
		expect(getAt(schema as Raw, ["$defs", "stroke", "properties", "tool", "enum"])).toEqual([...TOOLS]);
		expect(getAt(schema as Raw, ["$defs", "page", "properties", "paper", "properties", "kind", "enum"])).toEqual([...PAPER_KINDS]);
		expect(getAt(schema as Raw, ["$defs", "markerElement", "properties", "kind", "enum"])).toEqual([...MARKER_KINDS]);
		expect(getAt(schema as Raw, ["$defs", "boxElement", "properties", "kind", "enum"])).toEqual([...BOX_KINDS]);
	});

	it("accepts a new notebook", () => {
		expect(errorsOf(serialize(createDocument()))).toEqual([]);
	});

	it("accepts generated documents with ink", () => {
		for (const n of [0, 1, 7]) expect(errorsOf(serialize(sampleDocument(n)))).toEqual([]);
	});

	it("accepts a document that uses every element type and every optional field", () => {
		const doc = fullDocument();
		const text = written(doc);
		expect(errorsOf(text)).toEqual([]);
		// The test document really covers everything: every element type and the optional fields of the format are in the output.
		const raw = JSON.parse(text) as { pages: { elements?: { type: string }[] }[] };
		const types = new Set(raw.pages.flatMap((p) => (p.elements ?? []).map((e) => e.type)));
		expect([...types].sort()).toEqual(["box", "checkbox", "equation", "excerpt", "graph", "image", "marker", "sticky", "text"]);
		for (const key of [
			'"bookmarkInfo"', '"description"', '"coverArt"', '"position"', '"slides"', '"tags"', '"background"', '"margins"', '"infinite"', '"locked"',
			'"states"', '"comments"', '"hidden"', '"slide"', '"group"', '"lockAt"', '"outline"', '"taskAt"', '"sketch"', '"resolved"', '"inline"', '"numbered"',
			'"collapsed"', '"ink"', '"table"', '"params"', '"axes"', '"degrees"',
		]) expect(text, key).toContain(key);
		// ... and the writer keeps it (round trip), so the schema describes what is read back too.
		const back = parse(text);
		expect(back.ok).toBe(true);
	});

	it("accepts the same document after a read and write", () => {
		const first = parse(written(fullDocument()));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(errorsOf(serialize(first.doc))).toEqual([]);
	});
});

describe("notebook-v18.schema.json: invalid documents are refused", () => {
	const base = (): Raw => parseRaw(written(fullDocument()));
	const bad = (name: string, edit: (raw: Raw) => void): void => {
		it(name, () => {
			const raw = base();
			edit(raw);
			expect(validator.validate(raw).length).toBeGreaterThan(0);
		});
	};
	const set = (path: RawPath, value: unknown) => (raw: Raw) => setAt(raw, path, value);
	const del = (path: RawPath) => (raw: Raw) => delAt(raw, path);

	it("the untouched base document is valid (the negative cases below each break one rule)", () => {
		expect(validator.validate(base())).toEqual([]);
	});

	it("refuses things that are not notebooks", () => {
		for (const v of [null, 1, "x", [], {}, { format: "other", version: 18 }]) expect(validator.validate(v).length).toBeGreaterThan(0);
	});

	// Header.
	bad("wrong format id", set(["format"], "excalidraw"));
	bad("another version", set(["version"], 17));
	bad("version as a string", set(["version"], "18"));
	bad("no pages", set(["pages"], []));
	bad("missing id", del(["id"]));
	bad("missing meta", del(["meta"]));
	bad("missing assets", del(["assets"]));
	// Meta.
	bad("bad cover colour", set(["meta", "cover"], "blue"));
	bad("favorite not a boolean", set(["meta", "favorite"], "yes"));
	bad("description too long", set(["meta", "description"], "x".repeat(501)));
	bad("unknown cover art style", set(["meta", "coverArt"], { kind: "art", style: "plaid", seed: "1" }));
	bad("bookmark colour not a colour", set(["meta", "bookmarkInfo", "p-ink", "color"], "red"));
	// Assets and slides.
	bad("asset id not hexadecimal", set(["assets", "0123456789abcdef".repeat(4), "id"], "XYZ"));
	bad("asset kind unknown", set(["assets", "0123456789abcdef".repeat(4), "kind"], "video"));
	bad("asset bytes negative", set(["assets", "0123456789abcdef".repeat(4), "bytes"], -1));
	bad("slide page 0", set(["slides", 0, "page"], 0));
	// Pages.
	bad("page without strokes", del(["pages", 0, "strokes"]));
	bad("page width zero", set(["pages", 0, "width"], 0));
	bad("unknown paper kind", set(["pages", 0, "paper", "kind"], "tartan"));
	bad("paper spacing too small", set(["pages", 0, "paper", "spacing"], 0.1));
	bad("page locked false", set(["pages", 1, "locked"], false));
	bad("margins missing a side", del(["pages", 1, "margins", "bottom"]));
	bad("margin negative", set(["pages", 1, "margins", "left"], -1));
	bad("pdf background without a page number", del(["pages", 1, "background", "page"]));
	bad("background of an unknown kind", set(["pages", 1, "background"], { kind: "video", asset: "ab" }));
	bad("too many page tags", set(["pages", 0, "tags"], Array.from({ length: 51 }, (_, i) => `t${i}`)));
	// Strokes.
	bad("stroke with unknown tool", set(["pages", 0, "strokes", 0, "tool"], "brush"));
	bad("stroke without render", del(["pages", 0, "strokes", 0, "render"]));
	bad("stroke render 3", set(["pages", 0, "strokes", 0, "render"], 3));
	bad("stroke width negative", set(["pages", 0, "strokes", 0, "width"], -2));
	bad("stroke colour short", set(["pages", 0, "strokes", 0, "color"], "#fff"));
	bad("stroke without points", set(["pages", 0, "strokes", 0, "points"], []));
	bad("point with two numbers", set(["pages", 0, "strokes", 0, "points", 0], [1, 2]));
	bad("point with four numbers", set(["pages", 0, "strokes", 0, "points", 0], [1, 2, 0.5, 9]));
	bad("pressure above 1", set(["pages", 0, "strokes", 0, "points", 0, 2], 1.5));
	bad("pressure below 0", set(["pages", 0, "strokes", 0, "points", 0, 2], -0.1));
	bad("x as a string", set(["pages", 0, "strokes", 0, "points", 0, 0], "1"));
	bad("hidden false", set(["pages", 0, "strokes", 2, "hidden"], false));
	bad("stroke group too long", set(["pages", 0, "strokes", 0, "group"], "g".repeat(65)));
	// Elements.
	bad("element of an unknown type", set(["pages", 0, "elements", 0, "type"], "video"));
	bad("text without text", del(["pages", 0, "elements", 0, "text"]));
	bad("text size above 400", set(["pages", 0, "elements", 0, "fontSize"], 401));
	bad("image without asset", del(["pages", 0, "elements", 1, "asset"]));
	bad("image width negative", set(["pages", 0, "elements", 1, "width"], -1));
	bad("marker of an unknown kind", set(["pages", 0, "elements", 2, "kind"], "smiley"));
	bad("marker width without height", del(["pages", 0, "elements", 3, "height"]));
	bad("marker due date malformed", set(["pages", 0, "elements", 3, "due"], "02/11/2026"));
	bad("marker done false", set(["pages", 0, "elements", 3, "done"], false));
	bad("marker text too long", set(["pages", 0, "elements", 3, "text"], "x".repeat(301)));
	bad("box of an unknown kind", set(["pages", 0, "elements", 4, "kind"], "lemma"));
	bad("blank equation", set(["pages", 0, "elements", 5, "latex"], "   "));
	bad("equation without colour", del(["pages", 0, "elements", 5, "color"]));
	bad("graph without view", del(["pages", 0, "elements", 7, "view"]));
	bad("graph with 13 functions", (raw) => {
		const fns = getAt(raw, ["pages", 0, "elements", 7, "functions"]) as unknown[];
		for (let i = 0; i < 8; i++) fns.push({ id: `x${i}`, kind: "cartesian", color: "#000000", expr: "x" });
	});
	bad("graph function of an unknown kind", set(["pages", 0, "elements", 7, "functions", 0, "kind"], "spline"));
	bad("parametric function without y", del(["pages", 0, "elements", 7, "functions", 1, "y"]));
	bad("cartesian function without expr", del(["pages", 0, "elements", 7, "functions", 0, "expr"]));
	bad("piecewise function without pieces", del(["pages", 0, "elements", 7, "functions", 4, "pieces"]));
	bad("function min without max", del(["pages", 0, "elements", 7, "functions", 0, "max"]));
	bad("graph axes true", set(["pages", 0, "elements", 7, "axes"], true));
	bad("graph table rows 0", set(["pages", 0, "elements", 7, "table", "rows"], 0));
	bad("graph parameter named with a digit first", set(["pages", 0, "elements", 7, "params", 0, "name"], "1a"));
	bad("excerpt without source", del(["pages", 0, "elements", 8, "source"]));
	bad("excerpt source region empty", set(["pages", 0, "elements", 8, "source", "width"], 0));
	bad("sticky smaller than 48", set(["pages", 0, "elements", 10, "width"], 20));
	bad("sticky font above 72", set(["pages", 0, "elements", 10, "fontSize"], 100));
	bad("checkbox size 200", set(["pages", 0, "elements", 12, "size"], 200));
	bad("checkbox block id of someone else", set(["pages", 0, "elements", 12, "task", "block"], "abc123"));
	bad("checkbox time negative", set(["pages", 0, "elements", 12, "at"], -5));
	bad("checkbox time fractional", set(["pages", 0, "elements", 12, "at"], 1.5));
	bad("element lockAt as a string", set(["pages", 0, "elements", 7, "lockAt"], "now"));
	bad("element locked false", set(["pages", 0, "elements", 7, "locked"], false));
	// States.
	bad("state pose scale 0", set(["pages", 0, "states", "list", 1, "poses", 0, "scale"], 0));
	bad("state pose colour bad", set(["pages", 0, "states", "list", 1, "poses", 0, "color"], "red"));
	bad("state part without items", set(["pages", 0, "states", "parts", 0, "items"], []));
	bad("state pivot with one number", set(["pages", 0, "states", "parts", 0, "pivot"], [1]));
	bad("state without a name", del(["pages", 0, "states", "list", 0, "name"]));
	// Comments.
	bad("comment without author", del(["pages", 0, "comments", 0, "author"]));
	bad("comment region side 0", set(["pages", 0, "comments", 0, "region", "width"], 0));
	bad("comment time negative", set(["pages", 0, "comments", 0, "created"], -1));
	bad("comment text too long", set(["pages", 0, "comments", 0, "text"], "x".repeat(4001)));
	bad("comment sketch point outside the frame", set(["pages", 0, "comments", 0, "sketch", "strokes", 0, 0], 401));
	bad("comment sketch with fractions", set(["pages", 0, "comments", 0, "sketch", "strokes", 0, 0], 0.5));
	bad("reply with a region", set(["pages", 0, "comments", 1, "region"], { x: 0, y: 0, width: 5, height: 5 }));
	bad("reply with empty text", set(["pages", 0, "comments", 1, "text"], ""));
	bad("comment with neither region nor parent", del(["pages", 0, "comments", 0, "region"]));
	bad("comment resolved false", set(["pages", 0, "comments", 0, "resolved"], false));
	// Position.
	bad("position without a page", del(["position", "page"]));
	bad("position y negative", set(["position", "y"], -1));
});

describe("json-schema-lite", () => {
	it("refuses a keyword it does not implement instead of ignoring it", () => {
		const v = new SchemaValidator({ type: "object", patternProperties: { "^a": { type: "number" } } });
		expect(() => v.validate({})).toThrow(/unsupported schema keyword/);
	});

	it("counts string lengths in code points", () => {
		const v = new SchemaValidator({ type: "string", maxLength: 2 });
		expect(v.validate("😀😀")).toEqual([]);
		expect(v.validate("😀😀😀").length).toBe(1);
	});
});

describe("docs/format.md", () => {
	const guide = readFileSync(new URL("../docs/format.md", import.meta.url), "utf8");

	it("has a minimal example that satisfies the schema and that the plugin reads", () => {
		const block = /```json\n([\s\S]*?)\n```/.exec(guide);
		expect(block).not.toBeNull();
		const example = block![1]!;
		expect(errorsOf(example)).toEqual([]);
		const result = parse(example);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.migratedFrom).toBeNull();
	});

	it("names the schema file and the version it describes", () => {
		expect(guide).toContain("schema/notebook-v18.schema.json");
		expect(guide).toContain(`version ${CURRENT_VERSION}`);
	});
});
