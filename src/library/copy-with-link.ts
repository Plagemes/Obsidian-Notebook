/**
 * "Copy to notebook…" with a link back (roadmap #186): a thin flow on top of the notebook transfer. It asks (copy-with-link-
 * dialog.ts), lets `copyPagesInto` (page-transfer.ts) do the copy in the careful way, puts a "Copied from <notebook> p.N" chip
 * on every copy in the same write, and — if asked — a "Copied to …" chip on the originals as one ordinary undoable edit of the
 * open notebook (locked pages are skipped). Nothing here writes a file itself.
 */
import type { App, TFile } from "obsidian";
import { t } from "../i18n";
import { AddElement, Batch, type Command } from "../model/history";
import { createId } from "../model/document";
import type { EditContext } from "../view/edit-context";
import { showNotice } from "../view/notice";
import { askCopyLink } from "./copy-with-link-dialog";
import { planChip, planPairs, reversible, type PagePair } from "./copy-with-link-logic";
import { moveTargets } from "./move-pages";
import { pageExcerpt } from "./page-move";
import { copyPagesInto, dirOf, inspectNotebook, type TransferEnv } from "./page-transfer";

/** What a run did, for the notice. */
export interface CopyLinkOutcome {
	copied: number;
	destName: string;
	/** "Copied to" chips added to the originals. */
	reversed: number;
	/** Originals that are locked, so they got none. */
	skippedLocked: number;
	/** The originals could not get their chips (the edit was refused); the copies are in place. */
	reverseFailed: boolean;
}

function folderLabel(path: string, root: string): string {
	const dir = dirOf(path);
	return root !== "" && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir === root ? "" : dir;
}

/** The link text of `file` as written from the notebook at `from` (what Obsidian would write in a link there). */
function linktext(app: App, file: TFile, from: string): string {
	return app.metadataCache.fileToLinktext(file, from);
}

/** Puts the "Copied to" chips on the originals: one undo step, only pages that exist and are not locked now. */
function addReverseChips(src: EditContext, pairs: readonly PagePair[]): { added: number; skippedLocked: number; failed: boolean } {
	if (!src.alive()) return { added: 0, skippedLocked: 0, failed: true };
	const now = new Map(src.doc.pages.map((p) => [p.id, p.locked === true] as const));
	const { go, skippedLocked } = reversible(pairs, now);
	const commands: Command[] = [];
	for (const pair of go) {
		const page = src.doc.pages.find((p) => p.id === pair.sourceId);
		if (!page) continue;
		const chip = planChip(createId(), pair.toText, pair.toAlias, page, src.measure);
		if (chip) commands.push(new AddElement(page.id, chip, page.elements?.length ?? 0));
	}
	if (commands.length === 0) return { added: 0, skippedLocked, failed: false };
	// Refused (the notebook went read-only, a page was locked meanwhile): the copies stay, the originals are untouched.
	const done = src.execute(new Batch("Add copy links", commands));
	return { added: done ? commands.length : 0, skippedLocked, failed: !done };
}

/** Copies `pageIds` of the open notebook into `dest` at `at`, with the chips. Throws before anything is written when the copy cannot be made. */
export async function copyWithLink(
	env: TransferEnv, src: EditContext, req: { pageIds: readonly string[]; dest: TFile; at: number; reverse: boolean },
): Promise<CopyLinkOutcome> {
	const file = src.file;
	if (!file) throw new Error(t("transfer.sourceGone", { name: "" }));
	const app = env.app;
	const wanted = new Set(req.pageIds);
	let pairs: PagePair[] = [];
	const result = await copyPagesInto(env, {
		source: file, pageIds: req.pageIds, dest: req.dest, at: req.at,
		decorate: (plan, sourceDoc) => {
			const sources = sourceDoc.pages
				.map((p, i) => ({ id: p.id, number: i + 1, locked: p.locked === true }))
				.filter((p) => wanted.has(p.id));
			pairs = planPairs({
				sources, copyIds: plan.pages.map((p) => p.id), firstNumber: plan.at + 1,
				sourceName: file.basename, destName: req.dest.basename,
				// A link is written as seen from the notebook it sits in.
				sourceLinktext: linktext(app, file, req.dest.path), destLinktext: linktext(app, req.dest, file.path),
			});
			pairs.forEach((pair, i) => {
				const copy = plan.pages[i];
				const chip = copy ? planChip(createId(), pair.fromText, pair.fromAlias, copy, src.measure) : null;
				if (copy && chip) copy.elements = [...(copy.elements ?? []), chip];
			});
		},
	});
	const outcome: CopyLinkOutcome = { copied: result.summary.added, destName: req.dest.basename, reversed: 0, skippedLocked: 0, reverseFailed: false };
	if (req.reverse) {
		const r = addReverseChips(src, pairs);
		outcome.reversed = r.added;
		outcome.skippedLocked = r.skippedLocked;
		outcome.reverseFailed = r.failed;
	}
	return outcome;
}

/** The sentences for the notice after a run. */
export function outcomeText(o: CopyLinkOutcome): string {
	const lines = [t("copylink.done", { n: String(o.copied), name: o.destName })];
	if (o.reversed > 0) lines.push(t("copylink.done.reversed", { n: String(o.reversed) }));
	if (o.skippedLocked > 0) lines.push(t("copylink.done.locked", { n: String(o.skippedLocked) }));
	if (o.reverseFailed) lines.push(t("copylink.done.reverseFailed"));
	return lines.join(" ");
}

/** "Copy to notebook…" from the page menu, the command and the notebook map: asks, copies and reports. `preselect` = ids ticked at first. */
export async function runCopyWithLink(env: TransferEnv, src: EditContext, preselect: readonly string[]): Promise<void> {
	const app = env.app;
	const file = src.file;
	if (!file) return;
	const settings = env.settings();
	const targets = moveTargets(app, settings, file);
	const byPath = new Map(targets.map((f) => [f.path, f]));
	try {
		const answer = await askCopyLink(app, {
			notebook: file.basename,
			pages: src.doc.pages.map((p, i) => ({ id: p.id, number: i + 1, excerpt: pageExcerpt(p, 32), locked: p.locked === true })),
			preselected: preselect,
			candidates: targets.map((f) => ({ path: f.path, label: f.basename, folder: folderLabel(f.path, settings.folder) })),
			inspect: async (path) => {
				const f = byPath.get(path);
				const r = f ? await inspectNotebook(app, f) : null;
				return r ? { pages: r.pages } : null;
			},
			reverse: settings.copyLinkReverse,
		});
		const dest = answer ? byPath.get(answer.dest) : undefined;
		if (!answer || !dest || !src.alive()) return;
		const outcome = await copyWithLink(env, src, { pageIds: answer.pageIds, dest, at: answer.at, reverse: answer.reverse });
		showNotice(outcomeText(outcome), outcome.reverseFailed || outcome.skippedLocked > 0 ? 12000 : 8000);
	} catch (e) {
		console.error("[notebook] copy with link", e);
		showNotice(t("copylink.failed", { error: e instanceof Error ? e.message : String(e) }), 10000);
	}
}

