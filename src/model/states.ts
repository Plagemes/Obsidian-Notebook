// v13 (#241): drawings with states. A part is a group of strokes of a page; a state says, for each part, where it is
// (shift, rotation, scale, visibility, colour). The strokes are never changed: a state is applied when the page is drawn
// or exported (`stateView`), as copies of the member strokes with transformed points. Pure, no 'obsidian'. The file form
// is in states-format.ts / serialize.ts; the view (view/states-tools.ts) edits the table through `SetPageStates`.
import { strokeBounds, type BBox } from "../ink/hit-test";
import { transformStroke } from "../ink/lasso";
import { apply, IDENTITY, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Matrix } from "../ink/transform";
import type { Command } from "./history";
import { freezeStroke } from "./serialize";
import { canonicalPose, cleanStateName, isIdentityPose, normalizePageStates } from "./states-format";
import {
	STATES_ID_MAX, STATES_MAX_PARTS, STATES_MAX_SCALE, STATES_MAX_STATES, STATES_MIN_SCALE, type NotebookDocument, type Page, type PageState, type PageStates, type PartPose, type StatePart, type Stroke,
} from "./types";

const round = (v: number, digits: number): number => {
	const k = 10 ** digits;
	return Math.round(v * k) / k;
};

/** A short id (8 base-36 characters) not in `taken`. */
export function newStateId(taken: Iterable<string>, random: () => number = Math.random): string {
	const used = new Set(taken);
	for (;;) {
		let id = "";
		for (let i = 0; i < 8; i++) id += Math.floor(random() * 36).toString(36);
		if (!used.has(id) && id.length <= STATES_ID_MAX) return id;
	}
}

function freeze<T extends PageStates>(s: T): T {
	for (const p of s.parts) {
		Object.freeze(p.pivot);
		Object.freeze(p.items);
		Object.freeze(p);
	}
	for (const st of s.list) {
		for (const pose of st.poses) Object.freeze(pose);
		Object.freeze(st.poses);
		Object.freeze(st);
	}
	Object.freeze(s.parts);
	Object.freeze(s.list);
	return Object.freeze(s);
}

/** A deep, mutable-looking-but-frozen copy of the table (every edit builds a new one: committed tables are immutable). */
export function cloneStates(s: PageStates): PageStates {
	return freeze({
		parts: s.parts.map((p) => ({ ...p, pivot: [p.pivot[0], p.pivot[1]] as [number, number], items: [...p.items] })),
		list: s.list.map((st) => ({ ...st, poses: st.poses.map((p) => ({ ...p })) })),
		...(s.active !== undefined ? { active: s.active } : {}),
	});
}

export function emptyStates(): PageStates {
	return freeze({ parts: [], list: [] });
}

/** The state the page shows now: the state named by `active`, or null for the drawing as drawn. */
export function activeState(page: Page): PageState | null {
	const s = page.states;
	if (!s || s.active === undefined) return null;
	return s.list.find((st) => st.id === s.active) ?? null;
}

export function stateById(states: PageStates | undefined, id: string | null | undefined): PageState | null {
	if (!states || !id) return null;
	return states.list.find((st) => st.id === id) ?? null;
}

export function partById(states: PageStates | undefined, id: string): StatePart | null {
	return states?.parts.find((p) => p.id === id) ?? null;
}

/** The part a stroke belongs to, or null. */
export function partOfStroke(states: PageStates | undefined, strokeId: string): StatePart | null {
	if (!states) return null;
	return states.parts.find((p) => p.items.includes(strokeId)) ?? null;
}

/** The parts with at least one stroke on the page (the others are not written). */
export function livingParts(page: Page): StatePart[] {
	const s = page.states;
	if (!s) return [];
	const ids = new Set(page.strokes.map((x) => x.id));
	return s.parts.filter((p) => p.items.some((id) => ids.has(id)));
}

/** The strokes of `page` that belong to `part`, in page order. */
export function strokesOfPart(page: Page, part: StatePart): Stroke[] {
	const set = new Set(part.items);
	return page.strokes.filter((s) => set.has(s.id));
}

export function poseIn(state: PageState | null | undefined, partId: string): PartPose | undefined {
	return state?.poses.find((p) => p.part === partId);
}

// --- the transform ---

/** The matrix of a pose about the part's pivot: scale, then rotation, then the shift. Identity for no pose. */
export function poseMatrix(pose: Omit<PartPose, "part"> | undefined, pivot: readonly [number, number]): Matrix {
	if (!pose) return IDENTITY;
	const s = pose.scale ?? 1;
	const rad = ((pose.rot ?? 0) * Math.PI) / 180;
	let m: Matrix = IDENTITY;
	if (s !== 1) m = scaleAbout(s, s, pivot[0], pivot[1]);
	if (rad !== 0) m = multiply(rotateAbout(rad, pivot[0], pivot[1]), m);
	const dx = pose.dx ?? 0;
	const dy = pose.dy ?? 0;
	if (dx !== 0 || dy !== 0) m = multiply(translate(dx, dy), m);
	return m;
}

/**
 * The shift, rotation (degrees) and scale of a part that a total matrix (a similarity: move, uniform scale, rotation)
 * stands for about `pivot` — the inverse of `poseMatrix`. Rounded like the file keeps them.
 */
export function poseFromMatrix(m: Matrix, pivot: readonly [number, number]): { dx: number; dy: number; rot: number; scale: number } {
	const scale = Math.hypot(m[0], m[1]);
	const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
	const [px, py] = apply(m, pivot[0], pivot[1]);
	return {
		dx: round(px - pivot[0], 2),
		dy: round(py - pivot[1], 2),
		rot: round(rot, 2),
		scale: round(Math.min(STATES_MAX_SCALE, Math.max(STATES_MIN_SCALE, scale)), 4),
	};
}

/** Bounds of a set of strokes (page coordinates), or null when empty. */
export function strokesBounds(strokes: readonly Stroke[]): BBox | null {
	if (strokes.length === 0) return null;
	const boxes = strokes.map(strokeBounds);
	return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

// --- the page as a state shows it ---

/** Transformed copies of strokes, kept per (stroke, pose): the renderer caches its paths by object, so an unchanged part keeps its copy. */
const variants = new WeakMap<Stroke, Map<string, Stroke>>();
const VARIANTS_PER_STROKE = 8;

function derive(s: Stroke, pose: PartPose, pivot: readonly [number, number]): Stroke {
	const key = `${pose.dx ?? 0},${pose.dy ?? 0},${pose.rot ?? 0},${pose.scale ?? 1},${pose.color ?? ""},${pivot[0]},${pivot[1]}`;
	let cache = variants.get(s);
	if (!cache) {
		cache = new Map<string, Stroke>();
		variants.set(s, cache);
	}
	const hit = cache.get(key);
	if (hit) return hit;
	const m = poseMatrix(pose, pivot);
	let out = isIdentity(m) ? s : transformStroke(s, m);
	if (pose.color !== undefined) out = { ...out, color: pose.color };
	freezeStroke(out);
	if (cache.size >= VARIANTS_PER_STROKE) cache.delete(cache.keys().next().value as string);
	cache.set(key, out);
	return out;
}

/** The poses of `state` by stroke id: which transform each member stroke gets. */
function posedStrokes(states: PageStates, state: PageState): Map<string, { pose: PartPose; pivot: [number, number] }> {
	const posed = new Map<string, { pose: PartPose; pivot: [number, number] }>();
	for (const pose of state.poses) {
		const part = states.parts.find((p) => p.id === pose.part);
		if (!part || isIdentityPose(pose)) continue;
		for (const id of part.items) posed.set(id, { pose, pivot: part.pivot });
	}
	return posed;
}

/**
 * The page as state `stateId` shows it (null: as drawn): the same page when nothing moves, else a page whose strokes are
 * the member strokes transformed (hidden parts left out) in the same draw order. The document is never touched. The
 * page keeps its id and its other content, so renderer, export and thumbnails treat it like the real one.
 */
export function stateView(page: Page, stateId: string | null = activeState(page)?.id ?? null): Page {
	const states = page.states;
	const state = stateById(states, stateId);
	if (!states || !state) return page;
	const posed = posedStrokes(states, state);
	if (posed.size === 0) return page;
	const strokes: Stroke[] = [];
	for (const s of page.strokes) {
		const p = posed.get(s.id);
		if (!p) strokes.push(s);
		else if (!p.pose.hidden) strokes.push(derive(s, p.pose, p.pivot));
	}
	return { ...page, strokes };
}

/** What a view shows instead of a page's saved state: page id to state id (null: as drawn). Read-only views switch states without saving. */
export type ShownStates = ReadonlyMap<string, string | null>;

/** The state a page is shown in: the view's choice for it, else the saved `active` (null: as drawn). */
export function shownStateId(page: Page, shown?: ShownStates): string | null {
	if (shown?.has(page.id)) return shown.get(page.id) ?? null;
	return page.states?.active ?? null;
}

/** Whether the page shows a state that moves, hides or recolours something. */
export function showsState(page: Page, shown?: ShownStates): boolean {
	const states = page.states;
	const state = stateById(states, shownStateId(page, shown));
	return !!states && !!state && posedStrokes(states, state).size > 0;
}

interface LiveCache {
	id: string;
	states: PageStates;
	source: readonly Stroke[];
	/** Null: the state moves nothing, the page's own strokes are shown. */
	strokes: Stroke[] | null;
}

const liveViews = new WeakMap<Page, { shown: ShownStates | undefined; view: Page }>();

function sameStrokes(a: readonly Stroke[], b: readonly Stroke[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * A page that shows `page` in the state the view has chosen for it, and follows `page` as it changes: everything but
 * `strokes` (size, background, margins, elements, ...) is the page's own, and `strokes` is the page's strokes when it
 * shows the drawing as drawn, else the transformed copies (recomputed only when the state, the table or the page's ink
 * changed, so ink added or erased meanwhile is always right). The renderer and the exports get these instead of the page.
 */
export function liveStateView(page: Page, shown?: ShownStates): Page {
	const hit = liveViews.get(page);
	if (hit && hit.shown === shown) return hit.view;
	let cache: LiveCache | null = null;
	const view = Object.create(page, {
		strokes: {
			enumerable: true,
			get(): Stroke[] {
				const id = shownStateId(page, shown);
				const states = page.states;
				if (id === null || !states) return page.strokes;
				const source = page.strokes;
				if (!cache || cache.id !== id || cache.states !== states || !sameStrokes(cache.source, source)) {
					const shownPage = stateView(page, id);
					cache = { id, states, source: [...source], strokes: shownPage === page ? null : shownPage.strokes };
				}
				return cache.strokes ?? source;
			},
		},
	}) as Page;
	liveViews.set(page, { shown, view });
	return view;
}

/**
 * The pages as their states show them: `pages` itself when no page has states (the common case costs nothing); a page
 * with states is replaced by its live view (`liveStateView`).
 */
export function viewPages(pages: readonly Page[], shown?: ShownStates): readonly Page[] {
	if (!pages.some((p) => p.states)) return pages;
	return pages.map((p) => (p.states ? liveStateView(p, shown) : p));
}

/**
 * The strokes of `page` that a shown state has moved away from where they were drawn: ink tools skip them (a hit at the
 * drawn spot would hit nothing the reader sees). Null when the page shows no such state.
 */
export function displacedStrokeIds(page: Page, shown?: ShownStates): ReadonlySet<string> | null {
	const states = page.states;
	const state = stateById(states, shownStateId(page, shown));
	if (!states || !state) return null;
	const posed = posedStrokes(states, state);
	return posed.size > 0 ? new Set(posed.keys()) : null;
}

// --- editing: pure functions from a table to a new table ---

/** The table with `states` as its base (empty when there is none yet). */
function base(states: PageStates | undefined): PageStates {
	return states ?? emptyStates();
}

function pruneEmpty(s: PageStates): PageStates {
	const live = new Set(s.parts.filter((p) => p.items.length > 0).map((p) => p.id));
	if (live.size === s.parts.length) return s;
	return freeze({
		parts: s.parts.filter((p) => live.has(p.id)),
		list: s.list.map((st) => ({ ...st, poses: st.poses.filter((p) => live.has(p.part)) })),
		...(s.active !== undefined ? { active: s.active } : {}),
	});
}

/** The strokes leave the parts they were in (a part left without a stroke goes, with its poses). */
export function withoutItems(states: PageStates | undefined, ids: ReadonlySet<string>): PageStates | undefined {
	if (!states) return undefined;
	if (!states.parts.some((p) => p.items.some((id) => ids.has(id)))) return states;
	return pruneEmpty(freeze({
		parts: states.parts.map((p) => ({ ...p, pivot: p.pivot, items: p.items.filter((id) => !ids.has(id)) })),
		list: states.list, ...(states.active !== undefined ? { active: states.active } : {}),
	}));
}

export interface PartEdit {
	states: PageStates;
	partId: string;
}

/**
 * A new part made of `strokes` (they leave the parts they were in). Its pivot is the centre of their bounds. Null when
 * there is nothing to group or the page already has the most parts. `name`: shown in the part list.
 */
export function makePart(states: PageStates | undefined, strokes: readonly Stroke[], name?: string, random?: () => number): PartEdit | null {
	if (strokes.length === 0) return null;
	const cleaned = withoutItems(states, new Set(strokes.map((s) => s.id)));
	const current = base(cleaned);
	if (current.parts.length >= STATES_MAX_PARTS) return null;
	const b = strokesBounds(strokes)!;
	const id = newStateId([...current.parts.map((p) => p.id), ...current.list.map((s) => s.id)], random);
	const part: StatePart = { id, pivot: [round((b.minX + b.maxX) / 2, 2), round((b.minY + b.maxY) / 2, 2)], items: strokes.map((s) => s.id) };
	const label = cleanStateName(name);
	if (label !== undefined) part.name = label;
	return { states: freeze({ parts: [...current.parts, part], list: current.list, ...(current.active !== undefined ? { active: current.active } : {}) }), partId: id };
}

/** The part dissolves: its strokes are ordinary ink again and its poses go. */
export function dissolvePart(states: PageStates, partId: string): PageStates {
	return freeze({
		parts: states.parts.filter((p) => p.id !== partId),
		list: states.list.map((st) => ({ ...st, poses: st.poses.filter((p) => p.part !== partId) })),
		...(states.active !== undefined ? { active: states.active } : {}),
	});
}

export function renamePart(states: PageStates, partId: string, name: string): PageStates {
	const label = cleanStateName(name);
	return freeze({
		parts: states.parts.map((p) => {
			if (p.id !== partId) return p;
			const next: StatePart = { id: p.id, pivot: p.pivot, items: p.items };
			if (label !== undefined) next.name = label;
			return next;
		}),
		list: states.list, ...(states.active !== undefined ? { active: states.active } : {}),
	});
}

export interface StateEdit {
	states: PageStates;
	stateId: string;
}

/** A new state, shown at once. `from`: a state to start from (its poses are copied), else every part is where it was drawn. Null at the limit. */
export function addState(states: PageStates | undefined, name: string, from?: string | null, random?: () => number): StateEdit | null {
	const current = base(states);
	if (current.list.length >= STATES_MAX_STATES) return null;
	const id = newStateId([...current.parts.map((p) => p.id), ...current.list.map((s) => s.id)], random);
	const source = stateById(current, from ?? null);
	const state: PageState = { id, name: cleanStateName(name) ?? "State", poses: source ? source.poses.map((p) => ({ ...p })) : [] };
	return { states: freeze({ parts: current.parts, list: [...current.list, state], active: id }), stateId: id };
}

export function renameState(states: PageStates, stateId: string, name: string): PageStates {
	const label = cleanStateName(name);
	if (label === undefined) return states;
	return freeze({ parts: states.parts, list: states.list.map((s) => (s.id === stateId ? { ...s, name: label } : s)), ...(states.active !== undefined ? { active: states.active } : {}) });
}

/** The state goes; when it was shown, the page shows the drawing as drawn. */
export function deleteState(states: PageStates, stateId: string): PageStates {
	const active = states.active === stateId ? undefined : states.active;
	return freeze({ parts: states.parts, list: states.list.filter((s) => s.id !== stateId), ...(active !== undefined ? { active } : {}) });
}

/** The state shown by the page: null shows the drawing as drawn. */
export function withActive(states: PageStates, stateId: string | null): PageStates {
	const next: PageStates = { parts: states.parts, list: states.list };
	if (stateId !== null && states.list.some((s) => s.id === stateId)) next.active = stateId;
	return freeze(next);
}

/** Where part `partId` is in state `stateId`. `pose` replaces the part's pose there; null puts the part back where it was drawn. */
export function withPose(states: PageStates, stateId: string, partId: string, pose: Omit<PartPose, "part"> | null): PageStates {
	const next = pose ? canonicalPose({ ...pose, part: partId }) : null;
	return freeze({
		parts: states.parts,
		list: states.list.map((st) => {
			if (st.id !== stateId) return st;
			const poses = st.poses.filter((p) => p.part !== partId);
			if (next) poses.push(next);
			return { ...st, poses };
		}),
		...(states.active !== undefined ? { active: states.active } : {}),
	});
}

/** The id that comes `step` places after the shown state in the order "as drawn", then the states (wrapping); null is "as drawn". */
export function steppedState(states: PageStates | undefined, step: 1 | -1, current: string | null = states?.active ?? null): string | null {
	if (!states || states.list.length === 0) return null;
	const order: Array<string | null> = [null, ...states.list.map((s) => s.id)];
	const at = Math.max(0, order.indexOf(current));
	return order[(at + step + order.length) % order.length] ?? null;
}

/** "State 1", "State 2", ...: the first name of the form that is free. */
export function freshStateName(states: PageStates | undefined, label: string): string {
	const names = new Set((states?.list ?? []).map((s) => s.name));
	for (let n = (states?.list.length ?? 0) + 1; ; n++) if (!names.has(`${label} ${n}`)) return `${label} ${n}`;
}

/**
 * The table with its strokes under other ids (a copied page, a merged copy): `map` gives the new id of a stroke or
 * undefined when the stroke did not come along. Parts and states keep their ids (they are scoped to the page).
 */
export function remapStates(states: PageStates | undefined, map: (strokeId: string) => string | undefined): PageStates | undefined {
	if (!states) return undefined;
	const mapped = freeze({
		parts: states.parts.map((p) => ({ ...p, pivot: [p.pivot[0], p.pivot[1]] as [number, number], items: p.items.map(map).filter((id): id is string => id !== undefined) })),
		list: states.list.map((st) => ({ ...st, poses: st.poses.map((p) => ({ ...p })) })),
		...(states.active !== undefined ? { active: states.active } : {}),
	});
	const pruned = pruneEmpty(mapped);
	return pruned.parts.length === 0 && pruned.list.length === 0 ? undefined : pruned;
}

// --- the undoable command ---

/**
 * Replaces the states of a page (one user action = one command; `Batch` it with other edits of the same action). Undo
 * puts the previous table back, which also puts back the state that was shown then. A missing page is a no-op.
 */
export class SetPageStates implements Command {
	constructor(readonly pageId: string, readonly before: PageStates | undefined, readonly after: PageStates | undefined, readonly label = "Change states") {}

	private set(doc: NotebookDocument, states: PageStates | undefined): void {
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		if (states) page.states = states;
		else delete page.states;
	}

	apply(doc: NotebookDocument): void {
		this.set(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		this.set(doc, this.before);
	}
}

/** The table as the writer would keep it for `page` (dangling strokes and unused parts removed) — what a reader sees after a save. */
export function writtenStates(page: Page): PageStates | undefined {
	return normalizePageStates(page.states, new Set(page.strokes.map((s) => s.id)));
}
