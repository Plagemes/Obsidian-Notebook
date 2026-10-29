import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { SearchHit } from "../pdf/text-index";

/** What the panel shows (the controller builds it; the panel keeps no search state of its own). */
export interface SearchView {
	hits: readonly SearchHit[];
	active: SearchHit | null;
	/** Notebook page number (1-based) of a hit. */
	pageNumber(hit: SearchHit): number;
	running: boolean;
	done: number;
	total: number;
	/** The result list was cut at its limit. */
	truncated: boolean;
	unreadable: boolean;
	/** The query is too short to search. */
	tooShort: boolean;
	/** There is nothing to search in (no PDF pages). */
	noPdf: boolean;
}

export interface SearchPanelActions {
	/** The text of the box changed (already debounced). */
	query(text: string): void;
	step(delta: 1 | -1): void;
	pick(index: number): void;
	close(): void;
}

/** Wait after the last keystroke before searching, ms. */
const TYPING_DELAY_MS = 250;
/** Events that must not reach the page below the panel or the view's shortcuts (Backspace deletes a selection). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

/**
 * The search bar over the page area: a box, the position among the results, previous / next, a list of results
 * (page and snippet) and close. It sits outside the stage so its taps never reach the pen input.
 */
export class SearchPanel {
	readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly count: HTMLElement;
	private readonly status: HTMLElement;
	private readonly list: HTMLElement;
	private readonly prev: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	private readonly listButton: HTMLButtonElement;
	private timer: number | null = null;
	private listOpen = true;
	private lastActive: SearchHit | null = null;
	private lastRendered: readonly SearchHit[] | null = null;

	constructor(parent: HTMLElement, private readonly actions: SearchPanelActions, private readonly narrow: () => boolean) {
		this.el = parent.createDiv({ cls: "notebook-search notebook-hidden", attr: { role: "search", "aria-label": t("reading.search") } });
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		const bar = this.el.createDiv({ cls: "notebook-search-bar" });
		this.input = bar.createEl("input", {
			cls: "notebook-search-input",
			attr: { type: "search", placeholder: t("reading.search.placeholder"), "aria-label": t("reading.search.placeholder"), spellcheck: "false", autocomplete: "off", enterkeyhint: "search" },
		});
		this.input.addEventListener("input", () => this.typed());
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.flushTyping();
				this.actions.step(e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.actions.close();
			}
		});
		this.count = bar.createSpan({ cls: "notebook-search-count", attr: { role: "status", "aria-live": "polite" } });
		this.prev = this.button(bar, "chevron-up", "reading.search.prev", () => this.actions.step(-1));
		this.next = this.button(bar, "chevron-down", "reading.search.next", () => this.actions.step(1));
		this.listButton = this.button(bar, "list", "reading.search.list", () => {
			this.listOpen = !this.listOpen;
			this.syncList();
		});
		this.button(bar, "x", "reading.search.close", () => this.actions.close());
		this.status = this.el.createDiv({ cls: "notebook-search-status notebook-hidden", attr: { role: "status" } });
		this.list = this.el.createDiv({ cls: "notebook-search-list", attr: { role: "listbox", "aria-label": t("reading.search.list") } });
		this.syncList();
	}

	get isOpen(): boolean {
		return !this.el.hasClass("notebook-hidden");
	}

	/** Height of the panel in CSS px (what it covers at the top of the page area). */
	get height(): number {
		return this.isOpen ? this.el.offsetHeight : 0;
	}

	get query(): string {
		return this.input.value;
	}

	open(): void {
		this.el.removeClass("notebook-hidden");
		this.input.focus();
		this.input.select();
	}

	close(): void {
		this.flushTimer();
		this.el.addClass("notebook-hidden");
		this.input.blur();
		this.lastActive = null;
		this.lastRendered = null;
	}

	destroy(): void {
		this.flushTimer();
		this.el.remove();
	}

	/** Shows the current state of the search. Cheap enough to call a few times a second while results stream in. */
	render(v: SearchView): void {
		const n = v.hits.length;
		const index = v.active ? v.hits.indexOf(v.active) : -1;
		this.count.setText(n > 0 ? `${index + 1} / ${n}${v.truncated ? "+" : ""}` : "");
		this.prev.disabled = n === 0;
		this.next.disabled = n === 0;
		this.listButton.disabled = n === 0;

		let message = "";
		if (v.noPdf) message = t("reading.search.noPdf");
		else if (v.tooShort && this.input.value.trim().length > 0) message = t("reading.search.minChars");
		else if (v.running) message = t("reading.search.searching", { done: String(v.done), total: String(v.total) });
		else if (v.truncated) message = t("reading.search.truncated", { n: String(n) });
		else if (n === 0 && !v.tooShort && this.input.value.trim().length > 0) message = t("reading.search.none");
		if (v.unreadable && !v.running) message = message ? `${message} ${t("reading.search.unreadable")}` : t("reading.search.unreadable");
		this.status.setText(message);
		this.status.toggleClass("notebook-hidden", message === "");

		// The list is rebuilt only when the hits changed; moving the active hit only moves the highlight.
		if (this.lastRendered !== v.hits || this.list.childElementCount !== n) this.buildList(v);
		this.markActive(v);
	}

	private buildList(v: SearchView): void {
		this.lastRendered = v.hits;
		this.list.empty();
		v.hits.forEach((hit, i) => {
			const row = this.list.createEl("button", { cls: "notebook-search-row", attr: { type: "button", role: "option", "aria-selected": "false" } });
			row.createSpan({ cls: "notebook-search-page", text: t("reading.search.page", { n: String(v.pageNumber(hit)) }) });
			const text = row.createSpan({ cls: "notebook-search-snippet" });
			const s = hit.snippet;
			text.appendText(`${s.cutBefore ? "… " : ""}${s.before}`);
			text.createEl("mark", { text: s.match });
			text.appendText(`${s.after}${s.cutAfter ? " …" : ""}`);
			row.addEventListener("click", (e) => {
				e.preventDefault();
				this.actions.pick(i);
				if (this.narrow()) {
					this.listOpen = false;
					this.syncList();
				}
			});
		});
		this.lastActive = null;
		this.syncList();
	}

	private markActive(v: SearchView): void {
		if (v.active === this.lastActive) return;
		this.lastActive = v.active;
		const index = v.active ? v.hits.indexOf(v.active) : -1;
		this.list.querySelectorAll(".is-active").forEach((el) => {
			el.removeClass("is-active");
			el.setAttribute("aria-selected", "false");
		});
		const row = index >= 0 ? this.list.children.item(index) : null;
		if (row instanceof HTMLElement) {
			row.addClass("is-active");
			row.setAttribute("aria-selected", "true");
			row.scrollIntoView({ block: "nearest" });
		}
	}

	private syncList(): void {
		const show = this.listOpen && this.list.childElementCount > 0;
		this.list.toggleClass("notebook-hidden", !show);
		this.listButton.toggleClass("is-active", this.listOpen);
		this.listButton.setAttribute("aria-pressed", String(this.listOpen));
	}

	private typed(): void {
		this.flushTimer();
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.actions.query(this.input.value);
		}, TYPING_DELAY_MS);
	}

	/** Searches at once what is in the box (Enter does not wait for the typing delay). */
	private flushTyping(): void {
		if (this.timer === null) return;
		this.flushTimer();
		this.actions.query(this.input.value);
	}

	private flushTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private button(parent: HTMLElement, icon: string, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-tool clickable-icon", attr: { type: "button", "aria-label": t(label), title: t(label) } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}
}
