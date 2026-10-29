/**
 * "New lecture from slides…" (roadmap #191): the course slides PDF becomes a ready lecture notebook,
 * created in the course folder: optional header (page or text with course, date, title) and the slides as
 * page backgrounds in the chosen layout (model/lecture-pack.ts). No 'obsidian' here: the host injects
 * the picker, the dialog and the vault.
 */
import { createDocument, createId } from "../model/document";
import { buildLecturePackPages, type LayoutOptions } from "../model/lecture-pack";
import { freezeElement, serializeChecked } from "../model/serialize";
import { PAPER_SPACING, type Asset, type NotebookDocument, type Page, type TextElement } from "../model/types";
import { buildLecturePage, cleanTitle, HEADER_COLOR, HEADER_FONT_SIZE, HEADER_MARGIN, isoDate, lectureHeaderText } from "../view/lecture-logic";
import { LARGE_PDF_BYTES, pdfNotebookName, type ImportDeps, type PageSizePt } from "./import-pdf";

/** Where the lecture header goes: a page of its own before the slides, a text box on the first slide page, or nowhere. */
export const HEADER_MODES = ["page", "text", "none"] as const;
export type HeaderMode = (typeof HEADER_MODES)[number];

/** Space between the slide and a header text placed in the notes area, pt. */
const HEADER_GAP = 12;
const MIN_HEADER_WIDTH = 80;

export interface LectureSetup {
	title: string;
	date: Date;
	header: HeaderMode;
	layout: LayoutOptions;
}

/** Name of the lecture notebook: the course/title, then the date (the PDF's name when there is no title). */
export function lectureNotebookName(title: string, pdfFileName: string, date: Date): string {
	const base = cleanTitle(title) || pdfNotebookName(pdfFileName) || "Lecture";
	return `${base} ${isoDate(date)}`;
}

/**
 * Header text box for `page`: in the notes area when the page has one (beside or below the slide), at the
 * top of the page otherwise.
 */
export function headerTextElement(page: Page, title: string, date: Date): TextElement {
	const m = page.margins;
	let x = HEADER_MARGIN;
	let y = HEADER_MARGIN;
	let width = page.width - 2 * HEADER_MARGIN;
	if (m && m.right > 0) {
		x = page.width - m.right + HEADER_GAP;
		y = HEADER_GAP;
		width = m.right - 2 * HEADER_GAP;
	} else if (m && m.bottom > 0) {
		x = HEADER_GAP;
		y = page.height - m.bottom + HEADER_GAP;
		width = page.width - 2 * HEADER_GAP;
	}
	return freezeElement({
		id: createId(),
		type: "text",
		x: Math.round(x * 100) / 100,
		y: Math.round(y * 100) / 100,
		width: Math.max(MIN_HEADER_WIDTH, Math.round(width * 100) / 100),
		text: lectureHeaderText(title, date),
		fontSize: HEADER_FONT_SIZE,
		color: HEADER_COLOR,
	});
}

/** The lecture notebook: header (if any), then the slides in the chosen layout, all from `asset`. */
export function buildLectureDocument(asset: Asset, sizes: readonly PageSizePt[], setup: LectureSetup, now: Date = new Date()): NotebookDocument {
	if (sizes.length === 0) throw new Error("the PDF has no pages");
	const slides = buildLecturePackPages(asset, sizes, 1, setup.layout);
	const first = slides[0]!;
	const pages: Page[] = [];
	if (setup.header === "page") pages.push(buildLecturePage(first, setup.title, setup.date));
	else if (setup.header === "text") first.elements = [headerTextElement(first, setup.title, setup.date)];
	pages.push(...slides);
	const doc = createDocument(now, { width: first.width, height: first.height }, { kind: "blank", spacing: PAPER_SPACING.blank });
	doc.pages = pages;
	doc.assets = { [asset.id]: asset };
	return doc;
}

export interface LectureDeps<F> extends ImportDeps<F> {
	/** Asks for the layout, header, course and date; null when cancelled. `defaultTitle` is the PDF's name. */
	ask(defaultTitle: string): Promise<LectureSetup | null>;
}

/**
 * Picks the slides, asks for the setup, stores the PDF (content-addressed, so the same file is stored once)
 * and creates and opens the lecture notebook in `folder`. Never throws: problems are reported with `notify`.
 */
export async function createLectureFromSlides<F>(deps: LectureDeps<F>, folder: string): Promise<boolean> {
	let done: (() => void) | null = null;
	try {
		const picked = await deps.pick();
		if (!picked) return false;
		const pdfName = pdfNotebookName(picked.name) || "PDF";
		const setup = await deps.ask(pdfName);
		if (!setup) return false;
		if (picked.bytes.byteLength >= LARGE_PDF_BYTES) done = deps.progress(deps.messages.working(pdfName));
		const asset = await deps.store(picked.bytes, picked.name);
		const sizes = await deps.pageSizes(asset.id);
		if (sizes.length === 0) {
			deps.notify(deps.messages.empty());
			return false;
		}
		const doc = buildLectureDocument(asset, sizes, setup);
		// Validate before creating the file: an invalid document never reaches the vault.
		const checked = serializeChecked(doc);
		if (!checked.ok) throw new Error(checked.message);
		const file = await deps.create(folder, lectureNotebookName(setup.title, picked.name, setup.date), doc);
		await deps.open(file);
		return true;
	} catch (e) {
		console.error("[notebook] lecture from slides", e);
		deps.notify(deps.messages.failed(e instanceof Error ? e.message : String(e)));
		return false;
	} finally {
		done?.();
	}
}
