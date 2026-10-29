/**
 * Names of conflicted copies created by sync clients (roadmap #122). Pure, no Obsidian imports.
 *
 * When two devices change the same file before syncing, the sync client keeps both versions and
 * gives one of them another name in the same folder. The patterns recognised here (sources and
 * caveats in docs/research.md, "Conflicted copies"):
 *
 * | Client | Example (`Notes.notebook`) |
 * |---|---|
 * | Google Drive (web, Android, Windows "keep both"), file managers | `Notes (1).notebook` |
 * | Google Drive for desktop | `[Conflict] Notes.notebook`, `Notes [Conflict].notebook` |
 * | OneDrive (Windows) | `Notes-DESKTOP-AB12CD.notebook`, `Notes-LAPTOP-2.notebook` (device name, optional counter) |
 * | OneDrive (macOS), Dropbox | `Notes (conflicted copy).notebook`, `Notes (Anna's conflicted copy 2026-10-29).notebook` |
 * | Autosync and other Android sync apps | `Notes (conflict 2026-10-29 14.05).notebook`, `Notes_conflict-20261029.notebook` |
 * | Syncthing | `Notes.sync-conflict-20261029-140500-ABCDEFG.notebook` |
 *
 * A name is only a hint. To stay conservative, a file is treated as a conflicted copy of `Notes` only
 * when (checked by the caller) `Notes.notebook` exists in the same folder, both files parse, and both
 * hold the same document id (a sync conflict copies the file, so the id is the same; an unrelated
 * notebook that happens to be called "Notes (1)" has its own id).
 *
 * `Notes (1)` is also what a browser download or a file manager copy is called, and such a copy keeps the id
 * too: it may be intentional (`mayBeManualCopy`). A copy identical to the main file (`sameNotebookText`)
 * holds nothing to merge and is not announced. Merging is always the user's choice.
 */
import { parse, serialize } from "../model/serialize";

/** OneDrive device name: up to 15 letters, digits and hyphens, with at least one letter, optionally "-<n>". */
const DEVICE_SUFFIX = /^(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{0,14}(?:-\d{1,3})?$/;

const PATTERNS: readonly RegExp[] = [
	/^(.+?) \(\d{1,3}\)$/, // Notes (1)
	/^(.+?) ?\([^()]*conflict[^()]*\)$/i, // Notes (conflicted copy …), Notes (conflict …)
	/^\[conflict\] ?(.+)$/i, // [Conflict] Notes
	/^(.+?) ?\[conflict\]$/i, // Notes [Conflict]
	/^(.+)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]{7})?$/, // Syncthing
	/^(.+?)[ _.-]+conflict(?:ed)?(?:[ _.-].*)?$/i, // Notes_conflict-…, Notes - conflict …
];

/**
 * File names (without extension) of which `stem` may be a conflicted copy, most specific first.
 * Empty when the name does not look like a conflicted copy.
 */
export function conflictBaseCandidates(stem: string): string[] {
	const out: string[] = [];
	const add = (base: string | undefined) => {
		const b = base?.trim();
		if (b && b !== stem && !out.includes(b)) out.push(b);
	};
	for (const re of PATTERNS) add(re.exec(stem)?.[1]);
	// OneDrive: "<name>-<device>" where the device name may itself contain hyphens: try every split.
	for (let i = stem.indexOf("-"); i > 0; i = stem.indexOf("-", i + 1)) {
		if (DEVICE_SUFFIX.test(stem.slice(i + 1))) add(stem.slice(0, i));
	}
	return out;
}

/** The base among `existing` (stems of the files in the same folder) of which `stem` may be a copy, or null. */
export function conflictBaseOf(stem: string, existing: ReadonlySet<string>): string | null {
	for (const base of conflictBaseCandidates(stem)) if (existing.has(base)) return base;
	return null;
}

/**
 * Whether `stem` is named like a copy the user may have made on purpose (`Notes (1)`: browser downloads, file
 * managers, Google Drive's "keep both") rather than only by a sync conflict.
 */
export function mayBeManualCopy(stem: string, base: string): boolean {
	const m = PATTERNS[0]!.exec(stem);
	return m?.[1]?.trim() === base;
}

/** Whether two notebook files hold the same notebook content: the same text, or the same document once parsed. */
export function sameNotebookText(a: string, b: string): boolean {
	if (a === b) return true;
	const x = parse(a);
	const y = parse(b);
	return x.ok && y.ok && serialize(x.doc) === serialize(y.doc);
}

/** Stems in `siblings` that may be conflicted copies of `base`. */
export function conflictCopiesOf(base: string, siblings: readonly string[]): string[] {
	return siblings.filter((s) => s !== base && conflictBaseCandidates(s).includes(base));
}
