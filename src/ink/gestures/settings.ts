import { parseCustomGestures, type CustomGesture } from "./custom";
import { isBuiltInGesture, type BuiltInGestureId } from "./registry";

/** Pen gesture settings (roadmap 139), flat keys of the plugin settings. */
export interface PenGestureSettings {
	/** Built-in gestures the user switched off. */
	penGesturesOff: BuiltInGestureId[];
	/** Hold the pen still for a moment before writing a stroke to make it a gesture. Off by default: it changes how a pause feels. */
	penGestureLongPress: boolean;
	/** How much space the "^" gesture inserts, pt. */
	penGestureSpacePt: number;
	penGesturesCustom: CustomGesture[];
}

export const SPACE_PT_MIN = 16;
export const SPACE_PT_MAX = 160;

export const DEFAULT_PEN_GESTURE_SETTINGS: PenGestureSettings = {
	penGesturesOff: [],
	penGestureLongPress: false,
	penGestureSpacePt: 48,
	penGesturesCustom: [],
};

/** Merges saved data over the defaults, ignoring values of the wrong type. */
export function readPenGestureSettings(d: Record<string, unknown>): PenGestureSettings {
	const s: PenGestureSettings = { ...DEFAULT_PEN_GESTURE_SETTINGS, penGesturesOff: [], penGesturesCustom: [] };
	if (Array.isArray(d.penGesturesOff)) s.penGesturesOff = [...new Set(d.penGesturesOff.filter((x): x is BuiltInGestureId => typeof x === "string" && isBuiltInGesture(x)))];
	if (typeof d.penGestureLongPress === "boolean") s.penGestureLongPress = d.penGestureLongPress;
	if (typeof d.penGestureSpacePt === "number" && d.penGestureSpacePt >= SPACE_PT_MIN && d.penGestureSpacePt <= SPACE_PT_MAX) s.penGestureSpacePt = Math.round(d.penGestureSpacePt);
	s.penGesturesCustom = parseCustomGestures(d.penGesturesCustom);
	return s;
}
