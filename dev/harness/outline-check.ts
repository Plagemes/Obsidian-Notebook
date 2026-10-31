/**
 * Smoke check of the generated outline (0.13, roadmap #407) on the `doc=outline` notebook (npm run harness:check): a
 * notebook of three fake PDF slides and two notes pages, with large handwriting, markers and bookmarks. The real view's
 * page panel is opened in its outline mode and driven through the DOM: rows by source, the picture of each heading,
 * nesting, order, tap to jump, the category filter and the setting of each source. The run leaves the outline open, so
 * the screenshot the harness takes afterwards shows it.
 */
import { createDocument, createPage, createId } from "../../src/model/document";
import { serialize } from "../../src/model/serialize";
import { createPdfPages } from "../../src/model/pages";
import { DEFAULT_META, type MarkerElement, type Page } from "../../src/model/types";
import { reseed, writeLine } from "../../tests/words-gen";
import { FAKE_ASSET, FAKE_PAGE, FAKE_PATH } from "./fake-pdf";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface OutlineCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface OutlineSettings {
	outlineBookmarks: boolean;
	outlineSlides: boolean;
	outlineHeadings: boolean;
	outlineMarkers: boolean;
}

const marker = (kind: MarkerElement["kind"], y: number, text?: string): MarkerElement => ({ id: createId(), type: "marker", kind, x: 24, y, ...(text ? { text } : {}) });

/** Body text: three small lines under `top`. */
function body(tag: string, top: number): Page["strokes"] {
	return [
		...writeLine(`${tag}a`, "some small notes follow the title", { x: 60, baseY: top, H: 12 }),
		...writeLine(`${tag}b`, "and a second line of the same size", { x: 60, baseY: top + 26, H: 12 }),
		...writeLine(`${tag}c`, "then a third one to finish", { x: 60, baseY: top + 52, H: 12 }),
	];
}

/** Serialised notebook of the check: slides 1–3 of the fake PDF, a notes page with two headings and a blank page. */
export function outlineNotebook(): string {
	reseed(5);
	const doc = createDocument();
	doc.assets = { [FAKE_ASSET]: { id: FAKE_ASSET, kind: "pdf", path: FAKE_PATH, name: "Calculus 101.pdf", bytes: 8 } };
	const slides = createPdfPages(doc.assets[FAKE_ASSET]!, Array.from({ length: 3 }, () => ({ ...FAKE_PAGE })));
	slides[0]!.strokes = [...writeLine("h1", "limits", { x: 60, baseY: 120, H: 44 }), ...body("s1", 190)];
	slides[0]!.elements = [marker("question", 420, "Why does it converge?"), marker("gap", 470)];
	slides[1]!.strokes = body("s2", 150);
	slides[1]!.elements = [marker("star", 300)];
	slides[2]!.strokes = body("s3", 150);
	const notes = createPage({ width: FAKE_PAGE.width, height: FAKE_PAGE.height }, { kind: "ruled", spacing: 22.68 });
	notes.strokes = [
		...writeLine("h2", "summary", { x: 60, baseY: 110, H: 44 }),
		...body("n1", 170),
		...writeLine("h3", "exercises", { x: 60, baseY: 330, H: 26 }),
		...body("n2", 380),
	];
	const blank = createPage({ width: FAKE_PAGE.width, height: FAKE_PAGE.height });
	doc.pages = [...slides, notes, blank];
	doc.meta = {
		...DEFAULT_META,
		bookmarks: [slides[2]!.id, blank.id],
		bookmarkInfo: { [slides[2]!.id]: { title: "Key theorem", category: "important" }, [blank.id]: { color: "#22c55e" } },
	};
	return serialize(doc);
}

export async function checkOutline(api: OutlineCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const settings = v.host.settings as unknown as OutlineSettings;
	const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-navigator");
	const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-navigator .nb-outline-row"));
	const kinds = (): string[] => rows().map((r) => r.dataset.kind ?? "");
	const count = (kind: string): number => kinds().filter((k) => k === kind).length;
	const apply = async () => {
		v.applySettings(v.host.settings);
		await frames(2);
	};

	// On a phone the panel is a drawer that closes after a jump: open it again (in outline mode) whenever it is not showing.
	const showOutline = async (): Promise<HTMLButtonElement | null | undefined> => {
		if (!v.pageNav.open) v.toggleNavigator();
		await frames(2);
		const b = panel()?.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Outline']");
		if (b && b.getAttribute("aria-pressed") !== "true") b.click();
		await frames(3);
		return b;
	};
	const button = await showOutline();
	add("the page panel has an Outline button", !!button);

	// What the outline lists.
	add("it lists the PDF and one entry per slide", count("document") === 1 && count("slide") === 3, kinds().join(","));
	add("it lists the large handwriting (three headings) and the bookmarks (two)", count("heading") === 3 && count("bookmark") === 2, kinds().join(","));
	add("it lists the question and the key point but not the gap", count("marker") === 2, `${count("marker")} markers`);
	const order = rows().map((r) => Number(r.dataset.index));
	add("the entries follow the pages", order.every((n, i) => i === 0 || n >= order[i - 1]!), order.join(","));
	const docRow = rows().find((r) => r.dataset.kind === "document");
	add("the PDF is named by its file", docRow?.textContent?.includes("Calculus 101.pdf") === true, docRow?.textContent ?? "");
	const bookmarkTitle = rows().find((r) => r.dataset.kind === "bookmark")?.querySelector(".nb-outline-title")?.textContent;
	add("a bookmark shows its title", bookmarkTitle === "Key theorem", String(bookmarkTitle));

	// Headings are pictures of the ink.
	const inks = Array.from(document.querySelectorAll<HTMLImageElement>(".notebook-navigator .nb-outline-ink"));
	for (let i = 0; i < 60 && inks.some((img) => !img.complete); i++) await sleep(50);
	add("every heading is a picture of its ink", inks.length === 3 && inks.every((img) => img.src.startsWith("data:image/png") && img.naturalWidth > 20 && img.naturalHeight > 10),
		inks.map((img) => `${img.naturalWidth}x${img.naturalHeight}`).join(" "));
	add("the picture fits the panel", inks.every((img) => img.getBoundingClientRect().width <= (panel()?.getBoundingClientRect().width ?? 0)), "");

	// Nesting by level: the slide sits under the PDF, the heading under the slide.
	const depth = (kind: string) => Number(rows().find((r) => r.dataset.kind === kind)?.dataset.depth);
	const indent = (kind: string) => parseFloat(rows().find((r) => r.dataset.kind === kind)?.style.marginLeft || getComputedStyle(rows().find((r) => r.dataset.kind === kind)!).marginLeft);
	add("slides are nested under the PDF and headings under the slide", depth("document") === 1 && depth("slide") === 2 && depth("heading") === 3, `${depth("document")},${depth("slide")},${depth("heading")}`);
	add("a deeper level is indented", indent("slide") > indent("document") && indent("heading") > indent("slide"), `${indent("document")},${indent("slide")},${indent("heading")}`);

	// Touch targets, and one "you are here".
	add("every row is at least 44 px tall", rows().every((r) => r.getBoundingClientRect().height >= 43.5), rows().map((r) => Math.round(r.getBoundingClientRect().height)).join(","));
	add("exactly one row says where you are", rows().filter((r) => r.classList.contains("is-current")).length === 1, "");

	// Tap to jump.
	const lastBookmark = rows().filter((r) => r.dataset.kind === "bookmark").pop()!;
	lastBookmark.click();
	await sleep(400);
	await frames(3);
	add("tapping a bookmark goes to its page", v.currentPage() === 4, `page ${v.currentPage() + 1}`);
	await showOutline();
	const slideRow = rows().find((r) => r.dataset.kind === "slide" && r.dataset.index === "1")!;
	slideRow.click();
	await sleep(400);
	await frames(3);
	add("tapping a slide goes to its page", v.currentPage() === 1, `page ${v.currentPage() + 1}`);
	await showOutline();
	const here = rows().filter((r) => r.classList.contains("is-current"));
	add("the row for the page in view is marked", here.length === 1 && here[0]!.dataset.index === "1", here.map((r) => r.dataset.kind).join(","));

	// Category filter: bookmarks only.
	const select = panel()?.querySelector<HTMLSelectElement>(".notebook-outline-category");
	add("the category filter is offered", !!select);
	if (select) {
		select.value = "important";
		select.dispatchEvent(new Event("change"));
		await frames(2);
		add("the filter keeps only the bookmarks of the category", rows().length === 1 && count("bookmark") === 1, kinds().join(","));
		const again = panel()?.querySelector<HTMLSelectElement>(".notebook-outline-category");
		if (again) {
			again.value = "";
			again.dispatchEvent(new Event("change"));
		}
		await frames(2);
	}

	// Each source can be left out.
	settings.outlineHeadings = false;
	await apply();
	add("headings off: no heading rows, the rest stays", count("heading") === 0 && count("slide") === 3 && count("bookmark") === 2, kinds().join(","));
	settings.outlineHeadings = true;
	settings.outlineSlides = false;
	await apply();
	add("slides off: no PDF and slide rows", count("document") === 0 && count("slide") === 0 && count("heading") === 3, kinds().join(","));
	settings.outlineSlides = true;
	settings.outlineMarkers = false;
	settings.outlineBookmarks = false;
	await apply();
	add("markers and bookmarks off", count("marker") === 0 && count("bookmark") === 0 && count("slide") === 3, kinds().join(","));
	settings.outlineHeadings = false;
	settings.outlineSlides = false;
	await apply();
	add("all sources off: a message says where to turn one on", rows().length === 0 && (panel()?.querySelector(".nb-outline-empty-text")?.textContent ?? "").includes("Settings"), panel()?.querySelector(".nb-outline-empty-text")?.textContent ?? "");
	settings.outlineBookmarks = true;
	settings.outlineSlides = true;
	settings.outlineHeadings = true;
	settings.outlineMarkers = true;
	await apply();
	add("everything on again", rows().length === 11, `${rows().length} rows`);

	// Leave the outline open at the top for the screenshot.
	v.scrollToPage(0);
	await sleep(300);
	await frames(3);
	await showOutline();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
