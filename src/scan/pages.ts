/** Pure helpers that turn scanned sheets into notebook pages (no DOM, no 'obsidian'). */
import { createPage } from "../model/document";
import { A4_WIDTH, PAPER_SPACING, type Asset, type Page } from "../model/types";

/** Page size for a scanned sheet: A4 width, height from the sheet's aspect ratio (so the scan is not distorted). */
export function scannedPageSize(width: number, height: number): { width: number; height: number } {
	if (!(width > 0) || !(height > 0)) return { width: A4_WIDTH, height: Math.round((A4_WIDTH * 297) / 210 * 100) / 100 };
	return { width: A4_WIDTH, height: Math.round(((A4_WIDTH * height) / width) * 100) / 100 };
}

/** A blank page whose background is the scanned image stored as `asset`. */
export function scannedPage(asset: Asset, width: number, height: number): Page {
	const page = createPage(scannedPageSize(width, height), { kind: "blank", spacing: PAPER_SPACING.blank });
	page.background = { kind: "image", asset: asset.id };
	return page;
}
