import type { TFile, App } from "obsidian";
import type { ClipContent } from "../ink/clipboard";
import { SIGNATURE_STAMP_NAME } from "../ink/signature";
import { listStampFiles, loadStamp, saveStamp } from "./stamps";

/**
 * The signature (roadmap 154) is an ordinary personal stamp called "My signature" (src/storage/stamps.ts), so it syncs
 * with the vault and shows in the stamp palette. Saving a new one never overwrites or deletes the old: the newest file whose
 * name is "My signature" (or "My signature 2", …) is the one in use.
 */

const NAME = new RegExp(`^${SIGNATURE_STAMP_NAME}( \d+)?$`, "i");

/** The signature file in use, or null. */
export function findSignatureFile(app: App, notebooksFolder: string): TFile | null {
	let best: TFile | null = null;
	for (const f of listStampFiles(app, notebooksFolder)) {
		if (NAME.test(f.basename) && (!best || f.stat.mtime >= best.stat.mtime)) best = f;
	}
	return best;
}

/** The clip of the signature in use; null when there is none or it cannot be read. */
export async function loadSignature(app: App, notebooksFolder: string): Promise<ClipContent | null> {
	const file = findSignatureFile(app, notebooksFolder);
	if (!file) return null;
	const loaded = await loadStamp(app, file);
	return loaded.ok ? loaded.clip : null;
}

/** Saves `clip` as the signature in use. Throws a readable error when it cannot. */
export async function saveSignature(app: App, notebooksFolder: string, clip: ClipContent): Promise<TFile> {
	return saveStamp(app, notebooksFolder, SIGNATURE_STAMP_NAME, clip);
}
