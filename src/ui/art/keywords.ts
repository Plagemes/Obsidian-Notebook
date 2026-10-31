// Keyword motifs (pure logic, no AI): a fixed, rule-based map from the words of a title to art families, in English and
// Italian. "Matematica" gets waves or a grid, "Biologia" venation or cells, "Fisica" orbits or fields, "Storia"
// contours... The choice among a topic's families is a hash of the title, so it is stable and varied.
import { hashString } from "./prng";

/** Every family the engine can draw (the seven of the document format plus the newer ones that are not stored in files). */
export type FamilyName = "contours" | "cells" | "waves" | "branches" | "flow" | "orbits" | "grid" | "veins";

export interface Topic {
	/** English identifier (not a UI string). */
	readonly id: string;
	/**
	 * Word stems: a word matches when it starts with the stem; a stem starting with "=" must match the whole word
	 * (short words such as "art" or "law" would otherwise match "start" or "lawn").
	 */
	readonly stems: readonly string[];
	/** The families the topic evokes, best first. */
	readonly families: readonly FamilyName[];
}

/**
 * The rules, checked in this order for each word of the title (the first word that matches a topic decides).
 * Diacritics and case are ignored. Append only: changing a rule changes the art of every notebook it matches.
 */
export const TOPICS: readonly Topic[] = [
	{ id: "mathematics", stems: ["matemat", "math", "algebr", "geometr", "calcol", "analisi", "analysis", "statist", "probabil", "trigonom", "aritmet", "arithmet", "topolog", "=numeri", "=numbers", "=limiti", "=limits", "=integrali", "=derivate"], families: ["waves", "grid"] },
	{ id: "biology", stems: ["=bio", "biolog", "biomed", "biomat", "biochim", "biotec", "biofis", "bioinf", "bioing", "anatom", "cell", "cytolog", "citolog", "istolog", "histolog", "fisiolog", "physiolog", "genetic", "botani", "zoolog", "ecolog", "patolog", "pathol", "farmac", "pharma", "neuro", "cardio", "medic", "infermier", "nurs", "immunolog", "microbiolog", "virolog", "embriolog", "organism", "=organi", "vegetal", "plant", "=health", "=salute"], families: ["veins", "cells", "branches"] },
	{ id: "physics", stems: ["fisic", "physic", "mecc", "mechan", "termodinam", "thermodynam", "elettro", "electro", "magnet", "quantis", "quantum", "astro", "ottic", "optic", "cosmo", "cinemat", "kinemat", "dinamic", "dynamic", "relativ", "ondulator", "=onde", "=waves"], families: ["orbits", "flow"] },
	{ id: "chemistry", stems: ["chimic", "chemi", "molecol", "molecul", "reazion", "reaction", "stechiom", "organica", "atom"], families: ["cells", "orbits", "grid"] },
	{ id: "history", stems: ["stori", "histor", "antich", "ancient", "archeolog", "archaeolog", "geograf", "geograph", "geolog", "cartograf", "medioev", "medieval", "rinascim", "renaissance", "civilt", "civiliz", "civilis", "=romano", "=romana", "=romani", "=roman", "=roma", "=egitto", "=egypt", "=grecia", "=greece", "territor", "paesagg", "landscape", "=mappe", "=maps"], families: ["contours", "flow"] },
	{ id: "computing", stems: ["informat", "comput", "=program", "programming", "programmaz", "coding", "algorit", "software", "=codice", "=code", "database", "=dati", "=data", "=reti", "=network", "cyber", "robot", "digital", "=web", "=ai", "machine"], families: ["grid", "flow", "waves"] },
	{ id: "language", stems: ["letterat", "literat", "grammat", "poesi", "poetr", "poem", "lingu", "language", "=italiano", "=inglese", "=english", "=latino", "=latin", "=greco", "=francese", "=french", "=spagnolo", "=spanish", "=tedesco", "=german", "narrativ", "romanz", "scrittur", "writing", "=testi", "=texts", "retoric", "rhetoric"], families: ["flow", "contours"] },
	{ id: "arts", stems: ["music", "=arte", "=arti", "=art", "=arts", "design", "disegn", "drawing", "pittur", "paint", "scultur", "sculpt", "archit", "=teatro", "=theatre", "=theater", "cinema", "fotograf", "photograph"], families: ["flow", "waves", "contours"] },
	{ id: "economics", stems: ["econom", "finanz", "financ", "business", "marketing", "contabil", "account", "=mercato", "=market", "=bilancio", "=budget", "=azienda", "=management"], families: ["grid", "waves"] },
	{ id: "law", stems: ["diritt", "giurid", "juridic", "=law", "=laws", "legisl", "=legge", "=leggi", "=civile", "=penale", "costituzion", "constitution"], families: ["grid", "contours"] },
	{ id: "earth", stems: ["ambient", "environment", "natur", "forest", "foresta", "clima", "climate", "ecosist", "agricolt", "agricult", "=terra", "=earth", "=mare", "=sea", "=ocean", "=oceani", "meteo", "weather"], families: ["veins", "contours", "flow"] },
	{ id: "philosophy", stems: ["filosof", "philosoph", "psicolog", "psycholog", "sociolog", "antropolog", "anthropolog", "pedagog", "=etica", "=ethics", "=logica", "=logic", "=mente", "=mind"], families: ["orbits", "contours", "flow"] },
];

/** The lower-case words of a title without diacritics: "Física — Meccànica 2" → ["fisica", "meccanica"]. */
export function wordsOf(title: string): string[] {
	let s = title.toLowerCase();
	try {
		s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
	} catch {
		// A runtime without normalize keeps the accents: stems still match the unaccented part.
	}
	return s.split(/[^a-z]+/).filter((w) => w.length > 0);
}

function matches(word: string, stem: string): boolean {
	return stem.startsWith("=") ? word === stem.slice(1) : word.startsWith(stem);
}

/** The topic of a title: the first word (left to right) that matches a rule decides; null if no word does. */
export function topicOf(title: string): Topic | null {
	for (const word of wordsOf(title)) {
		for (const topic of TOPICS) {
			for (const stem of topic.stems) if (matches(word, stem)) return topic;
		}
	}
	return null;
}

/**
 * The family a title evokes among `allowed` (default: all), or null when no topic matches or none of its families is
 * allowed. The pick among several families is a hash of the lower-cased title: stable, and not always the first.
 */
export function motifFor(title: string, allowed?: readonly FamilyName[]): FamilyName | null {
	const topic = topicOf(title);
	if (!topic) return null;
	const options = allowed ? topic.families.filter((f) => allowed.includes(f)) : topic.families;
	if (options.length === 0) return null;
	return options[hashString(`motif:${title.trim().toLowerCase()}`) % options.length]!;
}
