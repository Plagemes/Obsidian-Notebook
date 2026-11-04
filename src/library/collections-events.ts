/** Keeps the saved collections (collections-store.ts) in step with the vault: another device's file that syncs in is read again. */
import { TFile, type Plugin } from "obsidian";
import type { CollectionsStore } from "./collections-store";

export function registerCollections(plugin: Plugin, store: CollectionsStore): void {
	const { vault, workspace } = plugin.app;
	workspace.onLayoutReady(() => void store.load().catch((e) => console.error("[notebook] collections could not be read", e)));
	const changed = (file: unknown) => {
		if (file instanceof TFile && store.watches(file.path)) void store.load().catch((e) => console.error("[notebook] collections could not be read", e));
	};
	plugin.registerEvent(vault.on("create", changed));
	plugin.registerEvent(vault.on("modify", changed));
	plugin.registerEvent(vault.on("delete", changed));
}
