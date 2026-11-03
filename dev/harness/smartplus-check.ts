/**
 * Smoke check of the Smart "+" (0.14, roadmap #410) on the `doc=new` notebook (npm run harness:check): the real view's
 * "add-page" action shows the strip of likely pages; each chip is a real button that adds the right page in one undo
 * step, "More…" opens the page sheet, and the strip steps aside. The run leaves the strip open for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SmartAddCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkSmartAdd(api: SmartAddCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const strip = (): HTMLElement | null => document.querySelector(".nb-smart-add");
	const keys = (): string[] => [...document.querySelectorAll<HTMLElement>(".nb-smart-add .nb-chip")].map((c) => c.dataset.key ?? "");
	const pages = (): number => v.document.pages.length;

	const n0 = pages();
	v.runAction("add-page");
	await api.frames(2);
	add("the + shows the strip and adds nothing yet", !!strip() && pages() === n0, `pages ${pages()}`);
	const ks = keys();
	add("2 to 3 suggestions plus More", ks.length >= 3 && ks.length <= 4 && ks[ks.length - 1] === "smart-add:more", ks.join(","));
	add("the first suggestion is the same paper", ks[0] === "smart-add:same", ks[0] ?? "");
	const chips = [...document.querySelectorAll<HTMLElement>(".nb-smart-add .nb-chip")];
	add("every chip is at least 40 px tall and inside the view", chips.every((c) => c.offsetHeight >= 40 && c.getBoundingClientRect().right <= window.innerWidth + 1));

	// Tapping the exercise chip (when offered) or the first one adds one page after the current page.
	const pick = document.querySelector<HTMLElement>(".nb-smart-add .nb-chip[data-key='smart-add:blank']") ?? document.querySelector<HTMLElement>(".nb-smart-add .nb-chip");
	const kind = pick?.dataset.key ?? "";
	pick?.click();
	await api.frames(2);
	add("a chip adds exactly one page and the strip closes", pages() === n0 + 1 && !strip(), `pages ${pages()} chip ${kind}`);
	v.undo();
	add("one undo takes the page away", pages() === n0);

	// The next "+" learns from the choice and still offers a way to the full chooser.
	v.runAction("add-page");
	await api.frames(2);
	add("the strip comes back", !!strip());
	document.querySelector<HTMLElement>(".nb-smart-add .nb-chip[data-key='smart-add:more']")?.click();
	await api.frames(3);
	add("More opens the page sheet and the strip closes", !strip() && !!document.querySelector(".nb-sheet, .notebook-sheet, [class*='sheet']"));
	v.ui.sheet && (document.querySelector<HTMLElement>("body")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
	await api.frames(2);

	v.runAction("add-page");
	await api.frames(3);
	add("the strip is open for the screenshot", !!strip());
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
