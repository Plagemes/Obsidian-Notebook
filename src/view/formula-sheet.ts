// 0.23 (#249) Formula sheet: the dialog and the vault side. "Build formula sheet" collects every equation element of the notebook in reading
// order and writes them as Markdown maths (with a link back to each page) into the note "<Notebook> — Formulas.md" next to the notebook.
// The note is derived data: only the part between the formula markers is rewritten (vault.process, re-read inside it); a note of the user's
// with that name and no markers (or one marker missing) is never touched, and neither is a region that records another notebook: the sheet
// goes to the next free name (" (2)"), so a build is never a dead end.
// The notebook file is never written.
import { Modal, TFile, normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { stablePageSubpath } from "../integration/page-links";
import {
	buildFormulaSection, collectFormulas, formulaRegionOf, groupByPage, newFormulaNote, pickFormulaNote, replaceFormulaSection, type FormulaEntry,
} from "../model/formula-sheet";
import type { Page } from "../model/types";
import { recordPluginWrite } from "../storage/plugin-written";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";

/** Name of the formula note, without the folder; `n` > 1 gives the disambiguated `Formulas (2)`. */
export function formulaNoteName(notebook: TFile, n = 1): string {
	return `${sanitizeName(notebook.basename) || "Notebook"} — Formulas${n > 1 ? ` (${n})` : ""}.md`;
}

/** Vault path of the formula note of `notebook`: next to it. */
export function formulaNotePath(notebook: TFile, n = 1): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${formulaNoteName(notebook, n)}`);
}

/** The path of the formula note to write for `notebook`: its plain name, or `(2)`... when that note belongs to another notebook. */
export async function resolveFormulaNotePath(app: App, notebook: TFile, docId?: string): Promise<string | null> {
	const n = await pickFormulaNote(async (i) => {
		const found = app.vault.getAbstractFileByPath(formulaNotePath(notebook, i));
		if (!found) return { exists: false };
		if (!(found instanceof TFile)) return { exists: true, folder: true };
		const text = await app.vault.cachedRead(found);
		// An empty note is free to use (the writer fills it); one with text of the user's and no complete region of ours is skipped.
		if (text.trim() === "") return { exists: false };
		const region = formulaRegionOf(text);
		if (!region) return { exists: true, owner: undefined };
		return { exists: true, owner: region.path, ownerId: region.id, ownerGone: region.path !== null && app.vault.getAbstractFileByPath(region.path) === null };
	}, notebook.path, docId);
	return n === null ? null : formulaNotePath(notebook, n);
}

export interface FormulaSheetHost {
	app: App;
	file: TFile;
	/** The notebook's document id: recorded in the note, so a rename or move keeps it. */
	docId?: string;
	pages: () => readonly Page[];
	/** Scrolls to page `index` (0-based) with page y `y` near the top. */
	goTo: (index: number, y: number) => void;
}

/** Writes the sheet into the note next to the notebook. Returns the note's path or null (nothing to write, an unsafe or foreign note, a failure: the reason is shown). */
export async function writeFormulaNote(host: FormulaSheetHost): Promise<string | null> {
	const { app, file } = host;
	const entries = collectFormulas(host.pages());
	const notePath = await resolveFormulaNotePath(app, file, host.docId);
	if (notePath === null) {
		showNotice(t("formulasheet.failed", { error: formulaNotePath(file) }), 10000);
		return null;
	}
	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing && !(existing instanceof TFile)) {
		showNotice(t("formulasheet.failed", { error: notePath }), 10000);
		return null;
	}
	if (entries.length === 0 && !existing) {
		showNotice(t("formulasheet.none"), 6000);
		return null;
	}
	const section = buildFormulaSection({
		entries,
		pageLink: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("formulasheet.page", { n: String(n) })),
		intro: t("formulasheet.intro", { link: app.fileManager.generateMarkdownLink(file, notePath, undefined, file.basename), n: String(entries.length), pages: String(groupByPage(entries).length) }),
		none: t("formulasheet.empty"),
		owner: file.path,
		ownerId: host.docId,
	});
	try {
		if (existing instanceof TFile) {
			const state: { outcome: "ok" | "unsafe" | "foreign" | "other" } = { outcome: "ok" };
			await app.vault.process(existing, (current) => {
				const r = replaceFormulaSection(current, section, file.path, { id: host.docId, pathExists: (p) => app.vault.getAbstractFileByPath(p) !== null });
				if (r.outcome === "unsafe") state.outcome = "unsafe";
				else if (r.outcome === "appended") state.outcome = "foreign";
				else if (r.outcome === "other") state.outcome = "other";
				return r.outcome === "replaced" || r.outcome === "created" ? r.text : current;
			});
			if (state.outcome !== "ok") {
				showNotice(t(state.outcome === "other" ? "formulasheet.other" : state.outcome === "unsafe" ? "formulasheet.unsafe" : "formulasheet.foreign", { path: notePath }), 12000);
				return null;
			}
		} else {
			recordPluginWrite(app, [notePath]);
			await app.vault.create(notePath, newFormulaNote(`${file.basename} — ${t("formulasheet.title")}`, section));
		}
		showNotice(t("formulasheet.done", { path: notePath, n: String(entries.length) }), 8000);
		return notePath;
	} catch (e) {
		console.error("[notebook] formula sheet", e);
		showNotice(t("formulasheet.failed", { error: (e as Error).message }), 10000);
		return null;
	}
}

/** The dialog: the formulas of the notebook in reading order (LaTeX source and a page chip that jumps) and "Build formula sheet". */
export class FormulaSheetModal extends Modal {
	constructor(private readonly fs: FormulaSheetHost) {
		super(fs.app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("formulasheet.title"), icon: "sigma", size: "medium", cls: "notebook-formulasheet-modal", subtitle: t("formulasheet.subtitle") });
		const entries = collectFormulas(this.fs.pages());
		shellNote(shell.body, entries.length === 0 ? t("formulasheet.empty") : t("formulasheet.summary", { n: String(entries.length), pages: String(groupByPage(entries).length) }));
		const list = shell.body.createDiv({ cls: "nb-formulasheet-list" });
		for (const g of groupByPage(entries)) {
			const block = list.createDiv({ cls: "nb-formulasheet-page", attr: { role: "group", "aria-label": t("formulasheet.page", { n: String(g.pageIndex + 1) }) } });
			const first = g.entries[0];
			const chip = block.createEl("button", { cls: "nb-formulasheet-ref", text: t("formulasheet.page", { n: String(g.pageIndex + 1) }), attr: { type: "button", "aria-label": t("formulasheet.goto", { n: String(g.pageIndex + 1) }) } });
			chip.addEventListener("click", () => {
				this.close();
				this.fs.goTo(g.pageIndex, Math.max(0, (first?.y ?? 0) - 24));
			});
			const codes = block.createDiv({ cls: "nb-formulasheet-codes" });
			for (const f of g.entries) codes.createEl("code", { cls: "nb-formulasheet-code", text: preview(f) });
		}
		shellButton(shell.foot, "secondary", t("formulasheet.close"), () => this.close());
		shellButton(shell.foot, "primary", t("formulasheet.write"), () => void writeFormulaNote(this.fs), { icon: "file-text" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** One line of the formula's source for the list (the whole source is written to the note). */
function preview(f: FormulaEntry): string {
	const one = f.latex.replace(/\s+/g, " ");
	return Array.from(one).length > 140 ? `${Array.from(one).slice(0, 139).join("")}…` : one;
}
