/**
 * Cover pictures (0.22 review fix D10). A picture chosen as a cover is stored as a content-addressed asset: the same picture twice is
 * one file, so two "Use this cover" with it may meet. Applies run one after the other, and a picture that a failed apply created is
 * trashed only when nothing else points at it any more. Pure: no 'obsidian'.
 */

/** Runs tasks one at a time, in the order they were queued; a failed task does not stop the next. */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

/**
 * Whether a failed apply may trash the cover picture it stored: only a file that this call created, and that no open notebook, no
 * other cover change and no notebook this session has read points at.
 */
export function mayTrashCoverAsset(created: boolean, referencedElsewhere: boolean): boolean {
	return created && !referencedElsewhere;
}
