/**
 * Zettelkasten system hygiene (roadmap Z10): finds cards nothing links to or from, likely duplicates and cards without a
 * typed title. Pure: no 'obsidian', no file access (the caller reads the notes and passes `read`), so it runs in Node tests.
 * Detection only: nothing here writes or deletes; fixing actions live in `hygiene-view.ts` and always ask first.
 */
import type { CardRecord } from "./card-content";
import { formatRegion } from "./subpath";

/** A card as the checks see it. */
export type HygieneCard = Pick<CardRecord, "path" | "id" | "title" | "notebookId" | "pageId" | "region" | "links">;

export type DuplicateReason = "title" | "page" | "text";

export interface DuplicateGroup {
	reasons: DuplicateReason[];
	cards: HygieneCard[];
}

export interface HygieneReport {
	scanned: number;
	/** Cards with no link to or from another note. */
	unlinked: HygieneCard[];
	/** Cards without a typed title. */
	untitled: HygieneCard[];
	duplicates: DuplicateGroup[];
}

/** Near-identical text: Jaccard similarity of two-word shingles at or above this. */
export const NEAR_SIMILARITY = 0.85;
/** Texts shorter than this many words are never compared (too little to call a duplicate). */
export const MIN_TEXT_WORDS = 6;
/** A candidate bucket larger than this is boilerplate shared by many notes: skipped. */
const MAX_BUCKET = 40;
const SIGNATURE = 12;
const BAND_ROWS = 3;

/** Title key: lower case, accents and punctuation dropped, spaces collapsed; "" for no title. */
export function titleKey(title: string): string {
	return title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The words of a card note's own text: the body without frontmatter, embeds and the transcription heading. */
export function cardBodyText(raw: string): string {
	const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
	return body.split(/\r?\n/).filter((l) => !/^\s*!\[\[.*\]\]\s*$/.test(l) && !/^\s*##\s+Transcription\s*$/i.test(l)).join(" ");
}

export function words(text: string): string[] {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function hash(s: string, seed: number): number {
	let h = (2166136261 ^ seed) >>> 0;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return h;
}

function shingles(ws: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 1 < ws.length; i++) out.add(`${ws[i]} ${ws[i + 1]}`);
	return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const x of small) if (large.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

/** Band keys of a shingle set (min-hash): two sets that are nearly the same share at least one with high probability. */
function bandKeys(set: ReadonlySet<string>): string[] {
	const sig: number[] = [];
	for (let k = 0; k < SIGNATURE; k++) {
		let min = 0xffffffff;
		for (const s of set) {
			const h = hash(s, k * 7919 + 1);
			if (h < min) min = h;
		}
		sig.push(min);
	}
	const keys: string[] = [];
	for (let b = 0; b < SIGNATURE / BAND_ROWS; b++) keys.push(`${b}:${sig.slice(b * BAND_ROWS, (b + 1) * BAND_ROWS).join(",")}`);
	return keys;
}

/**
 * Paths of notes linked to or from at least one OTHER note. `outgoing` is the link graph (source path to the paths it
 * links to, notes only); a card's own `links` property is added as outgoing links (resolved by `resolve`, null: none).
 */
export function linkedPaths(
	cards: readonly HygieneCard[], outgoing: ReadonlyMap<string, ReadonlySet<string>>, resolve: (card: HygieneCard, link: string) => string | null = () => null,
): Set<string> {
	const linked = new Set<string>();
	const mark = (from: string, to: string) => {
		if (from === to) return;
		linked.add(from);
		linked.add(to);
	};
	const wanted = new Set(cards.map((c) => c.path));
	for (const [from, targets] of outgoing) {
		for (const to of targets) if (wanted.has(from) || wanted.has(to)) mark(from, to);
	}
	for (const card of cards) {
		for (const link of card.links) {
			const to = resolve(card, link);
			if (to) mark(card.path, to);
		}
	}
	return linked;
}

class Union {
	private readonly parent = new Map<string, string>();
	find(x: string): string {
		let r = this.parent.get(x) ?? x;
		while ((this.parent.get(r) ?? r) !== r) r = this.parent.get(r)!;
		this.parent.set(x, r);
		return r;
	}
	join(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

export interface ScanDeps {
	cards: readonly HygieneCard[];
	outgoing: ReadonlyMap<string, ReadonlySet<string>>;
	resolve?: (card: HygieneCard, link: string) => string | null;
	/** The text of a card's note (null: unreadable, the card is then compared by title and page only). */
	read: (card: HygieneCard) => Promise<string | null>;
	/** Resolves after letting the UI breathe (a macrotask). */
	idle: () => Promise<void>;
	/** Milliseconds of work between two `idle()` calls. */
	sliceMs?: number;
	now?: () => number;
	cancelled?: () => boolean;
	progress?: (done: number, total: number) => void;
}

/** Runs the checks in idle slices. Null when cancelled. Never writes anything. */
export async function scanHygiene(deps: ScanDeps): Promise<HygieneReport | null> {
	const { cards } = deps;
	const now = deps.now ?? (() => Date.now());
	const slice = deps.sliceMs ?? 12;
	let t0 = now();
	const breathe = async (): Promise<boolean> => {
		if (now() - t0 < slice) return false;
		await deps.idle();
		t0 = now();
		return deps.cancelled?.() === true;
	};

	const linked = linkedPaths(cards, deps.outgoing, deps.resolve);
	const unlinked = cards.filter((c) => !linked.has(c.path));
	const untitled = cards.filter((c) => c.title.trim() === "");

	const union = new Union();
	const reasons = new Map<string, Set<DuplicateReason>>();
	const byPath = new Map(cards.map((c) => [c.path, c]));
	const pair = (a: string, b: string, why: DuplicateReason) => {
		union.join(a, b);
		for (const p of [a, b]) {
			const set = reasons.get(p) ?? new Set<DuplicateReason>();
			set.add(why);
			reasons.set(p, set);
		}
	};
	const bucketPairs = (buckets: Map<string, string[]>, why: DuplicateReason) => {
		for (const members of buckets.values()) {
			if (members.length < 2) continue;
			for (let i = 1; i < members.length; i++) pair(members[0]!, members[i]!, why);
		}
	};
	const push = (m: Map<string, string[]>, key: string, path: string) => {
		const list = m.get(key);
		if (list) list.push(path);
		else m.set(key, [path]);
	};

	const titles = new Map<string, string[]>();
	const pages = new Map<string, string[]>();
	for (const c of cards) {
		const key = titleKey(c.title);
		if (key) push(titles, key, c.path);
		push(pages, `${c.notebookId}/${c.pageId}/${c.region ? formatRegion(c.region) : ""}`, c.path);
	}
	bucketPairs(titles, "title");
	bucketPairs(pages, "page");

	// Text: read each note (a slice at a time), exact matches by key, near matches through min-hash bands.
	const exact = new Map<string, string[]>();
	const bands = new Map<string, string[]>();
	const sets = new Map<string, Set<string>>();
	let done = 0;
	for (const card of cards) {
		if (deps.cancelled?.()) return null;
		const raw = await deps.read(card).catch(() => null);
		if (raw !== null) {
			const ws = words(cardBodyText(raw));
			if (ws.length >= MIN_TEXT_WORDS) {
				push(exact, ws.join(" "), card.path);
				const set = shingles(ws);
				sets.set(card.path, set);
				for (const k of bandKeys(set)) push(bands, k, card.path);
			}
		}
		deps.progress?.(++done, cards.length);
		if (await breathe()) return null;
	}
	bucketPairs(exact, "text");
	for (const members of bands.values()) {
		if (members.length < 2 || members.length > MAX_BUCKET) continue;
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				const a = members[i]!;
				const b = members[j]!;
				if (union.find(a) === union.find(b)) continue;
				if (jaccard(sets.get(a)!, sets.get(b)!) >= NEAR_SIMILARITY) pair(a, b, "text");
			}
		}
		if (await breathe()) return null;
	}

	const groups = new Map<string, HygieneCard[]>();
	for (const p of reasons.keys()) {
		const card = byPath.get(p);
		if (!card) continue;
		const root = union.find(p);
		const list = groups.get(root);
		if (list) list.push(card);
		else groups.set(root, [card]);
	}
	const duplicates: DuplicateGroup[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const why = new Set<DuplicateReason>();
		for (const m of members) for (const r of reasons.get(m.path) ?? []) why.add(r);
		members.sort(byId);
		duplicates.push({ reasons: (["title", "page", "text"] as const).filter((r) => why.has(r)), cards: members });
	}
	duplicates.sort((a, b) => byId(a.cards[0]!, b.cards[0]!));
	unlinked.sort(byId);
	untitled.sort(byId);
	return { scanned: cards.length, unlinked, untitled, duplicates };
}

function byId(a: HygieneCard, b: HygieneCard): number {
	return a.id.localeCompare(b.id, undefined, { numeric: true }) || a.path.localeCompare(b.path);
}
