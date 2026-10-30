/**
 * Page templates (roadmap #74). Pure, no Obsidian.
 *
 * A template is an ordinary notebook document (stored as a small notebook file in the templates folder)
 * whose first page is the template: its content (ink, text boxes, images), paper, size and background.
 * Nothing is added to the document format. A template never shares ids with the pages made from it:
 * every use copies the page with fresh ids.
 */
import { elementAssetId } from "./excerpts";
import { cloneMeta, createDocument, createId, createPage, createStroke, quantizePoint } from "./document";
import { duplicatePage } from "./pages";
import { freezeElement, freezeStroke } from "./serialize";
import {
	CURRENT_VERSION, DEFAULT_META, FORMAT_ID, PAGE_SIZES, PAPER_SPACING,
	type Asset, type NotebookDocument, type Page, type Point, type Stroke, type TextElement,
} from "./types";

/** Characters that cannot be in a file name (same set as storage/notebooks.ts). */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

export function templateFileName(name: string): string {
	return name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
}

/** Asset records a page uses. */
export function assetsOfPage(page: Page, doc: NotebookDocument): Asset[] {
	const ids = new Set<string>();
	if (page.background) ids.add(page.background.asset);
	for (const el of page.elements ?? []) {
		const id = elementAssetId(el);
		if (id !== null) ids.add(id);
	}
	const out: Asset[] = [];
	for (const id of ids) {
		const a = doc.assets?.[id];
		if (a) out.push({ ...a });
	}
	return out;
}

/** One-page document holding a copy of `page` (content, paper, size, background) for the templates folder. */
export function templateDocument(doc: NotebookDocument, page: Page, now: Date = new Date()): NotebookDocument {
	const iso = now.toISOString();
	const assets: Record<string, Asset> = {};
	for (const a of assetsOfPage(page, doc)) assets[a.id] = a;
	return {
		format: FORMAT_ID, version: CURRENT_VERSION, id: createId(), createdAt: iso, modifiedAt: iso,
		pages: [duplicatePage(page)], meta: cloneMeta(DEFAULT_META), assets,
	};
}

/** The page a template gives, with new ids, and the assets it needs. */
export function pageFromTemplate(template: NotebookDocument): { page: Page; assets: Asset[] } | null {
	const source = template.pages[0];
	if (!source) return null;
	return { page: duplicatePage(source), assets: assetsOfPage(source, template) };
}

/** A new notebook document whose pages are copies of the template's pages (new notebook id, empty metadata). */
export function documentFromTemplate(template: NotebookDocument, now: Date = new Date()): NotebookDocument {
	const doc = createDocument(now);
	doc.pages = template.pages.map((p) => duplicatePage(p));
	const assets: Record<string, Asset> = {};
	for (const p of template.pages) for (const a of assetsOfPage(p, template)) assets[a.id] = a;
	doc.assets = assets;
	if (doc.pages.length === 0) doc.pages = [createPage()];
	return doc;
}

// ------------------------------------------------------------------ built-in templates

/** Text that appears on built-in templates, translated by the caller. */
export interface BuiltinLabels {
	cue: string;
	notes: string;
	summary: string;
	meetingTitle: string;
	date: string;
	attendees: string;
	agenda: string;
	decisions: string;
	actions: string;
	todoTitle: string;
}

export const BUILTIN_IDS = ["cornell", "meeting", "todo"] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

const INK = "#1e293b";
const MUTED = "#64748b";

function lineStroke(x0: number, y0: number, x1: number, y1: number, width = 1.2): Stroke {
	const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 20));
	const points: Point[] = [];
	for (let i = 0; i <= n; i++) points.push(quantizePoint(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, 0.5));
	return freezeStroke(createStroke(MUTED, width, points, "shape"));
}

function boxStroke(x: number, y: number, size: number): Stroke {
	const corners: Array<[number, number]> = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
	const points: Point[] = [];
	for (let c = 0; c < 4; c++) {
		const [ax, ay] = corners[c]!;
		const [bx, by] = corners[c + 1]!;
		for (let i = 0; i < 4; i++) points.push(quantizePoint(ax + ((bx - ax) * i) / 4, ay + ((by - ay) * i) / 4, 0.5));
	}
	points.push(quantizePoint(x, y, 0.5));
	return freezeStroke(createStroke(MUTED, 1.2, points, "shape"));
}

function text(x: number, y: number, width: number, value: string, fontSize: number, color = INK): TextElement {
	return freezeElement({ id: createId(), type: "text", x, y, width, text: value, fontSize, color });
}

function cornell(l: BuiltinLabels): NotebookDocument {
	const doc = createDocument(new Date(), PAGE_SIZES.a4, { kind: "blank", spacing: PAPER_SPACING.blank });
	const page = doc.pages[0]!;
	const { width: w, height: h } = page;
	const cueX = 170;
	const summaryY = h - 150;
	page.strokes.push(lineStroke(36, 78, w - 36, 78), lineStroke(cueX, 78, cueX, summaryY), lineStroke(36, summaryY, w - 36, summaryY));
	page.elements = [
		text(cueX + 12, 44, w - cueX - 48, l.notes, 16),
		text(40, 44, cueX - 50, l.cue, 16),
		text(40, summaryY + 10, 200, l.summary, 16),
	];
	return doc;
}

function meeting(l: BuiltinLabels): NotebookDocument {
	const doc = createDocument(new Date(), PAGE_SIZES.a4, { kind: "ruled", spacing: PAPER_SPACING.ruled });
	const page = doc.pages[0]!;
	const w = page.width - 90;
	page.elements = [
		text(45, 30, w, l.meetingTitle, 22),
		text(45, 66, w / 2, `${l.date}:`, 14, MUTED),
		text(45, 90, w, `${l.attendees}:`, 14, MUTED),
		text(45, 140, w, l.agenda, 16),
		text(45, 400, w, l.decisions, 16),
		text(45, 620, w, l.actions, 16),
	];
	return doc;
}

function todo(l: BuiltinLabels): NotebookDocument {
	const doc = createDocument(new Date(), PAGE_SIZES.a4, { kind: "ruled", spacing: PAPER_SPACING.ruled });
	const page = doc.pages[0]!;
	page.elements = [text(45, 30, page.width - 90, l.todoTitle, 22)];
	const step = PAPER_SPACING.ruled;
	for (let i = 0; i < 24; i++) page.strokes.push(boxStroke(48, step * (3 + i) - 18, 14));
	return doc;
}

/** Built-in templates are generated, not stored: they need no files and cannot be damaged. */
export function builtinTemplate(id: BuiltinId, labels: BuiltinLabels): NotebookDocument {
	if (id === "cornell") return cornell(labels);
	if (id === "meeting") return meeting(labels);
	return todo(labels);
}
