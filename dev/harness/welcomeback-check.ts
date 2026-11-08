/**
 * Smoke check of "Welcome back" (0.23, roadmap #420) on the `doc=welcomeback` notebook (the blank "New" notebook;
 * HARNESS_DOC=welcomeback npm run harness:check): the real view, card, rows and settings. A stored last-open time 20 hours
 * back and some markers make the card; its rows go to the stored place, the open questions and the gaps; the first stroke, the
 * close button and the settings take it away; a recent opening shows nothing; corrupt storage is survived.
 * `welcomebackShot` leaves the card showing for the screenshots.
 */
import { WELCOME_KEY } from "../../src/model/welcome-back";
import { createMarker } from "../../src/model/markers";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface WelcomebackCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface WelcomebackView extends HarnessView {
	welcomeBack: { offer(doc: HarnessView["document"]): void; visible: boolean };
	addPage(): void;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	app: { loadLocalStorage(key: string): unknown; saveLocalStorage(key: string, data: unknown): void };
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { welcomeBack: boolean; welcomeBackHours: number } };
}

const H = 3_600_000;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const card = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-welcome-back");
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".notebook-welcome-back-row"));

function seen(v: WelcomebackView, hoursAgo: number): void {
	v.app.saveLocalStorage(WELCOME_KEY, { [v.document.id]: Date.now() - hoursAgo * H });
}

/** The notebook with four pages, a stored place on page 3, three open questions, a resolved one and a gap; last open `hoursAgo` ago. */
async function prepare(api: WelcomebackCheckApi, hoursAgo = 20): Promise<WelcomebackView> {
	await api.open("welcomeback");
	const v = api.view as WelcomebackView;
	v.host.settings.welcomeBack = true;
	v.host.settings.welcomeBackHours = 8;
	v.applySettings(v.host.settings);
	while (v.document.pages.length < 4) v.addPage();
	await api.frames(3);
	const pages = v.document.pages;
	pages[1]!.elements = [createMarker("question", 80, 200, { text: "Why does the series converge?" }), { ...createMarker("question", 80, 100, { text: "Already answered" }), done: true }];
	pages[2]!.elements = [createMarker("question", 80, 300, { text: "Is the bound sharp?" }), createMarker("gap", 80, 500)];
	pages[3]!.elements = [createMarker("question", 80, 120, { text: "What is the third condition?" })];
	v.document.position = { page: pages[2]!.id, y: 0, at: new Date().toISOString() };
	v.scrollToPage(0, 0, false);
	await api.frames(3);
	seen(v, hoursAgo);
	v.welcomeBack.offer(v.document);
	await api.frames(3);
	return v;
}

export async function welcomebackShot(api: WelcomebackCheckApi): Promise<void> {
	await prepare(api);
}

export async function checkWelcomeback(api: WelcomebackCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const body = card()?.parentElement?.getBoundingClientRect();
		const r = card()?.getBoundingClientRect();
		add("the card is shown after 20 hours away", !!card() && !!r && r.width > 0, card()?.textContent ?? "none");
		add("it stays inside the page area", !!r && !!body && r.left >= body.left - 1 && r.right <= body.right + 1 && r.bottom <= body.bottom + 1);
		const labels = rows().map((x) => x.textContent ?? "");
		add("rows: the way back, two questions and the gap", rows().length === 4, labels.join(" | "));
		add("the first row is the stored place", (labels[0] ?? "").includes("page 3"), labels[0] ?? "");
		add("only open questions are listed (resolved ones are not)", !labels.some((l) => l.includes("Already answered")));
		add("the rest is said as text, not as a fake control", document.querySelector(".notebook-welcome-back-more")?.tagName === "DIV");
		const pages = v.document.pages.length;
		const strokes = v.document.pages.reduce((n, p) => n + p.strokes.length, 0);
		const stored = (v.app.loadLocalStorage(WELCOME_KEY) as Record<string, number> | null)?.[v.document.id] ?? 0;
		add("this opening is remembered", Math.abs(Date.now() - stored) < 5000);

		// A question row goes to its page and takes the card away.
		const question = rows().find((x) => x.classList.contains("notebook-welcome-back-question"));
		question?.click();
		await sleep(150);
		await api.frames(3);
		add("a question row goes to its page", v.currentPage() === 1, `page ${v.currentPage() + 1}`);
		add("the card is gone after a row is taken", !card());
		add("the notebook was not changed", v.document.pages.length === pages && v.document.pages.reduce((n, p) => n + p.strokes.length, 0) === strokes);

		// The resume row.
		v.scrollToPage(0, 0, false);
		await api.frames(2);
		seen(v, 20);
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		rows()[0]?.click();
		await sleep(150);
		await api.frames(3);
		add("the way-back row lands on the stored page", v.currentPage() === 2, `page ${v.currentPage() + 1}`);

		// Just opened again: nothing (and the time is now).
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		add("a quick reopening shows no card", !card());

		// First stroke.
		seen(v, 20);
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		add("the card is back for another long absence", !!card());
		await api.penStroke([[0.3, 0.7], [0.5, 0.74], [0.7, 0.7]]);
		await sleep(120);
		add("the first stroke takes the card away", !card());

		// Close button.
		seen(v, 20);
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		document.querySelector<HTMLElement>(".notebook-welcome-back-close")?.click();
		await api.frames(2);
		add("the close button hides it", !card());

		// Settings.
		seen(v, 20);
		v.host.settings.welcomeBackHours = 24;
		v.applySettings(v.host.settings);
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		add("a longer threshold waits (20 h < 24 h)", !card());
		v.host.settings.welcomeBackHours = 8;
		v.host.settings.welcomeBack = false;
		v.applySettings(v.host.settings);
		seen(v, 20);
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		add("with the setting off there is no card", !card());
		v.host.settings.welcomeBack = true;
		v.applySettings(v.host.settings);

		// Corrupt storage.
		v.app.saveLocalStorage(WELCOME_KEY, "garbage");
		v.welcomeBack.offer(v.document);
		await api.frames(2);
		add("corrupt storage shows nothing and does not fail", !card());
		add("and is replaced by a valid value", typeof (v.app.loadLocalStorage(WELCOME_KEY) as Record<string, number> | null)?.[v.document.id] === "number");
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
