/**
 * Smoke check of the suggested PDF search terms (0.27, roadmap #418; `HARNESS_DOC=pdfsuggest npm run harness:check`): the real
 * SearchPanel over a stand-in controller that builds the pool the way the view does (outline of a PDF, headings and titles,
 * frequent typed words; one notebook only). Checks the chips with an empty box, that typing filters them, that a tap puts the
 * term in the box and searches it, that the row scrolls inside the panel instead of widening it, and that the pool is built once.
 * Left open with the box empty for the screenshot; `pdfsuggestShot("typed")` types "ent" for the second one.
 */
import { SearchPanel } from "../../src/view/pdf-search-panel";
import { filterSuggestions, gatherSuggestInput, SuggestCache } from "../../src/pdf/search-suggest";
import { createDocument, createPage } from "../../src/model/document";
import type { Page } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface PdfSuggestCheckApi {
	errors: string[];
	notices: string[];
}

let mounted: { root: HTMLElement; panel: SearchPanel } | null = null;
const queries: string[] = [];
const cache = new SuggestCache();

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const narrow = () => window.innerWidth < 600;

function demoInput() {
	const doc = createDocument();
	const page: Page = createPage();
	page.background = { kind: "pdf", asset: "demo-pdf", page: 1 };
	page.elements = [
		{ id: "t1", type: "text", x: 40, y: 40, width: 300, text: "Entropy grows. Entropy of the system, enthalpy and entropy again. Enthalpy changes.", fontSize: 16, color: "#000000" },
		{ id: "b1", type: "box", kind: "definition", x: 40, y: 200, width: 200, height: 80, title: "Second law of thermodynamics" },
		{ id: "k1", type: "checkbox", x: 40, y: 300, size: 18, color: "#000000", label: "Review entropy examples" },
	] as Page["elements"];
	doc.pages = [page];
	return gatherSuggestInput(doc, {
		"demo-pdf": [
			{ title: "1 Introduction", level: 1, page: 1 },
			{ title: "Entropy and heat", level: 1, page: 1 },
			{ title: "Entropy in statistical mechanics", level: 2, page: 1 },
			{ title: "The Carnot cycle", level: 1, page: 1 },
			{ title: "Free energy", level: 1, page: 1 },
		],
	});
}

function unmount(): void {
	mounted?.panel.destroy();
	mounted?.root.remove();
	mounted = null;
}

function mount(): { root: HTMLElement; panel: SearchPanel } {
	unmount();
	queries.length = 0;
	const root = document.body.createDiv({ cls: "notebook-view" });
	root.setCssProps({ position: "fixed", inset: "0", background: "var(--background-secondary)", zIndex: "50" });
	let pool = cache.get(demoInput());
	const panel = new SearchPanel(root, {
		query: (text) => queries.push(text),
		step: () => undefined,
		pick: () => undefined,
		close: () => undefined,
		suggest: (typed, limit) => filterSuggestions(pool, typed, limit),
	}, narrow);
	pool = cache.get(demoInput());
	mounted = { root, panel };
	panel.open();
	return mounted;
}

const labels = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".notebook-search-chip")].map((c) => c.textContent ?? "");

export async function checkPdfSuggest(api: PdfSuggestCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const { root, panel } = mount();
	await sleep(60);
	const max = narrow() ? 8 : 14;

	let chips = labels(root);
	add("an empty box shows chips, no more than the row allows", chips.length > 0 && chips.length <= max, chips.join("|"));
	add("the outline comes first, then titles, then frequent words", chips[0] === "1 Introduction" || chips[0]?.startsWith("Entropy") === true || chips[0] === "The Carnot cycle" || chips[0] === "Free energy", chips.slice(0, 3).join("|"));
	add("a frequent typed word is among them, a stop-word is not", chips.includes("entropy") && !chips.some((c) => c.toLowerCase() === "the"), chips.join("|"));
	add("every chip is a button with a long-press explanation", [...root.querySelectorAll<HTMLElement>(".notebook-search-chip")].every((c) => c.tagName === "BUTTON" && c.dataset.help === "help.searchSuggest"));

	// Typing filters.
	const input = root.querySelector<HTMLInputElement>(".notebook-search-input")!;
	input.value = "ent";
	input.dispatchEvent(new Event("input"));
	await sleep(30);
	chips = labels(root);
	add("typing filters the chips by prefix", chips.length > 0 && chips.every((c) => c.toLowerCase().includes("ent")), chips.join("|"));
	input.value = "carnt";
	input.dispatchEvent(new Event("input"));
	await sleep(30);
	chips = labels(root);
	add("one typo still finds the term", chips[0] === "The Carnot cycle", chips.join("|"));
	input.value = "zzzz";
	input.dispatchEvent(new Event("input"));
	await sleep(30);
	add("nothing fits: the row is hidden, not empty", root.querySelector(".notebook-search-suggest")?.classList.contains("notebook-hidden") === true);

	// Tapping a chip.
	input.value = "";
	input.dispatchEvent(new Event("input"));
	await sleep(400);
	queries.length = 0;
	const first = root.querySelector<HTMLElement>(".notebook-search-chip");
	const term = first?.textContent ?? "";
	first?.click();
	add("a tap puts the term in the box and searches it at once", input.value === term && queries[queries.length - 1] === term, `${term} / ${queries.join("|")}`);

	// Layout: the row scrolls inside the panel.
	input.value = "";
	input.dispatchEvent(new Event("input"));
	await sleep(30);
	const el = panel.el;
	add("the panel does not run sideways", el.scrollWidth <= el.clientWidth + 1, `${el.scrollWidth}/${el.clientWidth}`);
	const row = root.querySelector<HTMLElement>(".notebook-search-suggest")!;
	add("the row is one line high", row.getBoundingClientRect().height < 64, `${Math.round(row.getBoundingClientRect().height)}px`);

	// Cache.
	const before = cache.built;
	cache.get(demoInput());
	cache.get(demoInput());
	add("the pool is built once for the same notebook", cache.built === before);
	add("another notebook's words are not in the pool", !labels(root).includes("secretword"));

	// Leave the empty state on screen.
	panel.open();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, narrow: narrow() } };
}

/** The second screenshot state. */
export async function pdfsuggestShot(state: "typed"): Promise<void> {
	if (!mounted) mount();
	const input = mounted?.root.querySelector<HTMLInputElement>(".notebook-search-input");
	if (!input || state !== "typed") return;
	input.value = "ent";
	input.dispatchEvent(new Event("input"));
	await sleep(60);
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function pdfSuggestApi(api: PdfSuggestCheckApi): Record<string, unknown> {
	return {
		checkPdfSuggest: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkPdfSuggest(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`pdfsuggest check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		pdfsuggestShot,
	};
}
