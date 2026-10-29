import { describe, expect, it } from "vitest";
import { captureClip } from "../src/ink/clipboard";
import {
	BUILTIN_STAMPS, builtinStamp, cleanStampName, normalizeStamp, planStampPlacement, readStamp, serializeStamp, stampPreview,
	stampSize, stampsFolder, uniqueStampName,
} from "../src/ink/stamps";
import { createDocument, createId } from "../src/model/document";
import { History } from "../src/model/history";
import { serializeChecked } from "../src/model/serialize";
import type { Asset, ImageElement, TextElement } from "../src/model/types";
import { line } from "./helpers";

const asset = (id: string): Asset => ({ id, kind: "image", path: `Notebooks/_assets/${id}.png`, name: `${id}.png`, bytes: 10 });
const image = (assetId: string, x = 100, y = 100): ImageElement => ({ id: createId(), type: "image", asset: assetId, x, y, width: 80, height: 60, rotation: 0 });
const text = (): TextElement => ({ id: createId(), type: "text", x: 20, y: 30, width: 120, text: "hello", fontSize: 14, color: "#1e1e1e" });
const doc0 = () => createDocument(new Date("2026-10-29T10:00:00.000Z"));

describe("stamp names", () => {
	it("cleans file-name characters and keeps names unique", () => {
		expect(cleanStampName("  my/sign:ature?  ")).toBe("my sign ature");
		expect(cleanStampName("///")).toBe("");
		expect(uniqueStampName("Check", ["Star"])).toBe("Check");
		expect(uniqueStampName("check", ["Check"])).toBe("check 2");
		expect(uniqueStampName("Check", ["Check", "check 2"])).toBe("Check 3");
		expect(uniqueStampName("", [])).toBe("Stamp");
		expect(stampsFolder("Notebooks/")).toBe("Notebooks/_stamps");
		expect(stampsFolder("")).toBe("_stamps");
	});
});

describe("stamp files", () => {
	it("round-trips strokes, text and images with their assets, moved to the origin", () => {
		const doc = doc0();
		doc.assets = { ab: asset("ab") };
		const s = line(200, 300, 260, 340);
		const img = image("ab", 150, 280);
		const tx = text();
		const clip = captureClip([s], [img, tx], doc.assets)!;
		const saved = serializeStamp(clip);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		const back = readStamp(saved.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.clip.strokes).toHaveLength(1);
		expect(back.clip.elements).toHaveLength(2);
		expect(back.clip.assets.map((a) => a.id)).toEqual(["ab"]);
		expect(Math.abs(back.clip.bounds.minX)).toBeLessThan(2);
		expect(Math.abs(back.clip.bounds.minY)).toBeLessThan(2);
		const size = stampSize(normalizeStamp(clip));
		expect(Math.abs(stampSize(back.clip).width - size.width)).toBeLessThan(1);
	});

	it("is a valid notebook document, so no format change is involved", () => {
		const clip = captureClip([line(10, 10, 80, 40)], [], undefined)!;
		const saved = serializeStamp(clip);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		const json = JSON.parse(saved.text) as { format: string; version: number; pages: unknown[] };
		expect(json.format).toBe("obsidian-notebook");
		expect(json.pages).toHaveLength(1);
	});

	it("refuses to write a stamp whose image has no asset record, and a selection that is too large", () => {
		const clip = captureClip([], [image("zz")], {})!;
		expect(serializeStamp(clip).ok).toBe(false);
		const big = captureClip([line(0, 0, 3000, 10)], [], undefined)!;
		expect(serializeStamp(big).ok).toBe(false);
	});

	it("reports damaged, foreign, newer and empty files instead of throwing", () => {
		expect(readStamp("").ok).toBe(false);
		expect(readStamp("{not json").ok).toBe(false);
		expect(readStamp('{"hello":1}').ok).toBe(false);
		const newer = JSON.stringify({ format: "obsidian-notebook", version: 999, pages: [] });
		expect(readStamp(newer).ok).toBe(false);
		const empty = serializeChecked(doc0(), true);
		expect(empty.ok).toBe(true);
		if (empty.ok) expect(readStamp(empty.text).ok).toBe(false);
	});
});

describe("built-in stamps", () => {
	it("are generated in code with the given colour and width", () => {
		for (const kind of BUILTIN_STAMPS) {
			const clip = builtinStamp(kind, "#dc2626", 3.2);
			expect(clip.strokes).toHaveLength(1);
			expect(clip.strokes[0]!.color).toBe("#dc2626");
			expect(clip.strokes[0]!.width).toBe(3.2);
			expect(clip.strokes[0]!.tool).toBe("shape");
			expect(clip.bounds.minX).toBe(0);
			expect(clip.bounds.minY).toBe(0);
			expect(clip.bounds.maxX).toBeGreaterThan(20);
			expect(clip.bounds.maxX).toBeLessThan(60);
			expect(serializeStamp(clip).ok).toBe(true);
		}
	});
});

describe("placing a stamp", () => {
	it("makes fresh ids, lands on the requested centre and is one undo step", () => {
		const doc = doc0();
		doc.assets = { ab: asset("ab") };
		const page = doc.pages[0]!;
		const clip = normalizeStamp(captureClip([line(0, 0, 60, 20)], [text()], doc.assets)!);
		const hist = new History(() => doc);
		const snapshot = JSON.stringify(clip);
		const plan = planStampPlacement(clip, doc, page, [300, 400])!;
		hist.execute(plan.command);
		expect(page.strokes).toHaveLength(1);
		expect(page.elements).toHaveLength(1);
		expect(page.strokes[0]!.id).not.toBe(clip.strokes[0]!.id);
		expect(page.elements![0]!.id).not.toBe(clip.elements[0]!.id);
		const placed = captureClip(page.strokes, page.elements!, doc.assets)!;
		expect((placed.bounds.minX + placed.bounds.maxX) / 2).toBeCloseTo(300, 0);
		expect((placed.bounds.minY + placed.bounds.maxY) / 2).toBeCloseTo(400, 0);
		// The same stamp can be placed again; the original clip is untouched.
		const again = planStampPlacement(clip, doc, page, [100, 100])!;
		hist.execute(again.command);
		expect(page.strokes).toHaveLength(2);
		expect(new Set(page.strokes.map((s) => s.id)).size).toBe(2);
		expect(JSON.stringify(clip)).toBe(snapshot);
		hist.undo();
		hist.undo();
		expect(page.strokes).toHaveLength(0);
		expect(page.elements).toHaveLength(0);
		expect(hist.canUndo()).toBe(false);
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("registers the images' assets once and skips images whose file is missing", () => {
		const doc = doc0();
		const page = doc.pages[0]!;
		const source = doc0();
		source.assets = { ab: asset("ab"), cd: asset("cd") };
		const clip = normalizeStamp(captureClip([], [image("ab"), image("cd", 300, 100)], source.assets)!);
		const hist = new History(() => doc);
		const plan = planStampPlacement(clip, doc, page, [200, 200], { usable: (id) => id === "ab" })!;
		expect(plan.skipped).toBe(1);
		hist.execute(plan.command);
		expect(Object.keys(doc.assets ?? {})).toEqual(["ab"]);
		expect(page.elements).toHaveLength(1);
		hist.undo();
		expect(Object.keys(doc.assets ?? {})).toEqual([]);
		// Nothing usable at all: no placement.
		expect(planStampPlacement(clip, doc, page, [200, 200], { usable: () => false })).toBeNull();
		// An asset the document already has is not added again.
		doc.assets = { ab: asset("ab") };
		const second = planStampPlacement(clip, doc, page, [200, 200], { usable: (id) => id === "ab" })!;
		hist.execute(second.command);
		expect(Object.keys(doc.assets)).toEqual(["ab"]);
	});

	it("keeps a stamp inside the page", () => {
		const doc = doc0();
		const page = doc.pages[0]!;
		const clip = builtinStamp("star", "#1e1e1e", 2);
		const plan = planStampPlacement(clip, doc, page, [-500, 5000])!;
		const placed = captureClip(plan.strokes, plan.elements, undefined)!;
		expect(placed.bounds.minX).toBeGreaterThanOrEqual(-2);
		expect(placed.bounds.maxY).toBeLessThanOrEqual(page.height + 2);
	});
});

describe("stamp previews", () => {
	it("describe strokes as paths and elements as boxes, with a bounded number of points", () => {
		const doc = doc0();
		doc.assets = { ab: asset("ab") };
		const clip = normalizeStamp(captureClip([line(0, 0, 100, 50, 400)], [image("ab", 0, 0)], doc.assets)!);
		const p = stampPreview(clip);
		expect(p.strokes).toHaveLength(1);
		expect(p.strokes[0]!.d.startsWith("M")).toBe(true);
		expect(p.strokes[0]!.d.split("L").length).toBeLessThanOrEqual(50);
		expect(p.boxes).toHaveLength(1);
		expect(p.boxes[0]!.kind).toBe("image");
		expect(p.box.w).toBeGreaterThan(80);
	});
});
