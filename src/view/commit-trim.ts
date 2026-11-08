import { planPenUpTrim } from "../ink/hook-clean";
import type { Command, History } from "../model/history";
import type { Page, Stroke } from "../model/types";

/**
 * 0.23 (#314) review fixes, the view side of "Trim hooks as you write", kept apart from the big view so it can be tested with a real
 * `History` (no 'obsidian' import). The stroke is committed as written; the trim follows as its own undo step whose replacement is the
 * very object the renderer already drew, so the static layer is not redrawn. `retractCommit` takes the stroke and its trim back together.
 */

/** What the last pen contact committed: its ids, the step that holds the stroke and, when a hook was cut, the trim step after it. */
export interface Committed {
	ids: ReadonlySet<string>;
	cmd: Command;
	trim?: Command;
}

const trimSteps = new WeakSet<Command>();

/** Whether `cmd` is the trim step of a stroke (the first Undo after a trim restores the hook only: the view says so). */
export function isTrimStep(cmd: Command | null | undefined): boolean {
	return !!cmd && trimSteps.has(cmd);
}

/**
 * Runs the trim of the stroke `id` (already committed on `page`) into `trimmed`, as its own history step. Returns the step, or null
 * when nothing was recorded (the stroke is not on the page, the page is locked, the guard refused it). The caller redraws the static
 * layer only when this returns null after it showed `trimmed`, or when it redrew the layer from the raw model meanwhile.
 */
export function commitTrim(history: Pick<History, "execute">, page: Page, id: string, trimmed: Stroke, committed: Committed | null): Command | null {
	const plan = planPenUpTrim(page, id, trimmed);
	if (!plan || !history.execute(plan.command)) return null;
	trimSteps.add(plan.command);
	if (committed) committed.trim = plan.command;
	return plan.command;
}

export interface Retracted {
	/** The contact was taken back completely (the caller replays it as the eraser). */
	ok: boolean;
	/** The document changed (at least one step was undone): the caller redraws and schedules a save even when `ok` is false. */
	changed: boolean;
}

/** Undoes the stroke of `c` and its trim step, only when they are the latest steps and nothing waits to be redone. */
export function retractCommit(history: Pick<History, "pending" | "undo" | "canRedo">, c: Committed): Retracted {
	if (history.canRedo()) return { ok: false, changed: false };
	const steps = history.pending();
	const last = steps[steps.length - 1];
	if (c.trim) {
		if (last !== c.trim || steps[steps.length - 2] !== c.cmd) return { ok: false, changed: false };
	} else if (last !== c.cmd) return { ok: false, changed: false };
	let changed = false;
	if (c.trim) {
		const undone = history.undo();
		if (!undone) return { ok: false, changed };
		changed = true;
		if (undone !== c.trim) return { ok: false, changed };
	}
	const undone = history.undo();
	if (undone) changed = true;
	return { ok: undone === c.cmd, changed };
}
