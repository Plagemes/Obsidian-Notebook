/**
 * Version-history list pieces (0.19, roadmap 222): the label of a snapshot, its row and the "Lecture snapshots" filter chip.
 * Kept apart from the modal so they can be drawn on their own (the harness does) and have no vault access.
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { formatBytes, formatSnapshotDate } from "../storage/history";
import { lectureLabelParts } from "../storage/lecture-snapshot";

export interface SnapshotLabelInput {
	date: Date;
	/** Taken automatically at the end of a lecture. */
	lecture: boolean;
	/** Course recorded for a lecture snapshot, or null. */
	course: string | null;
	/** File size in bytes. */
	size: number;
	/** Page count, null when the snapshot does not parse, undefined when it was not read (the list does not parse every copy). */
	pages?: number | null;
}

/** The date, or for a lecture snapshot "Lecture <course> <date> <hh:mm>". */
export function snapshotTitle(item: SnapshotLabelInput): string {
	if (!item.lecture) return formatSnapshotDate(item.date);
	const { date, time } = lectureLabelParts(item.date);
	return item.course ? t("history.lectureLabel", { course: item.course, date, time }) : t("history.lectureLabel.plain", { date, time });
}

export function snapshotLabel(item: SnapshotLabelInput): string {
	const base = `${snapshotTitle(item)} · ${formatBytes(item.size)}`;
	if (item.pages === undefined) return base;
	const pages = item.pages === null ? t("history.unreadable") : item.pages === 1 ? t("history.pages.one") : t("history.pages.other", { count: String(item.pages) });
	return `${base} · ${pages}`;
}

/** One row of the list; a lecture snapshot gets the graduation-cap mark. */
export function renderSnapshotRow(el: HTMLElement, item: SnapshotLabelInput): void {
	const row = el.createDiv({ cls: item.lecture ? "nb-ui nb-history-row is-lecture" : "nb-ui nb-history-row" });
	if (item.lecture) setIcon(row.createSpan({ cls: "nb-history-icon", attr: { "aria-hidden": "true" } }), "graduation-cap");
	row.createSpan({ text: snapshotLabel(item) });
}

/** The "Lecture snapshots" toggle chip; `onChange` gets the new state. */
export function createLectureFilter(onChange: (on: boolean) => void): HTMLElement {
	const bar = createDiv({ cls: "nb-ui nb-history-filter" });
	const chip = bar.createEl("button", {
		text: t("history.filter.lecture"), cls: "nb-history-chip", attr: { type: "button", "aria-pressed": "false", title: t("history.filter.lecture.hint") },
	});
	let on = false;
	chip.addEventListener("click", () => {
		on = !on;
		chip.toggleClass("is-active", on);
		chip.setAttribute("aria-pressed", String(on));
		onChange(on);
	});
	return bar;
}
