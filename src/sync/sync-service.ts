/**
 * 0.22 (roadmap #126): the cloud sync, wired to Obsidian. The rules are in planner.ts, one run in engine.ts (both tested in Node);
 * this file supplies the triggers, the sign-in hooks, the network check, the notices, the confirmations and the per-device
 * memory. Opt-in: nothing runs and nothing leaves the device until a service is chosen AND signed in on this device. No telemetry.
 *
 * When it runs (each can be switched off): a little after start-up, when the app goes to the background or quits (best effort:
 * the open notebooks are saved first), every N minutes while open, and on demand (command, settings button, status bar item).
 * Automatic runs wait for the pen to be off the screen. One run at a time.
 */
import { Platform, setIcon, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { NotebookSettings } from "../settings";
import { whenIdle } from "../storage/idle";
import { showErrorNotice, showNotice } from "../view/notice";
import { NO_SYNC_AUTH, type SyncAuthUI } from "./auth-ui";
import { runSync, type SyncOutcome, type SyncResult } from "./engine";
import { sha256Hex } from "./hash";
import { networkVerdict, type NetworkVerdict } from "./network";
import type { ProviderId } from "./provider-types";
import { chosenProvider, clientIdOf, fixedExclusions, needsClientSecret, scopeRules } from "./settings";
import { MAX_PATHS } from "./state";
import { normaliseSyncMemory, rememberInfo, rememberRun, SYNC_MEMORY_KEY, type LogEntry, type SyncMemory } from "./sync-memory";
import { vaultLocalPort, vaultStatePort } from "./vault-adapter";

/** First automatic run this long after start-up (the vault is still indexing before that). */
const OPEN_DELAY_MS = 20_000;
/** The interval is checked this often. */
const TICK_MS = 60_000;
/** "On close" runs at most this often (switching apps back and forth). */
const CLOSE_MIN_GAP_MS = 60_000;
const MB = 1024 * 1024;

export type SyncTrigger = "open" | "close" | "interval" | "manual" | "confirm";

export interface CloudSyncDeps {
	app: App;
	pluginId: string;
	/** This device's sidecar id (names the state file). */
	deviceId: string;
	settings: () => NotebookSettings;
	/** Saves every open notebook (the views' own flush). */
	flushAll: () => Promise<unknown>;
	/** Saves the notebook open at `path`; true when nothing is left unsaved (or it is not open). */
	settle: (path: string) => Promise<boolean>;
	/** This device's name (for the names of conflicted copies). */
	deviceName: () => string;
	/** The confirmation dialogs (view/cloud-sync-modals.ts); injected so this file stays free of UI code. */
	confirmDeletes?: (items: SyncResult["heldDeletes"], decide: (choice: "delete" | "keep" | null) => void) => void;
	confirmLarge?: (items: SyncResult["askLarge"], limitMb: number, decide: (choice: "sync" | "skip" | null) => void) => void;
}

/** Local-storage key of the client secret of `p` (device-local, see CloudSyncService.clientSecret). */
const secretKey = (p: ProviderId): string => `notebook-cloud-sync-secret-${p}`;

/** Local date and time as a short text. */
function whenText(at: number): string {
	try {
		return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	} catch {
		return new Date(at).toISOString();
	}
}

/** Short time for the status bar. */
function shortTime(at: number): string {
	try {
		return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	} catch {
		return new Date(at).toISOString().slice(11, 16);
	}
}

export function providerName(p: ProviderId): string {
	return t(p === "gdrive" ? "settings.cloudSyncProvider.gdrive" : "settings.cloudSyncProvider.onedrive");
}

/** "3 up, 1 down, 0 deleted, 0 kept both" or "everything up to date". */
export function summaryText(c: SyncResult["counts"]): string {
	const deleted = c.delLocal + c.delRemote;
	if (c.up + c.down + deleted + c.conflicts === 0) return t("cloudSync.summary.none");
	return t("cloudSync.summary", { up: String(c.up), down: String(c.down), deleted: String(deleted), conflicts: String(c.conflicts) });
}

const OUTCOME_STATUS: Record<SyncOutcome, MessageKey> = {
	ok: "cloudSync.status.ok",
	partial: "cloudSync.status.partial",
	confirm: "cloudSync.status.confirm",
	auth: "cloudSync.status.auth",
	offline: "cloudSync.status.offline",
	"too-many": "cloudSync.status.tooMany",
	cancelled: "cloudSync.status.cancelled",
	failed: "cloudSync.status.failed",
};

export class CloudSyncService {
	private auth: SyncAuthUI;
	private memory: SyncMemory;
	private busy = false;
	private stopped = false;
	private controller: AbortController | null = null;
	private readonly listeners = new Set<() => void>();
	private progressText = "";
	/** Why the last attempt did not run (network), shown in the status. */
	private blocked: NetworkVerdict | null = null;
	private network: NetworkVerdict | null = null;
	/** The notice shown last (the same problem is announced once until something else happens). */
	private lastNotice: string | null = null;
	private lastCloseRun = 0;
	/** Decisions of this app session. */
	private readonly approvedLarge = new Set<string>();
	private readonly declinedLarge = new Set<string>();
	/** What the last run waits for (the "Review" button reopens it). */
	private pending: SyncResult | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(private readonly d: CloudSyncDeps, auth: SyncAuthUI = NO_SYNC_AUTH) {
		this.auth = auth;
		this.memory = this.loadMemory();
	}

	/** Integration: the providers' sign-in (src/sync/auth/). */
	setAuth(auth: SyncAuthUI): void {
		this.auth = auth;
		this.emit();
	}

	authUI(): SyncAuthUI {
		return this.auth;
	}

	register(plugin: Plugin): void {
		plugin.register(() => this.stop());
		this.d.app.workspace.onLayoutReady(() => {
			plugin.registerInterval(window.setTimeout(() => {
				if (this.d.settings().cloudSyncOnOpen) void this.run("open");
			}, OPEN_DELAY_MS));
			plugin.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
		});
		plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.onLeave();
			else this.tick();
		});
		plugin.registerEvent(this.d.app.workspace.on("quit", () => this.onLeave()));
		// Desktop: a small item in Obsidian's status bar (mobile has none; the settings show the same status).
		if (!Platform.isMobile) {
			const el = plugin.addStatusBarItem();
			el.addClass("nb-ui", "nb-cloudsync-bar", "mod-clickable");
			el.setAttr("role", "button");
			el.setAttr("aria-label", t("cloudSync.bar.title"));
			el.addEventListener("click", () => void this.run("manual"));
			this.statusEl = el;
			this.renderBar();
			this.listeners.add(() => this.renderBar());
		}
	}

	stop(): void {
		this.stopped = true;
		this.controller?.abort();
		this.listeners.clear();
	}

	// ------------------------------------------------------------------------------------------------- what the UI shows

	provider(): ProviderId | null {
		return chosenProvider(this.d.settings());
	}

	running(): boolean {
		return this.busy;
	}

	/** The last run waits for a decision (held deletions, large files). */
	waiting(): boolean {
		return this.pending !== null && !this.busy;
	}

	log(): readonly LogEntry[] {
		return this.memory.log;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** The account line of the settings. */
	accountText(): string {
		const p = this.provider();
		if (!p) return t("cloudSync.status.off");
		if (!this.auth.available(p)) return t("cloudSync.account.unavailable", { provider: providerName(p) });
		if (!this.auth.isSignedIn(p)) return t("cloudSync.account.signedOut");
		return t("cloudSync.account.signedIn", {
			account: this.auth.accountLabel(p) ?? t("cloudSync.account.unknown"),
			folder: this.auth.rootLabel(p) ?? t("cloudSync.account.noFolder"),
		});
	}

	/** The status line under "Sync now". */
	statusText(): string {
		if (this.busy) return this.progressText || t("cloudSync.status.running");
		const p = this.provider();
		if (!p) return t("cloudSync.status.off");
		if (!this.auth.isSignedIn(p)) return t("cloudSync.status.signIn");
		const parts: string[] = [];
		const last = this.memory.last;
		if (!last) parts.push(t("cloudSync.status.never"));
		else parts.push(t(OUTCOME_STATUS[last.outcome], { time: whenText(last.at), summary: summaryText(last.counts), error: last.error ?? "?", max: String(MAX_PATHS) }));
		if (this.blocked === "metered") parts.push(t("cloudSync.status.waitWifi"));
		else if (this.blocked === "offline") parts.push(t("cloudSync.status.offlineNow"));
		else if (this.network === "unknown") parts.push(t("cloudSync.status.unknownNetwork"));
		return parts.join(" ");
	}

	private renderBar(): void {
		const el = this.statusEl;
		if (!el) return;
		const p = this.provider();
		el.toggleClass("notebook-hidden", !p);
		if (!p) return;
		el.empty();
		setIcon(el.createSpan({ cls: "nb-cloudsync-bar-icon" }), this.busy ? "refresh-cw" : "cloud");
		const last = this.memory.last;
		const attention = !this.auth.isSignedIn(p) || this.pending !== null || (last !== null && last.outcome !== "ok" && last.outcome !== "partial");
		el.toggleClass("is-attention", attention && !this.busy);
		el.createSpan({
			text: this.busy ? t("cloudSync.bar.syncing") : attention ? t("cloudSync.bar.attention") : last ? t("cloudSync.bar.synced", { time: shortTime(last.at) }) : t("cloudSync.bar.never"),
		});
	}

	// ----------------------------------------------------------------------------------------------------------- triggers

	private tick(): void {
		const s = this.d.settings();
		if (this.stopped || this.busy || !this.provider() || s.cloudSyncInterval <= 0) return;
		const last = this.memory.last?.at ?? 0;
		if (Date.now() - last >= s.cloudSyncInterval * 60_000) void this.run("interval");
	}

	private onLeave(): void {
		if (!this.d.settings().cloudSyncOnClose || !this.provider() || this.busy) return;
		if (Date.now() - this.lastCloseRun < CLOSE_MIN_GAP_MS) return;
		this.lastCloseRun = Date.now();
		void this.run("close");
	}

	/** "Sync now" (the command, the settings button and the status bar item). */
	syncNow(): Promise<SyncResult | null> {
		return this.run("manual");
	}

	/** Stops the run in progress (between files; nothing half-written). */
	cancel(): void {
		this.controller?.abort();
	}

	/** Shows again what the last run waits for. */
	review(): void {
		if (this.pending) this.ask(this.pending);
	}

	// -------------------------------------------------------------------------------------------------------------- run

	private noticeOnce(key: string, text: string, error = false): void {
		if (this.lastNotice === key) return;
		this.lastNotice = key;
		if (error) showErrorNotice(text, 10_000);
		else showNotice(text, 8000);
	}

	async run(trigger: SyncTrigger, extra: { allowedDeletes?: ReadonlySet<string>; restore?: boolean } = {}): Promise<SyncResult | null> {
		const manual = trigger === "manual" || trigger === "confirm";
		if (this.stopped) return null;
		if (this.busy) {
			if (manual) showNotice(t("cloudSync.notice.already"));
			return null;
		}
		const s = this.d.settings();
		const provider = chosenProvider(s);
		if (!provider) {
			if (manual) showNotice(t("cloudSync.notice.off"));
			return null;
		}
		if (!this.auth.isSignedIn(provider)) {
			if (manual) showNotice(t("cloudSync.notice.signIn", { provider: providerName(provider) }));
			this.emit();
			return null;
		}
		const net = networkVerdict(typeof navigator === "undefined" ? undefined : navigator, s.cloudSyncWifiOnly);
		this.network = net;
		if (net === "metered" || net === "offline") {
			this.blocked = net;
			if (manual) showNotice(t(net === "metered" ? "cloudSync.notice.metered" : "cloudSync.notice.offlineNow"));
			this.emit();
			return null;
		}
		this.blocked = null;
		this.busy = true;
		this.progressText = t("cloudSync.status.running");
		this.emit();
		let result: SyncResult;
		try {
			// Automatic runs wait for the pen to be off the screen; "on close" cannot wait.
			if (trigger === "open" || trigger === "interval") await whenIdle(0, 10_000);
			// Unsaved work first (also the only chance on close).
			await this.d.flushAll();
			result = await this.runOnce(provider, extra);
		} catch (e) {
			// `connect` may ask for a new sign-in; anything else is unexpected.
			if (e instanceof Error && e.name === "AuthRequiredError") result = { ...failure(e), outcome: "auth" };
			else {
				console.error("[notebook] cloud sync could not start", e);
				result = failure(e);
			}
		}
		this.busy = false;
		this.progressText = "";
		this.controller = null;
		const at = Date.now();
		this.memory = rememberRun(this.memory, { at, outcome: result.outcome, counts: result.counts, ...(result.error ? { error: result.error } : {}) }, result.events);
		this.saveMemory();
		this.pending = result.outcome === "confirm" ? result : null;
		this.announce(result, trigger);
		this.emit();
		if (this.pending && trigger !== "close" && document.visibilityState === "visible") this.ask(this.pending);
		return result;
	}

	private async runOnce(provider: ProviderId, extra: { allowedDeletes?: ReadonlySet<string>; restore?: boolean }): Promise<SyncResult> {
		const remote = await this.auth.connect(provider);
		if (!remote) return { ...failure(new Error("not signed in")), outcome: "auth" };
		const s = this.d.settings();
		const { app } = this.d;
		this.controller = new AbortController();
		const signal = this.controller.signal;
		return runSync(
			{
				local: vaultLocalPort(app, this.d.settle),
				remote,
				state: vaultStatePort(app, this.d.pluginId, this.d.deviceId),
				hash: sha256Hex,
				now: () => Date.now(),
				sleep: (ms) => new Promise<void>((resolve) => void window.setTimeout(resolve, ms)),
				signal,
				progress: (done, total) => {
					this.progressText = t("cloudSync.status.progress", { done: String(done), total: String(total) });
					this.emit();
				},
			},
			{
				root: this.auth.rootId(provider),
				scope: scopeRules(s),
				fixed: fixedExclusions(app.vault.configDir, s.zipBackupFolder),
				deletions: extra.restore ? "restore" : "guard",
				allowedDeletes: extra.allowedDeletes,
				largeBytes: s.cloudSyncLargeMb * MB,
				large: s.cloudSyncLarge,
				approvedLarge: this.approvedLarge,
				declinedLarge: this.declinedLarge,
				device: this.d.deviceName(),
			},
		);
	}

	private announce(r: SyncResult, trigger: SyncTrigger): void {
		const manual = trigger === "manual" || trigger === "confirm";
		const provider = this.provider();
		switch (r.outcome) {
			case "ok":
			case "partial":
				this.lastNotice = null;
				if (r.counts.conflicts > 0) showNotice(t("cloudSync.notice.conflicts", { count: String(r.counts.conflicts) }), 10_000);
				else if (manual) showNotice(t("cloudSync.notice.done", { summary: summaryText(r.counts) }));
				return;
			case "confirm":
				if (trigger === "close" || document.visibilityState !== "visible") this.noticeOnce("confirm", t("cloudSync.notice.confirm"));
				return;
			case "auth":
				this.noticeOnce("auth", t("cloudSync.notice.auth", { provider: provider ? providerName(provider) : "" }), true);
				return;
			case "offline":
				this.noticeOnce("offline", t("cloudSync.notice.offline"), true);
				return;
			case "too-many":
				this.noticeOnce("too-many", t("cloudSync.notice.tooMany", { max: String(MAX_PATHS) }), true);
				return;
			case "cancelled":
				if (manual) showNotice(t("cloudSync.status.cancelled", { time: whenText(Date.now()) }));
				return;
			case "failed":
				this.noticeOnce(`failed:${r.error ?? ""}`, t("cloudSync.notice.failed", { error: r.error ?? "?" }), true);
				return;
		}
	}

	/** Opens the dialogs for what the run waits for: first the held deletions, then the large files. */
	private ask(r: SyncResult): void {
		if (r.heldDeletes.length > 0 && this.d.confirmDeletes) {
			this.d.confirmDeletes(r.heldDeletes, (choice) => {
				if (choice === "delete") void this.run("confirm", { allowedDeletes: new Set(r.heldDeletes.map((h) => h.path)) });
				else if (choice === "keep") void this.run("confirm", { restore: true });
			});
			return;
		}
		if (r.askLarge.length > 0 && this.d.confirmLarge) {
			this.d.confirmLarge(r.askLarge, this.d.settings().cloudSyncLargeMb, (choice) => {
				if (choice === null) return;
				for (const item of r.askLarge) (choice === "sync" ? this.approvedLarge : this.declinedLarge).add(item.path);
				void this.run("confirm");
			});
		}
	}

	// ------------------------------------------------------------------------------------------------------- account

	/** The Google client secret kept on this device only (local storage, never in the synced settings); "" when none. */
	clientSecret(p: ProviderId): string {
		try {
			const v: unknown = this.d.app.loadLocalStorage(secretKey(p));
			return typeof v === "string" ? v : "";
		} catch {
			return "";
		}
	}

	setClientSecret(p: ProviderId, value: string): void {
		try {
			this.d.app.saveLocalStorage(secretKey(p), value.trim() || null);
		} catch (e) {
			console.error("[notebook] could not store the client secret", e);
		}
	}

	async signIn(): Promise<void> {
		const p = this.provider();
		if (!p || !this.auth.available(p)) return;
		const clientId = clientIdOf(this.d.settings(), p);
		const clientSecret = needsClientSecret(p) ? this.clientSecret(p) : undefined;
		if (!clientId || (needsClientSecret(p) && !clientSecret)) {
			showNotice(t(clientId ? "cloudSync.notice.clientSecret" : "cloudSync.notice.clientId", { provider: providerName(p) }));
			return;
		}
		const ok = await this.auth.signIn(p, clientSecret ? { clientId, clientSecret } : { clientId });
		if (ok) {
			this.memory = rememberInfo(this.memory, Date.now(), "signed-in");
			this.saveMemory();
			this.lastNotice = null;
		}
		this.emit();
		if (ok) void this.run("manual");
	}

	async chooseRoot(): Promise<void> {
		const p = this.provider();
		if (!p || !this.auth.chooseRoot) return;
		await this.auth.chooseRoot(p);
		this.emit();
	}

	/**
	 * "Disconnect": forgets this device's sign-in and sync state (the service choice stays, so "Sign in" is offered again). No file
	 * is touched on either side; connecting again later starts with a safe first sync (a union, nothing deleted).
	 */
	async disconnect(): Promise<void> {
		const p = this.provider();
		this.cancel();
		const out = p ? await this.auth.signOut(p) : undefined;
		try {
			await vaultStatePort(this.d.app, this.d.pluginId, this.d.deviceId).remove();
		} catch (e) {
			console.error("[notebook] cloud sync: could not remove the sync state", e);
		}
		this.pending = null;
		this.memory = rememberInfo({ ...this.memory, last: null }, Date.now(), "disconnected");
		this.saveMemory();
		if (p) showNotice(t("cloudSync.notice.disconnected", { provider: providerName(p) }));
		// The access could not be revoked from here: say where to remove it by hand.
		if (p && out && !out.revoked) showNotice(t("cloudSync.notice.revokeByHand", { provider: providerName(p), url: out.manageUrl ?? "" }), 0);
		this.emit();
	}

	// -------------------------------------------------------------------------------------------------------- memory

	private loadMemory(): SyncMemory {
		try {
			return normaliseSyncMemory(this.d.app.loadLocalStorage(SYNC_MEMORY_KEY));
		} catch {
			return normaliseSyncMemory(null);
		}
	}

	private saveMemory(): void {
		try {
			this.d.app.saveLocalStorage(SYNC_MEMORY_KEY, this.memory);
		} catch (e) {
			console.error("[notebook] could not store the cloud sync status", e);
		}
	}

	private emit(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] cloud sync status listener failed", e);
			}
		}
	}
}

function failure(e: unknown): SyncResult {
	return {
		outcome: "failed", first: false, damaged: false, events: [], heldDeletes: [], askLarge: [], skippedLarge: [],
		counts: { up: 0, down: 0, delLocal: 0, delRemote: 0, conflicts: 0, skipped: 0, errors: 0 },
		error: e instanceof Error ? e.message : String(e),
	};
}
