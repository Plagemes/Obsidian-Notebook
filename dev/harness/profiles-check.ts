/**
 * Smoke check of the writing profiles (0.25, roadmap #219) on the `doc=profiles` notebook (the blank "New" notebook;
 * HARNESS_DOC=profiles npm run harness:check): the real view. The chip on the pen options starts with "No profile"; Lecture sets the
 * smoothing, the paper of new notebooks and the strip, Study does the same with its own values, a command (the action registry)
 * switches too, a profile saved from the current state comes back with one tap and can be deleted, the lecture setting switches to
 * Lecture when a class starts, and through all of it the notebook document is byte for byte what it was. It leaves the pen options
 * open on the Study profile for the screenshot.
 */
import type { NotebookSettings } from "../../src/settings";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ProfilesCheckApi {
	view: unknown;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ProfilesView extends HarnessView {
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & NotebookSettings };
	applyWritingProfile(id: string, quiet?: boolean): void;
	profileHost(): { saveAs(name: string): boolean; remove(id: string): void; active(): { id: string } | null };
	profileForLecture(): void;
	activePenSet(): { id: string; pens: Array<{ kind?: string }> } | null;
}

export async function checkProfiles(api: ProfilesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as ProfilesView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const s = v.host.settings;
	const chip = () => document.querySelector<HTMLElement>(".notebook-profile-chip");
	const chipText = () => chip()?.querySelector(".notebook-penset-label")?.textContent ?? "";
	const docJson = () => JSON.stringify(v.document);
	const before = docJson();

	s.stabilization = 2;
	s.defaultPaper = "grid";
	s.writingProfileActive = "";
	await api.openOptions("pen");
	await frames(3);
	add("the profile chip is on the pen options", !!chip());
	add("it says no profile at first", chipText() === "No profile", chipText());
	add("it is an explained control (long-press help)", chip()?.dataset.help === "help.profileChip");

	v.applyWritingProfile("lecture", true);
	await frames(3);
	add("Lecture: light smoothing and ruled paper for new notebooks", s.stabilization === 1 && (s.defaultPaper as string) === "ruled" && s.writingProfileActive === "lecture", `${s.stabilization} ${s.defaultPaper}`);
	add("the chip shows Lecture", chipText() === "Lecture", chipText());
	add("the strip is the Lecture set", v.activePenSet()?.id === "wp-lecture");

	v.applyWritingProfile("study", true);
	await frames(3);
	add("Study: strong smoothing, grid paper, fountain pens", s.stabilization === 6 && s.defaultPaper === "grid" && v.activePenSet()?.pens[0]?.kind === "fountain", `${s.stabilization} ${s.defaultPaper}`);
	add("the chip shows Study", chipText() === "Study", chipText());

	v.runAction("profile-lecture");
	await frames(3);
	add("the command switches to Lecture", s.writingProfileActive === "lecture" && chipText() === "Lecture");
	v.runAction("profile-next");
	await frames(3);
	add("the next-profile command goes on to Study", s.writingProfileActive === "study" && chipText() === "Study");

	v.applyWritingProfile("study", true);
	s.stabilization = 9; // the user moves the slider by hand: the chip stops claiming the profile
	await frames(2);
	add("a changed slider means no profile is claimed", v.profileHost().active() === null);

	s.stabilization = 3;
	s.defaultPaper = "dotted";
	const saved = v.profileHost().saveAs("My class");
	await frames(2);
	add("the current setup is saved as a custom profile", saved && s.writingProfiles.length === 1 && s.writingProfiles[0]!.name === "My class" && /^profile-[0-9a-z]{8}$/.test(s.writingProfileActive));
	const mineId = s.writingProfileActive;
	v.applyWritingProfile("lecture", true);
	v.applyWritingProfile(mineId, true);
	await frames(3);
	add("one tap brings the custom profile back", s.stabilization === 3 && s.defaultPaper === "dotted" && chipText() === "My class", chipText());

	s.writingProfileOnLecture = false;
	v.applyWritingProfile("study", true);
	v.profileForLecture();
	add("lecture start leaves the profile alone when the setting is off", s.writingProfileActive === "study");
	s.writingProfileOnLecture = true;
	v.profileForLecture();
	await frames(2);
	add("lecture start switches to Lecture when the setting is on", s.writingProfileActive === "lecture");
	s.writingProfileOnLecture = false;

	const setCount = s.penSets.length;
	add("the profile made its own pen set when it was applied", s.penSets.some((x) => x.id === `wp-${mineId}`));
	v.profileHost().remove(mineId);
	add("a custom profile can be deleted, and its own pen set goes with it", s.writingProfiles.length === 0 && !s.penSets.some((x) => x.id === `wp-${mineId}`) && s.penSets.length === setCount - 1);

	add("the notebook document was never touched", docJson() === before);

	v.applyWritingProfile("study", true);
	await api.openOptions("pen");
	await frames(4);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { stabilization: s.stabilization, paper: s.defaultPaper } };
}
