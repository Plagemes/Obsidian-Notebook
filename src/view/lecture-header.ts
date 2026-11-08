/**
 * Automatic lecture header of one notebook view (0.22, roadmap #210). The rules are in timetable/lecture-header.ts (pure); this is
 * the view side: it writes the header of the class in progress onto the page being written on (one History step, in a fresh group,
 * only in an empty spot at the top), offers it with a small chip when the setting says "ask", and does it by itself on "automatic".
 *
 * It starts from two things: a lecture that begins (lecture mode starts without having added a lecture page of its own) and a new
 * page added while a class of the notebook is in progress. Never while the pen is on the screen, never on a locked page, never over
 * ink or elements: with no free spot the chip "Add lecture header" waits instead. The command works at any time, with the class in
 * progress or else the nearest one of today.
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { writing } from "../ink/writing-guard";
import { AddElement, Batch } from "../model/history";
import { isLocked } from "../model/page-lock";
import type { NotebookSettings } from "../settings";
import { headerText, planLectureHeader, type HeaderFields, type HeaderPlan } from "../timetable/lecture-header";
import type { LectureClass } from "../timetable/lecture-mode";
import type { EditContext } from "./edit-context";
import { showNotice } from "./notice";

/** How long the chip stays when nobody answers, ms. */
const CHIP_MS = 12000;
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

export interface LectureHeaderHost {
	parent(): HTMLElement;
	path(): string | null;
	settings(): Pick<NotebookSettings, "lectureHeader" | "lectureHeaderLecturer" | "lectureHeaderRoom" | "lectureHeaderDate" | "lectureHeaderTime">;
	/** The class in progress for the notebook; with `nearest`, else the closest of today. */
	classFor(path: string, nearest: boolean): LectureClass | null;
	editContext(): EditContext | null;
	/** The document shown, even while it cannot be edited (read-only, mid-stroke); null before one is loaded. */
	document?(): { pages: readonly { id: string }[] } | null;
	/** The view is in the middle of a stroke or gesture. */
	busy(): boolean;
	locale(): string;
	now?(): Date;
}

export function headerFields(s: ReturnType<LectureHeaderHost["settings"]>): HeaderFields {
	return { lecturer: s.lectureHeaderLecturer, room: s.lectureHeaderRoom, date: s.lectureHeaderDate, time: s.lectureHeaderTime };
}

/** What `insertHeader` did, for the chip and the notices. */
export type InsertOutcome = "added" | "present" | "no-space" | "locked" | "busy" | "no-class" | "empty";

/**
 * Writes the header of `cls` onto page `pageIndex` as one undo step. Pure with respect to the view: all it needs is the edit
 * context. A locked page is refused before anything is planned.
 */
export function insertHeader(ctx: EditContext, pageIndex: number, cls: LectureClass, fields: HeaderFields, locale: string, now: Date): InsertOutcome {
	const page = ctx.doc.pages[pageIndex];
	if (!page) return "empty";
	if (isLocked(page)) return "locked";
	const text = headerText(cls, now, locale, fields, t("lectureHeader.room"));
	const plan: HeaderPlan = planLectureHeader(page, text, cls.course, now, ctx.measure);
	if (plan.kind === "skip") return plan.reason;
	const start = page.elements?.length ?? 0;
	const commands = plan.elements.map((el, i) => new AddElement(page.id, el, start + i));
	const cmd = commands.length === 1 ? commands[0]! : new Batch("Lecture header", commands);
	return ctx.execute(cmd) ? "added" : "locked";
}

export class LectureHeaderService {
	private chip: HTMLElement | null = null;
	private timer: number | null = null;
	private offered: { cls: LectureClass; pageId: string } | null = null;
	/** Pages already seen, so only a page that appears later counts as new; null until the document is known. */
	private known: Set<string> | null = null;
	private knownDoc: unknown = null;
	/** Pages dealt with (header added, found or turned down) for a class occurrence: never offered again. */
	private readonly settled = new Set<string>();

	constructor(private readonly host: LectureHeaderHost) {}

	private now(): Date {
		return this.host.now?.() ?? new Date();
	}

	/** A document finished loading: the pages it has are not new. */
	opened(): void {
		this.known = null;
		this.knownDoc = null;
		this.hideChip();
		this.settled.clear();
		// Review round 2 (R2-5): the pages are seeded from the loaded document now, not at the first change (which may already have
		// deleted a page that an undo then brings back, read-only or mid-stroke views give no edit context).
		const doc = this.document();
		if (doc) this.seed(doc);
	}

	/** The document shown, also when it cannot be edited right now. */
	private document(): { pages: readonly { id: string }[] } | null {
		return this.host.document?.() ?? this.host.editContext()?.doc ?? null;
	}

	private seed(doc: { pages: readonly { id: string }[] }): void {
		this.known = new Set(doc.pages.map((p) => p.id));
		this.knownDoc = doc;
	}

	/** The pages may have changed (after a History step): a page that appeared while a class is on gets the header. */
	pagesChanged(): void {
		const doc = this.document();
		if (!doc) return;
		if (this.known === null || this.knownDoc !== doc) {
			this.seed(doc);
			return;
		}
		// Review fix (D1): `known` only grows. A page that comes back (undo of a delete, redo of an add) was seen before, so it is
		// never new: only a page created by a forward edit is, and undo/redo never runs an automatic step (the redo stack stays).
		const seen = this.known;
		const fresh = doc.pages.filter((p) => !seen.has(p.id));
		for (const p of doc.pages) seen.add(p.id);
		const mode = this.host.settings().lectureHeader;
		const path = this.host.path();
		if (mode === "off" || !path || fresh.length !== 1) return;
		const cls = this.host.classFor(path, false);
		if (!cls) return;
		this.consider(cls, fresh[0]!.id, mode);
	}

	/** Lecture mode began. `pageAdded`: it added its own lecture page (which already carries the course and date). */
	lectureStarted(cls: LectureClass, pageAdded: boolean): void {
		const mode = this.host.settings().lectureHeader;
		if (mode === "off" || pageAdded) return;
		const ctx = this.host.editContext();
		const page = ctx?.doc.pages[ctx.currentPage()];
		if (page) this.consider(cls, page.id, mode);
	}

	/** Command: the class in progress, else the nearest of today, onto the page in view. */
	runCommand(): void {
		const path = this.host.path();
		const cls = path ? this.host.classFor(path, true) : null;
		if (!cls) {
			showNotice(t("lectureHeader.noClass"));
			return;
		}
		const ctx = this.host.editContext();
		if (!ctx) {
			showNotice(t("lectureHeader.busy"));
			return;
		}
		this.report(this.add(ctx, ctx.currentPage(), cls), cls);
	}

	private consider(cls: LectureClass, pageId: string, mode: "ask" | "auto"): void {
		const key = `${cls.key}#${pageId}`;
		if (this.settled.has(key)) return;
		// Nothing changes under the pen: wait for the first pause, then look again.
		if (writing.writing() || this.host.busy()) {
			writing.whenQuiet(() => this.consider(cls, pageId, mode));
			return;
		}
		window.setTimeout(() => this.act(cls, pageId, mode, key), 0);
	}

	private act(cls: LectureClass, pageId: string, mode: "ask" | "auto", key: string): void {
		const ctx = this.host.editContext();
		if (!ctx || this.settled.has(key)) return;
		const index = ctx.doc.pages.findIndex((p) => p.id === pageId);
		if (index < 0) return;
		if (mode === "ask") {
			if (this.canAdd(ctx, index, cls)) this.showChip(cls, pageId, key);
			return;
		}
		const outcome = this.add(ctx, index, cls);
		// Automatic never says no loudly: with no free spot the chip waits; present and locked are silent.
		if (outcome === "added") {
			this.settled.add(key);
			showNotice(t("lectureHeader.done", { course: cls.course }));
		} else if (outcome === "no-space") this.showChip(cls, pageId, key);
		else this.settled.add(key);
	}

	/** True when the header could be written now (not locked, not already there). */
	private canAdd(ctx: EditContext, index: number, cls: LectureClass): boolean {
		const page = ctx.doc.pages[index];
		if (!page || isLocked(page)) return false;
		const now = this.now();
		const text = headerText(cls, now, this.host.locale(), headerFields(this.host.settings()), t("lectureHeader.room"));
		const plan = planLectureHeader(page, text, cls.course, now, ctx.measure);
		return plan.kind === "add" || plan.reason === "no-space";
	}

	private add(ctx: EditContext, index: number, cls: LectureClass): InsertOutcome {
		return insertHeader(ctx, index, cls, headerFields(this.host.settings()), this.host.locale(), this.now());
	}

	private report(outcome: InsertOutcome, cls: LectureClass): void {
		if (outcome === "added") showNotice(t("lectureHeader.done", { course: cls.course }));
		else if (outcome === "present") showNotice(t("lectureHeader.present"));
		else if (outcome === "no-space") showNotice(t("lectureHeader.noSpace"));
		else if (outcome === "locked") showNotice(t("lectureHeader.locked"));
	}

	// --- the chip ---

	private showChip(cls: LectureClass, pageId: string, key: string): void {
		this.hideChip();
		this.offered = { cls, pageId };
		const chip = this.host.parent().createDiv({ cls: "notebook-lecture-header-offer", attr: { role: "group", "aria-label": t("lectureHeader.offer") } });
		for (const type of ISOLATED) chip.addEventListener(type, (e) => e.stopPropagation());
		const add = chip.createEl("button", { cls: "notebook-lecture-header-add", attr: { type: "button" } });
		setIcon(add.createSpan({ cls: "notebook-lecture-header-icon", attr: { "aria-hidden": "true" } }), "graduation-cap");
		add.createSpan({ text: t("lectureHeader.offer") });
		add.addEventListener("click", (e) => {
			e.preventDefault();
			const ctx = this.host.editContext();
			this.hideChip();
			if (!ctx) {
				showNotice(t("lectureHeader.busy"));
				return;
			}
			const index = ctx.doc.pages.findIndex((p) => p.id === pageId);
			if (index < 0) return;
			const outcome = this.add(ctx, index, cls);
			if (outcome !== "no-space") this.settled.add(key);
			this.report(outcome, cls);
		});
		const close = chip.createEl("button", { cls: "notebook-lecture-header-close clickable-icon", attr: { type: "button", "aria-label": t("lectureHeader.dismiss") } });
		setIcon(close, "x");
		close.addEventListener("click", (e) => {
			e.preventDefault();
			this.settled.add(key);
			this.hideChip();
		});
		this.chip = chip;
		this.timer = window.setTimeout(() => {
			this.settled.add(key);
			this.hideChip();
		}, CHIP_MS);
	}

	hideChip(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.chip?.remove();
		this.chip = null;
		this.offered = null;
	}

	/** The chip is on screen (tests, state checks). */
	get offering(): boolean {
		return this.offered !== null;
	}

	destroy(): void {
		this.hideChip();
		this.known = null;
		this.knownDoc = null;
	}
}
