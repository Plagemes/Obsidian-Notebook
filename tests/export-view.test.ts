// wave 0.9: export choices (381), Markdown export (382), night mode (367) and the cropped view of PDF pages (376).
import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, isRelevant } from "../src/ui/actions";
import { placementsOf } from "../src/ui/layout";
import { layerFlags, layersSuffix, planExport } from "../src/ink/export-layers";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { fitPageViewport } from "../src/ink/page-mode";
import { layoutPages, withWindows } from "../src/ink/layout";
import { contrastRatio, formatColor, nightHighlighter, nightInk, nightLine, NIGHT_MIN_CONTRAST, NIGHT_PAPER, parseColor, toHsl } from "../src/ink/night";
import { clampToPage, fitWidth, PAGE_MARGIN } from "../src/ink/viewport";
import {
	buildNotebookMarkdown, escapeTextLine, linkTarget, pageImageName, pageTexts, planMarkdownFiles, renderScale, renderSize, uniqueFileName,
	MAX_RENDER_PIXELS, MAX_RENDER_SIDE,
} from "../src/model/export-markdown";
import { createPage, createStroke } from "../src/model/document";
import type { Page, TextElement } from "../src/model/types";
import { detectContentBox, pageWindow, type Bitmap } from "../src/pdf/content-box";
import { DEFAULT_READING_SETTINGS, readReadingSettings } from "../src/view/reading-settings";
import { line } from "./helpers";

function page(): Page {
	const p = createPage({ width: 400, height: 600 }, { kind: "grid", spacing: 20 });
	p.strokes.push(line(50, 80, 300, 90, 12, 3));
	p.elements = [{ id: "t1", type: "text", x: 40, y: 200, width: 200, text: "Hello notebook", fontSize: 14, color: "#1e1e1e" }];
	return p;
}

describe("export layers (381)", () => {
	it("maps each choice to the parts it draws", () => {
		expect(layerFlags(undefined)).toEqual({ background: true, content: true });
		expect(layerFlags("both")).toEqual({ background: true, content: true });
		expect(layerFlags("ink")).toEqual({ background: false, content: true });
		expect(layerFlags("background")).toEqual({ background: true, content: false });
		expect([layersSuffix("both"), layersSuffix("ink"), layersSuffix("background")]).toEqual(["", " ink", " background"]);
	});

	it("plans one file for a page or a PDF, one SVG per page for a notebook", () => {
		expect(planExport("pdf", "page", 1, 3)).toEqual([{ format: "pdf", pages: [1], suffix: " p2" }]);
		expect(planExport("pdf", "notebook", 0, 3, "ink")).toEqual([{ format: "pdf", pages: [0, 1, 2], suffix: " ink" }]);
		expect(planExport("svg", "notebook", 0, 3, "background").map((j) => [j.pages, j.suffix])).toEqual([[[0], " p1 background"], [[1], " p2 background"], [[2], " p3 background"]]);
		expect(planExport("svg", "page", 5, 3)).toEqual([]);
		expect(planExport("pdf", "notebook", 0, 0)).toEqual([]);
	});

	it("SVG: ink only has no sheet and no paper, background only has no ink, both is the old output", () => {
		const p = page();
		const both = pageToSvg(p);
		expect(pageToSvg(p, { layers: "both" })).toBe(both);
		expect(both).toContain('fill="#ffffff"');
		expect(both).toContain("Hello notebook");
		const ink = pageToSvg(p, { layers: "ink" });
		expect(ink).not.toContain('fill="#ffffff"/>');
		expect(ink).not.toContain("stroke-width=\"0.3\"");
		expect(ink).toContain("Hello notebook");
		expect(ink).toContain('fill="#1e1e1e"');
		expect(ink.trim().endsWith("</svg>")).toBe(true);
		const bg = pageToSvg(p, { layers: "background" });
		expect(bg).toContain('fill="#ffffff"');
		expect(bg).toContain("stroke-width=\"0.3\"");
		expect(bg).not.toContain("Hello notebook");
		expect(bg).not.toContain('fill="#1e1e1e"');
		expect(bg.trim().endsWith("</svg>")).toBe(true);
	});

	it("SVG: images follow their layer", () => {
		const p = page();
		const images = () => [
			{ href: "data:image/png;base64,AAAA", x: 0, y: 0, width: 400, height: 600, layer: "background" as const },
			{ href: "data:image/png;base64,BBBB", x: 10, y: 10, width: 50, height: 50, layer: "element" as const },
		];
		const ink = pageToSvg(p, { layers: "ink", images });
		expect(ink).toContain("BBBB");
		expect(ink).not.toContain("AAAA");
		const bg = pageToSvg(p, { layers: "background", images });
		expect(bg).toContain("AAAA");
		expect(bg).not.toContain("BBBB");
	});

	it("PDF: ink only has no white sheet, background only has no ink", () => {
		const p = page();
		const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
		const both = text(pagesToPdf([p]));
		const ink = text(pagesToPdf([p], { layers: "ink" }));
		const bg = text(pagesToPdf([p], { layers: "background" }));
		expect(text(pagesToPdf([p], { layers: "both" }))).toBe(both);
		expect(both).toContain("1 1 1 rg 0 0 400 600 re f");
		expect(ink).not.toContain("1 1 1 rg 0 0 400 600 re f");
		expect(bg).toContain("1 1 1 rg 0 0 400 600 re f");
		expect(both).toContain("Tj");
		expect(ink).toContain("Tj");
		expect(bg).not.toContain("Tj");
		expect(ink.length).toBeLessThan(both.length);
		expect(bg.length).toBeLessThan(both.length);
		expect(ink.startsWith("%PDF-")).toBe(true);
		expect(ink).toContain("/Count 1");
	});

	it("hidden ink keeps following its own rule in every layer", () => {
		const p = page();
		const hidden = createStroke("#ff0000", 3, line(10, 300, 200, 310).points);
		hidden.hidden = true;
		p.strokes.push(hidden);
		expect(pageToSvg(p, { layers: "ink" })).not.toContain("#ff0000");
		expect(pageToSvg(p, { layers: "ink", hiddenInk: true })).toContain("#ff0000");
	});
});

describe("Markdown export (382)", () => {
	it("names the page images with at least three digits", () => {
		expect(pageImageName(0, 5)).toBe("page-001.png");
		expect(pageImageName(41, 120)).toBe("page-042.png");
		expect(pageImageName(1000, 1500)).toBe("page-1001.png");
	});

	it("never picks a name that exists", () => {
		expect(uniqueFileName("notebook.md", () => false)).toBe("notebook.md");
		const taken = new Set(["notebook.md", "notebook 2.md"]);
		expect(uniqueFileName("notebook.md", (n) => taken.has(n))).toBe("notebook 3.md");
		expect(uniqueFileName("page-001.png", (n) => n === "page-001.png")).toBe("page-001 2.png");
	});

	it("plans every file of an export around the files already in the folder", () => {
		const existing = new Set(["Export/page-002.png", "Export/notebook.md"]);
		const plan = planMarkdownFiles("Export", 3, (path) => existing.has(path));
		expect(plan.images).toEqual(["page-001.png", "page-002 2.png", "page-003.png"]);
		expect(plan.markdown).toBe("notebook 2.md");
		expect(new Set(plan.images).size).toBe(3);
		expect(planMarkdownFiles("", 1, () => false)).toEqual({ images: ["page-001.png"], markdown: "notebook.md" });
		expect(planMarkdownFiles("A/B/", 1, (p) => p === "A/B/page-001.png").images).toEqual(["page-001 2.png"]);
	});

	it("encodes the characters that break a Markdown link", () => {
		expect(linkTarget("page-001.png")).toBe("page-001.png");
		expect(linkTarget("page-001 2.png")).toBe("page-001%202.png");
		expect(linkTarget("a(b).png")).toBe("a%28b%29.png");
	});

	it("keeps user text from becoming headings or lists", () => {
		expect(escapeTextLine("# not a title")).toBe("\\# not a title");
		expect(escapeTextLine("- item")).toBe("\\- item");
		expect(escapeTextLine("1. one")).toBe("\\1. one");
		expect(escapeTextLine("plain # text")).toBe("plain # text");
	});

	it("reads text boxes top to bottom, then left to right, and skips empty ones", () => {
		const t = (id: string, x: number, y: number, text: string): TextElement => ({ id, type: "text", x, y, width: 100, text, fontSize: 12, color: "#000000" });
		const texts = pageTexts({ elements: [t("c", 200, 50, "right"), t("b", 10, 50, "left"), t("a", 10, 10, "top\nsecond line"), t("e", 0, 500, "   ")] });
		expect(texts).toEqual(["top  \nsecond line", "left", "right"]);
		expect(pageTexts({})).toEqual([]);
	});

	it("builds notebook.md: title, bookmarks as headings, page images, text boxes", () => {
		const p1 = page();
		const p2 = createPage({ width: 400, height: 600 });
		const p3 = createPage({ width: 400, height: 600 });
		p1.elements = [{ id: "t1", type: "text", x: 0, y: 100, width: 100, text: "# Intro", fontSize: 12, color: "#000000" }];
		const md = buildNotebookMarkdown({
			title: "Analysis 1", pages: [p1, p2, p3],
			meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [p1.id, p3.id], bookmarkInfo: { [p1.id]: { title: "Limits" } } },
			images: ["page-001.png", "page-002.png", "page-003 2.png"], pageLabel: (n) => `Page ${n}`,
		});
		expect(md).toBe([
			"# Analysis 1", "## Limits", "![](page-001.png)", "\\# Intro", "![](page-002.png)", "## Page 3", "![](page-003%202.png)",
		].join("\n\n") + "\n");
	});

	it("sizes the renders by resolution and caps huge pages", () => {
		const a4 = { width: 595, height: 842 };
		expect(renderScale(a4, 144)).toBeCloseTo(2, 5);
		expect(renderSize(a4, 72)).toMatchObject({ width: 595, height: 842 });
		const tall = { width: 595, height: 40000 };
		const size = renderSize(tall, 200);
		expect(size.height).toBeLessThanOrEqual(MAX_RENDER_SIDE);
		expect(size.width * size.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS + size.width + size.height);
		expect(renderSize({ width: 0, height: 0 }, 150).width).toBeGreaterThanOrEqual(1);
	});
});

describe("night mode (367)", () => {
	const PAPER = parseColor(NIGHT_PAPER)!;

	it("parses and formats colours", () => {
		expect(parseColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30, a: 1 });
		expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
		expect(parseColor("not a colour")).toBeNull();
		expect(formatColor({ r: 255, g: 128, b: 0, a: 1 })).toBe("#ff8000");
	});

	it("turns near-black ink light and leaves white alone", () => {
		for (const dark of ["#000000", "#1e1e1e", "#222222"]) {
			const out = parseColor(nightInk(dark))!;
			expect(toHsl(out).l, dark).toBeGreaterThan(0.75);
		}
		expect(nightInk("#ffffff")).toBe("#ffffff");
	});

	it("keeps every ink readable on the night paper and keeps the hue", () => {
		const palette = ["#1e1e1e", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#6741d9", "#0000ff", "#8b0000", "#006400", "#800080", "#ffffff", "#9ca3af"];
		for (const c of palette) {
			const out = parseColor(nightInk(c))!;
			expect(contrastRatio(out, PAPER), `${c} -> ${formatColor(out)}`).toBeGreaterThanOrEqual(NIGHT_MIN_CONTRAST - 0.05);
			const before = toHsl(parseColor(c)!);
			const after = toHsl(out);
			if (before.s > 0.4 && before.l > 0.1 && before.l < 0.9) {
				const d = Math.abs(before.h - after.h);
				expect(Math.min(d, 360 - d), `${c} hue`).toBeLessThan(8);
			}
		}
	});

	it("leaves colours it cannot read untouched and keeps translucency", () => {
		expect(nightInk("var(--text)")).toBe("var(--text)");
		expect(nightInk("rgba(0, 0, 0, 0.5)")).toMatch(/^rgba\(/);
	});

	it("keeps the highlighter lively and the paper lines dim", () => {
		const yellow = toHsl(parseColor(nightHighlighter("#ffe066"))!);
		expect(yellow.l).toBeGreaterThanOrEqual(0.45);
		expect(yellow.l).toBeLessThanOrEqual(0.62);
		expect(yellow.s).toBeGreaterThan(0.6);
		expect(Math.abs(yellow.h - toHsl(parseColor("#ffe066")!).h)).toBeLessThan(3);
		for (const c of ["#cfdcea", "#9fb6cf", "#e9a3a3", "#8fa5bd"]) {
			const out = parseColor(nightLine(c))!;
			expect(contrastRatio(out, PAPER), c).toBeLessThan(3);
			expect(toHsl(out).l, c).toBeGreaterThan(toHsl(PAPER).l);
		}
	});
});

describe("content box of a PDF page (376)", () => {
	function bitmap(width: number, height: number, ink: Array<[number, number, number, number]>, background = 255): Bitmap {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < width * height; i++) data.set([background, background, background, 255], i * 4);
		for (const [x0, y0, x1, y1] of ink) {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([20, 20, 20, 255], (y * width + x) * 4);
		}
		return { data, width, height };
	}

	it("finds the bounds of the non-white pixels", () => {
		const box = detectContentBox(bitmap(100, 140, [[20, 30, 80, 110]]), { padding: 0 })!;
		expect(box.x).toBeCloseTo(0.2, 5);
		expect(box.y).toBeCloseTo(30 / 140, 5);
		expect(box.width).toBeCloseTo(0.6, 5);
		expect(box.height).toBeCloseTo(80 / 140, 5);
	});

	it("adds a little padding and stays inside the page", () => {
		const box = detectContentBox(bitmap(100, 100, [[1, 1, 99, 99]]))!;
		expect(box).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		const padded = detectContentBox(bitmap(100, 100, [[40, 40, 60, 60]]), { minWidth: 0.1, minHeight: 0.1 })!;
		expect(padded.x).toBeCloseTo(0.38, 5);
		expect(padded.width).toBeCloseTo(0.24, 5);
	});

	it("ignores a stray speck, light grey noise and transparent pixels", () => {
		const speck = bitmap(100, 100, [[2, 2, 3, 3], [30, 30, 70, 70]]);
		const box = detectContentBox(speck, { padding: 0 })!;
		expect(box.x).toBeCloseTo(0.3, 5);
		const grey = bitmap(100, 100, [], 250);
		expect(detectContentBox(grey)).toBeNull();
		const clear = bitmap(10, 10, [[0, 0, 10, 10]]);
		for (let i = 0; i < 100; i++) (clear.data as Uint8ClampedArray)[i * 4 + 3] = 0;
		expect(detectContentBox(clear)).toBeNull();
	});

	it("gives null for a blank or empty bitmap and never a sliver", () => {
		expect(detectContentBox(bitmap(50, 50, []))).toBeNull();
		expect(detectContentBox({ data: [], width: 0, height: 0 })).toBeNull();
		const tiny = detectContentBox(bitmap(100, 100, [[50, 50, 52, 52]]))!;
		expect(tiny.width).toBeGreaterThanOrEqual(0.3 - 1e-9);
		expect(tiny.height).toBeGreaterThanOrEqual(0.15 - 1e-9);
	});

	it("makes the window of a page, widened to hold the reader's ink", () => {
		const p = createPage({ width: 400, height: 600 });
		p.background = { kind: "pdf", asset: "a", page: 1 };
		const w = pageWindow(p, { x: 0.25, y: 0.1, width: 0.5, height: 0.8 })!;
		expect(w).toEqual({ x: 100, width: 200 });
		p.strokes.push(line(20, 300, 150, 310, 8, 2));
		const widened = pageWindow(p, { x: 0.25, y: 0.1, width: 0.5, height: 0.8 })!;
		expect(widened.x).toBeLessThan(20);
		expect(widened.x + widened.width).toBeCloseTo(300, 5);
		expect(pageWindow(p, null)).toBeNull();
	});

	it("respects the margins of the page", () => {
		const p = createPage({ width: 500, height: 600 });
		p.background = { kind: "pdf", asset: "a", page: 1 };
		p.margins = { left: 100, right: 0, bottom: 0 };
		const w = pageWindow(p, { x: 0, y: 0, width: 0.5, height: 1 })!;
		expect(w).toEqual({ x: 100, width: 200 });
	});
});

describe("the cropped view fits the window, not the page (376)", () => {
	const view = { width: 400, height: 800 };

	it("fits the window to the width and keeps the page coordinates", () => {
		const whole = fitWidth(view, { width: 600, height: 800 });
		const cropped = fitWidth(view, { width: 600, height: 800, window: { x: 100, width: 400 } });
		expect(cropped.scale).toBeGreaterThan(whole.scale);
		expect(cropped.scale).toBeCloseTo((400 - 2 * PAGE_MARGIN) / 400, 10);
		// The window starts PAGE_MARGIN from the left edge of the view: window.x * scale + offsetX.
		expect(100 * cropped.scale + cropped.offsetX).toBeCloseTo(PAGE_MARGIN, 8);
		expect(fitWidth(view, { width: 600, height: 800 })).toEqual(whole);
	});

	it("clamps the pan to the window", () => {
		const page = { width: 600, height: 800, window: { x: 100, width: 400 } };
		const v = fitWidth(view, page);
		const far = clampToPage({ ...v, offsetX: 5000 }, view, page);
		expect(100 * v.scale + far.offsetX).toBeCloseTo(PAGE_MARGIN, 8);
		const farLeft = clampToPage({ ...v, offsetX: -5000 }, view, page);
		expect(500 * v.scale + farLeft.offsetX).toBeCloseTo(view.width - PAGE_MARGIN, 8);
	});

	it("sets windows on the boxes and a layout window that is the union, dropping the useless ones", () => {
		const layout = layoutPages([{ width: 600, height: 800 }, { width: 600, height: 800 }]);
		const same = withWindows(layout, () => null);
		expect(same).toBe(layout);
		expect(withWindows(layout, () => ({ x: 0, width: 598 }))).toBe(layout);
		const shaped = withWindows(layout, (i) => (i === 0 ? { x: 100, width: 300 } : { x: 150, width: 300 }));
		expect(shaped.boxes[0]!.window).toEqual({ x: 100, width: 300 });
		expect(shaped.window).toEqual({ x: 100, width: 350 });
		expect(shaped.boxes[0]!.x).toBe(layout.boxes[0]!.x);
		expect(shaped.height).toBe(layout.height);
	});

	it("a page without a window keeps the whole width in the union", () => {
		const layout = layoutPages([{ width: 600, height: 800 }, { width: 600, height: 800 }]);
		const shaped = withWindows(layout, (i) => (i === 0 ? { x: 100, width: 300 } : null));
		expect(shaped.window).toBeUndefined();
	});

	it("fits a single page by its window in page-by-page mode", () => {
		const layout = layoutPages([{ width: 600, height: 800 }]);
		const shaped = withWindows(layout, () => ({ x: 100, width: 300 }));
		const v = fitPageViewport(view, shaped, 0);
		expect(v.scale).toBeCloseTo((400 - 2 * PAGE_MARGIN) / 300, 10);
		expect(100 * v.scale + v.offsetX).toBeCloseTo((view.width - 300 * v.scale) / 2, 8);
	});
});

describe("registry (wave 0.9)", () => {
	const by = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("registers the export dialog, the Markdown export, night mode and the crop toggle", () => {
		for (const id of ["export-dialog", "export-markdown", "night-mode", "crop-margins"]) {
			const a = by(id);
			expect(a, id).toBeTruthy();
			expect(a.scope).toBe("view");
			expect(a.command, id).toBeTruthy();
			expect(a.readOnly, id).toBe(true);
		}
		expect(by("export-dialog").surfaces).toEqual(expect.arrayContaining(["page", "sheet", "notebook"]));
		expect(by("export-markdown").surfaces).toEqual(expect.arrayContaining(["sheet", "notebook"]));
		expect(by("night-mode").surfaces).toContain("sheet");
	});

	it("shows the crop toggle on PDF pages only, with its state", () => {
		const a = by("crop-margins");
		const plain = baseContext();
		const pdf = baseContext({ page: { index: 0, count: 3, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } });
		expect(isRelevant(a, plain)).toBe(false);
		expect(isRelevant(a, pdf)).toBe(true);
		expect(a.checked?.(pdf)).toBe(false);
		expect(a.checked?.({ ...pdf, display: { night: false, crop: true } })).toBe(true);
		expect(placementsOf("crop-margins", pdf, 800)).toContain("context");
		expect(by("night-mode").checked?.({ ...plain, display: { night: true, crop: false } })).toBe(true);
	});

	it("puts the new view actions where a finger reaches them", () => {
		expect(placementsOf("night-mode", baseContext(), 800).length).toBeGreaterThan(0);
		expect(placementsOf("export-dialog", baseContext(), 360)).toContain("sheet");
	});
});

describe("display settings (wave 0.9)", () => {
	it("are off by default and read only as booleans", () => {
		expect(DEFAULT_READING_SETTINGS).toMatchObject({ nightMode: false, cropMargins: false });
		expect(readReadingSettings({ nightMode: "yes", cropMargins: 1 })).toMatchObject({ nightMode: false, cropMargins: false });
		expect(readReadingSettings({ nightMode: true })).toMatchObject({ nightMode: true, cropMargins: false });
	});
});
