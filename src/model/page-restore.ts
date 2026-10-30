/**
 * Restore a single page from a previous version (roadmap #180). Pure, no Obsidian imports.
 *
 * The page comes from an older version of the same notebook (a version-history snapshot or a backup
 * copy, parsed and migrated by `parse()`). It is either inserted as a new page after the page in view
 * (new ids for the page and its content) or it replaces the page in view, keeping that page's id so
 * bookmarks and links to it stay valid. The rest of the notebook is untouched, and the change is one
 * undo step. Assets the restored page needs and the notebook no longer lists are added back.
 */
import { createId } from "./document";
import { AddAsset, AddPage, Batch, type Command } from "./history";
import { unionPageTags } from "./page-tags";
import { duplicatePage } from "./pages";
import { freezeElement, freezeStroke } from "./serialize";
import type { Asset, NotebookDocument, Page } from "./types";

/** Replaces one page object with another at the same position. A missing page is a no-op both ways. */
export class ReplacePage implements Command {
	readonly label = "Restore page";
	private applied = false;
	constructor(readonly before: Page, readonly after: Page) {}

	apply(doc: NotebookDocument): void {
		const i = doc.pages.indexOf(this.before);
		this.applied = i >= 0 && !doc.pages.includes(this.after);
		if (this.applied) doc.pages.splice(i, 1, this.after);
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const i = doc.pages.indexOf(this.after);
		if (i >= 0) doc.pages.splice(i, 1, this.before);
	}
}

export type RestoreMode = "insert" | "replace";

export interface PageRestorePlan {
	command: Command;
	/** Index of the restored page once the command is applied. */
	pageIndex: number;
	/** Assets added back to the notebook. */
	assetsAdded: number;
}

/** Assets the page uses, taken from the version it comes from. */
function assetsOf(page: Page, from: NotebookDocument): Asset[] {
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) if (el.type === "image") ids.add(el.asset);
	const out: Asset[] = [];
	for (const id of ids) {
		const a = from.assets?.[id];
		if (a) out.push(a);
	}
	return out;
}

/**
 * Plans restoring `version.pages[sourceIndex]` into `doc` relative to `doc.pages[targetIndex]`.
 * Returns null when either page does not exist.
 */
export function planPageRestore(
	doc: NotebookDocument,
	version: NotebookDocument,
	sourceIndex: number,
	targetIndex: number,
	mode: RestoreMode,
): PageRestorePlan | null {
	const source = version.pages[sourceIndex];
	const target = doc.pages[targetIndex];
	if (!source || !target) return null;
	const commands: Command[] = [];
	let assetsAdded = 0;
	for (const a of assetsOf(source, version)) {
		if (doc.assets && Object.prototype.hasOwnProperty.call(doc.assets, a.id)) continue;
		commands.push(new AddAsset({ ...a }));
		assetsAdded++;
	}
	if (mode === "insert") {
		const page = duplicatePage(source);
		commands.push(new AddPage(page, targetIndex + 1));
		return { command: new Batch("Restore page as new page", commands), pageIndex: targetIndex + 1, assetsAdded };
	}
	// Replace: same page id; content ids are kept unless another page of the notebook uses them.
	const elsewhere = new Set<string>();
	for (const p of doc.pages) {
		if (p === target) continue;
		for (const s of p.strokes) elsewhere.add(s.id);
		for (const e of p.elements ?? []) elsewhere.add(e.id);
	}
	const idFor = (id: string) => {
		if (!elsewhere.has(id)) {
			elsewhere.add(id);
			return id;
		}
		let fresh = createId();
		while (elsewhere.has(fresh)) fresh = createId();
		elsewhere.add(fresh);
		return fresh;
	};
	const page: Page = {
		id: target.id,
		width: source.width,
		height: source.height,
		paper: { kind: source.paper.kind, spacing: source.paper.spacing },
		strokes: source.strokes.map((s) => freezeStroke({
			id: idFor(s.id), tool: s.tool, color: s.color, width: s.width, render: s.render,
			points: s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
		})),
	};
	if (source.background) page.background = { ...source.background };
	if (source.infinite !== undefined) page.infinite = source.infinite;
	// v7 page tags: the tags of the page in view and of the restored version, so restoring never drops a tag.
	// (Bookmark details are keyed by the page id, which is kept, so they stay as they are.)
	const tags = unionPageTags(target.tags, source.tags);
	if (tags) page.tags = tags;
	if (source.margins) page.margins = { ...source.margins };
	if (source.elements && source.elements.length > 0) page.elements = source.elements.map((e) => freezeElement({ ...e, id: idFor(e.id) }));
	commands.push(new ReplacePage(target, page));
	return { command: new Batch("Restore page", commands), pageIndex: targetIndex, assetsAdded };
}

/** The page of `version` that corresponds to `page`: same id, else the same position, else the first. */
export function matchingPageIndex(version: NotebookDocument, page: Page | undefined, index: number): number {
	if (page) {
		const byId = version.pages.findIndex((p) => p.id === page.id);
		if (byId >= 0) return byId;
	}
	return index >= 0 && index < version.pages.length ? index : 0;
}
