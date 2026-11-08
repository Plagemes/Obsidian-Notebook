import { setIcon } from "obsidian";
import { t } from "../i18n";
import { awayParts, normaliseSeen, planWelcome, recordSeen, type WelcomeItem, type WelcomePlan } from "../model/welcome-back";
import type { NotebookDocument } from "../model/types";

/** Events that must not reach the page or the view's shortcuts (the card never takes pen input). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

export interface WelcomeBackHost {
	/** The element the card floats in (the notebook body). */
	parent(): HTMLElement;
	enabled(): boolean;
	hours(): number;
	/** The per-device values (Obsidian's local storage); either may throw. */
	load(): unknown;
	save(value: unknown): void;
	now(): number;
	indexOf(pageId: string): number;
	/** Shows page `index` with page y `y` at the top, recorded in the back history. */
	goTo(index: number, y: number): void;
}

/**
 * Roadmap #420: when a notebook is reopened after a while, a quiet card offers the way back to where the reader was (the stored
 * reading position, the slide of a PDF page) and the open questions and gaps already marked in the notebook. Every row is a button
 * that goes there. Offered once per opening, closed by its button, by the first stroke or by taking a row. Nothing is written but the
 * device's own "last open" time, which is bounded local storage; the document is never touched.
 */
export class WelcomeBack {
	private card: HTMLElement | null = null;
	private docId: string | null = null;

	constructor(private readonly host: WelcomeBackHost) {}

	/** The notebook has just opened and its start position is applied: read the last time, remember this one, maybe show the card. */
	offer(doc: NotebookDocument): void {
		this.hide();
		this.docId = doc.id;
		const now = this.host.now();
		const seen = this.read();
		const last = seen[doc.id] ?? null;
		this.write(recordSeen(seen, doc.id, now));
		if (!this.host.enabled()) return;
		const plan = planWelcome(doc, { lastSeen: last, now, hours: this.host.hours() });
		if (plan) this.show(plan);
	}

	/** A stroke was written: the reader has started, the card goes away. */
	wrote(): void {
		this.hide();
	}

	get visible(): boolean {
		return this.card !== null;
	}

	/** A different file, or the view closing: the time this notebook was last in view is now. */
	reset(): void {
		this.hide();
		if (this.docId) this.write(recordSeen(this.read(), this.docId, this.host.now()));
		this.docId = null;
	}

	destroy(): void {
		this.reset();
	}

	private read(): Readonly<Record<string, number>> {
		try {
			return normaliseSeen(this.host.load());
		} catch {
			return {};
		}
	}

	private write(value: Readonly<Record<string, number>>): void {
		try {
			this.host.save(value);
		} catch (e) {
			console.error("[notebook] could not store the last-open time", e);
		}
	}

	private show(plan: WelcomePlan): void {
		const card = this.host.parent().createDiv({ cls: "notebook-welcome-back", attr: { role: "group", "aria-label": t("welcomeBack.title") } });
		for (const type of ISOLATED) card.addEventListener(type, (e) => e.stopPropagation());
		const head = card.createDiv({ cls: "notebook-welcome-back-head" });
		const titles = head.createDiv({ cls: "notebook-welcome-back-titles" });
		titles.createSpan({ cls: "notebook-welcome-back-title", text: t("welcomeBack.title") });
		const away = awayParts(plan.awayMs);
		titles.createSpan({ cls: "notebook-welcome-back-away", text: t(away.unit === "d" ? "welcomeBack.awayD" : "welcomeBack.awayH", { n: String(away.n) }) });
		const close = head.createEl("button", { cls: "notebook-welcome-back-close clickable-icon", attr: { type: "button", "aria-label": t("welcomeBack.dismiss") } });
		setIcon(close, "x");
		close.addEventListener("click", (e) => {
			e.preventDefault();
			this.hide();
		});
		const list = card.createDiv({ cls: "notebook-welcome-back-list" });
		if (plan.resume) {
			const r = plan.resume;
			const label = r.slide !== null ? t("welcomeBack.resumeSlide", { n: String(r.slide) }) : t("welcomeBack.resumePage", { n: String(r.index + 1) });
			this.row(list, "play", label, null, "resume", () => this.host.goTo(r.index, r.y));
		}
		this.group(list, "help-circle", "question", plan.questions);
		this.group(list, "alert-circle", "gap", plan.gaps);
		const more = plan.questionTotal - plan.questions.length + (plan.gapTotal - plan.gaps.length);
		if (more > 0) list.createDiv({ cls: "notebook-welcome-back-more", text: t("welcomeBack.more", { n: String(more) }) });
		this.card = card;
	}

	private group(list: HTMLElement, icon: string, kind: "question" | "gap", items: readonly WelcomeItem[]): void {
		for (const item of items) {
			const label = t(kind === "question" ? "welcomeBack.question" : "welcomeBack.gap", { n: String(item.pageIndex + 1) });
			this.row(list, icon, label, item.text, kind, () => {
				const index = this.host.indexOf(item.pageId);
				if (index >= 0) this.host.goTo(index, Math.max(0, item.y - 80));
			});
		}

	}

	private row(list: HTMLElement, icon: string, label: string, text: string | null, kind: string, go: () => void): void {
		const row = list.createEl("button", { cls: `notebook-welcome-back-row notebook-welcome-back-${kind}`, attr: { type: "button" } });
		setIcon(row.createSpan({ cls: "notebook-welcome-back-icon", attr: { "aria-hidden": "true" } }), icon);
		const body = row.createSpan({ cls: "notebook-welcome-back-text" });
		body.createSpan({ cls: "notebook-welcome-back-label", text: label });
		if (text) body.createSpan({ cls: "notebook-welcome-back-note", text });
		row.addEventListener("click", (e) => {
			e.preventDefault();
			this.hide();
			go();
		});
	}

	private hide(): void {
		this.card?.remove();
		this.card = null;
	}
}
