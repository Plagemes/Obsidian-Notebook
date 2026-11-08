/**
 * Format v20: the new pens (#35) — the tools "fountain", "brush" and "marker" and the optional stroke field `nib`: the v19 -> v20
 * migration, lenient read and strict write, staged loading, repair, merge keys, copies and the page information.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createStroke } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { mergeChangeCount, planMerge, strokeContentKey } from "../src/model/merge";
import { pageInfo } from "../src/model/page-info";
import { copyStroke, duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { AddStroke, History } from "../src/model/history";
import {
	CURRENT_VERSION, FORMAT_ID, isNewPen, isNibAngle, isNibPen, NIB_DEFAULT, RENDER_FREEHAND, RENDER_INK, TOOLS, TOOLS_V20,
	type NotebookDocument, type Stroke, type Tool,
} from "../src/model/types";
import { delAt, getAt, parseRaw, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-05T10:00:00.000Z";
const PTS: Array<[number, number, number]> = [[10, 10, 0.4], [30, 14, 0.6], [55, 30, 0.8], [80, 31, 0.5]];

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function pen(id: string, tool: Tool, over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#223344", 3, PTS.map((p) => [...p] as [number, number, number]), tool, RENDER_INK), id, ...over });
}

/** A notebook with one stroke of every tool, the nib pens with and without an angle. */
function penDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.strokes.push(
		pen("s-pen", "pen"), pen("s-hl", "highlighter"), pen("s-shape", "shape"),
		pen("s-fountain", "fountain", { nib: 120 }), pen("s-fountain-default", "fountain"), pen("s-brush", "brush"),
		pen("s-marker", "marker", { nib: 0, group: "g1" }), pen("s-marker2", "marker", { nib: 179, group: "g1", hidden: true }),
	);
	return doc;
}

function v19Raw(over: (page: Raw) => void = () => undefined): Raw {
	const page: Raw = {
		id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
		strokes: [
			{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 2, points: [[1, 2, 0.5], [3, 4, 0.5]] },
			{ id: "s2", tool: "highlighter", color: "#facc15", width: 14, render: 1, points: [[5, 6, 0.5], [7, 8, 0.5]] },
		],
	};
	over(page);
	return {
		format: FORMAT_ID, version: 19, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {}, pages: [page],
	};
}

describe("format v20: the tools and the nib", () => {
	it("is the current format and has the v19 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(20);
		expect(typeof MIGRATIONS[19]).toBe("function");
	});

	it("knows the new pens", () => {
		expect([...TOOLS]).toEqual(["pen", "highlighter", "shape", "fountain", "brush", "marker"]);
		expect([...TOOLS_V20]).toEqual(["fountain", "brush", "marker"]);
		expect(TOOLS.filter(isNewPen)).toEqual(["fountain", "brush", "marker"]);
		expect(TOOLS.filter(isNibPen)).toEqual(["fountain", "marker"]);
		expect(NIB_DEFAULT).toBe(45);
		expect([0, 45, 179].every(isNibAngle)).toBe(true);
		expect([-1, 180, 45.5, "45", NaN, null].some(isNibAngle)).toBe(false);
	});

	it("writes and reads every tool, and writes the same text again", () => {
		const doc = penDoc();
		const text = serialize(doc);
		const r = parsed(text);
		expect(r.migratedFrom).toBeNull();
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.strokes.map((s) => [s.tool, s.render, s.nib])).toEqual([
			["pen", 2, undefined], ["highlighter", 2, undefined], ["shape", 2, undefined],
			["fountain", 2, 120], ["fountain", 2, undefined], ["brush", 2, undefined],
			["marker", 2, 0], ["marker", 2, 179],
		]);
		expect(serialize(r.doc)).toBe(text);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("writes `nib` after `group` and before `points`, only when set", () => {
		const text = serialize(penDoc());
		const lines = text.split("\n").filter((l) => l.includes('"tool":'));
		expect(lines.find((l) => l.includes('"s-fountain"'))).toContain('"render":2,"nib":120,"points"');
		expect(lines.find((l) => l.includes('"s-fountain-default"'))).not.toContain('"nib"');
		expect(lines.find((l) => l.includes('"s-marker"'))).toContain('"render":2,"group":"g1","nib":0,"points"');
		expect(lines.find((l) => l.includes('"s-marker2"'))).toContain('"render":2,"hidden":true,"group":"g1","nib":179,"points"');
		expect(Object.keys(getAt<Raw>(parseRaw(text), ["pages", 0, "strokes", 3]))).toEqual(["id", "tool", "color", "width", "render", "nib", "points"]);
	});

	it("the strict reader refuses a new pen drawn with the old geometry, a nib where there is none and a nib out of range", () => {
		const text = serialize(penDoc());
		const withEdit = (edit: (raw: Raw) => void): string => {
			const raw = parseRaw(text);
			edit(raw);
			return JSON.stringify(raw);
		};
		const fountain = (k: string, v: unknown) => (raw: Raw) => setAt(raw, ["pages", 0, "strokes", 3, k], v);
		const tryStrict = (json: string) => {
			try {
				validate(JSON.parse(json));
				return null;
			} catch (e) {
				return (e as Error).message;
			}
		};
		expect(tryStrict(withEdit(fountain("render", 1)))).toContain("needs render version 2");
		expect(tryStrict(withEdit(fountain("nib", 180)))).toContain("nib");
		expect(tryStrict(withEdit(fountain("nib", -1)))).toContain("nib");
		expect(tryStrict(withEdit(fountain("nib", 12.5)))).toContain("nib");
		expect(tryStrict(withEdit(fountain("nib", "45")))).toContain("nib");
		expect(tryStrict(withEdit((raw) => setAt(raw, ["pages", 0, "strokes", 0, "nib"], 45)))).toContain("has no nib");
		expect(tryStrict(withEdit((raw) => setAt(raw, ["pages", 0, "strokes", 5, "nib"], 45)))).toContain("has no nib");
		expect(tryStrict(withEdit(fountain("tool", "quill")))).toContain("unknown tool");
		expect(tryStrict(text)).toBeNull();
	});

	it("the writer's check refuses a stroke that could not be read back", () => {
		const doc = penDoc();
		doc.pages[0]!.strokes.push(freezeStroke({ ...pen("bad-render", "brush"), render: RENDER_FREEHAND }));
		expect(serializeChecked(doc).ok).toBe(false);
		const doc2 = penDoc();
		doc2.pages[0]!.strokes.push(freezeStroke({ ...pen("bad-nib", "pen"), nib: 45 }));
		expect(serializeChecked(doc2).ok).toBe(false);
		const doc3 = penDoc();
		doc3.pages[0]!.strokes.push(freezeStroke({ ...pen("bad-angle", "fountain"), nib: 200 }));
		expect(serializeChecked(doc3).ok).toBe(false);
		expect(checkContent(doc3)).not.toBeNull();
	});
});

describe("format v20: lenient read", () => {
	const edited = (edit: (raw: Raw) => void): string => {
		const raw = parseRaw(serialize(penDoc()));
		edit(raw);
		return JSON.stringify(raw);
	};

	it("reads a tool name it does not know as a pen and counts it", () => {
		const r = parsed(edited((raw) => setAt(raw, ["pages", 0, "strokes", 3, "tool"], "quill")));
		const s = r.doc.pages[0]!.strokes[3]!;
		expect(s.tool).toBe("pen");
		// The unknown tool, and the nib a pen cannot have.
		expect(r.dropped).toBe(2);
		expect(s.nib).toBeUndefined();
		expect(s.points).toHaveLength(PTS.length);
		// Written back it is an ordinary pen stroke.
		expect(serializeChecked(r.doc, true).ok).toBe(true);
	});

	it("draws a new pen with the geometry it needs and counts it", () => {
		const r = parsed(edited((raw) => setAt(raw, ["pages", 0, "strokes", 5, "render"], 1)));
		expect(r.doc.pages[0]!.strokes[5]).toMatchObject({ tool: "brush", render: RENDER_INK });
		expect(r.dropped).toBe(1);
	});

	it("drops an invalid nib and keeps the stroke", () => {
		for (const bad of [180, -3, 7.5, "45", null, true]) {
			const r = parsed(edited((raw) => setAt(raw, ["pages", 0, "strokes", 3, "nib"], bad)));
			expect(r.doc.pages[0]!.strokes[3]!.nib).toBeUndefined();
			expect(r.doc.pages[0]!.strokes[3]!.tool).toBe("fountain");
			expect(r.dropped).toBe(1);
		}
	});

	it("drops a nib on a tool that has none", () => {
		const r = parsed(edited((raw) => setAt(raw, ["pages", 0, "strokes", 0, "nib"], 45)));
		expect(r.doc.pages[0]!.strokes[0]!.nib).toBeUndefined();
		expect(r.dropped).toBe(1);
	});

	it("a file of the next format is a newer format: it is not read, so it is never overwritten", () => {
		const r = parse(edited((raw) => setAt(raw, ["version"], CURRENT_VERSION + 1)));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("a v19 reader (0.21) opens this file read-only: its version is a newer one for it", () => {
		// The 0.21 reader supports up to 19 and refuses anything above as a newer format; this is what the version number guarantees.
		expect(CURRENT_VERSION).toBeGreaterThan(19);
	});
});

describe("format v20: migration from v19", () => {
	it("reads a v19 file unchanged apart from the version: nothing dropped", () => {
		const r = parsed(JSON.stringify(v19Raw()));
		expect(r.migratedFrom).toBe(19);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes.map((s) => [s.tool, s.render])).toEqual([["pen", 2], ["highlighter", 1]]);
		expect(r.dropped).toBeUndefined();
	});

	it.each(["fountain", "brush", "marker"])("refuses a v19 file with a %s stroke (it was not written by any version)", (tool) => {
		const r = parse(JSON.stringify(v19Raw((page) => setAt(page, ["strokes", 1, "tool"], tool))));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toContain(`'${tool}'`);
			expect(r.message).toContain("v20");
		}
	});

	it("drops a `nib` key of a v19 file (never ours) without counting it", () => {
		const r = parsed(JSON.stringify(v19Raw((page) => setAt(page, ["strokes", 0, "nib"], 45))));
		expect(r.doc.pages[0]!.strokes[0]!.nib).toBeUndefined();
		expect(r.dropped).toBeUndefined();
		expect(serialize(r.doc)).not.toContain('"nib"');
	});

	it("an unknown tool of a v19 file is read as a pen and counted, like a v20 file", () => {
		const r = parsed(JSON.stringify(v19Raw((page) => setAt(page, ["strokes", 0, "tool"], "quill"))));
		expect(r.doc.pages[0]!.strokes[0]!.tool).toBe("pen");
		expect(r.dropped).toBe(1);
	});

	it("a malformed page is left to validation", () => {
		const raw = v19Raw();
		delAt(raw, ["pages", 0, "strokes"]);
		expect(parse(JSON.stringify(raw)).ok).toBe(false);
	});
});

describe("format v20: staged loading", () => {
	function bigV19(): string {
		const doc = stressDocument(6000, 3, 7);
		return serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 19`);
	}

	it("stages a large v19 file, ignoring the v20 keys of every stroke", () => {
		const text = bigV19().replace(/"render":1,"points"/, '"render":1,"nib":10,"points"');
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		expect(text).toContain('"nib":10');
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(19);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.strokes.every((s) => s.nib === undefined))).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("refuses a new pen in any page of a large v19 file, as the whole-file read does", () => {
		// The third page is not the one shown first: it is refused when its turn comes.
		const parts = bigV19().split('"tool":"pen"');
		expect(parts.length).toBeGreaterThan(100);
		const text = parts.slice(0, -30).join('"tool":"pen"') + '"tool":"fountain"' + parts.slice(-30).join('"tool":"pen"');
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("exists only from v20");
	});

	it("stages a large v20 file with new pens page by page and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7, RENDER_INK);
		const page = doc.pages[1]!;
		page.strokes[0] = pen(page.strokes[0]!.id, "fountain", { nib: 33 });
		page.strokes[1] = pen(page.strokes[1]!.id, "brush");
		page.strokes[2] = pen(page.strokes[2]!.id, "marker");
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[1]!.strokes.slice(0, 3).map((s) => [s.tool, s.nib])).toEqual([["fountain", 33], ["brush", undefined], ["marker", undefined]]);
		expect(serialize(r.doc)).toBe(text);
	});
});

describe("format v20: repair", () => {
	it("keeps the new pens and their nib in a salvaged file", () => {
		const doc = stressDocument(40, 2, 3, RENDER_INK);
		const first = doc.pages[0]!;
		first.strokes[0] = pen(first.strokes[0]!.id, "fountain", { nib: 90 });
		first.strokes[1] = pen(first.strokes[1]!.id, "brush");
		first.strokes[2] = pen(first.strokes[2]!.id, "marker", { nib: 5 });
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const got = r.doc.pages[0]!.strokes;
		expect(got.slice(0, 3).map((s) => [s.tool, s.render, s.nib])).toEqual([["fountain", 2, 90], ["brush", 2, undefined], ["marker", 2, 5]]);
		expect(parse(r.text).ok).toBe(true);
	});

	it("repairs a new pen drawn with the old geometry and an invalid nib", () => {
		const doc = penDoc();
		const raw = parseRaw(serialize(doc));
		setAt(raw, ["pages", 0, "strokes", 5, "render"], 1);
		setAt(raw, ["pages", 0, "strokes", 3, "nib"], 500);
		const text = JSON.stringify(raw, null, "\t");
		const r = repairNotebookText(text.slice(0, text.length - 20));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const byId = new Map(r.doc.pages[0]!.strokes.map((s) => [s.id, s]));
		expect(byId.get("s-brush")?.render).toBe(RENDER_INK);
		expect(byId.get("s-fountain")?.nib).toBeUndefined();
		expect(parse(r.text).ok).toBe(true);
	});
});

describe("format v20: copies, merge and information", () => {
	it("a copy of a stroke keeps its nib", () => {
		const s = pen("a", "fountain", { nib: 77 });
		expect(copyStroke(s, "b").nib).toBe(77);
		expect(copyStroke(pen("c", "brush"), "d").nib).toBeUndefined();
		const doc = penDoc();
		const dup = duplicatePage(doc.pages[0]!);
		expect(dup.strokes.map((x) => [x.tool, x.nib])).toEqual(doc.pages[0]!.strokes.map((x) => [x.tool, x.nib]));
	});

	it("the merge content key tells a nib angle and a tool apart", () => {
		const a = pen("a", "fountain", { nib: 10 });
		const b = pen("b", "fountain", { nib: 11 });
		const c = pen("c", "fountain");
		const d = pen("d", "marker");
		expect(new Set([a, b, c, d].map(strokeContentKey)).size).toBe(4);
		expect(strokeContentKey(pen("x", "fountain", { nib: 10 }))).toBe(strokeContentKey(a));
		// Strokes that exist since v2 keep the key they always had.
		expect(strokeContentKey(pen("p", "pen"))).toBe(JSON.stringify(["pen", "#223344", 3, 2, PTS]));
	});

	it("merges a copy that has a new pen stroke the main does not, and a different nib as a different stroke", () => {
		const main = penDoc();
		const other = parsed(serialize(main)).doc;
		other.pages[0]!.strokes.push(pen("extra", "brush", { color: "#aa0000" }));
		const changed = other.pages[0]!.strokes.find((s) => s.id === "s-fountain")!;
		other.pages[0]!.strokes[other.pages[0]!.strokes.indexOf(changed)] = freezeStroke({ ...changed, id: "s-fountain-other", nib: 121 });
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		expect(plan.summary).toMatchObject({ strokesAdded: 2, identical: 7 });
		new History(() => main, 500, checkContent).execute(plan.command!);
		const tools = main.pages[0]!.strokes.map((s) => [s.id, s.tool, s.nib]);
		expect(tools).toContainEqual(["extra", "brush", undefined]);
		expect(tools).toContainEqual(["s-fountain-other", "fountain", 121]);
		expect(planMerge(main, other).command).toBeNull();
		expect(serializeChecked(main, true).ok).toBe(true);
	});

	it("a nib stroke added through the history is saved and read back", () => {
		const doc = penDoc();
		const h = new History(() => doc, 500, checkContent);
		h.execute(new AddStroke("p1", pen("new", "marker", { nib: 99 }), doc.pages[0]!.strokes.length));
		const r = parsed(serialize(doc));
		expect(r.doc.pages[0]!.strokes[r.doc.pages[0]!.strokes.length - 1]).toMatchObject({ id: "new", tool: "marker", nib: 99 });
	});

	it("the page information counts the new pens with the pen", () => {
		const info = pageInfo(penDoc(), 0)!;
		expect(info.strokes.total).toBe(8);
		expect(info.strokes.byTool).toEqual({ pen: 6, highlighter: 1, shape: 1 });
	});
});
