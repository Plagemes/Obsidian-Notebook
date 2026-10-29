/**
 * Logs an error once per scope (`[notebook] <prefix> <scope>` on the console), so a failure that
 * repeats on every frame or every pointer event is reported without flooding the log. Used by the
 * per-frame and per-event guards: one bad stroke, element or background must never stop the rest
 * of the page from being drawn, nor the pen from writing.
 */
export class ErrorOnce {
	private readonly seen = new Set<string>();

	constructor(
		private readonly prefix: string,
		private readonly log: (...args: unknown[]) => void = (...args) => console.error(...args),
	) {}

	/** Returns true the first time `scope` is reported. */
	report(scope: string, error: unknown): boolean {
		if (this.seen.has(scope)) return false;
		this.seen.add(scope);
		this.log(`[notebook] ${this.prefix} ${scope}`, error);
		return true;
	}

	/** Runs `fn`; a thrown error is reported (once per scope) and swallowed. Returns false if it threw. */
	run(scope: string, fn: () => void): boolean {
		try {
			fn();
			return true;
		} catch (e) {
			this.report(scope, e);
			return false;
		}
	}
}
