/**
 * 0.19 snapshot (roadmap 222): the version-history list with a lecture snapshot and the "Lecture snapshots" filter chip, on the
 * `doc=snapshot` scenario (npm run harness:check). Checked: the chip is a real toggle (aria-pressed follows, 32 px target at
 * least), a lecture row reads "Lecture <course> <date> <hh:mm>" with its mark while an ordinary row is just the date, nothing
 * overflows the screen. The panel is left on screen for the screenshot.
 */
import { createLectureFilter, renderSnapshotRow, type SnapshotLabelInput } from "../../src/view/history-ui";
import type { CheckResult } from "./reading-check";

export interface SnapshotCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkSnapshot(api: SnapshotCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const items: SnapshotLabelInput[] = [
		{ date: new Date(2026, 10, 4, 11, 0), lecture: true, course: "Linear Algebra", size: 184_000, pages: 42 },
		{ date: new Date(2026, 10, 3, 9, 0), lecture: false, course: null, size: 171_000, pages: 40 },
		{ date: new Date(2026, 10, 2, 14, 30), lecture: true, course: null, size: 160_000, pages: 38 },
		{ date: new Date(2026, 10, 1, 8, 15), lecture: false, course: null, size: 150_000, pages: 1 },
	];
	const host = document.body.createDiv({ cls: "harness-modal-container" });
	const panel = host.createDiv({ cls: "nb-ui", attr: { style: "background:var(--nb-bg-elevated);color:var(--nb-text);padding:12px;border-radius:12px;max-width:520px;margin:16px auto" } });
	const list = panel.createDiv();
	let only = false;
	const draw = (): void => {
		list.empty();
		for (const item of items) if (!only || item.lecture) renderSnapshotRow(list.createDiv({ attr: { style: "padding:8px 4px" } }), item);
	};
	panel.insertBefore(createLectureFilter((on) => { only = on; draw(); }), list);
	draw();

	const chip = panel.querySelector<HTMLButtonElement>(".nb-history-chip");
	add("the filter chip is there", !!chip, chip?.textContent ?? "");
	add("the chip is a touch target (at least 32 px)", !!chip && chip.getBoundingClientRect().height >= 32);
	add("all four rows show before the filter", list.children.length === 4);
	add("a lecture row reads Lecture <course> <date> <time> and has its mark", list.children[0]?.textContent?.startsWith("Lecture Linear Algebra 2026-11-04 11:00") === true && !!list.children[0]?.querySelector(".nb-history-icon svg"));
	add("a lecture row without a course falls back to the date", list.children[2]?.textContent?.startsWith("Lecture 2026-11-02 14:30") === true);
	add("an ordinary row is just the date, with no mark", list.children[1]?.textContent?.startsWith("2026-11-03 09:00") === true && !list.children[1]?.querySelector(".nb-history-icon"));
	chip?.click();
	add("the chip toggles on and keeps only the lecture snapshots", chip?.getAttribute("aria-pressed") === "true" && chip.classList.contains("is-active") && list.children.length === 2);
	const box = panel.getBoundingClientRect();
	add("the panel fits the screen", box.left >= 0 && box.right <= window.innerWidth + 1, `${Math.round(box.width)}px`);
	chip?.click();
	add("the chip toggles off and shows everything again", chip?.getAttribute("aria-pressed") === "false" && list.children.length === 4);
	chip?.click();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
