/**
 * The actions of the page navigator's multi-selection (wave 0.8, 378): move, duplicate, bookmark, tag, paper, size,
 * export and delete the selected pages together. Every action is one command, so it is one undo step; the logic that
 * builds the commands is in model/page-ops.ts. Kept out of navigator.ts and notebook-view.ts: the view only passes itself
 * as a `PageOpsHost`.
 */
import { Menu, type TFile } from "obsidian";
import { t } from "../i18n";
import { ConfirmModal, PromptModal } from "../library/library-modals";
import type { Command } from "../model/history";
import {
	addTagsCommand, allBookmarked, bookmarkCommand, deleteCommand, duplicateCommand, exportSuffix, moveCommand, paperCommand, removeTagCommand,
	selectedPages, selectionTags, sizeCommand, stashSnapshot, unstashedPages, type MoveTarget, type StashedPage,
} from "../model/page-ops";
import { parsePageTagInput } from "../model/page-tags";
import { PAGE_SIZES, PAPER_KINDS, type NotebookDocument, type Page, type PageSizeName } from "../model/types";
import { stashDeletedPage, type PageToolsHost } from "./page-tools";

import { showNotice } from "./notice";
/** What the multi-selection actions need from the notebook view. */
export interface PageOpsHost extends PageToolsHost {
	readonly file: TFile | null;
	/** "Move to notebook…" with these pages ticked (library/move-pages.ts). */
	moveToNotebook(pageIds: readonly string[]): Promise<void>;
	/** Writes a PDF of the pages next to the notebook. */
	exportPages(pages: readonly Page[], suffix: string): Promise<void>;
}

const MAX_TAG_ITEMS = 8;



/** Runs the command the current document yields for the selection; one undo step. False when the notebook cannot be edited now or nothing would change. */
function run(host: PageOpsHost, build: (doc: NotebookDocument) => Command | null, scrollTo?: (doc: NotebookDocument) => number): boolean {
	const doc = host.editableDocument();
	if (!doc) {
		showNotice(t("merge.notEditable"));
		return false;
	}
	const command = build(doc);
	if (!command) {
		showNotice(t("pageOps.nothingToChange"));
		return false;
	}
	return host.applyCommand(command, scrollTo?.(doc));
}

function moveTo(host: PageOpsHost, ids: readonly string[], to: MoveTarget): void {
	run(host, (doc) => moveCommand(doc, ids, to), (doc) => Math.max(0, doc.pages.findIndex((p) => ids.includes(p.id))));
}

function askPosition(host: PageOpsHost, ids: readonly string[]): void {
	const doc = host.editableDocument();
	if (!doc) return;
	new PromptModal(host.app, { title: t("pageOps.positionTitle"), label: t("pageOps.positionLabel", { max: String(doc.pages.length) }), cta: t("pageOps.move") }, (value) => {
		const position = Number(value.trim());
		if (!Number.isInteger(position) || position < 1) {
			showNotice(t("pageOps.positionInvalid", { max: String(doc.pages.length) }));
			return;
		}
		moveTo(host, ids, { position });
	}).open();
}

function askTags(host: PageOpsHost, ids: readonly string[]): void {
	new PromptModal(host.app, { title: t("pageOps.tagsTitle", { n: String(ids.length) }), label: t("pageOps.tagsLabel"), cta: t("pageOps.addTags") }, (value) => {
		const tags = parsePageTagInput(value);
		if (tags.length === 0) {
			showNotice(t("pageOps.tagsInvalid"));
			return;
		}
		run(host, (doc) => addTagsCommand(doc, ids, tags));
	}).open();
}

/** Deletes through the page trash: a copy of each page is on disk before any of them is removed. */
function askDelete(host: PageOpsHost, ids: readonly string[]): void {
	const doc = host.editableDocument();
	if (!doc) return;
	const pages = selectedPages(doc, ids);
	if (!deleteCommand(doc, ids)) {
		showNotice(t("pageOps.deleteAll"));
		return;
	}
	new ConfirmModal(host.app, { title: t("pageOps.deleteTitle", { n: String(pages.length) }), body: t("pageOps.deleteBody"), cta: t("page.delete") }, () => {
		void (async () => {
			const stashed = new Map<string, StashedPage>();
			// The copies are written one after the other; the notebook stays editable meanwhile. A page that was edited or
			// replaced after its copy was written gets a new copy (one more round); if it keeps changing, nothing is deleted.
			for (let round = 0; ; round++) {
				if (host.editableDocument() !== doc) return;
				const missing = unstashedPages(doc, ids, stashed);
				if (missing.length === 0) break;
				if (round >= 2) {
					showNotice(t("pageOps.deleteChanged"), 8000);
					return;
				}
				for (const page of missing) {
					const snapshot = stashSnapshot(page);
					if (!(await stashDeletedPage(host, doc, page, doc.pages.indexOf(page)))) return;
					stashed.set(page.id, { page, snapshot });
				}
			}
			// Delete only what is still there, still editable, and exactly the version that was kept.
			const at = selectedPages(doc, ids).map((p) => doc.pages.indexOf(p));
			const first = at.length > 0 ? Math.max(0, Math.min(...at) - 1) : 0;
			run(host, (d) => deleteCommand(d, ids), () => first);
		})();
	}).open();
}

function paperMenu(host: PageOpsHost, ids: readonly string[], evt: MouseEvent): void {
	const menu = new Menu();
	for (const kind of PAPER_KINDS) menu.addItem((i) => i.setTitle(t("page.paper", { kind: t(`paper.${kind}`) })).onClick(() => run(host, (doc) => paperCommand(doc, ids, kind))));
	menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
}

function sizeMenu(host: PageOpsHost, ids: readonly string[], evt: MouseEvent): void {
	const menu = new Menu();
	for (const name of Object.keys(PAGE_SIZES) as PageSizeName[]) {
		menu.addItem((i) => i.setTitle(t("page.size", { size: t(`size.${name}`) })).onClick(() => run(host, (doc) => sizeCommand(doc, ids, PAGE_SIZES[name]))));
	}
	menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
}

/** Menu of the actions for the selected pages (`ids`), shown at the event. Nothing happens until an item is chosen. */
export function openPageOpsMenu(host: PageOpsHost, ids: readonly string[], evt: MouseEvent): void {
	const doc = host.editableDocument();
	const menu = new Menu();
	if (!doc) {
		menu.addItem((i) => i.setTitle(t("merge.notEditable")).setDisabled(true));
		menu.showAtMouseEvent(evt);
		return;
	}
	const pages = selectedPages(doc, ids);
	const all = pages.length >= doc.pages.length;
	menu.addItem((i) => i.setTitle(t("pageOps.moveStart")).setIcon("arrow-up-to-line").onClick(() => moveTo(host, ids, "start")));
	menu.addItem((i) => i.setTitle(t("pageOps.moveEnd")).setIcon("arrow-down-to-line").onClick(() => moveTo(host, ids, "end")));
	menu.addItem((i) => i.setTitle(t("pageOps.movePosition")).setIcon("move-vertical").onClick(() => askPosition(host, ids)));
	menu.addItem((i) => i.setTitle(t("pageOps.moveNotebook")).setIcon("folder-input").onClick(() => void host.moveToNotebook(ids)));
	menu.addItem((i) => i.setTitle(t("pageOps.duplicate")).setIcon("copy").onClick(() => {
		// Built once: the copies get new ids each time.
		const now = host.editableDocument();
		const copy = now ? duplicateCommand(now, ids) : null;
		if (copy) host.applyCommand(copy.command, copy.index);
		else showNotice(t(now ? "pageOps.nothingToChange" : "merge.notEditable"));
	}));
	menu.addSeparator();
	menu.addItem((i) => i.setTitle(t(allBookmarked(doc, ids) ? "pageOps.unbookmark" : "pageOps.bookmark")).setIcon("bookmark").onClick(() => run(host, (d) => bookmarkCommand(d, ids))));
	menu.addItem((i) => i.setTitle(t("pageOps.addTags")).setIcon("tag").onClick(() => askTags(host, ids)));
	for (const { tag, count } of selectionTags(doc, ids).slice(0, MAX_TAG_ITEMS)) {
		menu.addItem((i) => i.setTitle(t("pageOps.removeTag", { tag, n: String(count) })).setIcon("tag").onClick(() => run(host, (d) => removeTagCommand(d, ids, tag))));
	}
	menu.addSeparator();
	menu.addItem((i) => i.setTitle(t("pageOps.paper")).setIcon("palette").onClick(() => paperMenu(host, ids, evt)));
	menu.addItem((i) => i.setTitle(t("pageOps.size")).setIcon("ruler").onClick(() => sizeMenu(host, ids, evt)));
	menu.addSeparator();
	const file = host.file;
	if (file) {
		menu.addItem((i) => i.setTitle(t("pageOps.exportPdf")).setIcon("file-output")
			.onClick(() => void host.exportPages(pages, exportSuffix(doc, pages))));
	}
	menu.addItem((i) => i.setTitle(t("pageOps.delete")).setIcon("trash-2").setSection("danger").setDisabled(all).onClick(() => askDelete(host, ids)));
	menu.showAtMouseEvent(evt);
}
