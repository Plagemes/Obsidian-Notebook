// 0.18 mentions (O7): the notes that link to a notebook page. Reads Obsidian's link index (`metadataCache.resolvedLinks` to find
// the notes that link to the notebook, `getFileCache(note).links / embeds` for the subpaths) and never writes. The sheet reads the
// text of each note lazily (cachedRead, bounded) only to show one line of context; a small count badge over the page area
// follows the page in view and is computed from the index alone.
import { Modal, setIcon, type App, type EventRef, type TFile } from "obsidian";
import { t } from "../i18n";
import { backlinksOf } from "../storage/backlinks";
import { splitLinktext } from "./hover-preview-logic";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import {
	contextSnippet, hitsOfNote, lineOf, linkersOf, mentionsMayChange, notebookMentions, noteLinksReach, pageMentionCount, pageMentions, sameLinkers, sourcesIntact, type MentionHit, type MentionRow, type RawLink,
} from "./mentions-logic";

/** Most notes whose links are read from the index, most links kept, most rows drawn in a group, most notes read for context. */
const MAX_NOTES = 400;
const MAX_HITS = 2000;
const MAX_ROWS = 60;
const MAX_READ_BYTES = 1_000_000;
const REFRESH_DELAY_MS = 600;

type Pages = ReadonlyArray<{ id: string }>;

/** The links and embeds of a note as the index has them (empty when it has no cache yet). */
function rawLinksOf(app: App, note: TFile): RawLink[] {
	const cache = app.metadataCache.getFileCache(note);
	if (!cache) return [];
	const out: RawLink[] = [];
	for (const l of cache.links ?? []) out.push({ link: l.link, line: l.position.start.line, col: l.position.start.col, endCol: l.position.end.col, embed: false });
	for (const l of cache.embeds ?? []) out.push({ link: l.link, line: l.position.start.line, col: l.position.start.col, endCol: l.position.end.col, embed: true });
	return out;
}

/** Every link to `file` in the vault's notes, from the index: no file is read. */
export function collectMentions(app: App, file: TFile, pages: Pages): MentionHit[] {
	const hits: MentionHit[] = [];
	const sources = backlinksOf(app, file.path).slice(0, MAX_NOTES);
	for (const path of sources) {
		const note = app.vault.getFileByPath(path);
		if (!note) continue;
		const links = rawLinksOf(app, note);
		const mine = hitsOfNote(path, links, (linkpath) => app.metadataCache.getFirstLinkpathDest(linkpath, path)?.path === file.path, pages);
		for (const h of mine) {
			if (hits.length >= MAX_HITS) return hits;
			hits.push(h);
		}
	}
	return hits;
}

export interface MentionsHost {
	app: App;
	/** The body of the view: the badge is placed in it. */
	body: HTMLElement;
	file(): TFile | null;
	pages(): Pages;
	/** Id of the page in view, or null. */
	currentPageId(): string | null;
	/** 1-based number of the page in view (0: none). */
	currentPageNumber(): number;
	register(ref: EventRef): void;
}

/** Keeps the hits for the open notebook up to date (debounced, from the index) and the badge in step with the page in view. */
export class Mentions {
	private hits: MentionHit[] = [];
	/** The notes the hits come from: a change of any other note that does not link here now cannot change them. */
	private sources = new Set<string>();
	/** The notes the link index had linking here when the hits were read. */
	private linkers = new Set<string>();
	private timer: number | null = null;
	private lastPath = "";
	private lastPages = -1;
	private readonly badge: HTMLButtonElement;
	private readonly countEl: HTMLElement;
	private destroyed = false;

	constructor(private readonly host: MentionsHost) {
		const badge = host.body.createEl("button", { cls: "nb-ui nb-mentions-badge", attr: { type: "button" } });
		setIcon(badge.createSpan({ cls: "nb-mentions-badge-icon", attr: { "aria-hidden": "true" } }), "links-coming-in");
		this.countEl = badge.createSpan({ cls: "nb-mentions-badge-count" });
		for (const type of ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown"] as const) badge.addEventListener(type, (e) => e.stopPropagation());
		badge.addEventListener("click", (e) => {
			e.preventDefault();
			this.open();
		});
		this.badge = badge;
		// Not every change of the vault: only when the set of notes that link here changed (the index may be ready only after the
		// notebook opened), or one of the notes we read is gone.
		host.register(host.app.metadataCache.on("resolved", () => {
			const file = host.file();
			const linkers = file ? linkersOf(host.app.metadataCache.resolvedLinks, file.path) : this.linkers;
			if (!sourcesIntact(this.sources, (p) => host.app.vault.getFileByPath(p) !== null) || !sameLinkers(this.linkers, linkers)) this.schedule();
		}));
		host.register(host.app.metadataCache.on("changed", (note) => this.noteChanged(note)));
	}

	/** Called whenever the page in view may have changed: re-reads the index when the notebook or its page count changed, then updates the badge. */
	sync(): void {
		const file = this.host.file();
		const pages = this.host.pages();
		if (file && (file.path !== this.lastPath || pages.length !== this.lastPages)) this.refresh();
		const n = pageMentionCount(this.hits, this.host.currentPageId());
		this.badge.toggleClass("is-visible", n > 0);
		this.countEl.setText(String(n));
		const label = t("mentions.badge.aria", { n: String(n) });
		this.badge.setAttribute("aria-label", label);
		this.badge.setAttribute("title", label);
	}

	private noteChanged(note: TFile): void {
		const file = this.host.file();
		if (!file) return;
		const app = this.host.app;
		const may = mentionsMayChange(note.path, file.path, this.sources, app.metadataCache.resolvedLinks[note.path], () =>
			noteLinksReach(app.metadataCache.getFileCache(note), (link) => app.metadataCache.getFirstLinkpathDest(splitLinktext(link).path, note.path)?.path === file.path));
		if (may) this.schedule();
	}

	private schedule(): void {
		if (this.destroyed || this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.refresh();
			this.sync();
		}, REFRESH_DELAY_MS);
	}

	private refresh(): void {
		const file = this.host.file();
		const pages = this.host.pages();
		this.lastPath = file?.path ?? "";
		this.lastPages = pages.length;
		this.hits = file ? collectMentions(this.host.app, file, pages) : [];
		this.sources = new Set(this.hits.map((h) => h.notePath));
		this.linkers = file ? linkersOf(this.host.app.metadataCache.resolvedLinks, file.path) : new Set();
	}

	/** The sheet, with the index read fresh. */
	open(): void {
		const file = this.host.file();
		if (!file) return;
		this.refresh();
		this.sync();
		new MentionsModal(this.host.app, file, this.hits, this.host.currentPageId(), this.host.currentPageNumber()).open();
	}

	destroy(): void {
		this.destroyed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.badge.remove();
	}
}

/** One link to show: a row of the group and the hit it opens. */
interface Line {
	row: MentionRow;
	hit: MentionHit;
}

const linesOf = (rows: readonly MentionRow[]): Line[] => rows.flatMap((row) => row.hits.map((hit) => ({ row, hit })));

class MentionsModal extends Modal {
	private cancelled = false;

	constructor(app: App, private readonly file: TFile, private readonly hits: readonly MentionHit[], private readonly pageId: string | null, private readonly pageNumber: number) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("mentions.title"), subtitle: this.file.basename, icon: "links-coming-in", size: "medium", cls: "notebook-mentions-modal" });
		const onPage = this.pageId ? linesOf(pageMentions(this.hits, this.pageId)) : [];
		const wholeNotebook = linesOf(notebookMentions(this.hits));
		const snippets: Array<{ line: Line; el: HTMLElement }> = [];
		if (onPage.length === 0 && wholeNotebook.length === 0) shellNote(shell.body, t("mentions.none"));
		if (this.pageId) this.group(shell.body, t("mentions.page", { n: String(this.pageNumber) }), onPage, t("mentions.page.none"), snippets);
		if (wholeNotebook.length > 0) this.group(shell.body, t("mentions.notebook"), wholeNotebook, "", snippets);
		shellButton(shell.foot, "secondary", t("create.close"), () => this.close());
		void this.readContext(snippets);
	}

	private group(parent: HTMLElement, title: string, lines: readonly Line[], empty: string, snippets: Array<{ line: Line; el: HTMLElement }>): void {
		const wrap = parent.createDiv({ cls: "nb-modal-section nb-mentions-group", attr: { role: "group", "aria-label": title } });
		wrap.createDiv({ cls: "nb-modal-section-title", text: `${title} · ${lines.length}` });
		const list = wrap.createDiv({ cls: "nb-modal-list" });
		if (lines.length === 0 && empty) shellNote(list, empty);
		for (const line of lines.slice(0, MAX_ROWS)) {
			const btn = list.createEl("button", { cls: "nb-mentions-row", attr: { type: "button" } });
			const head = btn.createDiv({ cls: "nb-mentions-head" });
			setIcon(head.createSpan({ cls: "nb-mentions-icon", attr: { "aria-hidden": "true" } }), line.hit.embed ? "image" : "file-text");
			head.createSpan({ cls: "nb-mentions-name", text: line.row.name });
			if (line.row.folder) head.createSpan({ cls: "nb-mentions-folder", text: line.row.folder });
			const snippet = btn.createDiv({ cls: "nb-mentions-snippet" });
			snippets.push({ line, el: snippet });
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				void this.openAt(line);
			});
		}
		if (lines.length > MAX_ROWS) shellNote(list, t("mentions.more", { n: String(lines.length - MAX_ROWS) }));
	}

	/** Opens the note at the line of the link (in a new tab: the notebook stays where it is). */
	private async openAt(line: Line): Promise<void> {
		const note = this.app.vault.getFileByPath(line.row.notePath);
		this.close();
		if (!note) return;
		try {
			await this.app.workspace.getLeaf("tab").openFile(note, { eState: { line: line.hit.line } });
		} catch (e) {
			console.error("[notebook] mentions open", e);
		}
	}

	/** Reads each note once (cached text, bounded) and fills the one-line context of its rows, a few at a time so the sheet stays responsive. */
	private async readContext(snippets: ReadonlyArray<{ line: Line; el: HTMLElement }>): Promise<void> {
		const texts = new Map<string, string | null>();
		let read = 0;
		for (const { line, el } of snippets) {
			if (this.cancelled) return;
			const path = line.row.notePath;
			if (!texts.has(path)) {
				const note = this.app.vault.getFileByPath(path);
				let text: string | null = null;
				if (note && note.stat.size <= MAX_READ_BYTES) {
					try {
						text = await this.app.vault.cachedRead(note);
					} catch {
						text = null;
					}
				}
				texts.set(path, text);
				if (++read % 6 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
			const text = texts.get(path);
			if (this.cancelled) return;
			if (text === null || text === undefined) {
				el.addClass("is-empty");
				continue;
			}
			const snippet = contextSnippet(lineOf(text, line.hit.line), line.hit.col, line.hit.endCol);
			if (snippet) el.setText(snippet);
			else el.addClass("is-empty");
		}
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}
}
