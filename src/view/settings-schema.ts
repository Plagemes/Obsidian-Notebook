/**
 * The settings tab, described once (DESIGN.md §6, docs/design-ui.md *Settings*).
 *
 * Every row of the tab is a `SettingSpec`: its section, its group inside the section (main, a collapsible feature group
 * or *Advanced*), its order, when it is relevant (`visible`) and its control. The tab (`settings-tab.ts`) builds both the
 * declarative definitions of Obsidian 1.13+ and the hand-drawn tab of older versions from this list, and `settingsView`
 * decides what is shown for the current settings, search query and open groups, so the two paths never drift.
 *
 * Pure: no 'obsidian' import (tested in Node). Texts are i18n keys; the tab translates them.
 */
import { GHOST_SPACINGS_MM } from "../model/ghost-lines";
import type { MessageKey } from "../i18n/en";
import { LANGUAGES, LANGUAGE_CODES } from "../i18n/languages";
import { PAGE_SIZES, PAPER_KINDS } from "../model/types";
import { EDGE_WIDTH_MAX, EDGE_WIDTH_MIN } from "../ink/edge-zones";
import { BUTTON_AFTER_MAX_MS, BUTTON_BEFORE_MAX_MS } from "../ink/pen-hover";
import { BUILTIN_GESTURES } from "../ink/gestures/registry";
import { SPACE_PT_MAX, SPACE_PT_MIN } from "../ink/gestures/settings";
import { TRASH_RETENTION_MAX_DAYS } from "../storage/trash-settings";
import { NAME_TOKEN } from "../storage/companion-path";
import { defaultLooseSheetPath } from "../library/loose-sheet-logic";
import { defaultDailyPath } from "../library/daily-logic";
import { DIM_MAX, DIM_MIN, DIM_STEP } from "./reading-settings";
import { INSERT_WIDTH_MAX, INSERT_WIDTH_MIN, INSERT_WIDTH_STEP } from "../model/note-insert";
import { LOOKUP_WIDTH_MAX, LOOKUP_WIDTH_MIN, LOOKUP_WIDTH_STEP } from "../model/look-up";
import { SNAP_STRENGTH_MAX, SNAP_STRENGTH_MIN, SNAP_STRENGTH_STEP } from "../model/snap";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../settings";
import { SYMBOL_COUNT_MAX, SYMBOL_COUNT_MIN } from "../ui/symbol-rank";
import { CLOUD_INTERVAL_MAX, CLOUD_LARGE_MAX_MB, CLOUD_MOBILE_MAX_MB, CLOUD_MOBILE_MIN_MB } from "../sync/settings";

export type SettingKey = keyof NotebookSettings;

/** Translates an i18n key (the tab passes `t`; tests pass a table lookup). */
export type Translate = (key: MessageKey, vars?: Record<string, string>) => string;

/** The sections, in the order of the tab. A new setting picks one of them; never add a section for one feature. */
export const SECTION_IDS = ["writing", "input", "pages", "reading", "library", "sync", "export", "integration", "study", "appearance", "diagnostics"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionSpec {
	id: SectionId;
	title: MessageKey;
	/** Lucide icon of the section header. */
	icon: string;
}

export const SECTIONS: readonly SectionSpec[] = [
	{ id: "writing", title: "settings.section.writing", icon: "pen-line" },
	{ id: "input", title: "settings.section.input", icon: "pencil" },
	{ id: "pages", title: "settings.section.pages", icon: "book-open" },
	{ id: "reading", title: "settings.section.reading", icon: "file-text" },
	{ id: "library", title: "settings.section.library", icon: "folder" },
	{ id: "sync", title: "settings.section.sync", icon: "refresh-cw" },
	{ id: "export", title: "settings.section.export", icon: "share" },
	{ id: "integration", title: "settings.section.integration", icon: "link" },
	{ id: "study", title: "settings.section.study", icon: "graduation-cap" },
	{ id: "appearance", title: "settings.section.appearance", icon: "palette" },
	{ id: "diagnostics", title: "settings.section.diagnostics", icon: "stethoscope" },
];

/** What the tab knows besides the settings: which services exist and whether a feature is in use. */
export interface SettingsContext {
	/** The sync safety service is running (device name, sync check). */
	sync: boolean;
	/** The backup service is running (the "Back up now" row). */
	backups?: boolean;
	/** 0.22 synccore (#126): the cloud sync service is running. */
	cloudSync?: boolean;
	/** The timetable service is running. */
	timetable: boolean;
	/** The timetable has at least one class. */
	timetableInUse: boolean;
	/** Vault path of the timetable file, for its description. */
	timetablePath?: string;
}

export const EMPTY_CONTEXT: SettingsContext = { sync: false, timetable: false, timetableInUse: false };

type Predicate = (s: NotebookSettings, ctx: SettingsContext) => boolean;

/**
 * A collapsible group of a section. `advanced` is every section's *Advanced* group (closed by default); the others are
 * features whose options are collapsed while the feature is not in use (`open`).
 */
export interface GroupSpec {
	id: string;
	section: SectionId;
	title: MessageKey;
	/** Open by default when this is true (the feature is in use). Absent: closed. */
	open?: Predicate;
}

/** The *Advanced* group of every section is `ADVANCED` (one id, scoped by the section). */
export const ADVANCED = "advanced";

export const GROUPS: readonly GroupSpec[] = [
	{
		id: "penGestures", section: "input", title: "settings.penGestures",
		open: (s) => s.penSideButton === "gesture" || s.penSideButton === "radial-gesture" || s.penGestureLongPress || s.penGesturesCustom.length > 0,
	},
	{ id: "pageHeader", section: "pages", title: "settings.pageHeader", open: (s) => s.headerMode !== "off" },
	{ id: "outline", section: "pages", title: "settings.outline", open: (s) => !(s.outlineBookmarks && s.outlineSlides && s.outlineHeadings && s.outlineMarkers) || s.outlinePdf === "off" },
	{ id: "timetable", section: "study", title: "settings.timetable", open: (_s, ctx) => ctx.timetableInUse },
	{ id: "zettel", section: "study", title: "settings.zettel", open: (s) => s.zettelSlipBoxes.length > 0 },
	// 0.22 synccore (#126): the optional cloud connector, open once a service is chosen.
	{ id: "cloudSync", section: "sync", title: "settings.cloudSync", open: (s) => s.cloudSyncProvider !== "off" },
];

/** Runs of the action rows; the tab maps each id to what it does. */
export type SettingActionId = "hints-reset" | "toolbar-reset" | "pen-test" | "benchmark" | "companion-update-all" | "sync-check" | "timetable-edit" | "gesture-sheet" | "gesture-custom" | "notebook-templates-manage" | "pen-sets" | "board-columns" | "storage-open" | "meanings-edit";
/** Rows drawn by the tab itself (no stored setting of their own). */
export type SettingCustomId = "device-name" | "pen-key" | "device-info" | "backup-now" | "cloud-account" | "cloud-sync-now" | "cloud-log" | "cloud-secret";

export type ControlSpec =
	| { type: "toggle" }
	| { type: "dropdown"; options: (tr: Translate) => Record<string, string> }
	| { type: "slider"; min: number; max: number; step: number; format?: (value: number, tr: Translate) => string }
	| { type: "text"; placeholder?: string }
	| { type: "folder"; placeholder?: string }
	| { type: "action"; run: SettingActionId; button?: MessageKey }
	| { type: "custom"; render: SettingCustomId };

export interface SettingSpec {
	/** Unique. For a value control it is the key passed to `getControlValue` / `setControlValue`. */
	id: string;
	section: SectionId;
	/** Absent: the main options of the section. `ADVANCED` or the id of a `GROUPS` entry of the same section. */
	group?: string;
	/** Position inside its group (ascending). Gaps are left for later settings. */
	order: number;
	name: MessageKey;
	desc?: MessageKey;
	/** Variables of `desc` (for example a file path). */
	descVars?: (ctx: SettingsContext) => Record<string, string>;
	control: ControlSpec;
	/** Settings keys this row changes. Default: `[id]` for a value control, none for an action. */
	edits?: readonly SettingKey[];
	/** The row this one depends on: while it is hidden, this one is too, and a search hit shows the parent instead. */
	parent?: string;
	/** Relevant only when this holds (a dependent option of its parent, or a service that must exist). */
	visible?: Predicate;
	/** Extra search words (both languages). */
	keywords?: string;
}

// ---------------------------------------------------------------------------------------------------------- helpers

const off = (tr: Translate) => tr("settings.off");
const suffix = (unit: string, zeroIsOff = false) => (v: number, tr: Translate) => (zeroIsOff && v === 0 ? off(tr) : `${v} ${unit}`);
const options = (pairs: ReadonlyArray<readonly [string, MessageKey]>) => (tr: Translate) => Object.fromEntries(pairs.map(([v, k]) => [v, tr(k)]));

/** The side button does something (the button rows that tune how it is detected are relevant). */
export const penButtonOn: Predicate = (s) => s.penSideButton !== "off";
const radialOnButton: Predicate = (s) => s.penSideButton === "radial" || s.penSideButton === "radial-eraser" || s.penSideButton === "radial-gesture";

/** Settings keys of the per-gesture switches: "penGesture:select", ... (they edit `penGesturesOff`). */
export const GESTURE_KEY_PREFIX = "penGesture:";

// ------------------------------------------------------------------------------------------------------- the specs

const WRITING: SettingSpec[] = [
	{
		id: "defaultPaper", section: "writing", order: 10, name: "settings.defaultPaper", desc: "settings.defaultPaper.desc",
		control: { type: "dropdown", options: (tr) => Object.fromEntries(PAPER_KINDS.map((k) => [k, tr(`paper.${k}` as MessageKey)])) },
	},
	{
		id: "defaultPageSize", section: "writing", order: 20, name: "settings.defaultSize",
		control: { type: "dropdown", options: (tr) => Object.fromEntries((Object.keys(PAGE_SIZES) as Array<keyof typeof PAGE_SIZES>).map((k) => [k, tr(`size.${k}` as MessageKey)])) },
	},
	{ id: "defaultLandscape", section: "writing", order: 30, name: "settings.defaultLandscape", control: { type: "toggle" } },
	// 0.20 planner (#118)
	{
		id: "plannerWeekStart", section: "writing", order: 35, name: "settings.plannerWeekStart", desc: "settings.plannerWeekStart.desc", keywords: "planner calendar week monday sunday agenda settimana lunedi domenica",
		control: { type: "dropdown", options: options([["auto", "settings.plannerWeekStart.auto"], ["monday", "settings.plannerWeekStart.monday"], ["sunday", "settings.plannerWeekStart.sunday"]]) },
	},
	{ id: "stabilization", section: "writing", order: 40, name: "settings.stabilization", desc: "settings.stabilization.filter.desc", control: { type: "slider", min: 0, max: 10, step: 1 } },
	{ id: "inkFollowsObjects", section: "writing", order: 50, name: "settings.inkFollows", desc: "settings.inkFollows.desc", control: { type: "toggle" } },
	// 0.17 snap (#71): magnetic snap to the paper grid and alignment guides while a selection moves or scales
	{
		id: "snapMode", section: "writing", order: 55, name: "settings.snapMode", desc: "settings.snapMode.desc", keywords: "snap magnetic align alignment guides grid aggancio allinea griglia guide",
		control: { type: "dropdown", options: options([["both", "settings.snapMode.both"], ["grid", "settings.snapMode.grid"], ["guides", "settings.snapMode.guides"], ["off", "settings.snapMode.off"]]) },
	},
	{
		id: "snapStrength", section: "writing", order: 56, name: "settings.snapStrength", desc: "settings.snapStrength.desc",
		control: { type: "slider", min: SNAP_STRENGTH_MIN, max: SNAP_STRENGTH_MAX, step: SNAP_STRENGTH_STEP, format: suffix("px") }, parent: "snapMode", visible: (s) => s.snapMode !== "off",
	},
	// 0.20 ghost lines (#94): faint temporary guide lines on blank paper
	{
		id: "ghostLines", section: "writing", order: 57, name: "settings.ghostLines", desc: "settings.ghostLines.desc", keywords: "ghost guide lines baseline straight blank paper handwriting righe guida linee scrittura dritta",
		control: { type: "dropdown", options: options([["off", "settings.ghostLines.off"], ["writing", "settings.ghostLines.writing"], ["always", "settings.ghostLines.always"]]) },
	},
	{
		id: "ghostSpacing", section: "writing", order: 57.5, name: "settings.ghostSpacing", desc: "settings.ghostSpacing.desc",
		control: { type: "dropdown", options: (tr) => ({ auto: tr("settings.ghostSpacing.auto"), ...Object.fromEntries(GHOST_SPACINGS_MM.map((mm) => [String(mm), `${mm} mm`])) }) }, parent: "ghostLines", visible: (s) => s.ghostLines !== "off",
	},
	// 0.19 checklists (#103): a small square drawn with the pen
	{
		id: "checklistDraw", section: "writing", order: 58, name: "settings.checklistDraw", desc: "settings.checklistDraw.desc", keywords: "checklist checkbox square draw tick todo task lista casella quadrato spunta",
		control: { type: "dropdown", options: options([["offer", "settings.checklistDraw.offer"], ["auto", "settings.checklistDraw.auto"], ["off", "settings.checklistDraw.off"]]) },
	},
	// 0.22 axes (#206): an L or a + drawn with the pen
	{
		id: "axesDraw", section: "writing", order: 58.5, name: "settings.axesDraw", desc: "settings.axesDraw.desc", keywords: "axes axis graph cartesian plot ticks assi grafico cartesiano",
		control: { type: "dropdown", options: options([["offer", "settings.axesDraw.offer"], ["auto", "settings.axesDraw.auto"], ["off", "settings.axesDraw.off"]]) },
	},
	{ id: "axesTicks", section: "writing", order: 58.6, name: "settings.axesTicks", desc: "settings.axesTicks.desc", control: { type: "toggle" } },
	{ id: "axesLabels", section: "writing", order: 58.7, name: "settings.axesLabels", desc: "settings.axesLabels.desc", control: { type: "toggle" }, parent: "axesTicks", visible: (s) => s.axesTicks },
	{ id: "autoLineBreak", section: "writing", order: 60, name: "settings.autoLineBreak", desc: "settings.autoLineBreak.desc", control: { type: "toggle" } },
	// 0.21 symbols
	{ id: "symbolStrip", section: "writing", order: 62, name: "settings.symbolStrip", desc: "settings.symbolStrip.desc", keywords: "symbols maths math formula greek simboli matematica", control: { type: "toggle" } },
	{ id: "symbolCount", section: "writing", order: 63, name: "settings.symbolCount", desc: "settings.symbolCount.desc", control: { type: "slider", min: SYMBOL_COUNT_MIN, max: SYMBOL_COUNT_MAX, step: 1 }, parent: "symbolStrip", visible: (s) => s.symbolStrip },
	// 0.15 pen sets: named pens per subject, loaded with the notebook (view/pen-sets.ts)
	{
		id: "penSets", section: "writing", order: 70, name: "settings.penSets", desc: "settings.penSets.desc", keywords: "pens subject maths languages science favourites penne materia",
		control: { type: "action", run: "pen-sets", button: "settings.open" }, edits: ["penSets", "penSetFolders", "penSetNotebooks"],
	},
	// 0.22 pens (#35): the pen the pen tool starts with, and the nib angle of new fountain pen and marker strokes
	{
		id: "defaultPenKind", section: "writing", order: 71, name: "settings.defaultPenKind", desc: "settings.defaultPenKind.desc", keywords: "pen fountain brush marker nib calligraphy stilografica pennello pennarello penna",
		control: { type: "dropdown", options: options([["pen", "tool.pen"], ["fountain", "tool.fountain"], ["brush", "tool.brush"], ["marker", "tool.marker"]]) },
	},
	{
		id: "defaultNibAngle", section: "writing", order: 72, name: "settings.defaultNibAngle", desc: "settings.defaultNibAngle.desc", keywords: "nib angle fountain marker calligraphy punta angolo",
		control: { type: "slider", min: 0, max: 175, step: 5, format: suffix("°") }, parent: "defaultPenKind", visible: (s) => s.defaultPenKind === "fountain" || s.defaultPenKind === "marker",
	},
	{ id: "eraseAreaElements", section: "writing", group: ADVANCED, order: 10, name: "settings.eraseAreaElements", desc: "settings.eraseAreaElements.desc", control: { type: "toggle" } },
	{ id: "dateStampFormat", section: "writing", group: ADVANCED, order: 20, name: "settings.dateStamp", desc: "settings.dateStamp.desc", control: { type: "text", placeholder: DEFAULT_SETTINGS.dateStampFormat } },
	{ id: "signDateMode", section: "writing", group: ADVANCED, order: 21, name: "settings.signDateMode", desc: "settings.signDateMode.desc", control: { type: "dropdown", options: (tr) => ({ locale: tr("settings.signDateMode.locale"), iso: tr("settings.signDateMode.iso"), custom: tr("settings.signDateMode.custom") }) }, keywords: "signature date sign firma data" },
	{ id: "signDateCustom", section: "writing", group: ADVANCED, order: 22, name: "settings.signDateCustom", desc: "settings.signDateCustom.desc", control: { type: "text", placeholder: DEFAULT_SETTINGS.signDateCustom }, keywords: "signature date sign firma data" },
	{ id: "inkPrediction", section: "writing", group: ADVANCED, order: 30, name: "settings.inkPrediction", desc: "settings.inkPrediction.desc", control: { type: "toggle" }, keywords: "latency latenza" },
	{ id: "lowLatencyInk", section: "writing", group: ADVANCED, order: 40, name: "settings.lowLatencyInk", desc: "settings.lowLatencyInk.desc", control: { type: "toggle" } },
];

const EDGES: ReadonlyArray<readonly [SettingKey, MessageKey]> = [
	["edgeLeft", "settings.edgeLeft"],
	["edgeRight", "settings.edgeRight"],
	["edgeTop", "settings.edgeTop"],
	["edgeBottom", "settings.edgeBottom"],
];

const INPUT: SettingSpec[] = [
	{ id: "fingerDrawing", section: "input", order: 10, name: "settings.finger", desc: "settings.finger.desc", control: { type: "toggle" }, keywords: "touch tocco" },
	{
		id: "palmRejectionMs", section: "input", order: 20, name: "settings.palm", desc: "settings.palm.desc",
		control: { type: "slider", min: 0, max: 2000, step: 50, format: suffix("ms") }, keywords: "palmo",
	},
	{
		id: "pressureMode", section: "input", order: 30, name: "settings.pressure", desc: "settings.pressure.desc",
		control: { type: "dropdown", options: options([["auto", "settings.pressure.auto"], ["simulated", "settings.pressure.simulated"]]) },
	},
	{
		id: "penSideButton", section: "input", order: 40, name: "settings.penButton", desc: "settings.penButton.desc", keywords: "s pen stylus",
		control: {
			type: "dropdown",
			options: options([
				["radial-eraser", "settings.penButton.radialEraser"], ["radial", "settings.penButton.radial"], ["eraser", "settings.penButton.eraser"],
				["lasso", "settings.penButton.lasso"], ["previous", "settings.penButton.previous"], ["gesture", "settings.penButton.gesture"],
				["radial-gesture", "settings.penButton.radialGesture"], ["off", "settings.penButton.off"],
			]),
		},
	},
	// Orders 41–49: reserved for the S Pen button settings of PEN_BUTTON_EXTENSIONS (below).
	{ id: "penHoldStill", section: "input", order: 50, name: "settings.penLongPress", desc: "settings.penLongPress.desc", control: { type: "toggle" }, parent: "penSideButton", visible: radialOnButton },
	{ id: "fingerLongPress", section: "input", order: 60, name: "settings.fingerLongPress", desc: "settings.fingerLongPress.desc", control: { type: "toggle" }, parent: "fingerDrawing", visible: (s) => !s.fingerDrawing },
	{
		id: "tapGestures", section: "input", order: 70, name: "settings.tapGestures", desc: "settings.tapGestures.desc",
		control: { type: "dropdown", options: options([["undo-redo", "settings.tapGestures.undoRedo"], ["redo-undo", "settings.tapGestures.redoUndo"], ["off", "settings.tapGestures.off"]]) },
	},
	{ id: "scribbleErase", section: "input", order: 80, name: "settings.scribble", desc: "settings.scribble.desc", control: { type: "toggle" } },
	// Pen gestures: collapsed while no gesture trigger is in use.
	{ id: "penGestureLongPress", section: "input", group: "penGestures", order: 10, name: "settings.penGestureLongPress", desc: "settings.penGestureLongPress.desc", control: { type: "toggle" } },
	{
		id: "penGestureSpacePt", section: "input", group: "penGestures", order: 20, name: "settings.penGestureSpace", desc: "settings.penGestureSpace.desc",
		control: { type: "slider", min: SPACE_PT_MIN, max: SPACE_PT_MAX, step: 4, format: suffix("pt") },
	},
	...BUILTIN_GESTURES.map((id, i): SettingSpec => ({
		id: `${GESTURE_KEY_PREFIX}${id}`, section: "input", group: "penGestures", order: 30 + i,
		name: `gesture.${id}.title` as MessageKey, desc: `gesture.${id}.how` as MessageKey,
		control: { type: "toggle" }, edits: ["penGesturesOff"],
	})),
	{ id: "gestureSheet", section: "input", group: "penGestures", order: 80, name: "settings.penGestureSheet", desc: "settings.penGestureSheet.desc", control: { type: "action", run: "gesture-sheet", button: "settings.open" } },
	{ id: "gestureCustom", section: "input", group: "penGestures", order: 90, name: "settings.penGestureCustom", desc: "settings.penGestureCustom.desc", control: { type: "action", run: "gesture-custom", button: "settings.open" }, edits: ["penGesturesCustom"] },
	// Advanced
	{
		id: "palmContactPx", section: "input", group: ADVANCED, order: 10, name: "settings.palmSize", desc: "settings.palmSize.desc",
		control: { type: "slider", min: 0, max: 120, step: 5, format: suffix("px", true) }, keywords: "palm palmo",
	},
	{ id: "penZeroPressureButton", section: "input", group: ADVANCED, order: 20, name: "settings.penZeroPressure", desc: "settings.penZeroPressure.desc", control: { type: "toggle" }, parent: "penSideButton", visible: penButtonOn },
	{ id: "penChordButton", section: "input", group: ADVANCED, order: 30, name: "settings.penChord", desc: "settings.penChord.desc", control: { type: "toggle" }, parent: "penSideButton", visible: penButtonOn },
	{ id: "edgeRejection", section: "input", group: ADVANCED, order: 40, name: "settings.edge", desc: "settings.edge.desc", control: { type: "toggle" }, keywords: "palm palmo" },
	{
		id: "edgeRejectionPx", section: "input", group: ADVANCED, order: 41, name: "settings.edgePx", desc: "settings.edgePx.desc",
		control: { type: "slider", min: EDGE_WIDTH_MIN, max: EDGE_WIDTH_MAX, step: 2, format: suffix("px") }, parent: "edgeRejection", visible: (s) => s.edgeRejection,
	},
	...EDGES.map(([key, name], i): SettingSpec => ({
		id: key, section: "input", group: ADVANCED, order: 42 + i, name, control: { type: "toggle" }, parent: "edgeRejection", visible: (s) => s.edgeRejection,
	})),
];

const PAGES: SettingSpec[] = [
	{
		id: "scrollMode", section: "pages", order: 10, name: "settings.scrollMode", desc: "settings.scrollMode.desc",
		control: { type: "dropdown", options: options([["continuous", "settings.scrollMode.continuous"], ["pages", "settings.scrollMode.pages"]]) },
	},
	{ id: "fastScrollbar", section: "pages", order: 20, name: "settings.fastScrollbar", desc: "settings.fastScrollbar.desc", control: { type: "toggle" }, parent: "scrollMode", visible: (s) => s.scrollMode === "continuous" },
	// 0.17 minimap (#173)
	{
		id: "minimapMode", section: "pages", order: 25, name: "settings.minimap", desc: "settings.minimap.desc",
		control: { type: "dropdown", options: options([["auto", "settings.minimap.auto"], ["always", "settings.minimap.always"], ["never", "settings.minimap.never"]]) }, keywords: "overview map panoramica mappa",
	},
	{ id: "autoNextPage", section: "pages", order: 30, name: "settings.autoNextPage", desc: "settings.autoNextPage.desc", control: { type: "toggle" } },
	{ id: "autoScrollWriting", section: "pages", order: 40, name: "settings.autoScroll", desc: "settings.autoScroll.desc", control: { type: "toggle" } },
	{ id: "pageTurnerKeys", section: "pages", order: 50, name: "settings.pageTurnerKeys", desc: "settings.pageTurnerKeys.desc", control: { type: "toggle" }, keywords: "keyboard tastiera clicker" },
	// 0.13 outline: what the generated outline in the page panel lists.
	{ id: "outlineBookmarks", section: "pages", group: "outline", order: 10, name: "settings.outlineBookmarks", desc: "settings.outlineBookmarks.desc", control: { type: "toggle" }, keywords: "outline indice sommario table of contents" },
	{ id: "outlineSlides", section: "pages", group: "outline", order: 20, name: "settings.outlineSlides", desc: "settings.outlineSlides.desc", control: { type: "toggle" }, keywords: "outline pdf slide diapositive" },
	{ id: "outlineHeadings", section: "pages", group: "outline", order: 30, name: "settings.outlineHeadings", desc: "settings.outlineHeadings.desc", control: { type: "toggle" }, keywords: "outline heading titoli handwriting scrittura" },
	{ id: "outlineMarkers", section: "pages", group: "outline", order: 40, name: "settings.outlineMarkers", desc: "settings.outlineMarkers.desc", control: { type: "toggle" }, keywords: "outline marker segnalini domande compiti" },
	// 0.16 (#46): the outline of a PDF in the notebook outline.
	{
		id: "outlinePdf", section: "pages", group: "outline", order: 50, name: "settings.outlinePdf", desc: "settings.outlinePdf.desc",
		control: { type: "dropdown", options: options([["merged", "settings.outlinePdf.merged"], ["section", "settings.outlinePdf.section"], ["off", "settings.outlinePdf.off"]]) }, keywords: "outline pdf bookmarks table of contents indice segnalibri sommario",
	},
	// 0.22 pagerefs (#179): the chip "Referenced on p. 3" on a page that other pages link to.
	{ id: "pageRefs", section: "pages", group: "outline", order: 60, name: "settings.pageRefs", desc: "settings.pageRefs.desc", control: { type: "toggle" }, keywords: "references backlinks links pages referenced riferimenti collegamenti" },
	// 0.15 page header (#75): the page number, date and notebook title drawn on the paper, never stored on the page.
	{
		id: "headerMode", section: "pages", group: "pageHeader", order: 10, name: "settings.headerMode", desc: "settings.headerMode.desc",
		control: { type: "dropdown", options: options([["off", "settings.headerMode.off"], ["header", "settings.headerMode.header"], ["footer", "settings.headerMode.footer"]]) }, keywords: "header footer page number date numero pagina intestazione piè di pagina",
	},
	{ id: "headerPageNumber", section: "pages", group: "pageHeader", order: 20, name: "settings.headerPageNumber", control: { type: "toggle" }, parent: "headerMode", visible: (s) => s.headerMode !== "off" },
	{ id: "headerPageTotal", section: "pages", group: "pageHeader", order: 21, name: "settings.headerPageTotal", desc: "settings.headerPageTotal.desc", control: { type: "toggle" }, parent: "headerMode", visible: (s) => s.headerMode !== "off" && s.headerPageNumber },
	{ id: "headerDate", section: "pages", group: "pageHeader", order: 30, name: "settings.headerDate", desc: "settings.headerDate.desc", control: { type: "toggle" }, parent: "headerMode", visible: (s) => s.headerMode !== "off" },
	{ id: "headerTitle", section: "pages", group: "pageHeader", order: 40, name: "settings.headerTitle", control: { type: "toggle" }, parent: "headerMode", visible: (s) => s.headerMode !== "off" },
	{
		id: "headerAlign", section: "pages", group: "pageHeader", order: 50, name: "settings.headerAlign",
		control: { type: "dropdown", options: options([["left", "settings.headerAlign.left"], ["centre", "settings.headerAlign.centre"], ["right", "settings.headerAlign.right"]]) }, parent: "headerMode", visible: (s) => s.headerMode !== "off",
	},
	{ id: "headerInExport", section: "pages", group: "pageHeader", order: 60, name: "settings.headerInExport", desc: "settings.headerInExport.desc", control: { type: "toggle" }, parent: "headerMode", visible: (s) => s.headerMode !== "off" },
	{ id: "headerPageTimes", section: "pages", group: "pageHeader", order: 70, name: "settings.headerPageTimes", desc: "settings.headerPageTimes.desc", control: { type: "toggle" } },
];

const READING: SettingSpec[] = [
	{ id: "snapHighlighter", section: "reading", order: 10, name: "settings.snapHighlighter", desc: "settings.snapHighlighter.desc", control: { type: "toggle" } },
	{ id: "dimBackground", section: "reading", order: 20, name: "settings.dimBackground", desc: "settings.dimBackground.desc", control: { type: "toggle" } },
	{
		id: "dimStrength", section: "reading", order: 21, name: "settings.dimStrength",
		control: { type: "slider", min: DIM_MIN, max: DIM_MAX, step: DIM_STEP, format: (v) => `${Math.round(v * 100)} %` }, parent: "dimBackground", visible: (s) => s.dimBackground,
	},
	{ id: "cropMargins", section: "reading", order: 30, name: "settings.cropMargins", desc: "settings.cropMargins.desc", control: { type: "toggle" } },
	// 0.14 slides (#226): ink remembers the slide beside the notes; its badge shows the slide again.
	{ id: "slideInkLink", section: "reading", order: 40, name: "settings.slideInkLink", desc: "settings.slideInkLink.desc", control: { type: "toggle" }, keywords: "slide side by side pdf link ink notes diapositiva affiancato" },
	{ id: "slideInkBadges", section: "reading", order: 41, name: "settings.slideInkBadges", desc: "settings.slideInkBadges.desc", control: { type: "toggle" }, parent: "slideInkLink", keywords: "slide badge diapositiva" },
	// 0.16 present: presentation mode (roadmap #87).
	{ id: "presentSteps", section: "reading", order: 50, name: "settings.presentSteps", desc: "settings.presentSteps.desc", control: { type: "toggle" }, keywords: "presentation present slides states steps presentazione" },
	{ id: "presentLaser", section: "reading", order: 51, name: "settings.presentLaser", desc: "settings.presentLaser.desc", control: { type: "toggle" }, keywords: "presentation present laser pointer puntatore" },

	// 0.16 (#90) highlights digest: how the digest note groups the highlights.
	{
		id: "digestGroup", section: "reading", order: 60, name: "settings.digestGroup", desc: "settings.digestGroup.desc",
		control: { type: "dropdown", options: options([["page", "settings.digestGroup.page"], ["colour", "settings.digestGroup.colour"]]) }, keywords: "highlights digest summary evidenziazioni riepilogo colour colore",
	},
	// 0.21 (#187): back-of-book index.
	{ id: "indexPrefix", section: "reading", order: 61, name: "settings.indexPrefix", desc: "settings.indexPrefix.desc", control: { type: "text", placeholder: "#idx" }, keywords: "index back of book term prefix marker indice analitico prefisso" },
	// 0.22 colormeaning (#101): what each ink colour means; edited in a dialog, used by the view filter and the digest by colour.
	{
		id: "colourMeanings", section: "reading", order: 62, name: "settings.meanings", desc: "settings.meanings.desc",
		control: { type: "action", run: "meanings-edit", button: "settings.open" }, edits: ["colourMeanings"], keywords: "colour color meaning legend definition example filter digest significato colori legenda definizione esempio",
	},
	{
		id: "meaningTolerance", section: "reading", order: 63, name: "settings.meaningTolerance", desc: "settings.meaningTolerance.desc",
		control: { type: "dropdown", options: options([["strict", "settings.meaningTolerance.strict"], ["normal", "settings.meaningTolerance.normal"], ["loose", "settings.meaningTolerance.loose"]]) }, parent: "colourMeanings", keywords: "colour color match tolerance legend tolleranza colori",
	},

	// 0.18 (#86): margin comments.
	{ id: "commentMarkers", section: "reading", order: 70, name: "settings.commentMarkers", desc: "settings.commentMarkers.desc", control: { type: "toggle" }, keywords: "comments markers margin review commenti margine revisione" },
	{ id: "commentsInPdf", section: "reading", order: 71, name: "settings.commentsInPdf", desc: "settings.commentsInPdf.desc", control: { type: "toggle" }, keywords: "comments pdf markdown export margin notes commenti esporta note a margine" },
	// 0.20 refwindow (#107): the floating reference window.
	{ id: "refWindowSnap", section: "reading", order: 75, name: "settings.refWindowSnap", desc: "settings.refWindowSnap.desc", control: { type: "toggle" }, keywords: "reference window floating snap edges finestra riferimento aggancio bordi" },

	// 0.16 (#46): links of PDF pages.
	{ id: "pdfLinks", section: "reading", order: 45, name: "settings.pdfLinks", desc: "settings.pdfLinks.desc", control: { type: "toggle" }, keywords: "pdf link internal external collegamenti url" },
];

const LIBRARY: SettingSpec[] = [
	{ id: "folder", section: "library", order: 10, name: "settings.folder", desc: "settings.folder.desc", control: { type: "folder", placeholder: DEFAULT_SETTINGS.folder } },
	{
		id: "trashRetentionDays", section: "library", order: 20, name: "settings.trashRetention", desc: "settings.trashRetention.desc",
		control: { type: "slider", min: 0, max: TRASH_RETENTION_MAX_DAYS, step: 1, format: suffix("d", true) },
	},
	{
		id: "snapshotIntervalHours", section: "library", order: 30, name: "settings.snapshotInterval", desc: "settings.snapshotInterval.desc",
		control: { type: "slider", min: 0, max: 168, step: 1, format: suffix("h", true) }, keywords: "backup snapshot",
	},
	{
		id: "snapshotsToKeep", section: "library", order: 31, name: "settings.snapshotKeep", desc: "settings.snapshotKeep.desc",
		control: { type: "slider", min: 1, max: 50, step: 1 }, parent: "snapshotIntervalHours", visible: (s) => s.snapshotIntervalHours > 0,
	},
	// 0.19 snapshot: a snapshot at the end of a lecture, kept apart from the interval ones
	{
		id: "lectureSnapshots", section: "library", order: 32, name: "settings.lectureSnapshots", desc: "settings.lectureSnapshots.desc",
		control: { type: "toggle" }, keywords: "backup snapshot lecture lesson class lezione",
	},
	{
		id: "lectureSnapshotsKeep", section: "library", order: 33, name: "settings.lectureSnapshotsKeep", desc: "settings.lectureSnapshotsKeep.desc",
		control: { type: "slider", min: 1, max: 100, step: 1 }, parent: "lectureSnapshots", visible: (s) => s.lectureSnapshots,
	},
	// 0.15 views: the Board's columns (names, colours, add, remove) are edited in a dialog; the statuses themselves are synced notebook data.
	{
		id: "boardColumns", section: "library", order: 40, name: "settings.boardColumns", desc: "settings.boardColumns.desc",
		control: { type: "action", run: "board-columns", button: "settings.open" }, edits: ["boardColumns"], keywords: "board kanban status columns lavagna colonne stato da fare in corso fatto stampare",
	},
	// 0.15 storage (128): the Storage manager (sizes, unused / duplicate / heavy files, old backups).
	{
		id: "storageManager", section: "library", order: 41, name: "settings.storage", desc: "settings.storage.desc",
		control: { type: "action", run: "storage-open", button: "settings.open" }, keywords: "storage space size disk cleanup duplicate unused backup spazio archiviazione pulizia",
	},
	// 0.16 shared files (#177): PDFs and images shared to Obsidian from other apps, offered on Home.
	{ id: "sharedInbox", section: "library", order: 42, name: "settings.sharedInbox", desc: "settings.sharedInbox.desc", control: { type: "toggle" }, keywords: "inbox share shared received files pdf image attachments condividi ricevuti file allegati" },
	{ id: "sharedInboxFolder", section: "library", order: 43, name: "settings.sharedInboxFolder", desc: "settings.sharedInboxFolder.desc", control: { type: "folder", placeholder: "/" }, parent: "sharedInbox", visible: (s) => s.sharedInbox },
	{ id: "looseSheetPath", section: "library", group: ADVANCED, order: 10, name: "settings.looseSheet", desc: "settings.looseSheet.desc", control: { type: "text", placeholder: defaultLooseSheetPath(DEFAULT_SETTINGS.folder) } },
	{ id: "templatesFolder", section: "library", group: ADVANCED, order: 20, name: "settings.templatesFolder", desc: "settings.templatesFolder.desc", control: { type: "folder", placeholder: "_templates" } },
	// 0.15 templates (roadmap #19)
	{ id: "notebookTemplatesFolder", section: "library", group: ADVANCED, order: 21, name: "settings.notebookTemplatesFolder", desc: "settings.notebookTemplatesFolder.desc", control: { type: "folder", placeholder: "_templates/notebooks" } },
	{ id: "notebookTemplates", section: "library", group: ADVANCED, order: 22, name: "settings.notebookTemplates", desc: "settings.notebookTemplates.desc", control: { type: "action", run: "notebook-templates-manage", button: "settings.notebookTemplates.button" }, keywords: "template notebooks planner modelli quaderni" },
];

// 0.22 synccore (#126): the cloud sync rows show only while the service runs; the options only once a service is chosen.
const cloudSyncService: Predicate = (_s, ctx) => ctx.cloudSync === true;
const cloudSyncOn: Predicate = (s, ctx) => ctx.cloudSync === true && s.cloudSyncProvider !== "off";

const SYNC: SettingSpec[] = [
	{ id: "deviceName", section: "sync", order: 10, name: "settings.deviceName", desc: "settings.deviceName.desc", control: { type: "custom", render: "device-name" }, visible: (_s, ctx) => ctx.sync },
	{ id: "syncCheck", section: "sync", order: 20, name: "settings.syncCheck", desc: "settings.syncCheck.desc", control: { type: "action", run: "sync-check", button: "sync.check.button" }, visible: (_s, ctx) => ctx.sync },
	// 0.21 backups (#127): scheduled zip backups into a vault folder; the "Back up now" row shows the last time and result.
	{
		id: "zipBackupSchedule", section: "sync", order: 30, name: "settings.backupSchedule", desc: "settings.backupSchedule.desc",
		control: { type: "dropdown", options: options([["off", "settings.backupSchedule.off"], ["daily", "settings.backupSchedule.daily"], ["weekly", "settings.backupSchedule.weekly"]]) },
		keywords: "backup zip schedule automatic copy safety archive copia di sicurezza pianificata automatica giornaliera settimanale",
		visible: (_s, ctx) => ctx.backups === true,
	},
	{ id: "zipBackupFolder", section: "sync", order: 31, name: "settings.backupFolder", desc: "settings.backupFolder.desc", control: { type: "folder", placeholder: DEFAULT_SETTINGS.zipBackupFolder }, parent: "zipBackupSchedule", visible: (s, ctx) => ctx.backups === true && s.zipBackupSchedule !== "off" },
	{ id: "zipBackupKeep", section: "sync", order: 32, name: "settings.backupKeep", desc: "settings.backupKeep.desc", control: { type: "slider", min: 1, max: 30, step: 1 }, parent: "zipBackupSchedule", visible: (s, ctx) => ctx.backups === true && s.zipBackupSchedule !== "off" },
	{ id: "backupNow", section: "sync", order: 40, name: "settings.backupNow", control: { type: "custom", render: "backup-now" }, keywords: "backup zip now copy safety archive copia di sicurezza adesso", visible: (_s, ctx) => ctx.backups === true },
	// 0.22 synccore (#126): the optional Google Drive / OneDrive connector (off by default), in its own group of this section.
	{
		id: "cloudSyncProvider", section: "sync", group: "cloudSync", order: 10, name: "settings.cloudSyncProvider", desc: "settings.cloudSyncProvider.desc",
		control: { type: "dropdown", options: options([["off", "settings.cloudSyncProvider.off"], ["gdrive", "settings.cloudSyncProvider.gdrive"], ["onedrive", "settings.cloudSyncProvider.onedrive"]]) },
		keywords: "cloud google drive onedrive connector account sync connettore account nuvola", visible: cloudSyncService,
	},
	// The user's own OAuth client: the id in the settings (the same on every device), Google's secret only on this device.
	{ id: "cloudSyncGdriveClientId", section: "sync", group: "cloudSync", order: 11, name: "settings.cloudSyncClientId", desc: "settings.cloudSyncClientId.gdrive", control: { type: "text", placeholder: "…apps.googleusercontent.com" }, keywords: "oauth client id google", parent: "cloudSyncProvider", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncProvider === "gdrive" },
	{ id: "cloudSyncSecret", section: "sync", group: "cloudSync", order: 12, name: "settings.cloudSyncSecret", desc: "settings.cloudSyncSecret.desc", control: { type: "custom", render: "cloud-secret" }, keywords: "oauth client secret google", parent: "cloudSyncProvider", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncProvider === "gdrive" },
	{ id: "cloudSyncOnedriveClientId", section: "sync", group: "cloudSync", order: 11, name: "settings.cloudSyncClientId", desc: "settings.cloudSyncClientId.onedrive", control: { type: "text", placeholder: "00000000-0000-0000-0000-000000000000" }, keywords: "oauth client id application microsoft azure", parent: "cloudSyncProvider", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncProvider === "onedrive" },
	{ id: "cloudSyncAccount", section: "sync", group: "cloudSync", order: 13, name: "settings.cloudSyncAccount", control: { type: "custom", render: "cloud-account" }, keywords: "sign in login disconnect accedi disconnetti", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{ id: "cloudSyncNow", section: "sync", group: "cloudSync", order: 14, name: "settings.cloudSyncNow", control: { type: "custom", render: "cloud-sync-now" }, keywords: "sync now status sincronizza ora stato", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{
		id: "cloudSyncScope", section: "sync", group: "cloudSync", order: 20, name: "settings.cloudSyncScope", desc: "settings.cloudSyncScope.desc",
		control: { type: "dropdown", options: options([["vault", "settings.cloudSyncScope.vault"], ["folders", "settings.cloudSyncScope.folders"], ["rules", "settings.cloudSyncScope.rules"]]) },
		keywords: "scope folders rules include exclude cartelle regole", parent: "cloudSyncProvider", visible: cloudSyncOn,
	},
	{ id: "cloudSyncFolders", section: "sync", group: "cloudSync", order: 21, name: "settings.cloudSyncFolders", desc: "settings.cloudSyncFolders.desc", control: { type: "text", placeholder: "Notebooks, School" }, parent: "cloudSyncScope", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncScope === "folders" },
	{ id: "cloudSyncInclude", section: "sync", group: "cloudSync", order: 22, name: "settings.cloudSyncInclude", desc: "settings.cloudSyncInclude.desc", control: { type: "text", placeholder: "Notebooks/**, *.pdf" }, keywords: "pattern glob", parent: "cloudSyncScope", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncScope === "rules" },
	{ id: "cloudSyncExclude", section: "sync", group: "cloudSync", order: 23, name: "settings.cloudSyncExclude", desc: "settings.cloudSyncExclude.desc", control: { type: "text", placeholder: "**/drafts/**, *.zip" }, keywords: "pattern glob", parent: "cloudSyncScope", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncScope === "rules" },
	{ id: "cloudSyncTypes", section: "sync", group: "cloudSync", order: 24, name: "settings.cloudSyncTypes", desc: "settings.cloudSyncTypes.desc", control: { type: "text", placeholder: "notebook, pdf, png" }, keywords: "extension type estensione tipo", parent: "cloudSyncScope", visible: (s, ctx) => cloudSyncOn(s, ctx) && s.cloudSyncScope === "rules" },
	{ id: "cloudSyncOnOpen", section: "sync", group: "cloudSync", order: 30, name: "settings.cloudSyncOnOpen", desc: "settings.cloudSyncOnOpen.desc", control: { type: "toggle" }, keywords: "start avvio", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{ id: "cloudSyncOnClose", section: "sync", group: "cloudSync", order: 31, name: "settings.cloudSyncOnClose", desc: "settings.cloudSyncOnClose.desc", control: { type: "toggle" }, keywords: "quit leave chiusura uscita", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{ id: "cloudSyncInterval", section: "sync", group: "cloudSync", order: 32, name: "settings.cloudSyncInterval", desc: "settings.cloudSyncInterval.desc", control: { type: "slider", min: 0, max: CLOUD_INTERVAL_MAX, step: 5, format: suffix("min", true) }, keywords: "interval minutes periodic intervallo minuti", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{ id: "cloudSyncWifiOnly", section: "sync", group: "cloudSync", order: 33, name: "settings.cloudSyncWifiOnly", desc: "settings.cloudSyncWifiOnly.desc", control: { type: "toggle" }, keywords: "wifi mobile data cellular dati mobili rete", parent: "cloudSyncProvider", visible: cloudSyncOn },
	{
		id: "cloudSyncLarge", section: "sync", group: "cloudSync", order: 40, name: "settings.cloudSyncLarge", desc: "settings.cloudSyncLarge.desc",
		control: { type: "dropdown", options: options([["ask", "settings.cloudSyncLarge.ask"], ["skip", "settings.cloudSyncLarge.skip"]]) },
		keywords: "large big size file grandi dimensione", parent: "cloudSyncProvider", visible: cloudSyncOn,
	},
	{ id: "cloudSyncLargeMb", section: "sync", group: "cloudSync", order: 41, name: "settings.cloudSyncLargeMb", desc: "settings.cloudSyncLargeMb.desc", control: { type: "slider", min: 0, max: CLOUD_LARGE_MAX_MB, step: 10, format: suffix("MB", true) }, keywords: "size limit megabytes limite", parent: "cloudSyncLarge", visible: cloudSyncOn },
	{ id: "cloudSyncMobileMaxMb", section: "sync", group: "cloudSync", order: 42, name: "settings.cloudSyncMobileMaxMb", desc: "settings.cloudSyncMobileMaxMb.desc", control: { type: "slider", min: CLOUD_MOBILE_MIN_MB, max: CLOUD_MOBILE_MAX_MB, step: 5, format: suffix("MB") }, keywords: "phone tablet mobile size cap memory telefono limite memoria", parent: "cloudSyncLarge", visible: cloudSyncOn },
	{ id: "cloudSyncLog", section: "sync", group: "cloudSync", order: 50, name: "settings.cloudSyncLog", desc: "settings.cloudSyncLog.desc", control: { type: "custom", render: "cloud-log" }, keywords: "log activity history registro attività", parent: "cloudSyncProvider", visible: cloudSyncOn },
];

const companionOn: Predicate = (s) => s.companionNotes;

const INTEGRATION: SettingSpec[] = [
	{ id: "notebookTabs", section: "integration", order: 10, name: "settings.notebookTabs", desc: "settings.notebookTabs.desc", control: { type: "toggle" } },
	{ id: "companionNotes", section: "integration", order: 20, name: "settings.companion", desc: "settings.companion.desc", control: { type: "toggle" }, keywords: "markdown dataview bases" },
	{
		id: "companionLocation", section: "integration", order: 21, name: "settings.companionLocation",
		control: { type: "dropdown", options: options([["beside", "settings.companionLocation.beside"], ["folder", "settings.companionLocation.folder"]]) },
		parent: "companionNotes", visible: companionOn,
	},
	{
		id: "companionFolder", section: "integration", order: 22, name: "settings.companionFolder", desc: "settings.companionFolder.desc",
		control: { type: "folder", placeholder: DEFAULT_SETTINGS.companionFolder }, parent: "companionLocation", visible: (s) => s.companionLocation === "folder",
	},
	{ id: "companionName", section: "integration", order: 23, name: "settings.companionName", desc: "settings.companionName.desc", control: { type: "text", placeholder: NAME_TOKEN }, parent: "companionNotes", visible: companionOn },
	// 0.19 search (O19)
	{ id: "companionSearchText", section: "integration", order: 23.5, name: "settings.companionSearchText", desc: "settings.companionSearchText.desc", control: { type: "toggle" }, parent: "companionNotes", visible: companionOn, keywords: "search find sticky comments equations ricerca" },
	{ id: "companionHeadings", section: "integration", order: 23.6, name: "settings.companionHeadings", desc: "settings.companionHeadings.desc", control: { type: "toggle" }, parent: "companionNotes", visible: companionOn, keywords: "headings titles titoli handwriting scrittura pictures immagini" },
	{
		id: "companionUpdateAll", section: "integration", order: 24, name: "settings.companionUpdateAll", desc: "settings.companionUpdateAll.desc",
		control: { type: "action", run: "companion-update-all", button: "settings.companionUpdateAll.button" }, parent: "companionNotes", visible: companionOn,
	},
	// 0.15 daily (O12): "Today's page" and its link from the daily note.
	{ id: "dailyNotebookPath", section: "integration", order: 30, name: "settings.dailyNotebook", desc: "settings.dailyNotebook.desc", control: { type: "text", placeholder: defaultDailyPath(DEFAULT_SETTINGS.folder) }, keywords: "daily journal today diario oggi" },
	{ id: "dailyLink", section: "integration", order: 31, name: "settings.dailyLink", desc: "settings.dailyLink.desc", control: { type: "toggle" }, keywords: "daily notes periodic notes journal diario" },
	{ id: "dailyCreateNote", section: "integration", order: 32, name: "settings.dailyCreateNote", desc: "settings.dailyCreateNote.desc", control: { type: "toggle" }, parent: "dailyLink", visible: (s) => s.dailyLink },
	// 0.19 (#221): lecture log in the daily note.
	{ id: "lectureLog", section: "integration", order: 35, name: "settings.lectureLog", desc: "settings.lectureLog.desc", control: { type: "toggle" }, keywords: "lecture log daily note timetable class registro lezione diario" },
	{ id: "lectureLogHeading", section: "integration", order: 36, name: "settings.lectureLogHeading", desc: "settings.lectureLogHeading.desc", control: { type: "text", placeholder: DEFAULT_SETTINGS.lectureLogHeading }, parent: "lectureLog", visible: (s) => s.lectureLog },
	// 0.17 (#23): the optional PDF copy next to each notebook; a notebook can override the switch from its menu.
	{ id: "pdfCopy", section: "integration", order: 40, name: "settings.pdfCopy", desc: "settings.pdfCopy.desc", control: { type: "toggle" }, keywords: "pdf copy share notebooklm export automatic copia condividere" },
	{
		id: "pdfCopyWhen", section: "integration", order: 41, name: "settings.pdfCopyWhen", desc: "settings.pdfCopyWhen.desc", keywords: "pdf copy battery android close idle chiusura",
		control: { type: "dropdown", options: options([["auto", "settings.pdfCopyWhen.auto"], ["idle", "settings.pdfCopyWhen.idle"], ["close", "settings.pdfCopyWhen.close"]]) },
	},
	{ id: "pdfCopyFolder", section: "integration", order: 42, name: "settings.pdfCopyFolder", desc: "settings.pdfCopyFolder.desc", control: { type: "folder", placeholder: "" }, keywords: "pdf copy folder cartella" },
	// 0.17 tasks (#57): "Make task" from a selection.
	{ id: "tasksNote", section: "integration", order: 33, name: "settings.tasksNote", desc: "settings.tasksNote.desc", control: { type: "text", placeholder: "Tasks.md" }, keywords: "task todo checkbox attivita" },
	{ id: "taskDueEmoji", section: "integration", order: 34, name: "settings.taskDueEmoji", desc: "settings.taskDueEmoji.desc", control: { type: "toggle" }, keywords: "task due date tasks plugin scadenza" },
	// 0.18 (#59): "Insert into note" from a selection.
	{ id: "noteInsertWidth", section: "integration", order: 35, name: "settings.noteInsertWidth", desc: "settings.noteInsertWidth.desc", control: { type: "slider", min: INSERT_WIDTH_MIN, max: INSERT_WIDTH_MAX, step: INSERT_WIDTH_STEP, format: suffix("px") }, keywords: "insert note image width larghezza immagine nota" },
	{
		id: "noteInsertBackground", section: "integration", order: 36, name: "settings.noteInsertBackground", desc: "settings.noteInsertBackground.desc", keywords: "insert note image transparent paper sfondo trasparente carta",
		control: { type: "dropdown", options: options([["transparent", "settings.noteInsertBackground.transparent"], ["paper", "settings.noteInsertBackground.paper"]]) },
	},
	{ id: "noteInsertLinkBack", section: "integration", order: 37, name: "settings.noteInsertLinkBack", desc: "settings.noteInsertLinkBack.desc", control: { type: "toggle" }, keywords: "insert note link back page collegamento pagina" },
	// 0.18 (#186): "Copy to notebook…" can leave a chip on the original page too.
	{ id: "copyLinkReverse", section: "integration", order: 38, name: "settings.copyLinkReverse", desc: "settings.copyLinkReverse.desc", control: { type: "toggle" }, keywords: "copy page notebook link back chip copia pagina collegamento" },
	// 0.19 (#213): "Look up later" from a selection.
	{ id: "lookUpNote", section: "integration", order: 43, name: "settings.lookUpNote", desc: "settings.lookUpNote.desc", control: { type: "text", placeholder: "Look up later.md" }, keywords: "look up later words list dictionary cerca dopo parole elenco" },
	{ id: "lookUpWidth", section: "integration", order: 44, name: "settings.lookUpWidth", desc: "settings.lookUpWidth.desc", control: { type: "slider", min: LOOKUP_WIDTH_MIN, max: LOOKUP_WIDTH_MAX, step: LOOKUP_WIDTH_STEP, format: suffix("px") }, keywords: "look up later picture crop width larghezza immagine" },
];

const timetableOn: Predicate = (s) => s.timetableOffer;

const STUDY: SettingSpec[] = [
	{
		id: "timetableEdit", section: "study", group: "timetable", order: 10, name: "settings.timetable.edit", desc: "settings.timetable.desc",
		descVars: (ctx) => ({ path: ctx.timetablePath ?? "_timetable.json" }), control: { type: "action", run: "timetable-edit" }, visible: (_s, ctx) => ctx.timetable,
	},
	{ id: "timetableOffer", section: "study", group: "timetable", order: 20, name: "settings.timetable.offer", desc: "settings.timetable.offer.desc", control: { type: "toggle" } },
	{ id: "timetableAutoOpen", section: "study", group: "timetable", order: 21, name: "settings.timetable.auto", desc: "settings.timetable.auto.desc", control: { type: "toggle" }, parent: "timetableOffer", visible: timetableOn },
	{
		id: "timetableLeadMinutes", section: "study", group: "timetable", order: 22, name: "settings.timetable.lead",
		control: { type: "slider", min: 0, max: 30, step: 1, format: suffix("min") }, parent: "timetableOffer", visible: timetableOn,
	},
	// 0.14 (401): lecture mode follows the timetable; off / ask / automatic.
	{
		id: "lectureMode", section: "study", group: "timetable", order: 30, name: "settings.lectureMode", desc: "settings.lectureMode.desc", keywords: "class lesson lecture classe lezione",
		control: { type: "dropdown", options: options([["off", "settings.lectureMode.off"], ["ask", "settings.lectureMode.ask"], ["auto", "settings.lectureMode.auto"]]) },
	},
	// 0.21 slideback (#225): the pill back to where you last wrote during a lecture.
	{ id: "slideBack", section: "study", group: "timetable", order: 31, name: "settings.slideBack", desc: "settings.slideBack.desc", control: { type: "toggle" }, keywords: "lecture slide back return current page lezione diapositiva torna" },
	// 0.22 lecthead (#210): the header of the class (course, lecturer, room, date, time) on the page you write on.
	{
		id: "lectureHeader", section: "study", group: "timetable", order: 32, name: "settings.lectureHeader", desc: "settings.lectureHeader.desc", keywords: "lecture header course lecturer room date time intestazione lezione corso docente aula",
		control: { type: "dropdown", options: options([["off", "settings.lectureHeader.off"], ["ask", "settings.lectureHeader.ask"], ["auto", "settings.lectureHeader.auto"]]) },
	},
	{ id: "lectureHeaderLecturer", section: "study", group: "timetable", order: 33, name: "settings.lectureHeader.lecturer", control: { type: "toggle" }, parent: "lectureHeader", visible: (s) => s.lectureHeader !== "off" },
	{ id: "lectureHeaderRoom", section: "study", group: "timetable", order: 34, name: "settings.lectureHeader.room", control: { type: "toggle" }, parent: "lectureHeader", visible: (s) => s.lectureHeader !== "off" },
	{ id: "lectureHeaderDate", section: "study", group: "timetable", order: 35, name: "settings.lectureHeader.date", control: { type: "toggle" }, parent: "lectureHeader", visible: (s) => s.lectureHeader !== "off" },
	{ id: "lectureHeaderTime", section: "study", group: "timetable", order: 36, name: "settings.lectureHeader.time", control: { type: "toggle" }, parent: "lectureHeader", visible: (s) => s.lectureHeader !== "off" },
	{ id: "zettelFolder", section: "study", group: "zettel", order: 10, name: "settings.zettelFolder", desc: "settings.zettelFolder.desc", control: { type: "folder", placeholder: DEFAULT_SETTINGS.zettelFolder } },
	{
		id: "zettelIdScheme", section: "study", group: "zettel", order: 20, name: "settings.zettelIdScheme", desc: "settings.zettelIdScheme.desc",
		control: { type: "dropdown", options: options([["timestamp", "settings.zettelIdScheme.timestamp"], ["luhmann", "settings.zettelIdScheme.luhmann"]]) },
	},
	{ id: "zettelShowRegions", section: "study", group: "zettel", order: 30, name: "settings.zettelShowRegions", desc: "settings.zettelShowRegions.desc", control: { type: "toggle" } },
];

const APPEARANCE: SettingSpec[] = [
	{
		id: "uiLanguage", section: "appearance", order: 10, name: "settings.uiLanguage", desc: "settings.uiLanguage.desc", keywords: "language lingua",
		control: { type: "dropdown", options: (tr) => ({ auto: tr("settings.uiLanguage.auto"), ...Object.fromEntries(LANGUAGE_CODES.map((c) => [c, LANGUAGES[c].label])) }) },
	},
	{
		id: "appearanceStyle", section: "appearance", order: 20, name: "settings.appearanceStyle", desc: "settings.appearanceStyle.desc", keywords: "theme tema colours colori",
		control: { type: "dropdown", options: options([["notebook", "settings.appearanceStyle.notebook"], ["obsidian", "settings.appearanceStyle.obsidian"]]) },
	},
	{
		id: "toolbarSize", section: "appearance", order: 30, name: "settings.toolbarSize", desc: "settings.toolbarSize.desc",
		control: { type: "dropdown", options: options([["compact", "settings.toolbarSize.compact"], ["normal", "settings.toolbarSize.normal"], ["large", "settings.toolbarSize.large"]]) },
	},
	// 0.14: generative interface. One switch per family; the pinned slots and the reset are always available.
	{ id: "adaptPageType", section: "appearance", order: 31, name: "settings.adaptPageType", desc: "settings.adaptPageType.desc", control: { type: "toggle" }, keywords: "adaptive toolbar page slide ruled grid adattiva barra pagina" },
	{ id: "adaptLearn", section: "appearance", order: 32, name: "settings.adaptLearn", desc: "settings.adaptLearn.desc", control: { type: "toggle" }, keywords: "adaptive toolbar learn notebook course usage frequent adattiva impara quaderno corso" },
	{ id: "adaptSelection", section: "appearance", order: 33, name: "settings.adaptSelection", desc: "settings.adaptSelection.desc", control: { type: "toggle" }, keywords: "adaptive selection bar ink image text lasso adattiva selezione" },
	{ id: "toolbarReset", section: "appearance", order: 34, name: "settings.toolbarReset", desc: "settings.toolbarReset.desc", control: { type: "action", run: "toolbar-reset", button: "settings.toolbarReset.button" }, keywords: "adaptive toolbar pinned pin reset forget learned fissate azzera dimentica" },
	{ id: "userName", section: "appearance", order: 15, name: "settings.userName", desc: "settings.userName.desc", keywords: "name nome greeting saluto home", control: { type: "text", placeholder: "Alex" } },
	{ id: "nightMode", section: "appearance", order: 40, name: "settings.nightMode", desc: "settings.nightMode.desc", control: { type: "toggle" }, keywords: "dark scuro" },
	// 0.13: just-in-time tips.
	{ id: "hintsEnabled", section: "appearance", order: 50, name: "settings.hints", desc: "settings.hints.desc", control: { type: "toggle" }, keywords: "tips hints suggerimenti consigli" },
	{ id: "hintsReset", section: "appearance", order: 60, name: "settings.hintsReset", desc: "settings.hintsReset.desc", control: { type: "action", run: "hints-reset", button: "settings.hintsReset.button" }, parent: "hintsEnabled", keywords: "tips hints suggerimenti consigli" },
];

const DIAGNOSTICS: SettingSpec[] = [
	{ id: "penTest", section: "diagnostics", order: 10, name: "settings.penTest", desc: "settings.penTest.desc", control: { type: "action", run: "pen-test", button: "settings.open" } },
	{ id: "benchmark", section: "diagnostics", order: 20, name: "command.benchmark", desc: "settings.benchmark.desc", control: { type: "action", run: "benchmark", button: "settings.open" } },
	{ id: "perfOverlay", section: "diagnostics", order: 30, name: "settings.perfOverlay", desc: "settings.perfOverlay.desc", control: { type: "toggle" } },
	// 0.12.3: what a bug report needs (the WebView's Chrome version, Obsidian's version, the platform), read-only.
	{ id: "deviceInfo", section: "diagnostics", order: 40, name: "settings.deviceInfo", desc: "settings.deviceInfo.desc", control: { type: "custom", render: "device-info" }, keywords: "webview chrome version android user agent" },
];

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// EXTENSION POINT — Pen & input: S Pen button settings.
//
// Rows of the side button that are added by other changes go here, with `section: "input"`, an `order` from 41 to 49
// (between "Pen side button", 40, and "Hold the pen still for the radial menu", 50) or `group: ADVANCED`, and
// `parent: "penSideButton", visible: penButtonOn` when they only matter while the button does something. Each key must
// also be in DEFAULT_SETTINGS and its strings in en.ts and it.ts; tests/settings-schema.test.ts checks both. Example:
//
//   { id: "penButtonEraserNext", section: "input", order: 41, name: "settings.penButtonEraserNext",
//     desc: "settings.penButtonEraserNext.desc", control: { type: "toggle" }, parent: "penSideButton", visible: penButtonOn },
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const PEN_BUTTON_EXTENSIONS: SettingSpec[] = [
	// 0.11.2 S Pen fallback (ink/pen-hover.ts): the hover click arms the eraser; a key (Key Mapper + Shizuku) acts as the button.
	{ id: "penButtonEraserNext", section: "input", order: 41, name: "settings.penButtonEraserNext", desc: "settings.penButtonEraserNext.desc", control: { type: "toggle" }, parent: "penSideButton", visible: penButtonOn },
	// The key works whatever the side button does, so it is not hidden with it. A custom row: key capture and the hotkey warning.
	{
		id: "penButtonKey", section: "input", order: 42, name: "settings.penButtonKey", desc: "settings.penButtonKey.desc", keywords: "key mapper shizuku s pen f9 f10 f11 f12 tasto",
		control: { type: "custom", render: "pen-key" }, edits: ["penButtonKey"], parent: "penSideButton",
	},
	{
		id: "penButtonKeyAction", section: "input", order: 43, name: "settings.penButtonKeyAction", desc: "settings.penButtonKeyAction.desc",
		control: { type: "dropdown", options: options([["eraser-next", "settings.penButtonKeyAction.eraserNext"], ["menu", "settings.penButtonKeyAction.menu"]]) },
		parent: "penButtonKey", visible: (s) => s.penButtonKey !== "",
	},
	// Side button timing around a pen contact (Advanced, next to the other button options).
	{
		id: "penButtonContactBeforeMs", section: "input", group: ADVANCED, order: 31, name: "settings.penButtonBeforeMs", desc: "settings.penButtonBeforeMs.desc",
		keywords: "side button timing tempi del pulsante laterale", control: { type: "slider", min: 0, max: BUTTON_BEFORE_MAX_MS, step: 10, format: suffix("ms") },
		parent: "penSideButton", visible: penButtonOn,
	},
	{
		id: "penButtonContactAfterMs", section: "input", group: ADVANCED, order: 32, name: "settings.penButtonAfterMs", desc: "settings.penButtonAfterMs.desc",
		keywords: "side button timing tempi del pulsante laterale", control: { type: "slider", min: 0, max: BUTTON_AFTER_MAX_MS, step: 10, format: suffix("ms") },
		parent: "penSideButton", visible: penButtonOn,
	},
];

/**
 * Settings keys that are not in the tab, and why: state the app keeps by itself, or edited where it is used.
 * Every other key of DEFAULT_SETTINGS is in exactly one section (tests/settings-schema.test.ts).
 */
export const INTERNAL_SETTING_KEYS: Readonly<Partial<Record<SettingKey, string>>> = {
	favouritePens: "edited on the toolbar (long press on a favourite, radial menu)",
	eraserSize: "the eraser's size, edited in its tool options",
	recentColours: "history of the colour picker",
	penButtonWindowsMigrated: "set by the app once the old 150 ms default of the before-window was read as the new one",
	penButtonSeen: "set by the app when the device first delivers a side-button signal",
	lastNotebookPath: "instant start: the last notebook",
	lastNotebookPage: "instant start: the last page",
	lastNotebookPos: "instant start: zoom and scroll of the last page",
	hintsSeen: "the tips already shown; Show tips again clears it",
	zettelSlipBoxes: "edited from the notebook menu (Zettelkasten slip boxes)",
	pdfCopyNotebooks: "edited from the notebook menu (Keep a PDF copy of this notebook)",
	pinnedQuick: "edited on the toolbar (press and hold a quick action, or a row of All actions); Reset the adaptive toolbar clears it",
};

const ALL: SettingSpec[] = [...WRITING, ...INPUT, ...PAGES, ...READING, ...LIBRARY, ...SYNC, ...INTEGRATION, ...STUDY, ...APPEARANCE, ...DIAGNOSTICS];

/** Every row of the tab, with the extensions, in display order (section, then main / groups / Advanced, then order). */
export function settingSpecs(): SettingSpec[] {
	return sortSpecs([...ALL, ...PEN_BUTTON_EXTENSIONS]);
}

/** The groups of a section in display order: main (`undefined`), the feature groups, then Advanced. */
export function sectionGroups(section: SectionId): Array<string | undefined> {
	return [undefined, ...GROUPS.filter((g) => g.section === section).map((g) => g.id), ADVANCED];
}

function sortSpecs(specs: SettingSpec[]): SettingSpec[] {
	const sectionIndex = (s: SettingSpec) => SECTION_IDS.indexOf(s.section);
	const groupIndex = (s: SettingSpec) => sectionGroups(s.section).indexOf(s.group);
	return specs
		.map((spec, i) => ({ spec, i }))
		.sort((a, b) => sectionIndex(a.spec) - sectionIndex(b.spec) || groupIndex(a.spec) - groupIndex(b.spec) || a.spec.order - b.spec.order || a.i - b.i)
		.map((x) => x.spec);
}

/** The settings keys a row changes. */
export function editedKeys(spec: SettingSpec): readonly SettingKey[] {
	if (spec.edits) return spec.edits;
	const t = spec.control.type;
	return t === "action" || t === "custom" ? [] : [spec.id as SettingKey];
}

/** The group spec of a row (`ADVANCED` has none: it is the same for every section). */
export function groupSpec(section: SectionId, id: string): GroupSpec | undefined {
	return GROUPS.find((g) => g.section === section && g.id === id);
}

/** Key of a group in the open-group state: groups are scoped by their section. */
export const groupKey = (section: SectionId, group: string): string => `${section}/${group}`;

// ---------------------------------------------------------------------------------------------------------- search

/** Lower case, accents removed, so "attivita" finds "attività". */
export function normalise(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const lookups: Translate[] = LANGUAGE_CODES.map((code) => (key, vars) => {
	const table: Record<string, string | undefined> = LANGUAGES[code].messages;
	let text = table[key] ?? "";
	if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
	return text;
});

/** A text in every UI language (distinct values), for the aliases Obsidian's own settings search uses. */
export function translations(key: MessageKey): string[] {
	return [...new Set(lookups.map((tr) => tr(key)).filter(Boolean))];
}

const haystacks = new Map<string, string>();

/** What a search query is matched against: name, description, section and group title in every language, keywords. */
export function searchText(spec: SettingSpec): string {
	const cacheKey = `${spec.section}/${spec.id}`;
	let text = haystacks.get(cacheKey);
	if (text === undefined) {
		const section = SECTIONS.find((s) => s.id === spec.section);
		const group = spec.group === ADVANCED ? "settings.group.advanced" : spec.group ? groupSpec(spec.section, spec.group)?.title : undefined;
		const keys = [spec.name, spec.desc, section?.title, group].filter((k): k is MessageKey => !!k);
		text = normalise([...lookups.flatMap((tr) => keys.map((k) => tr(k))), spec.keywords ?? "", spec.id].join(" \n "));
		haystacks.set(cacheKey, text);
	}
	return text;
}

/** Every word of the query is in the row's search text. */
export function matchesQuery(spec: SettingSpec, query: string): boolean {
	const words = normalise(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const text = searchText(spec);
	return words.every((w) => text.includes(w));
}

// ------------------------------------------------------------------------------------------------------ visibility

export interface SettingsViewState {
	settings: NotebookSettings;
	context: SettingsContext;
	/** The search box. */
	query: string;
	/** Groups the person opened or closed (by `groupKey`); the others follow their default. */
	groupOverrides: ReadonlyMap<string, boolean>;
}

export interface GroupView {
	/** The disclosure row is shown (the group has relevant rows and no search is running). */
	visible: boolean;
	open: boolean;
	/** Relevant rows inside, for the disclosure row's count. */
	count: number;
}

export interface SettingsView {
	/** Row id → shown. */
	rows: Map<string, boolean>;
	/** `groupKey` → disclosure row. */
	groups: Map<string, GroupView>;
	/** Section id → shown (it has a shown row or disclosure row). */
	sections: Map<SectionId, boolean>;
	/** Rows shown by the search (0 without a query). */
	matches: number;
}

/** A group is open: what the person chose, or open while its feature is in use (Advanced: closed). */
export function groupOpen(section: SectionId, group: string, state: SettingsViewState): boolean {
	const chosen = state.groupOverrides.get(groupKey(section, group));
	if (chosen !== undefined) return chosen;
	return groupSpec(section, group)?.open?.(state.settings, state.context) ?? false;
}

/**
 * What the tab shows. Without a query: the relevant rows (their own `visible` and their parent's), with the rows of a
 * closed group hidden behind its disclosure row. With a query: only matching relevant rows, groups expanded and their
 * disclosure rows hidden; a matching row that is not relevant (its parent is off) shows its nearest relevant parent, so
 * the way to it stays visible. A section is shown when it has anything to show.
 */
export function settingsView(specs: readonly SettingSpec[], state: SettingsViewState): SettingsView {
	const byId = new Map(specs.map((s) => [s.id, s]));
	const relevantCache = new Map<string, boolean>();
	const relevant = (spec: SettingSpec, depth = 0): boolean => {
		const cached = relevantCache.get(spec.id);
		if (cached !== undefined) return cached;
		const parent = spec.parent ? byId.get(spec.parent) : undefined;
		const value = (spec.visible?.(state.settings, state.context) ?? true) && (!parent || depth > 16 || relevant(parent, depth + 1));
		relevantCache.set(spec.id, value);
		return value;
	};

	const rows = new Map<string, boolean>();
	const groups = new Map<string, GroupView>();
	const searching = normalise(state.query).trim().length > 0;
	let matches = 0;

	for (const spec of specs) rows.set(spec.id, false);
	for (const spec of specs) {
		if (!spec.group) continue;
		const key = groupKey(spec.section, spec.group);
		const g = groups.get(key) ?? { visible: false, open: groupOpen(spec.section, spec.group, state), count: 0 };
		if (relevant(spec)) g.count++;
		groups.set(key, g);
	}
	for (const g of groups.values()) g.visible = !searching && g.count > 0;

	for (const spec of specs) {
		if (searching) {
			if (!matchesQuery(spec, state.query)) continue;
			let shown: SettingSpec | undefined = spec;
			while (shown && !relevant(shown)) shown = shown.parent ? byId.get(shown.parent) : undefined;
			if (shown && !rows.get(shown.id)) {
				rows.set(shown.id, true);
				matches++;
			}
		} else if (relevant(spec)) {
			rows.set(spec.id, !spec.group || (groups.get(groupKey(spec.section, spec.group))?.open ?? false));
		}
	}

	const sections = new Map<SectionId, boolean>();
	for (const id of SECTION_IDS) sections.set(id, false);
	for (const spec of specs) {
		if (rows.get(spec.id) || (spec.group && groups.get(groupKey(spec.section, spec.group))?.visible)) sections.set(spec.section, true);
	}
	return { rows, groups, sections, matches };
}
