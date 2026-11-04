/**
 * Automatic lecture mode of one notebook view (0.14, roadmap 401). The rules are in timetable/lecture-mode.ts (pure); this
 * is the view side: it asks the timetable which class is in progress for the open notebook, shows a small banner (ask
 * mode) or switches on by itself (auto mode), adds today's lecture page once, shows a quiet chip while the mode is on and
 * leaves it when the class ends. It never changes anything while the pen is on the screen, and everything stays inside the
 * app: no system notification is ever sent.
 *
 * "Lecture mode on" means `uiContext().lecture`: the contextual bar then shows the lecture tools (board shot, markers,
 * new lecture, end-of-lecture panel). The mode itself follows the clock and the timetable and is not stored.
 *
 * The lecture page is only ever added by a user action: Start, the command, or (automatic mode) the first stroke the user
 * writes during the lecture (`wrote()`, called by the view when a stroke was committed). The clock, the 30 s timer and
 * coming back to the app never touch the document: on resume the device may still hold a stale copy of a notebook that sync
 * is about to replace, and a page added by nobody would turn that copy into a local change that wins over the other device.
 * What the user turned down and the pages added are remembered for today in the device's local storage (lecture-memory.ts),
 * so reopening the notebook does not ask again and does not add a page the user deleted.
 */
import { setIcon } from "obsidian";
import { writing } from "../ink/writing-guard";
import { t } from "../i18n";
import { findLecturePage } from "../timetable/lecture-open";
import {
	lectureMemoryOf, normaliseLectureMemory, rememberLecture, type LectureMemoryKind,
} from "../timetable/lecture-memory";
import { isoDay } from "../timetable/schedule";
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
	/** The device's local storage (what was turned down or paged today); without it nothing is remembered across openings. */
	memory?: { load(): unknown; save(value: unknown): void };
	now?(): Date;
}

export class LectureModeController {
	private active: ActiveLecture | null = null;
	private activeClass: LectureClass | null = null;
	private asking: LectureClass | null = null;
	/** Occurrences turned down or left by the user (today, in this view and, from local storage, in earlier openings). */
	private readonly declined = new Set<string>();
	/** Occurrences whose lecture page was added (or found), same scope. */
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
		this.recall();
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

	/**
	 * The user wrote in the notebook (a stroke was committed). In a lecture mode the rule started on its own, this is the
	 * first user action: it adds today's lecture page, once (not when it was added before, even if it was deleted since).
	 */
	wrote(): void {
		const cls = this.activeClass;
		if (!this.active?.key || !cls || this.paged.has(cls.key)) return;
		this.ensurePage(cls, this.now(), false);
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
		// No page is added here: the clock never edits the notebook (see the top of this file).
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
		if (this.active?.key) this.remember("declined", this.active.key);
		this.active = null;
		this.activeClass = null;
		this.hideChip();
		this.host.parent().removeClass("nb-lecture-mode");
		this.host.changed();
		if (ended && was && now.getTime() >= was.endsAt) showNotice(t("lectureMode.over", { course: was.course }));
	}

	/**
	 * Adds today's lecture page (header, time slot, room, lecturer, slides) unless the notebook already has it, and notes
	 * that it was dealt with. Only called for a user action. `scroll`: go to the new page (Start, command), or stay where the
	 * user is writing.
	 */
	private ensurePage(cls: LectureClass, now: Date, scroll = true): void {
		const ctx = this.host.editContext();
		if (!ctx) return;
		if (findLecturePage(ctx.doc.pages, cls.course, now) < 0) addLecturePage(ctx, cls.course, now, cls.course, classContext(cls, ctx.slide?.() ?? null), scroll);
		this.remember("paged", cls.key);
	}

	/** Notes an occurrence as turned down or paged, here and in local storage. */
	private remember(kind: LectureMemoryKind, key: string): void {
		(kind === "declined" ? this.declined : this.paged).add(key);
		const mem = this.host.memory;
		const path = this.path;
		if (!mem || !path) return;
		try {
			const today = isoDay(this.now());
			mem.save(rememberLecture(normaliseLectureMemory(mem.load(), today), path, kind, key, today));
		} catch {
			// A convenience: without it the notebook may ask again after a reopening.
		}
	}

	/** Takes what earlier openings of this notebook noted today. */
	private recall(): void {
		const mem = this.host.memory;
		const path = this.path;
		if (!mem || !path) return;
		try {
			const known = lectureMemoryOf(normaliseLectureMemory(mem.load(), isoDay(this.now())), path);
			for (const k of known.declined) this.declined.add(k);
			for (const k of known.paged) this.paged.add(k);
		} catch {
			// Unreadable storage reads as nothing remembered.
		}
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
			this.remember("declined", cls.key);
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
