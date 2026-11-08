/**
 * Smoke check of the marked-pages filter of the page navigator (0.25, roadmap #419): HARNESS_DOC=markedview npm run harness:check.
 * Pages are marked in every way (bookmark, global bookmark, marker, colour meaning, open checkbox, tag); marked-only lists exactly those with their
 * real numbers and a badge each, in the list and in the thumbnail layout; the kinds narrow it; tapping a row goes to its page; an empty result says
 * so quietly; the choice is remembered per notebook and corrupt storage falls back to all pages. `markedviewShot` leaves the list showing.
 */
import { RENDER_INK } from "../../src/model/types";
import { NAV_MODE_KEY } from "../../src/ui/nav-adapt";
import { NAV_MARKED_KEY } from "../../src/ui/nav-marked";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface MarkedviewCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface MarkedView extends HarnessView {
	pageNav: { open: boolean; el: HTMLElement; refresh(): void };
	setNavigatorOpen(open: boolean): void;
	quickApi(): unknown;
	app: { loadLocalStorage(key: string): unknown; saveLocalStorage(key: string, data: unknown): void };
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { colourMeanings: Array<{ colour: string; label: string }> }; bookmarks?: { toggle(view: unknown): Promise<void> } };
}

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-navigator");
const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-navigator-item"));
const indexes = (): number[] => items().map((x) => Number(x.dataset.index));

async function marked(api: MarkedviewCheckApi): Promise<MarkedView> {
	await api.open("markedview");
	const v = api.view as MarkedView;
	v.app.saveLocalStorage(NAV_MODE_KEY, []);
	v.app.saveLocalStorage(NAV_MARKED_KEY, []);
	while (v.document.pages.length < 9) v.addPage();
	await api.frames(3);
	v.host.settings.colourMeanings = [{ colour: "#d62828", label: "Exam" }];
	const pages = v.document.pages;
	pages.forEach((p, i) => {
		p.elements = [{ id: `t${i}`, type: "text", x: 40, y: 60, width: 300, text: `Section ${i + 1}\nsecond line`, fontSize: 18, color: "#222222" }];
	});
	pages[1]!.tags = ["exam"];
	pages[2]!.elements!.push({ id: "m1", type: "marker", kind: "question", x: 300, y: 100 } as never);
	pages[3]!.elements!.push({ id: "c1", type: "checkbox", x: 40, y: 200, size: 20, label: "" } as never);
	pages[4]!.strokes.push({ id: "s1", tool: "pen", color: "#d62828", width: 2, render: RENDER_INK, points: [[10, 10, 0.5], [60, 40, 0.5]] } as never);
	(v.document.meta ??= {} as never).bookmarks = [pages[5]!.id];
	await v.host.bookmarks?.toggle(v.quickApi()); // a global bookmark on the page in view
	v.setNavigatorOpen(false);
	v.setNavigatorOpen(true);
	await api.frames(4);
	return v;
}

export async function markedviewShot(api: MarkedviewCheckApi): Promise<void> {
	const v = await marked(api);
	v.app.saveLocalStorage(NAV_MARKED_KEY, [[v.document.id, []]]);
	v.pageNav.refresh();
	await api.frames(4);
}

export async function checkMarkedview(api: MarkedviewCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await marked(api);
		const id = v.document.id;
		const set = async (kinds: string[] | null) => {
			v.app.saveLocalStorage(NAV_MARKED_KEY, kinds === null ? [] : [[id, kinds]]);
			v.pageNav.refresh();
			await api.frames(3);
		};
		const button = document.querySelector<HTMLButtonElement>(".notebook-navigator-marked");
		add("the marked-pages button exists and has a long-press help", !!button && button.dataset.help === "help.navMarked" && (button.getAttribute("aria-label") ?? "").length > 3);
		add("all pages by default", items().length === 9, String(items().length));
		add("no marked-only bar by default", !!document.querySelector(".notebook-navigator-markbar.notebook-hidden"));

		await set([]);
		const all = indexes();
		add("marked only lists the marked pages with their real numbers", [1, 2, 3, 4, 5, 8].every((i) => all.includes(i)) && all.length === 6, all.join(","));
		add("every marked page has a badge", items().every((x) => x.querySelectorAll(".notebook-navigator-mark").length > 0));
		add("the bar says marked only and can clear", !!document.querySelector(".notebook-navigator-markbar:not(.notebook-hidden) button"));
		const one = items().find((x) => x.dataset.index === "2");
		add("the question page says why", !!one?.querySelector(".notebook-navigator-mark.is-marker"));
		add("the numbers are the real ones", items().find((x) => x.dataset.index === "4")?.querySelector(".notebook-navigator-number")?.textContent === "5");

		await set(["tag"]);
		add("a sub-filter narrows the list", JSON.stringify(indexes()) === "[1]", indexes().join(","));
		await set(["task"]);
		add("open checkboxes", JSON.stringify(indexes()) === "[3]", indexes().join(","));
		await set(["meaning"]);
		add("colour meanings", JSON.stringify(indexes()) === "[4]", indexes().join(","));
		await set(["bookmark"]);
		add("in-notebook bookmarks", JSON.stringify(indexes()) === "[5]", indexes().join(","));
		await set(["global"]);
		add("global bookmarks (the page that was in view)", JSON.stringify(indexes()) === "[8]", indexes().join(","));

		// The thumbnail layout shows the badges too, and the compact list shows words.
		v.app.saveLocalStorage(NAV_MODE_KEY, [[id, "thumbs"]]);
		await set([]);
		add("thumbnail layout: badges without words", !panel()?.classList.contains("is-list") && document.querySelectorAll(".notebook-navigator-mark").length > 0 && document.querySelectorAll(".notebook-navigator-mark-text").length === 0);
		v.app.saveLocalStorage(NAV_MODE_KEY, [[id, "list"]]);
		await set([]);
		add("list layout: badges with words", !!panel()?.classList.contains("is-list") && document.querySelectorAll(".notebook-navigator-mark-text").length > 0);

		// Tapping goes to the page.
		items().find((x) => x.dataset.index === "3")?.click();
		await api.frames(3);
		v.setNavigatorOpen(true);
		await api.frames(3);
		add("tapping a row goes to its page", v.currentPage() === 3, String(v.currentPage()));

		// Empty result: a quiet message.
		v.document.pages.forEach((p) => { p.tags = []; p.elements = []; p.strokes = []; });
		(v.document.meta ??= {} as never).bookmarks = [];
		await set(["tag"]);
		add("an empty result says so quietly", items().length === 0 && (document.querySelector(".notebook-navigator-empty")?.textContent ?? "").length > 5, document.querySelector(".notebook-navigator-empty")?.textContent ?? "");

		// Corrupt storage and the clear button.
		v.app.saveLocalStorage(NAV_MARKED_KEY, "garbage");
		v.pageNav.refresh();
		await api.frames(3);
		add("corrupt storage falls back to all pages", items().length === 9, String(items().length));
		await set([]);
		document.querySelector<HTMLButtonElement>(".notebook-navigator-markbar button")?.click();
		await api.frames(3);
		const stored = (v.app.loadLocalStorage(NAV_MARKED_KEY) as Array<[string, unknown]> | null) ?? [];
		add("the bar's button shows all pages again and forgets the choice", items().length === 9 && !stored.some((r) => r[0] === id), JSON.stringify(stored));
		const p = panel()!.getBoundingClientRect();
		add("panel inside the window", p.right <= window.innerWidth + 1 && p.width > 100, `${p.left}-${p.right}`);
	} catch (e) {
		add("no exception", false, String(e));
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}
