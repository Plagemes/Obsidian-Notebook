import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { ButtonDecision, ButtonSignal, IgnoreReason } from "../ink/button-contact";
import { opensRadial } from "../ink/input-policy";
import { EventLog, LOG_LINES, PEN_TEST_EVENT_TYPES, describeTarget, effectivePenHold, noSignalYet, penHoldMayStart, type LoggedEvent } from "../ink/pen-button";
import { NIB_LONG_PRESS_MS, STILL_RADIUS_PX, capacitorInventory, formatCapacitorInventory, formatDelta } from "../ink/pen-hover";
import type { NotebookSettings } from "../settings";
import { showNotice } from "./notice";
import type { PenButtonSettings, PenButtonSettingsHost } from "./pen-button-settings";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";

/** What the test knows about this device's side button across sessions (a flag saved in the plugin settings). */
export interface PenSignalInfo {
	/** A side-button signal has been received on this device (here or while writing). */
	seen(): boolean;
	/** Remember that one has. */
	markSeen(): void;
	/** 0.11.2: the S Pen fallback settings; the test reads the side button timing windows for its verdict line. */
	penButton?: PenButtonSettingsHost;
}

/** The plugin settings as the "side button seen" flag. */
export function penSignalInfo(host: { settings: NotebookSettings; saveSettings(): Promise<void> }): PenSignalInfo {
	return {
		seen: () => host.settings.penButtonSeen,
		markSeen: () => {
			if (host.settings.penButtonSeen) return;
			host.settings.penButtonSeen = true;
			void host.saveSettings().catch((e) => console.error("[notebook] saving settings failed", e));
		},
		penButton: {
			get: () => host.settings,
			set: async (key, value) => {
				const target: PenButtonSettings = host.settings;
				target[key] = value;
				await host.saveSettings();
			},
		},
	};
}

const IGNORE_KEY: Record<IgnoreReason, MessageKey> = {
	off: "penTest.ign.off",
	resting: "penTest.ign.resting",
	"mid-stroke": "penTest.ign.midStroke",
	"after-drag": "penTest.ign.afterDrag",
	"no-contact": "penTest.ign.noContact",
	repeat: "penTest.ign.repeat",
};

/** The hold-still menu as the plugin reads it: the user's choice or the automatic default, and never next to the long-press gesture. */
function holdStillOn(s: PenButtonSettings): boolean {
	return effectivePenHold(s.penHoldStill, s.penButtonSeen) && !s.penGestureLongPress;
}

/** Is a rest of the nib spoken for (as the controller decides it, except gesture mode and the tool, which the test cannot know)? */
function restClaimedBy(s: PenButtonSettings): boolean {
	return penHoldMayStart({ enabled: holdStillOn(s), radialAction: opensRadial(s.penSideButton), eraser: false }) || s.penGestureLongPress;
}

/** The button signal the plugin saw, in the user's language: contextmenu Δ=+40 ms, pointerdown buttons=3, ... */
export function signalLabel(s: ButtonSignal): string {
	switch (s.kind) {
		case "contextmenu": return s.dt === undefined ? t("penTest.sig.contextmenuNone") : t("penTest.sig.contextmenu", { dt: formatDelta(s.dt) });
		case "pointerdown": return t("penTest.sig.pointerdown", { buttons: String(s.buttons ?? "?") });
		case "pointermove": return t("penTest.sig.pointermove", { buttons: String(s.buttons ?? "?"), dt: formatDelta(s.dt ?? 0) });
		case "chord": return t("penTest.sig.chord", { dt: formatDelta(s.dt ?? 0) });
		default: return t("penTest.sig.pointercancel");
	}
}

/** What the plugin made of it, in the user's language: menu (tap), eraser (drag), ignored: <reason>. */
export function decisionLabel(d: ButtonDecision): string {
	switch (d.kind) {
		case "waiting": return t("penTest.dec.waiting");
		case "menu":
			if (d.via === "hover") return t("penTest.dec.menuHover", { ms: String(Math.round(d.ms ?? 0)) });
			return d.via === "late-tap" ? t("penTest.dec.menuLate") : t("penTest.dec.menu");
		case "eraser": return t("penTest.dec.eraser");
		case "eraser-next": return t("penTest.dec.eraserNext", { ms: String(Math.round(d.ms ?? 0)) });
		default: return t("penTest.dec.ignored", { reason: t(IGNORE_KEY[d.reason ?? "repeat"]) });
	}
}

/**
 * "Pen button test": lists, in plain text, the last events the pen (or anything else) sends anywhere in the
 * window, and whether the plugin would treat each as the side button. Like the pen-tracker page it shows the
 * values of the last event too. 0.11.1: every pointer, mouse, touch, contextmenu, auxclick, selection and key
 * event is recorded at window level in the capture phase, so an event that targets another element than the
 * test area, or that a handler would stop on its way, still shows. It draws nothing and changes nothing.
 */
export class PenTestModal extends Modal {
	private readonly log: EventLog;
	private verdictEl!: HTMLElement;
	private signalSeenEl!: HTMLElement;
	private decisionEl!: HTMLElement;
	private t0 = 0;
	private area!: HTMLElement;
	private output!: HTMLTextAreaElement;
	private summary!: HTMLElement;
	private counts!: HTMLElement;
	private last!: HTMLElement;
	private lastText = "";
	private signal!: HTMLElement;
	private stop: () => void = () => {};
	private frame = 0;
	private tickTimer = 0;
	private capacitor!: HTMLElement;

	constructor(app: App, private readonly info: PenSignalInfo) {
		super(app);
		const s = info.penButton?.get();
		this.log = new EventLog(
			LOG_LINES,
			s ? { beforeMs: s.penButtonContactBeforeMs, afterMs: s.penButtonContactAfterMs } : undefined,
			s ? { enabled: s.penSideButton !== "off", menuAllowed: opensRadial(s.penSideButton), restClaimed: restClaimedBy(s), eraserNextOnClick: s.penButtonEraserNext } : undefined,
		);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("penTest.title"), subtitle: t("penTest.intro"), icon: "pen-tool", size: "wide", cls: "notebook-pentest-modal" });
		this.t0 = performance.now();
		const contentEl = shell.body;
		this.contentEl.addClass("notebook-pentest");
		shellNote(contentEl, t("penTest.window")).addClass("notebook-pentest-note");
		shellNote(contentEl, t("penTest.air")).addClass("notebook-pentest-note");

		this.area = contentEl.createDiv({ cls: "notebook-pentest-area", text: t("penTest.area") });
		this.last = contentEl.createDiv({ cls: "notebook-pentest-last" });
		const win = activeWindow;
		const doc = activeDocument;
		const rec = (ev: Event) => this.record(ev, win, doc);
		// Window, capture phase: first to see every event, whatever element it targets. Passive: the test never
		// changes what an event does, except that the native menu does not open over the test area.
		const opts = { capture: true, passive: true } as const;
		for (const type of PEN_TEST_EVENT_TYPES) win.addEventListener(type, rec, opts);
		doc.addEventListener("selectionchange", rec, opts);
		// The test area blocks like the pen-tracker page: no native menu or auxclick action, and the pen's
		// pointerdown is cancelled (no WebView long-press or selection that would cancel the pen stream). Not
		// passive; the window-level log above stays passive.
		const block = (e: Event) => {
			if (e.cancelable) e.preventDefault();
		};
		const penDown = (e: PointerEvent) => {
			if (e.pointerType === "pen" && e.cancelable) e.preventDefault();
		};
		const blockOpts = { capture: true, passive: false } as const;
		this.area.addEventListener("contextmenu", block, blockOpts);
		this.area.addEventListener("auxclick", block, blockOpts);
		this.area.addEventListener("pointerdown", penDown, blockOpts);
		this.stop = () => {
			for (const type of PEN_TEST_EVENT_TYPES) win.removeEventListener(type, rec, opts);
			doc.removeEventListener("selectionchange", rec, opts);
			this.area.removeEventListener("contextmenu", block, blockOpts);
			this.area.removeEventListener("auxclick", block, blockOpts);
			this.area.removeEventListener("pointerdown", penDown, blockOpts);
			if (this.frame) win.cancelAnimationFrame(this.frame);
			this.frame = 0;
			if (this.tickTimer) win.clearTimeout(this.tickTimer);
			this.tickTimer = 0;
		};

		this.signal = contentEl.createDiv({ cls: "notebook-pentest-note" });
		// 0.11.2: what the native bridge offers (names only; nothing is called): a stylus plugin would show here.
		this.capacitor = contentEl.createDiv({ cls: "notebook-pentest-note" });
		this.capacitor.setText(t("penTest.capacitor", { text: formatCapacitorInventory(capacitorInventory(win)) }));
		this.summary = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		// 0.11.2: what the last contextmenu meant (button held at contact, during a stroke, while hovering).
		this.verdictEl = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		// 0.12.4: the button signal the plugin saw around the pen contact and what it decided (menu on a tap, eraser on a drag).
		this.signalSeenEl = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		this.decisionEl = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		this.counts = contentEl.createDiv({ cls: "notebook-pentest-note" });
		this.output = contentEl.createEl("textarea", { cls: "notebook-pentest-log", attr: { readonly: "true", rows: "14", "aria-label": t("penTest.logLabel") } });
		shellButton(shell.foot, "secondary", t("penTest.clear"), () => {
			this.log.clear();
			this.lastText = "";
			this.refresh();
		});
		shellButton(shell.foot, "primary", t("penTest.copy"), () => void this.copy());
		this.refresh();
	}

	onClose(): void {
		this.stop();
		this.stop = () => {};
		this.contentEl.empty();
	}

	private record(e: Event, win: Window, doc: Document): void {
		const pe = e as Partial<PointerEvent> & Partial<KeyboardEvent>;
		const ev: LoggedEvent = { kind: e.type, t: performance.now() - this.t0, timeStamp: e.timeStamp, target: describeTarget(e.target, this.area, win, doc) };
		if (e.type === "keydown" || e.type === "keyup") {
			ev.key = pe.key;
			ev.code = pe.code;
		} else if (typeof pe.button === "number" || typeof pe.pointerType === "string") {
			ev.pointerType = typeof pe.pointerType === "string" ? pe.pointerType : "";
			ev.button = pe.button;
			ev.buttons = pe.buttons;
			ev.pressure = pe.pressure;
			ev.isPrimary = pe.isPrimary;
			ev.pointerId = pe.pointerId;
			ev.x = pe.clientX;
			ev.y = pe.clientY;
			const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities;
			if (caps?.firesTouchEvents === true) ev.fromTouch = true;
		} else if (e.type.startsWith("touch")) {
			const touches = (e as TouchEvent).changedTouches;
			const touch: (Touch & { touchType?: string }) | undefined = touches?.[0];
			ev.pointerType = touch?.touchType ? `touch:${touch.touchType}` : "touch";
			ev.pressure = touch?.force;
		}
		this.log.add(ev);
		this.watchHover(win);
		// The values of the last event, as the pen-tracker page shows them.
		if (ev.kind === "keydown" || ev.kind === "keyup") {
			this.lastText = `${ev.kind}  key=${JSON.stringify(ev.key ?? "")}  code=${ev.code ?? ""}  repeat=${pe.repeat ?? "-"}  target=${ev.target ?? "-"}`;
		} else if (ev.kind !== "selectionchange") {
			const fields = [`${ev.kind}`, `pointerType=${ev.pointerType ?? "-"}`, `button=${pe.button ?? "-"}`, `buttons=${pe.buttons ?? "-"}`,
				`pressure=${pe.pressure ?? "-"}`, `tiltX=${pe.tiltX ?? "-"}`, `tiltY=${pe.tiltY ?? "-"}`, `isPrimary=${pe.isPrimary ?? "-"}`, `target=${ev.target ?? "-"}`];
			this.lastText = fields.join("  ");
		}
		if (!this.frame) this.frame = win.requestAnimationFrame(() => {
			this.frame = 0;
			this.refresh();
		});
	}

	/** A bare contextmenu waits for a pen contact: when the before-window has run out the log says it was a hover click (the menu opens by itself). */
	private watchHover(win: Window): void {
		if (this.tickTimer || !this.log.hoverWaiting) return;
		this.tickTimer = win.setTimeout(() => {
			this.tickTimer = 0;
			this.log.tick(performance.now() - this.t0);
			this.refresh();
			this.watchHover(win);
		}, this.log.beforeMs + 40);
	}

	/** The settings the decision depends on, as one line at the top of the copied log. */
	private settingsLine(): string {
		const s = this.info.penButton?.get();
		if (!s) return "Settings: unknown";
		return `Settings: side button=${s.penSideButton}, before-window=${s.penButtonContactBeforeMs} ms, after-window=${s.penButtonContactAfterMs} ms, still radius=${STILL_RADIUS_PX} px, nib long-press=${NIB_LONG_PRESS_MS} ms, hold-still menu=${holdStillOn(s)} (choice=${String(s.penHoldStill)}, button seen=${s.penButtonSeen}), long-press gesture=${s.penGestureLongPress}, rest claimed=${restClaimedBy(s)}, click arms eraser=${s.penButtonEraserNext}`;
	}

	private refresh(): void {
		this.output.value = this.log.length > 0 ? this.log.text() : t("penTest.empty");
		this.output.scrollTop = this.output.scrollHeight;
		this.last.setText(t("penTest.last", { text: this.lastText || "-" }));
		this.summary.setText(t("penTest.summary", { n: String(this.log.sideButtonCount) }));
		const verdict = this.log.verdict;
		this.verdictEl.setText(verdict ? t("penTest.verdict", { text: verdict }) : t("penTest.verdictNone"));
		const sig = this.log.signal;
		const dec = this.log.decision;
		this.signalSeenEl.setText(sig ? t("penTest.signalLine", { text: signalLabel(sig) }) : t("penTest.signalNone"));
		this.decisionEl.setText(dec ? t("penTest.decisionLine", { text: decisionLabel(dec) }) : t("penTest.decisionNone"));
		this.counts.setText(this.log.total > 0 ? t("penTest.counts", { list: this.log.countsText() }) : t("penTest.countsNone"));
		if (this.log.sideButtonCount > 0) this.info.markSeen();
		this.signal.setText(noSignalYet(this.info.seen(), this.log.sideButtonCount) ? t("penTest.noSignal") : t("penTest.signalSeen"));
	}

	private async copy(): Promise<void> {
		const text = [this.settingsLine(), this.counts.getText(), this.verdictEl.getText(), this.signalSeenEl.getText(), this.decisionEl.getText(), this.capacitor.getText(), this.last.getText(), this.log.text()].join("\n");
		try {
			await navigator.clipboard.writeText(text);
			showNotice(t("penTest.copied"));
		} catch {
			// No clipboard permission in this WebView: select the text so a long-press and Copy works.
			this.output.focus();
			this.output.select();
			showNotice(t("penTest.copySelect"));
		}
	}
}
