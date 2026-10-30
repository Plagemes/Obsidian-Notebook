import { Notice } from "obsidian";
import { writing } from "../ink/writing-guard";

/** What a caller may do with a notice it showed: change its text, close it. */
export interface NoticeHandle {
	setMessage(message: string | DocumentFragment): void;
	hide(): void;
}

/**
 * Every notice the plugin shows goes through here (wave 0.8, 374: do not disturb while writing). While a pen is on the
 * screen, and for 1.5 s after it was lifted, the notice is queued and shown at the first pause; one repeated meanwhile is
 * shown once, and closing a queued notice cancels it. The returned handle works either way.
 *
 * Limits, on purpose: Obsidian's own notices (sync, other plugins, "file saved") are shown by Obsidian and cannot be held
 * back from here. A notice that has to be seen at once is not exempt; the delay is at most the time the pen stays down.
 */
export function showNotice(message: string | DocumentFragment, duration?: number): NoticeHandle {
	if (!writing.writing() && writing.waiting === 0) return new Notice(message, duration);
	let current = message;
	let shown: Notice | null = null;
	let cancelled = false;
	writing.whenQuiet(() => {
		if (!cancelled) shown = new Notice(current, duration);
	}, typeof message === "string" ? `notice:${message}` : null);
	return {
		setMessage(next) {
			current = next;
			shown?.setMessage(next);
		},
		hide() {
			cancelled = true;
			shown?.hide();
		},
	};
}
