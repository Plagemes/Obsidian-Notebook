import { t } from "../i18n";
import { LINE_HEIGHT } from "../ink/text-layout";
import type { TextElement } from "../model/types";

/** What is being edited: an existing text box (`element`) or a new one at `x`, `y`. Coordinates are page-local (pt). */
export interface TextEditSession {
	pageId: string;
	element: TextElement | null;
	x: number;
	y: number;
	width: number;
	fontSize: number;
	color: string;
}

export interface TextEditResult extends TextEditSession {
	text: string;
}

/** Events the textarea must not leak to the page below: they would start strokes, pans or shortcuts. */
const ISOLATED_EVENTS = [
	"pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown", "click",
] as const;

/**
 * A textarea laid over the canvas, at the position and size of the text box at the current zoom.
 * The view positions it (`place`) whenever the viewport changes and collects the text with `close`.
 */
export class TextEditor {
	private readonly area: HTMLTextAreaElement;
	private current: TextEditSession | null = null;
	private onDone: (() => void) | null = null;

	constructor(parent: HTMLElement) {
		this.area = parent.createEl("textarea", {
			cls: "notebook-text-editor notebook-hidden",
			attr: { "aria-label": t("text.label"), rows: "1", spellcheck: "false" },
		});
		for (const type of ISOLATED_EVENTS) this.area.addEventListener(type, (e) => e.stopPropagation());
		this.area.addEventListener("keydown", (e) => {
			// Typing must not trigger the view's shortcuts (Delete, Backspace, undo...).
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				this.onDone?.();
			}
		});
		this.area.addEventListener("keyup", (e) => e.stopPropagation());
		this.area.addEventListener("input", () => this.grow());
		this.area.addEventListener("blur", () => this.onDone?.());
	}

	/** The text field itself (the `[[` note suggester listens to it). */
	get element(): HTMLTextAreaElement {
		return this.area;
	}

	get isOpen(): boolean {
		return this.current !== null;
	}

	get session(): TextEditSession | null {
		return this.current;
	}

	/** Shows the editor; `done` is called when the user leaves it (Escape, tapping elsewhere) and must call `close`. */
	open(session: TextEditSession, text: string, done: () => void): void {
		this.current = session;
		this.onDone = done;
		this.area.value = text;
		this.area.setCssProps({ "--notebook-text-color": session.color });
		this.area.removeClass("notebook-hidden");
	}

	/** Moves and sizes the editor: (left, top) is the box's top-left corner in stage px, `scale` px per pt. */
	place(left: number, top: number, scale: number): void {
		const s = this.current;
		if (!s) return;
		this.area.setCssProps({
			"--notebook-text-x": `${left}px`,
			"--notebook-text-y": `${top}px`,
			"--notebook-text-w": `${s.width * scale}px`,
			"--notebook-text-fs": `${s.fontSize * scale}px`,
			"--notebook-text-lh": String(LINE_HEIGHT),
		});
		this.grow();
	}

	focus(): void {
		this.area.focus({ preventScroll: true });
		const end = this.area.value.length;
		this.area.setSelectionRange(end, end);
	}

	/** Hides the editor and returns what was typed (null if it was not open). */
	close(): TextEditResult | null {
		const s = this.current;
		if (!s) return null;
		this.current = null;
		this.onDone = null;
		const text = this.area.value;
		this.area.addClass("notebook-hidden");
		this.area.value = "";
		return { ...s, text };
	}

	destroy(): void {
		this.current = null;
		this.onDone = null;
		this.area.remove();
	}

	/** The textarea is as tall as its content. */
	private grow(): void {
		this.area.setCssProps({ "--notebook-text-h": "0px" });
		this.area.setCssProps({ "--notebook-text-h": `${this.area.scrollHeight}px` });
	}
}
