/**
 * Automatic lecture mode of one notebook view (0.14, roadmap 401). The rules are in timetable/lecture-mode.ts (pure); this
 * is the view side: it asks the timetable which class is in progress for the open notebook, shows a small banner (ask
 * mode) or switches on by itself (auto mode), adds today's lecture page once, shows a quiet chip while the mode is on and
 * leaves it when the class ends. It never changes anything while the pen is on the screen, and everything stays inside the
 * app: no system notification is ever sent.
 *
 * "Lecture mode on" means `uiContext().lecture`: the contextual bar then shows the lecture tools (board shot, markers,
 * new lecture, end-of-lecture panel). Nothing is stored: the mode follows the clock and the timetable.
 */
import { setIcon } from "obsidian";
import { writing } from "../ink/writing-guard";
import { t } from "../i18n";
import { findLecturePage } from "../timetable/lecture-open";
import {
	stepLectureMode, type ActiveLecture, type LectureClass, type LectureModeSetting, type ModeStep,
} from "../timetable/lecture-mode";
import type { EditContext } from "./edit-context";
import { addLecturePage, classContext } from "./lecture";
import { showNotice } from "./notice";

/** How often the clock is looked at while a notebook is open, ms. Cheap: no rendering, no file access. */
export const LECTURE_TICK_MS = 30_000;

/** What the controller needs of the notebook view and the plugin. */
export interface LectureModeHost {
	/** The element the banner floats in (the notebook body). */
	parent(): HTMLElement;
	/** Vault path of the open notebook, or null. */
	path(): string | null;
	setting(): LectureModeSetting;
	/** The class in progress that belongs to that notebook (timetable service), or null. */
	classFor(path: string, now: Date): LectureClass | null;
	/** The view cannot take changes now (a stroke or gesture in progress). */
	busy(): boolean;
	/** The open document for the lecture page; null when read-only, not loaded or in contact. */
	editContext(): EditContext | null;
	/** The lecture state changed: the UI (contextual bar) is drawn again. */
	changed(): void;
	now?(): Date;
}

export class LectureModeController {
	private active: ActiveLecture | null = null;
	private activeClass: LectureClass | null = null;
	private asking: LectureClass | null = null;
	/** Occurrences turned down or left by the user in this view. */
	private readonly declined = new Set<string>();
	/** Occurrences whose lecture page was added (or found) in this view. */
	private readonly paged = new Set<string>();
	private path: string | null = null;
	private banner: HTMLElement | null = null;
	private chip: HTMLElement | null = null;
	private timer: number | null = null;
	private readonly onVisible = (): void => {
		if (document.visibilityState === "visible") this.evaluate();
	};

	constructor(private readonly host: LectureModeHost) {}

	/** Lecture mode is on in this view. */
	get on(): boolean {
		return this.active !== null;
	}

	/** Course of the lecture in progress, or null. */
	get course(): string | null {
		return this.activeClass?.course ?? null;
	}

	/** The banner is waiting for an answer. */
	get asked(): boolean {
		return this.asking !== null;
	}

	/** A notebook finished loading (or was replaced by another): looks at the clock now and keeps looking. */
	opened(): void {
		const path = this.host.path();
		if (path !== this.path) this.reset();
		this.path = path;
		if (this.timer === null) {
			this.timer = window.setInterval(() => this.evaluate(), LECTURE_TICK_MS);
			document.addEventListener("visibilitychange", this.onVisible);
		}
		this.evaluate();
	}

	/** The notebook was closed or unloaded: nothing of its lecture state survives. */
	closed(): void {
		this.reset();
		this.stopTimer();
		this.path = null;
	}

	/** The setting changed. */
	settingsChanged(): void {
		if (this.path) this.evaluate();
	}

	destroy(): void {
		this.closed();
	}

	/** Command and button: switches the mode on or off by hand. Leaving a class's lecture early keeps the rule from bringing it back. */
	toggle(): void {
		if (this.active) {
			this.leave(false);
			return;
		}
		const now = this.now();
		const match = this.path ? this.host.classFor(this.path, now) : null;
		this.hideBanner();
		this.asking = null;
		this.enter(match, true);
		if (match) this.ensurePage(match, now);
	}

	/** Looks at the clock and the timetable and does what the rules say. */
	evaluate(): void {
		if (!this.path) return;
		const now = this.now();
		const match = this.host.classFor(this.path, now);
		const busy = writing.writing() || this.host.busy();
		// A banner withdrawn or a mode left may be followed at once by the next step (auto after ask, the next class back to back).
		for (let round = 0; round < 3; round++) {
			const step = stepLectureMode({
				setting: this.host.setting(), now: now.getTime(), match, active: this.active, asking: this.asking, declined: this.declined, busy,
			});
			this.apply(step, now);
			if (step.kind !== "leave" && step.kind !== "unask") break;
		}
		if (this.active?.key) {
			const cls = this.activeClass;
			if (cls && !busy && !this.paged.has(cls.key)) this.ensurePage(cls, now);
		}
	}

	private apply(step: ModeStep, now: Date): void {
		switch (step.kind) {
			case "enter":
				this.enter(step.cls, false);
				showNotice(t("lectureMode.on", { course: step.cls.course }));
				break;
			case "ask":
				this.asking = step.cls;
				this.showBanner(step.cls);
				break;
			case "unask":
				this.asking = null;
				this.hideBanner();
				break;
			case "leave":
				this.leave(true, now);
				break;
			case "none":
				break;
		}
	}

	private enter(cls: LectureClass | null, manual: boolean): void {
		this.active = { key: cls?.key ?? null, endsAt: cls?.endsAt ?? null, manual };
		this.activeClass = cls;
		this.hideBanner();
		this.showChip();
		this.host.parent().addClass("nb-lecture-mode");
		this.host.changed();
	}

	private leave(ended: boolean, now: Date = this.now()): void {
		const was = this.activeClass;
		if (this.active?.key) this.declined.add(this.active.key);
		this.active = null;
		this.activeClass = null;
		this.hideChip();
		this.host.parent().removeClass("nb-lecture-mode");
		this.host.changed();
		if (ended && was && now.getTime() >= was.endsAt) showNotice(t("lectureMode.over", { course: was.course }));
	}

	/** Adds today's lecture page (header, time slot, room, lecturer, slides) once, unless the notebook already has it. */
	private ensurePage(cls: LectureClass, now: Date): void {
		const ctx = this.host.editContext();
		if (!ctx) return;
		if (findLecturePage(ctx.doc.pages, cls.course, now) < 0) addLecturePage(ctx, cls.course, now, cls.course, classContext(cls, ctx.slide?.() ?? null));
		this.paged.add(cls.key);
	}

	private reset(): void {
		this.hideBanner();
		this.hideChip();
		this.host.parent().removeClass("nb-lecture-mode");
		const wasOn = this.active !== null;
		this.active = null;
		this.activeClass = null;
		this.asking = null;
		this.declined.clear();
		this.paged.clear();
		if (wasOn) this.host.changed();
	}

	private stopTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		document.removeEventListener("visibilitychange", this.onVisible);
	}

	private now(): Date {
		return this.host.now?.() ?? new Date();
	}

	// --- the banner (ask mode) and the chip (mode on) ---

	private showBanner(cls: LectureClass): void {
		this.hideBanner();
		const el = this.host.parent().createDiv({ cls: "notebook-lecture-banner", attr: { role: "status", "aria-live": "polite" } });
		setIcon(el.createSpan({ cls: "notebook-lecture-icon", attr: { "aria-hidden": "true" } }), "graduation-cap");
		const room = cls.room ? t("lectureMode.ask.room", { room: cls.room }) : "";
		el.createSpan({ cls: "notebook-lecture-text", text: t("lectureMode.ask", { course: cls.course, room }) });
		const actions = el.createDiv({ cls: "notebook-lecture-actions" });
		actions.createEl("button", { text: t("lectureMode.start"), cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", () => {
			const now = this.now();
			this.asking = null;
			this.enter(cls, false);
			this.ensurePage(cls, now);
		});
		actions.createEl("button", { text: t("lectureMode.notNow"), attr: { type: "button" } }).addEventListener("click", () => {
			this.declined.add(cls.key);
			this.asking = null;
			this.hideBanner();
		});
		this.banner = el;
	}

	private hideBanner(): void {
		this.banner?.remove();
		this.banner = null;
	}

	private showChip(): void {
		this.hideChip();
		const el = this.host.parent().createDiv({ cls: "notebook-lecture-chip", attr: { role: "status" } });
		setIcon(el.createSpan({ cls: "notebook-lecture-chip-icon", attr: { "aria-hidden": "true" } }), "graduation-cap");
		const cls = this.activeClass;
		el.createSpan({
			cls: "notebook-lecture-chip-text",
			text: cls ? t("lectureMode.chip", { course: cls.course, end: cls.end }) : t("lectureMode.chip.plain"),
		});
		const end = el.createEl("button", { cls: "notebook-lecture-chip-end", text: t("lectureMode.end"), attr: { type: "button", title: t("lectureMode.end.hint") } });
		end.addEventListener("click", () => this.leave(false));
		this.chip = el;
	}

	private hideChip(): void {
		this.chip?.remove();
		this.chip = null;
	}
}
