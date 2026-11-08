/**
 * The sign-in dialog of the cloud connector (#126), on the shared modal shell. It runs a device-flow sign-in given as
 * `run(ui)` and shows, in turn: "asking for a code"; the code to type, the address to open (with Copy code and Open
 * sign-in page), a countdown and the polling state; "setting up the sync folder"; or the problem with Try again.
 * Cancel (or closing the dialog) aborts the polling. It resolves `onDone` exactly once: the connected account, or null.
 */
import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../../i18n";
import { modalShell, shellButton, shellNote, type ModalShell } from "../../ui/components/modal-shell";
import { showNotice } from "../../view/notice";
import type { ProviderId } from "../provider-types";
import type { Connected } from "./connect";
import { SignInError, type DeviceCodePrompt, type SignInPhase, type SignInUi } from "./device-flow";

const FAILURE_KEYS: Record<SignInError["reason"], MessageKey> = {
	denied: "syncprov.error.denied",
	expired: "syncprov.error.expired",
	cancelled: "syncprov.error.other",
	client: "syncprov.error.client",
	network: "syncprov.error.network",
	other: "syncprov.error.other",
};

/** "mm:ss" left until `expiresAt`. */
export function countdown(expiresAt: number, now: number): string {
	const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class SignInModal extends Modal {
	private shell: ModalShell | null = null;
	private aborter: AbortController | null = null;
	private finished = false;
	private tick: number | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly providerId: ProviderId,
		private readonly run: (ui: SignInUi) => Promise<Connected>,
		private readonly onDone: (result: Connected | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.shell = modalShell(this, {
			title: t(this.providerId === "gdrive" ? "syncprov.title.gdrive" : "syncprov.title.onedrive"),
			subtitle: t("syncprov.subtitle"),
			icon: "cloud",
			size: "narrow",
			cls: "nb-signin-modal",
			seed: `signin-${this.providerId}`,
		});
		this.attempt();
	}

	/** Starts (or restarts) a sign-in. */
	private attempt(): void {
		this.aborter?.abort();
		const aborter = new AbortController();
		this.aborter = aborter;
		this.busy(t("syncprov.requesting"));
		const ui: SignInUi = {
			signal: aborter.signal,
			showCode: (prompt) => {
				if (!aborter.signal.aborted) this.showCode(prompt);
			},
			phase: (phase) => {
				if (!aborter.signal.aborted) this.phase(phase);
			},
		};
		this.run(ui).then(
			(done) => {
				if (aborter.signal.aborted || this.finished) return;
				this.finish(done);
				this.close();
			},
			(e: unknown) => {
				if (aborter.signal.aborted || this.finished) return;
				this.problem(e);
			},
		);
	}

	private finish(result: Connected | null): void {
		if (this.finished) return;
		this.finished = true;
		this.onDone(result);
	}

	private stopTick(): void {
		if (this.tick !== null) window.clearInterval(this.tick);
		this.tick = null;
	}

	/** A waiting state: one line and Cancel. */
	private busy(text: string): void {
		const s = this.shell;
		if (!s) return;
		this.stopTick();
		s.body.empty();
		s.foot.empty();
		const row = s.body.createDiv({ cls: "nb-signin-busy", attr: { role: "status" } });
		row.createSpan({ cls: "nb-signin-dot", attr: { "aria-hidden": "true" } });
		row.createSpan({ text });
		shellButton(s.foot, "secondary", t("syncprov.cancel"), () => this.close());
	}

	private showCode(prompt: DeviceCodePrompt): void {
		const s = this.shell;
		if (!s) return;
		this.stopTick();
		s.body.empty();
		s.foot.empty();
		const steps = s.body.createEl("ol", { cls: "nb-signin-steps" });
		steps.createEl("li", { text: t("syncprov.step.open") });
		steps.createEl("li", { text: t("syncprov.step.code") });
		steps.createEl("li", { text: t("syncprov.step.allow") });
		const box = s.body.createDiv({ cls: "nb-signin-codebox" });
		box.createDiv({ cls: "nb-signin-code", text: prompt.userCode, attr: { "aria-label": t("syncprov.codeLabel", { code: prompt.userCode.split("").join(" ") }) } });
		box.createDiv({ cls: "nb-signin-url", text: prompt.verificationUrl });
		const actions = box.createDiv({ cls: "nb-signin-actions" });
		shellButton(actions, "secondary", t("syncprov.copy"), () => void this.copy(prompt.userCode), { icon: "copy" });
		this.statusEl = s.body.createDiv({ cls: "nb-signin-status", attr: { role: "status", "aria-live": "polite" } });
		const paint = (): void => {
			if (!this.statusEl) return;
			const left = countdown(prompt.expiresAt, Date.now());
			this.statusEl.setText(left === "0:00" ? t("syncprov.expiredSoon") : t("syncprov.waiting", { time: left }));
		};
		paint();
		this.tick = window.setInterval(paint, 1000);
		shellButton(s.foot, "secondary", t("syncprov.cancel"), () => this.close());
		shellButton(s.foot, "primary", t("syncprov.open"), () => {
			window.open(prompt.verificationUrl, "_blank", "noopener");
		}, { icon: "external-link" });
	}

	private phase(phase: SignInPhase): void {
		if (phase === "finishing") this.busy(t("syncprov.finishing"));
		else if (phase === "slowDown" && this.statusEl) this.statusEl.addClass("is-slow");
	}

	private problem(e: unknown): void {
		const s = this.shell;
		if (!s) return;
		this.stopTick();
		s.body.empty();
		s.foot.empty();
		const reason = e instanceof SignInError ? e.reason : "other";
		const detail = e instanceof SignInError ? e.detail || e.reason : e instanceof Error ? e.message : String(e);
		shellNote(s.body, t(FAILURE_KEYS[reason], { detail }), "error");
		if (reason === "client") shellNote(s.body, t("syncprov.error.clientHint"));
		shellButton(s.foot, "secondary", t("syncprov.cancel"), () => this.close());
		shellButton(s.foot, "primary", t("syncprov.retry"), () => this.attempt(), { icon: "rotate-ccw" });
	}

	private async copy(code: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(code);
			showNotice(t("syncprov.copied"));
		} catch {
			showNotice(t("syncprov.copyFailed"));
		}
	}

	onClose(): void {
		this.aborter?.abort();
		this.stopTick();
		this.statusEl = null;
		this.finish(null);
		this.contentEl.empty();
	}
}
