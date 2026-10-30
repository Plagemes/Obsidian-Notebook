import { normalizePath, Platform, TFile, type App } from "obsidian";
import { ensureFolder } from "./vault-io";
import {
	cleanDeviceName, deviceFileName, deviceRecordDue, devicesFolder, HEARTBEAT_MS, newDeviceId, otherDevicesOpen,
	parseDevice, parsePresence, parsePresenceFileName, presenceFileName, presenceFolder, readIdentity, safeKey,
	serializeDevice, serializePresence, type DeviceIdentity, type DeviceRecord, type PresenceRecord,
} from "./presence-logic";

interface OpenEntry {
	notebookId: string;
	notebookPath: string;
	openedAt: string;
	/** Vault path of this device's presence file for the notebook. */
	file: string;
	/** Views of this notebook open on this device. */
	count: number;
	/** When its presence file was last written (ms since epoch), 0 before the first write. */
	beatAt: number;
}

/** Where the service keeps its per-device identity: Obsidian's App.loadLocalStorage / saveLocalStorage. */
export interface IdentityStore {
	load(): unknown;
	save(value: unknown): void;
}

function defaultDeviceName(id: string): string {
	const kind = Platform.isAndroidApp ? (Platform.isTablet ? "Android tablet" : "Android phone")
		: Platform.isIosApp ? (Platform.isTablet ? "iPad" : "iPhone")
		: Platform.isWin ? "Windows PC" : Platform.isMacOS ? "Mac" : Platform.isLinux ? "Linux PC" : "Device";
	return `${kind} ${id.slice(0, 4)}`;
}

function randomByte(): number {
	const b = new Uint8Array(1);
	crypto.getRandomValues(b);
	return b[0]!;
}

/**
 * "Open on another device" (roadmap #342), the vault side: this device's identity and presence files.
 *
 * - One file per (notebook, device), written and removed only by that device: no sync conflicts.
 * - Heartbeats run only while the app is visible (`setVisible`): a phone in the background writes nothing. A file is
 *   written on open, every HEARTBEAT_MS, and on resume only when its last write is that old (each write is an upload).
 * - Failures are logged and never reach the notebook: presence is a hint, not part of the data.
 */
export class PresenceService {
	private identity: DeviceIdentity | null = null;
	private readonly open = new Map<string, OpenEntry>();
	private timer: number | null = null;
	private visible = true;
	private disposed = false;
	/** Writes run one at a time, in order (a heartbeat cannot land after the removal that followed it). */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly app: App,
		private readonly root: () => string,
		private readonly store: IdentityStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	device(): DeviceIdentity {
		if (this.identity) return this.identity;
		const stored = readIdentity(this.store.load());
		if (stored) return (this.identity = stored);
		const id = newDeviceId(randomByte);
		this.identity = { id, name: defaultDeviceName(id) };
		this.store.save(this.identity);
		return this.identity;
	}

	/** Renames this device (settings); open notebooks and the device file carry the new name from now on. */
	setDeviceName(name: string): void {
		const me = this.device();
		const next = { id: me.id, name: cleanDeviceName(name, defaultDeviceName(me.id)) };
		if (next.name === me.name) return;
		this.identity = next;
		this.store.save(next);
		this.heartbeatAll();
		void this.touchDevice();
	}

	/** A view opened `notebookId`: writes its presence file now and keeps it fresh. Call `release` when it closes. */
	acquire(notebookId: string, notebookPath: string): void {
		if (this.disposed) return;
		const have = this.open.get(notebookId);
		if (have) {
			have.count++;
			have.notebookPath = notebookPath;
			return;
		}
		const file = normalizePath(`${presenceFolder(this.root())}/${presenceFileName(notebookId, this.device().id)}`);
		const entry: OpenEntry = { notebookId, notebookPath, openedAt: this.now().toISOString(), file, count: 1, beatAt: 0 };
		this.open.set(notebookId, entry);
		if (this.visible) void this.enqueue(() => this.write(entry));
		this.schedule();
	}

	release(notebookId: string): void {
		const entry = this.open.get(notebookId);
		if (!entry) return;
		if (--entry.count > 0) return;
		this.open.delete(notebookId);
		void this.enqueue(() => this.remove(entry.file));
		this.schedule();
	}

	/**
	 * The app went to the background (false) or came back (true). In the background no heartbeat is written; on resume
	 * only the files whose last heartbeat is HEARTBEAT_MS old (Android switches apps often: each write is an upload).
	 */
	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) this.heartbeatAll(true);
		this.schedule();
	}

	/** Fresh presence records of other devices that have `notebookId` open, newest first. Never throws. */
	async othersOpen(notebookId: string): Promise<PresenceRecord[]> {
		const folder = this.app.vault.getFolderByPath(normalizePath(presenceFolder(this.root())));
		if (!folder) return [];
		const me = this.device().id;
		const prefix = `${safeKey(notebookId)}.`;
		const records: PresenceRecord[] = [];
		for (const f of folder.children) {
			if (!(f instanceof TFile) || !f.name.startsWith(prefix)) continue;
			const key = parsePresenceFileName(f.name);
			if (!key || key.device === safeKey(me)) continue;
			try {
				const r = parsePresence(await this.app.vault.read(f));
				if (r) records.push(r);
			} catch (e) {
				console.error("[notebook] could not read", f.path, e);
			}
		}
		return otherDevicesOpen(records, notebookId, me, this.now().getTime());
	}

	/** Whether `path` is a presence file of `notebookId` written by another device. */
	isOtherPresenceFile(path: string, notebookId: string): boolean {
		const folder = normalizePath(presenceFolder(this.root()));
		if (!path.startsWith(`${folder}/`)) return false;
		const key = parsePresenceFileName(path.slice(folder.length + 1));
		return !!key && key.notebook === safeKey(notebookId) && key.device !== safeKey(this.device().id);
	}

	/** Device files of the other devices (#345: proof that files written elsewhere reach this folder). */
	async otherDevices(): Promise<DeviceRecord[]> {
		const folder = this.app.vault.getFolderByPath(normalizePath(devicesFolder(this.root())));
		if (!folder) return [];
		const me = this.device().id;
		const out: DeviceRecord[] = [];
		for (const f of folder.children) {
			if (!(f instanceof TFile) || f.extension !== "json") continue;
			try {
				const r = parseDevice(await this.app.vault.read(f));
				if (r && r.deviceId !== me) out.push(r);
			} catch (e) {
				console.error("[notebook] could not read", f.path, e);
			}
		}
		return out.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
	}

	/**
	 * At startup: refreshes this device's file in `_meta/devices` (at most every 12 h) and removes presence files
	 * this device left behind (the app was killed while a notebook was open). Other devices' files are never touched.
	 */
	startup(): Promise<void> {
		return this.enqueue(async () => {
			await this.touchDeviceNow();
			const folder = this.app.vault.getFolderByPath(normalizePath(presenceFolder(this.root())));
			if (!folder) return;
			const me = safeKey(this.device().id);
			const keep = new Set([...this.open.values()].map((e) => e.file));
			for (const f of [...folder.children]) {
				if (!(f instanceof TFile) || keep.has(f.path) || parsePresenceFileName(f.name)?.device !== me) continue;
				await this.app.vault.delete(f).catch((e) => console.error("[notebook] could not remove", f.path, e));
			}
		});
	}

	/** Removes this device's presence files (plugin unload). */
	dispose(): Promise<void> {
		this.disposed = true;
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		const entries = [...this.open.values()];
		this.open.clear();
		return this.enqueue(async () => {
			for (const e of entries) await this.remove(e.file);
		});
	}

	private touchDevice(): Promise<void> {
		return this.enqueue(() => this.touchDeviceNow());
	}

	private async touchDeviceNow(): Promise<void> {
		const me = this.device();
		const folder = normalizePath(devicesFolder(this.root()));
		const path = normalizePath(`${folder}/${deviceFileName(me.id)}`);
		const file = this.app.vault.getFileByPath(path);
		let existing: DeviceRecord | null = null;
		if (file) {
			try {
				existing = parseDevice(await this.app.vault.read(file));
			} catch {
				existing = null;
			}
		}
		const now = this.now();
		if (!deviceRecordDue(existing, me, now.getTime())) return;
		await this.writeText(path, serializeDevice({ deviceId: me.id, deviceName: me.name, lastSeen: now.toISOString() }));
	}

	private schedule(): void {
		const want = this.visible && !this.disposed && this.open.size > 0;
		if (want && this.timer === null) this.timer = window.setInterval(() => this.heartbeatAll(), HEARTBEAT_MS);
		else if (!want && this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** `onlyDue`: only the files whose last heartbeat is at least HEARTBEAT_MS old. */
	private heartbeatAll(onlyDue = false): void {
		if (!this.visible || this.disposed) return;
		const now = this.now().getTime();
		for (const entry of this.open.values()) {
			if (onlyDue && now - entry.beatAt < HEARTBEAT_MS) continue;
			void this.enqueue(() => this.write(entry));
		}
	}

	private async write(entry: OpenEntry): Promise<void> {
		// Released (or the plugin unloaded) while this write was queued: the file must stay removed.
		if (this.open.get(entry.notebookId) !== entry) return;
		const me = this.device();
		entry.beatAt = this.now().getTime();
		await this.writeText(entry.file, serializePresence({
			notebookId: entry.notebookId,
			deviceId: me.id,
			deviceName: me.name,
			path: entry.notebookPath,
			openedAt: entry.openedAt,
			heartbeat: this.now().toISOString(),
		}));
	}

	private async writeText(path: string, text: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			await this.app.vault.process(file, () => text);
			return;
		}
		await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
		await this.app.vault.create(path, text);
	}

	private async remove(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		// Our own small technical file: deleted for good, not moved to the trash.
		if (file) await this.app.vault.delete(file);
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.chain.then(task).catch((e: unknown) => console.error("[notebook] presence file", e));
		this.chain = run;
		return run;
	}
}
