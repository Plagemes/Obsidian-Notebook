/**
 * 0.22 synccore (#126): the drawn rows of the "Cloud sync" group of the settings (Sync section): the account (sign in,
 * disconnect, the cloud folder), "Sync now" with the status line, and the activity log (last 50 entries on this device).
 * Each follows the service while the tab is open and returns the way to stop following it.
 */
import type { ButtonComponent, Setting } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { LogEntry, LogKind } from "../sync/sync-memory";
import type { CloudSyncService } from "../sync/sync-service";
import { setDestructive } from "../ui/destructive";

/** The account row: who is signed in and to which folder; "Sign in", or "Change folder" and "Disconnect". */
export function renderCloudAccountRow(setting: Setting, service: CloudSyncService): () => void {
	const update = (): void => {
		setting.setDesc(service.accountText());
		setting.controlEl.empty();
		const p = service.provider();
		const auth = service.authUI();
		if (!p || !auth.available(p)) return;
		if (!auth.isSignedIn(p)) {
			setting.addButton((b) => b.setButtonText(t("cloudSync.account.signIn")).setCta().onClick(() => void service.signIn()));
			return;
		}
		if (auth.chooseRoot) setting.addButton((b) => b.setButtonText(t("cloudSync.account.chooseFolder")).onClick(() => void service.chooseRoot()));
		setting.addButton((b) => setDestructive(b.setButtonText(t("cloudSync.account.disconnect"))).onClick(() => void service.disconnect()));
	};
	update();
	return service.onChange(update);
}

/** Google's client secret: a masked field stored on this device only (never in the settings file, which other tools may sync). */
export function renderCloudSecretRow(setting: Setting, service: CloudSyncService): () => void {
	const p = service.provider();
	setting.controlEl.empty();
	if (!p) return () => {};
	setting.addText((text) => {
		text.inputEl.type = "password";
		text.inputEl.autocomplete = "off";
		text.inputEl.addClass("nb-ui", "nb-cloudsync-secret");
		text.setPlaceholder(t("settings.cloudSyncSecret.placeholder")).setValue(service.clientSecret(p));
		text.onChange((v) => service.setClientSecret(p, v));
	});
	return () => {};
}

/** "Sync now" with the status line; "Stop" while a run is in progress, "Review" when the last run waits for a decision. */
export function renderCloudSyncRow(setting: Setting, service: CloudSyncService): () => void {
	let main: ButtonComponent | null = null;
	let review: ButtonComponent | null = null;
	setting.addButton((b) => {
		review = b;
		b.setButtonText(t("cloudSync.review")).onClick(() => service.review());
	});
	setting.addButton((b) => {
		main = b;
		b.setCta().onClick(() => {
			if (service.running()) service.cancel();
			else void service.syncNow();
		});
	});
	const update = (): void => {
		setting.setDesc(service.statusText());
		main?.setButtonText(service.running() ? t("cloudSync.stop") : t("settings.cloudSyncNow"));
		review?.buttonEl.toggleClass("notebook-hidden", !service.waiting());
	};
	update();
	return service.onChange(update);
}

const KIND_LABEL: Record<LogKind, MessageKey> = {
	up: "cloudSync.log.up",
	down: "cloudSync.log.down",
	"del-local": "cloudSync.log.delLocal",
	"del-remote": "cloudSync.log.delRemote",
	conflict: "cloudSync.log.conflict",
	same: "cloudSync.log.same",
	skip: "cloudSync.log.skip",
	error: "cloudSync.log.error",
	run: "cloudSync.log.run",
	info: "cloudSync.log.info",
};

const SKIP_REASON: Record<string, MessageKey> = {
	duplicate: "cloudSync.skip.duplicate",
	case: "cloudSync.skip.case",
	changed: "cloudSync.skip.changed",
	unsaved: "cloudSync.skip.unsaved",
	large: "cloudSync.skip.large",
};

const OUTCOME_LABEL: Record<string, MessageKey> = {
	ok: "cloudSync.outcome.ok",
	partial: "cloudSync.outcome.partial",
	confirm: "cloudSync.outcome.confirm",
	auth: "cloudSync.outcome.auth",
	offline: "cloudSync.outcome.offline",
	"too-many": "cloudSync.outcome.tooMany",
	cancelled: "cloudSync.outcome.cancelled",
	failed: "cloudSync.outcome.failed",
	"signed-in": "cloudSync.info.signedIn",
	disconnected: "cloudSync.info.disconnected",
};

/** The text of one log line (what happened, to what). */
export function logLine(e: LogEntry): { label: string; text: string } {
	const label = t(KIND_LABEL[e.kind]);
	if (e.kind === "run" || e.kind === "info") {
		const key = OUTCOME_LABEL[e.path];
		return { label, text: (key ? t(key) : e.path) + (e.detail ? `: ${e.detail}` : "") };
	}
	if (e.kind === "conflict" && e.detail) return { label, text: `${e.path} → ${e.detail}` };
	if (e.kind === "skip" && e.detail) {
		const key = SKIP_REASON[e.detail];
		return { label, text: `${e.path} (${key ? t(key) : e.detail})` };
	}
	if (e.kind === "error" && e.detail) return { label, text: `${e.path}: ${e.detail}` };
	return { label, text: e.path };
}

function timeOf(at: number): string {
	try {
		return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return new Date(at).toISOString().slice(0, 16);
	}
}

/** The activity log: the last entries on this device, newest first, in a scrolling box under the row. */
export function renderCloudLogRow(setting: Setting, service: CloudSyncService): () => void {
	setting.settingEl.addClass("nb-cloudsync-log-row");
	const box = setting.settingEl.createDiv({ cls: "nb-ui nb-cloudsync-log", attr: { role: "log", "aria-label": t("settings.cloudSyncLog") } });
	const update = (): void => {
		box.empty();
		const log = service.log();
		if (log.length === 0) {
			box.createDiv({ cls: "nb-cloudsync-log-empty", text: t("cloudSync.log.empty") });
			return;
		}
		for (const e of log) {
			const { label, text } = logLine(e);
			const row = box.createDiv({ cls: `nb-cloudsync-log-line is-${e.kind}` });
			row.createSpan({ cls: "nb-cloudsync-log-time", text: timeOf(e.at) });
			row.createSpan({ cls: "nb-cloudsync-log-kind", text: label });
			row.createSpan({ cls: "nb-cloudsync-log-text", text });
		}
	};
	update();
	return service.onChange(update);
}
