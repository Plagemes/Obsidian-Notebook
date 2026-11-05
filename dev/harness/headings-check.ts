/**
 * Smoke check of headings from the size of the handwriting (0.20, roadmap #102, `doc=headings`, npm run harness:check): the real
 * notebook map on synthetic pages (a big title, an underlined line, two headings, plain text, a blank page). The Titles filter and the
 * title strips are checked: counts, pictures drawn lazily as real images, a tap on a strip goes to the line (page and y), the filter
 * keeps only pages with headings, everything stays inside the dialog. The outline rows are rendered too, and the companion text is
 * generated with the picture embeds. The map is left open for the screenshot.
 */
import type { App } from "obsidian";
import { companionContent } from "../../src/model/companion-content";
import { createDocument, createPage, createStroke } from "../../src/model/document";
import { OutlineBuilder, type OutlineItem, type OutlineSources } from "../../src/model/outline-builder";
import type { Page, Point, Stroke } from "../../src/model/types";
import { PAGE_SIZES } from "../../src/model/types";
import { NotebookMapModal } from "../../src/view/notebook-map-modal";
import { NotebookMapCache } from "../../src/model/notebook-map";
import { HeadingThumbs } from "../../src/view/outline-thumbs";
import { renderOutline, type OutlineHost } from "../../src/view/outline";
import { reseed, writeLine } from "../../tests/words-gen";
import type { CheckResult } from "./reading-check";

export interface HeadingsCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const HEADINGS_ONLY: OutlineSources = { bookmarks: false, slides: false, headings: true, markers: false, pdf: false };

function body(tag: string, top: number): Stroke[] {
	return [
		...writeLine(`${tag}a`, "some small notes follow the title", { x: 60, baseY: top, H: 12 }),
		...writeLine(`${tag}b`, "and a second line of the same size", { x: 60, baseY: top + 26, H: 12 }),
		...writeLine(`${tag}c`, "then a third one to finish", { x: 60, baseY: top + 52, H: 12 }),
	];
}

function rule(id: string, x0: number, y: number, x1: number): Stroke {
	const pts: Point[] = Array.from({ length: 12 }, (_, k) => [x0 + ((x1 - x0) * k) / 11, y, 0.5]);
	const s = createStroke("#1d4ed8", 2, pts, "pen");
	s.id = id;
	return s;
}

function pages(): Page[] {
	reseed(9);
	const size = { width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height };
	const mk = (): Page => createPage(size, { kind: "ruled", spacing: 22.68 });
	const p1 = mk();
	p1.strokes = [...writeLine("h1", "limits", { x: 60, baseY: 110, H: 44 }), ...body("a", 170)];
	const p2 = mk();
	p2.strokes = body("b", 150);
	const p3 = mk();
	const under = writeLine("h3", "key results", { x: 60, baseY: 110, H: 20 });
	p3.strokes = [...under, rule("u3", 56, 122, Math.max(...under.flatMap((s) => s.points.map((p) => p[0]))) + 4), ...body("c", 170)];
	const p4 = mk();
	p4.strokes = [...writeLine("h4", "summary", { x: 60, baseY: 110, H: 44 }), ...body("d", 170), ...writeLine("h5", "exercises", { x: 60, baseY: 330, H: 28 }), ...body("e", 380)];
	return [p1, p2, p3, p4, mk()];
}

export async function checkHeadings(api: HeadingsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const list = pages();
	const builder = new OutlineBuilder();
	const thumbs = new HeadingThumbs();
	const mapCache = new NotebookMapCache();
	const jumps: string[] = [];
	const last = (): string | undefined => jumps[jumps.length - 1];
	const headingItems = () => builder.build({ pages: list }, HEADINGS_ONLY).filter((i) => i.kind === "heading");

	const items = headingItems();
	add("four headings are found: a title, an underlined line and two on one page", items.length === 4, items.map((i) => `${i.index}:${i.heading?.level}`).join(" "));
	add("the underlined line is a level 2 heading that includes its underline", items.some((i) => i.index === 2 && i.heading?.level === 2 && i.heading.strokeIds.includes("u3")));

	// The outline rows (jump to the line).
	const host = {
		app: api.app, pages: () => list, meta: () => undefined, canEdit: () => false, execute: () => undefined, goTo: (i: number) => jumps.push(`page ${i}`),
		goToAt: (i: number, y: number) => jumps.push(`line ${i}@${Math.round(y)}`), assets: () => undefined, outline: () => builder,
		sources: () => HEADINGS_ONLY, headingImage: (item: OutlineItem) => thumbs.url(list.find((p) => p.id === item.pageId)!, item),
	} as unknown as OutlineHost;
	const panel = document.body.createDiv({ cls: "harness-outline-probe" });
	renderOutline(panel, host, { category: null, current: 0 }, () => undefined);
	const rows = Array.from(panel.querySelectorAll<HTMLElement>(".nb-outline-row"));
	add("the outline has a row per heading, each with a picture of the ink", rows.length === 4 && rows.every((r) => (r.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:image/png")), String(rows.length));
	rows[3]?.click();
	add("a heading row goes to the line, not only the page", last()?.startsWith("line 3@") === true, last() ?? "");
	panel.remove();

	// The notebook map.
	const modal = new NotebookMapModal(api.app as App, {
		map: () => mapCache.build(list), pages: () => list, current: () => 0, thumbnail: () => "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
		goTo: (i) => jumps.push(`page ${i}`), headings: headingItems, headingImage: (item: OutlineItem) => thumbs.url(list.find((p) => p.id === item.pageId)!, item),
		goToAt: (i, y) => jumps.push(`line ${i}@${Math.round(y)}`),
	});
	modal.open();
	await sleep(120);
	const m = document.querySelector<HTMLElement>(".nb-map-modal");
	if (m && !m.closest(".harness-modal-container")) {
		const backdrop = document.body.createDiv({ cls: "harness-modal-container" });
		backdrop.appendChild(m);
	}
	await sleep(120);
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-map-modal .nb-map-card"));
	const chip = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-map-modal .nb-chip[data-key='titles']");
	add("the map opens with a card per page", !!m && cards().length === 5, `${cards().length}`);
	add("a Titles filter counts the pages that have headings", !!chip() && chip()?.querySelector(".nb-chip-count")?.textContent === "3", chip()?.textContent ?? "none");
	for (let i = 0; i < 40 && document.querySelectorAll(".nb-map-modal [data-heading] img:not([src])").length > 0; i++) await sleep(50);
	const strips = Array.from(document.querySelectorAll<HTMLElement>(".nb-map-modal [data-heading]"));
	add("the cards carry title strips (up to two per page)", strips.length === 4, `${strips.length}`);
	add("the strips show real pictures of the ink", strips.every((s) => (s.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:image/png")));
	add("a card without headings has no strip", cards()[1]?.querySelector("[data-heading]") === null && cards()[4]?.querySelector("[data-heading]") === null);
	add("strips stay inside their cards and the dialog", strips.every((s) => {
		const r = s.getBoundingClientRect();
		const c = s.closest(".nb-map-card")!.getBoundingClientRect();
		const d = m!.getBoundingClientRect();
		return r.left >= c.left - 1 && r.right <= c.right + 1 && r.right <= d.right + 1 && r.height > 8;
	}));
	add("a strip is a touch target", strips.every((s) => s.getBoundingClientRect().height >= 24), strips.map((s) => Math.round(s.getBoundingClientRect().height)).join(","));

	chip()?.click();
	await sleep(120);
	add("the Titles filter keeps the pages with headings", cards().length === 3 && cards().every((c) => c.querySelector("[data-heading]")), `${cards().length}`);
	chip()?.click();
	await sleep(120);
	add("tapping it again clears it", cards().length === 5);

	// Leave the dialog open for the screenshot; the jump is checked on a fresh one first.
	strips[3]?.click();
	await sleep(120);
	add("a tap on a strip closes the map and goes to the line", last()?.startsWith("line 3@") === true && document.querySelector(".nb-map-modal") === null, last() ?? "");
	const again = new NotebookMapModal(api.app as App, {
		map: () => mapCache.build(list), pages: () => list, current: () => 0, thumbnail: () => "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
		goTo: (i) => jumps.push(`page ${i}`), headings: headingItems, headingImage: (item: OutlineItem) => thumbs.url(list.find((p) => p.id === item.pageId)!, item),
		goToAt: (i, y) => jumps.push(`line ${i}@${Math.round(y)}`),
	});
	again.open();
	await sleep(150);
	const m2 = document.querySelector<HTMLElement>(".nb-map-modal");
	if (m2 && !m2.closest(".harness-modal-container")) {
		const backdrop = document.body.createDiv({ cls: "harness-modal-container" });
		backdrop.appendChild(m2);
	}
	for (let i = 0; i < 40 && document.querySelectorAll(".nb-map-modal [data-heading] img:not([src])").length > 0; i++) await sleep(50);

	// The companion note: pictures under their page, the page heading unchanged.
	const doc = createDocument(new Date("2026-11-04T10:00:00Z"));
	doc.id = "doc-h";
	doc.pages = list;
	const embeds = new Map([[list[0]!.id, ["![[Maths (Headings)/p1-h1.png|220]]"]]]);
	const text = companionContent(doc, { notebookPath: "Notebooks/Maths.notebook", pageUri: (p) => `obsidian://x?p=${p}`, headingEmbeds: embeds }).text;
	add("the companion note shows the picture under its page and keeps the page heading", text.includes("### p. 1") && text.includes("- heading: ![[Maths (Headings)/p1-h1.png|220]]"), text.slice(0, 120));
	add("no stray console errors", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function headingsApi(api: HeadingsCheckApi): Record<string, unknown> {
	return { checkHeadings: async () => {
		try {
			return JSON.parse(JSON.stringify(await checkHeadings(api))) as unknown;
		} catch (e) {
			return { ok: false, results: [], errors: [`headings check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
		}
	} };
}
