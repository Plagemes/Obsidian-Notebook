/**
 * 0.20 (#79): files dragged straight onto a page. Pure decisions (no DOM, no 'obsidian'): which dropped file becomes what,
 * what is left out and why, where a group of drops lands (a cascade) and which page a screen point is on. Testable in Node.
 */
import { extensionOf, kindFromNameAndType, MAX_BULK_IMAGE_BYTES, MAX_BULK_PDF_BYTES } from "../library/bulk-import-logic";
import { nearestPage, pageAt, toPageLocal, type Layout } from "../ink/layout";
import { screenToPage, type Viewport } from "../ink/viewport";

/** Most files taken from one drop; the rest are named in the one notice. */
export const MAX_DROP_FILES = 20;
/** Most pages of a PDF that "insert as images" places on one page. */
export const MAX_PDF_IMAGES = 8;
/** Distance between two files of a cascade, pt. */
export const CASCADE_STEP = 28;

/** What a dropped file becomes. */
export type DropKind = "image" | "pdf" | "note";
/** Why a dropped file is left out. */
export type DropReason = "unsupported" | "heic" | "empty" | "tooBig" | "tooMany" | "unreadable";

export const DROP_REASONS: readonly DropReason[] = ["unsupported", "heic", "empty", "tooBig", "tooMany", "unreadable"];

/** Where a dropped file comes from: another app (a `File`) or Obsidian's own file explorer (a vault file). */
export type DropOrigin = "os" | "vault";

/** What is known about a dropped file before its bytes are read. */
export interface DropMeta {
	name: string;
	size: number;
	type: string;
	origin: DropOrigin;
}

/** Extensions of vault files a link is made to (a Markdown note, a notebook). */
export function linkableExtension(ext: string, notebookExtensions: readonly string[]): boolean {
	return ext === "md" || notebookExtensions.includes(ext);
}

/** What one dropped file is: its kind, or the reason it is left out. */
export function classifyDrop(meta: DropMeta, notebookExtensions: readonly string[] = ["notebook"]): { kind: DropKind | null; skip: DropReason | null } {
	if (meta.origin === "vault" && linkableExtension(extensionOf(meta.name), notebookExtensions)) return { kind: "note", skip: null };
	const claimed = kindFromNameAndType(meta.name, meta.type);
	if (claimed === null) return { kind: null, skip: "unsupported" };
	if (claimed === "heic") return { kind: null, skip: "heic" };
	if (meta.size <= 0) return { kind: null, skip: "empty" };
	const limit = claimed === "pdf" ? MAX_BULK_PDF_BYTES : MAX_BULK_IMAGE_BYTES;
	if (meta.size > limit) return { kind: null, skip: "tooBig" };
	return { kind: claimed, skip: null };
}

export interface DropPlan {
	/** The files that are taken, in drop order, with what each becomes. */
	items: Array<{ index: number; kind: DropKind }>;
	/** How many files were left out, by reason. */
	skipped: Record<DropReason, number>;
}

export function emptySkips(): Record<DropReason, number> {
	return { unsupported: 0, heic: 0, empty: 0, tooBig: 0, tooMany: 0, unreadable: 0 };
}

/** Sorts the dropped files into what is taken and what is left out. At most `MAX_DROP_FILES` are taken. */
export function planDrop(metas: readonly DropMeta[], notebookExtensions: readonly string[] = ["notebook"]): DropPlan {
	const items: DropPlan["items"] = [];
	const skipped = emptySkips();
	metas.forEach((meta, index) => {
		const { kind, skip } = classifyDrop(meta, notebookExtensions);
		if (kind === null) {
			skipped[skip ?? "unsupported"]++;
		} else if (items.length >= MAX_DROP_FILES) {
			skipped.tooMany++;
		} else {
			items.push({ index, kind });
		}
	});
	return { items, skipped };
}

/** The skip reasons that occurred, most common first (ties in the order of `DROP_REASONS`). */
export function skipEntries(skipped: Readonly<Record<DropReason, number>>): Array<{ reason: DropReason; n: number }> {
	return DROP_REASONS.map((reason) => ({ reason, n: skipped[reason] })).filter((e) => e.n > 0).sort((a, b) => b.n - a.n);
}

export function totalSkipped(skipped: Readonly<Record<DropReason, number>>): number {
	return DROP_REASONS.reduce((sum, r) => sum + skipped[r], 0);
}

/**
 * Centres for `count` files dropped at (cx, cy): the first on the point, each next one a step down and to the right, so they
 * overlap like a hand of cards instead of one hiding the other. The cascade starts over when it would run off the page.
 */
export function cascadeCentres(
	count: number, cx: number, cy: number, page: { width: number; height: number }, step = CASCADE_STEP,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	if (count <= 0) return out;
	const room = Math.max(0, Math.min(page.width - cx, page.height - cy));
	const perRun = Math.max(1, Math.min(count, Math.floor(room / step) + 1));
	for (let i = 0; i < count; i++) {
		const k = i % perRun;
		out.push([round2(cx + k * step), round2(cy + k * step)]);
	}
	return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A point on a page. */
export interface DropPoint {
	pageIndex: number;
	x: number;
	y: number;
}

/**
 * The page under a client point and the point on it in page coordinates (pt), never in screen px. Between pages, or in the
 * margin, the nearest page takes it. Null outside the stage, with no pages, or for a point that is not a number.
 */
export function locateDrop(
	layout: Layout | null, viewport: Viewport, stage: { left: number; top: number; right: number; bottom: number },
	clientX: number, clientY: number,
): DropPoint | null {
	if (!layout || layout.boxes.length === 0) return null;
	if (clientX < stage.left || clientX > stage.right || clientY < stage.top || clientY > stage.bottom) return null;
	const [dx, dy] = screenToPage(viewport, clientX - stage.left, clientY - stage.top);
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
	let index = pageAt(layout, dx, dy);
	if (index < 0) index = nearestPage(layout, dy);
	const box = layout.boxes[index];
	if (!box) return null;
	const [x, y] = toPageLocal(box, dx, dy);
	return { pageIndex: index, x: round2(x), y: round2(y) };
}

/** The point clamped onto the page (a drop in the margin lands at the page edge). */
export function clampToPageBox(p: { x: number; y: number }, page: { width: number; height: number }): { x: number; y: number } {
	return { x: Math.max(0, Math.min(page.width, p.x)), y: Math.max(0, Math.min(page.height, p.y)) };
}


/** The pages of a PDF to place as pictures: the first `MAX_PDF_IMAGES` of the chosen range (1-based, inclusive). */
export function imagePageRange(range: { from: number; to: number }): { from: number; to: number; cut: boolean } {
	const to = Math.min(range.to, range.from + MAX_PDF_IMAGES - 1);
	return { from: range.from, to, cut: to < range.to };
}

/**
 * 0.20 review (D6): writes the files a drop needs (`write` says whether it created one) only now, then applies the change
 * (`apply`, the History command; false when it refused). When it refuses, or a write or the change throws, the files this drop
 * created are discarded (`discard`, best effort), so a refused drop leaves nothing behind. A file that was already there is
 * never in the list: it is shared with other notebooks.
 * `after` runs once the change has been taken (for example selecting the new elements). It can never undo the drop: the History
 * already holds the change and the next save writes it, so a throw there is reported to the console and the files stay.
 */
export async function commitWithFiles<T>(
	items: readonly T[], write: (item: T) => Promise<boolean>, discard: (item: T) => Promise<void>, apply: () => boolean, after?: () => void,
): Promise<boolean> {
	const created: T[] = [];
	const undo = async (): Promise<void> => {
		for (const item of created.reverse()) {
			try {
				await discard(item);
			} catch {
				// Nothing more can be done for a file that cannot be removed; the others are still tried.
			}
		}
	};
	try {
		for (const item of items) {
			if (await write(item)) created.push(item);
		}
		if (!apply()) {
			await undo();
			return false;
		}
	} catch (e) {
		await undo();
		throw e;
	}
	try {
		after?.();
	} catch (e) {
		console.error("[notebook] drop files: after-commit step failed", e);
	}
	return true;
}
