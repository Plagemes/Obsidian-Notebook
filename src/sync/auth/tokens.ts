/**
 * Access tokens of a signed-in provider (#126): refreshed a minute before they expire (or after a 401), one refresh at a
 * time. A refresh the provider refuses for good (`invalid_grant`, an unknown client) becomes `AuthRequiredError`: the user
 * must sign in again. Microsoft rotates refresh tokens, so every refresh reports the new state through `onChange`, and the
 * owner stores it on this device only (token-store.ts). Tokens are never logged.
 */
import { AuthRequiredError, TransientRemoteError } from "../provider-types";
import { FORM, formBody, json, num, obj, str, type Http } from "./http";
import { oauthConfig, type ProviderAuth } from "./oauth-config";
import { sendWithRetry, type Clock } from "./retry";

/** Refresh when less than this is left on the access token. */
export const EXPIRY_MARGIN_MS = 60_000;

const PERMANENT = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "deleted_client", "interaction_required", "consent_required"]);

export class TokenManager {
	private auth: ProviderAuth;
	private pending: Promise<string> | null = null;

	constructor(
		auth: ProviderAuth,
		private readonly http: Http,
		private readonly clock: Clock,
		private readonly onChange?: (auth: ProviderAuth) => void,
	) {
		this.auth = { ...auth };
	}

	/** The current sign-in state (a copy). */
	current(): ProviderAuth {
		return { ...this.auth };
	}

	/** Updates fields that are not tokens (the root folder) and reports the new state. */
	update(patch: Partial<Pick<ProviderAuth, "rootId" | "rootLabel">>): void {
		this.auth = { ...this.auth, ...patch };
		this.onChange?.(this.current());
	}

	/** A valid access token, refreshed first when it is missing or about to expire. */
	async token(signal?: AbortSignal): Promise<string> {
		const a = this.auth;
		if (a.accessToken && a.expiresAt !== undefined && a.expiresAt - EXPIRY_MARGIN_MS > this.clock.now()) return a.accessToken;
		return this.refresh(signal);
	}

	/** Forgets the access token (after a 401) so the next `token()` refreshes. */
	invalidate(token: string): void {
		if (this.auth.accessToken === token) this.auth = { ...this.auth, accessToken: undefined, expiresAt: undefined };
	}

	/** Refreshes now (shared by concurrent callers). */
	refresh(signal?: AbortSignal): Promise<string> {
		this.pending ??= this.doRefresh(signal).finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	private async doRefresh(signal?: AbortSignal): Promise<string> {
		const a = this.auth;
		const cfg = oauthConfig(a.provider);
		const res = await sendWithRetry(this.http, () => ({
			url: cfg.tokenUrl,
			method: "POST",
			contentType: FORM,
			headers: { Accept: "application/json" },
			body: formBody({
				client_id: a.clientId,
				client_secret: cfg.needsSecret ? a.clientSecret : undefined,
				grant_type: "refresh_token",
				refresh_token: a.refreshToken,
				// Microsoft wants the scopes again on a refresh; Google ignores the field when absent.
				scope: a.provider === "onedrive" ? cfg.scope : undefined,
			}),
		}), { clock: this.clock, signal });
		const body = obj(json(res));
		if (res.status !== 200) {
			const error = str(body.error) ?? "";
			if (PERMANENT.has(error) || res.status === 401) throw new AuthRequiredError(a.provider);
			throw new TransientRemoteError(`Token refresh failed (HTTP ${res.status}${error ? ` ${error}` : ""})`);
		}
		const accessToken = str(body.access_token);
		if (!accessToken) throw new TransientRemoteError("Token refresh answer without an access token");
		const expiresIn = num(body.expires_in) ?? 3600;
		this.auth = {
			...this.auth,
			accessToken,
			expiresAt: this.clock.now() + expiresIn * 1000,
			refreshToken: str(body.refresh_token) ?? this.auth.refreshToken,
		};
		this.onChange?.(this.current());
		return accessToken;
	}
}

/**
 * Revokes the refresh token where the provider allows it (Google). Resolves true when the provider confirmed (or the token
 * was already invalid), false when there is no revocation endpoint (Microsoft) or the request failed: the caller deletes
 * the local tokens either way.
 */
export async function revokeAuth(http: Http, auth: ProviderAuth): Promise<boolean> {
	const cfg = oauthConfig(auth.provider);
	if (!cfg.revokeUrl) return false;
	try {
		const res = await http.request({ url: cfg.revokeUrl, method: "POST", contentType: FORM, body: formBody({ token: auth.refreshToken }) });
		return res.status === 200 || (res.status === 400 && str(obj(json(res)).error) === "invalid_token");
	} catch {
		return false;
	}
}
