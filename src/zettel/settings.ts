/** Zettelkasten settings (M15). Pure: no 'obsidian'. Merged into NotebookSettings like the companion settings. */
import { ID_SCHEMES, type ZettelIdScheme } from "./ids";

export interface ZettelSettings {
	/** Folder of new card notes. */
	zettelFolder: string;
	zettelIdScheme: ZettelIdScheme;
	/** Card regions (outline and id badge) drawn over the pages. */
	zettelShowRegions: boolean;
	/** Document ids of the slip-box notebooks (Z2): every page of these is a card. */
	zettelSlipBoxes: string[];
	/** Z5: related cards offered for linking in the card dialog. */
	zettelLinkSuggest: boolean;
	/** Z5: most suggestions listed (1-8). */
	zettelLinkSuggestCount: number;
}

export const DEFAULT_ZETTEL_SETTINGS: Readonly<ZettelSettings> = {
	zettelFolder: "Zettelkasten",
	zettelIdScheme: "timestamp",
	zettelShowRegions: true,
	zettelSlipBoxes: [],
	zettelLinkSuggest: true,
	zettelLinkSuggestCount: 4,
};

function cleanFolder(folder: string): string {
	return folder.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "." && s !== "..").join("/");
}

/** Reads the Zettelkasten settings from saved plugin data, ignoring values of the wrong type. */
export function readZettelSettings(d: Record<string, unknown>): ZettelSettings {
	const s: ZettelSettings = { ...DEFAULT_ZETTEL_SETTINGS, zettelSlipBoxes: [] };
	if (typeof d.zettelFolder === "string" && cleanFolder(d.zettelFolder)) s.zettelFolder = cleanFolder(d.zettelFolder);
	if (ID_SCHEMES.includes(d.zettelIdScheme as ZettelIdScheme)) s.zettelIdScheme = d.zettelIdScheme as ZettelIdScheme;
	if (typeof d.zettelShowRegions === "boolean") s.zettelShowRegions = d.zettelShowRegions;
	if (typeof d.zettelLinkSuggest === "boolean") s.zettelLinkSuggest = d.zettelLinkSuggest;
	if (typeof d.zettelLinkSuggestCount === "number" && Number.isFinite(d.zettelLinkSuggestCount)) s.zettelLinkSuggestCount = Math.min(8, Math.max(1, Math.round(d.zettelLinkSuggestCount)));
	if (Array.isArray(d.zettelSlipBoxes)) {
		s.zettelSlipBoxes = [...new Set(d.zettelSlipBoxes.filter((x): x is string => typeof x === "string" && x.length > 0))];
	}
	return s;
}

/** A6 portrait in pt (105 × 148 mm): the index-card page of a slip-box. */
export const A6_PAGE = { width: 297.64, height: 419.53 } as const;
