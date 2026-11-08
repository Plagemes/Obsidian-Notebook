/**
 * Smoke check of two-way page references (0.22, roadmap #179) on the `doc=pagerefs` notebook (the blank "New" notebook): the real
 * view, chip, list and setting. Page 1 and page 3 link to page 4 (by id), page 2 links to a page that is gone and page 4 links to
 * itself. With page 4 in view the chip names pages 1 and 3 (not 2, not itself); its list jumps to them; the setting turns the chip
 * off; a page nobody links to has no chip. `pagerefsShot` leaves the view on page 4 (list open or not) for the screenshots. The text
 * boxes are put into the live document directly: the check is about showing, not about the edit path.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";
import type { PageElement } from "../../src/model/types";

export interface PagerefsCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PagerefsView extends HarnessView {
	pageRefs: { shown: readonly { index: number }[]; listOpen: boolean; openList(): void; closeList(): void; sync(): void; reset(): void };
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { pageRefs: boolean } };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const chip = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-page-refs");
const list = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-page-refs-list");

const text = (id: string, t: string): PageElement => ({ id, type: "text", x: 60, y: 120, width: 420, text: t, fontSize: 22, color: "#1e1e1e" });

async function prepare(api: PagerefsCheckApi): Promise<PagerefsView> {
	await api.open("pagerefs");
	const v = api.view as PagerefsView;
	v.host.settings.pageRefs = true;
	await api.frames(4);
	while (v.document.pages.length < 4) v.addPage();
	await api.frames(3);
	const pages = v.document.pages;
	const to4 = `[[New.notebook#p4&id=${pages[3]!.id}|see page 4]]`;
	pages[0]!.elements = [text("pr-a", `Intro, then ${to4}`)];
	pages[1]!.elements = [text("pr-b", "[[New.notebook#p9&id=gone-page]] points nowhere")];
	pages[2]!.elements = [text("pr-c", `${to4} and again ${to4}`)];
	pages[3]!.elements = [text("pr-d", `[[New.notebook#p4&id=${pages[3]!.id}]] itself`)];
	v.scrollToPage(3);
	await sleep(500);
	await api.frames(3);
	return v;
}

/** On page 4 with the chip, and with the list open for `list`. */
export async function pagerefsShot(api: PagerefsCheckApi, state: "chip" | "list"): Promise<void> {
	const v = await prepare(api);
	if (state === "list") {
		v.pageRefs.openList();
		await api.frames(3);
	}
}

export async function checkPagerefs(api: PagerefsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const c = chip();
		const shown = JSON.stringify(v.pageRefs.shown.map((r) => r.index));
		add("page 4 shows the chip", !!c && c.offsetWidth > 0, c?.textContent ?? "none");
		add("it names pages 1 and 3 only", shown === "[0,2]", shown);
		add("the label lists the pages", (c?.textContent ?? "").includes("p. 1, p. 3"), c?.textContent ?? "");
		const rect = c?.getBoundingClientRect();
		const body = c?.parentElement?.getBoundingClientRect();
		add("the chip is small and at the top", !!rect && !!body && rect.height <= 44 && rect.top - body.top < 90 && rect.width < body.width * 0.7);

		c?.click();
		await api.frames(2);
		const l = list();
		add("tapping the chip opens the list", !!l && v.pageRefs.listOpen);
		add("the list has one row per referencing page", l?.querySelectorAll(".notebook-page-refs-row").length === 2);
		add("a page that links twice says so", (l?.textContent ?? "").includes("2 links"), l?.textContent ?? "");
		const lr = l?.getBoundingClientRect();
		add("the list stays inside the view", !!lr && !!body && lr.left >= body.left && lr.right <= body.right && lr.bottom <= body.bottom);

		const before = JSON.stringify(v.document.pages.map((p) => p.elements));
		l?.querySelectorAll<HTMLButtonElement>(".notebook-page-refs-row")[1]?.click();
		await sleep(400);
		await api.frames(3);
		add("a row jumps to that page", v.currentPage() === 2, `page ${v.currentPage() + 1}`);
		add("the list closed after the jump", !list());
		add("page 3 is linked by nobody: no chip", !chip());
		add("the notebook was not changed", JSON.stringify(v.document.pages.map((p) => p.elements)) === before);

		v.scrollToPage(1);
		await sleep(450);
		add("a page whose only inbound link is dead has no chip", !chip());

		v.scrollToPage(3);
		await sleep(450);
		add("back on page 4 the chip returns", !!chip());
		v.host.settings.pageRefs = false;
		v.applySettings(v.host.settings);
		await sleep(450);
		add("with the setting off there is no chip", !chip());
		v.host.settings.pageRefs = true;
		v.applySettings(v.host.settings);
		await sleep(450);
		add("with the setting on again the chip is back", !!chip());
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
