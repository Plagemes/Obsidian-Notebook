import { beforeAll, describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		static shown: string[] = [];
		constructor(message: unknown) {
			Notice.shown.push(String(message));
		}
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { buildHtml, pageHtmlLinks } from "../src/ink/export-html";
import { metaWithoutRedactedTitles, redactionOf, redactPage } from "../src/ink/redact";
import { buildNotebookMarkdown } from "../src/model/export-markdown";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, RENDER_INK, type NotebookMeta, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";
import { exportHtml, exportPdf, exportSvg, collectPageImages, runExport, type ExportOptions } from "../src/view/export";
import { withRedaction } from "../src/view/export-redact";
import { runHandIn } from "../src/view/hand-in";
import { planWithRedaction, type AreaHost } from "../src/view/export-area";
import type { NotebookMedia } from "../src/view/media";

const box = { x: 100, y: 100, width: 220, height: 120 };
const decode = (b: Uint8Array | string): string => (typeof b === "string" ? b : new TextDecoder("latin1").decode(b));

function line(id: string, points: Array<[number, number]>): Stroke {
	return { id, tool: "pen", color: "#1e1e1e", width: 2, render: RENDER_INK, points: points.map(([x, y]): Point => [x, y, 0.5]) };
}

/** A page with SECRET in every kind of text the writers can put in a file, all under the box, and public things outside it. */
function secretPage(extra: Partial<Page> = {}): Page {
	const elements: PageElement[] = [
		{ id: "t1", type: "text", x: 110, y: 110, width: 200, text: "SECRET alpha with [[SECRET note]]", fontSize: 14, color: "#000000" },
		{ id: "s1", type: "sticky", x: 120, y: 150, width: 90, height: 50, color: "#ffd966", fontSize: 12, text: "SECRET beta" },
		{ id: "b1", type: "box", kind: "definition", x: 210, y: 160, width: 90, height: 50, title: "SECRET gamma" },
		{ id: "e1", type: "equation", x: 215, y: 120, width: 80, height: 24, latex: "SECRET", fontSize: 14, color: "#000000" },
		{ id: "pub", type: "text", x: 40, y: 600, width: 200, text: "public words", fontSize: 14, color: "#000000" },
	];
	return {
		id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled },
		strokes: [line("s-a", [[20, 150], [400, 150]]), line("s-b", [[40, 700], [200, 700]])], elements,
		comments: [{ id: "c1", region: { x: 130, y: 120, width: 40, height: 20 }, text: "SECRET comment", author: "me", created: 1 }],
		...extra,
	};
}

/** The text of the one file with this extension that an export wrote (the test fails if there is not exactly one). */
function written(files: Map<string, string | Uint8Array>, ext: string): string {
	const found = [...files.entries()].filter(([p]) => p.endsWith(`.${ext}`));
	expect(found).toHaveLength(1);
	return decode(found[0]![1]);
}

const commentLabels ={ resolved: "resolved", sketch: "sketch", more: (n: number) => `+${n}`, when: () => "now" };

function fakeApp(): { app: App; notebook: TFile; files: Map<string, string | Uint8Array> } {
	const files = new Map<string, string | Uint8Array>();
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => (files.has(p) ? {} : null),
			create: (p: string, text: string) => { files.set(p, text); return Promise.resolve({ path: p }); },
			createBinary: (p: string, buf: ArrayBuffer) => { files.set(p, new Uint8Array(buf)); return Promise.resolve({ path: p }); },
		},
		loadLocalStorage: () => null,
		saveLocalStorage: () => undefined,
	} as unknown as App;
	return { app, notebook: notebookFile(), files };
}

function notebookFile(): TFile {
	// The mocked TFile (tests/fake-vault.ts) derives its name from its path; the folder is the only thing it lacks.
	const Made = TFile as unknown as new (path: string) => unknown;
	const made = new Made("Notebooks/Demo.notebook");
	if (!(made instanceof TFile)) throw new Error("test: could not build the notebook file");
	Object.defineProperty(made, "parent", { value: { path: "Notebooks" } });
	return made;
}

/** A media stand-in: the picture of a page under a box has "RAWPIXELS" in it, the burned one does not. */
function fakeMedia(): { media: NotebookMedia; asked: Array<unknown> } {
	const asked: unknown[] = [];
	const picture = (burn: unknown) => ({
		jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(burn ? "BURNED" : "RAWPIXELS and the SECRET printed on the scan"), 0xff, 0xd9]),
		pixelWidth: 10, pixelHeight: 10,
	});
	const media = {
		pdfPageJpeg: (_asset: string, _page: number, _dpi: number, burn?: unknown) => { asked.push(burn ?? null); return Promise.resolve(picture(burn)); },
		imageJpeg: (_asset: string, burn?: unknown) => { asked.push(burn ?? null); return Promise.resolve(picture(burn)); },
	} as unknown as NotebookMedia;
	return { media, asked };
}

beforeAll(() => {
	vi.stubGlobal("window", { setTimeout: (fn: () => void) => { fn(); return 0; } });
	vi.stubGlobal("activeDocument", { documentElement: { lang: "en" } });
});

describe("the control: without redaction the secret is in every file", () => {
	it("PDF and SVG carry it", () => {
		const page = secretPage();
		expect(decode(pagesToPdf([page], { comments: commentLabels }))).toContain("SECRET");
		expect(pageToSvg(page)).toContain("SECRET");
	});
});

describe("PDF export", () => {
	it("does not contain the secret anywhere in its bytes, and keeps what is public", async () => {
		const { app, notebook, files } = fakeApp();
		const options: ExportOptions = { redact: { p1: [box] }, comments: commentLabels };
		await exportPdf(app, notebook, [secretPage()], "", null, options);
		const bytes = files.get("Notebooks/Demo.pdf") as Uint8Array;
		const text = decode(bytes);
		expect(text).not.toContain("SECRET");
		expect(text).toContain("public words");
		expect(text.startsWith("%PDF-1.4")).toBe(true);
	});

	it("draws the box as a solid black shape over everything", () => {
		const redacted = redactPage(secretPage(), [box]);
		const pdf = decode(pagesToPdf([redacted]));
		const fills = pdf.match(/0 0 0 rg\n[^f]*f/g) ?? [];
		expect(fills.length).toBeGreaterThan(0);
		expect(pdf).toMatch(/100 100 m [^f]*320 100 l [^f]*320 220 l [^f]*100 220 l [^f]*100 100 l/);
	});

	it("leaves the title of the file alone but nothing of the covered page in it", () => {
		const pdf = decode(pagesToPdf([redactPage(secretPage(), [box])], { title: "Demo" }));
		expect(pdf).toContain("/Title (Demo)");
		expect(pdf).not.toContain("SECRET");
	});

	it("ignores the notebook's remembered boxes when the dialog says there are none", async () => {
		const { app, notebook, files } = fakeApp();
		await runExport(app, notebook, [secretPage()], { format: "pdf", scope: "page", pageIndex: 0, layers: "both" }, null, { redact: { p1: [box] } });
		expect(written(files, "pdf")).toContain("SECRET");
	});

	it("covers what the dialog chose", async () => {
		const { app, notebook, files } = fakeApp();
		await runExport(app, notebook, [secretPage()], { format: "pdf", scope: "page", pageIndex: 0, layers: "both", redact: { p1: [box] } }, null, {});
		const pdf = written(files, "pdf");
		expect(pdf).not.toContain("SECRET");
		expect(pdf).toContain("public words");
	});

	it("covers a clean copy too", async () => {
		const { app, notebook, files } = fakeApp();
		await runExport(app, notebook, [secretPage()], { format: "pdf", scope: "page", pageIndex: 0, layers: "both", clean: {}, redact: { p1: [box] } }, null, { comments: commentLabels });
		const pdf = written(files, "pdf");
		expect(pdf).not.toContain("SECRET");
		expect(pdf).toContain("public words");
	});
});

describe("a PDF page or a picture behind the page", () => {
	const background = { kind: "pdf" as const, asset: "pdf1", page: 1 };

	it("is burned in: the file holds the burned picture and not the original", async () => {
		const { media, asked } = fakeMedia();
		const { app, notebook, files } = fakeApp();
		await exportPdf(app, notebook, [secretPage({ background })], "", media, { redact: { p1: [box] } });
		const text = decode(files.get("Notebooks/Demo.pdf") as Uint8Array);
		expect(text).toContain("BURNED");
		expect(text).not.toContain("RAWPIXELS");
		expect(text).not.toContain("SECRET");
		const plan = asked[0] as { boxes: unknown[]; rect: unknown };
		expect(plan.boxes).toEqual([box]);
		expect(plan.rect).toEqual({ x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT });
	});

	it("is not burned when nothing is redacted, and is then the original picture", async () => {
		const { media, asked } = fakeMedia();
		const { app, notebook, files } = fakeApp();
		await exportPdf(app, notebook, [secretPage({ background })], "", media, {});
		expect(decode(files.get("Notebooks/Demo.pdf") as Uint8Array)).toContain("RAWPIXELS");
		expect(asked[0]).toBeNull();
	});

	it("is burned for a background-only export too, where no ink is drawn", async () => {
		const { media } = fakeMedia();
		const redacted = redactPage(secretPage({ background }), [box]);
		const collected = await collectPageImages(media, [redacted], "background");
		const pdf = decode(pagesToPdf([redacted], { layers: "background", images: (p) => collected.images.get(p) ?? [] }));
		expect(pdf).toContain("BURNED");
		expect(pdf).not.toContain("RAWPIXELS");
	});

	it("is burned for a picture background and for a page whose boxes miss the background", async () => {
		const { media, asked } = fakeMedia();
		const picture = redactPage(secretPage({ background: { kind: "image", asset: "img1" } }), [box]);
		await collectPageImages(media, [picture], "both");
		expect((asked[0] as { boxes: unknown[] }).boxes).toEqual([box]);
		const missed = redactPage(secretPage({ background, margins: { left: 500, right: 10, bottom: 0 } }), [box]);
		await collectPageImages(media, [missed], "both");
		expect(asked[1]).toBeNull();
	});

	it("does not load the background at all for an ink-only export", async () => {
		const { media, asked } = fakeMedia();
		await collectPageImages(media, [redactPage(secretPage({ background }), [box])], "ink");
		expect(asked).toEqual([]);
	});

	it("keeps burned pictures apart: the same PDF page with other boxes is another picture", async () => {
		const { media, asked } = fakeMedia();
		const a = redactPage(secretPage({ background }), [box]);
		const b = redactPage(secretPage({ background }), [{ x: 10, y: 10, width: 50, height: 50 }]);
		await collectPageImages(media, [a, b], "both");
		expect(asked).toHaveLength(2);
	});
});

describe("SVG export", () => {
	it("does not contain the secret, nor the id of a note that was left out", async () => {
		const { app, notebook, files } = fakeApp();
		await exportSvg(app, notebook, secretPage(), "", null, { redact: { p1: [box] } });
		const svg = files.get("Notebooks/Demo.svg") as string;
		expect(svg).not.toContain("SECRET");
		expect(svg).not.toContain("nb-sticky-s1");
		expect(svg).toContain("public words");
		expect(svg).toContain('fill="#000000"');
	});

	it("one file per page for a whole notebook, none with the secret", async () => {
		const { app, notebook, files } = fakeApp();
		const two = [secretPage(), secretPage({ id: "p2" })];
		await runExport(app, notebook, two, { format: "svg", scope: "notebook", pageIndex: 0, layers: "both", redact: { p1: [box], p2: [box] } }, null, {});
		const written = [...files.entries()].filter(([p]) => p.endsWith(".svg"));
		expect(written).toHaveLength(2);
		for (const [, svg] of written) expect(svg as string).not.toContain("SECRET");
	});
});

describe("interactive HTML export", () => {
	it("holds no covered text, no link to a covered note and no script data about it", async () => {
		const { app, notebook, files } = fakeApp();
		await exportHtml(app, notebook, [secretPage()], [0], "", null, { redact: { p1: [box] } });
		const html = files.get("Notebooks/Demo.html") as string;
		expect(html).not.toContain("SECRET");
		expect(html).toContain("public words");
		expect(html).toContain('id="nb-labels"');
	});

	it("the control carries the secret, and so does its link", () => {
		const page = secretPage();
		const html = buildHtml({ title: "Demo" }, [{ svg: pageToSvg(page), label: "p1", links: pageHtmlLinks(page, "Demo", () => null) }]);
		expect(html).toContain("SECRET");
	});

	it("through the dialog's request", async () => {
		const { app, notebook, files } = fakeApp();
		await runExport(app, notebook, [secretPage()], { format: "html", scope: "notebook", pageIndex: 0, layers: "both", redact: { p1: [box] } }, null, {});
		const html = written(files, "html");
		expect(html).not.toContain("SECRET");
		expect(html).toContain("public words");
	});
});

describe("hand-in PDF", () => {
	it("is redacted like any export, cover page included", async () => {
		const { app, notebook, files } = fakeApp();
		const page = secretPage();
		const path = await runHandIn({
			app, file: notebook, pages: () => [page], media: null,
			options: () => ({ redact: { p1: [box] }, comments: commentLabels }),
		}, { pages: [0], fields: { name: "Ada", course: "Maths", title: "Sheet 1", date: "8 Nov 2026" }, share: false });
		expect(path).toBe("Notebooks/Demo hand-in.pdf");
		const text = decode(files.get(path!) as Uint8Array);
		expect(text).not.toContain("SECRET");
		expect(text).toContain("public words");
		expect(text).toContain("Ada");
	});
});

describe("the written-area picture and copy as image", () => {
	function host(page: Page, selection: AreaHost["selection"], redact: ExportOptions["redact"]): AreaHost {
		return { app: {} as App, file: notebookFile(), page, pageNumber: 1, selection, media: null, exportOptions: redact ? { redact } : {}, render: {} };
	}

	it("measures and draws the page with the boxes applied", () => {
		const plan = planWithRedaction(host(secretPage(), null, { p1: [box] }), "page")!;
		expect(redactionOf(plan.page)).toEqual([box]);
		expect(pageToSvg(plan.page, { layers: "ink", paper: false })).not.toContain("SECRET");
		const plain = planWithRedaction(host(secretPage(), null, undefined), "page")!;
		expect(redactionOf(plain.page)).toEqual([]);
	});

	it("a selection takes only the boxes near it: far boxes do not widen the picture", () => {
		const page = secretPage();
		const selection = { strokes: [page.strokes[1]!], elements: [] };
		const near = planWithRedaction(host(page, selection, { p1: [{ x: 30, y: 680, width: 60, height: 40 }] }), "selection")!;
		expect(redactionOf(near.page)).toHaveLength(1);
		const far = planWithRedaction(host(page, selection, { p1: [box] }), "selection")!;
		expect(redactionOf(far.page)).toEqual([]);
		const plain = planWithRedaction(host(page, selection, undefined), "selection")!;
		expect(far.rect).toEqual(plain.rect);
	});

	it("a selection that is under a box is cut", () => {
		const page = secretPage();
		const selection = { strokes: [page.strokes[0]!], elements: [page.elements![0]!] };
		const plan = planWithRedaction(host(page, selection, { p1: [box] }), "selection")!;
		expect(pageToSvg(plan.page, { layers: "ink", paper: false })).not.toContain("SECRET");
	});
});

describe("print, PNG, share and Markdown get the same pages", () => {
	it("withRedaction hands every writer the redacted copies and a header that skips a covered page", () => {
		const header = { text: "Demo", x: 28, align: "left" as const, y: 13, size: 9, maxWidth: 400, footer: false };
		const pages = [secretPage(), secretPage({ id: "p2" })];
		const out = withRedaction(pages, { redact: { p1: [{ x: 20, y: 0, width: 200, height: 30 }] }, header: () => header });
		expect(out.pages[0]).not.toBe(pages[0]);
		expect(out.pages[1]).toBe(pages[1]);
		expect(out.options.header?.(out.pages[0]!)).toBeNull();
		expect(out.options.header?.(out.pages[1]!)).toBe(header);
		expect(withRedaction(pages, {}).pages).toBe(pages);
		expect(withRedaction(pages, { redact: { other: [box] } }).pages).toBe(pages);
	});

	it("the Markdown text and its bookmark titles leave out what is covered", () => {
		const page = secretPage();
		const redacted = redactPage(page, [box]);
		const meta = { tags: [], favorite: false, bookmarks: ["p1"], bookmarkInfo: { p1: { title: "SECRET plan" } } } as unknown as NotebookMeta;
		const labels = { heading: "Comments", resolved: "resolved", sketch: "sketch", when: () => "now" };
		const control = buildNotebookMarkdown({ title: "Demo", pages: [page], meta, images: ["p.png"], pageLabel: (n) => `Page ${n}`, comments: labels });
		expect(control).toContain("SECRET");
		// The export writes the redacted pages, and the meta without the covered pages' bookmark titles.
		const text = buildNotebookMarkdown({
			title: "Demo", pages: [redacted], meta: metaWithoutRedactedTitles(meta, [redacted])!, images: ["p.png"], pageLabel: (n) => `Page ${n}`, comments: labels,
		});
		expect(text).not.toContain("SECRET");
		expect(text).toContain("public words");
	});
});
