/** Back/forward through the visited pages (roadmap 18): the session's history and the rules for using it. No 'obsidian'. */
import { NavHistory, samePlace, type NavPlace } from "../model/nav-history";

export interface NavDeps {
	/** Where the reader is now (the active notebook view), or null when there is none. */
	here(): NavPlace | null;
	/** Whether the place can still be shown (the notebook exists and still has that page). */
	exists(place: NavPlace): Promise<boolean>;
	/** Shows the place, opening its notebook if needed. */
	open(place: NavPlace): Promise<void>;
	/** Milliseconds, for the arrival that a Back/Forward expects. */
	now?(): number;
}

/** A notebook that is opened by Back/Forward reports its arrival within this time (ms); later it counts as a new jump. */
const EXPECT_MS = 5000;

export class NavController {
	readonly history: NavHistory;
	private seenPlace: NavPlace | null = null;
	private expected: { place: NavPlace; until: number } | null = null;
	private busy = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: NavDeps, history: NavHistory = new NavHistory()) {
		this.history = history;
	}

	get canBack(): boolean {
		return this.history.canBack;
	}

	get canForward(): boolean {
		return this.history.canForward;
	}

	/** Called when the history changes (the buttons enable or disable). Returns the function that removes it. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of this.listeners) fn();
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/** The page in view of the active notebook changed (no jump): remembered as the place a later jump leaves from. */
	seen(place: NavPlace | null): void {
		if (place) this.seenPlace = place;
	}

	/**
	 * A deliberate jump to `to`. `from` is where the reader was in the view that jumps; null when that view has just
	 * opened (then the last place seen anywhere is used). The arrival that a Back or Forward asked for is not a jump.
	 */
	arrive(from: NavPlace | null, to: NavPlace): void {
		const exp = this.expected;
		this.expected = null;
		if (exp && exp.until >= this.now() && samePlace(exp.place, to)) {
			this.seenPlace = to;
			return;
		}
		this.history.jump(from ?? this.seenPlace, to);
		this.seenPlace = to;
		this.changed();
	}

	/** Back or Forward was shown without opening another view: no arrival will be reported. */
	shown(): void {
		this.expected = null;
	}

	/** Back (-1) or Forward (1). False when there is nowhere to go. */
	async go(dir: -1 | 1): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		try {
			const here = this.deps.here() ?? this.seenPlace;
			if (here) this.history.visit(here);
			for (let guard = 0; guard <= this.history.length; guard++) {
				const target = this.history.peek(dir);
				if (!target) return false;
				if (!(await this.deps.exists(target))) {
					this.history.drop(target);
					continue;
				}
				this.history.move(dir);
				this.seenPlace = target;
				this.expected = { place: target, until: this.now() + EXPECT_MS };
				await this.deps.open(target);
				return true;
			}
			return false;
		} finally {
			this.busy = false;
			this.changed();
		}
	}

	/** A notebook was renamed or moved. */
	renamed(oldPath: string, newPath: string): void {
		this.history.rename(oldPath, newPath);
		if (this.seenPlace?.path === oldPath) this.seenPlace = { ...this.seenPlace, path: newPath };
		this.changed();
	}

	/** A notebook was deleted. */
	removed(path: string): void {
		this.history.removeNotebook(path);
		if (this.seenPlace?.path === path) this.seenPlace = null;
		this.changed();
	}
}

/** Mouse buttons 3 and 4 (the side buttons of a desktop mouse): -1 back, 1 forward, 0 neither. */
export function mouseNavDirection(button: number): -1 | 0 | 1 {
	return button === 3 ? -1 : button === 4 ? 1 : 0;
}
