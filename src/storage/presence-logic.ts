/**
 * "Open on another device" (roadmap #342): pure logic of the presence files. No Obsidian imports.
 *
 * While a notebook is open, each device keeps one small file in the notebooks folder:
 * `_meta/presence/<notebook id>.<device id>.json`, refreshed every HEARTBEAT_MS while the app is in the
 * foreground and removed when the notebook is closed. A file is only ever written (and removed) by the
 * device whose id is in its name, so two devices never write the same file and the sync client never
 * has a reason to create a conflicted copy of it.
 *
 * `_meta/devices/<device id>.json` records when each device was last seen (refreshed at most every
 * DEVICE_REFRESH_MS). It is never removed: it lets the sync check (#345) tell whether files written by
 * other devices ever arrive in this folder.
 */

export const META_DIRNAME = "_meta";
export const PRESENCE_VERSION = 1;
/** A device refreshes its presence files this often while the app is visible. */
export const HEARTBEAT_MS = 60_000;
/**
 * A presence file is "fresh" (the notebook is probably still open there) for this long after its heartbeat.
 * Much longer than the heartbeat because folder-sync apps upload and download on their own schedule
 * (often every 5 to 15 minutes): a shorter window would miss most devices that are really open.
 */
export const STALE_AFTER_MS = 15 * 60_000;
/** Heartbeats further in the future than this come from a wrong clock and are not trusted. */
export const MAX_CLOCK_SKEW_MS = 10 * 60_000;
/** The device file is rewritten when it is older than this (or the device name changed). */
export const DEVICE_REFRESH_MS = 12 * 60 * 60_000;

export interface DeviceIdentity {
	/** Random, created once per device (letters and digits). */
	id: string;
	/** Shown to the other devices, editable in the settings. */
	name: string;
}

export interface PresenceRecord {
	notebookId: string;
	deviceId: string;
	deviceName: string;
	/** Vault path of the notebook on that device (for display only). */
	path: string;
	/** ISO times. */
	openedAt: string;
	heartbeat: string;
}

export interface DeviceRecord {
	deviceId: string;
	deviceName: string;
	lastSeen: string;
}

const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

export function metaFolder(root: string): string {
	return join(root, META_DIRNAME);
}

export function presenceFolder(root: string): string {
	return join(root, META_DIRNAME, "presence");
}

export function devicesFolder(root: string): string {
	return join(root, META_DIRNAME, "devices");
}

/** A file-name-safe form of an id: letters, digits, `_` and `-` only, at most 64 characters. */
export function safeKey(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	return cleaned.length > 0 ? cleaned : "_";
}

export function presenceFileName(notebookId: string, deviceId: string): string {
	return `${safeKey(notebookId)}.${safeKey(deviceId)}.json`;
}

/** `{ notebook, device }` keys of a presence file name, or null for any other file. */
export function parsePresenceFileName(name: string): { notebook: string; device: string } | null {
	const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.json$/.exec(name);
	return m ? { notebook: m[1]!, device: m[2]! } : null;
}

export function deviceFileName(deviceId: string): string {
	return `${safeKey(deviceId)}.json`;
}

export function serializePresence(r: PresenceRecord): string {
	return JSON.stringify({ kind: "notebook-presence", version: PRESENCE_VERSION, ...r }, null, "\t");
}

const str = (v: unknown): v is string => typeof v === "string";
const validTime = (s: string) => !Number.isNaN(Date.parse(s));

/** The record in a presence file, or null when the text is not one (unreadable, half-synced, unknown version). */
export function parsePresence(text: string): PresenceRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (o.kind !== "notebook-presence" || o.version !== PRESENCE_VERSION) return null;
	if (!str(o.notebookId) || !str(o.deviceId) || !str(o.heartbeat) || !validTime(o.heartbeat)) return null;
	return {
		notebookId: o.notebookId,
		deviceId: o.deviceId,
		deviceName: str(o.deviceName) && o.deviceName.trim() ? o.deviceName : o.deviceId,
		path: str(o.path) ? o.path : "",
		openedAt: str(o.openedAt) && validTime(o.openedAt) ? o.openedAt : o.heartbeat,
		heartbeat: o.heartbeat,
	};
}

export function serializeDevice(r: DeviceRecord): string {
	return JSON.stringify({ kind: "notebook-device", version: PRESENCE_VERSION, ...r }, null, "\t");
}

export function parseDevice(text: string): DeviceRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (o.kind !== "notebook-device" || o.version !== PRESENCE_VERSION) return null;
	if (!str(o.deviceId) || !str(o.lastSeen) || !validTime(o.lastSeen)) return null;
	return { deviceId: o.deviceId, deviceName: str(o.deviceName) && o.deviceName.trim() ? o.deviceName : o.deviceId, lastSeen: o.lastSeen };
}

/** Whether this device should rewrite its device file (`existing` = what is on disk, or null). */
export function deviceRecordDue(existing: DeviceRecord | null, me: DeviceIdentity, nowMs: number): boolean {
	if (!existing || existing.deviceId !== me.id || existing.deviceName !== me.name) return true;
	const age = nowMs - Date.parse(existing.lastSeen);
	return !(age >= 0 && age < DEVICE_REFRESH_MS);
}

/**
 * Whether the notebook is probably still open on the device of `r`: its heartbeat is less than
 * `staleAfterMs` old, and not further in the future than a plausible clock difference.
 */
export function isFresh(r: PresenceRecord, nowMs: number, staleAfterMs = STALE_AFTER_MS): boolean {
	const age = nowMs - Date.parse(r.heartbeat);
	return age < staleAfterMs && age > -MAX_CLOCK_SKEW_MS;
}

/** Fresh records of other devices for `notebookId`: one per device (the newest heartbeat), newest first. */
export function otherDevicesOpen(records: readonly PresenceRecord[], notebookId: string, myDeviceId: string, nowMs: number): PresenceRecord[] {
	const best = new Map<string, PresenceRecord>();
	for (const r of records) {
		if (r.notebookId !== notebookId || r.deviceId === myDeviceId || !isFresh(r, nowMs)) continue;
		const have = best.get(r.deviceId);
		if (!have || Date.parse(r.heartbeat) > Date.parse(have.heartbeat)) best.set(r.deviceId, r);
	}
	return [...best.values()].sort((a, b) => Date.parse(b.heartbeat) - Date.parse(a.heartbeat));
}

/** Whole minutes since the heartbeat (0 for a heartbeat in the future). */
export function minutesSince(iso: string, nowMs: number): number {
	return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
}

/** A new device id: 12 letters and digits from `randomByte` (crypto.getRandomValues at runtime). */
export function newDeviceId(randomByte: () => number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 12; i++) out += alphabet[randomByte() % alphabet.length];
	return out;
}

/** The device name as stored: single spaces, at most 40 characters; `fallback` when empty. */
export function cleanDeviceName(name: string, fallback: string): string {
	const cleaned = name.replace(/\s+/g, " ").trim().slice(0, 40).trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Reads a stored identity (plugin local storage); null when missing or malformed. */
export function readIdentity(raw: unknown): DeviceIdentity | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (!str(o.id) || !/^[a-z0-9]{6,32}$/.test(o.id) || !str(o.name)) return null;
	return { id: o.id, name: cleanDeviceName(o.name, o.id) };
}
