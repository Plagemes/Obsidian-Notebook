/**
 * Smoke check of the Figures gallery (0.19, roadmap #228) on the `doc=figures` notebook (npm run harness:check): six pages in
 * two lectures with photos (one placed twice, one whose file is missing), an anchored crop and a plain page. The real view's
 * dialog is opened and driven through the DOM: the section scope, the page badges, lazily drawn thumbnails, the kind chips with
 * counts, the notebook scope and a typed page range, the card menu, tap to go to a page. The notebook is never written. It
 * leaves the dialog open for the screenshot.
 */
import { createDocument, createId, createPage } from "../../src/model/document";
import { serialize } from "../../src/model/serialize";
import type { Asset, ExcerptElement, ImageElement, Page, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface FiguresCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const FOLDER = "Notebooks/_assets";
const COLOURS: Record<string, string> = { aaaa0a1: "#ef4444", bbbb0b2: "#3b82f6", cccc0c3: "#22c55e", dddd0d4: "#f59e0b", eeee0e5: "#a855f7", ffff0f6: "#14b8a6", "0ffe99": "#64748b" };

function asset(id: string): Asset {
	return { id, kind: "image", path: `${FOLDER}/${id}.png`, name: `${id}.png`, bytes: 0 };
}

const photo = (id: string, x: number, y: number, w = 220, h = 150): ImageElement => ({ id: createId(), type: "image", asset: id, x, y, width: w, height: h, rotation: 0 });
const lecture = (day: string): TextElement => ({ id: createId(), type: "text", x: 40, y: 24, width: 300, text: `Physics — 2026-11-${day}`, fontSize: 14, color: "#1e1e1e" });
const crop = (id: string, y: number): ExcerptElement => ({
	id: createId(), type: "excerpt", x: 60, y, width: 200, height: 120, asset: id,
	source: { notebook: "Notebooks/Figures.notebook", doc: "figures", page: "x", x: 0, y: 0, width: 200, height: 120 },
});

/** The serialised notebook of the check. */
export function figuresNotebook(): string {
	const doc = createDocument();
	doc.id = "figures";
	doc.assets = Object.fromEntries(Object.keys(COLOURS).map((id) => [id, asset(id)]));
	const pages: Page[] = Array.from({ length: 6 }, () => createPage());
	pages[0]!.elements = [photo("aaaa0a1", 80, 120)];
	pages[1]!.elements = [lecture("02"), photo("bbbb0b2", 80, 120), crop("cccc0c3", 340)];
	pages[2]!.elements = [photo("aaaa0a1", 80, 120, 180, 240), photo("0ffe99", 80, 420)];
	pages[3]!.elements = [lecture("03"), photo("dddd0d4", 80, 120)];
	pages[4]!.elements = [photo("eeee0e5", 80, 120), photo("ffff0f6", 80, 330, 160, 160)];
	doc.pages = pages;
	return serialize(doc);
}

/** Writes the picture files of the check (a coloured PNG each; "0ffe99" has no file). */
export async function seedFigureFiles(vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown> }): Promise<void> {
	for (const [id, colour] of Object.entries(COLOURS)) {
		if (id === "0ffe99") continue;
		const canvas = createEl("canvas");
		canvas.width = 240;
		canvas.height = 160;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = colour;
		ctx.fillRect(0, 0, 240, 160);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(20, 20, 200, 12);
		ctx.fillRect(20, 60, 120, 12);
		const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
		await vault.createBinary(`${FOLDER}/${id}.png`, await blob!.arrayBuffer());
	}
}

export async function checkFigures(api: FiguresCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView & { openFigures(): void };
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-figures-modal");
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-figures-modal .nb-figures-card"));
	const chips = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-figures-modal .nb-chip"));
	const chipLabel = (label: string) => chips().find((c) => c.textContent?.includes(label));
	const kindChip = (key: string) => chips().find((c) => c.dataset.key === key);
	const pagesOf = () => cards().map((c) => c.dataset.page).join(",");
	const shape = () => JSON.stringify(v.document.pages.map((p) => p.elements?.length ?? 0));
	const before = shape();

	const open = async (): Promise<void> => {
		v.openFigures();
		await frames(3);
		const m = modal();
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m.closest(".modal") ?? m);
		await frames(2);
	};
	const loaded = async (): Promise<void> => {
		const settled = (c: HTMLElement) => {
			const f = c.querySelector(".nb-figures-thumb");
			return !!f && (f.classList.contains("is-ready") || f.classList.contains("is-failed"));
		};
		for (let i = 0; i < 80 && !cards().every(settled); i++) await sleep(50);
	};

	// The section of the page in view: page 2 is in the first lecture, which runs from page 2 to page 3.
	v.scrollToPage(2);
	await frames(3);
	await open();
	add("the gallery opens", modal() !== null);
	add("the section scope is offered and chosen", (chipLabel("This section")?.getAttribute("aria-pressed") ?? "") === "true", chips().map((c) => c.textContent).join("|"));
	add("the section shows the photos and the crop of the lecture, pages 2 and 3 only", pagesOf() === "2,2,3,3", pagesOf());
	add("every card is a 40 px target", cards().every((c) => (c.querySelector(".nb-figures-tile")?.getBoundingClientRect().height ?? 0) >= 40), "");
	add("cards stay inside the dialog", cards().every((c) => { const r = c.getBoundingClientRect(); const m = modal()!.getBoundingClientRect(); return r.left >= m.left - 1 && r.right <= m.right + 1; }), "");
	await loaded();
	add("thumbnails are drawn from the stored files", cards().filter((c) => (c.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:image/jpeg")).length === 3, "");
	add("a picture whose file is missing says so and the others are fine", cards().filter((c) => c.querySelector(".nb-figures-thumb")?.classList.contains("is-failed")).length === 1
		&& (cards()[3]?.textContent ?? "").includes("missing"), cards()[3]?.textContent ?? "");
	add("each card names its page", cards().every((c) => (c.querySelector(".nb-figures-badge")?.textContent ?? "") === `p. ${c.dataset.page}`), "");
	add("the kind chips count photos and crops", kindChip("photo")?.querySelector(".nb-chip-count")?.textContent === "3" && kindChip("crop")?.querySelector(".nb-chip-count")?.textContent === "1", "");

	kindChip("crop")?.click();
	await frames(2);
	add("the crops filter keeps the crop", cards().length === 1 && cards()[0]?.dataset.kind === "crop", `${cards().length}`);
	kindChip("crop")?.click();
	await frames(2);
	add("tapping the active filter clears it", cards().length === 4, `${cards().length}`);

	chipLabel("Whole notebook")?.click();
	await frames(3);
	add("the notebook scope shows every figure in page order", pagesOf() === "1,2,2,3,3,4,5,5", pagesOf());
	await loaded();
	add("the same picture twice shows the same thumbnail", (cards()[0]?.querySelector("img")?.getAttribute("src") ?? "x") === (cards()[3]?.querySelector("img")?.getAttribute("src") ?? "y"), "");

	chipLabel("Some pages")?.click();
	await frames(3);
	const input = document.querySelector<HTMLInputElement>(".nb-figures-modal .nb-figures-range-input");
	add("the page range field is shown", !!input && input.getBoundingClientRect().height > 0);
	if (input) {
		input.value = "5-6";
		input.dispatchEvent(new Event("change"));
		await frames(3);
	}
	add("a typed range keeps those pages", pagesOf() === "5,5", pagesOf());
	if (input) {
		input.value = "9-2";
		input.dispatchEvent(new Event("change"));
		await frames(3);
	}
	add("a wrong range says what is wrong", (document.querySelector(".nb-figures-range-problem")?.textContent ?? "").length > 0, document.querySelector(".nb-figures-range-problem")?.textContent ?? "");

	chipLabel("Whole notebook")?.click();
	await frames(3);
	await loaded();
	cards()[1]?.querySelector<HTMLElement>(".nb-figures-more")?.click();
	await frames(2);
	const menu = (window as unknown as { harnessMenu?: { titles: string[] } }).harnessMenu;
	add("the card menu offers go, copy, insert and open original", !!menu && ["Go to page 2", "Copy image", "Insert into note…", "Open original"].every((x) => menu.titles.includes(x)), menu?.titles.join(" | ") ?? "");

	cards()[5]?.querySelector<HTMLElement>(".nb-figures-tile")?.click();
	await sleep(300);
	await frames(3);
	add("tapping a card closes the gallery and goes to its page", modal() === null && v.currentPage() === 3, `page ${v.currentPage() + 1}`);
	add("the notebook was not changed", shape() === before, "");

	// Leave the notebook scope open for the screenshot.
	await open();
	chipLabel("Whole notebook")?.click();
	await frames(3);
	await loaded();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
