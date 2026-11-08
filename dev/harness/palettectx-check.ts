/**
 * Smoke check of the context-ordered "All actions" sheet (0.24, roadmap #424, `doc=palettectx`, npm run harness:check) on the
 * blank "New" notebook: with the pen on a plain page the sheet has no "For this page" section; with the lasso in hand it opens
 * with that section, listing the lasso actions first; the section is a list of working rows (no fake controls); the
 * search puts the lasso's actions before the other matches. `palettectxShot` leaves the sheet open for the screenshots
 * (dist/shots/design/palettectx-<theme>-<device>.png).
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PalettectxCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PalettectxView extends HarnessView {
	toolbar: HarnessView["toolbar"] & { setTool(tool: string): void };
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-sheet");
const titles = (): string[] => Array.from(sheet()?.querySelectorAll(".notebook-sheet-section-title") ?? []).map((e) => e.textContent ?? "");
const firstSectionIds = (): string[] => Array.from(sheet()?.querySelector(".notebook-sheet-section")?.querySelectorAll<HTMLElement>("button.notebook-menu-item") ?? []).map((b) => b.dataset.action ?? "");

async function openSheet(api: PalettectxCheckApi): Promise<void> {
	const v = api.view as PalettectxView;
	if (v.ui.sheet.isOpen) v.ui.sheet.close();
	document.querySelector<HTMLElement>('.notebook-toolbar [aria-label="All actions"], [aria-label="All actions"]')?.click();
	await sleep(280);
	await api.frames(2);
}

export async function checkPalettectx(api: PalettectxCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	await api.open("new");
	const v = api.view as PalettectxView;
	await api.frames(3);
	await api.penStroke([[0.3, 0.3], [0.5, 0.34], [0.7, 0.3]]);
	await api.frames(2);

	v.toolbar.setTool("pen");
	await api.frames(2);
	await openSheet(api);
	add("the sheet opens", v.ui.sheet.isOpen && !!sheet());
	add("a plain page with the pen has no 'For this page' section", !titles().includes("For this page"), titles().join(", "));
	v.ui.sheet.close();

	v.toolbar.setTool("lasso");
	await api.frames(2);
	await openSheet(api);
	// A wide toolbar already shows the fitting actions (quick slots, selection bar), and the section never repeats them.
	// The History group (Action history, 0.25) is always in the sheet and comes before the selection ones; it is not what this checks.
	const lead = titles().filter((x) => x !== "History")[0];
	const here = titles()[0] === "For this page";
	add("with the lasso the sheet opens with 'For this page', or everything that fits is already on the toolbar", here || lead === "Selection", titles().join(", "));
	const ids = firstSectionIds();
	add("its rows are at most five", !here || (ids.length > 0 && ids.length <= 5), ids.join(","));
	add("every row is a working button", Array.from(sheet()?.querySelectorAll<HTMLButtonElement>(".notebook-sheet-section:first-child button.notebook-menu-item") ?? []).every((b) => b.textContent && !b.disabled));
	const r = sheet()?.getBoundingClientRect();
	add("the sheet stays inside the window", !!r && r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1);

	const input = sheet()?.querySelector<HTMLInputElement>("input[type=search]");
	if (input) {
		input.value = "select";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await api.frames(2);
		const hits = Array.from(sheet()?.querySelectorAll<HTMLElement>("button.notebook-menu-item") ?? []).map((b) => b.dataset.action ?? "");
		add("search puts the actions that fit the lasso first", (hits[0] ?? "").startsWith("select") || (hits[0] ?? "").startsWith("lasso"), hits.slice(0, 5).join(","));
	}
	v.ui.sheet.close();
	v.toolbar.setTool("pen");
	add("no script errors", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((x) => x.ok), results, errors: [...api.errors], notices: [...api.notices], env: {} };
}

/** Leaves the sheet open with the lasso in hand, for the screenshots. */
export async function palettectxShot(api: PalettectxCheckApi): Promise<void> {
	await api.open("new");
	const v = api.view as PalettectxView;
	await api.frames(3);
	await api.penStroke([[0.3, 0.3], [0.5, 0.34], [0.7, 0.3]]);
	await api.frames(2);
	v.toolbar.setTool("lasso");
	await api.frames(2);
	await openSheet(api);
}
