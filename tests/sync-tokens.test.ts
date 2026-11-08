// #126 cloud connector: token refresh, authorised requests (401, retries, Retry-After), revocation and the device-local store.
import { describe, expect, it } from "vitest";
import { disconnectAccount } from "../src/sync/auth/connect";
import { oauthConfig, type ProviderAuth } from "../src/sync/auth/oauth-config";
import { isTransientStatus, retryAfterMs, sendWithRetry } from "../src/sync/auth/retry";
import { AUTH_KEY, clearAuth, loadAuth, parseAuth, saveAuth, type LocalStore } from "../src/sync/auth/token-store";
import { TokenManager } from "../src/sync/auth/tokens";
import { ApiClient } from "../src/sync/providers/api";
import { AuthRequiredError, TransientRemoteError } from "../src/sync/provider-types";
import { FakeClock, FakeHttp, form, res } from "./sync-fake-http";

const G = oauthConfig("gdrive");
const M = oauthConfig("onedrive");
const API = "https://api.example/x";

function auth(over: Partial<ProviderAuth> = {}): ProviderAuth {
	return { provider: "onedrive", clientId: "cid", refreshToken: "rt-0", accessToken: "at-0", expiresAt: 1_700_000_000_000 + 3_600_000, rootId: "R", ...over };
}

describe("token refresh", () => {
	it("uses the stored token while it is valid, refreshes a minute before expiry", async () => {
		const clock = new FakeClock();
		const http = new FakeHttp().on("POST", M.tokenUrl, res(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }));
		const changes: ProviderAuth[] = [];
		const tm = new TokenManager(auth(), http, clock, (a) => changes.push(a));
		expect(await tm.token()).toBe("at-0");
		expect(http.calls).toEqual([]);
		clock.t += 3_600_000 - 30_000;
		expect(await tm.token()).toBe("at-1");
		expect(form(http.calls[0]!)).toMatchObject({ client_id: "cid", grant_type: "refresh_token", refresh_token: "rt-0", scope: M.scope });
		// Microsoft rotated the refresh token: the owner is told, so it can store it.
		expect(changes[changes.length - 1]).toMatchObject({ refreshToken: "rt-1", accessToken: "at-1" });
	});

	it("Google keeps the refresh token when the answer has none, and sends the secret", async () => {
		const http = new FakeHttp().on("POST", G.tokenUrl, res(200, { access_token: "g-1", expires_in: 3600 }));
		const tm = new TokenManager(auth({ provider: "gdrive", clientSecret: "sec", accessToken: undefined, expiresAt: undefined }), http, new FakeClock());
		expect(await tm.token()).toBe("g-1");
		expect(tm.current().refreshToken).toBe("rt-0");
		expect(form(http.calls[0]!)).toMatchObject({ client_secret: "sec" });
		expect(form(http.calls[0]!).scope).toBeUndefined();
	});

	it("invalid_grant means sign in again", async () => {
		const http = new FakeHttp().on("POST", M.tokenUrl, res(400, { error: "invalid_grant", error_description: "AADSTS70008" }));
		await expect(new TokenManager(auth({ accessToken: undefined }), http, new FakeClock()).token()).rejects.toBeInstanceOf(AuthRequiredError);
	});

	it("concurrent callers share one refresh", async () => {
		const http = new FakeHttp().on("POST", M.tokenUrl, res(200, { access_token: "at-1", expires_in: 3600 }));
		const tm = new TokenManager(auth({ accessToken: undefined }), http, new FakeClock());
		expect(await Promise.all([tm.token(), tm.token(), tm.token()])).toEqual(["at-1", "at-1", "at-1"]);
		expect(http.calls.length).toBe(1);
	});

	it("a refresh that keeps failing on the network is transient", async () => {
		const http = new FakeHttp().on("POST", M.tokenUrl, new Error("offline"));
		await expect(new TokenManager(auth({ accessToken: undefined }), http, new FakeClock()).token()).rejects.toBeInstanceOf(TransientRemoteError);
	});
});

describe("authorised requests", () => {
	it("a 401 refreshes once and retries; a second 401 means sign in again", async () => {
		const http = new FakeHttp()
			.once("GET", API, res(401, { error: { code: "InvalidAuthenticationToken" } }))
			.once("GET", API, res(200, { ok: true }))
			.on("POST", M.tokenUrl, res(200, { access_token: "at-1", expires_in: 3600 }));
		const clock = new FakeClock();
		const api = new ApiClient(http, new TokenManager(auth(), http, clock), clock, "onedrive");
		expect((await api.send({ url: API, method: "GET" })).status).toBe(200);
		expect(http.find("GET", API).map((c) => c.headers?.Authorization)).toEqual(["Bearer at-0", "Bearer at-1"]);

		const again = new FakeHttp().on("GET", API, res(401, "")).on("POST", M.tokenUrl, res(200, { access_token: "at-2", expires_in: 3600 }));
		const api2 = new ApiClient(again, new TokenManager(auth(), again, clock), clock, "onedrive");
		await expect(api2.send({ url: API, method: "GET" })).rejects.toBeInstanceOf(AuthRequiredError);
	});

	it("429 waits what Retry-After asks, then succeeds", async () => {
		const clock = new FakeClock();
		const http = new FakeHttp().once("GET", API, res(429, "", { "Retry-After": "7" })).once("GET", API, res(200, ""));
		expect((await sendWithRetry(http, () => ({ url: API, method: "GET" }), { clock })).status).toBe(200);
		expect(clock.slept).toEqual([7000]);
	});

	it("5xx backs off exponentially and ends in TransientRemoteError with the last Retry-After", async () => {
		const clock = new FakeClock();
		const http = new FakeHttp().on("GET", API, res(503, "", { "retry-after": "2" }));
		const e = await sendWithRetry(http, () => ({ url: API, method: "GET" }), { clock, tries: 3 }).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(TransientRemoteError);
		expect((e as TransientRemoteError).retryAfterMs).toBe(2000);
		expect(http.calls.length).toBe(3);

		const c2 = new FakeClock();
		await sendWithRetry(new FakeHttp().on("GET", API, res(502, "")), () => ({ url: API, method: "GET" }), { clock: c2, tries: 4, baseMs: 1000, random: () => 0.5 }).catch(() => undefined);
		expect(c2.slept).toEqual([1000, 2000, 4000]);
	});

	it("Drive's 403 rate limit is transient, other 403s are not; Retry-After as a date", () => {
		expect(isTransientStatus(res(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }))).toBe(true);
		expect(isTransientStatus(res(403, { error: { errors: [{ reason: "insufficientFilePermissions" }] } }))).toBe(false);
		expect(isTransientStatus(res(501, ""))).toBe(false);
		expect(retryAfterMs(res(503, "", { "Retry-After": new Date(1_700_000_010_000).toUTCString() }), 1_700_000_000_000)).toBe(10_000);
	});

	it("an aborted signal stops before the request", async () => {
		const ac = new AbortController();
		ac.abort();
		const http = new FakeHttp().on("GET", API, res(200, ""));
		await expect(sendWithRetry(http, () => ({ url: API, method: "GET" }), { clock: new FakeClock(), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(http.calls).toEqual([]);
	});
});

describe("disconnect", () => {
	it("Google revokes the refresh token; Microsoft has no revocation endpoint", async () => {
		const http = new FakeHttp().on("POST", G.revokeUrl ?? "", res(200, ""));
		expect(await disconnectAccount(http, auth({ provider: "gdrive" }))).toEqual({ revoked: true, manageUrl: G.manageUrl });
		expect(form(http.calls[0]!)).toEqual({ token: "rt-0" });
		const none = new FakeHttp();
		expect(await disconnectAccount(none, auth())).toEqual({ revoked: false, manageUrl: M.manageUrl });
		expect(none.calls).toEqual([]);
		expect((await disconnectAccount(new FakeHttp().on("POST", G.revokeUrl ?? "", new Error("offline")), auth({ provider: "gdrive" }))).revoked).toBe(false);
	});
});

describe("device-local token store", () => {
	class Store implements LocalStore {
		data = new Map<string, unknown>();
		loadLocalStorage(key: string): unknown {
			return this.data.get(key) ?? null;
		}
		saveLocalStorage(key: string, value: unknown): void {
			this.data.set(key, value);
		}
	}

	it("round-trips, reads leniently, and clears", () => {
		const s = new Store();
		expect(loadAuth(s)).toBeNull();
		const a = auth({ provider: "gdrive", clientSecret: "sec", rootLabel: "My Drive/Notebook sync" });
		expect(saveAuth(s, a)).toBe(true);
		expect(loadAuth(s)).toEqual(a);
		s.data.set(AUTH_KEY, "{not json");
		expect(loadAuth(s)).toBeNull();
		expect(parseAuth({ provider: "dropbox", clientId: "c", refreshToken: "r" })).toBeNull();
		expect(parseAuth({ provider: "onedrive", clientId: "c", refreshToken: "r", accessToken: "a" })).toEqual({ provider: "onedrive", clientId: "c", refreshToken: "r" });
		saveAuth(s, a);
		clearAuth(s);
		expect(loadAuth(s)).toBeNull();
	});

	it("a storage that throws counts as signed out", () => {
		const broken: LocalStore = {
			loadLocalStorage: () => {
				throw new Error("quota");
			},
			saveLocalStorage: () => {
				throw new Error("quota");
			},
		};
		expect(loadAuth(broken)).toBeNull();
		expect(saveAuth(broken, auth())).toBe(false);
		expect(() => clearAuth(broken)).not.toThrow();
	});
});
