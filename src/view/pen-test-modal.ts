import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { EventLog, noSignalYet, type LoggedEvent } from "../ink/pen-button";
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
 * "Pen button test": a test area that lists, in plain text, the last events the pen sends to it (pointer
 * events, contextmenu, auxclick, keys) and whether the plugin would treat each as the side button. It draws
 * nothing and changes nothing; its only purpose is to find out how a device reports the pen's button.
 */
export class PenTestModal extends Modal {
	private readonly log = new EventLog();
	private t0 = 0;
	private area!: HTMLElement;
	private output!: HTMLTextAreaElement;
	private summary!: HTMLElement;
	private signal!: HTMLElement;
	private stopKeys: () => void = () => {};

	constructor(app: App, private readonly info: PenSignalInfo) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("penTest.title"));
		this.t0 = performance.now();
		const { contentEl } = this;
		contentEl.addClass("notebook-pentest");
		contentEl.createEl("p", { text: t("penTest.intro") });
		contentEl.createEl("p", { text: t("penTest.air"), cls: "notebook-pentest-note" });

		this.area = contentEl.createDiv({ cls: "notebook-pentest-area", text: t("penTest.area") });
		const rec = (ev: Event) => this.record(ev);
		// pointerrawupdate does not exist everywhere: an event type that is never fired is harmless.
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerrawupdate", "contextmenu", "auxclick"]) {
			this.area.addEventListener(type, rec);
		}
		this.area.addEventListener("contextmenu", (e) => e.preventDefault());
		this.area.addEventListener("auxclick", (e) => e.preventDefault());
		// Keys go to the document while the modal is open (a pen button may be mapped to a key by the system).
		activeDocument.addEventListener("keydown", rec, true);
		activeDocument.addEventListener("keyup", rec, true);
		this.stopKeys = () => {
			activeDocument.removeEventListener("keydown", rec, true);
			activeDocument.removeEventListener("keyup", rec, true);
		};

		this.signal = contentEl.createDiv({ cls: "notebook-pentest-note" });
		this.summary = contentEl.createDiv({ cls: "notebook-pentest-summary" });
		this.output = contentEl.createEl("textarea", { cls: "notebook-pentest-log", attr: { readonly: "true", rows: "14", "aria-label": t("penTest.logLabel") } });
		const buttons = contentEl.createDiv({ cls: "notebook-pentest-buttons" });
		buttons.createEl("button", { text: t("penTest.copy"), cls: "mod-cta" }).addEventListener("click", () => void this.copy());
		buttons.createEl("button", { text: t("penTest.clear") }).addEventListener("click", () => {
			this.log.clear();
			this.refresh();
		});
		this.refresh();
	}

	onClose(): void {
		this.stopKeys();
		this.stopKeys = () => {};
		this.contentEl.empty();
	}

	private record(e: Event): void {
		const pe = e as Partial<PointerEvent> & Partial<KeyboardEvent>;
		const ev: LoggedEvent = { kind: e.type, t: performance.now() - this.t0 };
		if (e.type === "keydown" || e.type === "keyup") {
			ev.key = pe.key;
			ev.code = pe.code;
		} else {
			ev.pointerType = typeof pe.pointerType === "string" ? pe.pointerType : "";
			ev.button = pe.button;
			ev.buttons = pe.buttons;
			ev.pressure = pe.pressure;
			ev.isPrimary = pe.isPrimary;
			ev.pointerId = pe.pointerId;
		}
		this.log.add(ev);
		this.refresh();
	}

	private refresh(): void {
		this.output.value = this.log.length > 0 ? this.log.text() : t("penTest.empty");
		this.output.scrollTop = this.output.scrollHeight;
		this.summary.setText(t("penTest.summary", { n: String(this.log.sideButtonCount) }));
		if (this.log.sideButtonCount > 0) this.info.markSeen();
		this.signal.setText(noSignalYet(this.info.seen(), this.log.sideButtonCount) ? t("penTest.noSignal") : t("penTest.signalSeen"));
	}

	private async copy(): Promise<void> {
		const text = this.log.text();
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
