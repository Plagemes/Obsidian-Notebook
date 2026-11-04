/**
 * Snap while a selection is dragged (roadmap #71): the part between the page and the pure maths of model/snap.ts.
 * Pure (no 'obsidian', no DOM): the view builds a `SnapSession` when a drag starts and calls `snapDragged` on every
 * pointer sample; nothing here is stored, and nothing is drawn (the guides go to the renderer's live layer).
 */
import { clusterStrokes } from "../ink/align";
import { elementBounds, type MeasureText } from "../ink/elements";
import { strokeBounds, type BBox } from "../ink/hit-test";
import { estimateMeasure } from "../ink/text-layout";
import { multiply, scaleAbout, scaleFactor, translate, type Matrix } from "../ink/transform";
import { gridOf, snapMove, snapScale, snapTargets, transformedBox, usesGrid, usesGuides, type SnapGrid, type SnapGuide, type SnapMode, type SnapTargets } from "../model/snap";
import type { Page, PageElement, Stroke } from "../model/types";

/** A page with more strokes than this is not searched for alignment lines among its ink (its pictures and text boxes still are). */
export const MAX_SNAP_STROKES = 3000;

/** What a drag snaps to: built once when it starts. */
export interface SnapSession {
	targets: SnapTargets | null;
	grid: SnapGrid | null;
}

/**
 * The lines for dragging a selection of `page`. `selected` strokes and elements (and the ink that floats with them) are not
 * targets. Null when `mode` has nothing to snap to on this page (grid mode on blank paper).
 */
export function buildSnapSession(
	page: Page, mode: SnapMode, selectedStrokes: ReadonlySet<Stroke>, selectedElements: ReadonlySet<PageElement>, measure: MeasureText = estimateMeasure,
): SnapSession | null {
	const grid = usesGrid(mode) ? gridOf(page) : null;
	let targets: SnapTargets | null = null;
	if (usesGuides(mode)) {
		const boxes: BBox[] = [];
		for (const e of page.elements ?? []) if (!selectedElements.has(e)) boxes.push(elementBounds(e, measure));
		if (page.strokes.length <= MAX_SNAP_STROKES) {
			const rest = page.strokes.filter((s) => !selectedStrokes.has(s));
			for (const group of clusterStrokes(rest)) {
				let box: BBox | null = null;
				for (const s of group) {
					const b = strokeBounds(s);
					box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
				}
				if (box) boxes.push(box);
			}
		}
		targets = snapTargets(page, boxes);
	}
	return grid || targets ? { targets, grid } : null;
}

/**
 * The session for a selection drag that is starting, or null when it has nothing to snap to: a switched-off snap, a rotation, a
 * selection across pages, no page, or (0.17) the states' part editor's selection: its handles set the part's pose and the
 * pose must land where the pen put it, not be pulled toward the grid or the guides.
 */
export function dragSnapSession(i: {
	mode: SnapMode | "off"; kind: "move" | "scale" | "rotate"; crossPage: boolean; ownedByStates: boolean; page: Page | null;
	strokes: ReadonlySet<Stroke>; elements: ReadonlySet<PageElement>; measure?: MeasureText;
}): SnapSession | null {
	if (i.mode === "off" || i.kind === "rotate" || i.crossPage || i.ownedByStates || !i.page) return null;
	return buildSnapSession(i.page, i.mode, i.strokes, i.elements, i.measure);
}

export interface SnapDragInput {
	kind: "move" | "scale";
	/** Bounds of the selection before any matrix, page units. */
	bounds: BBox;
	/** The matrix the selection had when the drag started. */
	startMatrix: Matrix;
	/** The matrix the pointer asks for. */
	matrix: Matrix;
	session: SnapSession;
	mode: SnapMode;
	/** Reach in page units (strength in px divided by the view scale). */
	thr: number;
}

export interface SnapDragResult {
	matrix: Matrix;
	guides: SnapGuide[];
}

/** The matrix of the drag after snapping, and the guides to show. A rotation is never snapped (callers do not pass it). */
export function snapDragged(i: SnapDragInput): SnapDragResult {
	const { session, mode, thr } = i;
	if (i.kind === "move") {
		const box = transformedBox(i.bounds, i.matrix);
		const r = snapMove(box, session.targets, session.grid, mode, thr);
		const matrix = r.dx === 0 && r.dy === 0 ? i.matrix : multiply(translate(r.dx, r.dy), i.matrix);
		return { matrix, guides: r.guides };
	}
	const m0 = i.startMatrix;
	const base = scaleFactor(m0);
	const k = base > 0 ? scaleFactor(i.matrix) / base : 1;
	const ax = m0[0] * i.bounds.minX + m0[2] * i.bounds.minY + m0[4];
	const ay = m0[1] * i.bounds.minX + m0[3] * i.bounds.minY + m0[5];
	const r = snapScale(transformedBox(i.bounds, m0), [ax, ay], k, session.targets, session.grid, mode, thr);
	const matrix = r.k === k ? i.matrix : multiply(scaleAbout(r.k, r.k, ax, ay), m0);
	return { matrix, guides: r.guides };
}
