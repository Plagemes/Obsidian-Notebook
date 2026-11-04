import { describe, expect, it } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { DEFAULT_SPLIT, findCut, normalizeSplit, planSplit, sheetSize, tileLabel, type Obstacle, type SplitSettings } from "../src/ink/export-tiles";
import { PAPER_SPACING, type Page } from "../src/model/types";
import { goldenPages, stroke, textBox } from "./export-tiles-fixture";

const dec = new TextDecoder("latin1");
const fnv = (b: Uint8Array): number => {
	let h = 2166136261;
	for (const x of b) {
		h ^= x;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
};

/** A tall infinite page with `lines` short lines of handwriting `gap` apart. */
function tall(lines: number, gap = 40, width = 600): Page {
	const strokes = [];
	for (let i = 0; i < lines; i++) strokes.push(stroke(`s${i}`, 20, 30 + i * gap, 500));
	return { id: "inf", width, height: 30 + lines * gap + 100, infinite: true, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes };
}

const base: SplitSettings = { ...DEFAULT_SPLIT, margin: 0, pageNumbers: false, overlap: 0 };

describe("non-split exports stay byte-identical", () => {
	it("matches the bytes written before the split option existed", () => {
		const bytes = pagesToPdf(goldenPages());
		expect(bytes.length).toBe(11505);
		expect(fnv(bytes)).toBe(1433184535);
	});

	it("a split option that splits nothing changes nothing", () => {
		const plain = pagesToPdf(goldenPages());
		expect(pagesToPdf(goldenPages(), { split: () => null })).toEqual(plain);
		// A plan for a page that is not infinite is null, so the option leaves ordinary pages alone.
		const only = goldenPages().slice(0, 1);
		expect(pagesToPdf(only, { split: (p) => planSplit(p, DEFAULT_SPLIT) })).toEqual(pagesToPdf(only));
	});
});

describe("normalizeSplit", () => {
	it("falls back to the defaults and snaps the numbers", () => {
		expect(normalizeSplit(null)).toEqual(DEFAULT_SPLIT);
		expect(normalizeSplit({ paper: "tabloid", margin: "x", overlap: NaN, extra: 1 })).toEqual(DEFAULT_SPLIT);
		const n = normalizeSplit({ paper: "letter", orientation: "landscape", scale: "actual", margin: 40, overlap: 30, smartCuts: false, pageNumbers: false, skipBlank: false });
		expect(n).toEqual({ paper: "letter", orientation: "landscape", scale: "actual", margin: 36, overlap: 28, smartCuts: false, pageNumbers: false, skipBlank: false });
	});

	it("turns the sheet around for landscape", () => {
		expect(sheetSize({ paper: "a4", orientation: "landscape" })).toEqual({ width: 841.89, height: 595.28 });
		expect(sheetSize({ paper: "letter", orientation: "portrait" })).toEqual({ width: 612, height: 792 });
	});
});

describe("findCut", () => {
	const box = (minY: number, maxY: number, hard = false): Obstacle => ({ minX: 0, maxX: 100, minY, maxY, hard });

	it("keeps the nominal place when the band is empty", () => {
		expect(findCut([], 80, 100)).toBe(100);
		expect(findCut([box(0, 70)], 80, 100)).toBe(100);
	});

	it("goes into the white space between two lines", () => {
		const cut = findCut([box(60, 85), box(95, 120)], 70, 110);
		expect(cut).toBeGreaterThan(85);
		expect(cut).toBeLessThan(95);
	});

	it("takes the latest of equally empty gaps, and passes over a hairline gap for a roomy one", () => {
		const cut = findCut([box(0, 20), box(30, 49.5), box(50, 70), box(90, 100)], 10, 105);
		expect(cut).toBeGreaterThan(70);
		expect(cut).toBeLessThan(90);
	});

	it("avoids a text box even when it means crossing more strokes", () => {
		const hardBox = box(80, 100, true);
		const soft = [box(40, 60), box(40, 60), box(40, 60)];
		const cut = findCut([hardBox, ...soft], 40, 100);
		expect(cut).toBeLessThan(80);
	});

	it("crosses the fewest strokes when there is no gap", () => {
		const cut = findCut([box(0, 100), box(0, 100), box(50, 100)], 0, 100);
		expect(cut).toBeLessThan(50);
	});
});

describe("planSplit", () => {
	it("splits only infinite pages with something on them", () => {
		expect(planSplit({ ...tall(10), infinite: false }, base)).toBeNull();
		expect(planSplit({ id: "e", width: 600, height: 2000, infinite: true, paper: { kind: "blank", spacing: 1 }, strokes: [] }, base)).toBeNull();
	});

	it("fits the width of the content to the printable width", () => {
		const plan = planSplit(tall(60), { ...base, margin: 36 })!;
		const printable = plan.sheetWidth - 72;
		expect(plan.scale).toBeCloseTo(printable / plan.region.width, 6);
		for (const t of plan.tiles) {
			expect(t.height * plan.scale).toBeLessThanOrEqual(plan.sheetHeight - 72 + 1e-6);
			expect(t.width * plan.scale).toBeLessThanOrEqual(printable + 1e-6);
			expect(t.ox).toBeGreaterThanOrEqual(36 - 1e-6);
			expect(t.oy).toBe(36);
		}
	});

	it("at 100% one page pt is one paper pt, and a wide page needs columns in reading order", () => {
		const wide: Page = { id: "w", width: 3000, height: 2000, infinite: true, paper: { kind: "blank", spacing: 1 }, strokes: [stroke("a", 10, 10, 2200), stroke("b", 10, 1500, 2200)] };
		const plan = planSplit(wide, { ...base, scale: "actual", skipBlank: false })!;
		expect(plan.scale).toBe(1);
		expect(plan.cols).toBeGreaterThan(1);
		expect(plan.rows).toBeGreaterThan(1);
		expect(plan.tiles).toHaveLength(plan.cols * plan.rows);
		plan.tiles.forEach((t, i) => {
			expect(t.index).toBe(i);
			expect(t.row).toBe(Math.floor(i / plan.cols));
			expect(t.col).toBe(i % plan.cols);
		});
		const first = plan.tiles[0]!;
		expect(plan.tiles[1]!.x).toBeCloseTo(first.x + first.width, 6);
	});

	it("covers the region without gaps and repeats the overlap", () => {
		const page = tall(80);
		const plan = planSplit(page, { ...base, overlap: 28, smartCuts: false, skipBlank: false })!;
		const col0 = plan.tiles.filter((t) => t.col === 0);
		expect(col0.length).toBeGreaterThan(2);
		expect(col0[0]!.y).toBeCloseTo(plan.region.y, 6);
		for (let i = 1; i < col0.length; i++) {
			const prevEnd = col0[i - 1]!.y + col0[i - 1]!.height;
			expect(col0[i]!.y).toBeCloseTo(prevEnd - 28 / plan.scale, 6);
		}
		const last = col0[col0.length - 1]!;
		expect(last.y + last.height).toBeCloseTo(plan.region.y + plan.region.height, 6);
	});

	it("cuts between lines of ink, not through them", () => {
		const page = tall(120, 40);
		const plain = planSplit(page, { ...base, smartCuts: false })!;
		const smart = planSplit(page, base)!;
		const lineTops = page.strokes.map((s) => Math.min(...s.points.map((p) => p[1])) - 1);
		const lineBottoms = page.strokes.map((s) => Math.max(...s.points.map((p) => p[1])) + 1);
		const crosses = (y: number) => lineTops.some((top, i) => top < y && lineBottoms[i]! > y);
		expect(smart.cuts.length).toBeGreaterThan(1);
		for (const c of smart.cuts) expect(crosses(c)).toBe(false);
		// The test page is built so that the plain cuts do cut some line, otherwise this proves nothing.
		expect(plain.cuts.some(crosses)).toBe(true);
		// A smart cut never makes a sheet taller than the paper.
		for (const t of smart.tiles) expect(t.height * smart.scale).toBeLessThanOrEqual(smart.sheetHeight + 1e-6);
	});

	it("never cuts through a text box when a gap is near", () => {
		const page = tall(40, 40);
		const probe = planSplit(page, base)!;
		const nominal = probe.cuts[0]! + 12;
		const withBox: Page = { ...page, elements: [textBox("big", 20, nominal - 25, 500, "x\nx\nx\nx")] };
		const plan = planSplit(withBox, base)!;
		const box = { top: nominal - 25 };
		const bottom = box.top + 14 * 1.25 * 4;
		for (const c of plan.cuts) expect(c > box.top && c < bottom).toBe(false);
	});

	it("leaves out empty sheets, but keeps one", () => {
		const gappy: Page = { id: "g", width: 600, height: 6000, infinite: true, paper: { kind: "blank", spacing: 1 }, strokes: [stroke("a", 20, 20, 500), stroke("b", 20, 5000, 500)] };
		const kept = planSplit(gappy, { ...base, scale: "actual" })!;
		const all = planSplit(gappy, { ...base, scale: "actual", skipBlank: false })!;
		expect(kept.skippedBlank).toBeGreaterThan(0);
		expect(kept.tiles.length + kept.skippedBlank).toBe(all.tiles.length);
		expect(kept.tiles.map((t) => t.index)).toEqual(kept.tiles.map((_, i) => i));
	});

	it("does not skip anything on a page with a background", () => {
		const page = { ...tall(3), background: { kind: "image" as const, asset: "x" } };
		const plan = planSplit({ ...page, height: 3000 }, { ...base, scale: "actual" })!;
		expect(plan.skippedBlank).toBe(0);
	});

	it("honours paper, orientation and the room for page numbers", () => {
		const a5 = planSplit(tall(60), { ...base, paper: "a5", orientation: "landscape" })!;
		expect(a5.sheetWidth).toBeCloseTo(595.28);
		expect(a5.sheetHeight).toBeCloseTo(419.53);
		const numbered = planSplit(tall(60), { ...base, pageNumbers: true })!;
		for (const t of numbered.tiles) expect(t.oy + t.height * numbered.scale).toBeLessThanOrEqual(numbered.sheetHeight - 22 + 1e-6);
	});

	it("is capped", () => {
		const long: Page = { id: "l", width: 100, height: 2_000_000, infinite: true, paper: { kind: "blank", spacing: 1 }, strokes: [stroke("a", 0, 0, 90), stroke("b", 0, 1_900_000, 90)] };
		const plan = planSplit(long, { ...base, scale: "actual", skipBlank: false })!;
		expect(plan.tiles.length).toBeLessThanOrEqual(200);
		expect(plan.truncated).toBe(true);
	});

	it("labels the sheets", () => {
		const plan = planSplit(tall(60), base)!;
		expect(tileLabel(plan, 0)).toBe(`1/${plan.tiles.length}`);
	});
});

describe("split PDF", () => {
	function pdf(page: Page, s: SplitSettings): { text: string; sheets: number; count: number } {
		const plan = planSplit(page, s)!;
		const bytes = pagesToPdf([page], { split: (p) => planSplit(p, s) });
		const text = dec.decode(bytes);
		return { text, sheets: plan.tiles.length, count: Number(/\/Count (\d+)/.exec(text)![1]) };
	}

	it("writes one PDF page per sheet with the sheet's size and the numbers", () => {
		const page = tall(120);
		const s = { ...DEFAULT_SPLIT, pageNumbers: true };
		const { text, sheets, count } = pdf(page, s);
		expect(sheets).toBeGreaterThan(2);
		expect(count).toBe(sheets);
		expect(text.match(/\/Type \/Page /g)).toHaveLength(sheets);
		expect(text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(sheets);
		expect(text).toContain(`(1/${sheets})`);
		expect(text).toContain(`(${sheets}/${sheets})`);
	});

	it("draws the page once however many sheets there are", () => {
		const { text, sheets } = pdf(tall(120), DEFAULT_SPLIT);
		expect(text.match(/\/Subtype \/Form/g)).toHaveLength(1);
		expect(text.match(/\/Pg Do/g)).toHaveLength(sheets);
	});

	it("leaves the numbers out when asked, and keeps ordinary pages in the same file", () => {
		const infinite = tall(120);
		const normal = goldenPages()[0]!;
		const s = { ...DEFAULT_SPLIT, pageNumbers: false };
		const plan = planSplit(infinite, s)!;
		const text = dec.decode(pagesToPdf([normal, infinite], { split: (p) => planSplit(p, s) }));
		expect(Number(/\/Count (\d+)/.exec(text)![1])).toBe(1 + plan.tiles.length);
		expect(text).not.toContain(`(1/${plan.tiles.length})`);
	});

	it("keeps a valid cross-reference table", () => {
		const page = tall(60);
		const bytes = pagesToPdf([page], { split: (p) => planSplit(p, DEFAULT_SPLIT) });
		const text = dec.decode(bytes);
		const at = Number(/startxref\n(\d+)\n/.exec(text)![1]);
		expect(text.slice(at, at + 4)).toBe("xref");
		const n = Number(/xref\n0 (\d+)\n/.exec(text)![1]);
		const offsets = [...text.slice(at).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
		expect(offsets).toHaveLength(n - 1);
		offsets.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
	});
});
