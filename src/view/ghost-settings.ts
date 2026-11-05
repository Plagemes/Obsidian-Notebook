/**
 * Settings of the ghost guide lines on blank paper (roadmap #94). Kept in the plugin settings, never in a notebook file.
 * Pure: no 'obsidian' import.
 */
import { DEFAULT_GHOST_MODE, DEFAULT_GHOST_SPACING, normaliseGhostMode, normaliseGhostSpacing, type GhostMode } from "../model/ghost-lines";

export interface GhostSettings {
	/** Faint guide lines on blank paper: off, while writing (they fade after a pause), or always. */
	ghostLines: GhostMode;
	/** Distance between the guides in mm as text; "auto" follows the handwriting. */
	ghostSpacing: string;
}

export const DEFAULT_GHOST_SETTINGS: GhostSettings = { ghostLines: DEFAULT_GHOST_MODE, ghostSpacing: DEFAULT_GHOST_SPACING };

/** Reads the ghost line settings out of saved plugin data, ignoring values of the wrong type. */
export function readGhostSettings(data: Record<string, unknown>): GhostSettings {
	return {
		ghostLines: data.ghostLines === undefined ? DEFAULT_GHOST_MODE : normaliseGhostMode(data.ghostLines),
		ghostSpacing: data.ghostSpacing === undefined ? DEFAULT_GHOST_SPACING : normaliseGhostSpacing(data.ghostSpacing),
	};
}
