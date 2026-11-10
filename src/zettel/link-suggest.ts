/**
 * Z5: link suggestions while a card is made. Pure: no 'obsidian', no I/O, no AI.
 *
 * The cards of the slip-box are ranked against what has been typed so far (title, tags, source): shared tags weigh most,
 * then words the titles share, then a title that contains the other; the last change of the note only breaks ties.
 * The candidate set is bounded (`boundCandidates`) so a big vault stays cheap on a tablet.
 */
import { foldText } from "../library/index";
import { contentWords } from "../model/tag-suggest";

export const LINK_SUGGEST_MIN = 1;
export const LINK_SUGGEST_MAX = 8;
export const LINK_SUGGEST_DEFAULT = 4;
/** Most candidates ever ranked at once (the most recently changed cards win). */
export const MAX_CANDIDATES = 600;

export interface LinkCandidate {
	path: string;
	id: string;
	title: string;
	tags: readonly string[];
	/** Last change of the note (ms since epoch); only a tie-breaker. */
	mtime: number;
}

export interface LinkQuery {
	title: string;
	tags: readonly string[];
	source?: string;
}

export interface LinkSuggestion {
	candidate: LinkCandidate;
	score: number;
	sharedTags: string[];
	/** Words that both titles use (folded). */
	sharedWords: string[];
}

const TAG_WEIGHT = 3;
const WORD_WEIGHT = 2;
const CONTAIN_WEIGHT = 2;

export function clampCount(n: unknown): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return LINK_SUGGEST_DEFAULT;
	return Math.min(LINK_SUGGEST_MAX, Math.max(LINK_SUGGEST_MIN, Math.round(n)));
}

const tagKey = (t: string) => foldText(t.trim().replace(/^#+/, ""));

function wordSet(text: string): Set<string> {
	return new Set(contentWords(text).map(foldText));
}

/** The most recently changed cards, at most `max`: keeps ranking cheap in a very large slip-box. */
export function boundCandidates<T extends { mtime: number }>(list: readonly T[], max = MAX_CANDIDATES): T[] {
	if (list.length <= max) return [...list];
	return [...list].sort((a, b) => b.mtime - a.mtime).slice(0, max);
}

/** Whether anything typed can suggest something (an empty form suggests nothing). */
export function hasSignal(q: LinkQuery): boolean {
	return foldText(q.title).trim().length >= 3 || q.tags.some((t) => tagKey(t)) || wordSet(q.source ?? "").size > 0;
}

/**
 * The cards worth linking, best first, at most `limit`. A card needs at least one real connection (a shared tag, a shared
 * word or a contained title); `exclude` holds paths that must not be offered (already linked or chosen).
 */
export function rankLinkSuggestions(q: LinkQuery, candidates: readonly LinkCandidate[], limit: number, exclude: ReadonlySet<string> = new Set()): LinkSuggestion[] {
	if (!hasSignal(q)) return [];
	const qTags = new Set(q.tags.map(tagKey).filter(Boolean));
	const qTitle = foldText(q.title).trim();
	const qWords = new Set([...wordSet(q.title), ...wordSet(q.source ?? "")]);
	const out: LinkSuggestion[] = [];
	for (const c of boundCandidates(candidates)) {
		if (exclude.has(c.path)) continue;
		const sharedTags = c.tags.filter((t) => qTags.has(tagKey(t)));
		const cTitle = foldText(c.title).trim();
		const sharedWords = [...wordSet(c.title)].filter((w) => qWords.has(w));
		const contained = qTitle.length >= 4 && cTitle.length >= 4 && (cTitle.includes(qTitle) || qTitle.includes(cTitle));
		if (sharedTags.length === 0 && sharedWords.length === 0 && !contained) continue;
		const score = sharedTags.length * TAG_WEIGHT + sharedWords.length * WORD_WEIGHT + (contained ? CONTAIN_WEIGHT : 0);
		out.push({ candidate: c, score, sharedTags, sharedWords });
	}
	out.sort((a, b) => b.score - a.score || b.candidate.mtime - a.candidate.mtime || a.candidate.path.localeCompare(b.candidate.path));
	return out.slice(0, clampCount(limit));
}

/** The minimum a chosen card needs to be found again after the dialog (a card record has more). */
export interface ChosenCard {
	path: string;
	id: string;
}

/**
 * The cards to link to the note just made, from the ones chosen in its dialog: each is looked up by its path, else by its id
 * (the card may have been renamed or moved while the dialog was open); the new note itself, cards that are gone and doubles
 * are left out.
 */
export function resolveChosen<T extends ChosenCard>(chosen: readonly ChosenCard[], byPath: ReadonlyMap<string, T>, byId: ReadonlyMap<string, T>, madePath: string): T[] {
	const out = new Map<string, T>();
	for (const c of chosen) {
		const found = byPath.get(c.path) ?? byId.get(c.id.toLowerCase());
		if (found && found.path !== madePath) out.set(found.path, found);
	}
	return [...out.values()];
}

/** What to tell the person after linking: failed (some link could not be written), none (all were linked already), one, or many. */
export function linkOutcome(linked: number, failed: number): "failed" | "none" | "one" | "many" {
	if (failed > 0) return "failed";
	return linked <= 0 ? "none" : linked === 1 ? "one" : "many";
}
