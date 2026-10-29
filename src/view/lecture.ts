import { Modal, Notice, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { AddPage } from "../model/history";
import type { EditContext } from "./edit-context";
import { buildLecturePage, cleanTitle, defaultLectureTitle, isoDate, parseIsoDate } from "./lecture-logic";

export interface LectureAnswer {
	title: string;
	date: Date;
}

/** Small dialog for "New lecture": course or title (the notebook name by default) and date (today by default). */
class LectureModal extends Modal {
	private title: string;
	private dateText: string;
	private done = false;

	constructor(app: App, defaultTitle: string, private readonly finish: (answer: LectureAnswer | null) => void) {
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
				text.setValue(this.title).onChange((v) => (this.title = v));
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
				text.setValue(this.dateText).onChange((v) => (this.dateText = v));
			});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("lecture.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("lecture.create")).setCta().onClick(() => {
				if (!parseIsoDate(this.dateText)) {
					new Notice(t("lecture.badDate"));
					dateEl?.focus();
					return;
				}
				this.submit();
			}));
	}

	private submit(): void {
		const date = parseIsoDate(this.dateText);
		if (!date) {
			new Notice(t("lecture.badDate"));
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

export function askLecture(app: App, defaultTitle: string): Promise<LectureAnswer | null> {
	return new Promise((resolve) => new LectureModal(app, defaultTitle, resolve).open());
}

/**
 * "New lecture": asks for the course/title and the date, then adds a page at the end of the notebook with that header
 * as a text box (one undo step). The model has no page titles, so the header is ordinary text: it is searchable in the
 * library and exported with the page.
 */
export async function runNewLecture(ctx: EditContext): Promise<void> {
	const answer = await askLecture(ctx.app, defaultLectureTitle(ctx.file?.path));
	if (!answer || !ctx.alive()) return;
	const pages = ctx.doc.pages;
	const page = buildLecturePage(pages[pages.length - 1], answer.title, answer.date);
	ctx.execute(new AddPage(page, pages.length), pages.length);
	new Notice(t("lecture.done"));
}
