/**
 * 0.22 (roadmap #126): what the cloud sync engine and its settings need from the providers' sign-in (implemented by the
 * providers in `src/sync/auth/` and `src/sync/providers/`). Pure types and a stub: no `obsidian` import.
 *
 * The plugin plugs the real one in at load (`auth/obsidian-auth.ts` over `auth-adapter.ts`). Until then, and in tests that need no
 * providers, it uses `NO_SYNC_AUTH`: every provider reports itself as not available, so the settings show a note instead of a
 * "Sign in" button (no control that does nothing).
 */
import type { CloudProvider, ProviderId } from "./provider-types";

/**
 * Device-local storage keys of the cloud sync (Obsidian's `app.loadLocalStorage`: per vault and per device, never in the vault
 * and never in the synced plugin settings). The sign-in state (tokens, cloud folder) is `AUTH_KEY` in auth/token-store.ts.
 * Google's client secret lives ONLY under `cloudSecretKey`: the settings field edits it, and `auth-adapter.ts` keeps it out of the
 * sign-in blob and merges it back in when a provider is created.
 */
export const cloudSecretKey = (p: ProviderId): string => `notebook-cloud-sync-secret-${p}`;
/** The account label (e-mail or name) shown in the settings, as `{provider, label}`. */
export const CLOUD_ACCOUNT_KEY = "notebook-cloud-sync-account";

/** The user's own OAuth client: the id (same on every device) and, for Google, the secret (device-local). */
export interface CloudClient {
	clientId: string;
	clientSecret?: string;
}

export interface SignOutResult {
	revoked: boolean;
	manageUrl?: string;
}

export interface SyncAuthUI {
	/** Whether sign-in for `provider` exists in this build (false: the settings say so and offer no button). */
	available(provider: ProviderId): boolean;
	/** Whether this device holds a sign-in for `provider` (tokens in device-local storage). */
	isSignedIn(provider: ProviderId): boolean;
	/**
	 * Runs the whole sign-in flow for `provider` on this device with the user's own OAuth client (consent, then the remote root).
	 * Resolves true once signed in; false when cancelled or failed (the flow shows its own message). Never throws.
	 */
	signIn(provider: ProviderId, client: CloudClient): Promise<boolean>;
	/**
	 * Forgets this device's sign-in for `provider` (tokens) and tries to revoke it. Never throws. When the revocation did not
	 * happen, `manageUrl` is where the user can remove the access by hand (the settings say so).
	 */
	signOut(provider: ProviderId): Promise<SignOutResult | void>;
	/** Account label for the settings (e-mail or name), or null when unknown. */
	accountLabel(provider: ProviderId): string | null;
	/** Display path of the chosen root folder, or null. */
	rootLabel(provider: ProviderId): string | null;
	/** Remote id of the chosen root folder (the sync state is bound to it), or null. */
	rootId(provider: ProviderId): string | null;
	/** A provider bound to the root folder, ready to use; null when not signed in. May throw AuthRequiredError. */
	connect(provider: ProviderId): Promise<CloudProvider | null>;
	/** Optional: lets the user pick another root folder; resolves true when it changed. */
	chooseRoot?(provider: ProviderId): Promise<boolean>;
}

/** The stub used until the providers are integrated: nothing is available, nothing is signed in. */
export const NO_SYNC_AUTH: SyncAuthUI = {
	available: () => false,
	isSignedIn: () => false,
	signIn: () => Promise.resolve(false),
	signOut: () => Promise.resolve(),
	accountLabel: () => null,
	rootLabel: () => null,
	rootId: () => null,
	connect: () => Promise.resolve(null),
};
