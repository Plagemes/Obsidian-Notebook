/**
 * Settings of the magnetic snap and alignment guides (roadmap #71). Kept in the plugin settings, never in a notebook
 * file. Pure: no 'obsidian' import.
 */
import { DEFAULT_SNAP_MODE, DEFAULT_SNAP_STRENGTH, normaliseSnapMode, normaliseSnapStrength, type SnapMode } from "../model/snap";

export interface SnapSettings {
	/** What a selection snaps to while it is moved or scaled: nothing, the paper grid, the alignment guides, or both. */
	snapMode: SnapMode;
	/** How close (CSS px) the selection has to come before it is pulled onto a line. */
	snapStrength: number;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = { snapMode: DEFAULT_SNAP_MODE, snapStrength: DEFAULT_SNAP_STRENGTH };

/** Reads the snap settings out of saved plugin data, ignoring values of the wrong type. */
export function readSnapSettings(data: Record<string, unknown>): SnapSettings {
	return {
		snapMode: data.snapMode === undefined ? DEFAULT_SNAP_MODE : normaliseSnapMode(data.snapMode),
		snapStrength: data.snapStrength === undefined ? DEFAULT_SNAP_STRENGTH : normaliseSnapStrength(data.snapStrength),
	};
}
