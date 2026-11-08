/**
 * Smoke check of the suggested paper for a new page (0.25, roadmap #409) on the blank "New" notebook
 * (HARNESS_DOC=papersuggest npm run harness:check): the real view and strip. The pages' papers are set to patterns and the
 * "add-page-suggest" action must highlight the likeliest paper with its reason: a run ("Like the last 5 pages"), an
 * alternation, the course habit of the class in progress ("Usual for Analysis"), nothing for a mixed notebook, nothing when the
 * setting is off. Nothing is added until a chip is tapped, and tapping the suggestion makes a page with that paper in one undo
 * step. The run leaves the course suggestion on screen.
 */
import { setLectureCourseProvider } from "../../src/timetable/current";
import { COURSE_PAPER_KEY } from "../../src/model/paper-suggest";
import type { PaperKind } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PaperSuggestCheckApi {
	view: unknown;
	app: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}


interface Storage {
	saveLocalStorage(key: string, value: unknown): void;
}

export async function checkPapersuggest(api: PaperSuggestCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as HarnessView;
	const app = api.app as Storage;
	const flags = (v.host as unknown as { settings: { paperSuggest: boolean } }).settings;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const strip = (): HTMLElement | null => document.querySelector(".nb-smart-add");
	const marked = (): HTMLElement | null => document.querySelector(".nb-smart-add .nb-smart-suggested");
	const reason = (): string => marked()?.querySelector(".nb-smart-reason")?.textContent ?? "";
	const pages = (): number => v.document.pages.length;
	const open = async (): Promise<void> => {
		if (strip()) {
			v.runAction("add-page-suggest");
			await api.frames(2);
		}
		v.runAction("add-page-suggest");
		await api.frames(3);
	};
	const papers = (kinds: PaperKind[]): void => {
		while (pages() < kinds.length) v.addPage();
		kinds.forEach((k, i) => {
			const page = v.document.pages[i];
			if (page) page.paper.kind = k;
		});
		v.jumpToPage(kinds.length - 1);
	};

	flags.paperSuggest = true;
	setLectureCourseProvider(null);
	app.saveLocalStorage(COURSE_PAPER_KEY, null);

	// A run of grid pages.
	papers(["grid", "grid", "grid", "grid", "grid"]);
	await api.frames(2);
	const n0 = pages();
	await open();
	add("a run of the same paper highlights it first, with the reason", !!marked() && marked() === document.querySelector(".nb-smart-add .nb-chip") && reason() === "Like the last 5 pages", `reason "${reason()}"`);
	add("the strip adds nothing by itself", pages() === n0);
	add("the highlighted chip is still a normal 40 px button inside the view", (marked()?.offsetHeight ?? 0) >= 40 && (marked()?.getBoundingClientRect().right ?? 9999) <= window.innerWidth + 1);

	// Alternating papers: the next one is the paper of two pages back.
	papers(["ruled", "grid", "ruled", "grid"]);
	await open();
	const alt = marked();
	add("an alternation suggests the paper of two pages back", !!alt && /Ruled/i.test(alt.textContent ?? "") && /Alternating/.test(reason()), `chip "${alt?.textContent ?? ""}"`);
	const before = pages();
	alt?.click();
	await api.frames(2);
	add("tapping the suggestion adds one page with that paper", pages() === before + 1 && v.document.pages[4]?.paper.kind === "ruled", `kind ${v.document.pages[4]?.paper.kind}`);
	v.undo();
	add("one undo takes it away", pages() === before);

	// The course habit of the class in progress.
	setLectureCourseProvider(() => "Analysis");
	app.saveLocalStorage(COURSE_PAPER_KEY, { analysis: { at: 1, name: "Analysis", usage: { millimetre: 9, ruled: 1 } } });
	papers(["blank", "ruled", "dotted"]);
	await open();
	add("the class in progress suggests what it usually uses", !!marked() && reason() === "Usual for Analysis" && /Millimetre/i.test(marked()?.textContent ?? ""), `reason "${reason()}"`);

	// Off: nothing is highlighted and the strip is the one of 0.14.
	flags.paperSuggest = false;
	await open();
	add("with the setting off nothing is highlighted", !marked() && !!strip());
	flags.paperSuggest = true;

	// A mixed notebook has nothing to say.
	setLectureCourseProvider(null);
	papers(["blank", "ruled", "dotted"]);
	await open();
	add("a mixed notebook is not highlighted", !marked() && !!strip());

	// Leave the course suggestion on screen for the screenshot.
	setLectureCourseProvider(() => "Analysis");
	await open();
	add("the strip is open for the screenshot", !!marked());
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
