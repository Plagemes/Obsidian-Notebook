/**
 * The provider factory of the cloud connector (#126). The sync engine calls `createProvider(auth, http)` with the
 * device-local sign-in state and gets a `CloudProvider` bound to the sync root in `auth.rootId`.
 * Refreshed tokens (Microsoft rotates its refresh tokens) and the root chosen by `prepareRoot` come back through
 * `onAuthChange`: the owner must store them (sync/auth/token-store.ts), or the next start uses a dead refresh token.
 */
import type { CloudProvider, StoredAuth } from "../provider-types";
import type { Http } from "../auth/http";
import type { ProviderAuth } from "../auth/oauth-config";
import { realClock, type Clock } from "../auth/retry";
import { TokenManager } from "../auth/tokens";
import { ApiClient, type ApiTuning } from "./api";
import { GoogleDriveProvider, prepareDriveRoot, type ChunkOptions } from "./gdrive";
import { OneDriveProvider, prepareOneDriveRoot } from "./onedrive";

export interface ProviderOptions extends ChunkOptions {
	/** Called with the new state after a token refresh or a root change; store it on this device. */
	onAuthChange?: (auth: ProviderAuth) => void;
	clock?: Clock;
	tuning?: ApiTuning;
}

/** A provider plus the set-up step the sign-in uses. */
export interface ConnectedProvider extends CloudProvider {
	/** Finds or creates the sync root folder `name` at the top of the drive and records it in the sign-in state. */
	prepareRoot(name: string, signal?: AbortSignal): Promise<{ rootId: string; rootLabel: string }>;
	/** The current sign-in state (with refreshed tokens). */
	auth(): ProviderAuth;
}

/** Thrown by the file methods of a provider whose sign-in state has no sync root yet (a bug: sign-in sets it). */
export class NoRootError extends Error {
	constructor() {
		super("No sync folder chosen for this account");
		this.name = "NoRootError";
	}
}

export function createProvider(auth: StoredAuth | ProviderAuth, http: Http, opts: ProviderOptions = {}): ConnectedProvider {
	const clock = opts.clock ?? realClock;
	const tokens = new TokenManager(auth, http, clock, opts.onAuthChange);
	const api = new ApiClient(http, tokens, clock, auth.provider, opts.tuning);
	const make = (rootId: string): CloudProvider => (auth.provider === "gdrive" ? new GoogleDriveProvider(api, rootId, opts) : new OneDriveProvider(api, rootId, opts));
	let inner: CloudProvider | null = auth.rootId ? make(auth.rootId) : null;
	const bound = (): CloudProvider => {
		if (!inner) throw new NoRootError();
		return inner;
	};
	return {
		id: auth.provider,
		account: () => (inner ?? make("")).account(),
		changes: async (cursor, signal) => bound().changes(cursor, signal),
		download: async (id, signal) => bound().download(id, signal),
		upload: async (path, data, ifRev, signal) => bound().upload(path, data, ifRev, signal),
		remove: async (id, ifRev, signal) => bound().remove(id, ifRev, signal),
		prepareRoot: async (name, signal) => {
			const root = auth.provider === "gdrive" ? await prepareDriveRoot(api, name, signal) : await prepareOneDriveRoot(api, name, signal);
			tokens.update(root);
			inner = make(root.rootId);
			return root;
		},
		auth: () => tokens.current(),
	};
}
