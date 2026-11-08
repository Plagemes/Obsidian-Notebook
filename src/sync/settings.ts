/**
 * 0.22 (roadmap #126): the cloud sync settings. Pure: no `obsidian` import. Off by default: nothing leaves the device until a
 * provider is chosen and signed in on this device.
 */
import { cleanFolder, parseList, parseTypes, SCOPE_MODES, type FixedExclusions, type ScopeMode, type ScopeRules } from "./rules";
import type { LargeRule } from "./planner";
import type { ProviderId } from "./provider-types";

export const CLOUD_PROVIDERS = ["off", "gdrive", "onedrive"] as const;
export type CloudProviderChoice = (typeof CLOUD_PROVIDERS)[number];
export const LARGE_RULES = ["ask", "skip"] as const;

export const CLOUD_INTERVAL_MAX = 240;
export const CLOUD_LARGE_MAX_MB = 1000;

export interface CloudSyncSettings {
	/** "off" (the default): no cloud sync at all. */
	cloudSyncProvider: CloudProviderChoice;
	cloudSyncScope: ScopeMode;
	/** "folders" scope: comma-separated vault folders. */
	cloudSyncFolders: string;
	/** "rules" scope: comma-separated glob patterns to include (empty: everything). */
	cloudSyncInclude: string;
	/** "rules" scope: comma-separated glob patterns to leave out. */
	cloudSyncExclude: string;
	/** "rules" scope: comma-separated file types (empty: every type). */
	cloudSyncTypes: string;
	cloudSyncOnOpen: boolean;
	cloudSyncOnClose: boolean;
	/** Minutes between automatic runs while Obsidian is open; 0: off. */
	cloudSyncInterval: number;
	cloudSyncWifiOnly: boolean;
	/** Files larger than this (MB) follow `cloudSyncLarge`; 0: no limit. */
	cloudSyncLargeMb: number;
	cloudSyncLarge: LargeRule;
}

export const DEFAULT_CLOUD_SYNC_SETTINGS: CloudSyncSettings = {
	cloudSyncProvider: "off",
	cloudSyncScope: "vault",
	cloudSyncFolders: "",
	cloudSyncInclude: "",
	cloudSyncExclude: "",
	cloudSyncTypes: "",
	cloudSyncOnOpen: true,
	cloudSyncOnClose: true,
	cloudSyncInterval: 15,
	cloudSyncWifiOnly: true,
	cloudSyncLargeMb: 50,
	cloudSyncLarge: "ask",
};

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const text = (v: unknown, max = 2000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const clampInt = (v: unknown, min: number, max: number): number | null =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null;

export function readCloudSyncSettings(d: Record<string, unknown>): CloudSyncSettings {
	const s: CloudSyncSettings = { ...DEFAULT_CLOUD_SYNC_SETTINGS };
	if (oneOf(CLOUD_PROVIDERS, d.cloudSyncProvider)) s.cloudSyncProvider = d.cloudSyncProvider;
	if (oneOf(SCOPE_MODES, d.cloudSyncScope)) s.cloudSyncScope = d.cloudSyncScope;
	s.cloudSyncFolders = text(d.cloudSyncFolders) ?? s.cloudSyncFolders;
	s.cloudSyncInclude = text(d.cloudSyncInclude) ?? s.cloudSyncInclude;
	s.cloudSyncExclude = text(d.cloudSyncExclude) ?? s.cloudSyncExclude;
	s.cloudSyncTypes = text(d.cloudSyncTypes) ?? s.cloudSyncTypes;
	if (typeof d.cloudSyncOnOpen === "boolean") s.cloudSyncOnOpen = d.cloudSyncOnOpen;
	if (typeof d.cloudSyncOnClose === "boolean") s.cloudSyncOnClose = d.cloudSyncOnClose;
	s.cloudSyncInterval = clampInt(d.cloudSyncInterval, 0, CLOUD_INTERVAL_MAX) ?? s.cloudSyncInterval;
	if (typeof d.cloudSyncWifiOnly === "boolean") s.cloudSyncWifiOnly = d.cloudSyncWifiOnly;
	s.cloudSyncLargeMb = clampInt(d.cloudSyncLargeMb, 0, CLOUD_LARGE_MAX_MB) ?? s.cloudSyncLargeMb;
	if (oneOf(LARGE_RULES, d.cloudSyncLarge)) s.cloudSyncLarge = d.cloudSyncLarge;
	return s;
}

/** The provider chosen, or null when cloud sync is off. */
export function chosenProvider(s: CloudSyncSettings): ProviderId | null {
	return s.cloudSyncProvider === "off" ? null : s.cloudSyncProvider;
}

/** The scope rules of the settings. */
export function scopeRules(s: CloudSyncSettings): ScopeRules {
	return {
		mode: s.cloudSyncScope,
		folders: parseList(s.cloudSyncFolders).map(cleanFolder).filter(Boolean),
		include: parseList(s.cloudSyncInclude),
		exclude: parseList(s.cloudSyncExclude),
		types: parseTypes(s.cloudSyncTypes),
	};
}

/** Paths never synced: the configuration folder and the zip backup folder (#127). */
export function fixedExclusions(configDir: string, zipBackupFolder: string | null): FixedExclusions {
	return { configDir, backupFolder: zipBackupFolder ? cleanFolder(zipBackupFolder) || null : null };
}
