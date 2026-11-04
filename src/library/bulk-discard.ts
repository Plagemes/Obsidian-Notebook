// 0.16 (#80) Bulk import: whether a stored asset copy may be thrown away again. Pure logic around a `read` callback, no Obsidian.
import { scanNotebookText } from "./library-check";

/** One notebook file of the library: its text is read only when the check needs it. */
export interface DiscardCandidate {
	read(): Promise<string>;
}

/**
 * Whether the asset `assetId` may be moved to the trash: no notebook of the library names it. A notebook whose text is still
 * arriving from the sync client (the asset file may be missing here for the same reason), one that cannot be read, or one that
 * names the id (even when it does not parse) means "keep it": the copy costs disk space, a lost picture costs the user's work.
 */
export async function mayDiscardAsset(assetId: string, notebooks: Iterable<DiscardCandidate>): Promise<boolean> {
	const token = assetId.slice(0, 24).toLowerCase();
	for (const nb of notebooks) {
		let text: string;
		try {
			text = await nb.read();
		} catch {
			return false;
		}
		const scan = scanNotebookText(text, null);
		if (scan.status === "not-downloaded") return false;
		if (scan.tokens.has(token)) return false;
	}
	return true;
}
