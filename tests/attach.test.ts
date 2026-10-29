import { describe, expect, it } from "vitest";
import { ATTACH_SHARE, attachedInk, deleteInkCommand, inkOnRemoved, inkOwner, pointOnElement, shareOnElement } from "../src/ink/attach";
import { transformElement } from "../src/ink/elements";
import { transformStroke } from "../src/ink/lasso";
import { rotateAbout, scaleAbout, translate } from "../src/ink/transform";
import { createDocument, createId, createStroke, quantizePoint } from "../src/model/document";
import { Batch, History, RemoveElement, ReplaceElement, ReplaceStroke } from "../src/model/history";
import { serializeChecked } from "../src/model/serialize";
import type { ImageElement, Point, TextElement } from "../src/model/types";
import { line } from "./helpers";

const image = (x: number, y: number, w: number, h: number, rotation = 0): ImageElement =>
	({ id: createId(), type: "image", asset: "ab", x, y, width: w, height: h, rotation });
const text = (x: number, y: number): TextElement => ({ id: createId(), type: "text", x, y, width: 100, text: "hello", fontSize: 14, color: "#1e1e1e" });
const stroke = (pts: Array<[number, number]>) => createStroke("#1e1e1e", 2, pts.map(([x, y]): Point => quantizePoint(x, y, 0.5)));

describe("ink attached to objects: geometry", () => {
	it("a stroke belongs to an element when at least 60% of its points are inside", () => {
		const img = image(100, 100, 200, 100);
		const inside = line(120, 120, 280, 180);
		const outside = line(10, 10, 60, 10);
		const crossing = stroke([[50, 150], [80, 150], [110, 150], [150, 150], [200, 150], [250, 150]]); // 4 of 6 inside
		const halfOut = stroke([[50, 150], [80, 150], [110, 150], [150, 150]]); // 2 of 4 inside
		expect(ATTACH_SHARE).toBe(0.6);
		expect(shareOnElement(inside, img)).toBe(1);
		expect(shareOnElement(outside, img)).toBe(0);
		expect(inkOwner(inside, [img])).toBe(img);
		expect(inkOwner(outside, [img])).toBeNull();
		expect(inkOwner(crossing, [img])).toBe(img);
		expect(inkOwner(halfOut, [img])).toBeNull();
	});

	it("follows the rotation of an image", () => {
		const img = image(100, 100, 200, 20, Math.PI / 2); // a tall bar centred on (200, 110)
		expect(pointOnElement(img, 200, 40)).toBe(true);
		expect(pointOnElement(img, 130, 110)).toBe(false);
	});

	it("text boxes hold ink written over their laid-out box", () => {
		const tx = text(50, 50);
		const over = line(55, 55, 120, 58);
		expect(inkOwner(over, [tx])).toBe(tx);
		expect(inkOwner(line(300, 300, 340, 300), [tx])).toBeNull();
	});

	it("belongs to the topmost element when elements overlap", () => {
		const below = image(0, 0, 300, 300);
		const above = image(50, 50, 100, 100);
		const s = line(60, 60, 140, 140);
		expect(inkOwner(s, [below, above])).toBe(above);
		// Only the lower image moves: ink written on the upper one stays where it is.
		expect(attachedInk([s], [below, above], [below])).toEqual([]);
		expect(attachedInk([s], [below, above], [above])).toEqual([s]);
		// A stroke outside the upper image still belongs to the lower one.
		const t = line(200, 200, 280, 280);
		expect(attachedInk([s, t], [below, above], [below])).toEqual([t]);
	});

	it("leaves out strokes that are already selected and strokes elsewhere", () => {
		const img = image(100, 100, 200, 100);
		const a = line(120, 120, 280, 180);
		const b = line(130, 130, 200, 140);
		const far = line(500, 500, 560, 500);
		expect(attachedInk([a, b, far], [img], [img])).toEqual([a, b]);
		expect(attachedInk([a, b, far], [img], [img], new Set([a]))).toEqual([b]);
		expect(attachedInk([a], [img], [])).toEqual([]);
	});

	it("finds the ink to offer deleting with a removed element", () => {
		const img = image(100, 100, 200, 100);
		const other = image(400, 100, 100, 100);
		const a = line(120, 120, 280, 180);
		const b = line(420, 120, 480, 180);
		expect(inkOnRemoved([a, b], [img, other], [img])).toEqual([a]);
		expect(inkOnRemoved([a, b], [img, other], [img, other])).toEqual([a, b]);
	});
});

describe("ink attached to objects: moving with the element", () => {
	function scene() {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const page = doc.pages[0]!;
		doc.assets = { ab: { id: "ab", kind: "image", path: "Notebooks/_assets/ab.png", name: "a.png", bytes: 3 } };
		const img = image(100, 100, 200, 100);
		page.elements = [img];
		const over = line(120, 120, 280, 180);
		const free = line(10, 400, 100, 400);
		page.strokes.push(over, free);
		return { doc, page, img, over, free };
	}

	function transformAll(page: ReturnType<typeof scene>["page"], m: Parameters<typeof transformStroke>[1]) {
		const img = page.elements![0]!;
		const extra = attachedInk(page.strokes, page.elements!, [img]);
		const commands = [
			...extra.map((s) => new ReplaceStroke(page.id, s, [transformStroke(s, m)], page.strokes.indexOf(s))),
			new ReplaceElement(page.id, img, transformElement(img, m)),
		];
		return { extra, batch: new Batch("Transform selection", commands) };
	}

	it("moves, scales and rotates the ink with the element, in one undo step", () => {
		const { doc, page, over, free } = scene();
		const hist = new History(() => doc);
		const { extra, batch } = transformAll(page, translate(40, 10));
		expect(extra).toEqual([over]);
		hist.execute(batch);
		expect(page.strokes[0]!.points[0]!.slice(0, 2)).toEqual([160, 130]);
		expect(page.strokes[1]).toBe(free);
		expect((page.elements![0] as ImageElement).x).toBe(140);
		// The moved ink is still on the image.
		expect(inkOwner(page.strokes[0]!, page.elements!)).toBe(page.elements![0]);
		expect(() => serializeChecked(doc)).not.toThrow();
		hist.undo();
		expect(page.strokes[0]).toBe(over);
		expect((page.elements![0] as ImageElement).x).toBe(100);
		expect(hist.canUndo()).toBe(false);
	});

	it("keeps the ink on the image through a scale and a rotation", () => {
		for (const m of [scaleAbout(1.5, 1.5, 100, 100), rotateAbout(Math.PI / 6, 200, 150), rotateAbout(Math.PI / 2, 200, 150)]) {
			const { doc, page } = scene();
			const hist = new History(() => doc);
			hist.execute(transformAll(page, m).batch);
			const owner = inkOwner(page.strokes[0]!, page.elements!);
			expect(owner).toBe(page.elements![0]);
			expect(page.strokes[0]!.width).toBeGreaterThan(0);
		}
	});

	it("deleting the ink with its element is one undo step of its own", () => {
		const { doc, page, img, over, free } = scene();
		const hist = new History(() => doc);
		hist.execute(new Batch("Delete selection", [new RemoveElement(page.id, img)]));
		const owned = inkOnRemoved(page.strokes, [img], [img]);
		expect(owned).toEqual([over]);
		const cmd = deleteInkCommand(page.id, page.strokes, owned)!;
		hist.execute(cmd);
		expect(page.strokes).toEqual([free]);
		hist.undo();
		expect(page.strokes).toEqual([over, free]);
		expect(page.elements).toEqual([]);
		hist.undo();
		expect(page.elements).toEqual([img]);
		expect(deleteInkCommand(page.id, page.strokes, [])).toBeNull();
	});
});
