// 0.26 redact (#285), review fix T7: when the boxes changed in the Redact dialog reach the device. Kept apart from the dialog so it is
// tested without Obsidian.
// - Readable boxes: every change is handed over at once (nothing drawn is lost if the dialog never closes cleanly), and a set equal to
//   the last one handed over is not handed over again, so closing with Escape or × after a draw and an undo leaves the stored boxes as
//   they were.
// - Boxes that could not be read: nothing is handed over until Done, so a draw and an undo (or any change) closed with Escape or × never
//   replaces the unreadable state with "no boxes"; exports stay refused until the reader presses Done or resets the storage. After a
//   reset the storage is empty and readable, so what the dialog shows is handed over at once and changes go on as for readable boxes.
import type { Redactions } from "../model/redact";

const keyOf = (boxes: Redactions): string => JSON.stringify(boxes);

export class RedactCommits {
	private held: boolean;
	private last: string;

	constructor(private readonly commit: (boxes: Redactions) => void, initial: Redactions, unreadable: boolean) {
		this.held = unreadable;
		this.last = keyOf(initial);
	}

	/** A change in the dialog. */
	change(next: Redactions): void {
		if (!this.held) this.hand(next);
	}

	/** The storage was reset (empty and readable): what the dialog shows is handed over now. */
	reset(current: Redactions): void {
		this.held = false;
		this.last = keyOf({});
		this.hand(current);
	}

	/** The dialog closed: Done hands the set over as it is, even unchanged (it sets boxes that could not be read); Escape or × only what changed. */
	close(current: Redactions, done: boolean): void {
		if (done) {
			this.last = keyOf(current);
			this.commit(current);
		} else if (!this.held) {
			this.hand(current);
		}
	}

	private hand(next: Redactions): void {
		const key = keyOf(next);
		if (key === this.last) return;
		this.last = key;
		this.commit(next);
	}
}
