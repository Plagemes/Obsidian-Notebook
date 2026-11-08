// 0.25 profiles (#219): writing profiles. One tap switches the pens on the strip, the stabilization and the paper that new
// notebooks start on, for fast ("Lecture") or careful ("Study") writing. Pure logic (no 'obsidian'), unit-tested.
// Two profiles are built in (constants, never stored); the user's own are saved from the current state and live in the plugin
// settings with the active id, so they are the same on every device that shares the settings. Switching a profile changes tools
// and defaults only: no stroke, page or document is ever touched, and the document format is unchanged.
import { PROFILE_SCORE, type PaperCandidate } from "../model/paper-suggest";
import { PAPER_KINDS, type PaperKind } from "../model/types";
import { FAVOURITE_SLOTS, validPen, type FavouritePen } from "./favourites";
import { MAX_PEN_SETS, MAX_SET_NAME, type PenSet } from "./pen-sets";

export interface WritingProfile {
	/** `lecture` and `study` for the built-in ones, `profile-<n>` otherwise. */
	id: string;
	name: string;
	/** One to FAVOURITE_SLOTS pens for the strip. Used when `penSetId` is absent or the set no longer exists. */
	pens: FavouritePen[];
	/** Optional reference to a pen set: while it exists the strip shows that set instead of `pens`. */
	penSetId?: string;
	/** Stabilization level 0-10 (the same scale as the setting). */
	stabilization: number;
	/** Paper that new notebooks start on (the "Default paper" setting). */
	paper: PaperKind;
}

export const MAX_PROFILES = 12;
export const MAX_PROFILE_NAME = 30;
export const BUILTIN_IDS = ["lecture", "study"] as const;
export type BuiltinProfileId = (typeof BUILTIN_IDS)[number];

const pen = (color: string, width: number, extra: Partial<FavouritePen> = {}): FavouritePen => ({ tool: "pen", color, width, ...extra });
const marker = (color: string): FavouritePen => ({ tool: "highlighter", color, width: 14 });

/** Lecture: thin ballpoints and little smoothing for speed, ruled paper. Study: fountain pens, strong smoothing, grid paper. */
export const BUILTIN_PROFILES: readonly WritingProfile[] = [
	{ id: "lecture", name: "Lecture", pens: [pen("#1e1e1e", 1.4), pen("#1d4ed8", 1.4), pen("#dc2626", 1.4), pen("#15803d", 1.2), marker("#facc15"), marker("#4ade80")], stabilization: 1, paper: "ruled" },
	{ id: "study", name: "Study", pens: [pen("#1e1e1e", 2, { kind: "fountain" }), pen("#1d4ed8", 2, { kind: "fountain" }), pen("#dc2626", 1.6), pen("#15803d", 1.6), marker("#facc15"), marker("#f472b6")], stabilization: 6, paper: "grid" },
];

export const BUILTIN_NAME_KEYS = { lecture: "profiles.builtin.lecture", study: "profiles.builtin.study" } as const;
export type BuiltinNameKey = (typeof BUILTIN_NAME_KEYS)[BuiltinProfileId];

export function isBuiltin(id: string): id is BuiltinProfileId {
	return (BUILTIN_IDS as readonly string[]).includes(id);
}

export function cloneProfile(p: WritingProfile): WritingProfile {
	const out: WritingProfile = { id: p.id, name: p.name, pens: p.pens.map((x) => ({ ...x })), stabilization: p.stabilization, paper: p.paper };
	if (p.penSetId) out.penSetId = p.penSetId;
	return out;
}

export function cleanProfileName(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_PROFILE_NAME) : "";
}

const clampLevel = (n: number): number => Math.min(10, Math.max(0, Math.round(n)));

/** Reads the saved custom profiles leniently: bad entries, repeated ids and ids of the built-in ones are dropped. */
export function normaliseProfiles(data: unknown): WritingProfile[] {
	if (!Array.isArray(data)) return [];
	const out: WritingProfile[] = [];
	const seen = new Set<string>(BUILTIN_IDS);
	for (const raw of data) {
		if (out.length >= MAX_PROFILES) break;
		if (typeof raw !== "object" || raw === null) continue;
		const o = raw as Record<string, unknown>;
		const id = typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "";
		const name = cleanProfileName(o.name);
		if (!id || !name || seen.has(id) || !Array.isArray(o.pens)) continue;
		const pens = o.pens.map(validPen).filter((p): p is FavouritePen => p !== null).slice(0, FAVOURITE_SLOTS);
		if (pens.length === 0) continue;
		if (typeof o.stabilization !== "number" || !Number.isFinite(o.stabilization)) continue;
		if (!PAPER_KINDS.includes(o.paper as PaperKind)) continue;
		seen.add(id);
		const p: WritingProfile = { id, name, pens, stabilization: clampLevel(o.stabilization), paper: o.paper as PaperKind };
		if (typeof o.penSetId === "string" && /^[\w-]{1,40}$/.test(o.penSetId)) p.penSetId = o.penSetId;
		out.push(p);
	}
	return out;
}

/** The active id read from the settings: "" or the id of a profile that exists is kept, anything else is none. */
export function normaliseActive(v: unknown, custom: readonly WritingProfile[]): string {
	return typeof v === "string" && (isBuiltin(v) || custom.some((p) => p.id === v)) ? v : "";
}

/** Built-in profiles first, then the user's own. */
export function allProfiles(custom: readonly WritingProfile[]): WritingProfile[] {
	return [...BUILTIN_PROFILES.map(cloneProfile), ...custom.map(cloneProfile)];
}

export function findProfile(custom: readonly WritingProfile[], id: string): WritingProfile | null {
	return allProfiles(custom).find((p) => p.id === id) ?? null;
}

export function profileName(p: WritingProfile, translate: (key: BuiltinNameKey) => string): string {
	return isBuiltin(p.id) ? translate(BUILTIN_NAME_KEYS[p.id]) : p.name;
}

/** The part of the settings a profile reads and writes. */
export interface ProfileSettings {
	stabilization: number;
	defaultPaper: PaperKind;
	writingProfileActive: string;
}

/** The settings patch that switches to a profile (the pens are applied by the view, which owns the strip). */
export function applyPatch(p: WritingProfile): ProfileSettings {
	return { stabilization: clampLevel(p.stabilization), defaultPaper: p.paper, writingProfileActive: p.id };
}

/** Whether the settings still are what the profile sets (the user may have moved the slider since). */
export function isCurrent(p: WritingProfile, s: Pick<ProfileSettings, "stabilization" | "defaultPaper">): boolean {
	return clampLevel(p.stabilization) === s.stabilization && p.paper === s.defaultPaper;
}

/** The active profile as the chip shows it: none when nothing is active, the profile does not exist or the settings drifted. */
export function activeProfile(custom: readonly WritingProfile[], s: ProfileSettings): WritingProfile | null {
	const p = s.writingProfileActive ? findProfile(custom, s.writingProfileActive) : null;
	return p && isCurrent(p, s) ? p : null;
}

/** The candidate the "+" strip gets from the active profile (roadmap 409): its paper, above any history signal; none when no profile is active or the settings drifted from it (the same rule as the chip). */
export function profilePaperCandidate(custom: readonly WritingProfile[], s: ProfileSettings): PaperCandidate[] {
	const p = activeProfile(custom, s);
	return p ? [{ paper: p.paper, score: PROFILE_SCORE, reason: { kind: "profile" } }] : [];
}

/** The pens a profile puts on the strip: those of its pen set while that exists, else its own list. */
export function profilePens(p: WritingProfile, sets: readonly PenSet[]): FavouritePen[] {
	const set = p.penSetId ? sets.find((s) => s.id === p.penSetId) : undefined;
	return (set ? set.pens : p.pens).map((x) => ({ ...x }));
}

export function newProfileId(custom: readonly WritingProfile[]): string {
	let n = custom.length + 1;
	while (custom.some((p) => p.id === `profile-${n}`)) n++;
	return `profile-${n}`;
}

export interface CurrentState {
	pens: readonly FavouritePen[];
	penSetId: string | null;
	stabilization: number;
	paper: PaperKind;
}

function fromState(id: string, name: string, s: CurrentState): WritingProfile {
	const p: WritingProfile = { id, name, pens: s.pens.slice(0, FAVOURITE_SLOTS).map((x) => ({ ...x })), stabilization: clampLevel(s.stabilization), paper: s.paper };
	if (s.penSetId) p.penSetId = s.penSetId;
	return p;
}

/** "Custom": a new profile saved from the current state, or null (empty name, or the limit is reached). */
export function addProfile(custom: readonly WritingProfile[], rawName: string, s: CurrentState): { profiles: WritingProfile[]; id: string } | null {
	const name = cleanProfileName(rawName);
	if (!name || custom.length >= MAX_PROFILES || s.pens.length === 0) return null;
	const id = newProfileId(custom);
	return { profiles: [...custom.map(cloneProfile), fromState(id, name, s)], id };
}

/** Writes the current state into a custom profile (the built-in ones are never changed). */
export function updateProfile(custom: readonly WritingProfile[], id: string, s: CurrentState): WritingProfile[] {
	return custom.map((p) => (p.id === id ? fromState(p.id, p.name, s) : cloneProfile(p)));
}

export function deleteProfile(custom: readonly WritingProfile[], id: string): WritingProfile[] {
	return custom.filter((p) => p.id !== id).map(cloneProfile);
}

/** The profile after `activeId` in the order built-in then custom (wraps round; the first one when none is active). */
export function nextProfileId(custom: readonly WritingProfile[], activeId: string): string {
	const ids = allProfiles(custom).map((p) => p.id);
	const i = ids.indexOf(activeId);
	return ids[(i + 1) % ids.length]!;
}

/** Starting lecture mode switches to the Lecture profile only when the setting is on and it is not already the active one. */
export function switchOnLecture(enabled: boolean, s: ProfileSettings): boolean {
	return enabled && !(s.writingProfileActive === "lecture" && isCurrent(BUILTIN_PROFILES[0]!, s));
}

/** Id of the pen set that holds the pens of a profile that has no pen set of its own. */
export function profileSetId(p: WritingProfile): string {
	return `wp-${p.id}`.slice(0, 40);
}

/**
 * The pen set the strip shows for a profile: its own reference while that set exists, else the set made from its pen list
 * (created the first time and then left alone, so the pens the user changes later in it are kept). Null when the set list is full.
 */
export function ensureProfileSet(sets: readonly PenSet[], p: WritingProfile, displayName: string): { sets: PenSet[]; id: string } | null {
	const copy = sets.map((s) => ({ id: s.id, name: s.name, pens: s.pens.map((x) => ({ ...x })) }));
	if (p.penSetId && copy.some((s) => s.id === p.penSetId)) return { sets: copy, id: p.penSetId };
	const id = profileSetId(p);
	if (copy.some((s) => s.id === id)) return { sets: copy, id };
	if (copy.length >= MAX_PEN_SETS) return null;
	copy.push({ id, name: displayName.slice(0, MAX_SET_NAME), pens: p.pens.slice(0, FAVOURITE_SLOTS).map((x) => ({ ...x })) });
	return { sets: copy, id };
}
