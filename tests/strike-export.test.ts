import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { createStroke } from "../src/model/document";
import type { Page, Point, Stroke } from "../src/model/types";
import { struckInk } from "../src/ink/strikethrough";
import { exportPdf, runExport } from "../src/view/export";
import { withRedaction } from "../src/view/export-redact";
import { runHandIn } from "../src/view/hand-in";
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

function fakeApp(): { app: App; notebook: TFile; files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => (files.has(p) ? {} : null),
			createBinary: (p: string, buf: ArrayBuffer) => { files.set(p, new Uint8Array(buf)); return Promise.resolve({ path: p }); },
		},
		loadLocalStorage: () => null,
		saveLocalStorage: () => undefined,
	} as unknown as App;
	const Made = TFile as unknown as new (path: string) => unknown;
	const made = new Made("Notebooks/Demo.notebook");
	Object.defineProperty(made, "parent", { value: { path: "Notebooks" } });
	return { app, notebook: made as TFile, files };
}

const sizeOf = (files: Map<string, Uint8Array>): number => [...files.values()][0]!.length;

describe("the writers that take the options of the view", () => {
	beforeEach(() => reseed(11));

	it("the quick PDF leaves the struck words out when the options say so, and keeps them otherwise", async () => {
		const page = struckPage();
		const plain = fakeApp();
		await exportPdf(plain.app, plain.notebook, [page], "", null, {});
		const clean = fakeApp();
		await exportPdf(clean.app, clean.notebook, [page], "", null, { struck: true });
		expect(plain.files.size).toBe(1);
		expect(clean.files.size).toBe(1);
		expect(sizeOf(clean.files)).toBeLessThan(sizeOf(plain.files));
	});

	it("hand-in follows the options too", async () => {
		const page = struckPage();
		const request = { pages: [0], fields: { name: "Ada", course: "", title: "", date: "" }, share: false };
		const plain = fakeApp();
		await runHandIn({ app: plain.app, file: plain.notebook, pages: () => [page], media: null, options: () => ({}) }, request);
		const clean = fakeApp();
		await runHandIn({ app: clean.app, file: clean.notebook, pages: () => [page], media: null, options: () => ({ struck: true }) }, request);
		expect(sizeOf(clean.files)).toBeLessThan(sizeOf(plain.files));
	});

	it("the export dialog decides on its own: its request, not the setting, says whether struck words go", async () => {
		const page = struckPage();
		const request = { format: "pdf" as const, scope: "notebook" as const, pageIndex: 0, layers: "both" as const };
		const plain = fakeApp();
		await runExport(plain.app, plain.notebook, [page], request, null, {});
		const setting = fakeApp();
		await runExport(setting.app, setting.notebook, [page], request, null, { struck: true });
		expect(sizeOf(setting.files)).toBe(sizeOf(plain.files));
		const ticked = fakeApp();
		await runExport(ticked.app, ticked.notebook, [page], { ...request, clean: { markers: false, comments: false, collapsedStickies: false, struck: true } }, null, {});
		expect(sizeOf(ticked.files)).toBeLessThan(sizeOf(plain.files));
	});
});
