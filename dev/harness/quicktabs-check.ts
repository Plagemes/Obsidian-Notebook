/**
 * Smoke check of the quick tabs (0.18, roadmap #227) on the `doc=quicktabs` notebook (the outline notebook, five pages;
 * npm run harness:check): the real view with the real strip and an in-memory `_meta` folder. A page is pinned from the
 * registry (the page sheet / command), the strip shows a tab per pin with "p. N" or the bookmark title, a tap jumps, "Back"
 * returns, a pin of a page that is gone or of another notebook is drawn and handled, a tab is reordered and unpinned, the
 * strip collapses, and the notebook itself is never changed. It leaves the strip with four tabs and the Back button for the
 * screenshot (dev/harness/dist/shots/quicktabs-*.png).
 */
import type { App, TFile } from "obsidian";
import { QuickTabsStore } from "../../src/library/quicktabs-store";
import type { DeviceFileAdapter } from "../../src/storage/device-files";
import { QuickTabsService } from "../../src/view/quick-tabs-service";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface QuickTabsCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

const adapter = new MemoryAdapter();
const opened: Array<{ path: string; page: number; pageId: string }> = [];
let service: QuickTabsService | null = null;
const store = new QuickTabsStore(adapter, () => "Notebooks", "0a000000");

/** The service the harness gives the view when `doc=quicktabs` (in-memory files, a recorded opener for other notebooks). */
export function harnessQuickTabs(app: unknown): QuickTabsService {
	service ??= new QuickTabsService({
		app: app as App,
		store,
		readNotebook: () => Promise.resolve(null),
		notebooksFolder: () => "Notebooks",
		openAt: (file: TFile, page: number, pageId: string) => {
			opened.push({ path: file.path, page, pageId });
			return Promise.resolve();
		},
	});
	return service;
}

interface QuickView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	quickApi(): { jump(i: number): void; docId(): string | null };
	uiContext(): { page?: { quickTab?: boolean } | null };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function checkQuicktabs(api: QuickTabsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as QuickView;
	const svc = service!;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const strip = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-qt");
	const shown = (el: Element | null): boolean => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).offsetWidth > 0;
	const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".nb-qt .nb-qt-tab")];
	const texts = (): string[] => tabs().map((t) => t.querySelector(".nb-qt-label")?.textContent ?? "");
	const goTo = async (i: number) => {
		v.quickApi().jump(i);
		await frames(4);
		await sleep(60);
	};
	const settle = async () => {
		await frames(3);
		await sleep(80);
		await frames(2);
	};
	const docText = (): string => JSON.stringify(v.document);
	const before = docText();
	const scope = v.quickApi().docId()!;

	// --- nothing pinned: no strip ---
	add("no strip while nothing is pinned", !shown(strip()));
	add("the page sheet has the quick tab action, not checked", v.uiContext().page?.quickTab === false);

	// --- pin three pages from the registry ---
	await goTo(1);
	v.runAction("page-quick-tab");
	await settle();
	add("pinning shows the strip with a tab", shown(strip()) && tabs().length === 1, texts().join("|"));
	add("the tab says p. 2 and is the current one", texts()[0] === "p. 2" && tabs()[0]!.classList.contains("is-current"), texts().join("|"));
	add("the page sheet knows the page is a quick tab", v.uiContext().page?.quickTab === true);
	v.runAction("page-quick-tab");
	await settle();
	add("the same action again unpins", !shown(strip()) && svc.tabs(scope).length === 0);
	await goTo(1);
	v.runAction("page-quick-tab");
	await goTo(3);
	v.runAction("page-quick-tab");
	await goTo(4);
	v.runAction("page-quick-tab");
	await settle();
	add("three tabs in the order they were pinned", texts().join("|") === "p. 2|p. 4|p. 5", texts().join("|"));
	add("the tab of the page in view is marked and selected", tabs()[2]!.classList.contains("is-current") && tabs()[2]!.getAttribute("aria-selected") === "true");
	add("tabs are real controls: role, label, a touch-sized target", tabs().every((t) => t.getAttribute("role") === "tab" && !!t.getAttribute("aria-label") && t.getBoundingClientRect().height >= 29), `${tabs()[0]?.getBoundingClientRect().height}`);

	// --- tap jumps; Back returns ---
	await goTo(0);
	tabs()[1]!.click();
	await settle();
	add("a tap on a tab shows its page", v.currentPage() === 3, `page ${v.currentPage() + 1}`);
	const back = document.querySelector<HTMLButtonElement>(".nb-qt .nb-qt-back");
	add("Back appears after the jump", !!back && shown(back), back?.textContent ?? "missing");
	back?.click();
	await settle();
	add("Back returns to where the reader was", v.currentPage() === 0, `page ${v.currentPage() + 1}`);
	add("Back is gone once used", !document.querySelector(".nb-qt .nb-qt-back"));

	// --- a page that is gone, and a page of another notebook ---
	const noticesBefore = api.notices.length;
	await store.pin({ scope, path: "Notebooks/Outline.notebook", pageId: "gone-page", num: 2, label: "" });
	await store.pin({ scope, path: "Notebooks/New.notebook", pageId: "formulas-1", num: 1, label: "Formulas" });
	await settle();
	add("five tabs", tabs().length === 5, texts().join("|"));
	const gone = tabs().find((t) => t.classList.contains("is-gone"));
	const other = tabs().find((t) => t.classList.contains("is-other"));
	add("a tab whose page is gone is drawn dashed and still says p. N", !!gone && gone.querySelector(".nb-qt-label")?.textContent === "p. 2", gone?.className ?? "missing");
	add("a tab of another notebook shows its label and an icon", !!other && other.querySelector(".nb-qt-label")?.textContent === "Formulas" && !!other.querySelector(".nb-qt-tab-icon"), other?.className ?? "missing");
	await goTo(2);
	gone?.click();
	await settle();
	add("tapping it says the page is gone and shows the nearest page", api.notices.length > noticesBefore && /no longer/.test(api.notices.at(-1) ?? "") && v.currentPage() === 1, `${api.notices.at(-1)} / page ${v.currentPage() + 1}`);
	other?.click();
	await settle();
	add("tapping a tab of another notebook opens that notebook at the page", opened.length === 1 && opened[0]!.path === "Notebooks/New.notebook" && opened[0]!.pageId === "formulas-1", JSON.stringify(opened));
	add("the reader can go Back from there", !!document.querySelector(".nb-qt .nb-qt-back"));

	// --- reorder and unpin ---
	const ids = (): string[] => svc.tabs(scope).map((t) => t.pageId);
	const first = ids()[0]!;
	svc.move(scope, svc.tabs(scope)[0]!.id, 2);
	await settle();
	add("a tab moves to another place", ids()[2] === first && ids().length === 5, ids().join(","));
	add("the strip follows the new order", texts().length === 5);
	svc.unpin(svc.tabs(scope).find((t) => t.pageId === "gone-page")!.id);
	await settle();
	add("a tab is unpinned", ids().length === 4 && !ids().includes("gone-page"));

	// --- collapse ---
	const toggle = document.querySelector<HTMLButtonElement>(".nb-qt .nb-qt-toggle");
	toggle?.click();
	await settle();
	add("collapsed: the tabs are hidden and the count shows", tabs().length === 0 && document.querySelector(".nb-qt .nb-qt-count")?.textContent === "4", document.querySelector(".nb-qt")?.className ?? "");
	add("collapsed: Back is still there", !!document.querySelector(".nb-qt .nb-qt-back"));
	document.querySelector<HTMLButtonElement>(".nb-qt .nb-qt-toggle")?.click();
	await settle();
	add("expanded again", tabs().length === 4);

	// --- the pins are in _meta, never in the notebook ---
	add("the notebook was not changed by any of it", docText() === before);
	const file = [...adapter.files.entries()].find(([p]) => p.endsWith("/_meta/quicktabs-0a000000.json"));
	add("the pins are in this device's _meta file", !!file && file[1].includes('"format":"obsidian-notebook-quicktabs"'), file?.[0] ?? "no file");
	add("no script errors", api.errors.length === 0, api.errors.join("; "));

	// leave a state for the screenshot: the strip with its tabs and the Back button
	await goTo(0);
	tabs()[1]?.click();
	await settle();
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { tabs: texts() } };
}
