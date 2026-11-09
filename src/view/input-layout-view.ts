// 0.27 inputlayout (#431): the DOM side of the layout by input device. One passive, capture-phase listener pair on the view root
// reads `pointerType` of events the view already receives (it never stops, cancels or replaces them, and never touches the stroke
// pipeline); ui/input-layout.ts decides. The result is ONE class on the root (nb-input-pen | nb-input-touch | nb-input-mouse),
// next to the nb-vp-* classes, plus shortcut hints on the bar buttons while the mouse is in use.
import { Platform, type App } from "obsidian";
import {
	ALL_INPUT_CLASSES, DEFAULT_INPUT_KIND, InputDetector, inputClass, labelWithHotkey, resolveInput, showsShortcutHints,
	type HotkeyLike, type InputKind, type InputPref,
} from "../ui/input-layout";

export interface InputLayoutHost {
	app: App;
	/** The view root (the element that carries the nb-vp-* classes). */
	root: HTMLElement;
	pref(): InputPref;
	/** A stroke, an eraser pass or a drag is in progress: the device never changes then. */
	busy(): boolean;
	/** The layout changed: rebuild what depends on it (the toolbar size). */
	changed(kind: InputKind): void;
	listen(type: "pointerdown" | "pointerover", handler: (e: PointerEvent) => void): void;
}

interface HotkeyManagerLike {
	getHotkeys?(id: string): HotkeyLike[] | undefined;
	getDefaultHotkeys?(id: string): HotkeyLike[] | undefined;
}

/** The hotkeys Obsidian has for a command (the person's own, else the default); empty when the registry is not there. */
function hotkeysOf(app: App, commandId: string): HotkeyLike[] {
	try {
		const m = (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
		return m?.getHotkeys?.(commandId) ?? m?.getDefaultHotkeys?.(commandId) ?? [];
	} catch {
		return [];
	}
}

const BASE = "nbBaseLabel";
/** manifest.json id: the Obsidian command of an action is `notebook:<action>`. */
const PLUGIN_ID = "notebook";

export class InputLayout {
	private readonly detector = new InputDetector(DEFAULT_INPUT_KIND);
	private shown: InputKind | null = null;

	constructor(private readonly host: InputLayoutHost) {
		const onEvent = (e: PointerEvent) => {
			if (this.detector.feed(e.pointerType, e.timeStamp, this.host.busy())) this.apply();
		};
		host.listen("pointerdown", onEvent);
		host.listen("pointerover", (e) => {
			onEvent(e);
			if (e.pointerType === "mouse") this.hint(e.target);
		});
		this.apply();
	}

	/** The layout in use: the pinned device of the setting, else the detected one. */
	get kind(): InputKind {
		return resolveInput(this.host.pref(), this.detector.current);
	}

	/** The setting changed. */
	settingsChanged(): void {
		this.apply();
	}

	private apply(): void {
		const kind = this.kind;
		if (kind === this.shown) return;
		this.shown = kind;
		const root = this.host.root;
		root.removeClass(...ALL_INPUT_CLASSES);
		root.addClass(inputClass(kind));
		root.dataset.nbInput = kind;
		if (!showsShortcutHints(kind)) this.clearHints();
		this.host.changed(kind);
	}

	/** Mouse over a bar button: its tooltip (the aria-label Obsidian shows) names the shortcut the person has set for it. */
	private hint(target: EventTarget | null): void {
		if (!this.shown || !showsShortcutHints(this.shown) || !(target instanceof Element)) return;
		const button = target.closest<HTMLElement>("button[data-action]");
		if (!button || !this.host.root.contains(button)) return;
		const base = button.dataset[BASE] ?? button.getAttribute("aria-label") ?? "";
		if (!base) return;
		const label = labelWithHotkey(base, hotkeysOf(this.host.app, `${PLUGIN_ID}:${button.dataset.action}`), Platform.isMacOS);
		if (label === base) return;
		button.dataset[BASE] = base;
		button.setAttribute("aria-label", label);
	}

	private clearHints(): void {
		for (const b of Array.from(this.host.root.querySelectorAll<HTMLElement>("[data-nb-base-label]"))) {
			b.setAttribute("aria-label", b.dataset[BASE] ?? "");
			delete b.dataset[BASE];
		}
	}
}
