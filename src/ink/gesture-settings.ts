/** Settings of the pen and finger gestures (wave 0.6). Pure: parsed by `readSettings`. */

/** Finger taps: two fingers = undo, three = redo (or the other way round), or nothing. */
export const TAP_GESTURE_MODES = ["off", "undo-redo", "redo-undo"] as const;
export type TapGestureMode = (typeof TAP_GESTURE_MODES)[number];

export interface GestureSettings {
	/** Multi-finger taps. On by default: undo is never destructive. */
	tapGestures: TapGestureMode;
	/** Scribble to erase. Off by default: a false positive deletes ink (one undo step brings it back). */
	scribbleErase: boolean;
	/** After the pen lifts near the bottom of the view, scroll up smoothly. Off by default: it moves the view on its own. */
	autoScrollWriting: boolean;
}

export const DEFAULT_GESTURE_SETTINGS: GestureSettings = {
	tapGestures: "undo-redo",
	scribbleErase: false,
	autoScrollWriting: false,
};

/** Merges saved data over the defaults, ignoring values of the wrong type. */
export function readGestureSettings(d: Record<string, unknown>): GestureSettings {
	const s = { ...DEFAULT_GESTURE_SETTINGS };
	if (TAP_GESTURE_MODES.includes(d.tapGestures as TapGestureMode)) s.tapGestures = d.tapGestures as TapGestureMode;
	if (typeof d.scribbleErase === "boolean") s.scribbleErase = d.scribbleErase;
	if (typeof d.autoScrollWriting === "boolean") s.autoScrollWriting = d.autoScrollWriting;
	return s;
}
