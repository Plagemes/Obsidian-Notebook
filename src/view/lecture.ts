import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { AddPage } from "../model/history";
import type { EditContext } from "./edit-context";
import { suggestedClass, suggestedCourse } from "../timetable/current";
import type { LectureClass } from "../timetable/lecture-mode";
import { applyCourseTag } from "../timetable/page-tag";
import {
	buildLecturePage, cleanTitle, defaultLectureTitle, isoDate, lectureDetailsText, parseIsoDate, type LectureContext, type SlideRef,
} from "./lecture-logic";
import { showNotice } from "./notice";

export interface LectureAnswer {
	title: string;
	date: Date;
}

/** Small dialog for "New lecture": course or title (the notebook name by default) and date (today by default). */
class LectureModal extends Modal {
	private title: string;
	private dateText: string;
	private done = false;

	private previewEl: HTMLElement | null = null;

	constructor(
		app: App,
		defaultTitle: string,
		private readonly finish: (answer: LectureAnswer | null) => void,
		/** 0.14 (#438): the text the page will also carry for this title and date (shown under the fields); "" for nothing. */
		private readonly preview?: (title: string, date: Date | null) => string,
	) {
		super(app);
		this.title = defaultTitle;
		this.dateText = isoDate(new Date());
	}

	onOpen(): void {
		this.setTitle(t("lecture.title"));
		let dateEl: HTMLInputElement | null = null;
		new Setting(this.contentEl)
			.setName(t("lecture.course"))
			.setDesc(t("lecture.course.desc"))
			.addText((text) => {
				text.setValue(this.title).onChange((v) => {
					this.title = v;
					this.showPreview();
				});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						this.submit();
					}
				});
				window.setTimeout(() => {
					text.inputEl.focus();
					text.inputEl.select();
				}, 0);
			});
		new Setting(this.contentEl)
			.setName(t("lecture.date"))
			.addText((text) => {
				text.inputEl.type = "date";
				dateEl = text.inputEl;
				text.setValue(this.dateText).onChange((v) => {
					this.dateText = v;
					this.showPreview();
				});
			});
		if (this.preview) this.previewEl = this.contentEl.createDiv({ cls: "setting-item-description notebook-lecture-preview" });
		this.showPreview();
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("lecture.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("lecture.create")).setCta().onClick(() => {
				if (!parseIsoDate(this.dateText)) {
					showNotice(t("lecture.badDate"));
					dateEl?.focus();
					return;
				}
				this.submit();
			}));
	}

	private showPreview(): void {
		if (!this.previewEl || !this.preview) return;
		const text = this.preview(cleanTitle(this.title), parseIsoDate(this.dateText));
		this.previewEl.setText(text ? t("lecture.prefill", { text: text.split("\n").join(" · ") }) : "");
		this.previewEl.toggleClass("notebook-hidden", !text);
	}

	private submit(): void {
		const date = parseIsoDate(this.dateText);
		if (!date) {
			showNotice(t("lecture.badDate"));
			return;
		}
		this.done = true;
		this.finish({ title: cleanTitle(this.title), date });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.finish(null);
	}
}

export function askLecture(app: App, defaultTitle: string, preview?: (title: string, date: Date | null) => string): Promise<LectureAnswer | null> {
	return new Promise((resolve) => new LectureModal(app, defaultTitle, resolve, preview).open());
}

/**
 * What a class of the timetable adds to its lecture page (0.14, #438): the time slot, room and lecturer, and the slide or
 * PDF the notebook follows when one is open beside the notes or is the page's background.
 */
export function classContext(cls: LectureClass | null, slide: SlideRef | null): LectureContext {
	const out: LectureContext = {};
	if (cls) {
		out.start = cls.start;
		out.end = cls.end;
		if (cls.room) out.room = cls.room;
		if (cls.lecturer) out.lecturer = cls.lecturer;
	}
	if (slide) out.slide = slide;
	return out;
}

/**
 * Adds a lecture page (header: course and date, then the details of `context`: slot, room, lecturer, slides) at the end of
 * the notebook as one undo step. The course also tags the page when it is known from the timetable. The view goes to the new
 * page unless `scroll` is false (a page added while the user is writing elsewhere must not move the page under the pen).
 */
export function addLecturePage(ctx: EditContext, title: string, date: Date, course?: string, context?: LectureContext, scroll = true): void {
	const pages = ctx.doc.pages;
	let page = buildLecturePage(pages[pages.length - 1], title, date, context);
	if (course) page = applyCourseTag(page, course);
	ctx.execute(new AddPage(page, pages.length), scroll ? pages.length : undefined);
}

/**
 * "New lecture": asks for the course/title and the date, then adds a page at the end of the notebook with that header
 * as a text box (one undo step). The model has no page titles, so the header is ordinary text: it is searchable in the
 * library and exported with the page. The course defaults to the class in progress in the timetable, else the notebook name.
 * 0.14 (#438): when the course and the date are those of the class in progress, the page also carries its time slot, room
 * and lecturer; the slide or PDF beside the notes is added whenever there is one. The dialog shows what will be added.
 */
export async function runNewLecture(ctx: EditContext): Promise<void> {
	const cls = suggestedClass(ctx.file?.path);
	const fromTimetable = cls?.course ?? suggestedCourse(ctx.file?.path);
	const slide = ctx.slide?.() ?? null;
	const contextFor = (title: string, date: Date | null): LectureContext => {
		const sameClass = !!cls && !!date && title === cls.course && isoDate(date) === isoDate(new Date());
		return classContext(sameClass ? cls : null, slide);
	};
	const answer = await askLecture(ctx.app, fromTimetable ?? defaultLectureTitle(ctx.file?.path), (title, date) => lectureDetailsText(contextFor(title, date)));
	if (!answer || !ctx.alive()) return;
	addLecturePage(ctx, answer.title, answer.date, fromTimetable && answer.title ? answer.title : undefined, contextFor(answer.title, answer.date));
	showNotice(t("lecture.done"));
}
