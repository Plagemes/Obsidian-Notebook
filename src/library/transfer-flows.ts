/**
 * The three flows of roadmap #77, from the library's notebook menu and from the open notebook's map: ask (library/
 * transfer-dialog.ts), run (library/page-transfer.ts), and tell the user what happened — including what could not be done,
 * and the links that did not follow the pages. No document is touched here.
 */
import type { App, TFile } from "obsidian";
import { t } from "../i18n";
import { runUpdateLinks, planVaultLinks } from "../integration/update-links";
import { showNotice } from "../view/notice";
import { moveTargets } from "./move-pages";
import { currentDocument, dirOf, extractPages, inspectNotebook, mergeNotebooks, splitNotebook, type TransferEnv, type TransferSummary } from "./page-transfer";
import { pageExcerpt } from "./page-move";
import { askTransfer, offerLinkReview, type TransferAnswer, type TransferPageItem } from "./transfer-dialog";
import type { NotebookDocument } from "../model/types";

function pageItems(doc: NotebookDocument): TransferPageItem[] {
	return doc.pages.map((p, i) => ({ id: p.id, number: i + 1, excerpt: pageExcerpt(p, 32), locked: p.locked === true }));
}

function folderLabel(path: string, root: string): string {
	const dir = dirOf(path);
	return root !== "" && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir === root ? "" : dir;
}

/** The sentences for the notice after a run (the first is the headline; the others say what did not go as asked). */
export function outcomeLines(kind: "merge" | "split" | "extract", s: TransferSummary, opts: { moved: boolean; source: string }): string[] {
	const vars = { n: String(s.added), name: s.destination.basename, source: opts.source };
	const lines: string[] = [];
	if (kind === "merge") lines.push(t(s.trashed ? "transfer.done.mergeTrash" : "transfer.done.merge", vars));
	else if (kind === "split") lines.push(t("transfer.done.split", vars));
	else lines.push(t(opts.moved ? "transfer.done.extractMove" : "transfer.done.extractCopy", vars));
	if (s.changed > 0) lines.push(t("transfer.kept.changed", { n: String(s.changed) }));
	if (s.keptLocked > 0) lines.push(t("transfer.kept.locked", { n: String(s.keptLocked) }));
	if (s.trashSkipped === "changed") lines.push(t("transfer.trash.changed", { source: opts.source }));
	if (s.trashSkipped === "failed") lines.push(t("transfer.trash.failed", { source: opts.source }));
	if (s.textLinks > 0) lines.push(t("transfer.links.text", { n: String(s.textLinks) }));
	return lines;
}

export class TransferFlows {
	constructor(private readonly env: TransferEnv) {}

	private get app(): App {
		return this.env.app;
	}

	private fail(e: unknown): void {
		console.error("[notebook] transfer", e);
		showNotice(t("transfer.failed", { error: e instanceof Error ? e.message : String(e) }), 10000);
	}

	private report(kind: "merge" | "split" | "extract", s: TransferSummary, opts: { moved: boolean; source: string }): void {
		const lines = outcomeLines(kind, s, opts);
		showNotice(lines.join(" "), lines.length > 1 ? 14000 : 8000);
		if (s.removed > 0 || s.trashed) void this.offerLinkUpdate();
	}

	/** Pages left their notebook: links in the user's notes that name them can follow (the review list decides, nothing is written here). */
	private async offerLinkUpdate(): Promise<void> {
		try {
			const plan = await planVaultLinks(this.app, this.env.settings());
			const n = plan.changes.filter((c) => c.kind === "relocate").length;
			if (n === 0) return;
			offerLinkReview(this.app, n, () => void runUpdateLinks({ app: this.app, settings: this.env.settings() }));
		} catch (e) {
			console.warn("[notebook] transfer: could not look for links to update", e);
		}
	}

	/** "Merge a notebook into this one…": `into` receives the pages of the notebook the user picks. */
	async merge(into: TFile): Promise<void> {
		try {
			const doc = await currentDocument(this.app, into);
			if (!doc) return void showNotice(t("transfer.cannotRead", { name: into.basename }));
			const settings = this.env.settings();
			const candidates = moveTargets(this.app, settings, into).map((f) => ({ path: f.path, label: f.basename, folder: folderLabel(f.path, settings.folder) }));
			const byPath = new Map(moveTargets(this.app, settings, into).map((f) => [f.path, f]));
			const answer = await askTransfer(this.app, {
				kind: "merge", notebook: into.basename, pages: pageItems(doc), candidates, canTrash: !!this.env.trash,
				inspect: async (path) => {
					const f = byPath.get(path);
					return f ? inspectNotebook(this.app, f) : null;
				},
			});
			if (!answer || answer.kind !== "merge") return;
			const from = byPath.get(answer.other);
			if (!from) return;
			const s = await mergeNotebooks(this.env, { into, from, after: answer.after ?? undefined, trashFrom: answer.trashOther, allowLocked: answer.allowLocked });
			this.report("merge", s, { moved: answer.trashOther, source: from.basename });
		} catch (e) {
			this.fail(e);
		}
	}

	/** "Split at a page…": the pages from `at` (0-based, optional first guess) to the end become a new notebook beside this one. */
	async split(file: TFile, at?: number): Promise<void> {
		try {
			const doc = await currentDocument(this.app, file);
			if (!doc) return void showNotice(t("transfer.cannotRead", { name: file.basename }));
			const answer = await askTransfer(this.app, {
				kind: "split", notebook: file.basename, pages: pageItems(doc), splitAt: at, defaultName: t("transfer.split.defaultName", { name: file.basename }),
			});
			if (!answer || answer.kind !== "split") return;
			await this.runSplit(file, answer);
		} catch (e) {
			this.fail(e);
		}
	}

	private async runSplit(file: TFile, a: Extract<TransferAnswer, { kind: "split" }>): Promise<void> {
		const s = await splitNotebook(this.env, { source: file, at: a.at, name: a.name, allowLocked: a.allowLocked });
		this.report("split", s, { moved: true, source: file.basename });
	}

	/** "Extract pages…": `preselected` are the page ids ticked at first. */
	async extract(file: TFile, preselected?: readonly string[]): Promise<void> {
		try {
			const doc = await currentDocument(this.app, file);
			if (!doc) return void showNotice(t("transfer.cannotRead", { name: file.basename }));
			const answer = await askTransfer(this.app, {
				kind: "extract", notebook: file.basename, pages: pageItems(doc), preselected, defaultName: t("transfer.extract.defaultName", { name: file.basename }),
			});
			if (!answer || answer.kind !== "extract") return;
			const s = await extractPages(this.env, {
				source: file, pageIds: answer.pageIds, mode: answer.mode, name: answer.name, folder: dirOf(file.path), allowLocked: answer.allowLocked,
			});
			this.report("extract", s, { moved: answer.mode === "move", source: file.basename });
		} catch (e) {
			this.fail(e);
		}
	}
}
