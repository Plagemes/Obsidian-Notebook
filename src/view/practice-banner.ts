/**
 * The strip shown over a practice page (a page tagged `practice`, usually with a record in `_meta/practice.json`):
 * what attempt it is, *Peek at the solution* (hold), *Original*, *Attempts* and the optional timer. Everything here is view
 * state except the timer's *Stop*, which adds the time to the attempt's record.
 */
import { Notice } from "obsidian";
import { t } from "../i18n";
import { attemptFromTags, elapsedSeconds, formatDuration, hasPracticeTag, recordOf, type AttemptRecord } from "../model/practice";
import type { Page } from "../model/types";
import type { PracticeService } from "./practice";
import type { PracticeViewHost } from "./practice-types";

export class PracticeBanner {
	private readonly el: HTMLElement;
	private page: Page | null = null;
	private record: AttemptRecord | null = null;
	/** The peek is on (held, or switched on by the command). */
	private peeking = false;
	/** Bumped whenever a peek is started or ended, so a slow start does not outlive its release. */
	private token = 0;
	private tick: number | null = null;

	constructor(private readonly service: PracticeService, private readonly host: PracticeViewHost) {
		this.el = host.body.createDiv({ cls: "notebook-practice-banner notebook-hidden", attr: { role: "status" } });
	}

	/** Shows the banner for `page` (hidden for a page that is not a practice page). */
	show(page: Page | null): void {
		const doc = this.host.doc();
		const record = page && doc ? recordOf(this.service.data(), page.id, doc.id) : null;
		if (page?.id !== this.page?.id) this.endPeek();
		this.page = page;
		this.record = record;
		this.stopTick();
		this.el.empty();
		if (!page || (!record && !hasPracticeTag(page.tags))) {
			this.el.addClass("notebook-hidden");
			return;
		}
		this.el.removeClass("notebook-hidden");
		const n = record?.n ?? attemptFromTags(page.tags);
		this.el.createSpan({ cls: "notebook-practice-title", text: n ? t("practice.banner.attempt", { n: String(n) }) : t("practice.banner.plain") });
		if (!record) {
			this.el.createSpan({ cls: "notebook-practice-note", text: t("practice.banner.noLink") });
			return;
		}
		this.holdButton();
		this.button(t("practice.banner.original"), () => void this.service.goToOriginal(this.host));
		this.button(t("practice.banner.attempts"), () => void this.service.attempts(this.host));
		this.timerButton(page, record);
	}

	private button(text: string, onClick: () => void): HTMLButtonElement {
		const b = this.el.createEl("button", { cls: "notebook-practice-button", text, attr: { type: "button" } });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	/** Hold to see the original's hidden ink; let go and it is gone. Pointer capture keeps the release even if the finger slides off. */
	private holdButton(): void {
		const b = this.el.createEl("button", {
			cls: "notebook-practice-button notebook-practice-peek",
			text: t("practice.banner.peek"),
			attr: { type: "button", title: t("practice.banner.peek.hint") },
		});
		const down = (e: PointerEvent) => {
			if (e.button > 0) return;
			e.preventDefault();
			try {
				b.setPointerCapture(e.pointerId);
			} catch {
				// Not every pointer can be captured; the release events below still arrive while it stays over the button.
			}
			b.addClass("is-held");
			void this.startPeek();
		};
		const up = () => {
			b.removeClass("is-held");
			this.endPeek();
		};
		b.addEventListener("pointerdown", down);
		b.addEventListener("pointerup", up);
		b.addEventListener("pointercancel", up);
		b.addEventListener("lostpointercapture", up);
		b.addEventListener("contextmenu", (e) => e.preventDefault());
		b.addEventListener("keydown", (e) => {
			if ((e.key === " " || e.key === "Enter") && !e.repeat) {
				e.preventDefault();
				b.addClass("is-held");
				void this.startPeek();
			}
		});
		b.addEventListener("keyup", (e) => {
			if (e.key === " " || e.key === "Enter") up();
		});
		b.addEventListener("blur", up);
	}

	async startPeek(): Promise<void> {
		const record = this.record;
		const page = this.page;
		const doc = this.host.doc();
		if (!record || !page || !doc) {
			new Notice(t("practice.notPractice"));
			return;
		}
		const token = ++this.token;
		this.peeking = true;
		const strokes = await this.service.peekFor(this.host, record);
		// Released (or the page changed) while the original was being read.
		if (token !== this.token || !this.peeking) return;
		if (strokes === null) {
			this.peeking = false;
			new Notice(t("practice.originalGone"), 8000);
			return;
		}
		if (strokes.length === 0) {
			this.peeking = false;
			new Notice(t("practice.peek.nothing"));
			return;
		}
		const index = doc.pages.findIndex((p) => p.id === page.id);
		if (index >= 0) this.host.setPeek(index, strokes);
	}

	endPeek(): void {
		this.token++;
		if (!this.peeking) return;
		this.peeking = false;
		this.host.setPeek(0, null);
	}

	/** The command form: switches the overlay on or off (a hotkey cannot be held). */
	togglePeek(): void {
		if (this.peeking) this.endPeek();
		else void this.startPeek();
	}

	private timerButton(page: Page, record: AttemptRecord): void {
		const running = this.service.timerRunning(page.id);
		const b = this.button("", () => this.toggleTimer());
		b.addClass("notebook-practice-timer");
		b.setAttr("title", t(running === null ? "practice.timer.start.hint" : "practice.timer.stop.hint"));
		const paint = () => {
			const total = (record.seconds ?? 0) + (running === null ? 0 : elapsedSeconds(running, Date.now()));
			b.setText(`${t(running === null ? "practice.timer.start" : "practice.timer.stop")} ${formatDuration(total)}`);
		};
		paint();
		b.toggleClass("is-running", running !== null);
		if (running !== null) this.tick = window.setInterval(paint, 1000);
	}

	toggleTimer(): void {
		const page = this.page;
		const doc = this.host.doc();
		if (!page || !doc || !this.record) {
			new Notice(t("practice.notPractice"));
			return;
		}
		if (this.service.timerRunning(page.id) === null) {
			this.service.startTimer(page.id, doc.id);
			this.show(page);
		} else {
			void this.service.stopTimer(page.id).then((seconds) => {
				new Notice(t("practice.timer.stopped", { time: formatDuration(seconds) }));
				// Written records refresh every banner; this one also covers a stop that stored nothing.
				this.show(this.page);
			});
		}
	}

	private stopTick(): void {
		if (this.tick !== null) window.clearInterval(this.tick);
		this.tick = null;
	}

	destroy(): void {
		this.endPeek();
		this.stopTick();
		this.el.remove();
	}
}
