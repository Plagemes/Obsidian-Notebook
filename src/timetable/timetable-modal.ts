import { getLanguage, Modal, Notice, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import {
	entryProblem, findOverlaps, isValidDay, newEntry, WEEK_PATTERNS, type ClassEntry, type Timetable, type WeekPattern,
} from "./schedule";
import type { TimetableStore } from "./store";

export interface TimetableModalOptions {
	store: TimetableStore;
	timetable: Timetable;
	/** Why the file cannot be read, when it cannot: nothing is editable then until the user chooses to start over. */
	loadError: string | null;
	/** The file's text when the editor opened (null: no file). A save refuses to overwrite a file that differs from it. */
	base: string | null;
	/** Suggestions for the linked notebook or folder. */
	choices: string[];
	saved(timetable: Timetable): void;
}

const clone = (tt: Timetable): Timetable => JSON.parse(JSON.stringify(tt)) as Timetable;

/** Weekday names in the app language, Monday first. */
function dayNames(): string[] {
	const lang = getLanguage();
	return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(lang, { weekday: "long" }));
}

/** Editor of the weekly timetable: one card per class. Nothing is written until Save. */
export class TimetableModal extends Modal {
	private draft: Timetable;
	private replaceUnreadable = false;
	private listEl!: HTMLElement;
	private readonly warnings = new Map<string, HTMLElement>();

	constructor(app: App, private readonly opts: TimetableModalOptions) {
		super(app);
		this.draft = clone(opts.timetable);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-tt-modal");
		this.setTitle(t("timetable.title"));
		this.build();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private build(): void {
		const root = this.contentEl;
		root.empty();
		if (this.opts.loadError && !this.replaceUnreadable) {
			root.createEl("p", { text: t("timetable.unreadable", { path: this.opts.store.path(), error: this.opts.loadError }) });
			const row = root.createDiv({ cls: "notebook-tt-actions" });
			row.createEl("button", { text: t("timetable.startNew") }).addEventListener("click", () => {
				this.replaceUnreadable = true;
				this.draft = clone({ version: 1, entries: [] });
				this.build();
			});
			row.createEl("button", { text: t("timetable.cancel") }).addEventListener("click", () => this.close());
			return;
		}
		root.createEl("p", { cls: "setting-item-description", text: t("timetable.hint") });
		const weekOne = this.field(root, t("timetable.weekOne"), t("timetable.weekOne.desc"));
		const weekOneInput = weekOne.createEl("input", { type: "date", value: this.draft.weekOne ?? "" });
		weekOneInput.addEventListener("input", () => {
			if (weekOneInput.value) this.draft.weekOne = weekOneInput.value;
			else delete this.draft.weekOne;
		});
		this.listEl = root.createDiv({ cls: "notebook-tt-list" });
		const datalist = root.createEl("datalist", { attr: { id: "notebook-tt-choices" } });
		for (const c of this.opts.choices) datalist.createEl("option", { value: c });
		this.renderList();
		const row = root.createDiv({ cls: "notebook-tt-actions" });
		row.createEl("button", { text: t("timetable.add") }).addEventListener("click", () => {
			this.draft.entries.push(newEntry());
			this.renderList();
			this.listEl.lastElementChild?.scrollIntoView({ block: "nearest" });
		});
		row.createEl("button", { text: t("timetable.cancel") }).addEventListener("click", () => this.close());
		row.createEl("button", { text: t("timetable.save"), cls: "mod-cta" }).addEventListener("click", () => void this.save());
	}

	private field(parent: HTMLElement, label: string, desc?: string): HTMLElement {
		const f = parent.createDiv({ cls: "notebook-tt-field" });
		f.createEl("label", { text: label });
		const box = f.createDiv({ cls: "notebook-tt-control" });
		if (desc) f.createDiv({ cls: "setting-item-description", text: desc });
		return box;
	}

	private renderList(): void {
		this.listEl.empty();
		this.warnings.clear();
		if (!this.draft.entries.length) this.listEl.createEl("p", { cls: "setting-item-description", text: t("timetable.empty") });
		for (const entry of this.draft.entries) this.renderCard(entry);
		this.updateWarnings();
	}

	private renderCard(e: ClassEntry): void {
		const card = this.listEl.createDiv({ cls: "notebook-tt-card" });
		const course = this.field(card, t("timetable.course")).createEl("input", { type: "text", value: e.course });
		course.addEventListener("input", () => {
			e.course = course.value;
			this.updateWarnings();
		});

		const when = card.createDiv({ cls: "notebook-tt-row" });
		const day = this.field(when, t("timetable.day")).createEl("select", { cls: "dropdown" });
		dayNames().forEach((name, i) => day.createEl("option", { value: String(i + 1), text: name }));
		day.value = String(e.day);
		day.addEventListener("change", () => {
			e.day = Number(day.value);
			this.updateWarnings();
		});
		const time = (label: string, key: "start" | "end") => {
			const input = this.field(when, label).createEl("input", { type: "time", value: e[key] });
			input.addEventListener("input", () => {
				e[key] = input.value;
				this.updateWarnings();
			});
		};
		time(t("timetable.start"), "start");
		time(t("timetable.end"), "end");

		const room = this.field(card, t("timetable.room")).createEl("input", { type: "text", value: e.room ?? "" });
		room.addEventListener("input", () => {
			if (room.value.trim()) e.room = room.value;
			else delete e.room;
		});
		const link = this.field(card, t("timetable.link"), t("timetable.link.desc")).createEl("input", { type: "text", value: e.notebook ?? "", attr: { list: "notebook-tt-choices" } });
		link.addEventListener("input", () => {
			if (link.value.trim()) e.notebook = link.value;
			else delete e.notebook;
		});

		const extra = card.createDiv({ cls: "notebook-tt-row" });
		const weeks = this.field(extra, t("timetable.weeks")).createEl("select", { cls: "dropdown" });
		for (const w of WEEK_PATTERNS) weeks.createEl("option", { value: w, text: t(`timetable.weeks.${w}` as MessageKey) });
		weeks.value = e.weeks;
		weeks.addEventListener("change", () => {
			e.weeks = weeks.value as WeekPattern;
			this.updateWarnings();
		});
		const date = (label: string, key: "from" | "to") => {
			const input = this.field(extra, label).createEl("input", { type: "date", value: e[key] ?? "" });
			input.addEventListener("input", () => {
				if (input.value) e[key] = input.value;
				else delete e[key];
				this.updateWarnings();
			});
		};
		date(t("timetable.from"), "from");
		date(t("timetable.to"), "to");

		this.warnings.set(e.id, card.createDiv({ cls: "notebook-tt-warning" }));
		card.createEl("button", { text: t("timetable.remove"), cls: "mod-warning" }).addEventListener("click", () => {
			this.draft.entries = this.draft.entries.filter((x) => x !== e);
			this.renderList();
		});
	}

	private updateWarnings(): void {
		const lines = new Map<string, string[]>();
		for (const [a, b] of findOverlaps(this.draft.entries.filter((e) => entryProblem(e) === null))) {
			const add = (x: ClassEntry, other: ClassEntry) => {
				const l = lines.get(x.id) ?? [];
				l.push(t("timetable.overlap", { other: `${other.course} ${other.start}-${other.end}` }));
				lines.set(x.id, l);
			};
			add(a, b);
			add(b, a);
		}
		for (const [id, el] of this.warnings) el.setText((lines.get(id) ?? []).join(" · "));
	}

	private async save(): Promise<void> {
		const tt = this.draft;
		if (tt.weekOne && !isValidDay(tt.weekOne)) {
			new Notice(t("timetable.problem.weekOne"));
			return;
		}
		for (const e of tt.entries) {
			const p = entryProblem(e);
			if (p) {
				new Notice(t("timetable.problem.entry", { course: e.course.trim() || t("timetable.course"), problem: t(`timetable.problem.${p}` as MessageKey) }), 6000);
				return;
			}
		}
		try {
			const { backup } = await this.opts.store.save(tt, { base: this.opts.base, replaceUnreadable: this.replaceUnreadable });
			this.opts.saved(clone(tt));
			if (backup) new Notice(t("timetable.backedUp", { path: backup }), 8000);
			new Notice(t("timetable.saved"));
			this.close();
		} catch (e) {
			console.error("[notebook] timetable save", e);
			new Notice(t("timetable.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}
}
