/**
 * Pointing a notebook at another copy of a picture (Storage manager, roadmap #128): a downscaled copy, or the one kept when
 * duplicates are merged. Pure: no 'obsidian', no file access.
 *
 * Nothing here invents a new kind of edit. `planAssetRepoint` composes the document's own commands (`AddAsset`,
 * `SetPageBackground`, `ReplaceElement`, `SetMeta`) and one small new one, `RemoveAsset`, into a single `Batch`, so an open
 * notebook runs it as ONE undo step (history.execute) and a closed one applies it to the parsed document before it is
 * validated and written (`repointInText`). Only image assets are repointed: a PDF's id is also named by slide links and the
 * side-by-side link files, which this does not rewrite.
 */
import { cloneMeta, findPage } from "./document";
import { elementAssetId, withElementAsset } from "./excerpts";
import { AddAsset, Batch, ReplaceElement, SetMeta, SetPageBackground, type Command } from "./history";
import { parse, serializeChecked } from "./serialize";
import type { Asset, NotebookDocument, PageElement } from "./types";

/** Drops an asset record the document no longer uses; undo puts the record back. A missing record is a no-op both ways. */
export class RemoveAsset implements Command {
	readonly label = "Remove file";
	private removed: Asset | null = null;
	constructor(readonly id: string) {}

	apply(doc: NotebookDocument): void {
		const assets = doc.assets;
		if (!assets || !Object.prototype.hasOwnProperty.call(assets, this.id)) {
			this.removed = null;
			return;
		}
		this.removed = assets[this.id] ?? null;
		delete assets[this.id];
	}

	revert(doc: NotebookDocument): void {
		const record = this.removed;
		if (!record) return;
		this.removed = null;
		(doc.assets ??= {})[record.id] = record;
	}
}

/** Where a document uses an asset. */
export interface AssetUses {
	/** Pages whose background is the asset. */
	backgrounds: string[];
	/** Image elements and excerpt snapshots: page id and element. */
	elements: Array<{ pageId: string; element: PageElement }>;
	/** The notebook's cover is this picture. */
	cover: boolean;
}

export function assetUses(doc: NotebookDocument, id: string): AssetUses {
	const uses: AssetUses = { backgrounds: [], elements: [], cover: doc.meta?.coverArt?.kind === "image" && doc.meta.coverArt.asset === id };
	for (const page of doc.pages) {
		if (page.background?.asset === id) uses.backgrounds.push(page.id);
		for (const element of page.elements ?? []) if (elementAssetId(element) === id) uses.elements.push({ pageId: page.id, element });
	}
	return uses;
}

/** How many places of the document use the asset. */
export function useCount(uses: AssetUses): number {
	return uses.backgrounds.length + uses.elements.length + (uses.cover ? 1 : 0);
}

/**
 * The batch that makes every use of image asset `fromId` in `doc` use `to` instead, registers `to` and drops the record of
 * `fromId`. Null when the document does not use `fromId` (nothing to do), when `to` is the same asset, or when `fromId` is
 * not an image record of the document. Build it from the document it will run on: it holds the elements it replaces.
 */
export function planAssetRepoint(doc: NotebookDocument, fromId: string, to: Asset): Batch | null {
	if (to.kind !== "image" || to.id === fromId) return null;
	const from = doc.assets?.[fromId];
	if (!from || from.kind !== "image") return null;
	const uses = assetUses(doc, fromId);
	if (useCount(uses) === 0) return null;
	const commands: Command[] = [new AddAsset(to)];
	for (const pageId of uses.backgrounds) {
		const page = findPage(doc, pageId);
		const background = page?.background;
		if (!page || !background) continue;
		commands.push(new SetPageBackground(pageId, { ...background, asset: to.id }, { width: page.width, height: page.height }));
	}
	for (const { pageId, element } of uses.elements) commands.push(new ReplaceElement(pageId, element, withElementAsset(element, to.id)));
	if (uses.cover && doc.meta) {
		const after = cloneMeta(doc.meta);
		after.coverArt = { kind: "image", asset: to.id };
		commands.push(new SetMeta(doc.meta, after));
	}
	commands.push(new RemoveAsset(fromId));
	// Maintenance, not an edit: the same picture in another file (smaller, or a duplicate merged), so a locked page keeps looking
	// as it did. Exempt from the page-lock guard on purpose (docs/architecture.md); the batch itself carries the flag so the
	// library check still sees the assets it names while it sits on the undo or redo stack.
	return new Batch("Replace picture", commands, true);
}

export type RepointText = { ok: true; text: string | null; changes: number } | { ok: false; message: string };

/**
 * The text of a closed notebook with `fromId` replaced by `to`. `text: null` when the notebook does not use it (leave the
 * file alone). Fails, and nothing is written, when the notebook does not parse, or the result would not pass the save check
 * (`serializeChecked`) or does not read back the same way: the file is only ever replaced by text that was validated.
 */
export function repointInText(text: string, fromId: string, to: Asset): RepointText {
	const parsed = parse(text);
	if (!parsed.ok) return { ok: false, message: parsed.message };
	const doc = parsed.doc;
	const plan = planAssetRepoint(doc, fromId, to);
	if (!plan) return { ok: true, text: null, changes: 0 };
	plan.apply(doc);
	const uses = assetUses(doc, fromId);
	if (useCount(uses) !== 0 || doc.assets?.[fromId]) return { ok: false, message: "the old picture is still used after the change" };
	doc.modifiedAt = laterThan(doc.modifiedAt);
	const checked = serializeChecked(doc, true);
	if (!checked.ok) return { ok: false, message: checked.message };
	const again = parse(checked.text);
	if (!again.ok) return { ok: false, message: again.message };
	if (useCount(assetUses(again.doc, to.id)) === 0) return { ok: false, message: "the new picture is not used after the change" };
	return { ok: true, text: checked.text, changes: plan.commands.length - 2 };
}

/** A modification stamp later than `previous` (a write is a new edit for every device). */
function laterThan(previous: string): string {
	const now = new Date().toISOString();
	return Date.parse(now) > Date.parse(previous) ? now : new Date(Date.parse(previous) + 1).toISOString();
}
