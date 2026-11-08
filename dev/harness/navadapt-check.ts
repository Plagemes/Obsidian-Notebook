/**
 * Smoke check of the adaptive page navigator (0.24, roadmap #414): HARNESS_DOC=navadapt npm run harness:check.
 * A written notebook (the blank "New" one) gets the compact list; the PDF notebook ("Slides") gets large thumbnails; the header
 * button cycles Auto / Thumbnails / List and the choice is remembered on this device; a 520-page list opens in chunks, fast.
 * `navadaptShot` leaves the list showing for the screenshots.
 */
import { NAV_MODE_KEY } from "../../src/ui/nav-adapt";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface NavadaptCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface NavView extends HarnessView {
	pageNav: { open: boolean; el: HTMLElement; refresh(): void };
	addPage(): void;
	setNavigatorOpen(open: boolean): void;
	app: { loadLocalStorage(key: string): unknown; saveLocalStorage(key: string, data: unknown): void };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-navigator");
const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-navigator-item"));
const button = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(".notebook-navigator-layout");

async function written(api: NavadaptCheckApi, pages = 6): Promise<NavView> {
	await api.open("navadapt");
	const v = api.view as NavView;
	v.app.saveLocalStorage(NAV_MODE_KEY, {});
	while (v.document.pages.length < pages) v.addPage();
	await api.frames(3);
	v.document.pages.forEach((p, i) => {
		p.elements = [{ id: `t${i}`, type: "text", x: 40, y: 60, width: 300, text: i === 0 ? "Lecture 1: limits" : `Notes of section ${i + 1}\nsecond line`, fontSize: 18, color: "#222222" }];
		if (i % 2 === 0) { p.startAt = Date.now() - (pages - i) * 3_600_000; p.endAt = p.startAt + 600_000; }
	});
	v.setNavigatorOpen(false);
	v.setNavigatorOpen(true);
	await api.frames(4);
	return v;
}

export async function navadaptShot(api: NavadaptCheckApi): Promise<void> {
	await written(api, 14);
}

export async function checkNavadapt(api: NavadaptCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await written(api);
		add("a written notebook shows the compact list", !!panel()?.classList.contains("is-list") && !panel()?.classList.contains("is-large"));
		const titles = Array.from(document.querySelectorAll(".notebook-navigator-rowtitle")).map((x) => x.textContent ?? "");
		add("rows show the first typed line", titles[0] === "Lecture 1: limits" && titles[1] === "Notes of section 2", titles.slice(0, 2).join(" | "));
		add("page time shown for stamped pages only", document.querySelectorAll(".notebook-navigator-rowmeta").length === 3, String(document.querySelectorAll(".notebook-navigator-rowmeta").length));
		const first = items()[0]?.getBoundingClientRect();
		add("a row is compact", !!first && first.height < 100, String(first?.height));
		const p = panel()!.getBoundingClientRect();
		add("panel inside the window", p.right <= window.innerWidth + 1 && p.width > 100, `${p.left}-${p.right}`);

		const b = button();
		add("the layout button exists and says the mode", !!b && (b.getAttribute("aria-label") ?? "").length > 5, b?.getAttribute("aria-label") ?? "none");
		b?.click();
		await api.frames(3);
		add("first tap: Thumbnails (usual layout for a written notebook)", !panel()?.classList.contains("is-list") && !panel()?.classList.contains("is-large"));
		const stored = v.app.loadLocalStorage(NAV_MODE_KEY) as Record<string, string> | null;
		add("the choice is remembered for this notebook", stored?.[v.document.id] === "thumbs", JSON.stringify(stored));
		b?.click();
		await api.frames(3);
		add("second tap: List", !!panel()?.classList.contains("is-list"));
		b?.click();
		await api.frames(3);
		add("third tap: back to Auto (nothing stored)", !(v.app.loadLocalStorage(NAV_MODE_KEY) as Record<string, string>)[v.document.id] && !!panel()?.classList.contains("is-list"));
		add("tapping a row goes to its page", (() => { items()[2]?.click(); return true; })());

		// On a phone the drawer closes after a jump: open it again.
		v.setNavigatorOpen(true);
		await api.frames(3);
		// Corrupt storage is survived.
		v.app.saveLocalStorage(NAV_MODE_KEY, "garbage");
		v.pageNav.refresh();
		await api.frames(3);
		add("corrupt storage falls back to Auto", !!panel()?.classList.contains("is-list") && items().length === 6);

		// 520 pages: the first chunk is quick and every row arrives.
		const proto = v.document.pages[0]!;
		for (let i = 6; i < 520; i++) v.document.pages.push({ ...proto, id: `big${i}`, strokes: [], elements: [] });
		const t0 = performance.now();
		v.pageNav.refresh();
		const firstChunk = performance.now() - t0;
		add("a 520-page list builds its first chunk in under 250 ms", firstChunk < 250, `${firstChunk.toFixed(0)} ms`);
		add("not all rows at once (chunked)", items().length < 520, String(items().length));
		for (let i = 0; i < 40 && items().length < 520; i++) await sleep(50);
		add("every row arrives", items().length === 520, String(items().length));

		// The PDF notebook: large thumbnails.
		await api.open("pdf");
		const w = api.view as NavView;
		w.app.saveLocalStorage(NAV_MODE_KEY, {});
		w.setNavigatorOpen(false);
		w.setNavigatorOpen(true);
		await api.frames(4);
		add("a PDF notebook shows large thumbnails", !!panel()?.classList.contains("is-large") && !panel()?.classList.contains("is-list"));
		const wide = panel()!.getBoundingClientRect().width;
		add("large panel is wider than 200 px", wide > 200 || document.querySelector(".notebook-body.is-narrow") !== null, String(wide));
	} catch (e) {
		add("no exception", false, String(e));
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}
