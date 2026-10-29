/**
 * Which pages of a slip-box were made on this device in this session (Z2). Pure: no 'obsidian'.
 *
 * A slip-box gives a card only to those pages by itself. A page that came from another device (or existed before the
 * notebook was first seen here) may have a card there whose note has not synced yet, so making one here would give
 * the page two cards. The first look at a notebook records its pages; pages that arrive through sync are recorded
 * when the file changes, before this device's next save includes them.
 */
export class LocalPages {
	private readonly known = new Map<string, Set<string>>();

	/** Whether the pages of this document have been recorded in this session. */
	seen(docId: string): boolean {
		return this.known.has(docId);
	}

	/** Records pages as not made here (or as dealt with). */
	know(docId: string, pageIds: Iterable<string>): void {
		let set = this.known.get(docId);
		if (!set) this.known.set(docId, (set = new Set()));
		for (const id of pageIds) set.add(id);
	}

	/**
	 * Pages of the document that were not known: made on this device since the first look. The first look itself
	 * records every page and returns none.
	 */
	fresh(docId: string, pageIds: readonly string[]): Set<string> {
		const set = this.known.get(docId);
		if (!set) {
			this.know(docId, pageIds);
			return new Set();
		}
		return new Set(pageIds.filter((id) => !set.has(id)));
	}
}
