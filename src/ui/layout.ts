// ui redesign: the layout engine. From the action registry, the current context, the width of the view and the use
// counts, it decides what the primary toolbar shows in its quick slots, what the contextual bar offers, and how the
// "All actions" and page sheets are organised. Deterministic and pure (no DOM, no 'obsidian'): unit-tested.
import { ACTIONS, activeContexts, GROUP_ORDER, isRelevant, type ActionDef, type ActionGroup, type ContextKind, type Surface, type UiContext } from "./actions";
import { usageBoost, type UsageMap } from "./usage";

/** Sizes (CSS px) the toolbar is laid out with. They match styles.css (40 px buttons, 4 px gaps). */
export const TOOLBAR_METRICS = {
	/** One icon button and its gap. */
	slot: 44,
	/** Horizontal padding of the bar. */
	padding: 16,
	/** Gap between groups. */
	gap: 8,
	/** Pages panel button and the seven tools, with a divider. */
	tools: 8 * 44 + 12,
	/** Undo and redo. */
	history: 2 * 44,
	/** Current-pen indicator. */
	chip: 44,
	/** Six favourite pens of 40 px with 2 px gaps (the strip scrolls sideways when there is less room). */
	favourites: 6 * 42,
	/** Page indicator, save dot and the "All actions" button; the wide bar also shows the save state as text. */
	endNarrow: 64 + 20 + 44,
	endWide: 64 + 96 + 44,
} as const;

/** At most this many quick slots, however wide the view: a calm bar beats a crowded one. */
export const MAX_QUICK = 6;
/** The single-row bar needs room for at least this many quick slots, or it uses two rows. */
const MIN_QUICK_SINGLE_ROW = 2;

export interface ToolbarPlan {
	/** Tools and actions share one row (wide views); otherwise two rows. */
	singleRow: boolean;
	/** Number of ranked quick actions that fit. */
	quickSlots: number;
}

/** How the toolbar uses a view `width` CSS px wide. */
export function toolbarPlan(width: number): ToolbarPlan {
	const m = TOOLBAR_METRICS;
	const inner = Math.max(0, width - m.padding);
	const actions = (end: number) => m.history + m.chip + m.favourites + end + 3 * m.gap;
	const singleRoom = inner - m.tools - m.gap - actions(m.endWide) - m.gap;
	if (singleRoom >= MIN_QUICK_SINGLE_ROW * m.slot) {
		return { singleRow: true, quickSlots: Math.min(MAX_QUICK, Math.floor(singleRoom / m.slot)) };
	}
	const room = inner - actions(m.endNarrow) - m.gap;
	return { singleRow: false, quickSlots: Math.max(0, Math.min(MAX_QUICK, Math.floor(room / m.slot))) };
}

/** Score used to order actions: designed priority plus a boost for recent, frequent use. */
export function score(a: ActionDef, usage: UsageMap, now: number): number {
	return a.priority + usageBoost(usage[a.id], now);
}

/** Relevant actions placed on `surface`, best first (ties keep the registry order). */
export function ranked(surface: Surface, c: UiContext, usage: UsageMap, now: number, actions: readonly ActionDef[] = ACTIONS): ActionDef[] {
	return actions
		.map((a, i) => ({ a, i }))
		.filter(({ a }) => a.surfaces.includes(surface) && isRelevant(a, c))
		.sort((x, y) => score(y.a, usage, now) - score(x.a, usage, now) || x.i - y.i)
		.map(({ a }) => a);
}

export interface ContextBarPlan {
	kind: ContextKind;
	/** Action ids, best first. */
	actions: string[];
}

/** Number of action buttons the contextual bar can show in a view `width` CSS px wide (beside its label and collapse button). */
export function contextCapacity(width: number): number {
	const m = TOOLBAR_METRICS;
	return Math.max(3, Math.min(8, Math.floor((width - 32 - 2 * m.slot) / m.slot)));
}

/** The contextual bar: the most specific context that has something to offer, with its best actions. */
export function contextBar(c: UiContext, width: number, usage: UsageMap, now: number, actions: readonly ActionDef[] = ACTIONS): ContextBarPlan | null {
	if (!c.open) return null;
	const all = ranked("context", c, usage, now, actions);
	for (const kind of activeContexts(c)) {
		const fit = all.filter((a) => a.contexts?.includes(kind)).slice(0, contextCapacity(width));
		if (fit.length > 0) return { kind, actions: fit.map((a) => a.id) };
	}
	return null;
}

export interface ToolbarLayout extends ToolbarPlan {
	quick: string[];
	context: ContextBarPlan | null;
}

/** Everything the primary toolbar and the contextual bar show right now. */
export function buildLayout(c: UiContext, width: number, usage: UsageMap, now: number, actions: readonly ActionDef[] = ACTIONS): ToolbarLayout {
	const plan = toolbarPlan(width);
	const context = contextBar(c, width, usage, now, actions);
	const inContext = new Set(context?.actions ?? []);
	// A read-only view offers no quick insert actions: they would all be disabled.
	const quick = ranked("quick", c, usage, now, actions)
		.filter((a) => !inContext.has(a.id) && (c.editable || a.readOnly))
		.slice(0, plan.quickSlots)
		.map((a) => a.id);
	return { ...plan, quick, context };
}

export type SectionId = ActionGroup | "recent" | "results";

export interface SheetSection {
	id: SectionId;
	actions: ActionDef[];
}

export interface SheetOptions {
	/** "all": the "All actions" sheet (sheet and page actions); "page": the page sheet of one page. */
	kind: "all" | "page";
	usage: UsageMap;
	now: number;
	/** Search text; empty: grouped sections. */
	query?: string;
	/** Display text of an action and of a group, for the search. */
	label: (a: ActionDef) => string;
	groupLabel?: (g: ActionGroup) => string;
	/** Ids shown elsewhere right now (not repeated in "Recent"). */
	visible?: ReadonlySet<string>;
}

/** Up to this many entries in the "Recent" section of the sheet. */
export const RECENT_COUNT = 4;

/** Lower case, without accents, single spaces. */
export function fold(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The sections of a sheet: grouped in GROUP_ORDER (registry order inside a group), or the search results. */
export function buildSheet(c: UiContext, opts: SheetOptions, actions: readonly ActionDef[] = ACTIONS): SheetSection[] {
	const surfaces: readonly Surface[] = opts.kind === "page" ? ["page"] : ["sheet", "page"];
	const pool = actions.filter((a) => a.surfaces.some((s) => surfaces.includes(s)) && isRelevant(a, c));
	const query = fold(opts.query ?? "");
	if (query) {
		const words = query.split(" ");
		const hits = pool
			.map((a, i) => {
				const text = fold(`${opts.label(a)} ${a.keywords ?? ""} ${opts.groupLabel?.(a.group) ?? ""} ${a.id.replace(/-/g, " ")}`);
				if (!words.every((w) => text.includes(w))) return null;
				const starts = fold(opts.label(a)).startsWith(words[0]!) ? 1000 : 0;
				return { a, i, s: starts + score(a, opts.usage, opts.now) };
			})
			.filter((x): x is { a: ActionDef; i: number; s: number } => x !== null)
			.sort((x, y) => y.s - x.s || x.i - y.i)
			.map((x) => x.a);
		return hits.length ? [{ id: "results", actions: hits }] : [];
	}
	const sections: SheetSection[] = [];
	if (opts.kind === "all") {
		const visible = opts.visible ?? new Set<string>();
		const recent = pool
			.filter((a) => !visible.has(a.id) && !a.choices && usageBoost(opts.usage[a.id], opts.now) > 0)
			.sort((x, y) => usageBoost(opts.usage[y.id], opts.now) - usageBoost(opts.usage[x.id], opts.now))
			.slice(0, RECENT_COUNT);
		if (recent.length) sections.push({ id: "recent", actions: recent });
	}
	// The page sheet starts with getting to a page (go to, recent, one page at a time), then what acts on the page itself.
	const order: readonly ActionGroup[] = opts.kind === "page" ? ["navigate", "page", ...GROUP_ORDER.filter((g) => g !== "page" && g !== "navigate")] : GROUP_ORDER;
	for (const group of order) {
		const list = pool.filter((a) => a.group === group);
		if (list.length) sections.push({ id: group, actions: list });
	}
	return sections;
}

/**
 * Where the action can be found in this context and width (for the coverage test and the docs). Surfaces that are
 * always there (toolbar, options, favourites, radial, palette, notebook menu, library) count when declared.
 */
export function placementsOf(id: string, c: UiContext, width: number, actions: readonly ActionDef[] = ACTIONS): Surface[] {
	const a = actions.find((x) => x.id === id);
	if (!a || !isRelevant(a, c)) return [];
	const out = new Set<Surface>();
	const fixed: Surface[] = ["toolbar", "options", "favourites", "radial", "palette", "notebook", "library", "banner"];
	for (const s of a.surfaces) if (fixed.includes(s)) out.add(s);
	const layout = buildLayout(c, width, {}, 0, actions);
	if (layout.quick.includes(id)) out.add("quick");
	if (layout.context?.actions.includes(id)) out.add("context");
	const label = (x: ActionDef) => x.id;
	if (buildSheet(c, { kind: "all", usage: {}, now: 0, label }, actions).some((s) => s.actions.includes(a))) out.add("sheet");
	if (buildSheet(c, { kind: "page", usage: {}, now: 0, label }, actions).some((s) => s.actions.includes(a))) out.add("page");
	return [...out];
}
