/**
 * Just-in-time hints (roadmap 425): the service behind `hint(id)`. A call site says "this situation just happened"; the
 * engine (hint-logic.ts) decides whether a tip may be shown now (tips on, not seen, not writing, not too soon after
 * another) and the bubble (components/hint-bubble.ts) shows it. The seen ids live in the plugin settings (`hintsSeen`).
 */
import type { Plugin } from "obsidian";
import { t } from "../i18n";
import { writing } from "../ink/writing-guard";
import type { NotebookSettings } from "../settings";
import { showNotice } from "../view/notice";
import { hintBubble } from "./components/hint-bubble";
import { HINT_VISIBLE_MS, HINTS, HintEngine, normaliseSeen, type HintId } from "./hint-logic";

export interface HintHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

class HintService {
	private readonly engine: HintEngine;
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private lastPen = Number.NEGATIVE_INFINITY;

	constructor(private readonly host: HintHost) {
		this.engine = new HintEngine(
			{ now: () => Date.now(), enabled: () => host.settings.hintsEnabled, isWriting: () => writing.writing() },
			normaliseSeen(host.settings.hintsSeen),
		);
	}

	request(id: HintId): void {
		const d = this.engine.decide(id);
		if (d === "writing") {
			// Wait for the pause, then ask again (the situation may have passed, the tip may have been turned off).
			writing.whenQuiet(() => this.present(id), `hint:${id}`);
		} else if (d === "show") this.present(id);
	}

	private present(id: HintId): void {
		if (this.engine.decide(id) !== "show") return;
		const def = HINTS.find((h) => h.id === id);
		if (!def) return;
		this.close();
		this.engine.shown(id);
		this.store();
		const host = createDiv({ cls: "nb-ui nb-hint-host" });
		hintBubble(host, {
			icon: def.icon, title: t(def.title), body: t(def.body),
			dismissLabel: t("hint.dismiss"), turnOffLabel: t("hint.turnOff"),
			onDismiss: () => this.close(),
			onTurnOff: () => {
				this.host.settings.hintsEnabled = false;
				void this.host.saveSettings().catch((e) => console.error("[notebook] saving settings failed", e));
				this.close();
			},
		});
		activeDocument.body.appendChild(host);
		this.el = host;
		this.timer = window.setTimeout(() => this.close(), HINT_VISIBLE_MS);
	}

	close(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.el?.remove();
		this.el = null;
	}

	private store(): void {
		this.host.settings.hintsSeen = this.engine.seen;
		void this.host.saveSettings().catch((e) => console.error("[notebook] saving settings failed", e));
	}

	reset(): void {
		this.engine.reset();
		this.host.settings.hintsSeen = [];
	}

	/** The pen reached a notebook: remember when, for palm rejection. */
	notePen(): void {
		this.lastPen = Date.now();
	}

	penRecently(ms: number): boolean {
		return Date.now() - this.lastPen < ms;
	}
}

let active: HintService | null = null;

/** A situation just happened. Cheap and safe to call from anywhere; does nothing when tips are off or the hint was seen. */
export function hint(id: HintId): void {
	try {
		active?.request(id);
	} catch (e) {
		console.error("[notebook] hint failed", e);
	}
}

/** "Show tips again" (settings): every tip can appear again, and tips are switched back on. */
export function resetHints(host: Pick<HintHost, "settings" | "saveSettings">): void {
	host.settings.hintsSeen = [];
	host.settings.hintsEnabled = true;
	active?.reset();
	void host.saveSettings().catch((e) => console.error("[notebook] saving settings failed", e));
	showNotice(t("hint.reset.done"));
}

/**
 * Starts the service and the hints that come from the pointer itself, so no call site in the notebook needs a hook:
 * the first pen contact, the first pen hover (the side button opens the radial menu) and a finger that palm rejection
 * ignores. All listeners are passive and look only at events inside a notebook view.
 */
export function registerHints(plugin: HintHost): void {
	const service = new HintService(plugin);
	active = service;
	plugin.register(() => {
		service.close();
		if (active === service) active = null;
	});
	const inNotebook = (e: Event): boolean => e.target instanceof Element && e.target.closest(".notebook-view") !== null;
	const attach = (doc: Document): void => {
		const opts = { capture: true, passive: true };
		plugin.registerDomEvent(doc, "pointerdown", (e) => {
			if (!inNotebook(e)) return;
			if (e.pointerType === "pen") {
				service.notePen();
				hint("pen-detected");
			} else if (e.pointerType === "touch") {
				const s = plugin.settings;
				// Fingers draw only when allowed, and then not right after the pen: that touch is what was ignored.
				if (s.fingerDrawing && s.palmRejectionMs > 0 && service.penRecently(s.palmRejectionMs)) hint("palm-blocked");
			}
		}, opts);
		plugin.registerDomEvent(doc, "pointermove", (e) => {
			if (e.pointerType !== "pen" || e.buttons !== 0 || !inNotebook(e)) return;
			service.notePen();
			const side = plugin.settings.penSideButton;
			if (side === "radial" || side === "radial-eraser" || side === "radial-gesture") hint("radial-available");
		}, opts);
	};
	attach(document);
	plugin.registerEvent(plugin.app.workspace.on("window-open", (win) => attach(win.doc)));
}
