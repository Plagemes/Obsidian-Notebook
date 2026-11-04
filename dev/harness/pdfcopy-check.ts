/**
 * 0.17 PDF copy (#23) on the `doc=pdfcopy` scenario (npm run harness:check). Two surfaces, on the real code:
 *  - the notebook view: the "More options" menu of the tab shows the notebook's own choice and the status line, a click
 *    turns the copy on for this notebook, and a finished save tells the copy service (which builds nothing here: a stand-in
 *    records the calls). The source it hands over is the notebook as saved, never an unsaved one.
 *  - the settings tab: the three rows of Obsidian integration (switch, when, folder), searched for, switched, saved. The tab is
 *    left open for the screenshot.
 */
import { DEFAULT_SETTINGS } from "../../src/settings";
import { NotebookSettingTab, type SettingsHost } from "../../src/view/settings-tab";
import { Menu, type App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";
import type { PdfCopyPort, PdfCopySourceFn } from "../../src/storage/pdf-copy-service";

interface MenuView {
	file: { path: string };
	host: { pdfCopy?: PdfCopyPort; settings: unknown };
	document: { pages: unknown[] };
	onPaneMenu(menu: unknown, source: string): void;
	flushNow(): Promise<boolean>;
}

export interface PdfcopyCheckApi {
	app: App;
	view: unknown;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkPdfcopy(api: PdfcopyCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const tick = () => new Promise((r) => window.requestAnimationFrame(() => r(null)));
	const v = api.view as MenuView;

	// ------------------------------------------------------------------------------------------------------ the view
	const calls: string[] = [];
	const sources: PdfCopySourceFn[] = [];
	let on = false;
	let updatedAt: number | null = null;
	const pad = (n: number) => String(n).padStart(2, "0");
	const port: PdfCopyPort = {
		saved: (path, source) => (calls.push(`saved ${path}`), void sources.push(source)),
		closing: (path) => void calls.push(`closing ${path}`),
		hidden: (path) => void calls.push(`hidden ${path}`),
		enabled: () => on,
		setEnabled: async (path, next) => {
			calls.push(`setEnabled ${path} ${next}`);
			on = next;
			if (next) updatedAt = new Date(2026, 10, 4, 14, 5).getTime();
		},
		status: () => (!on ? { kind: "off" } : updatedAt === null ? { kind: "waiting" } : { kind: "updated", at: updatedAt }),
		statusText: () => (!on ? "PDF copy is off" : updatedAt === null ? "PDF copy not created yet" : `PDF copy updated ${pad(new Date(updatedAt).getHours())}:${pad(new Date(updatedAt).getMinutes())}`),
	};
	v.host.pdfCopy = port;

	const menuTitles = (): string[] => {
		const menu = new Menu();
		v.onPaneMenu(menu, "tab-header");
		menu.showAtMouseEvent();
		return (window as unknown as { harnessMenu: { titles: string[] } }).harnessMenu.titles;
	};
	const run = (title: string): void => (window as unknown as { harnessMenu: { run(t: string): void } }).harnessMenu.run(title);

	let titles = menuTitles();
	add("the notebook menu offers Keep a PDF copy", titles.includes("Keep a PDF copy"), titles.join(" | "));
	add("with no status line while it is off", !titles.some((t) => t.startsWith("PDF copy")));
	run("Keep a PDF copy");
	await tick();
	add("a click turns it on for this notebook", calls.some((c) => c === `setEnabled ${v.file.path} true`), calls.join(" | "));
	titles = menuTitles();
	add("the status line then shows the time of the last update", titles.some((t) => /^PDF copy updated \d\d:\d\d$/.test(t)), titles.join(" | "));

	// A save that finishes tells the service; the source is the notebook as saved.
	const before = calls.filter((c) => c.startsWith("saved")).length;
	await api.penStroke([[0.3, 0.3], [0.5, 0.45], [0.6, 0.5]]);
	await v.flushNow();
	for (let i = 0; i < 30 && calls.filter((c) => c.startsWith("saved")).length === before; i++) await new Promise((r) => window.setTimeout(r, 100));
	add("a finished save tells the copy service", calls.filter((c) => c.startsWith("saved")).length > before, calls.join(" | "));
	const source = sources[sources.length - 1]?.() as { pages: unknown[]; unsaved(): boolean; stamp(): number; file: { path: string } } | null | undefined;
	add("the source is the saved notebook (all pages, nothing unsaved)", !!source && source.pages.length === v.document.pages.length && !source.unsaved() && source.file.path === v.file.path);
	const stamp = source?.stamp() ?? -1;
	await api.penStroke([[0.2, 0.6], [0.4, 0.7]]);
	add("an edit changes the stamp, so a build that began before it is thrown away", (source?.stamp() ?? -1) !== stamp, `${stamp} -> ${source?.stamp()}`);
	await v.flushNow();
	on = false;
	updatedAt = null;

	// ----------------------------------------------------------------------------------------------- the settings tab
	let saves = 0;
	const host = {
		app: api.app,
		settings: { ...DEFAULT_SETTINGS, pdfCopyNotebooks: {} },
		saveSettings: () => (saves++, Promise.resolve()),
		runGlobal: () => undefined,
	};
	const tab = new NotebookSettingTab(api.app as never, host as unknown as SettingsHost);
	const root = tab.containerEl;
	root.addClass("harness-settings");
	document.body.appendChild(root);
	const legacy: { display(): void } = tab;
	legacy.display();
	await tick();
	const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null && (el as HTMLElement).offsetHeight > 0;
	const row = (name: string): HTMLElement | null => [...root.querySelectorAll<HTMLElement>(".setting-item")].find((el) => el.querySelector(".setting-item-name")?.textContent === name) ?? null;
	const search = root.querySelector<HTMLInputElement>(".notebook-settings-search-pill input");
	if (search) {
		search.value = "pdf copy";
		search.dispatchEvent(new Event("input"));
		await tick();
	}
	add("the three rows are found by searching 'pdf copy'", visible(row("Keep a PDF copy of each notebook")) && visible(row("Update the PDF copy")) && visible(row("PDF copy folder")));
	add("the switch is off by default", !host.settings.pdfCopy);
	row("Keep a PDF copy of each notebook")?.querySelector<HTMLElement>(".checkbox-container")?.click();
	await tick();
	await tick();
	add("switching it on saves it", host.settings.pdfCopy === true && saves > 0, `saves ${saves}`);
	const when = row("Update the PDF copy")?.querySelector<HTMLSelectElement>("select");
	add("'when' offers automatic, after a quiet moment and on close", !!when && [...when.options].map((o) => o.value).join() === "auto,idle,close", when ? [...when.options].map((o) => o.value).join() : "none");
	if (when) {
		when.value = "close";
		when.dispatchEvent(new Event("change"));
		await tick();
		await tick();
	}
	add("choosing 'when I close the notebook' saves it", host.settings.pdfCopyWhen === "close", host.settings.pdfCopyWhen);
	const controls = [...root.querySelectorAll<HTMLElement>("select, input[type=text]")].filter((el) => visible(el) && el.closest(".setting-item"));
	add("nothing is wider than the screen", root.scrollWidth <= window.innerWidth + 1, `${root.scrollWidth} / ${window.innerWidth}`);
	add("the controls are at least 40 px high", controls.every((el) => el.getBoundingClientRect().height >= 40), controls.map((el) => Math.round(el.getBoundingClientRect().height)).join(","));

	// ------------------------------------------------------------------------------------------- the view closing
	// (Last: it ends the session.) The copy service is told, with the notebook as it was saved.
	const closeSession = (v as unknown as { closeSession(): Promise<void> }).closeSession.bind(v);
	await closeSession();
	add("closing the view tells the copy service", calls.some((c) => c === `closing ${v.file.path}`), calls.join(" | "));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}

export function pdfcopyApi(api: PdfcopyCheckApi): Record<string, unknown> {
	return {
		checkPdfcopy: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkPdfcopy(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`pdfcopy check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
	};
}
