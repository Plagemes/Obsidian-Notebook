import type { PressureMode } from "./ink/pressure";
import { DEFAULT_ERASER_SIZE, DEFAULT_FAVOURITES, normaliseEraserSize, normaliseFavourites, type FavouritePen } from "./view/favourites";
import { cleanStampFormat, DEFAULT_STAMP_FORMAT } from "./ink/date-stamp";
import { EDGE_WIDTH_MAX, EDGE_WIDTH_MIN } from "./ink/edge-zones";
import { DEFAULT_GESTURE_SETTINGS, readGestureSettings, type GestureSettings } from "./ink/gesture-settings";
import { DEFAULT_PEN_GESTURE_SETTINGS, readPenGestureSettings, type PenGestureSettings } from "./ink/gestures/settings";
import { PEN_BUTTON_ACTIONS, type PenButtonAction } from "./ink/input-policy";
import { BUTTON_AFTER_MAX_MS, BUTTON_BEFORE_MAX_MS, DEFAULT_BUTTON_WINDOWS, LEGACY_BEFORE_MS, cleanPenKey, cleanWindowMs, isPenKeyAction, type PenKeyAction } from "./ink/pen-hover";
import { isScrollMode, type ScrollMode } from "./ink/page-mode";
import { parsePosition, type SavedPosition } from "./ink/view-position";
import { normaliseRecentColours } from "./ink/colour";
import { PAGE_SIZES, PAPER_KINDS, type PageSizeName, type PaperKind } from "./model/types";
import { DEFAULT_COMPANION_SETTINGS, readCompanionSettings, type CompanionSettings } from "./storage/companion-path";
import { DEFAULT_TRASH_SETTINGS, readTrashSettings, type TrashSettings } from "./storage/trash-settings";
import { DEFAULT_ZETTEL_SETTINGS, readZettelSettings, type ZettelSettings } from "./zettel/settings";
import { DEFAULT_TOOLBAR_SIZE, isToolbarSize, type ToolbarSize } from "./ui/toolbar-size";
import { isUiLanguage, type UiLanguage } from "./i18n/languages";
import { DEFAULT_READING_SETTINGS, readReadingSettings, type ReadingSettings } from "./view/reading-settings";

/** Companion note settings (O1) are in storage/companion-path.ts, Zettelkasten settings in zettel/settings.ts, PDF reading settings in view/reading-settings.ts. */
/** DESIGN.md §2.2: *Notebook* (its own tokens, the default) or *Follow Obsidian theme*. */
export const APPEARANCE_STYLES = ["notebook", "obsidian"] as const;
export type AppearanceStyle = (typeof APPEARANCE_STYLES)[number];

export interface NotebookSettings extends CompanionSettings, GestureSettings, PenGestureSettings, TrashSettings, ZettelSettings, ReadingSettings {
	/** UI language: "auto" follows Obsidian. */
	uiLanguage: UiLanguage;
	folder: string;
	fingerDrawing: boolean;
	palmRejectionMs: number;
	pressureMode: PressureMode;
	/**
	 * Draw the browser's predicted pen samples at the tip of the wet ink (never stored). Replaces the
	 * old `prediction` key (default on), so the new default (off) applies to everyone.
	 */
	inkPrediction: boolean;
	/**
	 * Experimental low-latency ink: the pen's wet canvas asks for a `desynchronized` context and
	 * `pointerrawupdate` is listened to. Off by default: on some Android GPUs a desynchronized canvas
	 * is composited as an opaque layer. Ink is painted in the input handler either way.
	 */
	lowLatencyInk: boolean;
	/** 0–10: strength of the adaptive position filter (one-euro.ts); 0 turns it off. */
	stabilization: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx: number;
	perfOverlay: boolean;
	/** Defaults for new notebooks; the "New notebook" dialog remembers the last choice. */
	defaultPaper: PaperKind;
	defaultPageSize: PageSizeName;
	defaultLandscape: boolean;
	/** Version history: at most one snapshot per notebook per this many hours; 0 turns snapshots off. */
	snapshotIntervalHours: number;
	/** Version history: how many snapshots to keep per notebook. */
	snapshotsToKeep: number;
	/** Writing near the bottom of the last page appends a page (same size and paper). Not for infinite pages. */
	autoNextPage: boolean;
	/** The eraser's Area mode also removes the text boxes and images inside the outline. */
	eraseAreaElements: boolean;
	/** Favourite pens (six slots: tool, colour, width). */
	favouritePens: FavouritePen[];
	/** Eraser radius, CSS px. */
	eraserSize: number;
	/** Vault path of the loose sheet (quick notes) notebook; empty = `<notebooks folder>/Quick notes.notebook`. */
	looseSheetPath: string;
	// wave p1a: input
	/** Edge rejection: touches that start within `edgeRejectionPx` of a selected edge of the page area are ignored. */
	edgeRejection: boolean;
	edgeRejectionPx: number;
	edgeLeft: boolean;
	edgeRight: boolean;
	edgeTop: boolean;
	edgeBottom: boolean;
	/**
	 * What the pen's side button does. Default: a click opens the radial menu, the button held while the nib
	 * touches erases. (Replaces the 0.5 key `penButtonAction`, whose saved default "radial" must not stick.)
	 */
	penSideButton: PenButtonAction;
	/**
	 * Fallback for pens whose button never reaches the app: holding the nib still opens the radial menu. `null` =
	 * never chosen: it is on only while `penButtonSeen` is false. An explicit true / false always wins.
	 */
	penHoldStill: boolean | null;
	/** The device has delivered a side-button signal at least once (set by the app, not shown in the settings tab). */
	penButtonSeen: boolean;
	/**
	 * A pen press with pressure exactly 0, after the pen was hovering, is the side button (what Samsung / Chromium
	 * report). Turn off for a device that reports pressure 0 on real contact.
	 */
	penZeroPressureButton: boolean;
	/**
	 * Side button pressed while the nib touches (a pen move with `button 0`, not confirmed on every device): ends the
	 * stroke without discarding it and switches to the side button's tool. Turn off if ordinary writing misfires.
	 */
	penChordButton: boolean;
	/** A finger held still on the page opens the radial menu beside it (only while finger drawing is off). */
	fingerLongPress: boolean;
	/**
	 * 0.11.2: a click of the side button while the pen hovers arms the eraser for the next pen stroke instead of opening
	 * the radial menu ("Button click: next stroke erases"). Off by default.
	 */
	penButtonEraserNext: boolean;
	/** 0.11.2: a key that stands in for the side button (S Pen mapped with Key Mapper + Shizuku): '' = off, else `KeyboardEvent.key`. */
	penButtonKey: string;
	/** 0.11.2: what the pen key does: the radial menu, or arm the eraser for the next stroke. */
	penButtonKeyAction: PenKeyAction;
	/**
	 * 0.11.2: the side button seen only as a `contextmenu` (device finding). One at most this many ms before the pen's
	 * pointerdown, or after it, means the button was held when the nib landed: that contact erases.
	 */
	penButtonContactBeforeMs: number;
	penButtonContactAfterMs: number;
	/** Instant start: the notebook and page (1-based) the reader was on last, for "Continue last notebook". Not shown in the settings tab. */
	lastNotebookPath: string;
	lastNotebookPage: number;
	// wave 0.6: navigation
	/** Continuous vertical scrolling, or one page at a time with a sideways swipe (#14). */
	scrollMode: ScrollMode;
	/** Zoom and scroll position on `lastNotebookPage` (O16), for "Continue last notebook". Not shown in the settings tab. */
	lastNotebookPos: SavedPosition | null;
	// wave 0.6: timetable
	/** Offer to open the current class's notebook at a new lecture page when the app or the library is opened during a class. */
	timetableOffer: boolean;
	/** Open it without asking (only when `timetableOffer` is on). */
	timetableAutoOpen: boolean;
	/** A class counts as in progress this many minutes before it starts. */
	timetableLeadMinutes: number;
	// wave 0.6: objects
	/** Ink written over an image or a text box moves, scales and rotates with it (geometric attachment, nothing stored). */
	inkFollowsObjects: boolean;
	// wave 0.9: obsidian and input
	/** Size of the toolbar, the contextual bar and the radial menu (370). */
	toolbarSize: ToolbarSize;
	/** Keyboard arrows, PageUp / PageDown, space and Bluetooth clickers turn pages (372). */
	pageTurnerKeys: boolean;
	// wave 0.10: tabs and lines
	/** A strip listing the open notebooks (363). Off by default. */
	notebookTabs: boolean;
	/** After the pen lifts near the right margin of ruled or grid paper, the view moves to the start of the next line (353). Off by default. */
	autoLineBreak: boolean;
	// wave 0.10: clipboard and stamps
	/** Format of the quick date and time stamp (356): tokens YYYY MM DD HH mm ss and so on, text in [brackets]. */
	dateStampFormat: string;
	// wave 0.10: colours
	/** The last custom colours chosen with the colour picker or the eyedropper (newest first, `#rrggbb`). */
	recentColours: string[];
	/** wave 0.10 (50): the draggable thumb with a page preview along the right edge in continuous scroll. */
	fastScrollbar: boolean;
	/** Look of the plugin's own surfaces (DESIGN.md §2.2): its own `--nb-*` palette, or those tokens mapped onto the Obsidian theme. */
	appearanceStyle: AppearanceStyle;
}

export const DEFAULT_SETTINGS: NotebookSettings = {
	uiLanguage: "auto",
	folder: "Notebooks",
	fingerDrawing: false,
	palmRejectionMs: 500,
	pressureMode: "auto",
	inkPrediction: false,
	lowLatencyInk: false,
	stabilization: 2,
	palmContactPx: 0,
	perfOverlay: false,
	defaultPaper: "grid",
	defaultPageSize: "a4",
	defaultLandscape: false,
	snapshotIntervalHours: 24,
	snapshotsToKeep: 10,
	autoNextPage: true,
	eraseAreaElements: false,
	favouritePens: DEFAULT_FAVOURITES.map((f) => ({ ...f })),
	eraserSize: DEFAULT_ERASER_SIZE,
	looseSheetPath: "",
	edgeRejection: false,
	edgeRejectionPx: 24,
	edgeLeft: true,
	edgeRight: true,
	edgeTop: false,
	edgeBottom: true,
	penSideButton: "radial-eraser",
	penHoldStill: null,
	penButtonSeen: false,
	fingerLongPress: true,
	penButtonEraserNext: false,
	penButtonKey: "",
	penButtonKeyAction: "eraser-next",
	penButtonContactBeforeMs: DEFAULT_BUTTON_WINDOWS.beforeMs,
	penButtonContactAfterMs: DEFAULT_BUTTON_WINDOWS.afterMs,
	penZeroPressureButton: true,
	penChordButton: true,
	lastNotebookPath: "",
	lastNotebookPage: 1,
	scrollMode: "continuous",
	lastNotebookPos: null,
	timetableOffer: true,
	timetableAutoOpen: false,
	timetableLeadMinutes: 5,
	inkFollowsObjects: true,
	toolbarSize: DEFAULT_TOOLBAR_SIZE,
	pageTurnerKeys: true,
	notebookTabs: false,
	autoLineBreak: false,
	dateStampFormat: DEFAULT_STAMP_FORMAT,
	recentColours: [],
	fastScrollbar: true,
	appearanceStyle: "notebook",
	...DEFAULT_COMPANION_SETTINGS,
	...DEFAULT_GESTURE_SETTINGS,
	...DEFAULT_PEN_GESTURE_SETTINGS,
	penGesturesOff: [],
	penGesturesCustom: [],
	...DEFAULT_TRASH_SETTINGS,
	...DEFAULT_ZETTEL_SETTINGS,
	zettelSlipBoxes: [],
	...DEFAULT_READING_SETTINGS,
};

/** Merges saved data over the defaults, ignoring values of the wrong type. */
export function readSettings(data: unknown): NotebookSettings {
	const s = { ...DEFAULT_SETTINGS };
	if (typeof data !== "object" || data === null) return s;
	const d = data as Record<string, unknown>;
	if (isUiLanguage(d.uiLanguage)) s.uiLanguage = d.uiLanguage;
	if (typeof d.folder === "string" && d.folder.trim()) s.folder = d.folder.trim();
	if (typeof d.fingerDrawing === "boolean") s.fingerDrawing = d.fingerDrawing;
	if (typeof d.palmRejectionMs === "number" && d.palmRejectionMs >= 0 && d.palmRejectionMs <= 5000) s.palmRejectionMs = d.palmRejectionMs;
	if (d.pressureMode === "auto" || d.pressureMode === "simulated") s.pressureMode = d.pressureMode;
	if (typeof d.inkPrediction === "boolean") s.inkPrediction = d.inkPrediction;
	if (typeof d.lowLatencyInk === "boolean") s.lowLatencyInk = d.lowLatencyInk;
	if (typeof d.stabilization === "number" && d.stabilization >= 0 && d.stabilization <= 10) s.stabilization = d.stabilization;
	if (typeof d.palmContactPx === "number" && d.palmContactPx >= 0 && d.palmContactPx <= 200) s.palmContactPx = d.palmContactPx;
	if (typeof d.perfOverlay === "boolean") s.perfOverlay = d.perfOverlay;
	if (PAPER_KINDS.includes(d.defaultPaper as PaperKind)) s.defaultPaper = d.defaultPaper as PaperKind;
	if (typeof d.defaultPageSize === "string" && Object.prototype.hasOwnProperty.call(PAGE_SIZES, d.defaultPageSize)) s.defaultPageSize = d.defaultPageSize as PageSizeName;
	if (typeof d.defaultLandscape === "boolean") s.defaultLandscape = d.defaultLandscape;
	if (typeof d.snapshotIntervalHours === "number" && d.snapshotIntervalHours >= 0 && d.snapshotIntervalHours <= 720) s.snapshotIntervalHours = d.snapshotIntervalHours;
	if (typeof d.snapshotsToKeep === "number" && Number.isInteger(d.snapshotsToKeep) && d.snapshotsToKeep >= 1 && d.snapshotsToKeep <= 100) s.snapshotsToKeep = d.snapshotsToKeep;
	if (typeof d.autoNextPage === "boolean") s.autoNextPage = d.autoNextPage;
	if (typeof d.eraseAreaElements === "boolean") s.eraseAreaElements = d.eraseAreaElements;
	s.favouritePens = normaliseFavourites(d.favouritePens);
	s.eraserSize = normaliseEraserSize(d.eraserSize);
	if (typeof d.looseSheetPath === "string") s.looseSheetPath = d.looseSheetPath.trim();
	if (typeof d.edgeRejection === "boolean") s.edgeRejection = d.edgeRejection;
	if (typeof d.edgeRejectionPx === "number" && d.edgeRejectionPx >= EDGE_WIDTH_MIN && d.edgeRejectionPx <= EDGE_WIDTH_MAX) s.edgeRejectionPx = d.edgeRejectionPx;
	if (typeof d.edgeLeft === "boolean") s.edgeLeft = d.edgeLeft;
	if (typeof d.edgeRight === "boolean") s.edgeRight = d.edgeRight;
	if (typeof d.edgeTop === "boolean") s.edgeTop = d.edgeTop;
	if (typeof d.edgeBottom === "boolean") s.edgeBottom = d.edgeBottom;
	if (PEN_BUTTON_ACTIONS.includes(d.penSideButton as PenButtonAction)) s.penSideButton = d.penSideButton as PenButtonAction;
	// The old key: 0.5.x saved every setting, so its "radial" is only the old default and is not carried over; an
	// explicit "eraser", "lasso", "off" (and wave 0.6's "lastTool", now "previous") is kept.
	else if (d.penButtonAction === "eraser" || d.penButtonAction === "lasso" || d.penButtonAction === "off") s.penSideButton = d.penButtonAction;
	else if (d.penButtonAction === "lastTool") s.penSideButton = "previous";
	// 0.5.1 saved `penLongPress: false` for everyone (its default), so only an explicit true is carried over.
	if (typeof d.penHoldStill === "boolean") s.penHoldStill = d.penHoldStill;
	else if (d.penLongPress === true) s.penHoldStill = true;
	if (typeof d.penButtonSeen === "boolean") s.penButtonSeen = d.penButtonSeen;
	if (typeof d.fingerLongPress === "boolean") s.fingerLongPress = d.fingerLongPress;
	if (typeof d.penButtonEraserNext === "boolean") s.penButtonEraserNext = d.penButtonEraserNext;
	const penKey = cleanPenKey(d.penButtonKey);
	if (penKey !== null) s.penButtonKey = penKey;
	if (isPenKeyAction(d.penButtonKeyAction)) s.penButtonKeyAction = d.penButtonKeyAction;
	s.penButtonContactBeforeMs = cleanWindowMs(d.penButtonContactBeforeMs, BUTTON_BEFORE_MAX_MS) ?? s.penButtonContactBeforeMs;
	// 0.5.x-0.12.3 saved every setting: their default of 150 ms is not a choice (see LEGACY_BEFORE_MS).
	if (s.penButtonContactBeforeMs === LEGACY_BEFORE_MS) s.penButtonContactBeforeMs = DEFAULT_BUTTON_WINDOWS.beforeMs;
	s.penButtonContactAfterMs = cleanWindowMs(d.penButtonContactAfterMs, BUTTON_AFTER_MAX_MS) ?? s.penButtonContactAfterMs;
	if (typeof d.penZeroPressureButton === "boolean") s.penZeroPressureButton = d.penZeroPressureButton;
	if (typeof d.penChordButton === "boolean") s.penChordButton = d.penChordButton;
	if (typeof d.lastNotebookPath === "string") s.lastNotebookPath = d.lastNotebookPath;
	if (typeof d.lastNotebookPage === "number" && Number.isInteger(d.lastNotebookPage) && d.lastNotebookPage >= 1) s.lastNotebookPage = d.lastNotebookPage;
	if (isScrollMode(d.scrollMode)) s.scrollMode = d.scrollMode;
	if (isToolbarSize(d.toolbarSize)) s.toolbarSize = d.toolbarSize;
	if (typeof d.pageTurnerKeys === "boolean") s.pageTurnerKeys = d.pageTurnerKeys;
	if (typeof d.notebookTabs === "boolean") s.notebookTabs = d.notebookTabs;
	if (typeof d.autoLineBreak === "boolean") s.autoLineBreak = d.autoLineBreak;
	if (typeof d.dateStampFormat === "string") s.dateStampFormat = cleanStampFormat(d.dateStampFormat);
	s.recentColours = normaliseRecentColours(d.recentColours);
	if (typeof d.fastScrollbar === "boolean") s.fastScrollbar = d.fastScrollbar;
	if (APPEARANCE_STYLES.includes(d.appearanceStyle as AppearanceStyle)) s.appearanceStyle = d.appearanceStyle as AppearanceStyle;
	s.lastNotebookPos = parsePosition(d.lastNotebookPos);

	if (typeof d.timetableOffer === "boolean") s.timetableOffer = d.timetableOffer;
	if (typeof d.timetableAutoOpen === "boolean") s.timetableAutoOpen = d.timetableAutoOpen;
	if (typeof d.timetableLeadMinutes === "number" && Number.isInteger(d.timetableLeadMinutes) && d.timetableLeadMinutes >= 0 && d.timetableLeadMinutes <= 30) s.timetableLeadMinutes = d.timetableLeadMinutes;
	Object.assign(s, readCompanionSettings(d), readGestureSettings(d), readPenGestureSettings(d));
	Object.assign(s, readTrashSettings(d));
	if (typeof d.inkFollowsObjects === "boolean") s.inkFollowsObjects = d.inkFollowsObjects;
	Object.assign(s, readZettelSettings(d));
	Object.assign(s, readReadingSettings(d));
	return s;
}

export function backupFolder(settings: NotebookSettings): string {
	return `${settings.folder.replace(/\/+$/, "")}/_backup`;
}
