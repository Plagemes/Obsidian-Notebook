/**
 * 0.15: tells the open library views that the Board's columns changed (the editor was used, from the board or from the
 * settings), so they draw the new columns. The columns themselves are a setting (`boardColumns`); this carries no data.
 * Pure: no 'obsidian'.
 */
const listeners = new Set<() => void>();

/** Runs `fn` after the board columns changed. Returns the unsubscribe function. */
export function onBoardColumnsChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}

export function emitBoardColumnsChanged(): void {
	for (const fn of [...listeners]) {
		try {
			fn();
		} catch (e) {
			console.error("[notebook] board columns listener failed", e);
		}
	}
}
