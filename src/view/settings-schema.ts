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
import { DIM_MAX, DIM_MIN, DIM_STEP } from "./reading-settings";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../settings";

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
	{ id: "timetable", section: "study", title: "settings.timetable", open: (_s, ctx) => ctx.timetableInUse },
	{ id: "zettel", section: "study", title: "settings.zettel", open: (s) => s.zettelSlipBoxes.length > 0 },
];

/** Runs of the action rows; the tab maps each id to what it does. */
export type SettingActionId = "pen-test" | "benchmark" | "companion-update-all" | "sync-check" | "timetable-edit" | "gesture-sheet" | "gesture-custom";
/** Rows drawn by the tab itself (no stored setting of their own). */
export type SettingCustomId = "device-name" | "pen-key";

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
	{ id: "stabilization", section: "writing", order: 40, name: "settings.stabilization", desc: "settings.stabilization.filter.desc", control: { type: "slider", min: 0, max: 10, step: 1 } },
	{ id: "inkFollowsObjects", section: "writing", order: 50, name: "settings.inkFollows", desc: "settings.inkFollows.desc", control: { type: "toggle" } },
	{ id: "autoLineBreak", section: "writing", order: 60, name: "settings.autoLineBreak", desc: "settings.autoLineBreak.desc", control: { type: "toggle" } },
	{ id: "eraseAreaElements", section: "writing", group: ADVANCED, order: 10, name: "settings.eraseAreaElements", desc: "settings.eraseAreaElements.desc", control: { type: "toggle" } },
	{ id: "dateStampFormat", section: "writing", group: ADVANCED, order: 20, name: "settings.dateStamp", desc: "settings.dateStamp.desc", control: { type: "text", placeholder: DEFAULT_SETTINGS.dateStampFormat } },
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
	{ id: "autoNextPage", section: "pages", order: 30, name: "settings.autoNextPage", desc: "settings.autoNextPage.desc", control: { type: "toggle" } },
	{ id: "autoScrollWriting", section: "pages", order: 40, name: "settings.autoScroll", desc: "settings.autoScroll.desc", control: { type: "toggle" } },
	{ id: "pageTurnerKeys", section: "pages", order: 50, name: "settings.pageTurnerKeys", desc: "settings.pageTurnerKeys.desc", control: { type: "toggle" }, keywords: "keyboard tastiera clicker" },
];

const READING: SettingSpec[] = [
	{ id: "snapHighlighter", section: "reading", order: 10, name: "settings.snapHighlighter", desc: "settings.snapHighlighter.desc", control: { type: "toggle" } },
	{ id: "dimBackground", section: "reading", order: 20, name: "settings.dimBackground", desc: "settings.dimBackground.desc", control: { type: "toggle" } },
	{
		id: "dimStrength", section: "reading", order: 21, name: "settings.dimStrength",
		control: { type: "slider", min: DIM_MIN, max: DIM_MAX, step: DIM_STEP, format: (v) => `${Math.round(v * 100)} %` }, parent: "dimBackground", visible: (s) => s.dimBackground,
	},
	{ id: "cropMargins", section: "reading", order: 30, name: "settings.cropMargins", desc: "settings.cropMargins.desc", control: { type: "toggle" } },
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
	{ id: "looseSheetPath", section: "library", group: ADVANCED, order: 10, name: "settings.looseSheet", desc: "settings.looseSheet.desc", control: { type: "text", placeholder: defaultLooseSheetPath(DEFAULT_SETTINGS.folder) } },
	{ id: "templatesFolder", section: "library", group: ADVANCED, order: 20, name: "settings.templatesFolder", desc: "settings.templatesFolder.desc", control: { type: "folder", placeholder: "_templates" } },
];

const SYNC: SettingSpec[] = [
	{ id: "deviceName", section: "sync", order: 10, name: "settings.deviceName", desc: "settings.deviceName.desc", control: { type: "custom", render: "device-name" }, visible: (_s, ctx) => ctx.sync },
	{ id: "syncCheck", section: "sync", order: 20, name: "settings.syncCheck", desc: "settings.syncCheck.desc", control: { type: "action", run: "sync-check", button: "sync.check.button" }, visible: (_s, ctx) => ctx.sync },
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
	{
		id: "companionUpdateAll", section: "integration", order: 24, name: "settings.companionUpdateAll", desc: "settings.companionUpdateAll.desc",
		control: { type: "action", run: "companion-update-all", button: "settings.companionUpdateAll.button" }, parent: "companionNotes", visible: companionOn,
	},
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
	{ id: "nightMode", section: "appearance", order: 40, name: "settings.nightMode", desc: "settings.nightMode.desc", control: { type: "toggle" }, keywords: "dark scuro" },
];

const DIAGNOSTICS: SettingSpec[] = [
	{ id: "penTest", section: "diagnostics", order: 10, name: "settings.penTest", desc: "settings.penTest.desc", control: { type: "action", run: "pen-test", button: "settings.open" } },
	{ id: "benchmark", section: "diagnostics", order: 20, name: "command.benchmark", desc: "settings.benchmark.desc", control: { type: "action", run: "benchmark", button: "settings.open" } },
	{ id: "perfOverlay", section: "diagnostics", order: 30, name: "settings.perfOverlay", desc: "settings.perfOverlay.desc", control: { type: "toggle" } },
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
	penButtonSeen: "set by the app when the device first delivers a side-button signal",
	lastNotebookPath: "instant start: the last notebook",
	lastNotebookPage: "instant start: the last page",
	lastNotebookPos: "instant start: zoom and scroll of the last page",
	zettelSlipBoxes: "edited from the notebook menu (Zettelkasten slip boxes)",
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
