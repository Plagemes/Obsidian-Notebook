/**
 * Smoke check of the automatic lecture header (0.22, roadmap #210) on the `doc=lecthead` notebook (the blank "New" notebook;
 * HARNESS_DOC=lecthead npm run harness:check): the real view, chip, command and History. A stand-in for the timetable answers
 * "which class is on" (`lectureStub`). New page in a class: the chip, the header in an empty spot as a group, one undo step; the
 * automatic mode; ink at the top (no overlap); a locked page; the command; the setting off.
 * `lectheadShot` leaves the page with the chip, or with the header, for the screenshots.
 */
import { createStroke } from "../../src/model/document";
import { AddStroke } from "../../src/model/history";
import { freezeStroke } from "../../src/model/serialize";
import type { TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import { classNow, lectureStub } from "./lecture-check";
import type { CheckResult } from "./reading-check";

export interface LectheadCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

type Mode = "off" | "ask" | "auto";

interface LectheadView extends HarnessView {
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { lectureHeader: Mode } };
	undo(): void;
	addPage(): void;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	runAction(id: string): void;
	commandApplies(id: string): boolean;
	currentPageIndex(): number;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const chip = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-lecture-header-offer");
const texts = (v: LectheadView, page: number): TextElement[] => (v.document.pages[page]?.elements ?? []).filter((e): e is TextElement => e.type === "text");

async function fresh(api: LectheadCheckApi, mode: Mode, withClass = true): Promise<LectheadView> {
	lectureStub.cls = withClass ? classNow("Analysis 1") : null;
	await api.open("lecthead");
	const v = api.view as LectheadView;
	v.host.settings.lectureHeader = mode;
	await api.frames(3);
	await sleep(50);
	return v;
}

export async function lectheadShot(api: LectheadCheckApi, state: "chip" | "header"): Promise<void> {
	const v = await fresh(api, state === "chip" ? "ask" : "auto");
	v.addPage();
	await sleep(250);
	await api.frames(4);
	v.scrollToPage(v.document.pages.length - 1, 0, false);
	await api.frames(4);
}

export async function checkLecthead(api: LectheadCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		// Ask: a new page in a class shows the chip; tapping it writes the header.
		let v = await fresh(api, "ask");
		v.addPage();
		await sleep(200);
		await api.frames(3);
		add("a new page during a class offers the chip", !!chip() && chip()!.offsetWidth > 0, chip()?.textContent ?? "none");
		const last = v.document.pages.length - 1;
		add("the chip changes nothing by itself", texts(v, last).length === 0);
		chip()?.querySelector<HTMLButtonElement>(".notebook-lecture-header-add")?.click();
		await api.frames(3);
		const els = texts(v, last);
		add("tapping the chip writes the course and the details", els.length === 2 && els[0]!.text === "Analysis 1" && els[1]!.text.includes("Prof. Rossi"), els.map((e) => e.text).join(" | "));
		add("they are one group at the top margin", els.length === 2 && !!els[0]!.group && els[0]!.group === els[1]!.group && els[0]!.y <= 40, `y=${els[0]?.y}`);
		add("the chip is gone", !chip());
		v.undo();
		await api.frames(2);
		add("one undo removes the whole header", texts(v, last).length === 0);

		// Closing the chip settles the page.
		v = await fresh(api, "ask");
		v.addPage();
		await sleep(200);
		chip()?.querySelector<HTMLButtonElement>(".notebook-lecture-header-close")?.click();
		await api.frames(2);
		add("closing the chip hides it and writes nothing", !chip() && texts(v, v.document.pages.length - 1).length === 0);

		// Automatic.
		v = await fresh(api, "auto");
		v.addPage();
		await sleep(300);
		await api.frames(3);
		add("automatic: the header is written on the new page", texts(v, v.document.pages.length - 1).length === 2, `${texts(v, v.document.pages.length - 1).length} boxes`);
		add("automatic: no chip is left", !chip());

		// Off.
		v = await fresh(api, "off");
		v.addPage();
		await sleep(250);
		add("off: nothing happens on a new page", !chip() && texts(v, v.document.pages.length - 1).length === 0);

		// No class.
		v = await fresh(api, "ask", false);
		v.addPage();
		await sleep(250);
		add("no class on: nothing is offered", !chip());

		// The command: ink at the top is never covered.
		v = await fresh(api, "off");
		const cur = v.currentPageIndex();
		const page = v.document.pages[cur]!;
		v.history.execute(new AddStroke(page.id, freezeStroke(createStroke("#1e1e1e", 2, [[40, 30, 0.5], [300, 50, 0.5], [500, 40, 0.5]])), 0));
		await api.frames(2);
		await sleep(150);
		const inkBefore = page.strokes.length;
		v.runAction("lecture-header");
		await api.frames(3);
		const page0 = texts(v, cur);
		const stroke = page.strokes[0]!;
		const maxInkY = Math.max(...stroke.points.map((p) => p[1]));
		add("the command writes the header below the ink, never over it", page0.length === 2 && page0.every((e) => e.y > maxInkY - 1), `ink to y=${Math.round(maxInkY)}, header at ${page0.map((e) => Math.round(e.y)).join(",")}, page ${cur}, notice ${api.notices.slice(-1)[0] ?? "-"}`);
		add("the ink is untouched", page.strokes.length === inkBefore);
		v.runAction("lecture-header");
		await api.frames(2);
		add("a second command does not add it twice", texts(v, cur).length === 2);
		add("the command applies", v.commandApplies("lecture-header"));

		// A locked page refuses.
		v = await fresh(api, "off");
		const before = texts(v, v.currentPageIndex()).length;
		v.runAction("page-lock");
		await api.frames(2);
		v.runAction("lecture-header");
		await api.frames(2);
		add("a locked page gets no header and says so", texts(v, v.currentPageIndex()).length === before && api.notices.some((n) => /locked/i.test(n)), api.notices.slice(-1)[0] ?? "");
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
