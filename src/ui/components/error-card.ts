// 0.12.3: a part of a surface that could not be drawn says so on screen, with the error and where it came from, in
// the style of the settings tab's "The settings could not be shown: …" (styles.css, "error card"). On a tablet the
// console cannot be read: this card is what a screenshot can report.
import { t } from "../../i18n";

/** The first frame of a stack that is not the message line ("at fn (main.js:1:2345)" or Safari's "fn@main.js:1:2345"). */
export function firstStackFrame(e: unknown): string {
	const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";
	for (const raw of stack.split("\n")) {
		const line = raw.trim();
		if (/^at\s/.test(line) || /@.+:\d+/.test(line)) return line.replace(/^at\s+/, "").slice(0, 200);
	}
	return "";
}

/** The message of anything thrown. */
export function errorMessage(e: unknown): string {
	if (e instanceof Error) return `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`;
	return String(e);
}

/** A small card: "Could not show <what>: <message>" and the first stack frame. */
export function errorCard(parent: HTMLElement, what: string, e: unknown): HTMLElement {
	const card = parent.createDiv({ cls: "nb-error-card", attr: { role: "alert" } });
	card.createDiv({ cls: "nb-error-text", text: t("ui.drawFailed", { what, error: errorMessage(e) }) });
	const frame = firstStackFrame(e);
	if (frame) card.createEl("code", { cls: "nb-error-frame", text: frame });
	return card;
}

/**
 * Draws one part of a surface. A failure is logged (`[notebook] <log>`) and shown as an error card in `parent`, and the
 * caller goes on with the next part. Returns whether the part was drawn.
 */
export function drawSafely(parent: HTMLElement, log: string, what: string, draw: () => void): boolean {
	try {
		draw();
		return true;
	} catch (e) {
		console.error(`[notebook] ${log} could not be drawn`, e);
		try {
			errorCard(parent, what, e);
		} catch {
			// Nothing more can be shown; the log above has the error.
		}
		return false;
	}
}
