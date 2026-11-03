/**
 * Smoke check of automatic lecture mode (roadmap 401) and of the prefilled lecture page (438) on the `doc=lecture`
 * notebook (npm run harness:check): the real view, banner, chip, contextual bar and edit context, driven by a stand-in for
 * the timetable service (`lectureStub`) and a clock the check moves. Ask mode, automatic mode, "not now", the pen holding
 * the mode back, the class ending, the manual switch and what the new page carries.
 */

import { writing } from "../../src/ink/writing-guard";
import type { LectureClass } from "../../src/timetable/lecture-mode";
import type { TextElement } from "../../src/model/types";
import type { HarnessUiContext, HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

/** What the harness view's host answers to "which class is on for this notebook". */
export const lectureStub: { cls: LectureClass | null } = { cls: null };

export interface LectureCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	/** Opens the `doc=lecture` notebook again (a fresh view). */
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

type Mode = "off" | "ask" | "auto";

interface LectureView extends HarnessView {
	lectureMode: {
		on: boolean;
		asked: boolean;
		course: string | null;
		evaluate(): void;
		toggle(): void;
		opened(): void;
		closed(): void;
		host: { now?: () => Date };
	};
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { lectureMode: Mode } };
	uiContext(): HarnessUiContext & { lecture: boolean };
}

const MIN = 60_000;

/** A class that began 30 minutes ago and ends in 60, at "today's" times. */
export function classNow(course = "Analysis 1", over: Partial<LectureClass> = {}): LectureClass {
	const now = Date.now();
	const hhmm = (ms: number) => {
		const d = new Date(ms);
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	};
	return {
		key: `lecture-harness@${new Date(now).toDateString()}`, course, room: "B2", lecturer: "Prof. Rossi",
		start: hhmm(now - 30 * MIN), end: hhmm(now + 60 * MIN), startsAt: now - 30 * MIN, endsAt: now + 60 * MIN, ...over,
	};
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function viewOf(api: LectureCheckApi): LectureView {
	return api.view as LectureView;
}

const banner = (): HTMLElement | null => document.querySelector(".notebook-lecture-banner");
const chip = (): HTMLElement | null => document.querySelector(".notebook-lecture-chip");
const buttons = (el: Element | null): HTMLButtonElement[] => [...(el?.querySelectorAll("button") ?? [])];
const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

async function fresh(api: LectureCheckApi, mode: Mode, cls: LectureClass | null): Promise<LectureView> {
	lectureStub.cls = cls;
	await api.open("lecture");
	const v = viewOf(api);
	v.host.settings.lectureMode = mode;
	return v;
}

/** The text boxes of the last page of the notebook. */
function lastPageTexts(v: LectureView): string[] {
	const pages = v.document.pages;
	return (pages[pages.length - 1]?.elements ?? []).filter((e): e is TextElement => e.type === "text").map((e) => e.text);
}

/** A state for the review screenshots: `ask` (the banner), `on` (the chip, the lecture bar, the new page). */
export async function lectureShot(api: LectureCheckApi, state: "ask" | "on" | "plain"): Promise<void> {
	if (state === "ask") {
		const v = await fresh(api, "ask", classNow());
		v.lectureMode.opened();
		await api.frames(4);
	} else if (state === "on") {
		const v = await fresh(api, "auto", classNow());
		v.lectureMode.opened();
		await api.frames(6);
		v.scrollToPage(v.document.pages.length - 1);
		await api.frames(6);
	} else {
		const v = await fresh(api, "off", null);
		v.lectureMode.toggle();
		await api.frames(4);
	}
}

export async function checkLecture(api: LectureCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const noticeCount = (re: RegExp): number => api.notices.filter((n) => re.test(n)).length;

	// --- no class: nothing is shown, the lecture tools are not on ---
	let v = await fresh(api, "ask", null);
	v.lectureMode.opened();
	await api.frames(2);
	add("no class: no banner and no chip", !banner() && !chip());
	add("no class: the contextual bar is not in lecture mode", v.uiContext().lecture === false);

	// --- ask mode ---
	const pagesBefore = v.document.pages.length;
	v = await fresh(api, "ask", classNow());
	v.lectureMode.opened();
	await api.frames(3);
	add("ask: a banner offers lecture mode and names the course", visible(banner()) && (banner()?.textContent ?? "").includes("Analysis 1") && (banner()?.textContent ?? "").includes("B2"), banner()?.textContent ?? "no banner");
	add("ask: two buttons, Start and Not now", buttons(banner()).map((b) => b.textContent).join("|") === "Start|Not now", buttons(banner()).map((b) => b.textContent).join("|"));
	add("ask: the icon square is not a button", !banner()?.querySelector("button .notebook-lecture-icon") && !!banner()?.querySelector(".notebook-lecture-icon svg"));
	add("ask: nothing is on and no page was added before the answer", v.uiContext().lecture === false && v.document.pages.length === pagesBefore);
	buttons(banner())[1]?.click();
	await api.frames(2);
	add("ask: Not now closes the banner", !banner());
	v.lectureMode.evaluate();
	await api.frames(1);
	add("ask: and it does not come back for that class", !banner() && !v.uiContext().lecture);

	// --- Start: lecture mode, the lecture page, the chip ---
	v = await fresh(api, "ask", classNow());
	v.lectureMode.opened();
	await api.frames(3);
	const before = v.document.pages.length;
	buttons(banner())[0]?.click();
	await api.frames(4);
	add("start: the banner is replaced by the chip", !banner() && visible(chip()), chip()?.textContent ?? "no chip");
	add("start: the chip names the course and the end time", (chip()?.textContent ?? "").includes("Analysis 1") && /until \d\d:\d\d/.test(chip()?.textContent ?? ""), chip()?.textContent ?? "");
	add("start: the lecture tools are on in the contextual bar", v.uiContext().lecture === true && v.lectureMode.on);
	add("start: one lecture page was added", v.document.pages.length === before + 1, `${before} -> ${v.document.pages.length}`);
	const texts = lastPageTexts(v);
	add("page: header with the course and the date", /^Analysis 1 \u2014 \d{4}-\d\d-\d\d$/.test(texts[0] ?? ""), texts[0] ?? "none");
	add("page: second box with the time slot, the room and the lecturer", /^\d\d:\d\d\u2013\d\d:\d\d \u00b7 B2 \u00b7 Prof\. Rossi$/.test(texts[1] ?? ""), texts[1] ?? "none");
	add("page: tagged with the course", (v.document.pages[v.document.pages.length - 1]?.tags ?? []).length > 0, JSON.stringify(v.document.pages[v.document.pages.length - 1]?.tags));
	v.lectureMode.evaluate();
	v.lectureMode.evaluate();
	await api.frames(2);
	add("start: the page is added once, however often the clock is looked at", v.document.pages.length === before + 1, String(v.document.pages.length));
	const end = chip()?.querySelector<HTMLButtonElement>("button");
	end?.click();
	await api.frames(2);
	add("end: the chip's button leaves lecture mode", !chip() && !v.lectureMode.on && v.uiContext().lecture === false);
	v.lectureMode.evaluate();
	await api.frames(1);
	add("end: and the rule does not start it again (ask mode)", !v.lectureMode.on && !banner());
	v.lectureMode.toggle();
	await api.frames(2);
	add("manual: the command switches it on again for the class", v.lectureMode.on && visible(chip()));
	v.lectureMode.toggle();
	await api.frames(2);
	add("manual: and off", !v.lectureMode.on && !chip());

	// --- automatic mode, the pen, the end of the class ---
	v = await fresh(api, "auto", classNow());
	writing.penDown(901);
	v.lectureMode.opened();
	await api.frames(3);
	add("auto: nothing starts while the pen is on the screen", !v.lectureMode.on && !chip() && !banner());
	writing.penUp(901);
	await sleep(1700);
	v.lectureMode.evaluate();
	await api.frames(3);
	add("auto: it starts at the first pause, without asking", v.lectureMode.on && visible(chip()) && !banner() && v.uiContext().lecture);
	add("auto: and says so inside the app", noticeCount(/Lecture mode: Analysis 1/) >= 1, api.notices.slice(-3).join(" | "));
	add("auto: its lecture page is there", /^Analysis 1 \u2014 /.test(lastPageTexts(v)[0] ?? ""));
	const pages = v.document.pages.length;

	// The class ends: the clock goes past its end. The pen is down first: the mode stays; after the pause it goes.
	const over = new Date(Date.now() + 61 * MIN);
	v.lectureMode.host.now = () => over;
	lectureStub.cls = null;
	writing.penDown(902);
	v.lectureMode.evaluate();
	await api.frames(2);
	add("end of class: lecture mode does not drop under the pen", v.lectureMode.on && visible(chip()));
	writing.penUp(902);
	await sleep(1700);
	v.lectureMode.evaluate();
	await api.frames(3);
	add("end of class: it ends at the first pause", !v.lectureMode.on && !chip() && v.uiContext().lecture === false);
	add("end of class: and says so inside the app", noticeCount(/Analysis 1 is over/) >= 1, api.notices.slice(-3).join(" | "));
	add("end of class: the pages are untouched", v.document.pages.length === pages);

	// --- off: the rule never acts; the command still works with no class ---
	v = await fresh(api, "off", classNow());
	v.lectureMode.opened();
	await api.frames(3);
	add("off: no banner and no mode, even with a class in progress", !banner() && !chip() && !v.lectureMode.on);
	lectureStub.cls = null;
	v.lectureMode.toggle();
	await api.frames(2);
	add("off: the command still switches it on, without a class", v.lectureMode.on && visible(chip()) && v.uiContext().lecture);
	add("off: the chip has no course to name", !(chip()?.textContent ?? "").includes("until"), chip()?.textContent ?? "");
	v.lectureMode.toggle();
	await api.frames(2);
	add("off: and off again", !v.lectureMode.on && !chip());

	// --- the setting turned off while the rule's mode is on ends it ---
	v = await fresh(api, "auto", classNow());
	v.lectureMode.opened();
	await api.frames(3);
	add("setting: automatic mode is on", v.lectureMode.on);
	v.host.settings.lectureMode = "off";
	v.lectureMode.evaluate();
	await sleep(1700);
	v.lectureMode.evaluate();
	await api.frames(2);
	add("setting: turning it off ends the mode the rule started", !v.lectureMode.on && !chip());

	// --- a class for another notebook, and the new page by hand ---
	lectureStub.cls = null;
	v = await fresh(api, "ask", null);
	v.lectureMode.opened();
	await api.frames(2);
	add("another notebook's class: nothing here", !banner() && !chip());
	const ctx = v.editContext();
	add("the view hands out an edit context with the slide hook", !!ctx && typeof ctx.slide === "function");
	add("no slides follow: the slide is null", (ctx.slide?.() ?? null) === null);

	lectureStub.cls = null;
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}
