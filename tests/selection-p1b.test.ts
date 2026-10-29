import { describe, expect, it } from "vitest";
import { captureClip, clipAssetIds, duplicateOffset, instantiateClip, pasteCommand, pasteOffset, PASTE_STEP } from "../src/ink/clipboard";
import { alphaForMin, WHITE_CUT, WHITE_KEEP, whiteToTransparent } from "../src/ink/image-alpha";
import { commonStyle, planRestyle, restyleAbilities, restyleStroke, styleGroup } from "../src/ink/restyle";
import { createDocument, createId, createStroke, quantizePoint } from "../src/model/document";
import { AddAsset, Batch, History, ReplaceElement } from "../src/model/history";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import type { Asset, ImageElement, NotebookDocument, TextElement } from "../src/model/types";
import { clipMarker, decidePaste, MAX_PASTED_TEXT, normalizePastedText, pastedImageElement, pastedImageName, pastedTextElement } from "../src/view/paste-logic";
import { line } from "./helpers";

const asset = (id: string): Asset => ({ id, kind: "image", path: `Notebooks/_assets/${id}.png`, name: `${id}.png`, bytes: 10 });
const image = (assetId: string, x = 100, y = 100): ImageElement => ({ id: createId(), type: "image", asset: assetId, x, y, width: 80, height: 60, rotation: 0 });
const text = (color = "#1e1e1e"): TextElement => ({ id: createId(), type: "text", x: 20, y: 30, width: 120, text: "hello", fontSize: 14, color });
const highlighter = () => createStroke("#facc15", 14, [quantizePoint(10, 10, 0.5), quantizePoint(90, 12, 0.5)], "highlighter");

function docWith(): NotebookDocument {
	return createDocument(new Date("2026-10-29T10:00:00.000Z"));
}

describe("restyle selection", () => {
	it("changes colour and width of pen strokes as one undo step", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const a = line(10, 10, 100, 10);
		const b = line(10, 30, 100, 30, 10, 5);
		page.strokes.push(a, b);
		const hist = new History(() => doc);
		const plan = planRestyle(page, [a, b], [], { group: "ink", color: "#DC2626", width: 3.2 })!;
		hist.execute(plan.command);
		expect(page.strokes.map((s) => [s.color, s.width])).toEqual([["#dc2626", 3.2], ["#dc2626", 3.2]]);
		expect(page.strokes.map((s) => s.id)).toEqual([a.id, b.id]);
		expect(plan.strokes).toEqual(page.strokes);
		hist.undo();
		expect(page.strokes[0]).toBe(a);
		expect(page.strokes[1]).toBe(b);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes[0]!.color).toBe("#dc2626");
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("keeps the points, the tool and the render version", () => {
		const s = createStroke("#1e1e1e", 2, [quantizePoint(1, 2, 0.4), quantizePoint(3, 4, 0.6)], "shape", 2);
		const r = restyleStroke(s, { group: "ink", color: "#1d4ed8" });
		expect(r.points).toEqual(s.points);
		expect(r.tool).toBe("shape");
		expect(r.render).toBe(2);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("leaves highlighters alone for a pen request and pens alone for a highlighter request", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const pen = line(10, 10, 100, 10);
		const hl = highlighter();
		page.strokes.push(pen, hl);
		const penPlan = planRestyle(page, [pen, hl], [], { group: "ink", color: "#dc2626" })!;
		expect(penPlan.strokes[1]).toBe(hl);
		expect(penPlan.strokes[0]!.color).toBe("#dc2626");
		const hlPlan = planRestyle(page, [pen, hl], [], { group: "highlighter", color: "#4ade80", width: 20 })!;
		expect(hlPlan.strokes[0]).toBe(pen);
		expect(hlPlan.strokes[1]).toMatchObject({ color: "#4ade80", width: 20, tool: "highlighter" });
	});

	it("does nothing (null) when nothing would change, and ignores bad values", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const s = line(10, 10, 100, 10);
		page.strokes.push(s);
		expect(planRestyle(page, [s], [], { group: "ink", color: s.color, width: s.width })).toBeNull();
		expect(planRestyle(page, [s], [], { group: "ink", color: "red", width: -1 })).toBeNull();
		expect(planRestyle(page, [s], [], { group: "ink", width: Number.NaN })).toBeNull();
	});

	it("skips strokes that are no longer on the page", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const gone = line(10, 10, 100, 10);
		expect(planRestyle(page, [gone], [], { group: "ink", color: "#dc2626" })).toBeNull();
	});

	it("reports what the selection allows and the shared style", () => {
		const pen = line(0, 0, 10, 0);
		const hl = highlighter();
		expect(restyleAbilities([pen], [])).toEqual({ inkColor: true, inkWidth: true, highlighterColor: false, highlighterWidth: false });
		expect(restyleAbilities([hl], [])).toMatchObject({ inkColor: false, highlighterColor: true });
		expect(restyleAbilities([], [text()])).toEqual({ inkColor: true, inkWidth: false, highlighterColor: false, highlighterWidth: false });
		expect(restyleAbilities([], [image("a".repeat(64))])).toEqual({ inkColor: false, inkWidth: false, highlighterColor: false, highlighterWidth: false });
		expect(styleGroup(hl)).toBe("highlighter");
		expect(commonStyle([pen, line(0, 5, 10, 5)], [], "ink")).toEqual({ color: "#1e1e1e", width: 2 });
		expect(commonStyle([pen, line(0, 5, 10, 5, 10, 5)], [], "ink")).toEqual({ color: "#1e1e1e", width: null });
	});

	it("recolours a text box in the same step as the strokes", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const s = line(10, 10, 100, 10);
		const el = text();
		page.strokes.push(s);
		page.elements = [el];
		const hist = new History(() => doc);
		const plan = planRestyle(page, [s], [el], { group: "ink", color: "#1d4ed8" })!;
		hist.execute(plan.command);
		expect(page.elements[0]).toMatchObject({ id: el.id, color: "#1d4ed8", text: "hello" });
		hist.undo();
		expect(page.elements[0]).toBe(el);
		expect(page.strokes[0]).toBe(s);
	});

	it("does not recolour text boxes for a highlighter request", () => {
		const doc = docWith();
		const page = doc.pages[0]!;
		const el = text();
		page.elements = [el];
		expect(planRestyle(page, [], [el], { group: "highlighter", color: "#4ade80" })).toBeNull();
	});
});

describe("clipboard: capture, instantiate, paste", () => {
	const id = "ab".repeat(32);

	function source(): { doc: NotebookDocument; clip: NonNullable<ReturnType<typeof captureClip>> } {
		const doc = docWith();
		doc.assets = { [id]: asset(id) };
		const page = doc.pages[0]!;
		const s = line(50, 50, 150, 50);
		const img = image(id, 200, 200);
		page.strokes.push(s);
		page.elements = [img, text()];
		const clip = captureClip([s], page.elements, doc.assets)!;
		return { doc, clip };
	}

	it("captures a deep copy with bounds and the assets the images need", () => {
		const { doc, clip } = source();
		doc.pages[0]!.strokes[0]!.points[0]![0] = 999; // a later edit of the source does not reach the clip
		expect(clip.strokes[0]!.points[0]![0]).toBe(50);
		expect(clip.assets.map((a) => a.id)).toEqual([id]);
		expect(clipAssetIds(clip)).toEqual([id]);
		expect(clip.bounds.minX).toBeLessThanOrEqual(20);
		expect(clip.bounds.maxX).toBeGreaterThanOrEqual(280);
		expect(captureClip([], [], undefined)).toBeNull();
	});

	it("pastes with new ids, on another page and another notebook, as one undo step, and the file stays valid", () => {
		const { clip } = source();
		const target = docWith();
		const page = target.pages[0]!;
		const hist = new History(() => target);
		const [dx, dy] = pasteOffset(clip.bounds, page, [300, 400]);
		const made = instantiateClip(clip, dx, dy);
		expect(made.strokes[0]!.id).not.toBe(clip.strokes[0]!.id);
		expect(made.elements.map((e) => e.id)).not.toContain(clip.elements[0]!.id);
		expect(made.strokes[0]!.points[0]![0]).toBeCloseTo(50 + dx, 1);
		expect(made.strokes[0]!.width).toBe(clip.strokes[0]!.width);
		hist.execute(pasteCommand(page, made.strokes, made.elements, clip.assets));
		expect(page.strokes).toHaveLength(1);
		expect(page.elements).toHaveLength(2);
		expect(target.assets![id]).toBeDefined();
		expect(parse(serialize(target)).ok).toBe(true);
		hist.undo();
		expect(page.strokes).toHaveLength(0);
		expect(page.elements).toHaveLength(0);
		expect(target.assets![id]).toBeUndefined();
		hist.redo();
		expect(page.strokes).toHaveLength(1);
		expect(target.assets![id]).toBeDefined();
	});

	it("can be pasted any number of times without id clashes", () => {
		const { clip } = source();
		const target = docWith();
		const page = target.pages[0]!;
		const hist = new History(() => target);
		for (let i = 0; i < 3; i++) {
			const [dx, dy] = pasteOffset(clip.bounds, page, [300, 400], i);
			const made = instantiateClip(clip, dx, dy);
			hist.execute(pasteCommand(page, made.strokes, made.elements, i === 0 ? clip.assets : []));
		}
		expect(page.strokes).toHaveLength(3);
		expect(() => serializeChecked(target)).not.toThrow();
		expect(page.strokes[1]!.points[0]![0] - page.strokes[0]!.points[0]![0]).toBeCloseTo(PASTE_STEP, 1);
	});

	it("renames the asset of an image when it was stored under another id", () => {
		const { clip } = source();
		const other = "cd".repeat(32);
		const made = instantiateClip(clip, 0, 0, new Map([[id, other]]));
		const img = made.elements.find((e) => e.type === "image") as ImageElement;
		expect(img.asset).toBe(other);
	});

	it("duplicate offsets down-right, or up-left at the page edge", () => {
		const page = { width: 595, height: 842 };
		expect(duplicateOffset({ minX: 10, minY: 10, maxX: 100, maxY: 100 }, page)).toEqual([PASTE_STEP, PASTE_STEP]);
		expect(duplicateOffset({ minX: 400, minY: 700, maxX: 590, maxY: 838 }, page)).toEqual([-PASTE_STEP, -PASTE_STEP]);
		expect(duplicateOffset({ minX: 0, minY: 0, maxX: 595, maxY: 842 }, page)).toEqual([0, 0]);
	});

	it("keeps a pasted clip inside the page when it fits and aligns to the corner when it does not", () => {
		const page = { width: 595, height: 842 };
		const b = { minX: 100, minY: 100, maxX: 200, maxY: 160 };
		const [dx, dy] = pasteOffset(b, page, [590, 840]);
		expect(b.maxX + dx).toBeLessThanOrEqual(595);
		expect(b.maxY + dy).toBeLessThanOrEqual(842);
		const [bx] = pasteOffset({ minX: 0, minY: 0, maxX: 800, maxY: 10 }, page, [300, 300]);
		expect(bx).toBe(0);
	});

	it("moving a pasted text box keeps its size", () => {
		const { clip } = source();
		const made = instantiateClip(clip, 30, 40);
		const t = made.elements.find((e) => e.type === "text") as TextElement;
		expect(t).toMatchObject({ x: 50, y: 70, width: 120, fontSize: 14 });
	});
});

describe("paste decisions (system clipboard)", () => {
	const marker = clipMarker(3, 1, 0);

	it("names the marker", () => {
		expect(marker).toBe("[Notebook selection: 3 strokes, 1 image]");
		expect(clipMarker(1, 0, 2)).toBe("[Notebook selection: 1 stroke, 2 text boxes]");
	});

	it("prefers the plugin clipboard only while the system clipboard still shows its marker", () => {
		expect(decidePaste({ readable: true, hasImage: false, text: marker }, marker)).toBe("internal");
		expect(decidePaste({ readable: true, hasImage: false, text: `  ${marker}\n` }, marker)).toBe("internal");
		expect(decidePaste({ readable: true, hasImage: false, text: "something else" }, marker)).toBe("text");
		expect(decidePaste({ readable: true, hasImage: true, text: "" }, marker)).toBe("image");
		expect(decidePaste({ readable: true, hasImage: false, text: "" }, marker)).toBe("internal");
		expect(decidePaste({ readable: true, hasImage: false, text: "" }, null)).toBe("empty");
		expect(decidePaste({ readable: true, hasImage: false, text: "plain" }, null)).toBe("text");
	});

	it("degrades when the clipboard cannot be read", () => {
		expect(decidePaste({ readable: false, hasImage: false, text: "" }, marker)).toBe("internal");
		expect(decidePaste({ readable: false, hasImage: false, text: "" }, null)).toBe("unreadable");
	});

	it("normalises pasted text", () => {
		expect(normalizePastedText("a\r\nb\rc  \n\n")).toEqual({ text: "a\nb\nc", truncated: false });
		expect(normalizePastedText("\n\n  hi")).toEqual({ text: "  hi", truncated: false });
		expect(normalizePastedText("x\u0000y\u0007z").text).toBe("xyz");
		expect(normalizePastedText("   ").text).toBe("");
		const long = normalizePastedText("a".repeat(MAX_PASTED_TEXT + 5));
		expect(long.truncated).toBe(true);
		expect(long.text).toHaveLength(MAX_PASTED_TEXT);
	});

	it("names pasted images with an extension the assets accept", () => {
		const d = new Date(2026, 9, 29, 8, 5, 3);
		expect(pastedImageName("image/png", d)).toBe("pasted-image-20261029-080503.png");
		expect(pastedImageName("image/jpeg", d)).toMatch(/\.jpg$/);
		expect(pastedImageName("image/webp", d)).toMatch(/\.webp$/);
		expect(pastedImageName("image/bmp", d)).toMatch(/\.png$/);
		expect(pastedImageName("", d)).toMatch(/\.png$/);
	});

	it("sizes and places a pasted image like an inserted one, inside the page", () => {
		const page = { width: 595.28, height: 841.89 };
		const el = pastedImageElement("f".repeat(64), { width: 4000, height: 3000 }, page, 300, 400);
		expect(el.width).toBeLessThanOrEqual(page.width * 0.6 + 0.01);
		expect(el.width / el.height).toBeCloseTo(4 / 3, 2);
		expect(el.x).toBeGreaterThanOrEqual(0);
		expect(el.x + el.width).toBeLessThanOrEqual(page.width);
		const edge = pastedImageElement("f".repeat(64), { width: 400, height: 300 }, page, 590, 840);
		expect(edge.x + edge.width).toBeLessThanOrEqual(page.width + 0.01);
		expect(edge.y + edge.height).toBeLessThanOrEqual(page.height + 0.01);
	});

	it("places pasted text as a text box on the page", () => {
		const page = { width: 595.28, height: 841.89 };
		const el = pastedTextElement("hello", page, 300, 400, 14, "#1e1e1e");
		expect(el).toMatchObject({ type: "text", text: "hello", fontSize: 14, color: "#1e1e1e" });
		expect(el.x).toBeGreaterThanOrEqual(0);
		expect(el.x + el.width).toBeLessThanOrEqual(page.width);
		const low = pastedTextElement("x", page, 100, 5000, 14, "#000000");
		expect(low.y).toBeLessThan(page.height);
	});
});

describe("white to transparent", () => {
	const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];

	it("maps the darkest channel to an alpha ramp", () => {
		expect(alphaForMin(255)).toBe(0);
		expect(alphaForMin(WHITE_CUT)).toBe(0);
		expect(alphaForMin(WHITE_KEEP)).toBe(255);
		expect(alphaForMin(0)).toBe(255);
		const mid = alphaForMin((WHITE_CUT + WHITE_KEEP) / 2);
		expect(mid).toBeGreaterThan(100);
		expect(mid).toBeLessThan(160);
		expect(alphaForMin(WHITE_KEEP, 40)).toBe(40);
		expect(alphaForMin(WHITE_KEEP + 1, 255)).toBeLessThan(255);
	});

	it("clears white and near-white, keeps ink and colour, and counts what changed", () => {
		const data = new Uint8ClampedArray([
			...px(255, 255, 255), // white
			...px(250, 251, 252), // near white (JPEG noise)
			...px(0, 0, 0), // ink
			...px(220, 30, 30), // red
			...px(255, 255, 240), // pale yellow: its darkest channel is below the cut
			...px(255, 255, 255, 0), // already transparent
		]);
		const changed = whiteToTransparent(data);
		expect(data[3]).toBe(0);
		expect(data[7]).toBe(0);
		expect(data[11]).toBe(255);
		expect(data[15]).toBe(255);
		expect(data[19]).toBeGreaterThan(0);
		expect(data[19]).toBeLessThan(255);
		expect(data[23]).toBe(0);
		expect(Array.from(data.slice(8, 11))).toEqual([0, 0, 0]);
		expect(Array.from(data.slice(12, 15))).toEqual([220, 30, 30]);
		expect(changed).toBe(3);
	});

	it("an image with no white is left alone", () => {
		const data = new Uint8ClampedArray([...px(10, 10, 10), ...px(100, 120, 140), ...px(200, 10, 10)]);
		const copy = Array.from(data);
		expect(whiteToTransparent(data)).toBe(0);
		expect(Array.from(data)).toEqual(copy);
	});

	it("keeps the document valid: the element points to a new asset, undo points back", () => {
		const doc = docWith();
		const oldId = "11".repeat(32);
		const newId = "22".repeat(32);
		doc.assets = { [oldId]: asset(oldId) };
		const page = doc.pages[0]!;
		const el = image(oldId);
		page.elements = [el];
		const hist = new History(() => doc);
		const next: ImageElement = { ...el, asset: newId };
		hist.execute(new Batch("Make white transparent", [new AddAsset(asset(newId)), new ReplaceElement(page.id, el, next)]));
		expect((page.elements[0] as ImageElement).asset).toBe(newId);
		expect(() => serializeChecked(doc)).not.toThrow();
		hist.undo();
		expect(page.elements[0]).toBe(el);
		expect(doc.assets[newId]).toBeUndefined();
	});
});
