import type { PressureMode } from "./ink/pressure";
import { defaultPenSets, MAX_FOLDER_ASSIGNMENTS, MAX_NOTEBOOK_ASSIGNMENTS, normaliseAssignments, normalisePenSets, type PenSet } from "./view/pen-sets";
import { normaliseActive, normaliseProfiles, type WritingProfile } from "./view/writing-profiles";
import { normaliseActivePreset, normalisePresets, type WorkspacePreset } from "./view/workspace-presets";
import { isToleranceName, parseLegend, type Meaning, type ToleranceName } from "./model/colour-meaning";
import { DEFAULT_ERASER_SIZE, DEFAULT_FAVOURITES, normaliseEraserSize, normaliseFavourites, type FavouritePen } from "./view/favourites";
import { cleanStampFormat, DEFAULT_STAMP_FORMAT } from "./ink/date-stamp";
import { cleanSignDateCustom, DEFAULT_SIGN_DATE_CUSTOM, DEFAULT_SIGN_DATE_MODE, isSignDateMode, type SignDateMode } from "./ink/signature";
import { EDGE_WIDTH_MAX, EDGE_WIDTH_MIN } from "./ink/edge-zones";
import { DEFAULT_GESTURE_SETTINGS, readGestureSettings, type GestureSettings } from "./ink/gesture-settings";
import { DEFAULT_PEN_GESTURE_SETTINGS, readPenGestureSettings, type PenGestureSettings } from "./ink/gestures/settings";
import { clampInsertWidth, INSERT_WIDTH_DEFAULT, isInsertBackground } from "./model/note-insert";
import { clampLookUpWidth, LOOKUP_WIDTH_DEFAULT } from "./model/look-up";
import { clampWelcomeHours, WELCOME_HOURS_DEFAULT } from "./model/welcome-back";
import { PEN_BUTTON_ACTIONS, type PenButtonAction } from "./ink/input-policy";
import { BUTTON_AFTER_MAX_MS, BUTTON_BEFORE_MAX_MS, DEFAULT_BUTTON_WINDOWS, LEGACY_BEFORE_MS, cleanPenKey, cleanWindowMs, isPenKeyAction, type PenKeyAction } from "./ink/pen-hover";
import { isHeaderAlign, isHeaderMode, type HeaderAlign, type HeaderMode } from "./ink/page-header";
import { isScrollMode, type ScrollMode } from "./ink/page-mode";
import { isMinimapMode, type MinimapMode } from "./model/minimap-geometry";
import { parsePosition, type SavedPosition } from "./ink/view-position";
import { normaliseRecentColours } from "./ink/colour";
import { PAGE_SIZES, PAPER_KINDS, type PageSizeName, type PaperKind } from "./model/types";
import { DEFAULT_COMPANION_SETTINGS, readCompanionSettings, type CompanionSettings } from "./storage/companion-path";
import { DEFAULT_TRASH_SETTINGS, readTrashSettings, type TrashSettings } from "./storage/trash-settings";
import { DEFAULT_LECTURE_SETTINGS, readLectureSettings, type LectureSettings } from "./timetable/lecture-mode";
import { DEFAULT_ZETTEL_SETTINGS, readZettelSettings, type ZettelSettings } from "./zettel/settings";
import { DEFAULT_TOOLBAR_SIZE, isToolbarSize, type ToolbarSize } from "./ui/toolbar-size";
import { DEFAULT_INPUT_PREF, isInputPref, type InputPref } from "./ui/input-layout";
import { cleanFadeSeconds, DEFAULT_TOOL_FADE_MODE, DEFAULT_TOOL_FADE_SECONDS, isToolFadeMode, type ToolFadeMode } from "./ui/tool-fade";
import { MAX_PINNED, normalisePinned } from "./ui/adapt";
import { macroActionId, readMacros, withoutMissingMacros, type Macro } from "./ui/macros";
import { isUiLanguage, type UiLanguage } from "./i18n/languages";
import { cleanUserName } from "./library/greeting";
import { normaliseSeen, type HintId } from "./ui/hint-logic";
import { DEFAULT_READING_SETTINGS, readReadingSettings, type ReadingSettings } from "./view/reading-settings";
import { DEFAULT_PRESENT_SETTINGS, readPresentSettings, type PresentSettings } from "./view/present-logic";
import { DEFAULT_BOARD_SETTINGS, readBoardSettings, type BoardSettings } from "./library/board-logic";
import { DEFAULT_SNAP_SETTINGS, readSnapSettings, type SnapSettings } from "./view/snap-settings";
import { DEFAULT_GHOST_SETTINGS, readGhostSettings, type GhostSettings } from "./view/ghost-settings";
import { DEFAULT_PDF_COPY_SETTINGS, readPdfCopySettings, type PdfCopySettings } from "./storage/pdf-copy-logic";
import { backupFolderConflict, DEFAULT_BACKUP_FOLDER, DEFAULT_BACKUP_SETTINGS, readBackupSettings, type BackupSettings } from "./storage/backup-logic";
import { DEFAULT_CLOUD_SYNC_SETTINGS, readCloudSyncSettings, type CloudSyncSettings } from "./sync/settings";
import { isPlannerWeekStart, type PlannerWeekStart } from "./model/calendar";
import { normalizeIndexPrefix } from "./model/book-index";
import { clampSymbolCount } from "./ui/symbol-rank";
import { isClipBackground, type ClipBackground } from "./ink/clip-image";
import { isPenKind, normaliseNib, type PenKind } from "./ink/pen-kinds";

/** Companion note settings (O1) are in storage/companion-path.ts, Zettelkasten settings in zettel/settings.ts, PDF reading settings in view/reading-settings.ts. */
/** DESIGN.md §2.2: *Notebook* (its own tokens, the default) or *Follow Obsidian theme*. */
export const APPEARANCE_STYLES = ["notebook", "obsidian"] as const;
export type AppearanceStyle = (typeof APPEARANCE_STYLES)[number];

export interface NotebookSettings extends CompanionSettings, GestureSettings, PenGestureSettings, TrashSettings, ZettelSettings, ReadingSettings, LectureSettings, BoardSettings, PresentSettings, SnapSettings, GhostSettings, PdfCopySettings, BackupSettings, CloudSyncSettings {
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
	/** 0.26 (#350): new strokes look the chosen width on screen at any zoom (stored width = chosen / zoom). Off = the width is in page units. */
	penWidthFollowsZoom: boolean;
	/** 0–10: strength of the adaptive position filter (one-euro.ts); 0 turns it off. */
	stabilization: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx: number;
	perfOverlay: boolean;
	/** Defaults for new notebooks; the "New notebook" dialog remembers the last choice. */
	defaultPaper: PaperKind;
	defaultPageSize: PageSizeName;
	defaultLandscape: boolean;
	/** 0.20 planner: the first day of the week of a generated planner ("auto" follows the device language). */
	plannerWeekStart: PlannerWeekStart;
	/** 0.27 plannertasks (#266): a chip on daily and weekly planner pages lists the vault's tasks due on those days. */
	plannerTasks: boolean;
	/** Version history: at most one snapshot per notebook per this many hours; 0 turns snapshots off. */
	snapshotIntervalHours: number;
	/** Version history: how many snapshots to keep per notebook. */
	snapshotsToKeep: number;
	/** 0.19: a named snapshot when a lecture ends (only if the notebook changed). */
	lectureSnapshots: boolean;
	/** 0.19: automatic lecture snapshots to keep per notebook (other snapshots are never pruned by this). */
	lectureSnapshotsKeep: number;
	/** Writing near the bottom of the last page appends a page (same size and paper). Not for infinite pages. */
	autoNextPage: boolean;
	/** The eraser's Area mode also removes the text boxes and images inside the outline. */
	eraseAreaElements: boolean;
	/** 0.13: what the generated outline lists (bookmarks, PDF slide changes, large handwriting, markers). */
	outlineBookmarks: boolean;
	outlineSlides: boolean;
	outlineHeadings: boolean;
	outlineMarkers: boolean;
	/** 0.16 (#46): the outline of a PDF in the notebook outline: mixed into the list (merged), its own section, or not listed. */
	outlinePdf: "merged" | "section" | "off";
	/** 0.16 (#46): a tap on a link of a PDF page follows it (another page of the notebook, or a web address after a question). */
	pdfLinks: boolean;
	/** Favourite pens (six slots: tool, colour, width). */
	favouritePens: FavouritePen[];
	/** 0.15 pen sets: named lists of pens per subject (starter sets Maths, Languages, Science; all editable). */
	penSets: PenSet[];
	/** 0.15 pen sets: folder path -> set id (a notebook uses its nearest folder's set). Bounded. */
	penSetFolders: Record<string, string>;
	/** 0.15 pen sets: notebook document id -> set id (wins over the folder). Bounded. */
	penSetNotebooks: Record<string, string>;
	/** 0.25 profiles (#219): the user's own writing profiles (Lecture and Study are built in). Bounded. */
	writingProfiles: WritingProfile[];
	/** 0.25 profiles: the id of the profile last switched to ("" none, "lecture", "study" or a custom id). */
	writingProfileActive: string;
	/** 0.25 profiles: starting lecture mode switches to the Lecture profile. */
	writingProfileOnLecture: boolean;
	/** 0.27 workspaces (#375): the user's own workspace presets (Lecture, Study and Focus are built in). Bounded. */
	workspacePresets: WorkspacePreset[];
	/** 0.27 workspaces: the id of the preset last applied ("" none). */
	workspacePresetActive: string;
	/** 0.27 workspaces: starting lecture mode applies the Lecture workspace. */
	workspaceOnLecture: boolean;
	/** Eraser radius, CSS px. */
	eraserSize: number;
	/** Vault path of the loose sheet (quick notes) notebook; empty = `<notebooks folder>/Quick notes.notebook`. */
	looseSheetPath: string;
	/** 0.15 (O12): vault path of the daily notebook ("Today's page"); empty = `<notebooks folder>/Daily.notebook`. */
	dailyNotebookPath: string;
	/** 0.16 (#177): show PDFs and images shared to Obsidian from other apps (Home's shared-files card and the library rail). */
	sharedInbox: boolean;
	/** 0.16 (#177): folder watched for shared files; empty = Obsidian's attachments folder. */
	sharedInboxFolder: string;
	/** 0.15 (O12): "Today's page" also adds a link to the page in today's daily note (Daily notes or Periodic Notes). */
	dailyLink: boolean;
	/** 0.15 (O12): create today's daily note when it does not exist yet (only used with `dailyLink`). */
	dailyCreateNote: boolean;
	/** 0.19 (#221): when a lecture session ends, one line about it goes into the daily note (off by default). */
	lectureLog: boolean;
	/** 0.19 (#221): the heading that line goes under (created at the end of the note when missing). */
	lectureLogHeading: string;
	/** 0.20 refwindow (#107): the floating reference window snaps to the edges of the view when it is dropped near them. */
	refWindowSnap: boolean;
	/** 0.21 slideback (#225): a pill "Back to slide N" while scrolled away from where you last wrote during a lecture. */
	slideBack: boolean;
	/** 0.22 pagerefs (#179): a chip on a page that other pages link to. */
	pageRefs: boolean;
	/** 0.25 papersuggest (#409): the "+" strip highlights the paper the history and the course suggest, with the reason. */
	paperSuggest: boolean;
	/** 0.23 welcomeback (#420): a quiet card with the way back, the open questions and gaps when a notebook is reopened after a while. */
	welcomeBack: boolean;
	/** Hours away before the card is offered. */
	welcomeBackHours: number;
	/** 0.22 lecthead (#210): header on the page you write on (course, lecturer, room, date, time of the class): off / ask (a chip) / automatic. */
	lectureHeader: "off" | "ask" | "auto";
	lectureHeaderLecturer: boolean;
	lectureHeaderRoom: boolean;
	lectureHeaderDate: boolean;
	lectureHeaderTime: boolean;
	/** 0.17 (#57): a task made from a selection gets its due date as the Tasks plugin's date emoji (else a Dataview field). */
	taskDueEmoji: boolean;
	/** 0.17 (#57): the note "Make task" can add to besides the daily note (vault path; empty = none configured). */
	tasksNote: string;
	/** 0.19 (#103): a small square drawn with the pen: "offer" a checkbox (a chip near it), turn it into one at once ("auto"), or leave it as ink ("off"). */
	checklistDraw: "off" | "offer" | "auto";
	/** 0.22 axes (#206): an "L" or a "+" drawn with the pen: "offer" Cartesian axes (a chip), make them at once ("auto"), or leave ink ("off"); ticks and number labels. */
	axesDraw: "off" | "offer" | "auto";
	axesTicks: boolean;
	axesLabels: boolean;
	/** 0.18 (#59): "Insert into note": display width (px) of the picture, its background and whether a link back to the page follows it. */
	noteInsertWidth: number;
	noteInsertBackground: "transparent" | "paper";
	noteInsertLinkBack: boolean;
	/** 0.19 (#213): the "Look up later" note (vault path; empty = `<notebooks folder>/Look up later.md`) and the width (px) of the crop shown in it. */
	lookUpNote: string;
	lookUpWidth: number;
	/** 0.18 (#186): copying pages to another notebook also leaves a "Copied to" chip on the original page (the dialog starts with this). */
	copyLinkReverse: boolean;
	/** 0.24 (#411): suggest tags from the course, sibling notebooks, text and markers when editing tags. */
	tagSuggestions: boolean;
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
	/** The saved 150 ms of earlier versions was read as the new default once (see `LEGACY_BEFORE_MS`). */
	penButtonWindowsMigrated: boolean;
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
	// 0.14: generative interface (392, 393, 402). Each family of adaptive behaviour has its own switch; pinned slots never move.
	/** The toolbar follows the kind of page: slide, ruled, grid… (392). */
	adaptPageType: boolean;
	/** Quick slots are ranked by what is used in the notebook in view (393). */
	adaptLearn: boolean;
	/** The selection bar follows what is selected: ink, picture, text, mixed (402). */
	adaptSelection: boolean;
	// 0.25 (#399): the toolbar and floating pills fade while the pen writes and return on the first touch.
	toolFade: ToolFadeMode;
	/** Seconds of writing before the bars fade, and of rest before they return. */
	toolFadeSeconds: number;
	/** The first finger touch on a faded bar only brings it back (the button is not pressed). */
	toolFadeFirstTouch: boolean;
	/** 0.27 (#431): the layout follows the input in use (automatic) or is pinned to the pen, the finger or the mouse. */
	inputLayout: InputPref;
	/** 0.26 (#422): the Related pages panel also lists the first page of the notebooks of the note's course. */
	relatedCourse: boolean;
	/** Quick actions the person pinned to the toolbar, in order (at most 3): the ranking never moves them. */
	pinnedQuick: string[];
	/** 0.27 (#170): the person's macros (a name, an icon and a list of actions each; at most 12 of at most 20 steps). A macro pinned to the toolbar is in `pinnedQuick` as `macro-<id>`. */
	macros: Macro[];
	/** Review fix (M6): macros stored beyond the limit of this version (written by a newer one), kept as written and written back, so saving the settings here does not lose them; they move into `macros` when there is room. */
	macrosExtra: unknown[];
	/** Keyboard arrows, PageUp / PageDown, space and Bluetooth clickers turn pages (372). */
	pageTurnerKeys: boolean;
	// wave 0.10: tabs and lines
	/** A strip listing the open notebooks (363). Off by default. */
	notebookTabs: boolean;
	/** After the pen lifts near the right margin of ruled or grid paper, the view moves to the start of the next line (353). Off by default. */
	autoLineBreak: boolean;
	/** 0.23 (#314): when the pen lifts, a tiny hook at the start or the end of the line is cut off the saved stroke (ink/hook-clean.ts). Off by default. */
	trimHooks: boolean;
	// 0.15 (#75): automatic page header / footer
	// 0.16 (#90): highlights digest
	/** How the digest note of the highlights is grouped: by page or by colour. */
	digestGroup: "page" | "colour";
	/** 0.22 (#101): what each ink colour means (the global legend; a notebook may have its own in `_meta`). */
	colourMeanings: Meaning[];
	/** 0.22 (#101): how close a stroke colour must be to a legend colour. */
	meaningTolerance: ToleranceName;
	/** 0.21 (#187): the label prefix that makes a marker an index term (one word). */
	indexPrefix: string;
	// 0.18 (#86): margin comments
	/** Show the numbered markers of the comments in the page margin (a comment whose card is open is always shown). */
	commentMarkers: boolean;
	/** Add the comments to the PDF export as margin notes (a strip beside each page that has comments). */
	commentsInPdf: boolean;
	headerMode: HeaderMode;
	headerPageNumber: boolean;
	headerPageTotal: boolean;
	headerDate: boolean;
	headerTitle: boolean;
	headerAlign: HeaderAlign;
	headerInExport: boolean;
	/** 0.25 (#277): background of "Copy as image": white (apps that show transparency as black) or transparent. */
	clipImageBackground: ClipBackground;
	/** 0.21 (#217): show when a page was written (its start and end time) in the header line and on the notebook map. */
	headerPageTimes: boolean;
	// wave 0.10: clipboard and stamps
	/** 0.21 (212): the strip of recent symbols, and how many buttons it has. */
	symbolStrip: boolean;
	symbolCount: number;
	/** 0.23 dimcheck (#293): a quiet hint in the equation editor when the units of a formula do not agree. */
	dimensionHint: boolean;
	/** 0.22 (#35): the pen the pen tool starts with (ballpoint, fountain pen, brush or marker) and the nib angle (degrees) of new fountain pen and marker strokes. */
	defaultPenKind: PenKind;
	defaultNibAngle: number;
	/** Format of the quick date and time stamp (356): tokens YYYY MM DD HH mm ss and so on, text in [brackets]. */
	dateStampFormat: string;
	// 0.21 signstamp
	/** How the date of a "sign and date" stamp is written (154): the language's own form, ISO, or the custom pattern. */
	signDateMode: SignDateMode;
	signDateCustom: string;
	// wave 0.10: colours
	/** The last custom colours chosen with the colour picker or the eyedropper (newest first, `#rrggbb`). */
	recentColours: string[];
	/** wave 0.10 (50): the draggable thumb with a page preview along the right edge in continuous scroll. */
	fastScrollbar: boolean;
	/** 0.17 (#173): the minimap of the page in view: automatic (infinite pages, high zoom), always, or never. */
	minimapMode: MinimapMode;
	/** 0.27 (#49) two-page spread: the first page alone on the right, like a book (otherwise the pairs are 1-2, 3-4...). */
	spreadFirstAlone: boolean;
	/** 0.27 (#49): show the spread by itself on a landscape tablet while the scrolling is continuous. */
	spreadAuto: boolean;
	/** 0.27 (#130): when zoomed far out, headings and titles of excerpts and pictures are shown large over the pages. */
	semanticZoom: boolean;
	/** Look of the plugin's own surfaces (DESIGN.md §2.2): its own `--nb-*` palette, or those tokens mapped onto the Obsidian theme. */
	appearanceStyle: AppearanceStyle;
	// wave 0.13: Home
	/** The name Home greets you with ("Good evening, Alex"); empty = the greeting has no name. */
	userName: string;
	/** 0.13: just-in-time tips (roadmap 425): a short tip the first time a situation occurs. */
	hintsEnabled: boolean;
	/** 0.24 iconhelp (#429): a finger held on a toolbar, bar or Home icon shows what it does. */
	iconHelp: boolean;
	/** The tips already shown (ids), so each appears once. Not shown in the settings tab; "Show tips again" clears it. */
	hintsSeen: HintId[];
	// 0.14 slides
	/** #226: ink written while a PDF page is beside the notes (side by side) remembers that slide. */
	slideInkLink: boolean;
	/** #226: a small badge next to ink written beside a slide; tapping it shows the slide again. */
	slideInkBadges: boolean;
}

export const DEFAULT_SETTINGS: NotebookSettings = {
	uiLanguage: "auto",
	folder: "Notebooks",
	fingerDrawing: false,
	palmRejectionMs: 500,
	pressureMode: "auto",
	inkPrediction: false,
	lowLatencyInk: false,
	penWidthFollowsZoom: false,
	stabilization: 2,
	palmContactPx: 0,
	perfOverlay: false,
	defaultPaper: "grid",
	defaultPageSize: "a4",
	defaultLandscape: false,
	plannerWeekStart: "auto",
	plannerTasks: true, // 0.27 plannertasks
	snapshotIntervalHours: 24,
	snapshotsToKeep: 10,
	lectureSnapshots: true,
	lectureSnapshotsKeep: 20,
	autoNextPage: true,
	eraseAreaElements: false,
	outlineBookmarks: true,
	outlineSlides: true,
	outlineHeadings: true,
	outlineMarkers: true,
	outlinePdf: "merged",
	pdfLinks: true,
	favouritePens: DEFAULT_FAVOURITES.map((f) => ({ ...f })),
	penSets: defaultPenSets(),
	penSetFolders: {},
	penSetNotebooks: {},
	writingProfiles: [],
	writingProfileActive: "",
	writingProfileOnLecture: false,
	workspacePresets: [],
	workspacePresetActive: "",
	workspaceOnLecture: false,
	eraserSize: DEFAULT_ERASER_SIZE,
	looseSheetPath: "",
	dailyNotebookPath: "",
	sharedInbox: true,
	sharedInboxFolder: "",
	dailyLink: false,
	dailyCreateNote: false,
	lectureLog: false,
	lectureLogHeading: "## Lectures",
	refWindowSnap: true, // 0.20 refwindow
	slideBack: true, // 0.21 slideback
	pageRefs: true, // 0.22 pagerefs
	paperSuggest: true, // 0.25 papersuggest
	welcomeBack: true, // 0.23 welcomeback
	welcomeBackHours: WELCOME_HOURS_DEFAULT, // 0.23 welcomeback
	lectureHeader: "ask", // 0.22 lecthead
	lectureHeaderLecturer: true,
	lectureHeaderRoom: true,
	lectureHeaderDate: true,
	lectureHeaderTime: true,
	taskDueEmoji: true,
	tasksNote: "",
	checklistDraw: "offer",
	axesDraw: "offer", // 0.22 axes
	axesTicks: true,
	axesLabels: true,
	noteInsertWidth: INSERT_WIDTH_DEFAULT,
	noteInsertBackground: "transparent",
	noteInsertLinkBack: true,
	lookUpNote: "",
	lookUpWidth: LOOKUP_WIDTH_DEFAULT,
	copyLinkReverse: false,
	tagSuggestions: true,
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
	penButtonWindowsMigrated: false,
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
	adaptPageType: true,
	adaptLearn: true,
	adaptSelection: true,
	toolFade: DEFAULT_TOOL_FADE_MODE,
	toolFadeSeconds: DEFAULT_TOOL_FADE_SECONDS,
	toolFadeFirstTouch: true,
	inputLayout: DEFAULT_INPUT_PREF,
	relatedCourse: true, // 0.26 related
	pinnedQuick: [],
	macros: [],
	macrosExtra: [],
	pageTurnerKeys: true,
	notebookTabs: false,
	autoLineBreak: false,
	trimHooks: false,
	digestGroup: "page",
	colourMeanings: [],
	meaningTolerance: "normal",
	indexPrefix: "#idx",
	commentMarkers: true,
	commentsInPdf: false,
	headerMode: "off",
	headerPageNumber: true,
	headerPageTotal: true,
	headerDate: true,
	headerTitle: false,
	headerAlign: "centre",
	headerInExport: true,
	clipImageBackground: "white",
	headerPageTimes: true,
	dateStampFormat: DEFAULT_STAMP_FORMAT,
	signDateMode: DEFAULT_SIGN_DATE_MODE,
	signDateCustom: DEFAULT_SIGN_DATE_CUSTOM,
	recentColours: [],
	fastScrollbar: true,
	minimapMode: "auto",
	spreadFirstAlone: true,
	spreadAuto: false,
	semanticZoom: true,
	symbolStrip: true,
	symbolCount: 6,
	dimensionHint: true,
	defaultPenKind: "pen",
	defaultNibAngle: 45,
	appearanceStyle: "notebook",
	userName: "",
	hintsEnabled: true,
	iconHelp: true,
	hintsSeen: [],
	// 0.14 slides
	slideInkLink: true,
	slideInkBadges: true,
	...DEFAULT_COMPANION_SETTINGS,
	...DEFAULT_GESTURE_SETTINGS,
	...DEFAULT_PEN_GESTURE_SETTINGS,
	penGesturesOff: [],
	penGesturesCustom: [],
	...DEFAULT_TRASH_SETTINGS,
	...DEFAULT_ZETTEL_SETTINGS,
	...DEFAULT_LECTURE_SETTINGS,
	zettelSlipBoxes: [],
	...DEFAULT_READING_SETTINGS,
	...DEFAULT_PRESENT_SETTINGS,
	...DEFAULT_SNAP_SETTINGS,
	...DEFAULT_GHOST_SETTINGS,
	// 0.15 views
	...DEFAULT_BOARD_SETTINGS,
	boardColumns: DEFAULT_BOARD_SETTINGS.boardColumns.map((c) => ({ ...c })),
	// 0.17 pdfcopy
	...DEFAULT_PDF_COPY_SETTINGS,
	pdfCopyNotebooks: {},
	// 0.21 backups
	...DEFAULT_BACKUP_SETTINGS,
	// 0.22 synccore (#126): cloud sync, off by default
	...DEFAULT_CLOUD_SYNC_SETTINGS,
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
	if (typeof d.penWidthFollowsZoom === "boolean") s.penWidthFollowsZoom = d.penWidthFollowsZoom;
	if (typeof d.stabilization === "number" && d.stabilization >= 0 && d.stabilization <= 10) s.stabilization = d.stabilization;
	if (typeof d.palmContactPx === "number" && d.palmContactPx >= 0 && d.palmContactPx <= 200) s.palmContactPx = d.palmContactPx;
	if (typeof d.perfOverlay === "boolean") s.perfOverlay = d.perfOverlay;
	if (PAPER_KINDS.includes(d.defaultPaper as PaperKind)) s.defaultPaper = d.defaultPaper as PaperKind;
	if (typeof d.defaultPageSize === "string" && Object.prototype.hasOwnProperty.call(PAGE_SIZES, d.defaultPageSize)) s.defaultPageSize = d.defaultPageSize as PageSizeName;
	if (typeof d.defaultLandscape === "boolean") s.defaultLandscape = d.defaultLandscape;
	if (isPlannerWeekStart(d.plannerWeekStart)) s.plannerWeekStart = d.plannerWeekStart;
	if (typeof d.plannerTasks === "boolean") s.plannerTasks = d.plannerTasks; // 0.27 plannertasks
	if (typeof d.snapshotIntervalHours === "number" && d.snapshotIntervalHours >= 0 && d.snapshotIntervalHours <= 720) s.snapshotIntervalHours = d.snapshotIntervalHours;
	if (typeof d.snapshotsToKeep === "number" && Number.isInteger(d.snapshotsToKeep) && d.snapshotsToKeep >= 1 && d.snapshotsToKeep <= 100) s.snapshotsToKeep = d.snapshotsToKeep;
	if (typeof d.lectureSnapshots === "boolean") s.lectureSnapshots = d.lectureSnapshots;
	if (typeof d.lectureSnapshotsKeep === "number" && Number.isInteger(d.lectureSnapshotsKeep) && d.lectureSnapshotsKeep >= 1 && d.lectureSnapshotsKeep <= 100) s.lectureSnapshotsKeep = d.lectureSnapshotsKeep;
	if (typeof d.autoNextPage === "boolean") s.autoNextPage = d.autoNextPage;
	if (typeof d.eraseAreaElements === "boolean") s.eraseAreaElements = d.eraseAreaElements;
	if (typeof d.outlineBookmarks === "boolean") s.outlineBookmarks = d.outlineBookmarks;
	if (typeof d.outlineSlides === "boolean") s.outlineSlides = d.outlineSlides;
	if (typeof d.outlineHeadings === "boolean") s.outlineHeadings = d.outlineHeadings;
	if (typeof d.outlineMarkers === "boolean") s.outlineMarkers = d.outlineMarkers;
	if (d.outlinePdf === "merged" || d.outlinePdf === "section" || d.outlinePdf === "off") s.outlinePdf = d.outlinePdf;
	if (typeof d.pdfLinks === "boolean") s.pdfLinks = d.pdfLinks;
	s.favouritePens = normaliseFavourites(d.favouritePens);
	s.penSets = normalisePenSets(d.penSets);
	s.penSetFolders = normaliseAssignments(d.penSetFolders, MAX_FOLDER_ASSIGNMENTS);
	s.penSetNotebooks = normaliseAssignments(d.penSetNotebooks, MAX_NOTEBOOK_ASSIGNMENTS);
	s.writingProfiles = normaliseProfiles(d.writingProfiles); // 0.25 profiles
	s.writingProfileActive = normaliseActive(d.writingProfileActive, s.writingProfiles);
	if (typeof d.writingProfileOnLecture === "boolean") s.writingProfileOnLecture = d.writingProfileOnLecture;
	s.workspacePresets = normalisePresets(d.workspacePresets); // 0.27 workspaces
	s.workspacePresetActive = normaliseActivePreset(d.workspacePresetActive, s.workspacePresets);
	if (typeof d.workspaceOnLecture === "boolean") s.workspaceOnLecture = d.workspaceOnLecture;
	s.eraserSize = normaliseEraserSize(d.eraserSize);
	if (typeof d.looseSheetPath === "string") s.looseSheetPath = d.looseSheetPath.trim();
	if (typeof d.dailyNotebookPath === "string") s.dailyNotebookPath = d.dailyNotebookPath.trim();
	if (typeof d.sharedInbox === "boolean") s.sharedInbox = d.sharedInbox;
	if (typeof d.sharedInboxFolder === "string") s.sharedInboxFolder = d.sharedInboxFolder.trim();
	if (typeof d.dailyLink === "boolean") s.dailyLink = d.dailyLink;
	if (typeof d.dailyCreateNote === "boolean") s.dailyCreateNote = d.dailyCreateNote;
	if (typeof d.lectureLog === "boolean") s.lectureLog = d.lectureLog;
	if (typeof d.lectureLogHeading === "string") s.lectureLogHeading = d.lectureLogHeading.trim().slice(0, 80); // normalised where it is used (an empty one means the default)
	if (typeof d.refWindowSnap === "boolean") s.refWindowSnap = d.refWindowSnap; // 0.20 refwindow
	if (typeof d.slideBack === "boolean") s.slideBack = d.slideBack; // 0.21 slideback
	if (typeof d.pageRefs === "boolean") s.pageRefs = d.pageRefs; // 0.22 pagerefs
	if (typeof d.paperSuggest === "boolean") s.paperSuggest = d.paperSuggest; // 0.25 papersuggest
	if (typeof d.welcomeBack === "boolean") s.welcomeBack = d.welcomeBack; // 0.23 welcomeback
	if (typeof d.welcomeBackHours === "number") s.welcomeBackHours = clampWelcomeHours(d.welcomeBackHours); // 0.23 welcomeback
	if (d.lectureHeader === "off" || d.lectureHeader === "ask" || d.lectureHeader === "auto") s.lectureHeader = d.lectureHeader; // 0.22 lecthead
	if (typeof d.lectureHeaderLecturer === "boolean") s.lectureHeaderLecturer = d.lectureHeaderLecturer;
	if (typeof d.lectureHeaderRoom === "boolean") s.lectureHeaderRoom = d.lectureHeaderRoom;
	if (typeof d.lectureHeaderDate === "boolean") s.lectureHeaderDate = d.lectureHeaderDate;
	if (typeof d.lectureHeaderTime === "boolean") s.lectureHeaderTime = d.lectureHeaderTime;
	if (typeof d.taskDueEmoji === "boolean") s.taskDueEmoji = d.taskDueEmoji;
	if (typeof d.tasksNote === "string") s.tasksNote = d.tasksNote.trim();
	if (d.checklistDraw === "off" || d.checklistDraw === "offer" || d.checklistDraw === "auto") s.checklistDraw = d.checklistDraw;
	if (d.axesDraw === "off" || d.axesDraw === "offer" || d.axesDraw === "auto") s.axesDraw = d.axesDraw; // 0.22 axes
	if (typeof d.axesTicks === "boolean") s.axesTicks = d.axesTicks;
	if (typeof d.axesLabels === "boolean") s.axesLabels = d.axesLabels;
	if (typeof d.noteInsertWidth === "number") s.noteInsertWidth = clampInsertWidth(d.noteInsertWidth);
	if (isInsertBackground(d.noteInsertBackground)) s.noteInsertBackground = d.noteInsertBackground;
	if (typeof d.noteInsertLinkBack === "boolean") s.noteInsertLinkBack = d.noteInsertLinkBack;
	if (typeof d.lookUpNote === "string") s.lookUpNote = d.lookUpNote.trim();
	if (typeof d.lookUpWidth === "number") s.lookUpWidth = clampLookUpWidth(d.lookUpWidth);
	if (typeof d.copyLinkReverse === "boolean") s.copyLinkReverse = d.copyLinkReverse;
	if (typeof d.tagSuggestions === "boolean") s.tagSuggestions = d.tagSuggestions;
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
	// 0.5.x-0.12.3 saved every setting: their default of 150 ms is not a choice (see LEGACY_BEFORE_MS). Once: afterwards 150 is.
	if (d.penButtonWindowsMigrated !== true && s.penButtonContactBeforeMs === LEGACY_BEFORE_MS) s.penButtonContactBeforeMs = DEFAULT_BUTTON_WINDOWS.beforeMs;
	s.penButtonWindowsMigrated = true;
	s.penButtonContactAfterMs = cleanWindowMs(d.penButtonContactAfterMs, BUTTON_AFTER_MAX_MS) ?? s.penButtonContactAfterMs;
	if (typeof d.penZeroPressureButton === "boolean") s.penZeroPressureButton = d.penZeroPressureButton;
	if (typeof d.penChordButton === "boolean") s.penChordButton = d.penChordButton;
	if (typeof d.lastNotebookPath === "string") s.lastNotebookPath = d.lastNotebookPath;
	if (typeof d.lastNotebookPage === "number" && Number.isInteger(d.lastNotebookPage) && d.lastNotebookPage >= 1) s.lastNotebookPage = d.lastNotebookPage;
	if (isScrollMode(d.scrollMode)) s.scrollMode = d.scrollMode;
	if (isToolbarSize(d.toolbarSize)) s.toolbarSize = d.toolbarSize;
	if (typeof d.adaptPageType === "boolean") s.adaptPageType = d.adaptPageType;
	if (typeof d.adaptLearn === "boolean") s.adaptLearn = d.adaptLearn;
	if (typeof d.adaptSelection === "boolean") s.adaptSelection = d.adaptSelection;
	if (isToolFadeMode(d.toolFade)) s.toolFade = d.toolFade;
	s.toolFadeSeconds = cleanFadeSeconds(d.toolFadeSeconds);
	if (typeof d.toolFadeFirstTouch === "boolean") s.toolFadeFirstTouch = d.toolFadeFirstTouch;
	if (isInputPref(d.inputLayout)) s.inputLayout = d.inputLayout;
	if (typeof d.relatedCourse === "boolean") s.relatedCourse = d.relatedCourse; // 0.26 related
	const macroRead = readMacros(d.macros, d.macrosExtra); // 0.27 macros
	s.macros = macroRead.macros;
	s.macrosExtra = macroRead.extra;
	// Review fix (M7): the pin of a macro that no longer exists (deleted, or its id repaired) would sit in a toolbar slot unseen.
	// Review fix (R2): but a macro kept apart (a newer version's 14th) still exists, and so does every macro when the list is unreadable.
	const kept = s.macrosExtra.flatMap((m) => (typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string" ? [{ id: (m as { id: string }).id }] : []));
	if (d.macros !== undefined && !Array.isArray(d.macros)) s.pinnedQuick = normalisePinned(d.pinnedQuick);
	else {
		// Review fix (T2): the pin of a macro this version only keeps is written back but never takes one of the three visible places.
		const rawPins = Array.isArray(d.pinnedQuick) ? (d.pinnedQuick as unknown[]) : [];
		const keptPins = new Set(kept.filter((k) => !s.macros.some((m) => m.id === k.id)).map((k) => macroActionId(k.id)));
		const hidden = [...new Set(rawPins.filter((p): p is string => typeof p === "string" && keptPins.has(p)))].slice(0, MAX_PINNED);
		const visible = withoutMissingMacros(normalisePinned(rawPins.filter((p) => !(typeof p === "string" && hidden.includes(p)))), [...s.macros, ...kept]);
		s.pinnedQuick = [...visible, ...hidden];
	}
	if (typeof d.pageTurnerKeys === "boolean") s.pageTurnerKeys = d.pageTurnerKeys;
	if (typeof d.notebookTabs === "boolean") s.notebookTabs = d.notebookTabs;
	if (typeof d.autoLineBreak === "boolean") s.autoLineBreak = d.autoLineBreak;
	if (typeof d.trimHooks === "boolean") s.trimHooks = d.trimHooks;
	if (d.digestGroup === "page" || d.digestGroup === "colour") s.digestGroup = d.digestGroup;
	s.colourMeanings = parseLegend(d.colourMeanings);
	if (isToleranceName(d.meaningTolerance)) s.meaningTolerance = d.meaningTolerance;
	if (typeof d.indexPrefix === "string") s.indexPrefix = normalizeIndexPrefix(d.indexPrefix);
	if (typeof d.commentMarkers === "boolean") s.commentMarkers = d.commentMarkers;
	if (typeof d.commentsInPdf === "boolean") s.commentsInPdf = d.commentsInPdf;
	if (isHeaderMode(d.headerMode)) s.headerMode = d.headerMode;
	if (isHeaderAlign(d.headerAlign)) s.headerAlign = d.headerAlign;
	if (isClipBackground(d.clipImageBackground)) s.clipImageBackground = d.clipImageBackground;
	for (const k of ["headerPageNumber", "headerPageTotal", "headerDate", "headerTitle", "headerInExport", "headerPageTimes"] as const) if (typeof d[k] === "boolean") s[k] = d[k];
	if (typeof d.dateStampFormat === "string") s.dateStampFormat = cleanStampFormat(d.dateStampFormat);
	if (isSignDateMode(d.signDateMode)) s.signDateMode = d.signDateMode;
	if (typeof d.signDateCustom === "string") s.signDateCustom = cleanSignDateCustom(d.signDateCustom);
	s.recentColours = normaliseRecentColours(d.recentColours);
	if (typeof d.fastScrollbar === "boolean") s.fastScrollbar = d.fastScrollbar;
	if (typeof d.spreadFirstAlone === "boolean") s.spreadFirstAlone = d.spreadFirstAlone;
	if (typeof d.spreadAuto === "boolean") s.spreadAuto = d.spreadAuto;
	if (typeof d.symbolStrip === "boolean") s.symbolStrip = d.symbolStrip;
	s.symbolCount = clampSymbolCount(d.symbolCount);
	if (typeof d.dimensionHint === "boolean") s.dimensionHint = d.dimensionHint;
	if (isPenKind(d.defaultPenKind)) s.defaultPenKind = d.defaultPenKind;
	s.defaultNibAngle = normaliseNib(d.defaultNibAngle);
	if (isMinimapMode(d.minimapMode)) s.minimapMode = d.minimapMode;
	if (typeof d.semanticZoom === "boolean") s.semanticZoom = d.semanticZoom;
	if (APPEARANCE_STYLES.includes(d.appearanceStyle as AppearanceStyle)) s.appearanceStyle = d.appearanceStyle as AppearanceStyle;
	if (typeof d.userName === "string") s.userName = cleanUserName(d.userName);
	if (typeof d.hintsEnabled === "boolean") s.hintsEnabled = d.hintsEnabled;
	if (typeof d.iconHelp === "boolean") s.iconHelp = d.iconHelp;
	s.hintsSeen = normaliseSeen(d.hintsSeen);
	// 0.14 slides
	if (typeof d.slideInkLink === "boolean") s.slideInkLink = d.slideInkLink;
	if (typeof d.slideInkBadges === "boolean") s.slideInkBadges = d.slideInkBadges;
	s.lastNotebookPos = parsePosition(d.lastNotebookPos);

	if (typeof d.timetableOffer === "boolean") s.timetableOffer = d.timetableOffer;
	if (typeof d.timetableAutoOpen === "boolean") s.timetableAutoOpen = d.timetableAutoOpen;
	if (typeof d.timetableLeadMinutes === "number" && Number.isInteger(d.timetableLeadMinutes) && d.timetableLeadMinutes >= 0 && d.timetableLeadMinutes <= 30) s.timetableLeadMinutes = d.timetableLeadMinutes;
	Object.assign(s, readCompanionSettings(d), readGestureSettings(d), readPenGestureSettings(d));
	Object.assign(s, readTrashSettings(d));
	Object.assign(s, readLectureSettings(d));
	if (typeof d.inkFollowsObjects === "boolean") s.inkFollowsObjects = d.inkFollowsObjects;
	Object.assign(s, readZettelSettings(d));
	Object.assign(s, readReadingSettings(d));
	Object.assign(s, readPresentSettings(d));
	Object.assign(s, readSnapSettings(d));
	Object.assign(s, readGhostSettings(d));
	Object.assign(s, readBoardSettings(d));
	Object.assign(s, readPdfCopySettings(d));
	Object.assign(s, readBackupSettings(d)); // 0.21 backups
	Object.assign(s, readCloudSyncSettings(d)); // 0.22 synccore (#126)
	// A backup folder that overlaps the notebooks or the templates would hide them (review W21 D2): back to the default.
	if (backupFolderConflict(s.zipBackupFolder, { notebooksFolder: s.folder, templatesFolder: s.templatesFolder, notebookTemplatesFolder: s.notebookTemplatesFolder }) !== null) s.zipBackupFolder = DEFAULT_BACKUP_FOLDER;
	return s;
}

export function backupFolder(settings: NotebookSettings): string {
	return `${settings.folder.replace(/\/+$/, "")}/_backup`;
}
