/**
 * 0.22 (roadmap #126): the cloud sync, wired to Obsidian. The rules are in planner.ts, one run in engine.ts (both tested in Node);
 * this file supplies the triggers, the sign-in hooks, the network check, the notices, the confirmations and the per-device
 * memory. Opt-in: nothing runs and nothing leaves the device until a service is chosen AND signed in on this device. No telemetry.
 *
 * When it runs (each can be switched off): a little after start-up, when the app goes to the background or quits (best effort:
 * the open notebooks are saved first), every N minutes while open, and on demand (command, settings button, status bar item).
 * Automatic runs wait for the pen to be off the screen. One run at a time.
 *
 * Review W22 safety:
 *  - S1: nothing runs (no trigger, not even "Sync now") before the vault is loaded: Obsidian's layout is ready AND its metadata
 *    cache reported the first full resolve (or READY_FALLBACK_MS passed after the layout, if that event came before we listened).
 *    A run on a half-indexed vault would read not-yet-listed files as deleted.
 *  - S5: "Disconnect" stops the run in progress and waits for it to end before it forgets the sign-in and the sync state.
 *  - S7: the runs at start-up and on leaving never delete (deletions wait for the next periodic or manual run), and automatic
 *    runs stop and ask above MASS_DELETE_AUTO_MAX deletions.
 *  - S16: with "Wi-Fi only" on a phone or tablet whose network type is unknown, automatic runs wait ("Sync now" still works,
 *    with a note); files above the mobile size cap are never transferred on a phone or tablet.
 *  - Signing in to another service first disconnects (and revokes where possible) the one this device was signed in to.
 */
import { Platform, setIcon, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { NotebookSettings } from "../settings";
import { whenIdle } from "../storage/idle";
import { showErrorNotice, showNotice } from "../view/notice";
import { cloudSecretKey, NO_SYNC_AUTH, type SyncAuthUI } from "./auth-ui";
import { withoutUrls } from "./auth/retry";
import { emptyResult, runSync, type SyncOutcome, type SyncResult } from "./engine";
import { sha256Hex } from "./hash";
import { networkVerdict, type NetworkVerdict } from "./network";
import { MASS_DELETE_AUTO_MAX, type DeletionPolicy } from "./planner";
import type { ProviderId } from "./provider-types";
import { chosenProvider, clientIdOf, fixedExclusions, needsClientSecret, scopeRules } from "./settings";
import { MAX_PATHS } from "./state";
import { normaliseSyncMemory, rememberInfo, rememberRun, SYNC_MEMORY_KEY, type LogEntry, type SyncMemory } from "./sync-memory";
import { vaultLocalPort, vaultStatePort, type VaultStatePort } from "./vault-adapter";

/** First automatic run this long after start-up (and never before the vault is loaded). */
const OPEN_DELAY_MS = 20_000;
/** The vault counts as loaded this long after the layout is ready even if the metadata cache's "resolved" came earlier. */
export const READY_FALLBACK_MS = 30_000;
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
	/** The state file of this device (tests pass a fake; the default is the vault adapter's). */
	statePort?: () => VaultStatePort;
	/** Whether this is a phone or tablet (default: Obsidian's `Platform.isMobile`). */
	mobile?: () => boolean;
}

/** What one trigger may do (pure; tested). */
export function triggerPolicy(trigger: SyncTrigger, restore: boolean): { deletions: DeletionPolicy; massDeleteMax?: number } {
	if (restore) return { deletions: "restore" };
	if (trigger === "open" || trigger === "close") return { deletions: "defer", massDeleteMax: MASS_DELETE_AUTO_MAX };
	if (trigger === "interval") return { deletions: "guard", massDeleteMax: MASS_DELETE_AUTO_MAX };
	return { deletions: "guard" };
}

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
	/** Review W22 S1: the layout is ready, and the vault's files are all indexed. */
	private layoutReady = false;
	private indexed = false;
	/** The start-up run is due and waits for the vault to be loaded. */
	private openDue = false;
	/** The run in progress (S5: "Disconnect" waits for it). */
	private current: Promise<SyncResult | null> | null = null;
	private disconnecting = false;
	/** Deletions the last start-up or leaving run left for later (shown in the status). */
	private deferred = 0;
	/** Notes already given in this app session (names that cannot be synced, files too large here). */
	private readonly told = new Set<string>();

	constructor(private readonly d: CloudSyncDeps, auth: SyncAuthUI = NO_SYNC_AUTH) {
		this.auth = auth;
		this.memory = this.loadMemory();
	}

	private mobile(): boolean {
		return this.d.mobile ? this.d.mobile() : Platform.isMobile;
	}

	private statePort(): VaultStatePort {
		return this.d.statePort ? this.d.statePort() : vaultStatePort(this.d.app, this.d.pluginId, this.d.deviceId);
	}

	/** The Obsidian app (for the settings' dialogs). */
	app(): App {
		return this.d.app;
	}

	/** Review W22 S1: true once the vault is loaded; no run starts before. */
	ready(): boolean {
		return this.layoutReady && this.indexed;
	}

	/** The layout is ready (Obsidian's `onLayoutReady`). */
	markLayoutReady(): void {
		this.layoutReady = true;
		this.whenReady();
	}

	/** The metadata cache resolved every file (its "resolved" event), or the fallback delay passed. */
	markIndexed(): void {
		this.indexed = true;
		this.whenReady();
	}

	private whenReady(): void {
		if (!this.ready()) return;
		this.emit();
		if (this.openDue) {
			this.openDue = false;
			if (this.d.settings().cloudSyncOnOpen) void this.run("open");
		}
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
		// Review W22 S1: the first full resolve of the metadata cache says every file of the vault is indexed.
		plugin.registerEvent(this.d.app.metadataCache.on("resolved", () => {
			if (!this.indexed) this.markIndexed();
		}));
		this.d.app.workspace.onLayoutReady(() => {
			this.markLayoutReady();
			plugin.registerInterval(window.setTimeout(() => {
				if (!this.indexed) this.markIndexed();
			}, READY_FALLBACK_MS));
			plugin.registerInterval(window.setTimeout(() => {
				this.openDue = true;
				this.whenReady();
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
		if (!this.auth.isSignedIn(p)) {
			// Signed in to the other service on this device: signing in here disconnects that one first.
			const other = this.auth.signedInAs?.() ?? null;
			return other && other !== p ? `${t("cloudSync.account.signedOut")} ${t("cloudSync.account.otherSignedIn", { provider: providerName(other) })}` : t("cloudSync.account.signedOut");
		}
		const line = t("cloudSync.account.signedIn", {
			account: this.auth.accountLabel(p) ?? t("cloudSync.account.unknown"),
			folder: this.auth.rootLabel(p) ?? t("cloudSync.account.noFolder"),
		});
		// Google's drive.file scope only sees what the same OAuth client created: every device must use the same client ID.
		// Review W22 S13: OneDrive is reached through its app folder (Files.ReadWrite.AppFolder), never the whole drive.
		return `${line} ${t(p === "gdrive" ? "cloudSync.account.gdriveNote" : "cloudSync.account.onedriveNote")}`;
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
		else if (this.blocked === "unknown") parts.push(t("cloudSync.status.unknownWaits"));
		else if (this.network === "unknown") parts.push(t("cloudSync.status.unknownNetwork"));
		if (this.deferred > 0) parts.push(t("cloudSync.status.deferred", { count: String(this.deferred) }));
		if (!this.ready()) parts.push(t("cloudSync.status.loading"));
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

	/** The periodic check (also when the app comes back to the foreground). */
	tick(): void {
		const s = this.d.settings();
		if (this.stopped || this.busy || !this.ready() || !this.provider() || s.cloudSyncInterval <= 0) return;
		const last = this.memory.last?.at ?? 0;
		if (Date.now() - last >= s.cloudSyncInterval * 60_000) void this.run("interval");
	}

	/** The app goes to the background or quits. */
	onLeave(): void {
		if (!this.ready() || !this.d.settings().cloudSyncOnClose || !this.provider() || this.busy) return;
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
		if (this.stopped || this.disconnecting) return null;
		if (!this.ready()) {
			// Review W22 S1: a half-indexed vault would read its not-yet-listed files as deleted.
			if (manual) showNotice(t("cloudSync.notice.loading"));
			return null;
		}
		if (this.busy) {
			if (manual) showNotice(t("cloudSync.notice.already"));
			return null;
		}
		const job = this.execute(trigger, extra, manual);
		this.current = job;
		try {
			return await job;
		} finally {
			if (this.current === job) this.current = null;
		}
	}

	private async execute(trigger: SyncTrigger, extra: { allowedDeletes?: ReadonlySet<string>; restore?: boolean }, manual: boolean): Promise<SyncResult | null> {
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
		// Review W22 S16: "Wi-Fi only" cannot be checked on this phone or tablet: automatic runs wait, "Sync now" goes with a note.
		// (A desktop never reports a network type; it is not held back.)
		if (net === "unknown" && this.mobile()) {
			if (!manual) {
				this.blocked = "unknown";
				this.emit();
				return null;
			}
			showNotice(t("cloudSync.notice.unknownNetwork"));
		}
		this.blocked = null;
		this.busy = true;
		// Made before any wait, so a "Stop" or "Disconnect" during the wait or the connection is not lost (the engine checks it first).
		this.controller = new AbortController();
		this.progressText = t("cloudSync.status.running");
		this.emit();
		let result: SyncResult;
		try {
			// Automatic runs wait for the pen to be off the screen; "on close" cannot wait.
			if (trigger === "open" || trigger === "interval") await whenIdle(0, 10_000);
			// Unsaved work first (also the only chance on close).
			await this.d.flushAll();
			result = await this.runOnce(provider, trigger, extra);
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
		this.deferred = result.deferredDeletes;
		this.announce(result, trigger);
		this.tell(result);
		this.emit();
		if (this.pending && trigger !== "close" && document.visibilityState === "visible") this.ask(this.pending);
		return result;
	}

	private async runOnce(provider: ProviderId, trigger: SyncTrigger, extra: { allowedDeletes?: ReadonlySet<string>; restore?: boolean }): Promise<SyncResult> {
		const remote = await this.auth.connect(provider);
		if (!remote) return { ...failure(new Error("not signed in")), outcome: "auth" };
		const s = this.d.settings();
		const { app } = this.d;
		this.controller ??= new AbortController();
		const signal = this.controller.signal;
		const policy = triggerPolicy(trigger, extra.restore === true);
		return runSync(
			{
				local: vaultLocalPort(app, this.d.settle),
				remote,
				state: this.statePort(),
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
				deletions: policy.deletions,
				massDeleteMax: policy.massDeleteMax,
				allowedDeletes: extra.allowedDeletes,
				hardMaxBytes: this.mobile() ? s.cloudSyncMobileMaxMb * MB : 0,
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

	/**
	 * One note per app session for files a run skipped for good reasons that do not go away by themselves: names that cannot exist
	 * on every device (review W22 S10) and files above the size cap of this phone or tablet (S16). The activity log lists them.
	 */
	private tell(r: SyncResult): void {
		const once = (key: string, text: string): void => {
			if (this.told.has(key)) return;
			this.told.add(key);
			showNotice(text, 10_000);
		};
		if (r.unsyncable.length > 0) once(`names:${[...r.unsyncable].sort().join("|")}`, t("cloudSync.notice.names", { count: String(r.unsyncable.length), example: r.unsyncable[0]! }));
		if (r.tooLarge.length > 0) once(`large:${r.tooLarge.map((x) => x.path).sort().join("|")}`, t("cloudSync.notice.tooLarge", { count: String(r.tooLarge.length), limit: String(this.d.settings().cloudSyncMobileMaxMb) }));
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
			const v: unknown = this.d.app.loadLocalStorage(cloudSecretKey(p));
			return typeof v === "string" ? v : "";
		} catch {
			return "";
		}
	}

	setClientSecret(p: ProviderId, value: string): void {
		try {
			this.d.app.saveLocalStorage(cloudSecretKey(p), value.trim() || null);
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
		// One account per device: the service this device was signed in to before is disconnected first (revoked where possible),
		// with its sync state, so no sign-in is left behind.
		const other = this.auth.signedInAs?.() ?? null;
		if (other && other !== p) await this.signOutOf(other, false);
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
	 * `forgetSecret`: also forget the Google client secret typed on this device.
	 */
	async disconnect(o: { forgetSecret?: boolean } = {}): Promise<void> {
		const p = this.provider();
		if (!p) return;
		await this.signOutOf(p, o.forgetSecret === true);
	}

	/**
	 * Review W22 S5: the run in progress is stopped and awaited first, so its last save cannot bring the state back after it was
	 * removed (a later sign-in then starts with the promised union). No run starts meanwhile.
	 */
	private async signOutOf(p: ProviderId, forgetSecret: boolean): Promise<void> {
		this.disconnecting = true;
		try {
			this.cancel();
			const running = this.current;
			if (running) await running.catch(() => null);
			const out = await this.auth.signOut(p);
			try {
				await this.statePort().remove();
			} catch (e) {
				console.error("[notebook] cloud sync: could not remove the sync state", e);
			}
			if (forgetSecret) this.setClientSecret(p, "");
			this.pending = null;
			this.deferred = 0;
			this.memory = rememberInfo({ ...this.memory, last: null }, Date.now(), "disconnected");
			this.saveMemory();
			showNotice(t("cloudSync.notice.disconnected", { provider: providerName(p) }));
			// The access could not be revoked from here: say where to remove it by hand.
			if (out && !out.revoked) showNotice(t("cloudSync.notice.revokeByHand", { provider: providerName(p), url: out.manageUrl ?? "" }), 0);
		} finally {
			this.disconnecting = false;
			this.emit();
		}
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
	return { ...emptyResult("failed"), error: withoutUrls(e instanceof Error ? e.message : String(e)) };
}
