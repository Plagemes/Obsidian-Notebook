/**
 * Smoke check of the notebook map (0.14, roadmap #408) on the `doc=nbmap` notebook (the outline notebook: three slides with
 * a question, a gap and a key point, a notes page and a blank page; npm run harness:check). The real view's page panel
 * gets its map button; the modal is opened through it and driven through the DOM: cards, badges, filter chips with counts,
 * tap to go to a page. It leaves the map open for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface NbmapCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkNbmap(api: NbmapCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-map-modal");
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-map-modal .nb-map-card"));
	const chips = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-map-modal .nb-chip"));
	const chipOf = (key: string) => chips().find((c) => c.dataset.key === key);
	const countOf = (key: string) => chipOf(key)?.querySelector(".nb-chip-count")?.textContent ?? "";

	const openMap = async (): Promise<void> => {
		if (!v.pageNav.open) v.toggleNavigator();
		await frames(2);
		const b = document.querySelector<HTMLButtonElement>(".notebook-navigator-header button[aria-label='Notebook map']");
		add("the page panel has a Notebook map button", !!b || modal() !== null);
		b?.click();
		await frames(3);
		const m = modal();
		if (m && !m.closest(".harness-modal-container")) {
			const backdrop = document.body.createDiv({ cls: "harness-modal-container" });
			backdrop.appendChild(m);
		}
		await frames(2);
	};
	await openMap();
	add("the map opens", modal() !== null);
	add("one card per page", cards().length === 5, `${cards().length}`);
	add("filters: all, questions, to complete, key points, empty", ["all", "question", "gap", "key", "empty"].every((k) => !!chipOf(k)) && !chipOf("homework"), chips().map((c) => c.dataset.key).join(","));
	add("counts per state", countOf("all") === "5" && countOf("question") === "1" && countOf("gap") === "1" && countOf("key") === "1" && countOf("empty") === "1",
		["all", "question", "gap", "key", "empty"].map(countOf).join(","));
	add("page 1 shows a question and a gap badge", (cards()[0]?.dataset.states ?? "") === "question gap", cards()[0]?.dataset.states ?? "");
	add("the blank page is marked empty", (cards()[4]?.dataset.states ?? "") === "empty", cards()[4]?.dataset.states ?? "");
	add("every card is a 40 px target", cards().every((c) => c.getBoundingClientRect().height >= 40), "");
	add("cards stay inside the dialog", cards().every((c) => { const r = c.getBoundingClientRect(); const m = modal()!.getBoundingClientRect(); return r.left >= m.left - 1 && r.right <= m.right + 1; }), "");
	for (let i = 0; i < 40 && cards().some((c) => !c.querySelector("img")?.getAttribute("src")); i++) await sleep(50);
	add("thumbnails are drawn", cards().every((c) => (c.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:")), "");

	chipOf("question")?.click();
	await frames(2);
	add("the question filter keeps one page", cards().length === 1 && cards()[0]?.dataset.index === "0", `${cards().length}`);
	chipOf("question")?.click();
	await frames(2);
	add("tapping the active filter clears it", cards().length === 5, `${cards().length}`);
	chipOf("empty")?.click();
	await frames(2);
	add("the empty filter keeps the blank page", cards().length === 1 && cards()[0]?.dataset.index === "4", `${cards().length}`);

	cards()[0]?.click();
	await sleep(400);
	await frames(3);
	add("tapping a card goes to the page and closes the map", v.currentPage() === 4 && modal() === null, `page ${v.currentPage() + 1}`);

	// Leave it open for the screenshot.
	await openMap();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
