/**
 * Where the sign-in state lives (#126): Obsidian's per-device local storage (`app.saveLocalStorage`, kept per vault and
 * per device). Never in the vault, never in the synced plugin settings, never sent anywhere but the provider, never
 * logged. Read leniently: anything unreadable counts as signed out (the user signs in again; no file is touched).
 */
import type { ProviderId } from "../provider-types";
import type { ProviderAuth } from "./oauth-config";

/** Local storage key of the sign-in state. */
export const AUTH_KEY = "notebook-sync-auth";

/** The part of Obsidian's App that holds per-device values. */
export interface LocalStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

const PROVIDERS: readonly ProviderId[] = ["gdrive", "onedrive"];
const MAX_LEN = 16_384;

function text(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 && v.length <= MAX_LEN ? v : undefined;
}

/** A stored value checked field by field; null when it is not a usable sign-in state. */
export function parseAuth(raw: unknown): ProviderAuth | null {
	let v = raw;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v) as unknown;
		} catch {
			return null;
		}
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	const provider = o.provider;
	if (typeof provider !== "string" || !PROVIDERS.includes(provider as ProviderId)) return null;
	const clientId = text(o.clientId);
	const refreshToken = text(o.refreshToken);
	if (!clientId || !refreshToken) return null;
	const auth: ProviderAuth = { provider: provider as ProviderId, clientId, refreshToken };
	const accessToken = text(o.accessToken);
	const expiresAt = typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : undefined;
	if (accessToken && expiresAt !== undefined) {
		auth.accessToken = accessToken;
		auth.expiresAt = expiresAt;
	}
	const rootId = text(o.rootId);
	if (rootId) auth.rootId = rootId;
	const rootLabel = text(o.rootLabel);
	if (rootLabel) auth.rootLabel = rootLabel;
	const clientSecret = text(o.clientSecret);
	if (clientSecret) auth.clientSecret = clientSecret;
	return auth;
}

/** The sign-in state on this device, or null (signed out, or unreadable). */
export function loadAuth(store: LocalStore): ProviderAuth | null {
	try {
		return parseAuth(store.loadLocalStorage(AUTH_KEY));
	} catch {
		return null;
	}
}

/** Stores the sign-in state on this device. Returns false when the storage refused it. */
export function saveAuth(store: LocalStore, auth: ProviderAuth): boolean {
	try {
		store.saveLocalStorage(AUTH_KEY, JSON.stringify(auth));
		return true;
	} catch {
		return false;
	}
}

/** Deletes the sign-in state from this device. */
export function clearAuth(store: LocalStore): void {
	try {
		store.saveLocalStorage(AUTH_KEY, null);
	} catch {
		// Nothing else to do: the next load reads whatever is left leniently.
	}
}
