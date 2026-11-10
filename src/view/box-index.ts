// 0.28 (#205) Index of the numbered definitions and theorems: the dialog (kind, number, title, page, jump to the box) and the plugin-owned
// note "<Notebook> — Definitions.md" next to the notebook. Same rules as the formula sheet: only the part between the markers is
// rewritten (vault.process, re-read inside it); a note of the user's with that name and no markers is never touched, the index goes to the
// next free name. The notebook file is never written.
import { Modal, TFile, normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { stablePageSubpath } from "../integration/page-links";
import {
	boxesRegionOf, buildBoxesSection, newBoxesNote, numberLabel, pickBoxesNote, replaceBoxesSection, type NumberedBox,
} from "../model/box-numbering";
import { recordPluginWrite } from "../storage/plugin-written";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { boxAbbreviations, boxNames } from "./box-numbers";
import { showNotice } from "./notice";

export function boxesNotePath(notebook: TFile, n = 1): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${sanitizeName(notebook.basename) || "Notebook"} — Definitions${n > 1 ? ` (${n})` : ""}.md`);
}

export async function resolveBoxesNotePath(app: App, notebook: TFile, docId?: string): Promise<string | null> {
	const n = await pickBoxesNote(async (i) => {
		const found = app.vault.getAbstractFileByPath(boxesNotePath(notebook, i));
		if (!found) return { exists: false };
		if (!(found instanceof TFile)) return { exists: true, folder: true };
		const text = await app.vault.cachedRead(found);
		if (text.trim() === "") return { exists: false };
		const region = boxesRegionOf(text);
		if (!region) return { exists: true, owner: undefined };
		return { exists: true, owner: region.path, ownerId: region.id, ownerGone: region.path !== null && app.vault.getAbstractFileByPath(region.path) === null };
	}, notebook.path, docId);
	return n === null ? null : boxesNotePath(notebook, n);
}

export interface BoxIndexHost {
	app: App;
	file: TFile;
	docId?: string;
	/** The numbered boxes in reading order (already redacted: a box under a redaction box is not listed). */
	items: () => readonly NumberedBox[];
	/** Scrolls to page `index` (0-based) with page y `y` near the top. */
	goTo: (index: number, y: number) => void;
}

export async function writeBoxesNote(host: BoxIndexHost): Promise<string | null> {
	const { app, file } = host;
	const items = host.items();
	const notePath = await resolveBoxesNotePath(app, file, host.docId);
	if (notePath === null) {
		showNotice(t("boxindex.failed", { error: boxesNotePath(file) }), 10000);
		return null;
	}
	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing && !(existing instanceof TFile)) {
		showNotice(t("boxindex.failed", { error: notePath }), 10000);
		return null;
	}
	if (items.length === 0 && !existing) {
		showNotice(t("boxindex.none"), 6000);
		return null;
	}
	const section = buildBoxesSection({
		items, names: boxNames(), abbr: boxAbbreviations(),
		pageLink: (n, id) => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(n, id), t("boxindex.page", { n: String(n) })),
		intro: t("boxindex.intro", { link: app.fileManager.generateMarkdownLink(file, notePath, undefined, file.basename), n: String(items.length) }),
		none: t("boxindex.empty"),
		owner: file.path,
		ownerId: host.docId,
	});
	try {
		if (existing instanceof TFile) {
			const state: { outcome: "ok" | "unsafe" | "foreign" | "other" } = { outcome: "ok" };
			await app.vault.process(existing, (current) => {
				const r = replaceBoxesSection(current, section, file.path, { id: host.docId, pathExists: (p) => app.vault.getAbstractFileByPath(p) !== null });
				if (r.outcome === "unsafe") state.outcome = "unsafe";
				else if (r.outcome === "appended") state.outcome = "foreign";
				else if (r.outcome === "other") state.outcome = "other";
				return r.outcome === "replaced" || r.outcome === "created" ? r.text : current;
			});
			if (state.outcome !== "ok") {
				showNotice(t(state.outcome === "other" ? "boxindex.other" : state.outcome === "unsafe" ? "boxindex.unsafe" : "boxindex.foreign", { path: notePath }), 12000);
				return null;
			}
		} else {
			recordPluginWrite(app, [notePath]);
			await app.vault.create(notePath, newBoxesNote(`${file.basename} — ${t("boxindex.noteTitle")}`, section));
		}
		showNotice(t("boxindex.done", { path: notePath, n: String(items.length) }), 8000);
		return notePath;
	} catch (e) {
		console.error("[notebook] box index", e);
		showNotice(t("boxindex.failed", { error: (e as Error).message }), 10000);
		return null;
	}
}

/** The dialog: every numbered box in reading order; a row jumps to the box; "Write index note" saves the list as a note. */
export class BoxIndexModal extends Modal {
	constructor(private readonly bx: BoxIndexHost, private readonly numbered: boolean) {
		super(bx.app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("boxindex.title"), icon: "list-ordered", size: "medium", cls: "notebook-boxindex-modal", subtitle: t("boxindex.subtitle") });
		const items = this.bx.items();
		const abbr = boxAbbreviations();
		const names = boxNames();
		shellNote(shell.body, items.length === 0 ? t("boxindex.empty") : t("boxindex.summary", { n: String(items.length) }));
		if (!this.numbered && items.length > 0) shellNote(shell.body, t("boxindex.off"));
		const list = shell.body.createDiv({ cls: "nb-boxindex-list", attr: { role: "list" } });
		for (const it of items) {
			const label = this.numbered ? numberLabel(it.kind, it.number, abbr) : names[it.kind];
			const row = list.createEl("button", {
				cls: `nb-boxindex-row nb-boxindex-${it.kind}`, attr: { type: "button", role: "listitem", "aria-label": t("boxindex.goto", { label: it.title ? `${label} ${it.title}` : label, n: String(it.pageIndex + 1) }) },
			});
			row.createSpan({ cls: `nb-boxindex-swatch notebook-box-${it.kind}` });
			row.createSpan({ cls: "nb-boxindex-label", text: label });
			row.createSpan({ cls: "nb-boxindex-title", text: it.title ?? "" });
			row.createSpan({ cls: "nb-boxindex-page", text: t("boxindex.page", { n: String(it.pageIndex + 1) }) });
			row.addEventListener("click", () => {
				this.close();
				this.bx.goTo(it.pageIndex, Math.max(0, it.y - 40));
			});
		}
		shellButton(shell.foot, "secondary", t("boxindex.close"), () => this.close());
		shellButton(shell.foot, "primary", t("boxindex.write"), () => void writeBoxesNote(this.bx), { icon: "file-text" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
