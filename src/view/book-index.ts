// 0.21 (#187) Back-of-book index: the dialogs and the vault side. "Add to index…" turns a lasso selection into an ordinary star marker whose
// label is `<prefix> <term>` (settings: indexPrefix); the index dialog lists the terms A-Z with their pages (a tap on a page goes there)
// and can write the same list into the note "<Notebook> — Index.md" next to the notebook. The note is derived data: only the part between
// the index markers is rewritten (vault.process); a note of the user's with that name and no markers is never touched, and a note whose
// start marker records another notebook is never rewritten (the name gets " (2)" instead).
import { Modal, TFile, getLanguage, normalizePath, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { stablePageSubpath } from "../integration/page-links";
import {
	buildIndex, buildIndexSection, collectIndexEntries, filterIndex, indexCounts, indexLabel, indexRegionOf, newIndexNote, pickIndexNote, replaceIndexSection, type IndexSection, type IndexTerm,
} from "../model/book-index";
import type { Page } from "../model/types";
import { recordPluginWrite } from "../storage/plugin-written";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";

/** Name of the index note, without the folder; `n` > 1 gives the disambiguated `Index (2)`. */
export function indexNoteName(notebook: TFile, n = 1): string {
	return `${sanitizeName(notebook.basename) || "Notebook"} — Index${n > 1 ? ` (${n})` : ""}.md`;
}

/** Vault path of the index note of `notebook`: next to it. */
export function indexNotePath(notebook: TFile, n = 1): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${indexNoteName(notebook, n)}`);
}

/** The path of the index note to write for `notebook`: its plain name, or `(2)`... when that note belongs to another notebook. */
export async function resolveIndexNotePath(app: App, notebook: TFile, docId?: string): Promise<string | null> {
	const n = await pickIndexNote(async (i) => {
		const found = app.vault.getAbstractFileByPath(indexNotePath(notebook, i));
		if (!found) return { exists: false };
		if (!(found instanceof TFile)) return { exists: true, folder: true };
		const region = indexRegionOf(await app.vault.cachedRead(found));
		if (!region) return { exists: true, owner: undefined };
		return { exists: true, owner: region.path, ownerId: region.id, ownerGone: region.path !== null && app.vault.getAbstractFileByPath(region.path) === null };
	}, notebook.path, docId);
	return n === null ? null : indexNotePath(notebook, n);
}

/** The index of the pages now (locale: the plugin's language). */
export function currentIndex(pages: readonly Page[], prefix: string): IndexSection[] {
	return buildIndex(collectIndexEntries(pages, prefix), getLanguage());
}

export interface BookIndexHost {
	app: App;
	file: TFile;
	/** The notebook's document id: recorded in the index note, so a rename or move keeps the note (review W21 N1). */
	docId?: string;
	prefix: string;
	pages: () => readonly Page[];
	/** Scrolls to page `index` (0-based) with page y `y` near the top. */
	goTo: (index: number, y: number) => void;
}

/** Writes the index into the note next to the notebook. Returns the note's path or null (nothing to write, an unsafe or foreign note, a failure: the reason is shown). */
export async function writeIndexNote(host: BookIndexHost): Promise<string | null> {
	const { app, file } = host;
	const sections = currentIndex(host.pages(), host.prefix);
	const notePath = await resolveIndexNotePath(app, file, host.docId);
	if (notePath === null) {
		showNotice(t("bookindex.failed", { error: indexNotePath(file) }), 10000);
		return null;
	}
	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing && !(existing instanceof TFile)) {
		showNotice(t("bookindex.failed", { error: notePath }), 10000);
		return null;
	}
	if (sections.length === 0 && !existing) {
		showNotice(t("bookindex.none"), 6000);
		return null;
	}
	const counts = indexCounts(sections);
	const section = buildIndexSection({
		sections,
		pageLink: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("bookindex.page", { n: String(n) })),
		intro: t("bookindex.intro", { link: app.fileManager.generateMarkdownLink(file, notePath, undefined, file.basename), terms: String(counts.terms), pages: String(counts.pages) }),
		none: t("bookindex.empty"),
		owner: file.path,
		ownerId: host.docId,
	});
	try {
		if (existing instanceof TFile) {
			const state: { outcome: "ok" | "unsafe" | "foreign" | "other" } = { outcome: "ok" };
			await app.vault.process(existing, (current) => {
				const r = replaceIndexSection(current, section, file.path, { id: host.docId, pathExists: (p) => app.vault.getAbstractFileByPath(p) !== null });
				if (r.outcome === "unsafe") state.outcome = "unsafe";
				else if (r.outcome === "appended") state.outcome = "foreign";
				else if (r.outcome === "other") state.outcome = "other";
				return r.outcome === "replaced" || r.outcome === "created" ? r.text : current;
			});
			if (state.outcome === "other") {
				showNotice(t("bookindex.other", { path: notePath }), 12000);
				return null;
			}
			if (state.outcome === "unsafe") {
				showNotice(t("bookindex.unsafe", { path: notePath }), 12000);
				return null;
			}
			if (state.outcome === "foreign") {
				showNotice(t("bookindex.foreign", { path: notePath }), 12000);
				return null;
			}
		} else {
			recordPluginWrite(app, [notePath]);
			await app.vault.create(notePath, newIndexNote(`${file.basename} — ${t("bookindex.title")}`, section));
		}
		showNotice(t("bookindex.done", { path: notePath, n: String(counts.terms) }), 8000);
		return notePath;
	} catch (e) {
		console.error("[notebook] book index", e);
		showNotice(t("bookindex.failed", { error: (e as Error).message }), 10000);
		return null;
	}
}

/** The index dialog: a filter, the terms A-Z with a chip per page, "Write to note". */
export class BookIndexModal extends Modal {
	private query = "";
	private listEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;

	constructor(private readonly ix: BookIndexHost) {
		super(ix.app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("bookindex.title"), icon: "book-a", size: "medium", cls: "notebook-bookindex-modal", subtitle: t("bookindex.subtitle", { prefix: this.ix.prefix }) });
		const field = shellField(shell.body, t("bookindex.filter"), "nb-bookindex-filter");
		const input = field.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-bookindex-filter", type: "search", autocomplete: "off", placeholder: t("bookindex.filter.placeholder") } });
		input.addEventListener("input", () => {
			this.query = input.value;
			this.renderList();
		});
		this.summaryEl = shellNote(shell.body, "");
		this.listEl = shell.body.createDiv({ cls: "nb-bookindex-list" });
		this.renderList();
		shellButton(shell.foot, "secondary", t("bookindex.close"), () => this.close());
		shellButton(shell.foot, "primary", t("bookindex.write"), () => void writeIndexNote(this.ix), { icon: "file-text" });
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const all = currentIndex(this.ix.pages(), this.ix.prefix);
		const counts = indexCounts(all);
		this.summaryEl?.setText(all.length === 0 ? t("bookindex.empty") : t("bookindex.summary", { terms: String(counts.terms), pages: String(counts.pages) }));
		const sections = filterIndex(all, this.query);
		if (all.length > 0 && sections.length === 0) {
			list.createDiv({ cls: "nb-modal-note", text: t("bookindex.noMatch") });
			return;
		}
		for (const s of sections) {
			const block = list.createDiv({ cls: "nb-bookindex-section", attr: { role: "group", "aria-label": s.letter } });
			block.createDiv({ cls: "nb-bookindex-letter", text: s.letter });
			const emit = (term: IndexTerm, depth: number) => {
				const row = block.createDiv({ cls: "nb-bookindex-term" });
				row.setCssProps({ "--nb-index-depth": String(depth) });
				row.createSpan({ cls: "nb-bookindex-name", text: term.name });
				const refs = row.createSpan({ cls: "nb-bookindex-refs" });
				for (const r of term.refs) {
					const chip = refs.createEl("button", { cls: "nb-bookindex-ref", text: String(r.pageIndex + 1), attr: { type: "button", "aria-label": t("bookindex.goto", { n: String(r.pageIndex + 1), term: term.name }) } });
					chip.addEventListener("click", () => {
						this.close();
						this.ix.goTo(r.pageIndex, Math.max(0, r.y - 24));
					});
				}
				term.children.forEach((c) => emit(c, depth + 1));
			};
			s.terms.forEach((term) => emit(term, 0));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The terms in use, flattened to "Parent / Child" spellings (for the suggestions of the add dialog). */
export function termSpellings(sections: readonly IndexSection[]): string[] {
	const out: string[] = [];
	const walk = (term: IndexTerm, parents: string[]) => {
		const path = [...parents, term.name];
		if (term.refs.length > 0) out.push(path.join(" / "));
		term.children.forEach((c) => walk(c, path));
	};
	sections.forEach((s) => s.terms.forEach((term) => walk(term, [])));
	return out;
}

/** "Add to index…": asks for the term (suggesting the ones already in use) and calls `add` with the marker label. */
export class AddToIndexModal extends Modal {
	private term = "";
	private suggestionsEl: HTMLElement | null = null;
	private input: HTMLInputElement | null = null;

	constructor(app: App, private readonly prefix: string, private readonly existing: readonly string[], private readonly add: (label: string) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("bookindex.add.title"), icon: "book-a", size: "narrow", cls: "notebook-bookindex-add", subtitle: t("bookindex.add.hint") });
		const field = shellField(shell.body, t("bookindex.add.term"), "nb-bookindex-term");
		const input = field.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-bookindex-term", type: "text", maxlength: "200", autocomplete: "off", placeholder: t("bookindex.add.placeholder") } });
		this.input = input;
		this.suggestionsEl = shell.body.createDiv({ cls: "nb-bookindex-suggest" });
		const submit = () => {
			const label = indexLabel(this.term, this.prefix);
			if (!label) {
				input.focus();
				return;
			}
			this.close();
			this.add(label);
		};
		input.addEventListener("input", () => {
			this.term = input.value;
			this.renderSuggestions();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		this.renderSuggestions();
		shellButton(shell.foot, "secondary", t("bookindex.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("bookindex.add.button"), submit, { icon: "plus" });
		window.setTimeout(() => input.focus(), 0);
	}

	private renderSuggestions(): void {
		const box = this.suggestionsEl;
		if (!box) return;
		box.empty();
		const q = this.term.trim().toLowerCase();
		const shown = this.existing.filter((s) => s.toLowerCase() !== q && (q === "" || s.toLowerCase().includes(q))).slice(0, 8);
		for (const s of shown) {
			const b = box.createEl("button", { cls: "nb-bookindex-suggestion", attr: { type: "button" } });
			setIcon(b.createSpan({ cls: "nb-bookindex-suggestion-icon", attr: { "aria-hidden": "true" } }), "corner-down-right");
			b.createSpan({ text: s });
			b.addEventListener("click", () => {
				this.term = s;
				if (this.input) {
					this.input.value = s;
					this.input.focus();
				}
				this.renderSuggestions();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
