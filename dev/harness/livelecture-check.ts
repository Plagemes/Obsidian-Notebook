/**
 * Check of the live lecture bar (0.28, roadmap #132) on the `doc=livelecture` notebook (the blank "New" notebook with the lecture
 * stub; HARNESS_DOC=livelecture npm run harness:check): the bar appears with the lecture mode and shows the elapsed time; "New page"
 * adds a page after the current one; "Important moment" stamps a bookmark ("★ mm:ss") on the current page, twice on one page joins the
 * stamps; the end-of-lecture panel lists them and a row jumps to its page; the bar folds; the setting hides it. The final state
 * (bar open, a mark made) is left for the screenshot (dist/shots/livelecture-<theme>-<device>.png).
 */
import { classNow, lectureStub } from "./lecture-check";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface LiveLectureCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface LiveView extends Omit<HarnessView, "markerTools"> {
	lectureMode: { on: boolean; toggle(): void };
	markerTools: { openPanel(): void } | null;
	currentPageIndex(): number;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	applySettings(s: unknown): void;
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { liveBar: boolean } };
}

export async function checkLivelecture(api: LiveLectureCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		lectureStub.cls = classNow("Analysis 1");
		await api.open("livelecture");
		const v = api.view as LiveView;
		const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
		const bar = () => q<HTMLElement>(".notebook-live-bar");
		const click = async (sel: string) => {
			q<HTMLElement>(sel)?.click();
			await api.frames(3);
		};
		add("no bar before the lecture", !bar());
		v.lectureMode.toggle();
		await api.frames(4);
		add("the bar shows with the lecture mode", !!bar() && bar()!.getBoundingClientRect().width > 0);
		const time = q<HTMLElement>(".notebook-live-time")?.textContent ?? "";
		add("it shows the elapsed time (the class began 30 minutes ago)", /^(29|30|31):\d\d$/.test(time), time);
		const body = q<HTMLElement>(".notebook-body")!.getBoundingClientRect();
		const r = bar()!.getBoundingClientRect();
		add("the bar stays inside the page area", r.left >= body.left - 1 && r.right <= body.right + 1 && r.top >= body.top - 1 && r.bottom <= body.bottom + 1);
		const chip = q<HTMLElement>(".notebook-lecture-chip")?.getBoundingClientRect();
		add("it does not overlap the lecture chip", !chip || r.top >= chip.bottom - 0.5 || r.left >= chip.right - 0.5 || r.right <= chip.left + 0.5);
		for (const b of Array.from(document.querySelectorAll<HTMLElement>(".notebook-live-btn"))) {
			const br = b.getBoundingClientRect();
			add(`button "${b.getAttribute("aria-label") ?? ""}" is reachable`, br.width >= 32 && br.height >= 32, `${Math.round(br.width)}x${Math.round(br.height)}`);
		}

		const pages = v.document.pages.length;
		const at = v.currentPageIndex();
		await click(".notebook-live-actions .notebook-live-btn:nth-child(1)");
		add("New page adds a page after the current one", v.document.pages.length === pages + 1 && v.currentPageIndex() === at + 1, `${pages} -> ${v.document.pages.length}`);

		const pageId = v.document.pages[v.currentPageIndex()]!.id;
		await click(".notebook-live-actions .notebook-live-btn:nth-child(2)");
		const meta = () => v.document.meta;
		const title = () => meta()?.bookmarkInfo?.[pageId]?.title ?? "";
		add("Important moment bookmarks the current page", !!meta()?.bookmarks.includes(pageId));
		add("the bookmark carries the stamp", /^★ \d\d:\d\d$/.test(title()), title());
		await click(".notebook-live-actions .notebook-live-btn:nth-child(2)");
		add("a second moment on the page joins the stamps (or keeps one when in the same second)", /^★ \d\d:\d\d( · ★ \d\d:\d\d)?$/.test(title()), title());

		v.markerTools?.openPanel();
		await api.frames(3);
		const rows = Array.from(document.querySelectorAll<HTMLElement>(".notebook-live-moment"));
		add("the end-of-lecture panel lists the moments", rows.length >= 1 && /★/.test(rows[0]!.textContent ?? ""), rows.map((x) => x.textContent).join(" | "));
		v.scrollToPage(0, 0, false);
		await api.frames(3);
		rows[0]?.click();
		await api.frames(6);
		add("tapping a moment jumps to its page", v.currentPageIndex() === v.document.pages.findIndex((p) => p.id === pageId), String(v.currentPageIndex()));

		await click(".notebook-live-fold");
		add("the bar folds to the timer", bar()!.classList.contains("is-folded") && getComputedStyle(q<HTMLElement>(".notebook-live-actions")!).display === "none");
		await click(".notebook-live-fold");
		add("and opens again", !bar()!.classList.contains("is-folded"));

		const s = v.host.settings;
		s.liveBar = false;
		v.applySettings(s);
		await api.frames(3);
		add("the setting hides the bar", !bar());
		s.liveBar = true;
		v.applySettings(s);
		await api.frames(3);
		add("and shows it again", !!bar());
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
