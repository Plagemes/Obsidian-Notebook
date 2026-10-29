import { describe, expect, it } from "vitest";
import { createDocument, createStroke } from "../src/model/document";
import { MIGRATIONS } from "../src/model/migrations";
import { freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import {
	CURRENT_VERSION, FORMAT_ID, RENDER_FREEHAND, RENDER_INK, RENDER_VERSIONS, TOOLS,
	type NotebookDocument, type Point, type RenderVersion,
} from "../src/model/types";

const stamp = "2026-10-29T10:00:00.000Z";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rawStroke(id: string, tool = "pen"): Raw {
	return { id, tool, color: "#112233", width: 2, points: [[1, 2, 0.5], [3, 4, 0.6]] };
}

function oldDoc(version: number): Raw {
	return {
		format: FORMAT_ID, version, id: "doc", createdAt: stamp, modifiedAt: stamp,
		pages: [
			{ id: "p1", width: 595.28, height: 841.89, paper: { kind: "grid", spacing: 14.17 }, strokes: [rawStroke("a"), rawStroke("b", "highlighter")] },
			{ id: "p2", width: 595.28, height: 841.89, paper: { kind: "grid", spacing: 14.17 }, strokes: [rawStroke("c")] },
		],
	};
}

function mixedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	const pts: Point[] = [[1, 2, 0.5], [3, 4, 0.6]];
	let n = 0;
	for (const tool of TOOLS) {
		for (const render of RENDER_VERSIONS) {
			const s = createStroke("#112233", 2, pts.map((p) => [...p] as Point), tool, render);
			s.id = `s${n++}`;
			doc.pages[0]!.strokes.push(freezeStroke(s));
		}
	}
	return doc;
}

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

describe("format v5: per-stroke render", () => {
	it("is at version 5 and has a v4 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(5);
		expect(MIGRATIONS[4]).toBeTypeOf("function");
		expect(RENDER_FREEHAND).toBe(1);
		expect(RENDER_INK).toBe(2);
	});

	it("migrates a v4 file: every stroke becomes render 1, nothing else changes", () => {
		const v4: Raw = { ...oldDoc(4), meta: { tags: ["t"], favorite: true, cover: "#ff0000", bookmarks: ["p2"] }, assets: {} };
		const r = parsed(JSON.stringify(v4));
		expect(r.migratedFrom).toBe(4);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		const strokes = r.doc.pages.flatMap((p) => p.strokes);
		expect(strokes).toHaveLength(3);
		for (const s of strokes) expect(s.render).toBe(1);
		expect(r.doc.pages[0]!.strokes[1]).toEqual({ ...v4.pages[0].strokes[1], render: 1 });
		expect(r.doc.meta).toEqual(v4.meta);
	});

	it.each([0, 1, 2, 3])("a v%i file reaches v5 with render 1", (from) => {
		const raw = from === 0
			? { strokes: [{ color: "#000000", size: 2, points: [{ x: 1, y: 2 }] }] }
			: oldDoc(from);
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(from);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		const strokes = r.doc.pages.flatMap((p) => p.strokes);
		expect(strokes.length).toBeGreaterThan(0);
		for (const s of strokes) expect(s.render).toBe(1);
		const text = serialize(r.doc);
		const again = parsed(text);
		expect(again.migratedFrom).toBeNull();
		expect(serialize(again.doc)).toBe(text);
	});

	it("tolerates pages and strokes the validator will reject", () => {
		const v4 = oldDoc(4);
		v4.pages[0].strokes.push(null);
		expect(parse(JSON.stringify(v4)).ok).toBe(false);
		expect(parse(JSON.stringify({ ...oldDoc(4), pages: "x" })).ok).toBe(false);
	});

	it("serialize writes render right after width and before points", () => {
		const text = serialize(mixedDoc());
		const lines = text.split("\n").filter((l) => l.includes('"tool"'));
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe('\t\t\t\t{"id":"s0","tool":"pen","color":"#112233","width":2,"render":1,"points":[[1,2,0.5],[3,4,0.6]]},');
		expect(lines[1]).toContain('"width":2,"render":2,"points"');
		expect(Object.keys(JSON.parse(text).pages[0].strokes[0])).toEqual(["id", "tool", "color", "width", "render", "points"]);
	});

	it("serialize(parse(s)) === s with both render values and all tools", () => {
		const doc = mixedDoc();
		const text = serialize(doc);
		const r = parsed(text);
		expect(r.migratedFrom).toBeNull();
		expect(r.doc.pages[0]!.strokes.map((s) => [s.tool, s.render])).toEqual(
			TOOLS.flatMap((t) => RENDER_VERSIONS.map((v) => [t, v])),
		);
		expect(serialize(r.doc)).toBe(text);
	});

	it.each([
		["missing", undefined],
		["0", 0],
		["3", 3],
		["a string", "2"],
		["null", null],
		["1.5", 1.5],
	])("parse rejects a v5 stroke whose render is %s", (_name, value) => {
		const raw = JSON.parse(serialize(mixedDoc())) as Raw;
		const stroke = raw.pages[0].strokes[2];
		if (value === undefined) delete stroke.render;
		else stroke.render = value;
		const r = parse(JSON.stringify(raw));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toContain("pages[0].strokes[2].render");
		}
	});

	it("serializeChecked accepts mixed render values, on both paths, and matches serialize", () => {
		const doc = mixedDoc();
		const a = serializeChecked(doc);
		expect(a.ok && a.text).toBe(serialize(doc));
		expect(serializeChecked(doc, true).ok).toBe(true);
		const parsedDoc = parsed(serialize(doc)).doc;
		const b = serializeChecked(parsedDoc);
		expect(b.ok && b.text).toBe(serialize(doc));
	});

	it("serializeChecked refuses a stroke with an invalid render", () => {
		const doc = createDocument(new Date(stamp));
		const bad = { ...createStroke("#112233", 2, [[1, 2, 0.5]]), render: 7 as RenderVersion };
		doc.pages[0]!.strokes.push(bad);
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("createStroke defaults to render 1 and accepts 2", () => {
		expect(createStroke("#000000", 2).render).toBe(RENDER_FREEHAND);
		expect(createStroke("#000000", 2, [], "pen").render).toBe(1);
		expect(createStroke("#000000", 2, [], "highlighter", RENDER_INK).render).toBe(2);
	});

	it("stressDocument carries the requested render", () => {
		const strokes = (d: NotebookDocument) => d.pages.flatMap((p) => p.strokes);
		expect(strokes(stressDocument(20, 2)).every((s) => s.render === 1)).toBe(true);
		const ink = stressDocument(20, 2, 42, 2);
		expect(strokes(ink)).toHaveLength(20);
		expect(strokes(ink).every((s) => s.render === 2)).toBe(true);
		expect(parsed(serialize(ink)).doc).toEqual(ink);
	});
});
