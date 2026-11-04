/**
 * 0.14 sections: the dynamic sections (Now, To complete, Changed on another device) in the browser harness. `checkSections()`
 * seeds the view's seen record (as if this device had last looked 30 days ago and had seen three notebooks since), then checks
 * the dashboard panels (library) or the shortcut chips (Home), the sidebar counts, that every row opens, that a section is a
 * place with the same number of notebooks, and that "Mark as seen" empties and hides Changed. It leaves the screen as it found
 * it. `sectionsState()` sets the seeded state up for review screenshots.
 */
import type { SeenState } from "../../src/library/changed-seen";
import { t } from "../../src/i18n";
import type { LibraryHarness } from "./library-check";

type Result = { name: string; ok: boolean; detail: string };

/** The view's private parts the check seeds and reads (the harness is the one place that reaches into them). */
interface Internals {
	seen: SeenState | null;
	dyn: unknown;
	place: unknown;
	index: { all(): Array<{ path: string; id?: string; mtime: number }> };
	render(): void;
}

const DAY = 24 * 60 * 60 * 1000;
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const app = () => document.querySelector<HTMLElement>(".nb-app")!;
const q = (sel: string) => app().querySelector<HTMLElement>(sel);
const all = (sel: string) => Array.from(app().querySelectorAll<HTMLElement>(sel));
const num = (el: Element | null | undefined) => Number(el?.textContent?.trim() ?? NaN);

async function seed(h: LibraryHarness): Promise<void> {
	const v = h.view as unknown as Internals;
	const state: SeenState = { version: 1, baseline: Date.now() - 30 * DAY, seen: {} };
	for (const e of v.index.all().slice(0, 3)) state.seen[e.id ? `id:${e.id}` : `path:${e.path}`] = e.mtime;
	v.seen = state;
	v.dyn = null;
	v.render();
	await frames(3);
	await wait(150);
}

async function unseed(h: LibraryHarness): Promise<void> {
	const v = h.view as unknown as Internals;
	v.seen = { version: 1, baseline: Date.now(), seen: {} };
	v.dyn = null;
	v.render();
	await frames(3);
}

export async function sectionsState(h: LibraryHarness, state: string): Promise<boolean> {
	if (state === "on") await seed(h);
	else await unseed(h);
	return true;
}

export async function checkSections(h: LibraryHarness, surface: string): Promise<Result[]> {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `sections ${window.innerWidth}px ${surface}: ${name}`, ok, detail });
	const v = h.view as unknown as Internals;
	const initialPlace = v.place;
	await seed(h);

	const railOf = (id: string) => q(`[data-key="nav:dyn:${id}"]`);
	const railCount = (id: string) => num(railOf(id)?.querySelector(".nb-rail-count, .nb-count"));
	const ids = ["now", "todo", "changed"];
	const present = ids.filter((id) => railOf(id));
	add("the sidebar lists Now, To complete and Changed with counts", present.length === 3 && ids.every((id) => railCount(id) > 0), ids.map((id) => `${id}=${railCount(id)}`).join(" "));

	if (surface === "library") {
		const panels = all(".nb-lib-dyn");
		add("the dashboard shows the three panels, Now first", panels.length === 3 && panels[0]!.classList.contains("nb-lib-dyn-now"), panels.map((p) => p.className).join("|"));
		const firstRow = q(".nb-lib-dyn-now .nb-list-row .nb-row-meta")?.textContent ?? "";
		add("the first row of Now says the class is in progress", firstRow === t("dyn.reason.lecture"), firstRow);
		for (const id of ids) {
			const badge = num(q(`.nb-lib-dyn-${id} .nb-dyn-count`));
			add(`${id}: the panel count matches the sidebar`, badge === railCount(id), `${badge} / ${railCount(id)}`);
		}
		add("every row is a labelled control that opens its notebook", all(".nb-lib-dyn .nb-list-row").every((r) => r.getAttribute("role") === "button" && !!r.getAttribute("aria-label")));
		const before = h.calls.length;
		q(".nb-lib-dyn-todo .nb-list-row")?.click();
		await frames(2);
		add("a row opens its notebook", h.calls.slice(before).some((c) => c.startsWith("open:")), h.calls.slice(before).join());
		await seed(h);
	} else {
		const chips = all(".nb-home-dynamic .nb-chip");
		add("Home shows a shortcut chip for each section", chips.length === 3, String(chips.length));
		add("the chips carry the same counts as the sidebar", ids.every((id, i) => num(chips[i]?.querySelector(".nb-chip-count")) === railCount(id)), chips.map((c) => c.textContent).join("|"));
	}

	// A section is a place with the same notebooks.
	const expected = railCount("changed");
	railOf("changed")?.click();
	await frames(3);
	await wait(100);
	const cards = all(".notebook-lib-card").length;
	add("Changed opens as a place with its notebooks", q(".nb-page-title")?.textContent === t("dyn.changed") && cards === Math.min(expected, 60), `${q(".nb-page-title")?.textContent} ${cards}/${expected}`);
	const mark = q(".nb-mark-seen");
	add("the place has a working Mark as seen control", !!mark && mark.getAttribute("aria-label") === t("dyn.markSeen"));
	mark?.click();
	await frames(4);
	await wait(100);
	add("after Mark as seen the section is hidden and the place says it is empty", !railOf("changed") && all(".notebook-lib-card").length === 0 && !!q(".nb-empty, .nb-empty-state, .nb-empty-title"), String(all(".notebook-lib-card").length));
	add("Now and To complete are still there", !!railOf("now") && !!railOf("todo"));

	// Back to where the check found the screen.
	v.place = initialPlace;
	await unseed(h);
	add("a fresh record shows nothing as changed", !railOf("changed"));
	return out;
}
