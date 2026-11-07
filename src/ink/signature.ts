import { createId, createStroke } from "../model/document";
import { groupedItem } from "../model/groups";
import type { NotebookDocument, Page, PageElement, Point, Stroke } from "../model/types";
import { captureClip, instantiateClip, pasteCommand, pasteOffset, type ClipContent } from "./clipboard";
import { formatStamp, stampElement } from "./date-stamp";
import { estimateMeasure, type MeasureText } from "./text-layout";

/**
 * Reusable signature and date stamp (roadmap 154). Pure helpers: the date text of a "sign and date" stamp (locale, ISO or
 * a custom pattern), the signature clip made from the strokes of the signature pad, and the placement (fresh ids, one
 * group for the signature and its date, one undo step). The signature itself is an ordinary personal stamp (src/ink/stamps.ts).
 */

/** Name of the stamp file that holds the signature. */
export const SIGNATURE_STAMP_NAME = "My signature";
export const SIGN_DATE_MODES = ["locale", "iso", "custom"] as const;
export type SignDateMode = (typeof SIGN_DATE_MODES)[number];
export const DEFAULT_SIGN_DATE_MODE: SignDateMode = "locale";
export const DEFAULT_SIGN_DATE_CUSTOM = "DD/MM/YYYY";
const ISO = "YYYY-MM-DD";
/** Width (pt) a signature is placed with, whatever size it was drawn at. */
export const SIGNATURE_WIDTH = 150;
const GAP = 4;

export function isSignDateMode(v: unknown): v is SignDateMode {
	return typeof v === "string" && (SIGN_DATE_MODES as readonly string[]).includes(v);
}

/** The date of a stamp: the language's own long form, ISO `YYYY-MM-DD`, or the custom pattern (ISO when it is empty). */
export function signDateText(date: Date, mode: SignDateMode, custom: string, locale = "en"): string {
	if (mode === "iso") return formatStamp(date, ISO, locale);
	if (mode === "custom") {
		const pattern = custom.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
		const text = pattern === "" ? "" : formatStamp(date, pattern, locale).trim();
		return text === "" ? formatStamp(date, ISO, locale) : text;
	}
	try {
		return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
	} catch {
		return formatStamp(date, ISO, "en");
	}
}

/** A saved custom pattern: trimmed and limited; the default when nothing usable is left. */
export function cleanSignDateCustom(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_SIGN_DATE_CUSTOM;
	const pattern = raw.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
	return pattern === "" ? DEFAULT_SIGN_DATE_CUSTOM : pattern;
}

/** The signature clip from the strokes drawn on the pad (pad coordinates); null when nothing was drawn. */
export function signatureClip(strokes: readonly Stroke[], measure: MeasureText = estimateMeasure): ClipContent | null {
	const drawn = strokes.filter((s) => s.points.length > 0);
	if (drawn.length === 0) return null;
	return captureClip(drawn, [], undefined, measure);
}

/** A stroke for the pad: round ink of the signature colour and width. */
export function padStroke(color: string, width: number, points: Point[]): Stroke {
	return createStroke(color, width, points, "pen");
}

export interface SignaturePlan {
	command: ReturnType<typeof pasteCommand>;
	strokes: Stroke[];
	elements: PageElement[];
	/** The group the signature and its date share (absent when only one item is placed). */
	group: string | null;
}

/**
 * Places the signature (scaled to `SIGNATURE_WIDTH`) and/or the date text on `page`, centred on `centre`. Everything gets
 * fresh ids and, when there are several items, one fresh group so they move together. The date goes under the signature
 * (or alone). One undo step; null when there is nothing to place.
 */
export function planSignature(
	signature: ClipContent | null, doc: Readonly<NotebookDocument>, page: Page, centre: readonly [number, number],
	options: { dateText?: string | null; fontSize: number; color: string; measure?: MeasureText; newGroup?: () => string },
): SignaturePlan | null {
	void doc;
	const measure = options.measure ?? estimateMeasure;
	const dateText = options.dateText ? options.dateText : null;
	if (!signature && !dateText) return null;
	const dateHeight = options.fontSize * 1.3;
	let strokes: Stroke[] = [];
	let sigBox: { left: number; top: number; bottom: number } | null = null;
	const extra = signature && dateText ? GAP + dateHeight : 0;
	if (signature) {
		const w = signature.bounds.maxX - signature.bounds.minX;
		const k = w > 0 ? SIGNATURE_WIDTH / w : 1;
		const [dx, dy] = pasteOffset(signature.bounds, page, [centre[0], centre[1] - extra / 2], 0, k);
		strokes = instantiateClip(signature, dx, dy, undefined, measure, k).strokes;
		sigBox = {
			left: signature.bounds.minX + dx,
			top: signature.bounds.minY + dy,
			bottom: signature.bounds.minY + dy + (signature.bounds.maxY - signature.bounds.minY) * k,
		};
	}
	const elements: PageElement[] = [];
	if (dateText) {
		const x = sigBox ? sigBox.left : centre[0];
		const y = sigBox ? sigBox.bottom + GAP : centre[1];
		elements.push(stampElement(dateText, page, x, y, options.fontSize, options.color, measure));
	}
	const count = strokes.length + elements.length;
	const group = count > 1 ? (options.newGroup ?? createId)() : null;
	if (group !== null) {
		strokes = strokes.map((s) => groupedItem(s, group));
		for (let i = 0; i < elements.length; i++) elements[i] = groupedItem(elements[i]!, group);
	} else {
		// A lone item never carries a group (a group is two members or more).
		strokes = strokes.map((s) => (s.group === undefined ? s : stripGroup(s)));
	}
	return { command: pasteCommand(page, strokes, elements, [], "Sign and date"), strokes, elements, group };
}

function stripGroup<T extends { group?: string }>(item: T): T {
	const { group: _g, ...rest } = item;
	void _g;
	return rest as T;
}

