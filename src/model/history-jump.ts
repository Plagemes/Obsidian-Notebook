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
export type JumpHistory = Pick<History, "undo" | "redo" | "stepsTo" | "depth" | "runSteps">;

/** The number of steps and the way to the target, or null when the step is not in the history. */
export function planJump(history: JumpHistory, target: JumpTarget): { direction: "undo" | "redo"; steps: number } | null {
	if (target.kind === "start") return { direction: "undo", steps: history.depth().undo };
	return history.stepsTo(target.cmd);
}

/**
 * A jump taken in slices (review fix): a jump of hundreds of steps on a large notebook blocks the screen for seconds when it runs in one go
 * (every step checks the whole document, as an ordinary Undo does). `advance` takes steps until the time budget is used and says whether the
 * jump is over; the caller lets the screen breathe between slices. The steps are the same ordinary `History.undo()` / `History.redo()`, one
 * after the other, so the outcome (and the stop at a refused step) is exactly that of one go.
 */
export class JumpRunner {
	private readonly plan: { direction: "undo" | "redo"; steps: number } | null;
	private taken = 0;
	private over = false;

	constructor(private readonly history: JumpHistory, target: JumpTarget) {
		this.plan = planJump(history, target);
		this.over = this.plan === null || this.plan.steps === 0;
	}

	get wanted(): number {
		return this.plan?.steps ?? 0;
	}

	get done(): number {
		return this.taken;
	}

	get finished(): boolean {
		return this.over;
	}

	/** Takes steps for about `budgetMs` (at least one). True when the jump is over: all steps taken, or one was refused. */
	advance(budgetMs: number, now: () => number = () => performance.now()): boolean {
		const plan = this.plan;
		if (this.over || !plan) return true;
		const stop = now() + budgetMs;
		this.history.runSteps(() => {
			do {
				const step = plan.direction === "undo" ? this.history.undo() : this.history.redo();
				if (!step) {
					this.over = true;
					return;
				}
				this.taken++;
			} while (this.taken < plan.steps && now() < stop);
		});
		if (this.taken >= plan.steps) this.over = true;
		return this.over;
	}

	result(): JumpResult {
		if (!this.plan) return { direction: null, wanted: 0, done: 0, gone: true };
		return { direction: this.plan.steps === 0 ? null : this.plan.direction, wanted: this.plan.steps, done: this.taken, gone: false };
	}
}

/**
 * Takes the steps one at a time through the history. A step the history refuses (it returns null: it said why itself) stops the jump,
 * which leaves the document wherever the last good step left it. A jump to where the document already is takes no step.
 */
export function jumpHistory(history: JumpHistory, target: JumpTarget): JumpResult {
	const runner = new JumpRunner(history, target);
	runner.advance(Number.POSITIVE_INFINITY);
	return runner.result();
}

/** What `finishJump` needs from its surroundings (the view gives the real ones, a test gives plain functions). */
export interface JumpPacing {
	/** How long one slice may run, in ms. */
	budgetMs: number;
	/** The clock the budget is read on (a test gives its own). */
	now?: () => number;
	/** Lets the screen draw and the input run before the next slice. */
	yieldToUi(): Promise<void>;
	/** Called after every slice with the steps taken so far and the steps wanted. */
	progress?(done: number, wanted: number): void;
	/** False when the jump must stop where it is (the notebook was closed or replaced): the steps taken stay taken. */
	keepGoing?(): boolean;
}

/** Takes the rest of a jump slice by slice, yielding between them; the result is the same as the jump in one go (or stops early when asked to). */
export async function finishJump(runner: JumpRunner, pacing: JumpPacing): Promise<JumpResult> {
	pacing.progress?.(runner.done, runner.wanted);
	while (!runner.finished && (pacing.keepGoing?.() ?? true)) {
		await pacing.yieldToUi();
		if (!(pacing.keepGoing?.() ?? true)) break;
		runner.advance(pacing.budgetMs, pacing.now);
		pacing.progress?.(runner.done, runner.wanted);
	}
	return runner.result();
}
