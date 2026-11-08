/**
 * 0.22 (roadmap #126): the cloud sync engine's ports over Obsidian: the vault (`LocalPort`) and the device-local state file
 * (`StatePort`). Files only through `app.vault` / `app.fileManager`; the state lives in the plugin's own folder through the
 * vault adapter, like the instant-save journal (no vault events, no indexing), one file per device.
 *
 *  - Sizes and times come from the vault's own records (`TFile.stat`) everywhere, so the engine's "unchanged since planned"
 *    checks compare like with like.
 *  - A replace goes through `vault.modifyBinary`: an open notebook gets the vault's "modify" event and reloads through its
 *    existing external-change path (DocumentSession.handleExternalChange). The engine saves it first (`settle`) and never
 *    replaces it while something is unsaved.
 *  - A delete goes through `fileManager.trashFile` (the user's trash setting).
 *  - An unreadable state file is copied aside once (`.bad.json`) before a new state is written over it.
 */
import { normalizePath, TFile, type App } from "obsidian";
import { ensureFolder } from "../storage/vault-io";
import { LocalChangedError, type LocalPort, type LocalStat, type StatePort } from "./engine";

const statOf = (f: TFile): LocalStat => ({ size: f.stat.size, mtime: f.stat.mtime });
const same = (a: LocalStat, b: LocalStat) => a.size === b.size && a.mtime === b.mtime;

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : "";
}

/**
 * The vault as the engine sees it. `settle(path)` saves a notebook open at `path` and says whether nothing is left unsaved
 * (the views' own flush; true when it is not open).
 */
export function vaultLocalPort(app: App, settle: (path: string) => Promise<boolean>): LocalPort {
	const { vault } = app;
	const fileAt = (path: string): TFile | null => {
		const f = vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	};
	return {
		list: () => vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
		stat: (path) => {
			const f = fileAt(path);
			return Promise.resolve(f ? statOf(f) : null);
		},
		read: async (path) => {
			const f = fileAt(path);
			if (!f) throw new LocalChangedError(path);
			return vault.readBinary(f);
		},
		write: async (path, data, expect) => {
			const p = normalizePath(path);
			const existing = vault.getAbstractFileByPath(p);
			if (expect === null) {
				if (existing) throw new LocalChangedError(p);
				const folder = parentOf(p);
				if (folder) await ensureFolder(app, folder);
				const created = await vault.createBinary(p, data);
				return statOf(created);
			}
			if (!(existing instanceof TFile) || !same(statOf(existing), expect)) throw new LocalChangedError(p);
			await vault.modifyBinary(existing, data);
			return statOf(existing);
		},
		trash: async (path, expect) => {
			const f = fileAt(path);
			if (!f || !same(statOf(f), expect)) throw new LocalChangedError(path);
			await app.fileManager.trashFile(f);
		},
		settle,
	};
}

/** Folder of the cloud sync state files, in the plugin's own folder. */
export function syncStateFolder(app: App, pluginId: string): string {
	return normalizePath(`${app.vault.configDir}/plugins/${pluginId}/cloud-sync`);
}

/** The state file of this device (`deviceId`: the per-device sidecar id). */
export function vaultStatePort(app: App, pluginId: string, deviceId: string): StatePort & { remove(): Promise<void> } {
	const adapter = app.vault.adapter;
	const folder = syncStateFolder(app, pluginId);
	const path = `${folder}/state-${deviceId}.json`;
	const bad = `${folder}/state-${deviceId}.bad.json`;
	return {
		load: async () => {
			if (!(await adapter.exists(path))) return null;
			const text = await adapter.read(path);
			try {
				return JSON.parse(text) as unknown;
			} catch {
				// Kept aside before anything is written over it; the engine starts over safely (no deletions).
				try {
					if (!(await adapter.exists(bad))) await adapter.write(bad, text);
				} catch (e) {
					console.error("[notebook] cloud sync: could not keep the unreadable state", e);
				}
				return "unreadable";
			}
		},
		save: async (data) => {
			if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
			await adapter.write(path, JSON.stringify(data));
		},
		remove: async () => {
			if (await adapter.exists(path)) await adapter.remove(path);
		},
	};
}
