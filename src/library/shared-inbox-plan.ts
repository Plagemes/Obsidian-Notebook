/**
 * 0.16 (roadmap #177): what "Add to notebook" and "New notebook" do with a received file, as plain edits. Pure: no
 * 'obsidian'. The edits are `Prepare` functions of the plugin API (integration/api-plan.ts), so they run on an open
 * notebook as one undo step or on a closed one with the same checks (parse, apply, re-validate, write, read back).
 */
import { createPage } from "../model/document";
import { AddAsset, AddElement, InsertPages } from "../model/history";
import { createPdfPages } from "../model/pages";
import { PAPER_SPACING, type Asset, type NotebookDocument, type Page } from "../model/types";
import { buildImageElement, parseImageOptions, type EditPlan, type Prepare } from "../integration/api-plan";
import { imagePageSize } from "../view/view-helpers";
import { scannedPage } from "../scan/pages";
import { buildImagesDocument } from "./bulk-import-run";

export interface PageSizePt {
	width: number;
	height: number;
}

export interface ImageDims {
	width: number;
	height: number;
}

/** Where a received image goes in a notebook. */
export type ImagePlacement = "page" | "element";

export interface AppendResult {
	/** Pages added at the end (0 for an image element). */
	added: number;
	/** 1-based number of the page that got the file (first new page, or the page with the image element). */
	page: number;
}

/** A PDF as pages with the PDF as their background, after the last page. */
export function prepareAppendPdf(asset: Asset, sizes: readonly PageSizePt[]): Prepare<AppendResult> {
	return (doc) => {
		if (sizes.length === 0) throw new Error("the PDF has no pages");
		const pages = createPdfPages(asset, sizes);
		const ids = pages.map((p) => p.id);
		const at = doc.pages.length;
		return {
			commands: [new AddAsset(asset), new InsertPages(pages, at)],
			result: { added: pages.length, page: at + 1 },
			verify: (back) => ids.every((id) => back.pages.some((p) => p.id === id)) && back.assets?.[asset.id] !== undefined,
		};
	};
}

/** The page an image makes: A4 portrait or landscape by the image's aspect, the image as the background. */
export function imagePage(asset: Asset, dims: ImageDims): Page {
	const page = createPage(imagePageSize(dims.width, dims.height), { kind: "blank", spacing: PAPER_SPACING.blank });
	page.background = { kind: "image", asset: asset.id };
	return page;
}

/** An image as a new page after the last page. */
export function prepareAppendImagePage(asset: Asset, dims: ImageDims): Prepare<AppendResult> {
	return (doc) => {
		const page = imagePage(asset, dims);
		const at = doc.pages.length;
		return {
			commands: [new AddAsset(asset), new InsertPages([page], at)],
			result: { added: 1, page: at + 1 },
			verify: (back) => back.pages.some((p) => p.id === page.id && p.background?.kind === "image") && back.assets?.[asset.id] !== undefined,
		};
	};
}

/** An image as an element in the middle of a page: the page in view when the notebook is open, else the last page. */
export function prepareImageElement(asset: Asset, dims: ImageDims, pageIndex: number | null): Prepare<AppendResult> {
	return (doc) => {
		if (doc.pages.length === 0) throw new Error("the notebook has no pages");
		const index = pageIndex !== null && pageIndex >= 0 && pageIndex < doc.pages.length ? pageIndex : doc.pages.length - 1;
		const page = doc.pages[index]!;
		const element = buildImageElement(page, dims, asset.id, parseImageOptions(undefined));
		const plan: EditPlan<AppendResult> = {
			commands: [new AddAsset(asset), new AddElement(page.id, element, page.elements?.length ?? 0)],
			result: { added: 0, page: index + 1 },
			verify: (back) => back.pages.some((p) => p.id === page.id && (p.elements ?? []).some((e) => e.id === element.id && e.type === "image")) && back.assets?.[asset.id] !== undefined,
		};
		return plan;
	};
}

/** A new notebook with the image as its single page. */
export function buildImageDocument(asset: Asset, dims: ImageDims, now: Date = new Date()): NotebookDocument {
	// The same notebook the bulk import makes from one image (library/bulk-import-run.ts), so both paths agree on the page.
	return buildImagesDocument([scannedPage(asset, dims.width, dims.height)], [asset], now);
}
