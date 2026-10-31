import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { Command } from "../model/history";
import {
	findInDocument, nextHitIndex, replaceAllCommand, replaceHitCommand, DEFAULT_FIND, MAX_RESULTS,
	type FindOptions, type FindResult, type TextHit,
} from "../model/text-search";
import type { NotebookDocument } from "../model/types";
import { showNotice } from "./notice";
import { modalShell, shellButton, shellCheck, shellField } from "../ui/components/modal-shell";

/** What the panel needs from the notebook view. */
export interface FindReplaceHost {
	app: App;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not being drawn on). */
	canEdit(): boolean;
	/** Runs the command as one undo step and refreshes the view; false when it could not (the document is no longer editable). */
	run(cmd: Command): boolean;
	/** Scrolls the page (0-based) into view. */
	goTo(pageIndex: number): void;
}

/** Wait after the last keystroke before searching, ms. */
const TYPING_MS = 120;

/**
 * Roadmap 361: find and replace in the text boxes of the notebook. Find box, replacement, match case, whole word, the
 * results with their page (tap to see the page behind the panel; the arrow button also closes the panel), Replace for
 * the chosen result and Replace all. Each replacement is one undo step; Replace all is one step for the whole notebook.
 */
export class FindReplaceModal extends Modal {
	private query = "";
	private replacement = "";
	private opts: FindOptions = { ...DEFAULT_FIND };
	private result: FindResult = { hits: [], total: 0, boxes: 0, truncated: false };
	private active = -1;
	private timer: number | null = null;
	private findInput!: HTMLInputElement;
	private status!: HTMLElement;
	private list!: HTMLElement;
	private replaceOne!: HTMLButtonElement;
	private replaceAll!: HTMLButtonElement;

	constructor(private readonly host: FindReplaceHost) {
		super(host.app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("find.title"), icon: "replace", size: "medium", cls: "notebook-find-panel" });
		const body = shell.body;

		const findRow = shellField(body, t("find.find"), "notebook-find-input");
		this.findInput = findRow.createEl("input", {
			cls: "nb-modal-input",
			attr: { id: "notebook-find-input", type: "text", placeholder: t("find.find.placeholder"), spellcheck: "false", autocomplete: "off", enterkeyhint: "search" },
		});
		this.findInput.addEventListener("input", () => this.typed());
		this.findInput.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			this.flushTyping();
			this.step(e.shiftKey ? -1 : 1);
		});

		const replaceRow = shellField(body, t("find.replace"), "notebook-replace-input");
		const replaceInput = replaceRow.createEl("input", {
			cls: "nb-modal-input",
			attr: { id: "notebook-replace-input", type: "text", placeholder: t("find.replace.placeholder"), spellcheck: "false", autocomplete: "off" },
		});
		replaceInput.addEventListener("input", () => {
			this.replacement = replaceInput.value;
		});

		const options = body.createDiv({ cls: "nb-modal-checks notebook-find-options" });
		this.checkbox(options, t("find.matchCase"), "matchCase");
		this.checkbox(options, t("find.wholeWord"), "wholeWord");

		this.status = body.createDiv({ cls: "nb-modal-note notebook-find-status", attr: { role: "status", "aria-live": "polite" } });
		this.list = body.createDiv({ cls: "notebook-find-results" });

		this.replaceOne = shellButton(shell.foot, "secondary", t("find.replaceOne"), () => this.doReplaceOne());
		this.replaceAll = shellButton(shell.foot, "danger", t("find.replaceAll"), () => this.doReplaceAll());
		this.refresh(-1);
		this.findInput.focus();
	}

	onClose(): void {
		this.flushTyping(false);
		this.contentEl.empty();
	}

	private checkbox(parent: HTMLElement, label: string, key: keyof FindOptions): void {
		shellCheck(parent, label, this.opts[key], (on) => {
			this.opts = { ...this.opts, [key]: on };
			this.flushTyping();
			this.refresh(this.active >= 0 ? 0 : -1);
		}).parentElement?.addClass("notebook-find-check");
	}

	// --- searching ---

	private typed(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.refresh(0);
		}, TYPING_MS);
	}

	/** Runs a pending search now (Enter, or an option changed). `search`: false when the panel is closing. */
	private flushTyping(search = true): void {
		if (this.timer === null) return;
		window.clearTimeout(this.timer);
		this.timer = null;
		if (search) this.query = this.findInput.value;
	}

	/** Searches again with the current query and shows the results; `active` is the result to choose (-1: none). */
	private refresh(active: number): void {
		this.query = this.findInput?.value ?? this.query;
		const doc = this.host.doc();
		this.result = doc ? findInDocument(doc, this.query, this.opts) : { hits: [], total: 0, boxes: 0, truncated: false };
		this.active = this.result.hits.length === 0 ? -1 : Math.max(0, Math.min(active, this.result.hits.length - 1));
		this.render();
	}

	private render(): void {
		const { hits, total, boxes, truncated } = this.result;
		const editable = this.host.canEdit();
		this.replaceOne.disabled = !editable || this.active < 0;
		this.replaceAll.disabled = !editable || total === 0;
		this.status.empty();
		if (this.query.length === 0) this.status.setText(t("find.prompt"));
		else if (total === 0) this.status.setText(t("find.none"));
		else this.status.setText(total === 1 && boxes === 1 ? t("find.count.one") : t("find.count", { n: String(total), boxes: String(boxes) }));
		if (!editable && this.query.length > 0 && total > 0) this.status.createDiv({ text: t("find.readOnly") });
		if (truncated) this.status.createDiv({ text: t("find.truncated", { shown: String(MAX_RESULTS) }) });
		this.list.empty();
		hits.forEach((hit, i) => this.row(hit, i));
	}

	private row(hit: TextHit, index: number): void {
		const row = this.list.createDiv({ cls: "notebook-find-row-result" });
		row.toggleClass("is-active", index === this.active);
		const main = row.createEl("button", { cls: "notebook-find-hit", attr: { type: "button" } });
		main.createSpan({ cls: "notebook-find-page", text: t("find.page", { n: String(hit.pageIndex + 1) }) });
		const text = main.createSpan({ cls: "notebook-find-snippet" });
		text.createSpan({ text: hit.before });
		text.createEl("mark", { text: hit.match });
		text.createSpan({ text: hit.after });
		main.addEventListener("click", () => this.choose(index, false));
		const go = row.createEl("button", { cls: "clickable-icon notebook-find-go", attr: { type: "button", "aria-label": t("find.goTo", { n: String(hit.pageIndex + 1) }) } });
		setIcon(go, "arrow-right");
		go.addEventListener("click", () => this.choose(index, true));
	}

	/** Makes result `index` the chosen one and shows its page; `close` also closes the panel (to see the page on a small screen). */
	private choose(index: number, close: boolean): void {
		const hit = this.result.hits[index];
		if (!hit) return;
		this.active = index;
		this.host.goTo(hit.pageIndex);
		if (close) {
			this.close();
			return;
		}
		this.render();
		this.list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
	}

	private step(delta: 1 | -1): void {
		const n = this.result.hits.length;
		if (n === 0) return;
		this.choose(this.active < 0 ? (delta === 1 ? 0 : n - 1) : (this.active + delta + n) % n, false);
	}

	// --- replacing ---

	private doReplaceOne(): void {
		this.flushTyping();
		const hit = this.result.hits[this.active];
		if (!hit || !this.host.canEdit()) return;
		const doc = this.host.doc();
		const cmd = doc ? replaceHitCommand(doc, hit, this.replacement, this.query, this.opts) : null;
		if (!cmd) {
			// The text box changed since the results were built (an edit in between).
			showNotice(t("find.changed"));
			this.refresh(this.active);
			return;
		}
		if (!this.host.run(cmd)) return;
		const fresh = findInDocument(doc!, this.query, this.opts);
		// On to the next match after the new text, so a replacement that contains the query is not found again.
		const next = nextHitIndex(fresh.hits, { pageIndex: hit.pageIndex, elementIndex: hit.elementIndex, offset: hit.start + this.replacement.length });
		this.result = fresh;
		this.active = fresh.hits.length === 0 ? -1 : next >= 0 ? next : 0;
		this.render();
		showNotice(t("find.replacedOne"));
		const shown = this.result.hits[this.active];
		if (shown) this.host.goTo(shown.pageIndex);
	}

	private doReplaceAll(): void {
		this.flushTyping();
		const doc = this.host.doc();
		if (!doc || !this.host.canEdit()) return;
		const plan = replaceAllCommand(doc, this.query, this.replacement, this.opts);
		if (!plan) return;
		if (!this.host.run(plan.command)) return;
		showNotice(t("find.replacedAll", { n: String(plan.replaced), boxes: String(plan.boxes) }));
		this.refresh(-1);
	}
}
