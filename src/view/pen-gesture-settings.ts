import { BUILTIN_GESTURES, type BuiltInGestureId } from "../ink/gestures/registry";
import { GESTURE_KEY_PREFIX } from "./settings-schema";

export { GESTURE_KEY_PREFIX };

/** The gesture of a per-gesture switch key of the settings tab ("penGesture:select" gives "select"), or null. */
export function gestureKeyId(key: string): BuiltInGestureId | null {
	if (!key.startsWith(GESTURE_KEY_PREFIX)) return null;
	const id = key.slice(GESTURE_KEY_PREFIX.length);
	return (BUILTIN_GESTURES as readonly string[]).includes(id) ? (id as BuiltInGestureId) : null;
}
