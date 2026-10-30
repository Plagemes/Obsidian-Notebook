// wave 0.7: sync safety (roadmap #342–#345). The UI side; pure logic in storage/presence-logic.ts and storage/sync-state.ts.
import { debounce, Modal, Notice, Setting, TFile, type App, type Component, type Plugin, type SettingDefinitionAction, type SettingDefinitionRender, type TAbstractFile } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { NotebookDocument } from "../model/types";
import { PresenceService } from "../storage/presence";
import { minutesSince, type DeviceRecord, type PresenceRecord } from "../storage/presence-logic";
import type { DocumentSession, SessionMode } from "../storage/session";
import {
	formatBytes, issueSignature, LONG_PATH_CHARS, scanForSyncIssues, segmentIssue, sizeIssue, type SyncIssue,
} from "../storage/sync-state";

/** Plugin local storage key of the last startup check result (the notice is shown again only when it changes). */
const CHECK_KEY = "notebook-sync-check";
/** The startup check waits for the vault index to settle. */
const STARTUP_CHECK_DELAY_MS = 8000;
/** A notebook that is not downloaded yet is looked at again this often while the app is visible. */
const NOT_DOWNLOADED_POLL_MS = 4000;

interface SyncPluginHost extends Plugin {
	settings: { folder: string };
}

export interface SyncCheckReport {
	folder: string;
	issues: SyncIssue[];
	otherDevices: DeviceRecord[];
}

function agoText(iso: string, nowMs: number): string {
	const n = minutesSince(iso, nowMs);
	return n < 1 ? t("sync.ago.now") : t("sync.ago.min", { n: String(n) });
}

export function describeIssue(issue: SyncIssue): string {
	return t(`sync.issue.${issue.kind}` as MessageKey, {
		path: issue.path,
		other: issue.other ?? "",
		size: issue.size !== undefined ? formatBytes(issue.size) : "",
	});
}

/** Issues of one notebook file (its own path and size; folders are covered by the vault check). */
function fileIssues(file: TFile): SyncIssue[] {
	const out: SyncIssue[] = [];
	let prefix = "";
	for (const segment of file.path.split("/")) {
		prefix = prefix ? `${prefix}/${segment}` : segment;
		const kind = segmentIssue(segment);
		if (kind) {
			out.push({ kind, path: prefix });
			break;
		}
	}
	if (file.path.length > LONG_PATH_CHARS) out.push({ kind: "long-path", path: file.path });
	const big = sizeIssue(file.path, file.stat.size);
	if (big) out.push(big);
	return out;
}

/**
 * Plugin-wide part: the presence service, the visibility of the app, the "Check sync safety" command and the
 * startup check (#345). Created once in onload.
 */
export class SyncSafetyService {
	readonly presence: PresenceService;
	private readonly noted = new Set<string>();

	constructor(private readonly plugin: SyncPluginHost) {
		const app = plugin.app;
		this.presence = new PresenceService(app, () => plugin.settings.folder, {
			load: () => app.loadLocalStorage("notebook-device") as unknown,
			save: (value) => app.saveLocalStorage("notebook-device", value),
		});
	}

	register(): void {
		const { plugin } = this;
		// Heartbeats stop while the app is in the background (Android may keep it alive for a long time).
		plugin.registerDomEvent(document, "visibilitychange", () => this.presence.setVisible(document.visibilityState !== "hidden"));
		plugin.registerDomEvent(window, "pagehide", () => this.presence.setVisible(false));
		plugin.registerDomEvent(window, "pageshow", () => this.presence.setVisible(document.visibilityState !== "hidden"));
		// The command "Check sync safety" (sync-check) comes from the action registry (ui/actions.ts) and calls openCheck().
		plugin.app.workspace.onLayoutReady(() => {
			void this.presence.startup();
			const timer = window.setTimeout(() => void this.startupCheck(), STARTUP_CHECK_DELAY_MS);
			plugin.register(() => window.clearTimeout(timer));
		});
	}

	dispose(): void {
		void this.presence.dispose();
	}

	/** Every issue under the notebooks folder, and the other devices seen there. */
	async check(): Promise<SyncCheckReport> {
		const { app } = this.plugin;
		const folder = this.plugin.settings.folder.replace(/^\/+|\/+$/g, "");
		const files = app.vault.getFiles()
			.filter((f) => folder === "" || f.path.startsWith(`${folder}/`))
			// Backups are copies of files that are checked themselves: their size would only repeat the same warning.
			.map((f) => ({ path: f.path, size: f.path.startsWith(`${folder ? `${folder}/` : ""}_backup/`) ? 0 : f.stat.size }));
		const issues = scanForSyncIssues(folder, app.vault.configDir, files);
		let otherDevices: DeviceRecord[] = [];
		try {
			otherDevices = await this.presence.otherDevices();
		} catch (e) {
			console.error("[notebook] could not read the device files", e);
		}
		return { folder, issues, otherDevices };
	}

	async openCheck(): Promise<void> {
		try {
			new SyncCheckModal(this.plugin.app, await this.check()).open();
		} catch (e) {
			new Notice(t("sync.check.failed", { error: (e as Error).message }));
		}
	}

	/** At startup: a notice only when the issues found differ from the last time (no nagging). */
	private async startupCheck(): Promise<void> {
		try {
			const report = await this.check();
			const signature = issueSignature(report.issues);
			const app = this.plugin.app;
			const last = app.loadLocalStorage(CHECK_KEY) as unknown;
			app.saveLocalStorage(CHECK_KEY, signature);
			if (report.issues.length === 0 || last === signature) return;
			this.notice(t("sync.check.notice", { n: String(report.issues.length) }), report);
		} catch (e) {
			console.error("[notebook] sync check failed", e);
		}
	}

	/** A notebook was opened: warns once per session about its own path or size. */
	noteOpened(file: TFile): void {
		if (this.noted.has(file.path)) return;
		const issues = fileIssues(file);
		if (issues.length === 0) return;
		this.noted.add(file.path);
		this.notice(describeIssue(issues[0]!), null);
	}

	private notice(text: string, report: SyncCheckReport | null): void {
		const fragment = createFragment((f) => {
			f.createDiv({ text });
			f.createEl("button", { text: t("sync.check.details") })
				.addEventListener("click", () => {
					if (report) new SyncCheckModal(this.plugin.app, report).open();
					else void this.openCheck();
				});
		});
		new Notice(fragment, 12000);
	}
}

/** #345: the result of the check, with what cannot be detected from inside the vault. */
export class SyncCheckModal extends Modal {
	constructor(app: App, private readonly report: SyncCheckReport) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const { folder, issues, otherDevices } = this.report;
		const shown = folder === "" ? "/" : folder;
		contentEl.empty();
		this.setTitle(t("sync.check.title"));
		if (issues.length === 0) contentEl.createEl("p", { text: t("sync.check.none", { folder: shown }) });
		else {
			contentEl.createEl("p", { text: t("sync.check.found", { n: String(issues.length), folder: shown }) });
			const list = contentEl.createEl("ul", { cls: "notebook-sync-issues" });
			for (const issue of issues.slice(0, 50)) list.createEl("li", { text: describeIssue(issue) });
			if (issues.length > 50) list.createEl("li", { text: t("sync.check.more", { n: String(issues.length - 50) }) });
		}
		const now = Date.now();
		contentEl.createEl("p", {
			text: otherDevices.length === 0
				? t("sync.check.devices.none", { folder: shown })
				: t("sync.check.devices.some", { devices: otherDevices.map((d) => `${d.deviceName} (${agoText(d.lastSeen, now)})`).join(", ") }),
		});
		contentEl.createEl("p", { cls: "notebook-sync-muted", text: t("sync.check.limits") });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Settings rows: this device's name (local, never synced) and the check. Obsidian 1.13+ definitions. */
export function syncSettingDefinitions(service: SyncSafetyService | undefined): Array<SettingDefinitionRender | SettingDefinitionAction> {
	if (!service) return [];
	return [
		{ name: t("settings.deviceName"), desc: t("settings.deviceName.desc"), render: (setting) => deviceNameRow(setting, service) },
		{ name: t("settings.syncCheck"), desc: t("settings.syncCheck.desc"), action: () => void service.openCheck() },
	];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displaySyncSettings(containerEl: HTMLElement, service: SyncSafetyService | undefined): void {
	if (!service) return;
	deviceNameRow(new Setting(containerEl).setName(t("settings.deviceName")).setDesc(t("settings.deviceName.desc")), service);
	new Setting(containerEl)
		.setName(t("settings.syncCheck"))
		.setDesc(t("settings.syncCheck.desc"))
		.addButton((b) => b.setButtonText(t("sync.check.button")).onClick(() => void service.openCheck()));
}

function deviceNameRow(setting: Setting, service: SyncSafetyService): void {
	const save = debounce((v: string) => service.presence.setDeviceName(v), 800, true);
	setting.addText((text) => text.setValue(service.presence.device().name).onChange((v) => save(v)));
}

// ------------------------------------------------------------------------------- per view

export interface ViewSyncDeps {
	app: App;
	/** The view: owns the event registrations. */
	component: Component;
	/** The banner goes into `container`, before `before`. */
	container: HTMLElement;
	before: HTMLElement;
	service: SyncSafetyService | null;
	file(): TFile | null;
	session(): DocumentSession | null;
	/** #343: an asset file arrived or changed. */
	assetFileChanged(file: TFile): void;
	/** Read-only was switched on or off: the view refreshes its tools. */
	editingChanged(): void;
}

/**
 * The per-view part: presence of the open notebook and the "open on another device" banner (#342), the
 * "not downloaded yet" message and its polling (#344), and the vault events that let assets appear (#343).
 */
export class ViewSyncSafety {
	/** The user chose "Open read-only" after the warning: nothing can be changed in this view. */
	readOnly = false;
	private banner: HTMLElement | null = null;
	private notebookId: string | null = null;
	private others: PresenceRecord[] = [];
	private dismissed = new Set<string>();
	private poll: number | null = null;
	private checking = 0;

	constructor(private readonly deps: ViewSyncDeps) {
		const { app, component } = deps;
		const changed = (f: TAbstractFile) => {
			if (!(f instanceof TFile)) return;
			deps.assetFileChanged(f);
			const id = this.notebookId;
			if (id && deps.service?.presence.isOtherPresenceFile(f.path, id)) void this.refreshOthers();
		};
		component.registerEvent(app.vault.on("create", changed));
		component.registerEvent(app.vault.on("modify", changed));
		component.registerEvent(app.vault.on("rename", (f) => changed(f)));
		component.registerEvent(app.vault.on("delete", (f) => {
			const id = this.notebookId;
			if (id && deps.service?.presence.isOtherPresenceFile(f.path, id)) void this.refreshOthers();
		}));
		component.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState !== "hidden") this.pollOnce();
		});
		component.register(() => this.destroy());
	}

	/** Called by the view after every (re)load of the session. */
	loaded(doc: NotebookDocument | null, mode: SessionMode): void {
		if (mode === "not-downloaded") this.startPoll();
		else this.stopPoll();
		const file = this.deps.file();
		if (doc && mode === "ok" && file) {
			if (this.notebookId !== doc.id) {
				this.releasePresence();
				this.notebookId = doc.id;
				this.deps.service?.presence.acquire(doc.id, file.path);
				void this.refreshOthers();
			}
			this.deps.service?.noteOpened(file);
		} else {
			this.releasePresence();
		}
	}

	/** The file is being closed or replaced: presence removed, banner and read-only reset. */
	closed(): void {
		this.stopPoll();
		this.releasePresence();
		this.dismissed.clear();
		this.others = [];
		const wasReadOnly = this.readOnly;
		this.readOnly = false;
		this.renderBanner();
		if (wasReadOnly) this.deps.editingChanged();
	}

	/** #344: fills the view's message area for a notebook that is not downloaded yet. */
	renderNotDownloaded(el: HTMLElement): void {
		el.empty();
		el.createEl("h3", { text: t("sync.notDownloaded.title") });
		el.createEl("p", { text: t("sync.notDownloaded.body") });
		el.createEl("p", { cls: "notebook-sync-muted", text: t("sync.notDownloaded.hint") });
		el.show();
	}

	destroy(): void {
		this.stopPoll();
		this.releasePresence();
		this.banner?.remove();
		this.banner = null;
	}

	private releasePresence(): void {
		if (this.notebookId !== null) this.deps.service?.presence.release(this.notebookId);
		this.notebookId = null;
	}

	private async refreshOthers(): Promise<void> {
		const service = this.deps.service;
		const id = this.notebookId;
		if (!service || !id) return;
		const run = ++this.checking;
		let others: PresenceRecord[] = [];
		try {
			others = await service.presence.othersOpen(id);
		} catch (e) {
			console.error("[notebook] presence check failed", e);
		}
		if (run !== this.checking || this.notebookId !== id) return;
		this.others = others;
		this.renderBanner();
	}

	private renderBanner(): void {
		const visible = this.others.filter((r) => !this.dismissed.has(r.deviceId));
		if (!this.readOnly && visible.length === 0) {
			this.banner?.remove();
			this.banner = null;
			return;
		}
		if (!this.banner) {
			this.banner = createDiv({ cls: "notebook-sync-banner", attr: { role: "status" } });
			this.deps.container.insertBefore(this.banner, this.deps.before);
		}
		const el = this.banner;
		el.empty();
		const text = el.createDiv({ cls: "notebook-sync-banner-text" });
		const now = Date.now();
		const shown = this.readOnly ? this.others : visible;
		if (shown.length === 1) text.createDiv({ text: t("sync.other.one", { device: shown[0]!.deviceName, ago: agoText(shown[0]!.heartbeat, now) }) });
		else if (shown.length > 1) text.createDiv({ text: t("sync.other.many", { devices: shown.map((r) => r.deviceName).join(", ") }) });
		text.createDiv({ cls: "notebook-sync-muted", text: t(this.readOnly ? "sync.other.isReadOnly" : "sync.other.hint") });
		const actions = el.createDiv({ cls: "notebook-sync-banner-actions" });
		if (this.readOnly) {
			actions.createEl("button", { text: t("sync.other.edit") }).addEventListener("click", () => {
				this.readOnly = false;
				for (const r of this.others) this.dismissed.add(r.deviceId);
				this.renderBanner();
				this.deps.editingChanged();
			});
			return;
		}
		actions.createEl("button", { text: t("sync.other.readOnly"), cls: "mod-cta" }).addEventListener("click", () => {
			this.readOnly = true;
			this.renderBanner();
			this.deps.editingChanged();
		});
		actions.createEl("button", { text: t("sync.other.anyway") }).addEventListener("click", () => {
			for (const r of visible) this.dismissed.add(r.deviceId);
			this.renderBanner();
		});
	}

	private startPoll(): void {
		if (this.poll !== null) return;
		this.poll = window.setInterval(() => this.pollOnce(), NOT_DOWNLOADED_POLL_MS);
	}

	private stopPoll(): void {
		if (this.poll !== null) window.clearInterval(this.poll);
		this.poll = null;
	}

	/** The content may have arrived without a vault event (mobile rescans only from time to time). */
	private pollOnce(): void {
		if (this.poll === null || document.visibilityState === "hidden") return;
		const session = this.deps.session();
		if (session?.mode === "not-downloaded") void session.handleExternalChange();
	}
}
