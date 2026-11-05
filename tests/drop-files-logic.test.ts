import { describe, expect, it } from "vitest";
import {
	cascadeCentres, classifyDrop, imagePageRange, locateDrop, MAX_DROP_FILES, MAX_PDF_IMAGES, planDrop, skipEntries, type DropMeta,
} from "../src/view/drop-files-logic";
import type { Layout } from "../src/ink/layout";

const os = (name: string, size = 1000, type = ""): DropMeta => ({ name, size, type, origin: "os" });
const vault = (name: string, size = 1000): DropMeta => ({ name, size, type: "", origin: "vault" });

describe("classifyDrop", () => {
	it("routes pictures, PDFs and vault notes", () => {
		expect(classifyDrop(os("a.PNG")).kind).toBe("image");
		expect(classifyDrop(os("a.pdf")).kind).toBe("pdf");
		expect(classifyDrop(os("x", 10, "image/webp")).kind).toBe("image");
		expect(classifyDrop(vault("Note.md")).kind).toBe("note");
		expect(classifyDrop(vault("Q.notebook")).kind).toBe("note");
	});
	it("leaves out what cannot be placed, with a reason", () => {
		expect(classifyDrop(os("a.svg")).skip).toBe("unsupported");
		expect(classifyDrop(os("a.heic")).skip).toBe("heic");
		expect(classifyDrop(os("a.png", 0)).skip).toBe("empty");
		expect(classifyDrop(os("a.png", 60 * 1024 * 1024)).skip).toBe("tooBig");
		expect(classifyDrop(os("n.md")).skip).toBe("unsupported");
		expect(classifyDrop(vault("a.canvas")).skip).toBe("unsupported");
	});
});

describe("planDrop", () => {
	it("keeps drop order and counts what is left out", () => {
		const plan = planDrop([os("a.png"), os("b.zip"), os("c.pdf"), os("d.zip")]);
		expect(plan.items).toEqual([{ index: 0, kind: "image" }, { index: 2, kind: "pdf" }]);
		expect(skipEntries(plan.skipped)).toEqual([{ reason: "unsupported", n: 2 }]);
	});
	it("takes at most MAX_DROP_FILES", () => {
		const plan = planDrop(Array.from({ length: MAX_DROP_FILES + 3 }, (_, i) => os(`${i}.png`)));
		expect(plan.items).toHaveLength(MAX_DROP_FILES);
		expect(plan.skipped.tooMany).toBe(3);
	});
});

describe("cascadeCentres", () => {
	const page = { width: 600, height: 800 };
	it("steps down and right from the drop point", () => {
		expect(cascadeCentres(3, 100, 100, page, 20)).toEqual([[100, 100], [120, 120], [140, 140]]);
	});
	it("starts over before running off the page", () => {
		const c = cascadeCentres(5, 560, 100, page, 20);
		expect(c.every(([x]) => x <= 600)).toBe(true);
		expect(c[0]).toEqual([560, 100]);
	});
	it("handles none and a point at the corner", () => {
		expect(cascadeCentres(0, 1, 1, page)).toEqual([]);
		expect(cascadeCentres(2, 600, 800, page)).toEqual([[600, 800], [600, 800]]);
	});
});

describe("locateDrop", () => {
	const layout: Layout = { boxes: [{ x: 0, y: 0, width: 600, height: 800 }, { x: 0, y: 824, width: 600, height: 800 }], width: 600, height: 1624 };
	const stage = { left: 100, top: 50, right: 700, bottom: 650 };
	it("maps a client point to page coordinates through the zoom and pan", () => {
		const p = locateDrop(layout, { scale: 2, offsetX: 20, offsetY: 10 }, stage, 300, 250);
		expect(p).toEqual({ pageIndex: 0, x: 90, y: 95 });
	});
	it("uses the page that is under the point, in its own coordinates", () => {
		const p = locateDrop(layout, { scale: 1, offsetX: 0, offsetY: -800 }, stage, 150, 100 + 0);
		expect(p?.pageIndex).toBe(1);
		expect(p?.y).toBeCloseTo(850 - 824 - 0, 5);
	});
	it("falls back to the nearest page in a gap and refuses points outside the stage", () => {
		expect(locateDrop(layout, { scale: 1, offsetX: 0, offsetY: 0 }, stage, 150, 50 + 810)).toBeNull();
		expect(locateDrop(layout, { scale: 1, offsetX: 0, offsetY: 0 }, stage, 50, 100)).toBeNull();
		expect(locateDrop(null, { scale: 1, offsetX: 0, offsetY: 0 }, stage, 150, 100)).toBeNull();
	});
});

describe("imagePageRange", () => {
	it("cuts a long range", () => {
		expect(imagePageRange({ from: 2, to: 4 })).toEqual({ from: 2, to: 4, cut: false });
		expect(imagePageRange({ from: 1, to: 100 })).toEqual({ from: 1, to: MAX_PDF_IMAGES, cut: true });
	});
});
