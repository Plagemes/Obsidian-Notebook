/**
 * Z5: the "Cards to link" part of the card dialog. The linking itself is done by the zettel service, in the task that creates
 * the card (`CardAnswer.links`), so the links always go to the note that was made from this dialog.
 *
 * Cheap on purpose: the candidates are read once, when the dialog opens, from the card index already in memory and the
 * metadata cache (no note is read); typing only re-ranks that bounded list, a moment after the last key.
 */
import { type App } from "obsidian";
import { t } from "../i18n";
import { setIconSafe } from "../ui/components/dom";
import type { CardRecord } from "./card-content";
import { boundCandidates, clampCount, rankLinkSuggestions, type LinkCandidate, type LinkQuery, type LinkSuggestion } from "./link-suggest";

/** What the dialog needs from the plugin; registered once from onload. */
export interface LinkSuggestHost {
	settings(): { zettelLinkSuggest: boolean; zettelLinkSuggestCount: number };
	service(): { allCards(): CardRecord[] } | undefined;
}

let host: LinkSuggestHost | null = null;

export function setLinkSuggestHost(h: LinkSuggestHost | null): void {
	host = h;
}

/** Whether the dialog should offer suggestions (setting on, service up). */
export function linkSuggestOn(): boolean {
	try {
		return !!host && host.settings().zettelLinkSuggest && !!host.service();
	} catch {
		return false;
	}
}

function tagsOf(fm: Record<string, unknown> | undefined): string[] {
	const raw = fm?.tags;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
	return list.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** The cards that can be linked, from memory and the metadata cache (no file is read). */
export function collectCandidates(app: App, cards: readonly CardRecord[]): { candidates: LinkCandidate[]; records: Map<string, CardRecord> } {
	const records = new Map<string, CardRecord>();
	const candidates: LinkCandidate[] = [];
	for (const card of cards) {
		if (card.orphaned) continue;
		const file = app.vault.getFileByPath(card.path);
		if (!file) continue;
		records.set(card.path, card);
		candidates.push({ path: card.path, id: card.id, title: card.title || card.id, tags: tagsOf(app.metadataCache.getFileCache(file)?.frontmatter), mtime: file.stat.mtime });
	}
	return { candidates: boundCandidates(candidates), records };
}

const DEBOUNCE_MS = 250;

/**
 * The suggestion field of the dialog. `query()` returns what has been typed; `changed()` must be called after each edit.
 * Returns null when suggestions are off.
 */
export class LinkSuggestField {
	private readonly chosen = new Map<string, CardRecord>();
	private readonly candidates: LinkCandidate[];
	private readonly records: Map<string, CardRecord>;
	private readonly list: HTMLElement;
	private readonly count: number;
	private timer: number | null = null;

	private constructor(parent: HTMLElement, app: App, cards: CardRecord[], private readonly query: () => LinkQuery) {
		const found = collectCandidates(app, cards);
		this.candidates = found.candidates;
		this.records = found.records;
		this.count = clampCount(host?.settings().zettelLinkSuggestCount);
		const wrap = parent.createDiv({ cls: "nb-zk-field nb-zk-suggest" });
		wrap.createDiv({ cls: "nb-zk-label", text: t("zettel.suggest.title") });
		wrap.createDiv({ cls: "nb-zk-field-hint", text: t("zettel.suggest.hint") });
		this.list = wrap.createDiv({ cls: "nb-zk-suggest-list", attr: { role: "group", "aria-label": t("zettel.suggest.title") } });
		this.paint();
	}

	static create(parent: HTMLElement, app: App, query: () => LinkQuery): LinkSuggestField | null {
		if (!linkSuggestOn()) return null;
		const service = host?.service();
		if (!service) return null;
		return new LinkSuggestField(parent, app, service.allCards(), query);
	}

	/** Re-rank a moment after the last edit. */
	changed(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.paint();
		}, DEBOUNCE_MS);
	}

	/** The cards the person tapped. */
	chosenCards(): CardRecord[] {
		return [...this.chosen.values()];
	}

	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private reason(s: LinkSuggestion): string {
		if (s.sharedTags.length > 0) return t("zettel.suggest.tags", { tags: s.sharedTags.map((x) => `#${x}`).join(" ") });
		if (s.sharedWords.length > 0) return t("zettel.suggest.words", { words: s.sharedWords.slice(0, 3).join(", ") });
		return t("zettel.suggest.titleMatch");
	}

	private paint(): void {
		this.list.empty();
		for (const card of this.chosen.values()) this.row(card.title || card.id, card.id, t("zettel.suggest.chosen"), card);
		const ranked = rankLinkSuggestions(this.query(), this.candidates, this.count, new Set(this.chosen.keys()));
		for (const s of ranked) {
			const record = this.records.get(s.candidate.path);
			if (record) this.row(s.candidate.title, s.candidate.id, this.reason(s), record);
		}
		if (this.list.childElementCount === 0) this.list.createDiv({ cls: "nb-zk-suggest-empty", text: t("zettel.suggest.empty") });
	}

	private row(title: string, id: string, reason: string, card: CardRecord): void {
		const on = this.chosen.has(card.path);
		const btn = this.list.createEl("button", { cls: "nb-zk-suggest-row", attr: { type: "button", "aria-pressed": String(on) } });
		btn.toggleClass("is-active", on);
		setIconSafe(btn.createSpan({ cls: "nb-icon-square is-small", attr: { "aria-hidden": "true" } }), on ? "check" : "link");
		const text = btn.createSpan({ cls: "nb-zk-suggest-text" });
		text.createSpan({ cls: "nb-zk-suggest-title", text: title });
		text.createSpan({ cls: "nb-zk-suggest-reason", text: `${id} · ${reason}` });
		btn.addEventListener("click", () => {
			if (this.chosen.has(card.path)) this.chosen.delete(card.path);
			else this.chosen.set(card.path, card);
			this.paint();
		});
	}
}
