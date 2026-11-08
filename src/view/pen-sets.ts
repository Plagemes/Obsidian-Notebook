// Pen sets per subject: named lists of pens (tool, colour, width) that fill the favourites strip. Pure logic (no
// 'obsidian'), unit-tested. A set is chosen for a notebook with this order of precedence: the notebook itself, then the
// nearest folder above it that has one, then the default favourite pens (the user's own `favouritePens`, never touched
// by a set). The set definitions live in the plugin settings; so do the assignments (folder path -> set id and
// document id -> set id), bounded and read leniently. No document format change.
import { DEFAULT_FAVOURITES, FAVOURITE_SLOTS, normaliseFavourites, validPen, type FavouritePen } from "./favourites";

export interface PenSet {
	/** Stable id (`starter-maths` for a built-in one, `set-<n>` otherwise). */
	id: string;
	name: string;
	/** One to FAVOURITE_SLOTS pens; the strip shows them in order and keeps the default pen in any slot left over. */
	pens: FavouritePen[];
}

export const MAX_PEN_SETS = 24;
export const MAX_SET_NAME = 40;
export const MAX_FOLDER_ASSIGNMENTS = 200;
export const MAX_NOTEBOOK_ASSIGNMENTS = 200;
export const MAX_KEY_LENGTH = 512;

const pen = (color: string, width: number): FavouritePen => ({ tool: "pen", color, width });
const marker = (color: string): FavouritePen => ({ tool: "highlighter", color, width: 14 });

/** The built-in starter sets. They are ordinary sets once seeded: the user can edit, rename or delete them. */
export const STARTER_SETS: readonly PenSet[] = [
	{ id: "starter-maths", name: "Maths", pens: [pen("#1e1e1e", 1.6), pen("#1d4ed8", 1.6), pen("#dc2626", 1.6), pen("#15803d", 1.2), marker("#facc15"), marker("#4ade80")] },
	{ id: "starter-languages", name: "Languages", pens: [pen("#1e1e1e", 2), pen("#dc2626", 2), pen("#1d4ed8", 2), pen("#ea580c", 2), marker("#facc15"), marker("#f472b6")] },
	{ id: "starter-science", name: "Science", pens: [pen("#1e1e1e", 1.6), pen("#1d4ed8", 1.6), pen("#15803d", 1.6), pen("#7c3aed", 1.6), marker("#facc15"), marker("#22d3ee")] },
];

export const STARTER_NAME_KEYS = {
	"starter-maths": "pensets.starter.maths",
	"starter-languages": "pensets.starter.languages",
	"starter-science": "pensets.starter.science",
} as const;
export type StarterNameKey = (typeof STARTER_NAME_KEYS)[keyof typeof STARTER_NAME_KEYS];

export function cloneSet(s: PenSet): PenSet {
	return { id: s.id, name: s.name, pens: s.pens.map((p) => ({ ...p })) };
}

export function defaultPenSets(): PenSet[] {
	return STARTER_SETS.map(cloneSet);
}


/** Trims, collapses whitespace and cuts a name; an empty result is "". */
export function cleanSetName(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_SET_NAME) : "";
}

/**
 * Reads the saved sets. Anything that is not an array gives the starter sets (first run); an array is taken as it is,
 * dropping bad entries and repeated ids, so deleting every set stays deleted.
 */
export function normalisePenSets(data: unknown): PenSet[] {
	if (!Array.isArray(data)) return defaultPenSets();
	const out: PenSet[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		if (out.length >= MAX_PEN_SETS) break;
		if (typeof raw !== "object" || raw === null) continue;
		const o = raw as Record<string, unknown>;
		const id = typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "";
		const name = cleanSetName(o.name);
		if (!id || !name || seen.has(id) || !Array.isArray(o.pens)) continue;
		const pens = o.pens.map(validPen).filter((p): p is FavouritePen => p !== null).slice(0, FAVOURITE_SLOTS);
		if (pens.length === 0) continue;
		seen.add(id);
		out.push({ id, name, pens });
	}
	return out;
}

/** Reads an assignment map (key -> set id): string pairs only, bounded to the last `max` entries. */
export function normaliseAssignments(data: unknown, max: number): Record<string, string> {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const pairs = Object.entries(data as Record<string, unknown>)
		.filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "" && e[0] !== "" && e[0].length <= MAX_KEY_LENGTH && e[1].length <= 40);
	const out: Record<string, string> = {};
	for (const [k, v] of pairs.slice(-max)) out[k] = v;
	return out;
}

/** Vault path without leading or trailing slashes ("" is the vault root). */
export function folderKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** The folders that contain a file, nearest first (`a/b/x.notebook` gives `a/b`, `a`). */
export function ancestorFolders(filePath: string): string[] {
	const parts = folderKey(filePath).split("/");
	parts.pop();
	const out: string[] = [];
	for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join("/"));
	return out;
}

export type PenSetSource = "notebook" | "folder" | "default";

export interface PenSetChoice {
	/** The set to use, or null for the default favourite pens. */
	set: PenSet | null;
	source: PenSetSource;
	/** For "folder": the folder that carries the assignment. */
	folder?: string;
}

export interface PenSetResolveInput {
	sets: readonly PenSet[];
	folders: Readonly<Record<string, string>>;
	notebooks: Readonly<Record<string, string>>;
	notebookId: string | null;
	filePath: string;
}

const own = (m: Readonly<Record<string, string>>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);

/** notebook > nearest folder > default. An assignment to a set that no longer exists is skipped, not an error. */
export function resolvePenSet(i: PenSetResolveInput): PenSetChoice {
	const byId = (id: string | undefined): PenSet | null => (id === undefined ? null : i.sets.find((s) => s.id === id) ?? null);
	if (i.notebookId) {
		const set = byId(own(i.notebooks, i.notebookId));
		if (set) return { set, source: "notebook" };
	}
	for (const folder of ancestorFolders(i.filePath)) {
		const set = byId(own(i.folders, folder));
		if (set) return { set, source: "folder", folder };
	}
	return { set: null, source: "default" };
}

/** The six strip slots of a set: its pens first, the user's default favourites in any slot it leaves out. */
export function slotsOf(set: PenSet, fallback: readonly FavouritePen[] = DEFAULT_FAVOURITES): FavouritePen[] {
	return normaliseFavourites(fallback).map((f, i) => ({ ...(set.pens[i] ?? f) }));
}

/** The set `id` with the strip written into it (what saving a slot does while that set is active). */
export function withSetPens(sets: readonly PenSet[], id: string, strip: readonly FavouritePen[]): PenSet[] {
	return sets.map((s) => (s.id === id ? { ...cloneSet(s), pens: strip.slice(0, FAVOURITE_SLOTS).map((p) => ({ ...p })) } : cloneSet(s)));
}

/** A fresh id that no set uses. */
export function newSetId(sets: readonly PenSet[]): string {
	let n = sets.length + 1;
	while (sets.some((s) => s.id === `set-${n}`)) n++;
	return `set-${n}`;
}

/** Adds a set made of the given pens; null when the name is empty, the limit is reached or there are no pens. */
export function addPenSet(sets: readonly PenSet[], name: string, pens: readonly FavouritePen[]): { sets: PenSet[]; id: string } | null {
	const clean = cleanSetName(name);
	if (!clean || sets.length >= MAX_PEN_SETS || pens.length === 0) return null;
	const id = newSetId(sets);
	return { sets: [...sets.map(cloneSet), { id, name: clean, pens: pens.slice(0, FAVOURITE_SLOTS).map((p) => ({ ...p })) }], id };
}

export function renamePenSet(sets: readonly PenSet[], id: string, name: string): PenSet[] {
	const clean = cleanSetName(name);
	return sets.map((s) => (s.id === id && clean ? { ...cloneSet(s), name: clean } : cloneSet(s)));
}

export function replacePens(sets: readonly PenSet[], id: string, pens: readonly FavouritePen[]): PenSet[] {
	return sets.map((s) => (s.id === id && pens.length > 0 ? { ...cloneSet(s), pens: pens.slice(0, FAVOURITE_SLOTS).map((p) => ({ ...p })) } : cloneSet(s)));
}

/** Removes a set and every assignment that pointed to it. */
export function removePenSet(
	sets: readonly PenSet[], folders: Readonly<Record<string, string>>, notebooks: Readonly<Record<string, string>>, id: string,
): { sets: PenSet[]; folders: Record<string, string>; notebooks: Record<string, string> } {
	const keep = (m: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== id));
	return { sets: sets.filter((s) => s.id !== id).map(cloneSet), folders: keep(folders), notebooks: keep(notebooks) };
}

/** Puts the starter sets that are missing back (existing sets, edited or not, are left alone). */
export function restoreStarters(sets: readonly PenSet[]): PenSet[] {
	const out = sets.map(cloneSet);
	for (const s of STARTER_SETS) if (!out.some((o) => o.id === s.id) && out.length < MAX_PEN_SETS) out.push(cloneSet(s));
	return out;
}

/** Sets (or, with null, clears) one assignment; the newest entries are kept when the map is over its bound. */
export function assign(map: Readonly<Record<string, string>>, key: string, setId: string | null, max: number): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(map)) if (k !== key) out[k] = v;
	if (setId !== null && key !== "" && key.length <= MAX_KEY_LENGTH) out[key] = setId;
	return normaliseAssignments(out, max);
}

/** Display name: a starter set that still carries its English name is shown in the interface language. */
export function displayName(set: PenSet, translate: (key: StarterNameKey) => string): string {
	const key = (STARTER_NAME_KEYS as Record<string, StarterNameKey | undefined>)[set.id];
	const starter = STARTER_SETS.find((s) => s.id === set.id);
	return key && starter && starter.name === set.name ? translate(key) : set.name;
}
