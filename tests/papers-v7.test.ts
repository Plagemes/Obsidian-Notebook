/** v7 paper kinds (#73): pattern geometry, on-screen density, culling and export. */
import { describe, expect, it } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { minorVisible, paperPattern, type PaperLine } from "../src/ink/paper";
import {
	CALLIGRAPHY_SLANT_DEG, CORNELL_CUE_RATIO, CORNELL_SUMMARY_RATIO, MUSIC_PERIOD_GAPS, MUSIC_TOP, PLANNER_HEADER_ROWS, V7_PAPER_KINDS,
} from "../src/ink/paper-kinds";
import { A4_HEIGHT, A4_WIDTH, PAPER_KINDS_V7, PAPER_SPACING, type Page, type PaperKind } from "../src/model/types";

function page(kind: PaperKind, width = A4_WIDTH, height = A4_HEIGHT, spacing = PAPER_SPACING[kind]): Page {
	return { id: "p", width, height, paper: { kind, spacing }, strokes: [] };
}
const whole = (p: Page) => ({ minX: 0, minY: 0, maxX: p.width, maxY: p.height });
const horizontalAt = (lines: PaperLine[], y: number) => lines.filter((l) => Math.abs(l.y1 - y) < 1e-6 && Math.abs(l.y2 - y) < 1e-6);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("v7 paper kinds", () => {
	it("every v7 kind has its own geometry", () => {
		expect([...V7_PAPER_KINDS].sort()).toEqual([...PAPER_KINDS_V7].sort());
	});

	it.each(PAPER_KINDS_V7)("%s: lines inside the page, none on its edge, minor ones dropped when too dense", (kind) => {
		for (const p of [page(kind), page(kind, A4_HEIGHT, A4_WIDTH)]) {
			const { lines, dots } = paperPattern(p, whole(p));
			expect(lines.length).toBeGreaterThan(0);
			expect(dots).toEqual([]);
			for (const l of lines) {
				for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]] as const) {
					expect(x).toBeGreaterThanOrEqual(-1e-6);
					expect(x).toBeLessThanOrEqual(p.width + 1e-6);
					expect(y).toBeGreaterThanOrEqual(-1e-6);
					expect(y).toBeLessThanOrEqual(p.height + 1e-6);
				}
				const horizontalEdge = near(l.y1, l.y2) && (near(l.y1, 0) || near(l.y1, p.height));
				const verticalEdge = near(l.x1, l.x2) && (near(l.x1, 0) || near(l.x1, p.width));
				expect(horizontalEdge || verticalEdge).toBe(false);
			}
			const coarse = paperPattern(p, whole(p), { includeMinor: false }).lines;
			expect(coarse.every((l) => l.kind !== "minor")).toBe(true);
			expect(coarse.length).toBeLessThan(lines.length);
			// The same input gives the same pattern.
			expect(paperPattern(p, whole(p))).toEqual({ lines, dots });
		}
	});

	it.each(PAPER_KINDS_V7)("%s: only segments that cross the visible area, and a subset of the whole pattern", (kind) => {
		const p = page(kind);
		const visible = { minX: 100, minY: 300, maxX: 250, maxY: 420 };
		const all = paperPattern(p, whole(p)).lines;
		const part = paperPattern(p, visible).lines;
		expect(part.length).toBeGreaterThan(0);
		expect(part.length).toBeLessThan(all.length);
		const key = (l: PaperLine) => [l.x1, l.y1, l.x2, l.y2, l.kind].map((v) => (typeof v === "number" ? v.toFixed(4) : v)).join();
		const keys = new Set(all.map(key));
		for (const l of part) {
			expect(keys.has(key(l))).toBe(true);
			expect(Math.max(l.x1, l.x2)).toBeGreaterThanOrEqual(visible.minX - 1e-6);
			expect(Math.min(l.x1, l.x2)).toBeLessThanOrEqual(visible.maxX + 1e-6);
			expect(Math.max(l.y1, l.y2)).toBeGreaterThanOrEqual(visible.minY - 1e-6);
			expect(Math.min(l.y1, l.y2)).toBeLessThanOrEqual(visible.maxY + 1e-6);
		}
		expect(paperPattern(p, { minX: -100, minY: -100, maxX: -50, maxY: -50 }).lines).toEqual([]);
	});

	it.each(PAPER_KINDS_V7)("%s: an absurd density is refused quickly instead of looping", (kind) => {
		const p = page(kind, 595, 100_000, 0.5);
		const started = Date.now();
		const r = paperPattern(p, whole(p));
		expect(Date.now() - started).toBeLessThan(2000);
		expect(r.lines.length).toBeLessThan(1_500_000);
	});

	it("Cornell: header and summary lines, a cue column between them", () => {
		const p = page("cornell");
		const { lines } = paperPattern(p, whole(p));
		const summary = p.height * (1 - CORNELL_SUMMARY_RATIO);
		expect(horizontalAt(lines, summary).map((l) => l.kind)).toEqual(["major"]);
		const cue = lines.filter((l) => l.kind === "margin");
		expect(cue).toHaveLength(1);
		expect(cue[0]!.x1).toBeCloseTo(p.width * CORNELL_CUE_RATIO);
		expect(cue[0]!.y2).toBeCloseTo(summary);
	});

	it("music: staves of five lines, outer ones major", () => {
		const p = page("music");
		const s = p.paper.spacing;
		const { lines } = paperPattern(p, whole(p));
		const first = [0, 1, 2, 3, 4].map((i) => horizontalAt(lines, MUSIC_TOP + i * s)[0]?.kind);
		expect(first).toEqual(["major", "minor", "minor", "minor", "major"]);
		expect(horizontalAt(lines, MUSIC_TOP + 5 * s)).toEqual([]);
		expect(horizontalAt(lines, MUSIC_TOP + MUSIC_PERIOD_GAPS * s)).toHaveLength(1);
		expect(lines.length % 5).toBe(0);
	});

	it("isometric: vertical lines and lines at ±30°", () => {
		const p = page("isometric");
		const slopes = new Set(paperPattern(p, whole(p)).lines.map((l) => (near(l.x1, l.x2) ? "v" : ((l.y2 - l.y1) / (l.x2 - l.x1)).toFixed(4))));
		expect([...slopes].sort()).toEqual(["-0.5774", "0.5774", "v"]);
	});

	it("hexagonal: edges of side `spacing`, each drawn once", () => {
		const p = page("hexagonal");
		const { lines } = paperPattern(p, whole(p));
		const inner = lines.filter((l) => l.x1 > 1 && l.x2 > 1 && l.x1 < p.width - 1 && l.x2 < p.width - 1 && l.y1 > 1 && l.y2 > 1 && l.y1 < p.height - 1 && l.y2 < p.height - 1);
		for (const l of inner) expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).toBeCloseTo(p.paper.spacing, 4);
		const key = (l: PaperLine) => {
			const a = `${l.x1.toFixed(3)},${l.y1.toFixed(3)}`;
			const b = `${l.x2.toFixed(3)},${l.y2.toFixed(3)}`;
			return a < b ? `${a}|${b}` : `${b}|${a}`;
		};
		expect(new Set(lines.map(key)).size).toBe(lines.length);
	});

	it("calligraphy: baselines are major, slant guides lean at the configured angle", () => {
		const p = page("calligraphy");
		const { lines } = paperPattern(p, whole(p));
		const slanted = lines.filter((l) => !near(l.y1, l.y2));
		expect(slanted.length).toBeGreaterThan(0);
		const inner = slanted.filter((l) => l.x1 > 0 && l.x2 < p.width);
		for (const l of inner) expect(Math.atan2(l.y1 - l.y2, l.x2 - l.x1) * 180 / Math.PI).toBeCloseTo(CALLIGRAPHY_SLANT_DEG, 6);
		const coarse = paperPattern(p, whole(p), { includeMinor: false }).lines;
		expect(coarse.every((l) => l.kind === "major" && near(l.y1, l.y2))).toBe(true);
	});

	it("planners: a header line; the week has eight boxes (2 × 4 portrait, 4 × 2 landscape)", () => {
		for (const kind of ["planner-day", "planner-week"] as const) {
			const p = page(kind);
			expect(horizontalAt(paperPattern(p, whole(p)).lines, PLANNER_HEADER_ROWS * p.paper.spacing).some((l) => l.kind === "major")).toBe(true);
		}
		const verticals = (p: Page) => paperPattern(p, whole(p), { includeMinor: false }).lines.filter((l) => near(l.x1, l.x2) && l.kind === "major");
		expect(verticals(page("planner-week"))).toHaveLength(1);
		expect(verticals(page("planner-week", A4_HEIGHT, A4_WIDTH))).toHaveLength(3);
		const day = paperPattern(page("planner-day"), whole(page("planner-day")), { includeMinor: false }).lines;
		expect(day.filter((l) => l.kind === "margin")).toHaveLength(1);
	});

	it("on screen the minor lines follow the usual 3 px rule", () => {
		expect(minorVisible(PAPER_SPACING.music, 0.4)).toBe(false);
		expect(minorVisible(PAPER_SPACING.music, 1)).toBe(true);
		expect(minorVisible(PAPER_SPACING.hexagonal, 0.5)).toBe(true);
	});

	it.each(PAPER_KINDS_V7)("%s: exported to SVG and PDF with the same pattern", (kind) => {
		const p = page(kind);
		const svg = pageToSvg(p);
		expect(svg).toContain('stroke="#');
		expect((svg.match(/<path d="M/g) ?? []).length).toBeGreaterThan(0);
		const pdf = new TextDecoder("latin1").decode(pagesToPdf([p]));
		expect(pdf).toContain(" l");
	});
});
