import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { EventLog, PEN_TEST_EVENT_TYPES, describeTarget, noSignalYet, type LoggedEvent } from "../ink/pen-button";
import type { NotebookSettings } from "../settings";
import { showNotice } from "./notice";

/** What the test knows about this device's side button across sessions (a flag saved in the plugin settings). */
export interface PenSignalInfo {
	/** A side-button signal has been received on this device (here or while writing). */
	seen(): boolean;
	/** Remember that one has. */
	markSeen(): void;
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
	};
}

/**
 * "Pen button test": lists, in plain text, the last events the pen (or anything else) sends anywhere in the
 * window, and whether the plugin would treat each as the side button. Like the pen-tracker page it shows the
 * values of the last event too. 0.11.1: every pointer, mouse, touch, contextmenu, auxclick, selection and key
 * event is recorded at window level in the capture phase, so an event that targets another element than the
 * test area, or that a handler would stop on its way, still shows. It draws nothing and changes nothing.
 */
export class PenTestModal extends Modal {
	private readonly log = new EventLog();
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

	constructor(app: App, private readonly info: PenSignalInfo) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("penTest.title"));
		this.t0 = performance.now();
		const { contentEl } = this;
		contentEl.addClass("notebook-pentest");
		contentEl.createEl("p", { text: t("penTest.intro") });
		contentEl.createEl("p", { text: t("penTest.window"), cls: "notebook-pentest-note" });
		contentEl.createEl("p", { text: t("penTest.air"), cls: "notebook-pentest-note" });

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
		};

		this.signal = contentEl.createDiv({ cls: "notebook-pentest-note" });
		this.summary = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		this.counts = contentEl.createDiv({ cls: "notebook-pentest-note" });
		this.output = contentEl.createEl("textarea", { cls: "notebook-pentest-log", attr: { readonly: "true", rows: "14", "aria-label": t("penTest.logLabel") } });
		const buttons = contentEl.createDiv({ cls: "notebook-pentest-buttons" });
		buttons.createEl("button", { text: t("penTest.copy"), cls: "mod-cta" }).addEventListener("click", () => void this.copy());
		buttons.createEl("button", { text: t("penTest.clear") }).addEventListener("click", () => {
			this.log.clear();
			this.lastText = "";
			this.refresh();
		});
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
			const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities;
			if (caps?.firesTouchEvents === true) ev.fromTouch = true;
		} else if (e.type.startsWith("touch")) {
			const touches = (e as TouchEvent).changedTouches;
			const touch: (Touch & { touchType?: string }) | undefined = touches?.[0];
			ev.pointerType = touch?.touchType ? `touch:${touch.touchType}` : "touch";
			ev.pressure = touch?.force;
		}
		this.log.add(ev);
		// The values of the last event, as the pen-tracker page shows them.
		if (ev.kind !== "selectionchange") {
			const fields = [`${ev.kind}`, `pointerType=${ev.pointerType ?? "-"}`, `button=${pe.button ?? "-"}`, `buttons=${pe.buttons ?? "-"}`,
				`pressure=${pe.pressure ?? "-"}`, `tiltX=${pe.tiltX ?? "-"}`, `tiltY=${pe.tiltY ?? "-"}`, `isPrimary=${pe.isPrimary ?? "-"}`, `target=${ev.target ?? "-"}`];
			this.lastText = fields.join("  ");
		}
		if (!this.frame) this.frame = win.requestAnimationFrame(() => {
			this.frame = 0;
			this.refresh();
		});
	}

	private refresh(): void {
		this.output.value = this.log.length > 0 ? this.log.text() : t("penTest.empty");
		this.output.scrollTop = this.output.scrollHeight;
		this.last.setText(t("penTest.last", { text: this.lastText || "-" }));
		this.summary.setText(t("penTest.summary", { n: String(this.log.sideButtonCount) }));
		this.counts.setText(this.log.total > 0 ? t("penTest.counts", { list: this.log.countsText() }) : t("penTest.countsNone"));
		if (this.log.sideButtonCount > 0) this.info.markSeen();
		this.signal.setText(noSignalYet(this.info.seen(), this.log.sideButtonCount) ? t("penTest.noSignal") : t("penTest.signalSeen"));
	}

	private async copy(): Promise<void> {
		const text = [this.counts.getText(), this.last.getText(), this.log.text()].join("\n");
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
