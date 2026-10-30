/** Remembers the tool used before the current one (for the pen's side button: "previous tool while held"). */
export class LastTool<T extends string> {
	private current: T | null = null;
	private before: T | null = null;

	/** The tool in use changed (or was set). Repeating the same tool changes nothing. */
	note(tool: T): void {
		if (tool === this.current) return;
		this.before = this.current;
		this.current = tool;
	}

	/** The tool used before the current one, or null when there was none yet. */
	previous(): T | null {
		return this.before;
	}
}
