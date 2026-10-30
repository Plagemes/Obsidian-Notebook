import { Notice, type App } from "obsidian";
import { t } from "../i18n";
import { elementsInLasso } from "../ink/elements";
import type { BBox } from "../ink/hit-test";
import type { Pt, TrailPoint } from "../ink/gestures/geometry";
import { boundsOf as boxOf } from "../ink/gestures/geometry";
import type { GestureWorld, Recognition } from "../ink/gestures/resolve";
import { strokesInLasso } from "../ink/lasso";
import { measureText } from "../ink/renderer";
import { detectScribble, scribbleEraseSteps, scribbleVictims } from "../ink/scribble";
import { movePlan } from "../ink/gestures/move";
import { planSpaceChange } from "../ink/space";
import { cloneMeta, createStroke } from "../model/document";
import { AddStroke, SetMeta, type Command } from "../model/history";
import { visibleStrokes } from "../model/markers";
import { pageContentCommand } from "../model/page-content";
import { freezeStroke } from "../model/serialize";
import { DEFAULT_META, RENDER_INK, type NotebookDocument, type Page, type PageElement, type Point, type Stroke } from "../model/types";
import type { NotebookSettings } from "../settings";
import { runCommand } from "./obsidian-commands";
import { toggleBookmark } from "./view-helpers";

/** What the gesture actions need from the notebook view (the view implements it with its private state). */
export interface PenGestureView {
	app: App;
	settings(): NotebookSettings;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Page index under a point of the stage (CSS px), or -1. */
	pageIndexAt(p: Pt): number;
	/** Page-local coordinates (pt) of a stage point on a page. */
	toLocal(pageIndex: number, p: Pt): [number, number] | null;
	stageRect(): DOMRect;
	boundsOf(): ((s: Stroke) => BBox) | undefined;
	/** v8: whether the hidden ink of `page` is shown (solutions revealed); hidden ink is never a gesture target otherwise. */
	revealed(page: Page): boolean;
	/** The current lasso selection, if any (page, strokes, objects). */
	selection(): { pageIndex: number; strokes: readonly Stroke[]; elements: readonly PageElement[] } | null;
	/** Is this page-local point on the selection (box or handles)? */
	selectionHit(pageIndex: number, local: [number, number]): boolean;
	selectPolygon(pageIndex: number, polygon: Array<[number, number]>): void;
	clearSelection(): void;
	penStyle(): { color: string; width: number };
	/** Runs commands as one gesture: one history step each, then the view is refreshed. */
	execute(commands: Command[]): void;
	editTags(page: Page): void;
	openSearch(): void;
}

/** The page the stroke is mostly on: the page under the middle of its box, else the one under its first point. */
function pageOf(v: PenGestureView, pts: readonly Pt[]): number {
	const b = boxOf(pts);
	const mid = v.pageIndexAt({ x: b.minX + b.w / 2, y: b.minY + b.h / 2 });
	return mid >= 0 ? mid : v.pageIndexAt(pts[0]!);
}

function toLocalPoints(v: PenGestureView, pageIndex: number, pts: readonly Pt[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const p of pts) {
		const l = v.toLocal(pageIndex, p);
		if (l) out.push(l);
	}
	return out;
}

/** Answers the recognisers' questions about the page (screen px in, page data out). */
export function gestureWorld(v: PenGestureView): GestureWorld {
	return {
		enclosedInk(loop) {
			const idx = pageOf(v, loop);
			const page = v.doc()?.pages[idx];
			if (!page) return 0;
			const poly = toLocalPoints(v, idx, loop);
			return strokesInLasso(visibleStrokes(page.strokes, v.revealed(page)), poly).length + elementsInLasso(page.elements ?? [], poly, measureText).length;
		},
		scribbleVictims(trail) {
			if (trail.length < 6) return 0;
			const idx = pageOf(v, trail);
			const page = v.doc()?.pages[idx];
			if (!page) return 0;
			const pts: Point[] = [];
			for (const p of trail) {
				const l = v.toLocal(idx, p);
				if (l) pts.push([l[0], l[1], p.p ?? 0.5]);
			}
			const duration = trail[trail.length - 1]!.t - trail[0]!.t;
			const scribble = detectScribble(pts, duration);
			return scribble ? scribbleVictims(scribble, page.strokes, v.penStyle().width, v.boundsOf(), v.revealed(page)).length : 0;
		},
		onPage: (p) => v.pageIndexAt(p) >= 0,
		onSelection(p) {
			const sel = v.selection();
			const local = sel ? v.toLocal(sel.pageIndex, p) : null;
			return !!sel && !!local && v.selectionHit(sel.pageIndex, local);
		},
		thumbnailAt(p) {
			const r = v.stageRect();
			const el = document.elementFromPoint(r.left + p.x, r.top + p.y);
			const item = el?.closest(".notebook-navigator-item");
			const n = item ? Number(item.getAttribute("data-index")) : NaN;
			return Number.isInteger(n) && n >= 0 ? n : -1;
		},
		selectionPage: () => v.selection()?.pageIndex ?? -1,
	};
}

interface GestureInk {
	page: Page;
	stroke: Stroke;
}

/**
 * The gesture stroke as ordinary ink, built only to be put into the undo history. It is never drawn and never saved
 * on its own: the gesture's effect is recorded after it, so one Undo reverts the effect and leaves the stroke as the
 * user's ink, and a second Undo removes the stroke too.
 */
function gestureInk(v: PenGestureView, trail: readonly TrailPoint[]): GestureInk | null {
	const idx = pageOf(v, trail);
	const page = v.doc()?.pages[idx];
	if (!page) return null;
	const pts: Point[] = [];
	for (const p of trail) {
		const l = v.toLocal(idx, p);
		if (l) pts.push([l[0], l[1], p.p ?? 0.5]);
	}
	if (pts.length < 2) return null;
	const { color, width } = v.penStyle();
	return { page, stroke: freezeStroke(createStroke(color, width, pts, "pen", RENDER_INK)) };
}

/** Records `effect` after the gesture stroke (see `gestureInk`). Without a stroke the effect is recorded alone. */
function executeKeeping(v: PenGestureView, ink: GestureInk | null, effect: Command): void {
	v.execute(ink ? [new AddStroke(ink.page.id, ink.stroke, ink.page.strokes.length), effect] : [effect]);
}

/**
 * Carries out a recognised gesture. Gestures that change the page (delete, space, bookmark, move) are recorded in the undo
 * history after the gesture stroke, so Undo gives back the page as it was and the stroke as ink; gestures that only open
 * something (select, tags, search, a command) leave no undo step and the stroke is dropped.
 */
export function runGesture(v: PenGestureView, r: Recognition, trail: readonly TrailPoint[]): void {
	if (r.type === "custom") {
		const ok = runCommand(v.app, r.gesture.command);
		if (!ok) new Notice(t("gesture.custom.commandMissing", { id: r.gesture.command }));
		return;
	}
	if (r.type !== "builtin") return;
	const doc = v.doc();
	if (!doc) return;
	switch (r.id) {
		case "select": {
			const idx = pageOf(v, trail);
			if (idx >= 0) v.selectPolygon(idx, toLocalPoints(v, idx, trail));
			return;
		}
		case "search":
			v.openSearch();
			return;
		case "tag": {
			const page = doc.pages[v.pageIndexAt(r.anchor)];
			if (page && v.editable()) v.editTags(page);
			return;
		}
		default:
	}
	if (!v.editable()) return;
	const ink = gestureInk(v, trail);
	switch (r.id) {
		case "delete": {
			if (!ink) return;
			const steps = scribbleEraseSteps(ink.page, ink.stroke, trail[trail.length - 1]!.t - trail[0]!.t, v.boundsOf(), {}, v.revealed(ink.page));
			if (steps) {
				v.clearSelection();
				v.execute([steps.keep, steps.erase]);
			}
			return;
		}
		case "space": {
			const idx = v.pageIndexAt(r.anchor);
			const local = idx >= 0 ? v.toLocal(idx, r.anchor) : null;
			if (!local) return;
			const plan = planSpaceChange(doc.pages, idx, local[1], v.settings().penGestureSpacePt, measureText, v.boundsOf());
			if (!plan) {
				new Notice(t("space.nothing"));
				return;
			}
			v.clearSelection();
			executeKeeping(v, ink, pageContentCommand(doc, plan, "Insert space"));
			return;
		}
		case "bookmark": {
			const page = doc.pages[v.pageIndexAt(r.anchor)];
			if (!page) return;
			const before = doc.meta ?? cloneMeta(DEFAULT_META);
			const marked = before.bookmarks.includes(page.id);
			executeKeeping(v, ink, new SetMeta(before, toggleBookmark(before, page.id)));
			new Notice(t(marked ? "gesture.bookmarkRemoved" : "gesture.bookmarkAdded"));
			return;
		}
		case "move": {
			const sel = v.selection();
			if (!sel || r.target === undefined) return;
			const plan = movePlan(doc, sel, r.target, measureText);
			if (!plan) {
				new Notice(t("gesture.moveNothing"));
				return;
			}
			v.clearSelection();
			executeKeeping(v, ink, pageContentCommand(doc, plan, "Move to page"));
			new Notice(t("gesture.moved", { n: String(r.target + 1) }));
			return;
		}
		default:
	}
}
