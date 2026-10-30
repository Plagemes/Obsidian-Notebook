/** Settings of the library trash and of the page templates. Pure: no 'obsidian'. */

export interface TrashSettings {
	/** Items older than this many days are emptied from the library trash automatically; 0 = never (default). */
	trashRetentionDays: number;
	/** Folder of the page templates; empty = `<notebooks folder>/_templates`. */
	templatesFolder: string;
}

export const DEFAULT_TRASH_SETTINGS: Readonly<TrashSettings> = {
	trashRetentionDays: 0,
	templatesFolder: "",
};

export const TRASH_RETENTION_MAX_DAYS = 365;

/** Reads the settings from saved plugin data, ignoring values of the wrong type. */
export function readTrashSettings(d: Record<string, unknown>): TrashSettings {
	const s: TrashSettings = { ...DEFAULT_TRASH_SETTINGS };
	const days = d.trashRetentionDays;
	if (typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= TRASH_RETENTION_MAX_DAYS) s.trashRetentionDays = days;
	if (typeof d.templatesFolder === "string") s.templatesFolder = d.templatesFolder.trim();
	return s;
}
