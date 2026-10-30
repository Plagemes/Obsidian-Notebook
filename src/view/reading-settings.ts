/**
 * Settings of the PDF reading tools (wave 0.6): snapping highlighter (#43) and dimmed backgrounds (#199). They are view
 * settings, kept in the plugin settings and never in a notebook file. Pure: no 'obsidian' import.
 */
/** wave 0.9: view-only display options (night mode 367, crop the white margins of PDF pages 376). */
export interface DisplaySettings {
	/** Dark page display; the stored colours are not changed. */
	nightMode: boolean;
	/** PDF pages are shown cropped to their content (the white margins fall off screen). */
	cropMargins: boolean;
}

export interface ReadingSettings extends DisplaySettings {
	/** The highlighter snaps to the text lines of a PDF page. */
	snapHighlighter: boolean;
	/** PDF and image backgrounds are drawn lighter so the ink stands out. */
	dimBackground: boolean;
	/** How much lighter, 0.1-0.8 (the share of white mixed into the background). */
	dimStrength: number;
}

export const DIM_MIN = 0.1;
export const DIM_MAX = 0.8;
export const DIM_STEP = 0.05;
export const DEFAULT_DIM = 0.45;

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
	snapHighlighter: false,
	dimBackground: false,
	dimStrength: DEFAULT_DIM,
	nightMode: false,
	cropMargins: false,
};

/** A strength within range, rounded to the slider step; the default for anything that is not a number. */
export function normaliseDim(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DIM;
	const clamped = Math.min(DIM_MAX, Math.max(DIM_MIN, value));
	return Math.round(clamped / DIM_STEP) / Math.round(1 / DIM_STEP);
}

/** Reads the reading settings out of saved plugin data, ignoring values of the wrong type. */
export function readReadingSettings(data: Record<string, unknown>): ReadingSettings {
	const s = { ...DEFAULT_READING_SETTINGS };
	if (typeof data.snapHighlighter === "boolean") s.snapHighlighter = data.snapHighlighter;
	if (typeof data.dimBackground === "boolean") s.dimBackground = data.dimBackground;
	if (typeof data.nightMode === "boolean") s.nightMode = data.nightMode;
	if (typeof data.cropMargins === "boolean") s.cropMargins = data.cropMargins;
	if (data.dimStrength !== undefined) s.dimStrength = normaliseDim(data.dimStrength);
	return s;
}
