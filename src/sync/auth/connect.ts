/**
 * Connecting an account (#126): the device flow, then the sync root folder, then the account label; and disconnecting.
 * Pure (HTTP and time injected): `sign-in.ts` wires it to Obsidian.
 */
import { AuthRequiredError, TransientRemoteError, type ProviderId } from "../provider-types";
import { createProvider } from "../providers";
import { runDeviceFlow, SignInError, type SignInUi } from "./device-flow";
import type { Http } from "./http";
import { DEFAULT_ROOT_NAME, oauthConfig, type ProviderAuth } from "./oauth-config";
import type { Clock } from "./retry";
import { revokeAuth } from "./tokens";

export interface ConnectOptions {
	/** Google only: the client secret of the user's limited-input OAuth client. */
	clientSecret?: string;
	/** Name of the sync root folder (default "Notebook sync"). */
	rootName?: string;
}

/** The result of a sign-in: the state to store on this device and the account to show. */
export interface Connected {
	auth: ProviderAuth;
	account: string;
}

/** A client id as pasted: trimmed; empty or with spaces inside is refused. */
export function cleanClientId(raw: string): string | null {
	const v = raw.trim();
	return v && !/\s/.test(v) && v.length <= 512 ? v : null;
}

export async function connectAccount(http: Http, clock: Clock, provider: ProviderId, clientId: string, ui: SignInUi, opts: ConnectOptions = {}): Promise<Connected> {
	const id = cleanClientId(clientId);
	if (!id) throw new SignInError("client", "empty client id");
	const secret = opts.clientSecret?.trim() || undefined;
	if (oauthConfig(provider).needsSecret && !secret) throw new SignInError("client", "missing client secret");
	const auth = await runDeviceFlow(http, { provider, clientId: id, clientSecret: secret }, ui, clock);
	// The provider keeps the state (root, refreshed tokens): `p.auth()` below is the one to store.
	const p = createProvider(auth, http, { clock });
	try {
		await p.prepareRoot(opts.rootName?.trim() || DEFAULT_ROOT_NAME, ui.signal);
		const account = await p.account();
		return { auth: p.auth(), account };
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw new SignInError("cancelled");
		if (e instanceof AuthRequiredError) throw new SignInError("client", "the new token was refused");
		if (e instanceof TransientRemoteError) throw new SignInError("network", e.message);
		throw new SignInError("other", e instanceof Error ? e.message : String(e));
	}
}

/**
 * Disconnect: revokes the refresh token where the provider allows it (Google). The caller then deletes the local state
 * (`clearAuth`) whatever this returns. `manageUrl` is the page where the user can remove the app's access by hand.
 */
export async function disconnectAccount(http: Http, auth: ProviderAuth): Promise<{ revoked: boolean; manageUrl: string }> {
	const revoked = await revokeAuth(http, auth);
	return { revoked, manageUrl: oauthConfig(auth.provider).manageUrl };
}
