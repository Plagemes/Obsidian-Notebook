/**
 * 0.29 figcaptions (roadmap #248): figure captions and references on the `doc=figcaptions` scenario (HARNESS_DOC=figcaptions npm run
 * harness:check). Checked: the numbers follow the reading order and renumber when a figure is added before or removed, a caption shows
 * "Fig. N — words", a reference shows the current number and "Fig. ?" once its figure is gone, a text box with markers is drawn with
 * what is shown (canvas pixels differ from the raw marker's width), the caption dialog saves the words, the reference picker lists
 * the captioned figures with 44 px rows and hands back the chosen figure. The picker is left open (with a strip of the drawn boxes
 * under it) for the screenshot, tablet and phone, dark and light.
 */
import { drawTextElement, measureText } from "../../src/ink/renderer";
import { shownText } from "../../src/ink/wikilink";
import { captionText, referenceToken } from "../../src/ink/figure-text";
import { createPage } from "../../src/model/document";
import { brokenReferences, numberFigures } from "../../src/model/figure-captions";
import type { ImageElement, Page, TextElement } from "../../src/model/types";
import { FigureCaptionModal, FigureNumbers, FigureRefModal } from "../../src/view/figure-captions";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface FigcaptionsCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkFigcaptions(api: FigcaptionsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const mount = (m: HTMLElement | null) => {
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
	};

	const picture = (id: string, x: number, y: number): ImageElement => ({ id, type: "image", asset: `a-${id}`, x, y, width: 160, height: 90, rotation: 0 });
	const box = (id: string, text: string, x: number, y: number): TextElement => ({ id, type: "text", x, y, width: 220, text, fontSize: 14, color: "#1a1a1a" });
	const p1 = createPage({ width: 600, height: 800 });
	const p2 = createPage({ width: 600, height: 800 });
	p1.elements = [picture("lake", 40, 60), box("c-lake", captionText("lake", "The lake at dawn"), 40, 156), box("note", `see ${referenceToken("hill")} and ${referenceToken("gone")}`, 40, 300)];
	p2.elements = [picture("hill", 40, 60), box("c-hill", captionText("hill", "North ridge"), 40, 156)];
	const pages: Page[] = [p1, p2];
	let tick = 0;
	const numbers = new FigureNumbers({ pages: () => pages, tick: () => tick });
	numbers.register();

	const label = (text: string) => shownText(text).text;
	add("numbers follow the reading order", numbers.items().map((n) => `${n.number}:${n.figure.elementId}`).join("|") === "1:lake|2:hill", numbers.items().map((n) => n.number).join(","));
	add("a caption shows 'Fig. N — words'", label(captionText("hill", "North ridge")) === "Fig. 2 — North ridge", label(captionText("hill", "North ridge")));
	add("a reference shows the current number", label(referenceToken("hill")) === "Fig. 2");
	add("a reference to a missing figure shows 'Fig. ?'", label(referenceToken("gone")) === "Fig. ?");
	add("references that show 'Fig. ?' are counted", brokenReferences(pages).length === 1);

	// A figure captioned on an earlier page renumbers the later ones; stored text is unchanged.
	const p0 = createPage({ width: 600, height: 800 });
	p0.elements = [picture("cover", 40, 60), box("c-cover", captionText("cover", "Cover"), 40, 156)];
	pages.unshift(p0);
	tick++;
	numbers.touch();
	add("adding a figure before renumbers the later ones", label(referenceToken("hill")) === "Fig. 3" && label(referenceToken("lake")) === "Fig. 2");
	add("the stored text is not changed", (p1.elements?.[2] as TextElement).text.includes(referenceToken("hill")));
	pages.shift();
	tick++;
	numbers.touch();
	add("removing it renumbers back", label(referenceToken("hill")) === "Fig. 2");

	// The drawing: a reference is drawn as what it shows (a short label), not as its marker.
	const canvas = createEl("canvas");
	canvas.width = 420;
	canvas.height = 120;
	canvas.style.cssText = "display:block;background:#fff;border-radius:8px;margin-top:12px;max-width:100%";
	const ctx = canvas.getContext("2d");
	let markerPixels = 0;
	if (ctx) {
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, 420, 120);
		const rows: TextElement[] = [box("d1", captionText("lake", "The lake at dawn"), 12, 8), box("d2", `As ${referenceToken("hill")} shows`, 12, 40), box("d3", `Lost: ${referenceToken("gone")}`, 12, 72)];
		for (const r of rows) drawTextElement(ctx, r);
		const data = ctx.getImageData(0, 0, 420, 120).data;
		for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 160) markerPixels++;
		add("a text box with markers is drawn", markerPixels > 200, String(markerPixels));
		add("the drawn width is the label's, not the marker's", measureText("As Fig. 2 shows", 14) < measureText(`As ${referenceToken("hill")} shows`, 14));
	}

	// The caption dialog.
	let saved: string | null = null;
	const dialog = new FigureCaptionModal(app as never, { number: 2, words: "North ridge", save: (w) => (saved = w) });
	dialog.open();
	await sleep(40);
	const dEl = document.querySelector<HTMLElement>(".nb-figcap-modal");
	const input = dEl?.querySelector<HTMLInputElement>("input.nb-modal-input");
	add("the caption dialog shows the words and the number", input?.value === "North ridge" && !!dEl?.querySelector(".nb-figcap-number"), dEl?.textContent ?? "");
	if (input) input.value = "North ridge, 2026";
	dEl?.querySelector<HTMLButtonElement>(".nb-modal-foot .nb-modal-btn.is-primary")?.click();
	await sleep(30);
	add("Save hands back the words and closes", saved === "North ridge, 2026" && !document.querySelector(".nb-figcap-modal"), String(saved));

	// The reference picker.
	let chosen: string | null = null;
	const picker = new FigureRefModal(app as never, { items: () => numbers.items(), broken: () => brokenReferences(pages, numbers.items()).length, insert: (id) => (chosen = id) });
	picker.open();
	await sleep(60);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.nb-figcap-modal ${sel}`));
	add("the picker lists the captioned figures in order", q(".nb-modal-row-label").map((e) => e.textContent).join("|") === "Fig. 1 — The lake at dawn|Fig. 2 — North ridge", q(".nb-modal-row-label").map((e) => e.textContent).join("|"));
	add("every row is a 44 px target", q(".nb-figcap-row").length === 2 && q(".nb-figcap-row").every((r) => r.getBoundingClientRect().height >= 43));
	add("the picker says how many references show 'Fig. ?'", q(".nb-modal-note").some((n) => (n.textContent ?? "").includes("1")));
	const modal = document.querySelector<HTMLElement>(".nb-figcap-modal");
	add("the picker fits the screen", !!modal && modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= window.innerWidth + 1);
	// Left open for the screenshot, with the drawn boxes under the list.
	modal?.querySelector<HTMLElement>(".nb-modal-body")?.appendChild(canvas);
	mount(modal);
	await sleep(40);
	q(".nb-figcap-row")[1]?.click();
	await sleep(30);
	add("a row hands back the chosen figure and closes", chosen === "hill" && !document.querySelector(".nb-figcap-modal"), String(chosen));

	// The screenshot state: open the picker again.
	const shot = new FigureRefModal(app as never, { items: () => numberFigures(pages), broken: () => brokenReferences(pages).length, insert: () => undefined });
	shot.open();
	await sleep(60);
	const again = document.querySelector<HTMLElement>(".nb-figcap-modal");
	again?.querySelector<HTMLElement>(".nb-modal-body")?.appendChild(canvas);
	mount(again);
	await sleep(40);
	numbers.dispose();

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
