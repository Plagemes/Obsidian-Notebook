/**
 * 0.24 tagsuggest (#411): tags suggested from context while the person edits tags. Pure: no 'obsidian', no AI, no network.
 *
 * Sources, strongest first: the course of the class linked to the notebook (timetable), tags that sibling notebooks of
 * the same folder use, frequent words of the written text and headings, and the kinds of markers and boxes on the page
 * (question, homework, definition...). Nothing is stored: the list is computed when the editor opens.
 */
import { normalizeTag, tagKey } from "./tags";
import { normalizePageTag } from "./page-tags";

export const MAX_SUGGESTIONS = 6;

/** Words that never make a tag (English and Italian, lower case, accents folded). */
const STOP_WORDS = new Set(
	(
		"about above after again all also always among and any are because been before being below between both but can cannot could did does doing down during each " +
		"either else even ever every few for from further had has have having her here hers him his how however into its itself just like many may might more most much must " +
		"neither never nor not now off once only onto other our ours out over own per same shall she should since some such than that the their them then there these they this " +
		"those through thus too under until upon very was were what when where whether which while who whom whose why will with within without would yes yet you your " +
		"alla alle allo agli all anche ancora assai avere aveva avevano che chi ciascuno come con contro cui dal dall dalla dalle dallo dai dagli dei del dell della delle dello degli " +
		"dentro dopo dove due ecco era erano essere fra fino fuori gli hanno ho invece loro lui maggior mai mentre molto molti nel nell nella nelle nello nei negli noi non nostro " +
		"nostra nostri nostre oltre ogni oppure per perche perché poi pero però piu più possono prima proprio quale quali quando quanto quella quelle quelli quello questa queste " +
		"questi questo qui sarà sarebbe sono sopra sotto sua sue suo suoi sul sull sulla sulle sullo sui sugli tra tre tua tue tuo tuoi tutti tutto una uno uno verso vostro " +
		"fatto fare essere stato stata stati state sia siano sei sia siamo siete"
	).split(/\s+/),
);

const foldWord = (w: string) => w.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

export function isStopWord(word: string): boolean {
	const lower = word.toLowerCase();
	return STOP_WORDS.has(lower) || STOP_WORDS.has(foldWord(lower));
}

/** Shortest word that can become a tag. */
export const MIN_WORD_LENGTH = 4;

/** Content words of a text, lower case, in order of appearance: no stop-words, no numbers, no short words. */
export function contentWords(text: string): string[] {
	const out: string[] = [];
	for (const match of text.toLowerCase().matchAll(/[\p{L}][\p{L}\p{M}'’-]*/gu)) {
		const word = match[0].replace(/^['’-]+|['’-]+$/g, "");
		if ([...word].length < MIN_WORD_LENGTH || isStopWord(word)) continue;
		out.push(word);
	}
	return out;
}

/** Tag for a marker or box kind on the page; kinds that say nothing about the content (gap, importance) give none. */
const KIND_TAGS: Readonly<Record<string, string>> = {
	question: "questions",
	homework: "homework",
	definition: "definitions",
	theorem: "theorems",
	example: "examples",
	proof: "proofs",
};

export function tagForKind(kind: string): string | null {
	return KIND_TAGS[kind] ?? null;
}

export type TagStyle = "obsidian" | "page";

export interface TagSuggestInput {
	/** Course of the class linked to the notebook or its folder. */
	course?: string | null;
	/** The tags of each sibling notebook of the same folder. */
	siblingTags?: ReadonlyArray<readonly string[]>;
	/** Headings of the notebook or page (weigh more than plain text). */
	headings?: readonly string[];
	/** Written or recognised text. */
	text?: readonly string[];
	/** Kinds of the markers and boxes present. */
	kinds?: readonly string[];
	/** Tags already on the target: never suggested again. */
	existing?: readonly string[];
	/** `obsidian` (notebook tags: no spaces) or `page` (page tags keep spaces). Default `obsidian`. */
	style?: TagStyle;
	limit?: number;
}

interface Candidate {
	tag: string;
	score: number;
	order: number;
}

const COURSE_SCORE = 1000;
const SIBLING_SCORE = 100;
const KIND_SCORE = 40;
const HEADING_WEIGHT = 3;
/** A word needs this weight (occurrences, headings count 3) before it is suggested. */
const MIN_WORD_WEIGHT = 3;
const WORD_SCORE = 10;

/** Ranked tag suggestions for the context (at most `limit`, default 6), without the tags already there. */
export function suggestFromContext(input: TagSuggestInput): string[] {
	const style = input.style ?? "obsidian";
	const limit = Math.max(0, input.limit ?? MAX_SUGGESTIONS);
	const norm = (raw: string): string | null => (style === "page" ? normalizePageTag(raw) : normalizeTag(raw));
	const taken = new Set<string>();
	for (const tag of input.existing ?? []) {
		taken.add(tagKey(tag));
		const n = norm(tag);
		if (n !== null) taken.add(tagKey(n));
	}
	const found = new Map<string, Candidate>();
	let order = 0;
	const bump = (raw: string, score: number) => {
		const tag = norm(raw);
		if (tag === null) return;
		const key = tagKey(tag);
		if (taken.has(key)) return;
		const known = found.get(key);
		if (known) known.score += score;
		else found.set(key, { tag, score, order: order++ });
	};

	if (input.course && input.course.trim()) bump(input.course, COURSE_SCORE);

	// One vote per sibling notebook and tag.
	for (const tags of input.siblingTags ?? []) {
		const voted = new Set<string>();
		for (const raw of tags) {
			const tag = norm(raw);
			if (tag === null || voted.has(tagKey(tag))) continue;
			voted.add(tagKey(tag));
			bump(tag, SIBLING_SCORE);
		}
	}

	for (const kind of new Set(input.kinds ?? [])) {
		const tag = tagForKind(kind);
		if (tag) bump(tag, KIND_SCORE);
	}

	const weight = new Map<string, number>();
	const count = (texts: readonly string[] | undefined, w: number) => {
		for (const text of texts ?? []) for (const word of contentWords(text)) weight.set(word, (weight.get(word) ?? 0) + w);
	};
	count(input.headings, HEADING_WEIGHT);
	count(input.text, 1);
	for (const [word, w] of weight) if (w >= MIN_WORD_WEIGHT) bump(word, WORD_SCORE + Math.min(w, 50));

	return [...found.values()]
		.sort((a, b) => b.score - a.score || a.order - b.order || a.tag.localeCompare(b.tag))
		.slice(0, limit)
		.map((c) => c.tag);
}
