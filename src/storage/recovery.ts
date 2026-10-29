/**
 * Sources for the repair of a damaged notebook (roadmap #140): the damaged file itself, the instant
 * save journal, version-history snapshots and backup copies. Pure, no Obsidian imports; the vault side
 * that lists the files lives in src/integration/reliability.ts.
 *
 * Every source is run through `repairNotebookText`, and the candidates are ranked: most recovered
 * items first (strokes + elements + pages), then the newest, then file > journal > snapshot > backup.
 * The caller shows them all and preselects the first.
 */
import { mergeChangeCount, planMerge } from "../model/merge";
import { repairNotebookText, recoveredItems, type RepairSummary } from "../model/repair";
import { parse, serializeChecked } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { applyHunks, decodeEntry, fingerprint, splitLines, type JournalSlotFile } from "./journal";

export type SourceKind = "file" | "journal" | "snapshot" | "backup";

export interface RecoverySource {
	kind: SourceKind;
	/** File path or description, for display. */
	label: string;
	/** When this version was written, if known. */
	date: Date | null;
	text: string;
}

export interface RecoveryCandidate {
	source: RecoverySource;
	doc: NotebookDocument;
	/** Serialized, checked text of `doc`. */
	text: string;
	summary: RepairSummary;
	/** Recovered items, the ranking key. */
	score: number;
}

const KIND_ORDER: Readonly<Record<SourceKind, number>> = { file: 0, journal: 1, snapshot: 2, backup: 3 };

/** Repairs every source and ranks the usable ones, best first. Sources with identical text are tried once. */
export function rankSources(sources: readonly RecoverySource[], now: Date = new Date()): RecoveryCandidate[] {
	const seen = new Set<string>();
	const out: RecoveryCandidate[] = [];
	for (const source of sources) {
		if (seen.has(source.text)) continue;
		seen.add(source.text);
		const r = repairNotebookText(source.text, now);
		if (!r.ok) continue;
		out.push({ source, doc: r.doc, text: r.text, summary: r.summary, score: recoveredItems(r.summary) });
	}
	return out.sort((a, b) =>
		b.score - a.score
		|| (b.source.date?.getTime() ?? 0) - (a.source.date?.getTime() ?? 0)
		|| KIND_ORDER[a.source.kind] - KIND_ORDER[b.source.kind]);
}

/**
 * Complete notebook texts that can be rebuilt from journal slot files of document `docId`: "full"
 * entries as they are; "delta" entries only on top of one of `bases` (texts they were written against,
 * checked by fingerprint), and only when the result has the fingerprint the entry recorded.
 * Newest first. Never throws.
 */
export function journalTexts(files: readonly JournalSlotFile[], docId: string, bases: readonly string[]): Array<{ text: string; savedAt: string }> {
	const entries = files
		.map((f) => decodeEntry(f.text))
		.filter((e): e is NonNullable<typeof e> => e !== null && e.doc === docId)
		.sort((a, b) => b.seq - a.seq);
	const byFp = new Map<string, string>();
	for (const b of bases) byFp.set(fingerprint(b), b);
	const out: Array<{ text: string; savedAt: string }> = [];
	for (const e of entries) {
		let text: string | null = null;
		if (e.full !== undefined) {
			text = e.full;
		} else if (e.hunks) {
			const base = byFp.get(e.base);
			if (base !== undefined) text = applyHunks(splitLines(base), e.hunks)?.join("\n") ?? null;
		}
		if (text !== null && fingerprint(text) === e.result) out.push({ text, savedAt: e.savedAt });
	}
	return out;
}

/** Date of a backup file name: `<name> <YYYYMMDD-HHmmss> <reason> [n ]<hash>.bak` (see VaultDocumentIO.backup). */
export function backupDate(name: string): Date | null {
	const m = / (\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}) [a-z-]+ (?:\d+ )?[0-9a-f]{8}\.bak$/.exec(name);
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
	const date = new Date(y, mo - 1, d, h, mi, s);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** True for a backup copy of the notebook named `basename` (backups are named after the file). */
export function isBackupOf(name: string, basename: string): boolean {
	return name.startsWith(`${basename} `) && backupDate(name) !== null && name.slice(basename.length + 1).match(/^\d{8}-\d{6} /) !== null;
}

/**
 * Union of two candidates (`first` as the base, everything of `second` added by the merge rules of
 * #122): nothing of either is left out. Null when it adds nothing to `first` or cannot be serialized.
 */
export function combineCandidates(first: RecoveryCandidate, second: RecoveryCandidate): { doc: NotebookDocument; text: string; added: number } | null {
	const base = parse(first.text);
	if (!base.ok) return null;
	const plan = planMerge(base.doc, second.doc);
	const added = mergeChangeCount(plan.summary);
	if (!plan.command || added === 0) return null;
	plan.command.apply(base.doc);
	const checked = serializeChecked(base.doc, true);
	if (!checked.ok) return null;
	const again = parse(checked.text);
	return again.ok ? { doc: again.doc, text: checked.text, added } : null;
}
