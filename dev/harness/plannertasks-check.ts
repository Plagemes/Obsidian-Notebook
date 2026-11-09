/**
 * Smoke check of the tasks chip on planner pages (0.27, roadmap #266) on the `doc=plannertasks` notebook (the blank "New" notebook;
 * HARNESS_DOC=plannertasks npm run harness:check): the real view, chip, panel and setting, with a stand-in vault of notes. Page 1 is
 * made a daily planner page (12 March 2026), page 2 the weekly page of that week, page 3 an ordinary page. The chip counts the open
 * tasks due on the page's days (Tasks plugin date, Dataview due field, a task in that day's daily note); the panel lists them open
 * first, each row opens its note at the line, none is a checkbox; a changed note updates the chip; the setting turns it off; the
 * notebook is not touched. `plannertasksShot` leaves the panel open (or just the chip) for the screenshots.
 */
import { buildPlanner } from "../../src/model/planner";
import type { Page } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PlannertasksCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface StubFile { path: string; stat: { mtime: number } }
interface PlannertasksView extends HarnessView {
	plannerTasks: { wrote(): void; panelOpen: boolean; shownDays: readonly string[]; busy: boolean; sync(): void; reset(): void };
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	app: {
		vault: { create(p: string, data: string): Promise<StubFile>; modify(f: StubFile, data: string): Promise<void>; getFileByPath(p: string): StubFile | null };
		metadataCache: { caches: Map<string, unknown>; trigger(name: string, ...a: unknown[]): void };
		workspace: { getLeaf: (...a: unknown[]) => unknown };
	};
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { plannerTasks: boolean } };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const chip = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-plantasks");
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-plantasks-panel");
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-plantasks-row"));

/** The metadata cache entry Obsidian would hold for a note: one list item per task line. */
function cacheOf(text: string): unknown {
	return { listItems: text.split("\n").filter((l) => /^\s*[-*+]\s+\[.\]/.test(l)).map((l) => ({ task: /\[(.)\]/.exec(l)![1] })) };
}

async function note(v: PlannertasksView, path: string, text: string): Promise<StubFile> {
	// (the stand-in vault outlives a re-open of the notebook: a note left by an earlier run is put back as it was)
	const had = v.app.vault.getFileByPath(path);
	if (had) await v.app.vault.modify(had, text);
	const f = had ?? (await v.app.vault.create(path, text));
	v.app.metadataCache.caches.set(path, cacheOf(text));
	return f;
}

const PROJECT = "- [ ] Send the report 📅 2026-03-12\n- [x] Book the room [due:: 2026-03-12]\n- [ ] Much later 📅 2026-04-01\n- [ ] No date at all";

/** Page 1 = the daily page of 12 March 2026, page 2 = its week, page 3 ordinary; the vault holds the notes. */
async function prepare(api: PlannertasksCheckApi): Promise<PlannertasksView> {
	await api.open("plannertasks");
	const v = api.view as PlannertasksView;
	v.host.settings.plannerTasks = true;
	v.applySettings(v.host.settings);
	while (v.document.pages.length < 3) v.addPage();
	await api.frames(3);
	const pages = v.document.pages;
	const { pages: built } = buildPlanner({
		year: 2026, startMonth: 1, lang: "en", weekStart: 1, size: { width: pages[0]!.width, height: pages[0]!.height },
		sections: { year: false, months: false, weeks: true, days: true, notes: false }, notesPages: 0, linkTarget: "New.notebook",
	});
	const day = built.find((p) => p.paper.kind === "planner-day" && JSON.stringify(p.elements).includes("12 March 2026")) as Page;
	const week = built.find((p) => p.paper.kind === "planner-week" && JSON.stringify(p.elements).includes("9–15 March 2026")) as Page;
	Object.assign(pages[0]!, { paper: day.paper, elements: day.elements });
	Object.assign(pages[1]!, { paper: week.paper, elements: week.elements });
	await note(v, "Projects/Project.md", PROJECT);
	await note(v, "Daily/2026-03-12.md", "# Thursday\n- [ ] Call the bank\n- [ ] Buy a gift 📅 2026-03-14");
	await note(v, "Daily/2026-03-10.md", "- [ ] Tuesday thing");
	v.plannerTasks.reset();
	v.scrollToPage(0, 0, false);
	await sleep(700);
	await api.frames(3);
	return v;
}

/** On the daily page with the chip, and with the panel open for `panelOpen`. */
export async function plannertasksShot(api: PlannertasksCheckApi, state: "chip" | "panel" | "week"): Promise<void> {
	const v = await prepare(api);
	if (state === "week") {
		v.scrollToPage(1, 0, false);
		await sleep(700);
	}
	if (state !== "chip") {
		chip()?.click();
		await api.frames(3);
	}
}

export async function checkPlannertasks(api: PlannertasksCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const before = JSON.stringify(v.document.pages.map((p) => [p.id, p.strokes.length, p.elements?.length ?? 0]));
		const body = chip()?.parentElement?.getBoundingClientRect();
		const label = () => chip()?.textContent ?? "";
		add("the chip is shown on the daily planner page", !!chip(), label());
		add("it counts the open tasks due that day (Tasks date, due field, daily note)", label().includes("2"), label());
		add("it names the day it stands for", v.plannerTasks.shownDays.join() === "2026-03-12", v.plannerTasks.shownDays.join());
		const r = chip()?.getBoundingClientRect();
		add("the chip stays inside the page area", !!r && !!body && r.left >= body.left - 1 && r.right <= body.right + 1 && r.top >= body.top - 1 && r.bottom <= body.bottom + 1);
		add("the chip is a real button and starts collapsed", chip()?.tagName === "BUTTON" && chip()?.getAttribute("aria-expanded") === "false" && !panel());

		chip()?.click();
		await api.frames(3);
		add("tapping the chip opens the list", !!panel() && chip()?.getAttribute("aria-expanded") === "true");
		const texts = rows().map((x) => x.querySelector(".notebook-plantasks-task")?.textContent ?? "");
		add("three tasks: two open first, the done one last", texts.join("|") === "Call the bank|Send the report|Book the room", texts.join("|"));
		add("a task of another day or without a date is not listed", !texts.some((x) => x.includes("Much later") || x.includes("No date")));
		add("the done one is marked as done", rows()[2]?.classList.contains("is-done") === true);
		add("no row is a checkbox (read only)", !panel()?.querySelector("input, [role=checkbox], [role=switch]"));
		const pr = panel()?.getBoundingClientRect();
		add("the list stays inside the page area and clear of the chip", !!pr && !!body && !!r && pr.right <= body.right + 1 && pr.bottom <= body.bottom + 1 && pr.top >= r.bottom - 1, pr ? `${Math.round(pr.top)}-${Math.round(pr.bottom)}` : "");

		// A row opens its note at the line.
		const opened: Array<{ path: string; line: unknown }> = [];
		const real = v.app.workspace.getLeaf;
		v.app.workspace.getLeaf = () => ({ openFile: async (f: StubFile, s?: { eState?: { line?: number } }) => void opened.push({ path: f.path, line: s?.eState?.line }) });
		rows()[1]?.click();
		await sleep(50);
		v.app.workspace.getLeaf = real;
		add("a row opens its note at the task's line", opened.length === 1 && opened[0]!.path === "Projects/Project.md" && opened[0]!.line === 0, JSON.stringify(opened));
		add("and closes the list", !panel());

		// The first stroke takes the list away, the chip stays.
		chip()?.click();
		await api.frames(2);
		v.plannerTasks.wrote();
		await api.frames(2);
		add("writing folds the list and keeps the chip", !panel() && !!chip());

		// A changed note updates the count.
		const project = v.app.vault.getFileByPath("Projects/Project.md")!;
		await sleep(5);
		const next = `${PROJECT}\n- [ ] Added later [due:: 2026-03-12]`;
		v.app.metadataCache.caches.set(project.path, cacheOf(next));
		await v.app.vault.modify(project, next);
		v.app.metadataCache.trigger("changed", project);
		await sleep(1300);
		add("a changed note updates the chip", label().includes("3"), label());

		// The week.
		v.scrollToPage(1, 0, false);
		await sleep(700);
		await api.frames(3);
		add("the weekly page has a chip for its seven days", v.plannerTasks.shownDays.length === 7, String(v.plannerTasks.shownDays.length));
		add("it counts the week's open tasks", label().includes("5"), label());
		chip()?.click();
		await api.frames(3);
		add("weekly rows say which day", rows().some((x) => !!x.querySelector(".notebook-plantasks-day")));
		add("the Tuesday task and the 14th are in the week", rows().some((x) => x.textContent?.includes("Tuesday thing")) && rows().some((x) => x.textContent?.includes("Buy a gift")));
		v.plannerTasks.wrote();

		// An ordinary page has none.
		v.scrollToPage(2, 0, false);
		await sleep(700);
		await api.frames(3);
		add("an ordinary page has no chip", !chip());

		// The setting.
		v.scrollToPage(0, 0, false);
		await sleep(700);
		add("back on the daily page the chip returns", !!chip());
		v.host.settings.plannerTasks = false;
		v.applySettings(v.host.settings);
		await sleep(500);
		add("with the setting off there is no chip", !chip());
		v.host.settings.plannerTasks = true;
		v.applySettings(v.host.settings);
		await sleep(500);
		add("and it is back with the setting on", !!chip());

		const after = JSON.stringify(v.document.pages.map((p) => [p.id, p.strokes.length, p.elements?.length ?? 0]));
		add("the notebook was not changed", before === after);
		add("the overlay is not in the page data", !JSON.stringify(v.document.pages[0]).includes("Call the bank"));
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((x) => x.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
