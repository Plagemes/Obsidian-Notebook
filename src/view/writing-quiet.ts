import type { Plugin } from "obsidian";
import { writing } from "../ink/writing-guard";

/**
 * Feeds the writing guard (ink/writing-guard.ts) from the pen's pointer events, anywhere in Obsidian (wave 0.8, 374).
 * Capture-phase and passive: it never changes how a pointer event is handled. Only pointers of type `pen` count: a finger
 * resting on the screen or a mouse click is not "writing". Called once from onload; popout windows are followed.
 */
export function trackWriting(plugin: Plugin): void {
	const attach = (doc: Document, win: Window) => {
		const opts = { capture: true, passive: true };
		plugin.registerDomEvent(doc, "pointerdown", (e) => {
			if (e.pointerType === "pen") writing.penDown(e.pointerId);
		}, opts);
		const up = (e: PointerEvent) => {
			if (e.pointerType === "pen") writing.penUp(e.pointerId);
		};
		plugin.registerDomEvent(doc, "pointerup", up, opts);
		plugin.registerDomEvent(doc, "pointercancel", up, opts);
		// The up event may never come when the window loses focus or the tab is hidden.
		plugin.registerDomEvent(win, "blur", () => writing.penLost());
		plugin.registerDomEvent(doc, "visibilitychange", () => {
			if (doc.visibilityState === "hidden") writing.penLost();
		});
	};
	attach(document, window);
	plugin.registerEvent(plugin.app.workspace.on("window-open", (win) => attach(win.doc, win.win)));
	plugin.register(() => writing.reset());
}
