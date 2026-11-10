import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		constructor(_message: unknown) {}
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { createStroke } from "../src/model/document";
import type { Page, Point, Stroke } from "../src/model/types";
import { struckInk } from "../src/ink/strikethrough";
import { withRedaction } from "../src/view/export-redact";
import { reseed, writeLine } from "./words-gen";

const BASE = 100;

function line(id: string, x0: number, y0: number, x1: number, y1: number): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i <= 12; i++) pts.push([x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12 + Math.sin(i * 1.7) * 0.4, 0.5]);
	const s = createStroke("#000000", 1.5, pts, "pen");
	s.id = id;
	return s;
}

function struckPage(): Page {
	const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
	const word = text.filter((s) => s.id.split(":")[1] === "1");
	const xs = word.flatMap((s) => s.points.map((p) => p[0]));
	const strike = line("strike", Math.min(...xs) - 4, BASE - 5, Math.max(...xs) + 4, BASE - 5);
	return { id: "p1", width: 600, height: 800, paper: { kind: "plain" }, strokes: [...text, strike] } as unknown as Page;
}

describe("every export writer leaves struck words out when the setting is on (withRedaction)", () => {
	beforeEach(() => reseed(11));

	it("draws the pages without the struck words and their lines, keeping ids, and the page itself is untouched", () => {
		const page = struckPage();
		const count = page.strokes.length;
		const struck = struckInk(page.strokes);
		expect(struck.size).toBeGreaterThan(0);
		const out = withRedaction([page], { struck: true });
		expect(out.pages[0]).not.toBe(page);
		expect(out.pages[0]!.id).toBe("p1");
		expect(out.pages[0]!.strokes).toHaveLength(count - struck.size);
		expect(out.pages[0]!.strokes.some((s) => struck.has(s.id))).toBe(false);
		expect(page.strokes).toHaveLength(count);
		// The writer is not asked twice.
		expect(out.options.struck).toBeUndefined();
	});

	it("is the same list of pages when asked for nothing, or when nothing is struck", () => {
		const page = struckPage();
		const pages = [page];
		expect(withRedaction(pages, {}).pages).toBe(pages);
		const plain: Page = { ...page, strokes: page.strokes.filter((s) => s.id !== "strike") } as Page;
		const plainPages = [plain];
		expect(withRedaction(plainPages, { struck: true }).pages).toBe(plainPages);
	});

	it("goes before the redaction boxes, which keep covering what is left", () => {
		const page = struckPage();
		const out = withRedaction([page], { struck: true, redact: { p1: [{ x: 0, y: 0, width: 600, height: 20 }] } });
		expect(out.pages[0]!.strokes.some((s) => s.id === "strike")).toBe(false);
	});
});

describe("the export paths pass the setting on", () => {
	const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

	it("the view adds it to the export options and to the page-range PDF; Markdown, the API and the dialogs handle it", () => {
		const view = read("view/notebook-view.ts");
		expect(view).toMatch(/\.\.\.this\.struckOption\(\),\s*\.\.\.this\.redactOptions\(\)/);
		expect(view).toMatch(/\{ \.\.\.this\.struckOption\(\), \.\.\.this\.redactOptions\(\) \}/);
		expect(read("view/export-markdown.ts")).toMatch(/struck: true as const/);
		expect(read("integration/api.ts")).toMatch(/exportHideStruck \? \{ struck: true as const \}/);
		// The dialog and the share sheet decide on their own and do not clean twice.
		expect(read("view/export.ts")).toMatch(/delete base\.struck/);
		expect(read("view/share-page.ts")).toMatch(/delete base\.struck/);
	});
});
