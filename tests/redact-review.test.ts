// 0.26 privacy review fixes (#285): every fix has a SECRET marker test with its own positive control (the same export without the boxes
// carries the marker). The base64 pictures of SVG and HTML are decoded before the bytes are searched; the PDF writer stores its streams
// uncompressed, and a compressed stream fails the search loudly (it would have to be inflated first, or a marker in it would be missed).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { Notice } from "obsidian";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { redactPage } from "../src/ink/redact";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { pageTexts } from "../src/model/export-markdown";
import { collectFormulas } from "../src/model/formula-sheet";
import { meaningRegions } from "../src/model/colour-meaning";
import { serialize } from "../src/model/serialize";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, RENDER_INK, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";
import { textUnderBands } from "../src/pdf/region-text";
import { createNotebookApi } from "../src/integration/api";
import { exportHtml, exportPdf, exportSvg, runExport, type ExportOptions } from "../src/view/export";
import { RedactionUnavailableError, announceRedaction, withRedaction } from "../src/view/export-redact";
import { planWithRedaction, type AreaHost } from "../src/view/export-area";
import { exportPngPages } from "../src/view/export-png";
import { exportMarkdown } from "../src/view/export-markdown";
import { printPages } from "../src/view/print";
import type { NotebookMedia } from "../src/view/media";
import { REDACT_KEY, saveRedactState } from "../src/ui/redact-store";
import { FakeVault } from "./fake-vault";

const shown = (): string[] => (Notice as unknown as { shown: string[] }).shown;
const box = { x: 100, y: 100, width: 220, height: 120 };
const far = { x: 450, y: 700, width: 40, height: 40 };

/** Every text an export file carries: the bytes as latin1 and every base64 data URL decoded. Throws on a compressed PDF stream. */
function readable(file: string | Uint8Array): string {
	const raw = typeof file === "string" ? file : new TextDecoder("latin1").decode(file);
	if (/\/Filter\s*\/(FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode)/.test(raw)) throw new Error("test: a compressed stream would hide a marker");
	const parts = [raw];
	// Pictures embedded as data URLs (SVG, HTML).
	for (const d of raw.matchAll(/data:[a-z/+-]+;base64,([A-Za-z0-9+/=]+)/g)) parts.push(atob(d[1]!));
	return parts.join("\n");
}

function line(id: string, points: Array<[number, number]>, extra: Partial<Stroke> = {}): Stroke {
	return { id, tool: "pen", color: "#1e1e1e", width: 2, render: RENDER_INK, points: points.map(([x, y]): Point => [x, y, 0.5]), ...extra };
}

function page(extra: Partial<Page> = {}): Page {
	return { id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes: [], ...extra };
}

function notebookFile(): TFile {
	const Made = TFile as unknown as new (path: string) => unknown;
	const made = new Made("Notebooks/Demo.notebook");
	if (!(made instanceof TFile)) throw new Error("test: could not build the notebook file");
	Object.defineProperty(made, "parent", { value: { path: "Notebooks" } });
	return made;
}

function fakeApp(): { app: App; files: Map<string, string | Uint8Array> } {
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
	return { app, files };
}

/** A media stand-in: every picture is a JPEG whose bytes name the asset (so a snapshot left in a file is found by its name). */
function fakeMedia(): NotebookMedia {
	const picture = (asset: string, burn: unknown) => ({
		jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(burn ? `BURNED ${asset}` : `PIXELS of ${asset}`), 0xff, 0xd9]),
		pixelWidth: 10, pixelHeight: 10,
	});
	return {
		pdfPageJpeg: (asset: string, _page: number, _dpi: number, burn?: unknown) => Promise.resolve(picture(asset, burn)),
		imageJpeg: (asset: string, burn?: unknown) => Promise.resolve(picture(asset, burn)),
	} as unknown as NotebookMedia;
}

beforeAll(() => {
	vi.stubGlobal("window", { setTimeout: (fn: () => void) => { fn(); return 0; } });
	vi.stubGlobal("activeDocument", { documentElement: { lang: "en" } });
});
beforeEach(() => {
	shown().length = 0;
});

// ------------------------------------------------------------------------------------------------------------------------------ P12

describe("P12: every kind of item has its own marker and its own control", () => {
	const kinds: Array<{ kind: string; el?: PageElement; comment?: boolean; outputs: Array<"pdf" | "svg" | "md"> }> = [
		{ kind: "text", el: { id: "e", type: "text", x: 110, y: 110, width: 200, text: "SECRET-text", fontSize: 14, color: "#000000" }, outputs: ["pdf", "svg", "md"] },
		{ kind: "sticky", el: { id: "e", type: "sticky", x: 120, y: 150, width: 120, height: 50, color: "#ffd966", fontSize: 12, text: "SECRET-sticky" }, outputs: ["pdf", "svg", "md"] },
		{ kind: "box", el: { id: "e", type: "box", kind: "definition", x: 130, y: 160, width: 120, height: 50, title: "SECRET-box" }, outputs: ["pdf", "svg"] },
		{ kind: "equation", el: { id: "e", type: "equation", x: 120, y: 120, width: 160, height: 24, latex: "SECRET-equation", fontSize: 14, color: "#000000" }, outputs: ["pdf", "svg", "md"] },
		{ kind: "checkbox", el: { id: "e", type: "checkbox", x: 130, y: 130, size: 20, color: "#000000", label: "SECRET-checkbox" }, outputs: ["md"] },
		{ kind: "comment", comment: true, outputs: ["pdf"] },
	];
	const labels = { resolved: "resolved", sketch: "sketch", more: (n: number) => `+${n}`, when: () => "now" };
	const of = (k: (typeof kinds)[number]): Page => page({
		...(k.el ? { elements: [k.el] } : {}),
		...(k.comment ? { comments: [{ id: "c1", region: { x: 130, y: 120, width: 40, height: 20 }, text: "SECRET-comment", author: "me", created: 1 }] } : {}),
	});
	const write = (out: "pdf" | "svg" | "md", p: Page): string =>
		out === "pdf" ? readable(pagesToPdf([p], { comments: labels })) : out === "svg" ? readable(pageToSvg(p)) : pageTexts(p).join("\n");

	for (const k of kinds) {
		it(`${k.kind}: written without the box, left out under it`, () => {
			const marker = `SECRET-${k.kind}`;
			for (const out of k.outputs) {
				expect(write(out, redactPage(of(k), [far])), `${k.kind} control in ${out}`).toContain(marker);
				expect(write(out, redactPage(of(k), [box])), `${k.kind} redacted in ${out}`).not.toContain(marker);
			}
		});
	}
});

// ------------------------------------------------------------------------------------------------------------------------------ P2

describe("P2: an excerpt of a covered region, on a page with no box", () => {
	const source = page({ id: "src" });
	const shows = page({
		id: "dst",
		elements: [{ id: "ex", type: "excerpt", x: 50, y: 300, width: 200, height: 100, asset: "snapSECRET", source: { notebook: "Demo", doc: "d", page: "src", x: 120, y: 120, width: 100, height: 50 } }],
	});

	it("is not in the PDF (its snapshot is the covered pixels); the control has it", async () => {
		const control = fakeApp();
		await exportPdf(control.app, notebookFile(), [source, shows], "", fakeMedia(), { redact: { src: [far] } });
		expect(readable([...control.files.values()][0]!)).toContain("PIXELS of snapSECRET");
		const { app, files } = fakeApp();
		await exportPdf(app, notebookFile(), [source, shows], "", fakeMedia(), { redact: { src: [box] } });
		expect(files.size).toBe(1);
		expect(readable([...files.values()][0]!)).not.toContain("snapSECRET");
	});

	it("is not in the SVG of that page alone, nor in the HTML (base64 decoded); the controls have it", async () => {
		const c1 = fakeApp();
		await exportSvg(c1.app, notebookFile(), shows, " p2", fakeMedia(), { redact: { src: [far] } });
		expect(readable([...c1.files.values()][0]!)).toContain("PIXELS of snapSECRET");
		const s = fakeApp();
		await exportSvg(s.app, notebookFile(), shows, " p2", fakeMedia(), { redact: { src: [box] } });
		expect(readable([...s.files.values()][0]!)).not.toContain("snapSECRET");
		const c2 = fakeApp();
		await exportHtml(c2.app, notebookFile(), [source, shows], [0, 1], "", fakeMedia(), {});
		expect(readable([...c2.files.values()][0]!)).toContain("PIXELS of snapSECRET");
		const h = fakeApp();
		await exportHtml(h.app, notebookFile(), [source, shows], [0, 1], "", fakeMedia(), { redact: { src: [box] } });
		expect(readable([...h.files.values()][0]!)).not.toContain("snapSECRET");
	});

	it("is not in the written-area picture of that page either", () => {
		// Some ink beside the excerpt: the picture has something written to measure.
		const inked = { ...shows, strokes: [line("s", [[60, 450], [240, 460]])] };
		const host = (redact?: ExportOptions["redact"]): AreaHost => ({ app: {} as App, file: notebookFile(), page: inked, pageNumber: 2, selection: null, media: null, exportOptions: redact ? { redact } : {}, render: {} });
		expect(JSON.stringify(planWithRedaction(host({ src: [far] }), "page")!.page)).toContain("snapSECRET");
		expect(JSON.stringify(planWithRedaction(host({ src: [box] }), "page")!.page)).not.toContain("snapSECRET");
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P4

describe("P4: boxes that cannot be read refuse the export (fail closed)", () => {
	const secret = page({ elements: [{ id: "t", type: "text", x: 110, y: 110, width: 200, text: "SECRET-p4", fontSize: 14, color: "#000000" }] });

	it("PDF, SVG and HTML write nothing and say why; the control writes the file", async () => {
		const control = fakeApp();
		await exportPdf(control.app, notebookFile(), [secret], "", null, {});
		expect(readable([...control.files.values()][0]!)).toContain("SECRET-p4");
		const { app, files } = fakeApp();
		await exportPdf(app, notebookFile(), [secret], "", null, { redactBlocked: true });
		await exportSvg(app, notebookFile(), secret, "", null, { redactBlocked: true });
		await exportHtml(app, notebookFile(), [secret], [0], "", null, { redactBlocked: true });
		expect(files.size).toBe(0);
		expect(shown().some((n) => n.includes("could not be read"))).toBe(true);
	});

	it("PNG, print and Markdown refuse before anything is drawn", async () => {
		const { app, files } = fakeApp();
		expect(await exportPngPages(app, [secret], { folder: "out", scale: 1, pages: [0] }, null, { redactBlocked: true })).toBeNull();
		expect(await printPages([secret], [0], null, { redactBlocked: true })).toBe(false);
		const doc = { ...createDocument(new Date(0)), pages: [secret] };
		expect(await exportMarkdown(app, notebookFile(), doc, null, { folder: "out", dpi: 96, redactBlocked: true } as never)).toBeNull();
		expect(files.size).toBe(0);
	});

	it("withRedaction and the area plan throw instead of handing back the pages", () => {
		expect(() => withRedaction([secret], { redactBlocked: true })).toThrow(RedactionUnavailableError);
		const host: AreaHost = { app: {} as App, file: notebookFile(), page: secret, pageNumber: 1, selection: null, media: null, exportOptions: { redactBlocked: true }, render: {} };
		expect(() => planWithRedaction(host, "page")).toThrow(RedactionUnavailableError);
	});

	it("the export dialog's own boxes lift the refusal; a request without boxes keeps it", async () => {
		const { app, files } = fakeApp();
		await runExport(app, notebookFile(), [secret], { format: "pdf", scope: "notebook", pageIndex: 0, layers: "both" }, null, { redactBlocked: true });
		expect(files.size).toBe(0);
		await runExport(app, notebookFile(), [secret], { format: "pdf", scope: "notebook", pageIndex: 0, layers: "both", redact: { p1: [box] } }, null, { redactBlocked: true });
		expect(files.size).toBe(1);
		expect(readable([...files.values()][0]!)).not.toContain("SECRET-p4");
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P5, P6

describe("P5 / P6: the digests never quote a PDF word a box touches", () => {
	const run = { str: "Pay to IBAN IT60X0542811101000000123456 today", x: 100, y: 200, width: 330, height: 12 };
	const band = { x0: 90, y0: 198, x1: 440, y1: 214 };

	it("a word partly under a box is left out, whatever share of it the highlight covers; the control quotes it", () => {
		expect(textUnderBands([run], [band])).toContain("IT60X0542811101000000123456");
		// The box covers only the tail of the IBAN (well under 60 % of it).
		const tail = { x: 330, y: 195, width: 40, height: 20 };
		const text = textUnderBands([run], [band], undefined, [tail]);
		expect(text).not.toContain("IT60X");
		expect(text).toContain("Pay");
	});

	it("the colour digest finds no region in ink a box covers; the control finds it", () => {
		const red = "#dc2626";
		const p = createPage({ width: 600, height: 800 });
		p.strokes = [createStroke(red, 2, [[120, 150, 0.5], [200, 150, 0.5], [280, 150, 0.5]], "pen")];
		const legend = [{ colour: red, label: "SECRET-meaning" }];
		expect(meaningRegions(withRedaction([p], { redact: { [p.id]: [far] } }).pages, legend)).toHaveLength(1);
		expect(meaningRegions(withRedaction([p], { redact: { [p.id]: [box] } }).pages, legend)).toHaveLength(0);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P7

describe("P7: the public API's exportPdf follows the stored switch", () => {
	function setup(): { api: ReturnType<typeof createNotebookApi>; vault: FakeVault; app: App; written: Map<string, Uint8Array> } {
		const doc = createDocument(new Date(0));
		doc.pages = [{ ...doc.pages[0]!, elements: [{ id: "t", type: "text", x: 110, y: 110, width: 200, text: "SECRET-api", fontSize: 14, color: "#000000" }] }];
		const vault = new FakeVault({ "Notebooks/Demo.notebook": serialize(doc) });
		const written = new Map<string, Uint8Array>();
		const local = new Map<string, unknown>();
		const app = {
			vault: { ...vault.vault, createBinary: (p: string, buf: ArrayBuffer) => { written.set(p, new Uint8Array(buf)); return Promise.resolve({ path: p }); } },
			workspace: { getLeavesOfType: () => [] },
			loadLocalStorage: (k: string) => local.get(k) ?? null,
			saveLocalStorage: (k: string, v: unknown) => { local.set(k, JSON.parse(JSON.stringify(v))); },
		} as unknown as App;
		const api = createNotebookApi({ app, settings: { folder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "", zipBackupFolder: "" } } as never);
		(app as unknown as { doc: typeof doc }).doc = doc;
		return { api, vault, app, written };
	}
	const docId = (app: App): string => (app as unknown as { doc: { id: string; pages: Page[] } }).doc.id;
	const pageId = (app: App): string => (app as unknown as { doc: { pages: Page[] } }).doc.pages[0]!.id;

	it("covers what the boxes cover when they are on; the control (off) writes the marker", async () => {
		const off = setup();
		saveRedactState(off.app, docId(off.app), { on: false, boxes: { [pageId(off.app)]: [box] } });
		await off.api.exportPdf("Notebooks/Demo.notebook");
		expect(readable([...off.written.values()][0]!)).toContain("SECRET-api");
		const on = setup();
		saveRedactState(on.app, docId(on.app), { on: true, boxes: { [pageId(on.app)]: [box] } });
		await on.api.exportPdf("Notebooks/Demo.notebook");
		expect(on.written.size).toBe(1);
		expect(readable([...on.written.values()][0]!)).not.toContain("SECRET-api");
	});

	it("refuses with export-failed and writes nothing when the boxes cannot be read", async () => {
		const s = setup();
		(s.app as unknown as { saveLocalStorage(k: string, v: unknown): void }).saveLocalStorage(REDACT_KEY, "garbage");
		await expect(s.api.exportPdf("Notebooks/Demo.notebook")).rejects.toMatchObject({ code: "export-failed" });
		expect(s.written.size).toBe(0);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P9

describe("P9: the formula sheet leaves out an equation under a box", () => {
	it("collects it without the box, not with it", () => {
		const p = page({ elements: [{ id: "eq", type: "equation", x: 120, y: 120, width: 160, height: 24, latex: "SECRET-formula", fontSize: 14, color: "#000000" }] });
		expect(JSON.stringify(collectFormulas(withRedaction([p], { redact: { p1: [far] } }).pages))).toContain("SECRET-formula");
		expect(JSON.stringify(collectFormulas(withRedaction([p], { redact: { p1: [box] } }).pages))).not.toContain("SECRET-formula");
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P10

describe("P10: switched-off boxes give one quiet hint on the paths outside the dialog", () => {
	it("says so after a quick export, and not after a dialog export (the dialog showed the switch)", async () => {
		const { app } = fakeApp();
		await exportPdf(app, notebookFile(), [page()], "", null, { redactOff: 2 });
		expect(shown().filter((n) => n.includes("Redaction boxes are off"))).toHaveLength(1);
		shown().length = 0;
		await runExport(app, notebookFile(), [page()], { format: "pdf", scope: "notebook", pageIndex: 0, layers: "both" }, null, { redactOff: 2 });
		expect(shown().some((n) => n.includes("Redaction boxes are off"))).toBe(false);
		shown().length = 0;
		announceRedaction([page()], { redact: { p1: [box] }, redactOff: 2 });
		expect(shown().some((n) => n.includes("Redaction applied"))).toBe(true);
		expect(shown().some((n) => n.includes("are off"))).toBe(false);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ P11

describe("P11: the header of a covered page is left out of the SVG a note gets", () => {
	it("pageToSvg with the redacted header has no header text; the control has it", () => {
		const header = { text: "SECRET-header", x: 28, align: "left" as const, y: 13, size: 9, maxWidth: 400, footer: false };
		const covered = withRedaction([page()], { redact: { p1: [{ x: 20, y: 0, width: 200, height: 30 }] }, header: () => header });
		const control = withRedaction([page()], { redact: { p1: [far] }, header: () => header });
		expect(pageToSvg(control.pages[0]!, { header: control.options.header!(control.pages[0]!) })).toContain("SECRET-header");
		expect(pageToSvg(covered.pages[0]!, { header: covered.options.header!(covered.pages[0]!) })).not.toContain("SECRET-header");
	});
});
