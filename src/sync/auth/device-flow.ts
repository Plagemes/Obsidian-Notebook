/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for both providers (#126). The same flow works in Obsidian on Android
 * and on desktop without a redirect URI: the plugin shows a short code and a web address, the user approves on any
 * browser, and the plugin polls the token endpoint, waiting `interval` seconds between polls and five seconds more after
 * each `slow_down` (RFC 8628 §3.5). Pure: HTTP and time are injected.
 */
import type { ProviderId } from "../provider-types";
import { FORM, formBody, json, num, obj, str, type Http, type HttpResponse } from "./http";
import { oauthConfig, type ProviderAuth } from "./oauth-config";
import { throwIfAborted, type Clock } from "./retry";

/** What the user sees: the code to type and where. */
export interface DeviceCodePrompt {
	userCode: string;
	verificationUrl: string;
	/** ms since 1970 when the code stops working. */
	expiresAt: number;
}

export type SignInPhase = "requesting" | "waiting" | "slowDown" | "finishing";

/** The sign-in surface: shows the code and the progress; its signal cancels. */
export interface SignInUi {
	showCode(prompt: DeviceCodePrompt): void;
	phase?(phase: SignInPhase): void;
	signal?: AbortSignal;
}

export type SignInFailure = "denied" | "expired" | "cancelled" | "client" | "network" | "other";

/** A sign-in that did not end with tokens; `reason` picks the message shown. */
export class SignInError extends Error {
	constructor(readonly reason: SignInFailure, readonly detail = "") {
		super(`Sign-in ${reason}${detail ? `: ${detail}` : ""}`);
		this.name = "SignInError";
	}
}

/** The answer of the device authorization endpoint. */
export interface DeviceCode extends DeviceCodePrompt {
	deviceCode: string;
	/** Seconds between polls. */
	interval: number;
}

export interface DeviceFlowClient {
	provider: ProviderId;
	clientId: string;
	clientSecret?: string;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Polls that may fail on the network in a row before the sign-in gives up. */
const MAX_NETWORK_FAILURES = 5;

async function post(http: Http, url: string, fields: Record<string, string | undefined>): Promise<HttpResponse> {
	return http.request({ url, method: "POST", contentType: FORM, body: formBody(fields), headers: { Accept: "application/json" } });
}

const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client", "invalid_scope", "org_internal", "admin_policy_enforced", "deleted_client"]);

/** Asks the provider for a device code and the user code to show. */
export async function requestDeviceCode(http: Http, client: DeviceFlowClient, clock: Clock): Promise<DeviceCode> {
	const cfg = oauthConfig(client.provider);
	let res: HttpResponse;
	try {
		res = await post(http, cfg.deviceUrl, { client_id: client.clientId, scope: cfg.scope });
	} catch (e) {
		throw new SignInError("network", e instanceof Error ? e.message : String(e));
	}
	const body = obj(json(res));
	if (res.status !== 200) {
		const code = str(body.error) ?? `HTTP ${res.status}`;
		throw new SignInError(CLIENT_ERRORS.has(code) || res.status === 401 ? "client" : res.status >= 500 || res.status === 429 ? "network" : "other", code);
	}
	const deviceCode = str(body.device_code);
	const userCode = str(body.user_code);
	// Google says `verification_url`, RFC 8628 and Microsoft `verification_uri`.
	const verificationUrl = str(body.verification_uri) ?? str(body.verification_url);
	if (!deviceCode || !userCode || !verificationUrl || !/^https:\/\//.test(verificationUrl)) throw new SignInError("other", "incomplete device code answer");
	const expiresIn = num(body.expires_in) ?? 900;
	const interval = Math.max(1, num(body.interval) ?? 5);
	return { deviceCode, userCode, verificationUrl, expiresAt: clock.now() + expiresIn * 1000, interval };
}

/** The token answer turned into the stored sign-in state. */
export function authFromTokens(client: DeviceFlowClient, body: Record<string, unknown>, now: number): ProviderAuth {
	const refreshToken = str(body.refresh_token);
	const accessToken = str(body.access_token);
	if (!refreshToken || !accessToken) throw new SignInError("other", "no refresh token in the answer");
	const expiresIn = num(body.expires_in) ?? 3600;
	const auth: ProviderAuth = { provider: client.provider, clientId: client.clientId, refreshToken, accessToken, expiresAt: now + expiresIn * 1000 };
	if (client.clientSecret) auth.clientSecret = client.clientSecret;
	return auth;
}

/** Polls the token endpoint until the user approves, denies, the code expires, or the UI cancels. */
export async function pollForToken(http: Http, client: DeviceFlowClient, code: DeviceCode, clock: Clock, ui: Pick<SignInUi, "phase" | "signal">): Promise<ProviderAuth> {
	const cfg = oauthConfig(client.provider);
	let interval = code.interval;
	let networkFailures = 0;
	for (;;) {
		try {
			await clock.sleep(interval * 1000, ui.signal);
		} catch {
			throw new SignInError("cancelled");
		}
		if (ui.signal?.aborted) throw new SignInError("cancelled");
		if (clock.now() >= code.expiresAt) throw new SignInError("expired");
		let res: HttpResponse;
		try {
			res = await post(http, cfg.tokenUrl, { client_id: client.clientId, client_secret: cfg.needsSecret ? client.clientSecret : undefined, device_code: code.deviceCode, grant_type: DEVICE_GRANT });
		} catch (e) {
			if (++networkFailures >= MAX_NETWORK_FAILURES) throw new SignInError("network", e instanceof Error ? e.message : String(e));
			continue;
		}
		if (ui.signal?.aborted) throw new SignInError("cancelled");
		const body = obj(json(res));
		if (res.status === 200) {
			ui.phase?.("finishing");
			return authFromTokens(client, body, clock.now());
		}
		const error = str(body.error) ?? "";
		if (error === "authorization_pending") {
			networkFailures = 0;
			continue;
		}
		if (error === "slow_down") {
			interval += 5;
			ui.phase?.("slowDown");
			continue;
		}
		if (error === "access_denied" || error === "authorization_declined") throw new SignInError("denied");
		if (error === "expired_token") throw new SignInError("expired");
		if (error === "invalid_grant" || error === "bad_verification_code") throw new SignInError("expired", error);
		if (CLIENT_ERRORS.has(error)) throw new SignInError("client", error);
		if (res.status === 429 || res.status >= 500) {
			if (++networkFailures >= MAX_NETWORK_FAILURES) throw new SignInError("network", `HTTP ${res.status}`);
			continue;
		}
		throw new SignInError("other", error || `HTTP ${res.status}`);
	}
}

/** The whole device flow: request a code, show it, poll until there are tokens. */
export async function runDeviceFlow(http: Http, client: DeviceFlowClient, ui: SignInUi, clock: Clock): Promise<ProviderAuth> {
	ui.phase?.("requesting");
	throwIfCancelled(ui.signal);
	const code = await requestDeviceCode(http, client, clock);
	throwIfCancelled(ui.signal);
	ui.showCode({ userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt: code.expiresAt });
	ui.phase?.("waiting");
	return pollForToken(http, client, code, clock, ui);
}

function throwIfCancelled(signal?: AbortSignal): void {
	try {
		throwIfAborted(signal);
	} catch {
		throw new SignInError("cancelled");
	}
}
