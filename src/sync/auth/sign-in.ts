/**
 * Sign-in entry points for the settings section (#126), wired to Obsidian (`requestUrl`, real timers).
 *
 *   const done = await openSignIn(app, { provider: "gdrive", clientId, clientSecret });   // null when cancelled
 *   if (done) { saveAuth(app, done.auth); show(done.account); }
 *   ...
 *   await disconnect(app, auth);   // revokes where possible, then deletes the tokens on this device
 */
import type { App } from "obsidian";
import type { ProviderId } from "../provider-types";
import { connectAccount, disconnectAccount, type Connected, type ConnectOptions } from "./connect";
import type { SignInUi } from "./device-flow";
import type { Http } from "./http";
import { obsidianHttp } from "./http-obsidian";
import type { ProviderAuth } from "./oauth-config";
import { realClock, type Clock } from "./retry";
import { SignInModal } from "./sign-in-modal";
import { clearAuth, type LocalStore } from "./token-store";

export interface SignInOptions extends ConnectOptions {
	http?: Http;
	clock?: Clock;
}

/** Runs the device flow with any UI and prepares the sync root; resolves with the state to store on this device. */
export async function signIn(provider: ProviderId, clientId: string, ui: SignInUi, opts: SignInOptions = {}): Promise<ProviderAuth> {
	return (await connectAccount(opts.http ?? obsidianHttp(), opts.clock ?? realClock, provider, clientId, ui, opts)).auth;
}

/** Opens the sign-in dialog and resolves when it closes: the new state and account, or null when the user cancelled. */
export function openSignIn(app: App, o: { provider: ProviderId; clientId: string } & SignInOptions): Promise<Connected | null> {
	const http = o.http ?? obsidianHttp();
	const clock = o.clock ?? realClock;
	return new Promise((resolve) => {
		new SignInModal(app, o.provider, (ui) => connectAccount(http, clock, o.provider, o.clientId, ui, o), resolve).open();
	});
}

/**
 * Disconnects: revokes the refresh token where the provider supports it, then deletes the sign-in state from this
 * device whatever the provider answered. `manageUrl` is where the user can remove the app's access by hand.
 */
export async function disconnect(store: LocalStore, auth: ProviderAuth, http: Http = obsidianHttp()): Promise<{ revoked: boolean; manageUrl: string }> {
	try {
		return await disconnectAccount(http, auth);
	} finally {
		clearAuth(store);
	}
}
