// 0.27 workspaces (#375): workspace presets. A preset says which of the plugin's own panels are open around the notebook in view
// (slides side pane, floating reference window, page panel, outline, minimap, related pages) and, optionally, which writing profile
// is in use. One command applies it. Pure logic (no 'obsidian'), unit-tested.
// Applying only opens or closes those panels through their existing open / close functions; it never moves the user's other
// Obsidian leaves and never touches a document. Two presets are built in (constants, never stored: Lecture, Study); Focus closes all
// panels. The user's own are saved from the current arrangement and live in the plugin settings, bounded and read leniently.

export const PANEL_IDS = ["pdf", "reference", "navigator", "outline", "minimap", "related"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** Which panels are open now. `navigator` and `outline` are two faces of the page panel and never both on. */
export type PanelState = Readonly<Record<PanelId, boolean>>;

export interface WorkspacePreset {
	/** `lecture`, `study` and `focus` for the built-in ones, `ws-<random>` for a saved one. */
	id: string;
	name: string;
	/** The panels that are open; every other panel is closed. */
	panels: PanelId[];
	/** Optional writing profile (view/writing-profiles.ts) switched to with the preset. */
	profile?: string;
}

export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 30;
export const BUILTIN_PRESET_IDS = ["lecture", "study", "focus"] as const;
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

export const BUILTIN_PRESETS: readonly WorkspacePreset[] = [
	{ id: "lecture", name: "Lecture", panels: ["pdf", "outline"] },
	{ id: "study", name: "Study", panels: ["reference", "related"] },
	{ id: "focus", name: "Focus", panels: [] },
];

export const BUILTIN_PRESET_NAME_KEYS = { lecture: "workspace.builtin.lecture", study: "workspace.builtin.study", focus: "workspace.builtin.focus" } as const;
export const BUILTIN_PRESET_ICONS: Readonly<Record<BuiltinPresetId, string>> = { lecture: "presentation", study: "book-open", focus: "focus" };
export const PANEL_ICONS: Readonly<Record<PanelId, string>> = {
	pdf: "columns-2", reference: "picture-in-picture-2", navigator: "panel-left", outline: "list-tree", minimap: "map", related: "link-2",
};
export const PANEL_NAME_KEYS = {
	pdf: "workspace.panel.pdf", reference: "workspace.panel.reference", navigator: "workspace.panel.navigator",
	outline: "workspace.panel.outline", minimap: "workspace.panel.minimap", related: "workspace.panel.related",
} as const;

export function isBuiltinPreset(id: string): id is BuiltinPresetId {
	return (BUILTIN_PRESET_IDS as readonly string[]).includes(id);
}

export function cleanPresetName(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_PRESET_NAME) : "";
}

const isPanel = (v: unknown): v is PanelId => typeof v === "string" && (PANEL_IDS as readonly string[]).includes(v);
const validId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,40}$/.test(v);

/** The panels of a preset in the fixed order, repeated ones dropped, the outline winning over the plain page panel. */
export function cleanPanels(v: unknown): PanelId[] {
	if (!Array.isArray(v)) return [];
	const set = new Set(v.filter(isPanel));
	if (set.has("outline")) set.delete("navigator");
	return PANEL_IDS.filter((p) => set.has(p));
}

export function clonePreset(p: WorkspacePreset): WorkspacePreset {
	const out: WorkspacePreset = { id: p.id, name: p.name, panels: [...p.panels] };
	if (p.profile) out.profile = p.profile;
	return out;
}

/** Reads the saved presets leniently: bad entries, repeated ids and ids of the built-in ones are dropped; at most MAX_PRESETS. */
export function normalisePresets(data: unknown): WorkspacePreset[] {
	if (!Array.isArray(data)) return [];
	const out: WorkspacePreset[] = [];
	const seen = new Set<string>(BUILTIN_PRESET_IDS);
	for (const raw of data) {
		if (out.length >= MAX_PRESETS) break;
		if (typeof raw !== "object" || raw === null) continue;
		const o = raw as Record<string, unknown>;
		const name = cleanPresetName(o.name);
		if (!validId(o.id) || !name || seen.has(o.id) || !Array.isArray(o.panels)) continue;
		seen.add(o.id);
		const p: WorkspacePreset = { id: o.id, name, panels: cleanPanels(o.panels) };
		if (validId(o.profile)) p.profile = o.profile;
		out.push(p);
	}
	return out;
}

/** The id of the preset last applied, if it still exists ("" none). */
export function normaliseActivePreset(v: unknown, custom: readonly WorkspacePreset[]): string {
	if (typeof v !== "string" || !v) return "";
	return isBuiltinPreset(v) || custom.some((p) => p.id === v) ? v : "";
}

export function allPresets(custom: readonly WorkspacePreset[]): WorkspacePreset[] {
	return [...BUILTIN_PRESETS.map(clonePreset), ...custom.map(clonePreset)];
}

export function findPreset(custom: readonly WorkspacePreset[], id: string): WorkspacePreset | null {
	return allPresets(custom).find((p) => p.id === id) ?? null;
}

/** The shown name: built-in presets are translated, the user's own are as typed. */
export function presetName(p: WorkspacePreset, tr: (key: (typeof BUILTIN_PRESET_NAME_KEYS)[BuiltinPresetId]) => string): string {
	return isBuiltinPreset(p.id) ? tr(BUILTIN_PRESET_NAME_KEYS[p.id]) : p.name;
}

/** Every panel closed. */
export const NO_PANELS: PanelState = { pdf: false, reference: false, navigator: false, outline: false, minimap: false, related: false };

/** The panel state a preset asks for. */
export function wantedState(p: WorkspacePreset): PanelState {
	const open = new Set(cleanPanels(p.panels));
	return { pdf: open.has("pdf"), reference: open.has("reference"), navigator: open.has("navigator"), outline: open.has("outline"), minimap: open.has("minimap"), related: open.has("related") };
}

/** A preset from the current arrangement. */
export function captureArrangement(state: PanelState, id: string, name: string, profile = ""): WorkspacePreset {
	const p: WorkspacePreset = { id, name: cleanPresetName(name), panels: cleanPanels(PANEL_IDS.filter((k) => state[k])) };
	if (validId(profile)) p.profile = profile;
	return p;
}

export const ALL_AVAILABLE: Readonly<Record<PanelId, boolean>> = { pdf: true, reference: true, navigator: true, outline: true, minimap: true, related: true };

/** Whether the arrangement in front is what the preset asks for (the picker marks the preset that holds). */
export function matches(p: WorkspacePreset, state: PanelState, available: Readonly<Record<PanelId, boolean>> = ALL_AVAILABLE): boolean {
	const want = wantedState(p);
	return PANEL_IDS.every((k) => !available[k] || want[k] === state[k]);
}


/** What the place offers: a narrow view (phone) and the panels that exist at all there (the minimap can be turned off in the settings). */
export interface DiffContext {
	narrow: boolean;
	available: Readonly<Record<PanelId, boolean>>;
}

export interface PanelPlan {
	close: PanelId[];
	open: PanelId[];
	/** Panels left alone because this place cannot show them (narrow view, minimap turned off): the caller says so once. */
	skipped: PanelId[];
}

/** Panels a phone does not get: they would float over or push aside a page that is already small. */
export const NARROW_SKIPPED: readonly PanelId[] = ["reference", "minimap", "related"];
/** On a phone the page panel is a drawer over the page: it is skipped while the slides pane shares the screen. */
export const NARROW_DRAWER: readonly PanelId[] = ["navigator", "outline"];

/**
 * The difference between what the preset wants and what is open: panels to close first, then panels to open. A panel already in
 * the wanted state is left alone. On a narrow view the panels it cannot show are skipped (and never closed or opened); the side
 * pane for slides stays, as it is a split inside the view that works on phones.
 */
export function planPanels(want: PanelState, current: PanelState, ctx: DiffContext): PanelPlan {
	const skipped: PanelId[] = [];
	const effective: Record<PanelId, boolean> = { ...want };
	// The two faces of the page panel are one thing: the outline wins.
	if (effective.outline) effective.navigator = false;
	for (const id of PANEL_IDS) {
		const unavailable = !ctx.available[id];
		const narrowSkip = ctx.narrow && (NARROW_SKIPPED.includes(id) || (NARROW_DRAWER.includes(id) && effective.pdf));
		if ((unavailable || narrowSkip) && effective[id]) {
			// Cannot be shown here: left as it is. A panel wanted closed is still closed, even on a phone.
			skipped.push(id);
			effective[id] = current[id];
		} else if (unavailable) {
			effective[id] = current[id];
		}
	}
	const close: PanelId[] = [], open: PanelId[] = [];
	for (const id of PANEL_IDS) {
		if (effective[id] === current[id]) continue;
		(effective[id] ? open : close).push(id);
	}
	return { close, open, skipped };
}

/** Panels that need a file to show (the user is asked): at most one picker is opened by one apply. */
export const NEEDS_FILE: readonly PanelId[] = ["pdf", "reference"];

/** Splits the panels to open into those that open at once and the one that asks for a file; the rest wait for the user. */
export function splitOpen(open: readonly PanelId[]): { now: PanelId[]; ask: PanelId | null; later: PanelId[] } {
	const now = open.filter((p) => !NEEDS_FILE.includes(p));
	const files = open.filter((p) => NEEDS_FILE.includes(p));
	return { now, ask: files[0] ?? null, later: files.slice(1) };
}

/** A fresh id for a saved preset. */
export function newPresetId(random: () => number = Math.random): string {
	let s = "";
	for (let i = 0; i < 8; i++) s += Math.floor(random() * 36).toString(36);
	return `ws-${s}`;
}

/** Adds a preset made from the arrangement; null at the limit or with an empty name. */
export function addPreset(custom: readonly WorkspacePreset[], name: string, state: PanelState, profile: string, id: string = newPresetId()): { presets: WorkspacePreset[]; id: string } | null {
	const clean = cleanPresetName(name);
	if (!clean || custom.length >= MAX_PRESETS) return null;
	return { presets: [...custom.map(clonePreset), captureArrangement(state, id, clean, profile)], id };
}

/** Replaces the panels (and profile) of a saved preset by the current arrangement. */
export function updatePreset(custom: readonly WorkspacePreset[], id: string, state: PanelState, profile: string): WorkspacePreset[] {
	return custom.map((p) => (p.id === id ? captureArrangement(state, p.id, p.name, profile) : clonePreset(p)));
}

export function renamePreset(custom: readonly WorkspacePreset[], id: string, name: string): WorkspacePreset[] {
	const clean = cleanPresetName(name);
	return custom.map((p) => (p.id === id && clean ? { ...clonePreset(p), name: clean } : clonePreset(p)));
}

export function removePreset(custom: readonly WorkspacePreset[], id: string): WorkspacePreset[] {
	return custom.filter((p) => p.id !== id).map(clonePreset);
}
