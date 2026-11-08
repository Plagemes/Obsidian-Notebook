/**
 * The real `SyncAuthUI` of the plugin (#126): the adapter in `../auth-adapter.ts` wired to Obsidian's `requestUrl`, the device-code
 * sign-in dialog and the per-device local storage. Plugged in with `plugin.cloudSync.setAuth(...)` at load.
 */
import type { App } from "obsidian";
import { t } from "../../i18n";
import { createSyncAuthUI } from "../auth-adapter";
import type { SyncAuthUI } from "../auth-ui";
import { createProvider } from "../providers";
import { obsidianHttp } from "./http-obsidian";
import { disconnect, openSignIn } from "./sign-in";

export function obsidianSyncAuth(app: App): SyncAuthUI {
	return createSyncAuthUI({
		store: app,
		http: obsidianHttp,
		openSignIn: (o) => openSignIn(app, o),
		disconnect,
		createProvider,
		// Google's drive.file scope reaches only what this app created: say that the root is that folder.
		rootText: (provider, label) => (provider === "gdrive" ? t("cloudSync.root.gdrive", { folder: label }) : label),
		log: (message, error) => console.error(`[notebook] cloud sync: ${message}`, error),
	});
}
