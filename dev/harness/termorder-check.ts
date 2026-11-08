/**
 * 0.23 termorder (#416): the Library's "Active term" order (doc=termorder opens the library surface on the seeded demo vault with a
 * timetable). `installTermTimetable()` puts a demo timetable where the harness host reads it; `checkTermOrder()` reads the order of
 * the cards: with an active term the default is "Active term" (courses of the term by next class, then other courses, then the
 * rest); the sort menu offers it and the user's choice wins; without a timetable the option is hidden and the order is last-modified.
 */
import { t } from "../../src/i18n";
import { isoDay, type ClassEntry, type Timetable } from "../../src/timetable/schedule";
import type { LibraryHarness } from "./library-check";
import type { CheckResult } from "./reading-check";

type Win = { __nbTimetable?: Timetable | null; harnessMenu?: { titles: string[]; run: (title: string) => void } };
const w = window as unknown as Win;
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};

const entry = (id: string, course: string, day: number, notebook: string | undefined, from?: string, to?: string): ClassEntry => ({ id, course, day, start: "09:00", end: "10:30", weeks: "all", notebook, from, to });

/** Anatomia teaches the day after tomorrow, Fisiologia tomorrow (so Fisiologia comes first); Matematica's term is over; Biomateriali is not linked. */
export function installTermTimetable(): void {
	const at = (n: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + n);
	const weekday = (n: number) => (at(n).getDay() === 0 ? 7 : at(n).getDay());
	const from = isoDay(at(-40)), to = isoDay(at(60));
	w.__nbTimetable = {
		version: 1,
		entries: [
			entry("a", "Anatomia", weekday(2), "Notebooks/Anatomia", from, to),
			entry("m", "Matematica", weekday(1), "Notebooks/Matematica", "2020-02-01", "2020-06-30"),
			entry("f", "Fisiologia", weekday(1), "Notebooks/Fisiologia", from, to),
		],
	};
}

const cards = (): string[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-lib-card")).map((c) => c.dataset.path ?? "");
const folderOf = (p: string) => (p.split("/").length > 2 ? p.split("/")[1]! : "");

export async function checkTermOrder(h: LibraryHarness): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const view = h.view as unknown as { render(): void };
	const rerender = async () => { view.render(); await frames(3); };
	const sortButton = () => document.querySelector<HTMLElement>(`[aria-label="${t("library.sort.label")}"]`);
	const menu = async () => {
		w.harnessMenu = undefined;
		sortButton()?.click();
		await frames(1);
		return (window as unknown as Win).harnessMenu ?? null;
	};
	// Collapse to the order of the folders, in sequence, so "Fisiologia x3, Anatomia x3, Matematica x3, then the rest" reads at once.
	const groups = () => cards().map(folderOf).filter((f, i, a) => i === 0 || f !== a[i - 1]);

	await rerender();
	const termOrder = cards();
	add("the library has notebooks", termOrder.length >= 10, `${termOrder.length}`);
	add("active term: the default order starts with the course taught first", groups()[0] === "Fisiologia", groups().join(">"));
	add("active term: then the other course of the term, then the course whose term is over", groups().slice(0, 3).join(">") === "Fisiologia>Anatomia>Matematica", groups().join(">"));
	add("active term: notebooks of no course come last", ["Biomateriali", ""].includes(groups()[groups().length - 1]!) && !groups().slice(0, 3).includes("Biomateriali"), groups().join(">"));
	const m1 = await menu();
	add("the sort menu offers Active term", !!m1?.titles.includes(t("library.sort.term")), (m1?.titles ?? []).join("|"));
	m1?.run(t("library.sort.modified"));
	await rerender();
	const modified = cards();
	add("choosing Last modified overrides the default", modified.join() !== termOrder.join(), groups().join(">"));
	const m2 = await menu();
	m2?.run(t("library.sort.term"));
	await rerender();
	add("choosing Active term brings the term order back", cards().join() === termOrder.join(), groups().join(">"));

	const saved = w.__nbTimetable;
	w.__nbTimetable = null;
	await rerender();
	const m3 = await menu();
	add("without a timetable the option is hidden", !!m3 && !m3.titles.includes(t("library.sort.term")), (m3?.titles ?? []).join("|"));
	add("without a timetable the order is last-modified", cards().join() === modified.join(), groups().join(">"));
	m3?.run(t("library.sort.modified"));
	w.__nbTimetable = saved;
	// Leave the screen on the default term order for the screenshot (the choice made above was Last modified).
	const m4 = await menu();
	m4?.run(t("library.sort.term"));
	await rerender();
	return { ok: results.every((r) => r.ok), results, errors: [], notices: [], env: { width: window.innerWidth } };
}
