/**
 * A per-path "busy" mark that others can wait on (pure; no Obsidian). A job that must not overlap another on the same file
 * takes it with `acquire`; a job that may not be skipped uses `acquireWhenFree`; a job that may be skipped
 * just checks `has`.
 */
export class PathLock {
	private readonly held = new Map<string, Promise<void>>();

	has(path: string): boolean {
		return this.held.has(path);
	}

	/** Marks `path` busy; the returned function frees it. Only call it when `has(path)` is false. */
	acquire(path: string): () => void {
		let free: () => void = () => undefined;
		this.held.set(path, new Promise<void>((resolve) => {
			free = resolve;
		}));
		return () => {
			this.held.delete(path);
			free();
		};
	}

	/** Waits until `path` is free, then takes it (several waiters take it one after the other, never together). */
	async acquireWhenFree(path: string): Promise<() => void> {
		for (let held = this.held.get(path); held; held = this.held.get(path)) await held;
		return this.acquire(path);
	}
}
