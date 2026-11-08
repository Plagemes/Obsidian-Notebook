/**
 * Smoke check of "Back to the current slide" (0.21, roadmap #225) on the `doc=slideback` notebook (the blank "New" notebook with
 * the lecture stub; npm run harness:check): the real view, pill, command and setting. Writing during the lecture mode makes a
 * place to come back to; scrolling a screen or more away shows the pill after the scroll settles, a small scroll does not,
 * the pill returns to the written page and goes away, it can be closed, and the setting turns it off. `slidebackShot`
 * leaves the view scrolled away with the pill showing for the screenshots.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SlidebackCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface SlidebackView extends HarnessView {
	lectureMode: { on: boolean; toggle(): void };
	slideBack: { visible: boolean; available: boolean; goBack(): boolean };
	commandApplies(id: string): boolean;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	viewSize: { width: number; height: number };
	setViewport(v: HarnessView["viewport"], interactive?: boolean): void;
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { slideBack: boolean } };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const pill = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-slide-back");

async function prepare(api: SlidebackCheckApi): Promise<SlidebackView> {
	await api.open("slideback");
	const v = api.view as SlidebackView;
	v.host.settings.slideBack = true;
	v.lectureMode.toggle();
	await api.frames(4);
	for (let i = 0; i < 3; i++) v.addPage();
	await api.frames(3);
	v.scrollToPage(0);
	await api.frames(3);
	await api.penStroke([[0.2, 0.3], [0.5, 0.34], [0.7, 0.3]]);
	await sleep(120);
	return v;
}

/** `away`: scrolled to the last page with the pill showing. */
export async function slidebackShot(api: SlidebackCheckApi, state: "away"): Promise<void> {
	const v = await prepare(api);
	if (state === "away") {
		v.scrollToPage(3);
		await sleep(500);
		await api.frames(4);
	}
}

export async function checkSlideback(api: SlidebackCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const strokes = v.document.pages[0]!.strokes.length;
		add("writing in the lecture mode leaves a place to go back to", v.slideBack.available && strokes > 0);
		add("at the written place there is no pill", !pill());

		// A small scroll does not show it.
		const vp = v.viewport;
		v.setViewport({ ...vp, offsetY: vp.offsetY - v.viewSize.height * 0.1 }, false);
		await sleep(450);
		add("a small scroll does not show the pill", !pill());

		// Far away: after the scroll settles it shows, with the slide-less label.
		v.scrollToPage(3);
		await api.frames(2);
		add("no pill while the view is still moving", !pill());
		await sleep(500);
		const p = pill();
		add("scrolled a few pages away: the pill is shown", !!p && p.offsetWidth > 0, p?.textContent ?? "none");
		add("the label names the current page", (p?.textContent ?? "").includes("Back to current page"), p?.textContent ?? "");
		add("the command applies", v.commandApplies("slide-back"));
		const rect = p?.getBoundingClientRect();
		const body = p?.parentElement?.getBoundingClientRect();
		// The recent-symbols strip (0.21) is also centred at the top: the pill sits just below it, never over it.
		const strip = p?.parentElement?.querySelector<HTMLElement>(".notebook-symbol-strip:not(.notebook-hidden)");
		const stripRect = strip?.getBoundingClientRect();
		add("the pill is small and sits at the top, off the writing area", !!rect && !!body && rect.height <= 48 && rect.top - body.top < (stripRect ? 110 : 40) && rect.width < body.width);
		add("the pill does not overlap the symbols strip", !rect || !stripRect || rect.top >= stripRect.bottom - 1, stripRect && rect ? `strip bottom ${Math.round(stripRect.bottom)}, pill top ${Math.round(rect.top)}` : "no strip");

		// Back.
		p?.querySelector<HTMLButtonElement>(".notebook-slide-back-go")?.click();
		await sleep(120);
		await api.frames(3);
		add("the pill goes back to the written page", v.currentPage() === 0, `page ${v.currentPage() + 1}`);
		add("the pill is gone once back", !pill());
		add("the notebook was not changed by going back", v.document.pages[0]!.strokes.length === strokes && v.document.pages.length === 4);

		// Close.
		v.scrollToPage(3);
		await sleep(600);
		add("the pill comes back when away again", !!pill());
		pill()?.querySelector<HTMLButtonElement>(".notebook-slide-back-close")?.click();
		await api.frames(2);
		add("closing hides it", !pill());
		v.scrollToPage(2);
		await sleep(500);
		add("closed stays closed while away", !pill());
		v.scrollToPage(0);
		await sleep(500);
		v.scrollToPage(3);
		await sleep(500);
		add("after going back to the place it can show again", !!pill());

		// The command.
		add("the command goes back", v.slideBack.goBack());
		await api.frames(3);
		add("the command lands on the written page", v.currentPage() === 0 && !pill());

		// The setting.
		v.host.settings.slideBack = false;
		v.applySettings(v.host.settings);
		v.scrollToPage(3);
		await sleep(500);
		add("with the setting off there is no pill", !pill());
		add("with the setting off the command does not apply", !v.commandApplies("slide-back"));
		v.host.settings.slideBack = true;
		v.applySettings(v.host.settings);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
