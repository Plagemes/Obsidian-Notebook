/** The built-in pen gestures (roadmap 139): id, the shape that draws it and the picture the cheat sheet shows. */
export const BUILTIN_GESTURES = ["select", "delete", "space", "tag", "bookmark", "search", "move"] as const;
export type BuiltInGestureId = (typeof BUILTIN_GESTURES)[number];

export type GestureShape = "circle" | "scribble" | "caret" | "hash" | "star" | "question" | "line";

export interface GestureInfo {
	id: BuiltInGestureId;
	shape: GestureShape;
	/** SVG path (viewBox 0 0 48 48) of the shape as it is drawn. */
	icon: string;
}

export const GESTURE_INFO: readonly GestureInfo[] = [
	{ id: "select", shape: "circle", icon: "M36 36A16 16 0 1 1 41 22" },
	{ id: "delete", shape: "scribble", icon: "M8 12L40 16L8 22L40 28L8 34L40 38" },
	{ id: "space", shape: "caret", icon: "M10 38L24 10L38 38" },
	{ id: "tag", shape: "hash", icon: "M17 8L15 40L33 36L31 8L8 17L40 15L38 33L8 31" },
	{ id: "bookmark", shape: "star", icon: "M24 5L37 42L6 19L42 19L11 42L24 5" },
	{ id: "search", shape: "question", icon: "M14 16A10 10 0 1 1 27 25Q23 27 23 32V40" },
	{ id: "move", shape: "line", icon: "M8 38L38 10M38 10L28 11M38 10L37 20" },
];

export function isBuiltInGesture(id: string): id is BuiltInGestureId {
	return (BUILTIN_GESTURES as readonly string[]).includes(id);
}
