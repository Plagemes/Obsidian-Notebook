/**
 * Keeps the folder metadata (folder-meta-store.ts) in step with the vault: a renamed or moved folder takes its colour, icon,
 * description and art style along, and another device's metadata file that syncs in is read again.
 */
import { TFile, TFolder, type Plugin } from "obsidian";
import type { FolderMetaStore } from "./folder-meta-store";

export function registerFolderMeta(plugin: Plugin, store: FolderMetaStore): void {
	const { vault, workspace } = plugin.app;
	workspace.onLayoutReady(() => void store.load().catch((e) => console.error("[notebook] folder metadata could not be read", e)));
	plugin.registerEvent(vault.on("rename", (file, oldPath) => {
		if (file instanceof TFolder) {
			void store.rename(oldPath, file.path).catch((e) => console.error("[notebook] folder metadata did not follow the rename", oldPath, e));
		}
	}));
	const changed = (file: unknown) => {
		if (file instanceof TFile && store.watches(file.path)) void store.reload().catch((e) => console.error("[notebook] folder metadata could not be read", e));
	};
	plugin.registerEvent(vault.on("create", changed));
	plugin.registerEvent(vault.on("modify", changed));
	plugin.registerEvent(vault.on("delete", changed));
}
