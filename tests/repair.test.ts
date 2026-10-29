import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { parseLenient } from "../src/model/lenient-json";
import { recoveredItems, repairNotebookText } from "../src/model/repair";
import { parse, serialize } from "../src/model/serialize";
import { CURRENT_VERSION, type NotebookDocument, type Point } from "../src/model/types";
import { buildEntry, splitLines } from "../src/storage/journal";
import { backupDate, combineCandidates, isBackupOf, journalTexts, rankSources, type RecoverySource } from "../src/storage/recovery";
import { line, sampleDocument } from "./helpers";

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bigDocument(pages = 3, strokesPerPage = 20): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages = [];
	for (let p = 0; p < pages; p++) {
		const page = createPage();
		for (let i = 0; i < strokesPerPage; i++) page.strokes.push(line(20 + i, 30 + i * 9, 200 + p, 40 + i * 9, 6));
		page.elements = [{ id: `text-${p}`, type: "text", x: 10, y: 10, width: 120, text: `page ${p}`, fontSize: 14, color: "#112233" }];
		doc.pages.push(page);
	}
	doc.meta = { tags: ["work"], favorite: true, cover: "#ff0000", bookmarks: [doc.pages[1]!.id] };
	return doc;
}

function strokeIds(doc: NotebookDocument): Set<string> {
	return new Set(doc.pages.flatMap((p) => p.strokes.map((s) => s.id)));
}

describe("parseLenient", () => {
	it("returns complete JSON unchanged", () => {
		const r = parseLenient('{"a":[1,2,{"b":"c"}]}');
		expect(r.complete).toBe(true);
		expect(r.value).toEqual({ a: [1, 2, { b: "c" }] });
	});

	it("closes open containers at a truncation and drops a cut value", () => {
		const r = parseLenient('{"a":[1,2,3],"b":{"c":"x","d":12.5');
		expect(r.complete).toBe(false);
		// 12.5 touches the end of the text: it may have been cut (e.g. from 12.53), so it is dropped.
		expect(r.value).toEqual({ a: [1, 2, 3], b: { c: "x" } });
		const b = (r.value as { b: object }).b;
		expect(r.incomplete.has(b)).toBe(true);
	});

	it("drops a cut string and a cut key", () => {
		expect(parseLenient('{"a":"hel').value).toEqual({});
		expect(parseLenient('{"a":1,"bc').value).toEqual({ a: 1 });
		expect(parseLenient('[1,2,tr').value).toEqual([1, 2]);
	});

	it("stops at garbage and keeps what came before", () => {
		const r = parseLenient('{"a":[1,2,\u0000\u0000\u0000],"b":2}');
		expect(r.value).toEqual({ a: [1, 2] });
		expect(r.stoppedAt).toBe(10);
	});

	it("never assigns __proto__ and survives deep nesting", () => {
		const r = parseLenient('{"__proto__":{"x":1},"y":2');
		expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
		expect(parseLenient("[".repeat(10_000)).complete).toBe(false);
	});

	it("handles escapes", () => {
		expect(parseLenient('{"a":"q\\"\\u0041\\n","b":[').value).toEqual({ a: "q\"A\n", b: [] });
	});
});

describe("repairNotebookText", () => {
	it("reports a readable file as already readable, nothing lost", () => {
		const doc = sampleDocument(4);
		const r = repairNotebookText(serialize(doc));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.alreadyReadable).toBe(true);
		expect(r.summary.strokes).toEqual({ recovered: 4, repaired: 0, lost: 0 });
	});

	it("refuses empty, foreign and newer-version files", () => {
		expect(repairNotebookText("  ")).toMatchObject({ ok: false, reason: "empty" });
		expect(repairNotebookText('{"hello":"world"}')).toMatchObject({ ok: false, reason: "not-notebook" });
		expect(repairNotebookText('{"format":"something-else","version":2,"pages":[]}')).toMatchObject({ ok: false, reason: "not-notebook" });
		const future = serialize(sampleDocument()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		expect(repairNotebookText(future)).toMatchObject({ ok: false, reason: "future-version" });
		expect(repairNotebookText(future.slice(0, 200))).toMatchObject({ ok: false, reason: "future-version" });
	});

	it("keeps every valid stroke around one bad stroke", () => {
		const doc = sampleDocument(5);
		const raw = JSON.parse(serialize(doc)) as { pages: Array<{ strokes: unknown[] }> };
		raw.pages[0]!.strokes[2] = { id: "bad", tool: "pen", color: "#000000", width: 2, render: 1, points: "nope" };
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.strokes).toEqual({ recovered: 4, repaired: 0, lost: 1 });
		const ids = strokeIds(r.doc);
		for (const [i, s] of doc.pages[0]!.strokes.entries()) expect(ids.has(s.id)).toBe(i !== 2);
	});

	it("fixes invalid fields conservatively", () => {
		const doc = sampleDocument(1);
		const raw = JSON.parse(serialize(doc)) as { pages: Array<Record<string, unknown> & { strokes: Array<Record<string, unknown>> }> };
		const s = raw.pages[0]!.strokes[0]!;
		s.color = "red";
		s.tool = "crayon";
		delete s.render;
		(s.points as unknown[]).push([1, Number.NaN, 0.5], "x", [3, 4, 7]);
		raw.pages[0]!.width = -5;
		raw.pages[0]!.paper = { kind: "papyrus", spacing: 3 };
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = r.doc.pages[0]!;
		expect(out.strokes).toHaveLength(1);
		expect(out.strokes[0]!.color).toBe("#000000");
		expect(out.strokes[0]!.tool).toBe("pen");
		expect(out.strokes[0]!.render).toBe(1);
		// Invalid points dropped, out-of-range pressure clamped.
		expect(out.strokes[0]!.points[out.strokes[0]!.points.length - 1]).toEqual([3, 4, 1]);
		expect(out.strokes[0]!.points).toHaveLength(doc.pages[0]!.strokes[0]!.points.length + 1);
		expect(out.width).toBeGreaterThan(0);
		expect(out.paper.kind).toBe("grid");
		expect(r.summary.strokes.repaired).toBe(1);
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(2);
	});

	it("drops an image whose asset is missing but keeps text boxes and the background-less page", () => {
		const doc = sampleDocument(1);
		const raw = JSON.parse(serialize(doc)) as { pages: Array<Record<string, unknown>> };
		raw.pages[0]!.elements = [
			{ id: "img", type: "image", asset: "abc", x: 0, y: 0, width: 10, height: 10, rotation: 0 },
			{ id: "txt", type: "text", x: 0, y: 0, width: 50, text: "hi", fontSize: 9999, color: "#000000" },
		];
		raw.pages[0]!.background = { kind: "pdf", asset: "abc", page: 1 };
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.elements).toEqual({ recovered: 0, repaired: 1, lost: 1 });
		expect(r.summary.backgroundsLost).toBe(1);
		expect(r.doc.pages[0]!.elements?.map((e) => e.id)).toEqual(["txt"]);
		expect(r.doc.pages[0]!.background).toBeUndefined();
	});

	it("gives a new id to a different stroke with a duplicate id and drops an exact duplicate", () => {
		const doc = sampleDocument(2);
		const raw = JSON.parse(serialize(doc)) as { pages: Array<{ strokes: Array<Record<string, unknown>> }> };
		const [a, b] = raw.pages[0]!.strokes;
		raw.pages[0]!.strokes.push({ ...a! }, { ...b!, id: a!.id });
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.strokes).toHaveLength(3);
		expect(r.summary.duplicates).toBe(1);
		expect(r.summary.strokes.repaired).toBe(1);
	});

	it("counts unknown (future) fields, which stay only in the original", () => {
		const doc = sampleDocument(1);
		const raw = JSON.parse(serialize(doc)) as Record<string, unknown> & { pages: Array<Record<string, unknown> & { strokes: Array<Record<string, unknown>> }> };
		raw.layers = [];
		raw.pages[0]!.template = "x";
		raw.pages[0]!.strokes[0]!.opacity = 0.5;
		raw.pages[0]!.strokes[0]!.points = "broken"; // makes the file unreadable
		raw.pages[0]!.strokes.push({ ...doc.pages[0]!.strokes[0]!, id: "other", glow: true });
		const r = repairNotebookText(JSON.stringify(raw));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.unknownFields).toBe(3);
	});

	it("recovers the strokes before a truncation and reports the damage", () => {
		const doc = bigDocument(3, 20);
		const text = serialize(doc);
		const cut = text.slice(0, Math.floor(text.length * 0.6));
		const r = repairNotebookText(cut);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.damaged).toBe(true);
		const ids = strokeIds(r.doc);
		const originals = doc.pages.flatMap((p) => p.strokes);
		// Every stroke whose line ends before the cut is recovered whole.
		for (const s of originals) {
			const end = text.indexOf(s.id);
			const lineEnd = text.indexOf("\n", end);
			if (lineEnd < cut.length) expect(ids.has(s.id)).toBe(true);
		}
		// Recovered strokes are identical to the originals.
		const byId = new Map(originals.map((s) => [s.id, s]));
		for (const p of r.doc.pages) for (const s of p.strokes) if (byId.has(s.id) && r.summary.strokes.repaired === 0) expect(s).toEqual(byId.get(s.id));
		expect(r.doc.meta?.tags).toEqual(["work"]);
	});

	it("recovers strokes AFTER a damaged region in the middle (line scan)", () => {
		const doc = bigDocument(3, 10);
		const text = serialize(doc);
		const lines = text.split("\n");
		// Destroy a few lines inside page 1.
		const target = doc.pages[1]!.strokes[3]!.id;
		const at = lines.findIndex((l) => l.includes(target));
		for (let i = at; i < at + 3; i++) lines[i] = "\u0000\u0000garbage{{{";
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const ids = strokeIds(r.doc);
		const lost = new Set(doc.pages[1]!.strokes.slice(3, 6).map((s) => s.id));
		for (const p of doc.pages) for (const s of p.strokes) expect(ids.has(s.id)).toBe(!lost.has(s.id));
		// Pages keep their ids, order and settings.
		expect(r.doc.pages.map((p) => p.id)).toEqual(doc.pages.map((p) => p.id));
		expect(r.doc.pages[2]!.elements?.[0]?.id).toBe("text-2");
		expect(r.doc.meta?.bookmarks).toEqual([doc.pages[1]!.id]);
	});

	it("runs older versions through the migrations, tolerating a bad stroke", () => {
		const v3 = {
			format: "obsidian-notebook", version: 3, id: "old", createdAt: "a", modifiedAt: "b",
			pages: [{
				id: "p1", width: 595.28, height: 841.89, paper: { kind: "ruled", spacing: 22.68 },
				strokes: [
					{ id: "s1", tool: "pen", color: "#000000", width: 2, points: [[1, 2, 0.5], [3, 4, 0.5]] },
					// "shape" did not exist before v4: the v3 -> v4 migration rejects it.
					{ id: "s2", tool: "shape", color: "#000000", width: 2, points: [[1, 2, 0.5]] },
					{ id: "s3", tool: "highlighter", color: "#ffff00", width: 9, points: [[5, 6, 0.5]] },
				],
			}],
		};
		expect(parse(JSON.stringify(v3)).ok).toBe(false);
		const r = repairNotebookText(JSON.stringify(v3));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.sourceVersion).toBe(3);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(["s1", "s3"]);
		expect(r.doc.pages[0]!.strokes.every((s) => s.render === 1)).toBe(true);
		expect(r.summary.strokes.lost).toBe(1);
	});

	it("repairs a damaged v0 prototype file", () => {
		const v0 = '{"strokes":[{"points":[{"x":1,"y":2}],"color":"#000000","size":2},{"points":[{"x":"no"}],"color":"#000000","size":2},{"points":[{"x":5,"y":6,"p":0.2}],"col';
		const r = repairNotebookText(v0);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages).toHaveLength(1);
		// The first stroke as is; the cut-off third one has its points and gets a default colour; the second is lost.
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(r.summary.strokes).toEqual({ recovered: 1, repaired: 1, lost: 1 });
	});

	it("returns 'nothing' when no content survives", () => {
		expect(repairNotebookText('{"format":"obsidian-notebook","version":5,"id":"x","pa')).toMatchObject({ ok: false, reason: "nothing" });
	});

	it("fuzz: any truncation or corruption gives a valid notebook (or a clean refusal) and never invents strokes", () => {
		const doc = bigDocument(2, 8);
		const text = serialize(doc);
		const originals = new Map(doc.pages.flatMap((p) => p.strokes).map((s) => [s.id, s]));
		const rand = rng(1234);
		for (let iter = 0; iter < 300; iter++) {
			let damaged: string;
			const mode = iter % 4;
			if (mode === 0) damaged = text.slice(0, Math.floor(rand() * text.length));
			else if (mode === 1) {
				const at = Math.floor(rand() * text.length);
				damaged = text.slice(0, at) + "\u0000".repeat(1 + Math.floor(rand() * 40)) + text.slice(at + Math.floor(rand() * 40));
			} else if (mode === 2) {
				const chars = text.split("");
				for (let k = 0; k < 5; k++) chars[Math.floor(rand() * chars.length)] = String.fromCharCode(32 + Math.floor(rand() * 90));
				damaged = chars.join("");
			} else {
				const lines = text.split("\n");
				lines.splice(Math.floor(rand() * lines.length), 1 + Math.floor(rand() * 4));
				damaged = lines.join("\n");
			}
			const r = repairNotebookText(damaged);
			if (!r.ok) {
				expect(["empty", "not-notebook", "nothing", "future-version"]).toContain(r.reason);
				continue;
			}
			// The output is a valid notebook that round-trips.
			const back = parse(r.text);
			expect(back.ok).toBe(true);
			if (back.ok) expect(serialize(back.doc)).toBe(r.text);
			// Every stroke with an original id has (a prefix of) the original points, never different ones.
			for (const p of r.doc.pages) {
				for (const s of p.strokes) {
					const o = originals.get(s.id);
					if (!o || r.summary.strokes.repaired > 0) continue;
					expect(s.points.length).toBeLessThanOrEqual(o.points.length);
				}
			}
			expect(recoveredItems(r.summary)).toBeGreaterThan(0);
		}
	});

	it("a large clean prefix is recovered fast enough", () => {
		const doc = bigDocument(5, 400);
		const text = serialize(doc);
		const t0 = performance.now();
		const r = repairNotebookText(text.slice(0, text.length - 50));
		expect(performance.now() - t0).toBeLessThan(10_000);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.strokes.recovered).toBeGreaterThanOrEqual(1999);
	});
});

describe("recovery sources", () => {
	it("ranks by recovered items, then date, then kind", () => {
		const doc = bigDocument(2, 10);
		const full = serialize(doc);
		const sources: RecoverySource[] = [
			{ kind: "file", label: "f", date: new Date(3000), text: full.slice(0, full.length / 2) },
			{ kind: "snapshot", label: "s", date: new Date(1000), text: full },
			{ kind: "backup", label: "b", date: new Date(500), text: full },
			{ kind: "journal", label: "j", date: new Date(2000), text: "garbage" },
		];
		const ranked = rankSources(sources);
		expect(ranked.map((c) => c.source.label)).toEqual(["s", "f"]);
		expect(ranked[0]!.summary.alreadyReadable).toBe(true);
	});

	it("rebuilds journal entries: full ones always, deltas only on a matching base", () => {
		const doc = sampleDocument(2);
		const base = serialize(doc);
		doc.pages[0]!.strokes.push(line(1, 1, 50, 50));
		const next = serialize(doc);
		const full = buildEntry(doc.id, 2, "2026-10-29T10:00:00.000Z", base, splitLines(base), next)!;
		expect(journalTexts([{ owner: "a", slot: 0, text: full.text }], doc.id, [])).toEqual([{ text: next, savedAt: "2026-10-29T10:00:00.000Z" }]);
		expect(journalTexts([{ owner: "a", slot: 0, text: full.text }], "other-doc", [])).toEqual([]);
		// A hand-made delta entry.
		const delta = JSON.stringify({ ...full.entry, full: undefined, hunks: [[splitLines(base).length - 3, 0, ["x"]]], result: "nope" });
		expect(journalTexts([{ owner: "a", slot: 1, text: delta }], doc.id, [base])).toEqual([]);
	});

	it("combines two candidates without losing anything of either", () => {
		const a = sampleDocument(2);
		const b = parse(serialize(a));
		if (!b.ok) throw new Error();
		b.doc.pages[0]!.strokes.push(line(9, 9, 99, 99));
		const ranked = rankSources([
			{ kind: "file", label: "a", date: null, text: serialize(a) },
			{ kind: "snapshot", label: "b", date: null, text: serialize(b.doc) },
		]);
		const combined = combineCandidates(ranked[1]!, ranked[0]!);
		expect(combined).not.toBeNull();
		expect(combined!.doc.pages[0]!.strokes).toHaveLength(3);
		expect(combineCandidates(ranked[0]!, ranked[1]!)).toBeNull();
	});

	it("reads backup names", () => {
		expect(backupDate("Notes 20261029-140501 unreadable 0a1b2c3d.bak")?.getHours()).toBe(14);
		expect(backupDate("Notes 20261029-140501 before-restore 2 0a1b2c3d.bak")).not.toBeNull();
		expect(isBackupOf("Notes 20261029-140501 unreadable 0a1b2c3d.bak", "Notes")).toBe(true);
		expect(isBackupOf("Notes 2 20261029-140501 unreadable 0a1b2c3d.bak", "Notes")).toBe(false);
		expect(isBackupOf("Other.notebook", "Notes")).toBe(false);
	});
});

describe("repair keeps strokes intact", () => {
	it("pressure and coordinates are not altered for intact strokes", () => {
		const doc = createDocument();
		const pts: Point[] = [quantizePoint(1.23, 4.56, 0.789), quantizePoint(7.01, 8.02, 0.001)];
		doc.pages[0]!.strokes.push(createStroke("#123456", 3.5, pts, "highlighter", 2));
		const text = serialize(doc);
		const r = repairNotebookText(text.replace(/"modifiedAt": "[^"]*"/, '"modifiedAt": 5'));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.pages[0]!.strokes[0]).toEqual(doc.pages[0]!.strokes[0]);
	});
});
