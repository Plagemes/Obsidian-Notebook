import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { HEADER_MODES, type HeaderMode, type LectureSetup } from "../library/lecture-pack";
import { PAPER_KINDS, type PaperKind } from "../model/types";
import { parseLayoutOptions, SLIDE_LAYOUTS, type LayoutOptions, type SlideLayout } from "../model/lecture-pack";
import { cleanTitle, isoDate, parseIsoDate } from "./lecture-logic";
import { showNotice } from "./notice";

/** Device-local storage key (Obsidian's per-vault local storage) for the last layout chosen. */
const STORAGE_KEY = "notebook-lecture-layout";

/** The layout chosen last time on this device (the defaults the first time, or when the stored value is unusable). */
export function loadLayoutOptions(app: App): LayoutOptions {
	try {
		return parseLayoutOptions(app.loadLocalStorage(STORAGE_KEY));
	} catch {
		return parseLayoutOptions(null);
	}
}

function saveLayoutOptions(app: App, options: LayoutOptions): void {
	try {
		app.saveLocalStorage(STORAGE_KEY, options);
	} catch {
		// Local storage can be unavailable; the choice is then just not remembered.
	}
}

/** Layout, notes paper and "notes page after every slide" for `state`, which the controls update in place. */
function addLayoutSettings(el: HTMLElement, state: LayoutOptions): void {
	let notesPaperEl: HTMLSelectElement | null = null;
	let afterPaperEl: HTMLSelectElement | null = null;
	const sync = () => {
		if (notesPaperEl) notesPaperEl.disabled = state.layout === "slide";
		if (afterPaperEl) afterPaperEl.disabled = !state.notesPageAfter;
	};
	new Setting(el)
		.setName(t("lecturePack.layout"))
		.setDesc(t("lecturePack.layout.desc"))
		.addDropdown((dd) => {
			for (const layout of SLIDE_LAYOUTS) dd.addOption(layout, t(`lecturePack.layout.${layout}`));
			dd.setValue(state.layout).onChange((v) => {
				state.layout = v as SlideLayout;
				sync();
			});
		});
	new Setting(el)
		.setName(t("lecturePack.notesPaper"))
		.addDropdown((dd) => {
			for (const kind of PAPER_KINDS) dd.addOption(kind, t(`paper.${kind}`));
			notesPaperEl = dd.selectEl;
			dd.setValue(state.notesPaper).onChange((v) => (state.notesPaper = v as LayoutOptions["notesPaper"]));
		});
	new Setting(el)
		.setName(t("lecturePack.notesPageAfter"))
		.setDesc(t("lecturePack.notesPageAfter.desc"))
		.addToggle((tg) => tg.setValue(state.notesPageAfter).onChange((v) => {
			state.notesPageAfter = v;
			sync();
		}));
	new Setting(el)
		.setName(t("lecturePack.afterPaper"))
		.addDropdown((dd) => {
			for (const kind of PAPER_KINDS) dd.addOption(kind, t(`paper.${kind}`));
			afterPaperEl = dd.selectEl;
			dd.setValue(state.afterPaper).onChange((v) => (state.afterPaper = v as LayoutOptions["afterPaper"]));
		});
	sync();
}

/** Layout questions for "Insert PDF" in an open notebook. Resolves null when cancelled. */
export function askLayoutOptions(app: App): Promise<LayoutOptions | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		const state = loadLayoutOptions(app);
		let settled = false;
		const finish = (value: LayoutOptions | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		modal.setTitle(t("lecturePack.insertTitle"));
		addLayoutSettings(modal.contentEl, state);
		const submit = () => {
			saveLayoutOptions(app, state);
			finish({ ...state });
			modal.close();
		};
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText(t("lecture.cancel")).onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(t("lecturePack.apply")).setCta().onClick(submit));
		modal.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		modal.onClose = () => {
			finish(null);
			modal.contentEl.empty();
		};
		modal.open();
	});
}

/** Everything "New lecture from slides…" asks after the PDF is chosen. Resolves null when cancelled. */
export function askLectureSetup(app: App, defaultTitle: string): Promise<LectureSetup | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		const layout = loadLayoutOptions(app);
		let title = defaultTitle;
		let dateText = isoDate(new Date());
		let header: HeaderMode = "page";
		let settled = false;
		const finish = (value: LectureSetup | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		modal.setTitle(t("lecturePack.title"));
		let dateEl: HTMLInputElement | null = null;
		new Setting(modal.contentEl)
			.setName(t("lecture.course"))
			.setDesc(t("lecture.course.desc"))
			.addText((text) => text.setValue(title).onChange((v) => (title = v)));
		new Setting(modal.contentEl)
			.setName(t("lecture.date"))
			.addText((text) => {
				text.inputEl.type = "date";
				dateEl = text.inputEl;
				text.setValue(dateText).onChange((v) => (dateText = v));
			});
		new Setting(modal.contentEl)
			.setName(t("lecturePack.header"))
			.addDropdown((dd) => {
				for (const mode of HEADER_MODES) dd.addOption(mode, t(`lecturePack.header.${mode}`));
				dd.setValue(header).onChange((v) => (header = v as HeaderMode));
			});
		addLayoutSettings(modal.contentEl, layout);
		const submit = () => {
			const date = parseIsoDate(dateText);
			if (!date) {
				showNotice(t("lecture.badDate"));
				dateEl?.focus();
				return;
			}
			saveLayoutOptions(app, layout);
			finish({ title: cleanTitle(title), date, header, layout: { ...layout } });
			modal.close();
		};
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText(t("lecture.cancel")).onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(t("lecturePack.create")).setCta().onClick(submit));
		modal.onClose = () => {
			finish(null);
			modal.contentEl.empty();
		};
		modal.open();
	});
}

/** Paper of the "Exercise page here" action: the paper chosen for notes pages, remembered like the layout. */
export function loadExercisePaper(app: App): PaperKind {
	return loadLayoutOptions(app).afterPaper;
}

/** Asks for the paper of exercise pages (and of notes pages after each slide, which share the choice). */
export function askExercisePaper(app: App): Promise<PaperKind | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		const options = loadLayoutOptions(app);
		let settled = false;
		const finish = (value: PaperKind | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		modal.setTitle(t("exercise.paperTitle"));
		new Setting(modal.contentEl).setName(t("exercise.paper")).addDropdown((dd) => {
			for (const kind of PAPER_KINDS) dd.addOption(kind, t(`paper.${kind}`));
			dd.setValue(options.afterPaper).onChange((v) => (options.afterPaper = v as PaperKind));
		});
		const submit = () => {
			saveLayoutOptions(app, options);
			finish(options.afterPaper);
			modal.close();
		};
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText(t("lecture.cancel")).onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(t("lecturePack.apply")).setCta().onClick(submit));
		modal.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		modal.onClose = () => {
			finish(null);
			modal.contentEl.empty();
		};
		modal.open();
	});
}
