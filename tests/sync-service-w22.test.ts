/**
 * Review W22 (cloud sync): the service's fixes (src/sync/sync-service.ts) and the vault adapter's trash. The engine is replaced by
 * a scripted `runSync` (its own fixes are tested in sync-review-w22.test.ts); Obsidian is the shared mock. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Plugin } from "obsidian";
import type { SyncOptions, SyncPorts, SyncResult } from "../src/sync/engine";
import type { SyncAuthUI } from "../src/sync/auth-ui";
import type { CloudProvider, ProviderId } from "../src/sync/provider-types";
import type { NotebookSettings } from "../src/settings";
import { DEFAULT_CLOUD_SYNC_SETTINGS, type CloudSyncSettings } from "../src/sync/settings";
import { FakeTFile } from "./fake-vault";
import { CONFIG_DIR, installFakeWindow, removeFakeWindow } from "./node-env";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

/** The scripted engine: each call is recorded and answered by `engine.next` (default: an "ok" result at once). */
const engine = vi.hoisted(() => ({
	calls: [] as { ports: unknown; options: unknown }[],
	next: null as null | ((ports: unknown, options: unknown) => Promise<unknown>),
}));
vi.mock("../src/sync/engine", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/sync/engine")>();
	return {
		...real,
		runSync: (ports: unknown, options: unknown) => {
			engine.calls.push({ ports, options });
			return engine.next ? engine.next(ports, options) : Promise.resolve(real.emptyResult("ok"));
		},
	};
});

const { CloudSyncService, READY_FALLBACK_MS, triggerPolicy } = await import("../src/sync/sync-service");
const { vaultLocalPort } = await import("../src/sync/vault-adapter");
const { MASS_DELETE_AUTO_MAX } = await import("../src/sync/planner");
const { emptyResult } = await import("../src/sync/engine");
const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };
const { t } = await import("../src/i18n");

interface Harness {
	service: InstanceType<typeof CloudSyncService>;
	store: Map<string, unknown>;
	log: string[];
	state: { saved: number; removed: number };
	auth: { signedIn: ProviderId | null };
	settings: CloudSyncSettings & { zipBackupFolder: string | null };
}

function harness(o: { mobile?: boolean; signedIn?: ProviderId | null; provider?: CloudSyncSettings["cloudSyncProvider"] } = {}): Harness {
	const store = new Map<string, unknown>();
	const log: string[] = [];
	const state = { saved: 0, removed: 0 };
	const authState = { signedIn: o.signedIn === undefined ? ("gdrive" as ProviderId) : o.signedIn };
	const settings = { ...DEFAULT_CLOUD_SYNC_SETTINGS, cloudSyncProvider: o.provider ?? "gdrive", cloudSyncWifiOnly: true, zipBackupFolder: null };
	const app = {
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void (v === null ? store.delete(k) : store.set(k, v)),
		vault: { configDir: CONFIG_DIR, getFiles: () => [] },
	} as unknown as App;
	const auth: SyncAuthUI = {
		available: () => true,
		isSignedIn: (p) => authState.signedIn === p,
		signedInAs: () => authState.signedIn,
		signIn: (p) => {
			log.push(`signIn ${p}`);
			authState.signedIn = p;
			return Promise.resolve(true);
		},
		signOut: (p) => {
			log.push(`signOut ${p}`);
			if (authState.signedIn === p) authState.signedIn = null;
			return Promise.resolve({ revoked: true, manageUrl: "" });
		},
		accountLabel: () => "me@example.com",
		rootLabel: () => "Notebook sync",
		rootId: () => "root",
		connect: () => Promise.resolve({ id: "gdrive" } as unknown as CloudProvider),
	};
	const service = new CloudSyncService({
		app,
		pluginId: "notebook",
		deviceId: "dev",
		settings: () => settings as unknown as NotebookSettings,
		flushAll: () => Promise.resolve(),
		settle: () => Promise.resolve(true),
		deviceName: () => "Tablet",
		mobile: () => o.mobile === true,
		statePort: () => ({
			load: () => Promise.resolve(null),
			save: () => {
				state.saved++;
				log.push("state saved");
				return Promise.resolve();
			},
			remove: () => {
				state.removed++;
				log.push("state removed");
				return Promise.resolve();
			},
		}),
	}, auth);
	return { service, store, log, state, auth: authState, settings };
}

const ready = (h: Harness): Harness => {
	h.service.markLayoutReady();
	h.service.markIndexed();
	return h;
};

beforeEach(() => {
	engine.calls.length = 0;
	engine.next = null;
	Notice.shown.length = 0;
	installFakeWindow();
	vi.stubGlobal("document", { visibilityState: "visible" });
});

afterEach(() => {
	vi.useRealTimers();
	removeFakeWindow();
});

describe("review W22 S1: nothing runs before the vault is loaded", () => {
	it("'Sync now' is refused with a note until the layout is ready AND the metadata cache resolved", async () => {
		const h = harness();
		expect(await h.service.syncNow()).toBeNull();
		expect(Notice.shown).toContain(t("cloudSync.notice.loading"));
		h.service.markLayoutReady();
		expect(await h.service.syncNow()).toBeNull();
		expect(h.service.statusText()).toContain(t("cloudSync.status.loading"));
		h.service.markIndexed();
		expect(await h.service.syncNow()).not.toBeNull();
		expect(engine.calls).toHaveLength(1);
	});

	it("register: the 'resolved' event, or the fallback delay after the layout, opens the gate; the start-up run waits for it", async () => {
		vi.useFakeTimers();
		installFakeWindow();
		const h = harness();
		h.settings.cloudSyncInterval = 0;
		let resolved: (() => void) | null = null;
		let layout: (() => void) | null = null;
		const app = h.service.app() as unknown as Record<string, unknown>;
		app.metadataCache = { on: (name: string, fn: () => void) => (name === "resolved" ? (resolved = fn) : null) };
		app.workspace = { onLayoutReady: (fn: () => void) => void (layout = fn), on: () => null };
		const plugin = { register: () => undefined, registerEvent: () => undefined, registerInterval: (n: number) => n, registerDomEvent: () => undefined, addStatusBarItem: () => statusEl() } as unknown as Plugin;
		h.service.register(plugin);
		expect(h.service.ready()).toBe(false);
		layout!();
		expect(h.service.ready()).toBe(false);
		await vi.advanceTimersByTimeAsync(20_000);
		// The start-up run is due, but the vault is not indexed yet.
		expect(engine.calls).toHaveLength(0);
		resolved!();
		expect(h.service.ready()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(engine.calls).toHaveLength(1));

		const h2 = harness();
		let layout2: (() => void) | null = null;
		const app2 = h2.service.app() as unknown as Record<string, unknown>;
		app2.metadataCache = { on: () => null };
		app2.workspace = { onLayoutReady: (fn: () => void) => void (layout2 = fn), on: () => null };
		h2.service.register(plugin);
		layout2!();
		await vi.advanceTimersByTimeAsync(READY_FALLBACK_MS - 1);
		expect(h2.service.ready()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(h2.service.ready()).toBe(true);
	});

	it("automatic triggers do nothing before the vault is loaded", () => {
		const h = harness();
		h.service.tick();
		h.service.onLeave();
		expect(engine.calls).toHaveLength(0);
	});
});

describe("review W22 S7: what each trigger may delete", () => {
	it("start-up and leaving defer deletions; periodic runs stop sooner; manual runs use the normal guard", () => {
		expect(triggerPolicy("open", false)).toEqual({ deletions: "defer", massDeleteMax: MASS_DELETE_AUTO_MAX });
		expect(triggerPolicy("close", false)).toEqual({ deletions: "defer", massDeleteMax: MASS_DELETE_AUTO_MAX });
		expect(triggerPolicy("interval", false)).toEqual({ deletions: "guard", massDeleteMax: MASS_DELETE_AUTO_MAX });
		expect(triggerPolicy("manual", false)).toEqual({ deletions: "guard" });
		expect(triggerPolicy("confirm", true)).toEqual({ deletions: "restore" });
	});

	it("the run gets the policy, and the deferred count shows in the status", async () => {
		const h = ready(harness());
		h.settings.cloudSyncWifiOnly = false;
		engine.next = () => Promise.resolve({ ...emptyResult("ok"), deferredDeletes: 3 });
		h.service.onLeave();
		await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
		await vi.waitFor(() => expect(h.service.running()).toBe(false));
		expect(engine.calls[0]!.options).toMatchObject({ deletions: "defer", massDeleteMax: MASS_DELETE_AUTO_MAX });
		expect(h.service.statusText()).toContain(t("cloudSync.status.deferred", { count: "3" }));
	});
});

describe("review W22 S5: 'Disconnect' waits for the run in progress", () => {
	it("cancels the run, waits for its last save, then signs out and removes the state; no run starts meanwhile", async () => {
		const h = ready(harness());
		h.settings.cloudSyncWifiOnly = false;
		engine.next = (ports) => new Promise((resolve) => {
			const p = ports as SyncPorts;
			// The engine's final save happens after the abort.
			const stop = () => void p.state.save({}).then(() => resolve({ ...emptyResult("cancelled") }));
			if (p.signal!.aborted) stop();
			else p.signal!.addEventListener("abort", stop);
		});
		const run = h.service.syncNow();
		await vi.waitFor(() => expect(h.service.running()).toBe(true));
		const gone = h.service.disconnect();
		expect(await h.service.syncNow()).toBeNull();
		await gone;
		await run;
		expect(h.log).toEqual(["state saved", "signOut gdrive", "state removed"]);
		expect(h.state.removed).toBe(1);
	});

	it("forgets the Google client secret only when asked", async () => {
		const h = ready(harness());
		h.service.setClientSecret("gdrive", "s3cret");
		await h.service.disconnect();
		expect(h.service.clientSecret("gdrive")).toBe("s3cret");
		h.auth.signedIn = "gdrive";
		await h.service.disconnect({ forgetSecret: true });
		expect(h.service.clientSecret("gdrive")).toBe("");
	});
});

describe("review W22: one account per device", () => {
	it("signing in to OneDrive first disconnects Google (and removes its sync state)", async () => {
		const h = ready(harness({ provider: "onedrive", signedIn: "gdrive" }));
		h.settings.cloudSyncOnedriveClientId = "11111111";
		expect(h.service.accountText()).toContain(t("cloudSync.account.otherSignedIn", { provider: t("settings.cloudSyncProvider.gdrive") }));
		engine.next = () => new Promise(() => undefined); // the first run after sign-in is not awaited here
		await h.service.signIn();
		expect(h.log.slice(0, 3)).toEqual(["signOut gdrive", "state removed", "signIn onedrive"]);
		expect(h.service.accountText()).toContain(t("cloudSync.account.onedriveNote"));
	});
});

describe("review W22 S16: phones and tablets", () => {
	it("an unknown network type holds the automatic runs on mobile ('Sync now' goes, with a note); a desktop is not held", async () => {
		const phone = ready(harness({ mobile: true }));
		phone.service.onLeave();
		await Promise.resolve();
		expect(engine.calls).toHaveLength(0);
		expect(phone.service.statusText()).toContain(t("cloudSync.status.unknownWaits"));
		await phone.service.syncNow();
		expect(engine.calls).toHaveLength(1);
		expect(Notice.shown).toContain(t("cloudSync.notice.unknownNetwork"));

		const desktop = ready(harness({ mobile: false }));
		desktop.service.onLeave();
		await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
	});

	it("the mobile size cap goes to the engine as a hard limit; none on desktop", async () => {
		const phone = ready(harness({ mobile: true }));
		phone.settings.cloudSyncMobileMaxMb = 20;
		await phone.service.syncNow();
		expect((engine.calls[0]!.options as SyncOptions).hardMaxBytes).toBe(20 * 1024 * 1024);
		const desktop = ready(harness());
		await desktop.service.syncNow();
		expect((engine.calls[1]!.options as SyncOptions).hardMaxBytes).toBe(0);
	});

	it("names that cannot be synced and files too large here are told once per app session", async () => {
		const h = ready(harness({ mobile: true }));
		h.settings.cloudSyncWifiOnly = false;
		const result: SyncResult = { ...emptyResult("partial"), unsyncable: ["a?.md"], tooLarge: [{ path: "big.pdf", size: 1 }] };
		engine.next = () => Promise.resolve(result);
		await h.service.syncNow();
		await h.service.syncNow();
		const names = t("cloudSync.notice.names", { count: "1", example: "a?.md" });
		expect(Notice.shown.filter((s) => s === names)).toHaveLength(1);
		expect(Notice.shown.filter((s) => s === t("cloudSync.notice.tooLarge", { count: "1", limit: "50" }))).toHaveLength(1);
	});
});

describe("review W22 S2: a local delete goes to Obsidian's own trash", () => {
	it("vault.trash(file, false): the vault's .trash folder, whatever the user's deletion setting", async () => {
		const file = new FakeTFile("a.md");
		file.stat = { mtime: 5, ctime: 1, size: 3 };
		const trash = vi.fn(() => Promise.resolve());
		const trashFile = vi.fn(() => Promise.resolve());
		const app = { vault: { getAbstractFileByPath: () => file, trash }, fileManager: { trashFile } } as unknown as App;
		await vaultLocalPort(app, () => Promise.resolve(true)).trash("a.md", { size: 3, mtime: 5 });
		expect(trash).toHaveBeenCalledWith(file, false);
		expect(trashFile).not.toHaveBeenCalled();
	});
});

function statusEl(): unknown {
	const el: Record<string, unknown> = {};
	for (const m of ["addClass", "setAttr", "addEventListener", "toggleClass", "empty"]) el[m] = () => undefined;
	el.createSpan = () => el;
	return el;
}
