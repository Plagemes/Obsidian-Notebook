/**
 * 0.22 integration (roadmap #126): the `SyncAuthUI` the sync engine and its settings talk to (auth-ui.ts), built over the
 * providers' sign-in (`src/sync/auth/`, `src/sync/providers/`). No `obsidian` import: the sign-in dialog, the HTTP layer and the
 * strings are injected (see `auth/obsidian-auth.ts` for the real ones), so this file is tested in Node with fakes.
 *
 * Where things live (all per device, none of it in the vault or in `data.json`):
 *   - the OAuth client id: the synced plugin settings (it is not a secret; every device must use the same one);
 *   - Google's client secret: ONE local-storage key, `cloudSecretKey(provider)`, which the settings field edits. It is stripped
 *     from the sign-in state before that is stored and merged back in when the provider is created;
 *   - the sign-in state (refresh and access tokens, the chosen cloud folder): local-storage key `AUTH_KEY` (auth/token-store.ts),
 *     one account per device;
 *   - the account label shown in the settings: local-storage key `CLOUD_ACCOUNT_KEY`.
 */
import { CLOUD_ACCOUNT_KEY, cloudSecretKey, type CloudClient, type SignOutResult, type SyncAuthUI } from "./auth-ui";
import type { Connected } from "./auth/connect";
import type { Http } from "./auth/http";
import { oauthConfig, type ProviderAuth } from "./auth/oauth-config";
import { clearAuth, loadAuth, saveAuth, type LocalStore } from "./auth/token-store";
import type { ConnectedProvider, ProviderOptions } from "./providers";
import type { CloudProvider, ProviderId } from "./provider-types";

export interface AuthAdapterDeps {
	/** The per-device storage (Obsidian's `app.loadLocalStorage` / `app.saveLocalStorage`). */
	store: LocalStore;
	http: () => Http;
	/** The sign-in dialog and flow; resolves with the new state and account, or null when cancelled. Never rejects for a refusal. */
	openSignIn: (o: { provider: ProviderId; clientId: string; clientSecret?: string }) => Promise<Connected | null>;
	/** Revokes where the provider allows, then deletes the sign-in state (auth/sign-in.ts `disconnect`). */
	disconnect: (store: LocalStore, auth: ProviderAuth, http: Http) => Promise<{ revoked: boolean; manageUrl: string }>;
	createProvider: (auth: ProviderAuth, http: Http, opts: ProviderOptions) => ConnectedProvider;
	/** How a cloud folder is named in the settings (Google's root is the folder this app created, so it is said so). */
	rootText?: (provider: ProviderId, label: string) => string;
	log?: (message: string, error: unknown) => void;
}

function readText(store: LocalStore, key: string): string | null {
	try {
		const v = store.loadLocalStorage(key);
		return typeof v === "string" && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

export function createSyncAuthUI(d: AuthAdapterDeps): SyncAuthUI {
	const log = d.log ?? (() => {});
	const { store } = d;

	/** The sign-in state of this device with Google's secret merged in; null when signed out, or signed in to another service. */
	const load = (provider: ProviderId): ProviderAuth | null => {
		const auth = loadAuth(store);
		if (!auth || auth.provider !== provider) return null;
		if (!oauthConfig(provider).needsSecret) return auth;
		const secret = readText(store, cloudSecretKey(provider));
		return secret ? { ...auth, clientSecret: secret } : auth;
	};

	/** Stores a sign-in state: the secret goes to its own key (when the state carries one), never into the token blob. */
	const persist = (auth: ProviderAuth): boolean => {
		const { clientSecret, ...rest } = auth;
		try {
			if (clientSecret) store.saveLocalStorage(cloudSecretKey(auth.provider), clientSecret);
		} catch (e) {
			log("could not store the client secret", e);
		}
		return saveAuth(store, rest);
	};

	const saveAccount = (provider: ProviderId, label: string | null): void => {
		try {
			store.saveLocalStorage(CLOUD_ACCOUNT_KEY, label ? JSON.stringify({ provider, label }) : null);
		} catch (e) {
			log("could not store the account label", e);
		}
	};

	const rootLabelOf = (provider: ProviderId): string | null => {
		const label = load(provider)?.rootLabel;
		if (!label) return null;
		return d.rootText ? d.rootText(provider, label) : label;
	};

	return {
		available: () => true,
		isSignedIn: (provider) => load(provider) !== null,
		async signIn(provider: ProviderId, client: CloudClient): Promise<boolean> {
			try {
				const done = await d.openSignIn({ provider, clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) });
				if (!done) return false;
				if (!persist(done.auth)) {
					log("the sign-in state could not be stored", new Error("storage refused it"));
					return false;
				}
				saveAccount(provider, done.account);
				return true;
			} catch (e) {
				log("sign-in failed", e);
				return false;
			}
		},
		async signOut(provider: ProviderId): Promise<SignOutResult | void> {
			const auth = load(provider);
			saveAccount(provider, null);
			if (!auth) return;
			try {
				return await d.disconnect(store, auth, d.http());
			} catch (e) {
				log("disconnect failed", e);
				clearAuth(store);
				return { revoked: false, manageUrl: oauthConfig(provider).manageUrl };
			}
		},
		accountLabel(provider: ProviderId): string | null {
			try {
				const raw = readText(store, CLOUD_ACCOUNT_KEY);
				const v = raw ? (JSON.parse(raw) as unknown) : null;
				if (typeof v !== "object" || v === null) return null;
				const o = v as { provider?: unknown; label?: unknown };
				return o.provider === provider && typeof o.label === "string" && o.label.length > 0 ? o.label : null;
			} catch {
				return null;
			}
		},
		rootLabel: rootLabelOf,
		rootId: (provider) => load(provider)?.rootId ?? null,
		async connect(provider: ProviderId): Promise<CloudProvider | null> {
			const auth = load(provider);
			if (!auth?.rootId) return null;
			return d.createProvider(auth, d.http(), {
				// Microsoft rotates its refresh tokens: every refresh must be stored, or the next start uses a dead one. A refresh that
				// finishes after "Disconnect" is dropped: the sign-in must not come back.
				onAuthChange: (next) => {
					const cur = loadAuth(store);
					if (cur && cur.provider === next.provider) persist(next);
				},
			});
		},
	};
}
