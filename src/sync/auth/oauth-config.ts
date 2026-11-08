/**
 * OAuth endpoints and scopes of the two providers (#126). The plugin ships no client id and no secret: the user registers
 * their own OAuth app (docs/cloud-sync.md) and pastes its client id (and, for Google, the client secret Google issues to a
 * "TVs and Limited Input devices" client, which is not confidential for an installed app). Sources: docs/research.md.
 */
import type { ProviderId, StoredAuth } from "../provider-types";

export interface OAuthConfig {
	/** RFC 8628 device authorization endpoint. */
	deviceUrl: string;
	tokenUrl: string;
	/** Token revocation endpoint (RFC 7009), when the provider has one for public clients. */
	revokeUrl?: string;
	/** Space-separated scopes asked for in the device flow. */
	scope: string;
	/** True when the token endpoint wants the client secret (Google's limited-input clients). */
	needsSecret: boolean;
	/** Where the user removes the app's access when the provider has no revocation endpoint. */
	manageUrl: string;
}

/**
 * Google: the device flow allows only a few scopes; for Drive these are `drive.file` and `drive.appdata` (not the full
 * `drive` scope). `drive.file` reaches only files and folders this OAuth client created or opened, so the sync root is a
 * folder the plugin creates ("Notebook sync" in My Drive). Every device must use the same client id to see it.
 */
const GOOGLE: OAuthConfig = {
	deviceUrl: "https://oauth2.googleapis.com/device/code",
	tokenUrl: "https://oauth2.googleapis.com/token",
	revokeUrl: "https://oauth2.googleapis.com/revoke",
	scope: "https://www.googleapis.com/auth/drive.file",
	needsSecret: true,
	manageUrl: "https://myaccount.google.com/connections",
};

/**
 * Microsoft identity platform v2, tenant `common` (personal Microsoft accounts and work or school accounts; the app
 * registration must allow both and have "Allow public client flows" on). `offline_access` gives the refresh token,
 * `Files.ReadWrite` the user's OneDrive, `User.Read` the account name shown in settings. There is no endpoint that revokes
 * one refresh token of a public client: Disconnect deletes the tokens on this device and links the consent page.
 */
const MICROSOFT: OAuthConfig = {
	deviceUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
	tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
	scope: "Files.ReadWrite offline_access User.Read",
	needsSecret: false,
	manageUrl: "https://account.live.com/consent/Manage",
};

export function oauthConfig(provider: ProviderId): OAuthConfig {
	return provider === "gdrive" ? GOOGLE : MICROSOFT;
}

/** The device-local sign-in state, with the one field the contract does not carry: Google's client secret. */
export interface ProviderAuth extends StoredAuth {
	/** Google only: the client secret of the user's own limited-input OAuth client. Never synced, never logged. */
	clientSecret?: string;
}

/** Default name of the sync root folder the plugin creates at the top of the user's drive. */
export const DEFAULT_ROOT_NAME = "Notebook sync";
