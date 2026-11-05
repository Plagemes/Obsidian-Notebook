/**
 * "Restore this page" of the version diff (0.20, #121). Pure, no Obsidian imports. It reuses the page-restore planner
 * (model/page-restore.ts): a page that is still in the notebook is replaced (same page id, one undo step), a page that was
 * removed since is inserted again after the nearest page before it that is still there. A locked page is never replaced.
 */
import { planPageRestore, type PageRestorePlan, type RestoreMode } from "./page-restore";
import type { NotebookDocument } from "./types";
import type { PageDiff } from "./version-diff";

export type DiffRestore =
	| { kind: "ok"; plan: PageRestorePlan; mode: RestoreMode; /** 0-based index of the page replaced, or of the page the new one goes after. */ target: number }
	/** The page is not in the version to restore from. */
	| { kind: "not-in-version" }
	/** The page in the notebook is locked (1-based page number). */
	| { kind: "locked"; n: number }
	/** 0.20 review (D5): the notebook now on screen is not the one the versions belong to. */
	| { kind: "other-notebook" }
	| { kind: "nothing" };

/**
 * `planDiffRestore`, but only into the notebook the versions were read from: the dialog can outlive the notebook in its leaf
 * (a link opened in the same leaf, a back gesture), and a page id missing there would otherwise copy a page across notebooks.
 */
export function planDiffRestoreInto(
	current: NotebookDocument, source: NotebookDocument, pageId: string, order: readonly PageDiff[], fallback: number,
): DiffRestore {
	if (current.id !== source.id) return { kind: "other-notebook" };
	return planDiffRestore(current, source, pageId, order, fallback);
}

/**
 * Plans restoring the page `pageId` of `source` (an earlier version of the notebook) into `current`. `order` is the page list
 * of the diff, to find where a page that is gone belongs; `fallback` is the page to go after when nothing before it is left.
 */
export function planDiffRestore(
	current: NotebookDocument, source: NotebookDocument, pageId: string, order: readonly PageDiff[], fallback: number,
): DiffRestore {
	const sourceIndex = source.pages.findIndex((p) => p.id === pageId);
	if (sourceIndex < 0) return { kind: "not-in-version" };
	if (current.pages.length === 0) return { kind: "nothing" };
	const targetIndex = current.pages.findIndex((p) => p.id === pageId);
	if (targetIndex >= 0) {
		if (current.pages[targetIndex]!.locked) return { kind: "locked", n: targetIndex + 1 };
		const plan = planPageRestore(current, source, sourceIndex, targetIndex, "replace");
		return plan ? { kind: "ok", plan, mode: "replace", target: targetIndex } : { kind: "nothing" };
	}
	// Gone from the notebook: after the nearest earlier page of the list that is still there.
	let after = -1;
	for (let i = order.findIndex((p) => p.id === pageId) - 1; i >= 0; i--) {
		const at = current.pages.findIndex((p) => p.id === order[i]!.id);
		if (at >= 0) {
			after = at;
			break;
		}
	}
	if (after < 0) after = Math.min(Math.max(0, fallback), current.pages.length - 1);
	const plan = planPageRestore(current, source, sourceIndex, after, "insert");
	return plan ? { kind: "ok", plan, mode: "insert", target: after } : { kind: "nothing" };
}
