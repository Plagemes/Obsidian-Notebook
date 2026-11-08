/**
 * 0.25 (#84): going to a point of the history, step by step. Pure, no Obsidian. Every step is an ordinary `History.undo()` or
 * `History.redo()`, so the guards of the history apply to each one (a locked page, a change the writer would reject, the read-only
 * mode): when a step is refused the jump stops there, and the result says how far it got. Nothing here touches the document itself.
 */
import type { Command, History } from "./history";

/** Where to go: just after a step of the list, or before the oldest step the history still holds. */
export type JumpTarget = { readonly kind: "step"; readonly cmd: Command } | { readonly kind: "start" };

export interface JumpResult {
	/** Which way the jump went, or null when there was nowhere to go. */
	direction: "undo" | "redo" | null;
	/** How many steps it took to get there. */
	wanted: number;
	/** How many steps were taken. */
	done: number;
	/** The step is no longer in the history (it was undone past, dropped or refused since the list was drawn). */
	gone: boolean;
}

/** The part of `History` a jump needs (a test can give a smaller one). */
export type JumpHistory = Pick<History, "undo" | "redo" | "stepsTo" | "depth">;

/** The number of steps and the way to the target, or null when the step is not in the history. */
export function planJump(history: JumpHistory, target: JumpTarget): { direction: "undo" | "redo"; steps: number } | null {
	if (target.kind === "start") return { direction: "undo", steps: history.depth().undo };
	return history.stepsTo(target.cmd);
}

/**
 * Takes the steps one at a time through the history. A step the history refuses (it returns null: it said why itself) stops the jump,
 * which leaves the document wherever the last good step left it. A jump to where the document already is takes no step.
 */
export function jumpHistory(history: JumpHistory, target: JumpTarget): JumpResult {
	const plan = planJump(history, target);
	if (!plan) return { direction: null, wanted: 0, done: 0, gone: true };
	let done = 0;
	while (done < plan.steps) {
		const step = plan.direction === "undo" ? history.undo() : history.redo();
		if (!step) break;
		done++;
	}
	return { direction: plan.steps === 0 ? null : plan.direction, wanted: plan.steps, done, gone: false };
}
