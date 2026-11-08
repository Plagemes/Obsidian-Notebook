// #126 cloud connector: the OAuth 2.0 device flow (RFC 8628) for Google and Microsoft, and connecting an account.
import { describe, expect, it } from "vitest";
import { cleanClientId, connectAccount } from "../src/sync/auth/connect";
import { pollForToken, requestDeviceCode, runDeviceFlow, SignInError, type DeviceCodePrompt, type SignInPhase } from "../src/sync/auth/device-flow";
import { oauthConfig } from "../src/sync/auth/oauth-config";
import { bodyJson, FakeClock, FakeHttp, form, res } from "./sync-fake-http";

const G = oauthConfig("gdrive");
const M = oauthConfig("onedrive");

function ui(signal?: AbortSignal) {
	const shown: DeviceCodePrompt[] = [];
	const phases: SignInPhase[] = [];
	return { shown, phases, signal, showCode: (p: DeviceCodePrompt) => shown.push(p), phase: (p: SignInPhase) => phases.push(p) };
}

const GOOGLE_CODE = { device_code: "dev-1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 };
const MS_CODE = { device_code: "dev-2", user_code: "F7KQ2PLM", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5, message: "…" };
const TOKENS = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3599, token_type: "Bearer" };

async function failure(p: Promise<unknown>): Promise<SignInError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof SignInError) return e;
		throw e;
	}
	throw new Error("expected a SignInError");
}

describe("device flow", () => {
	it("Google: shows the code, polls while pending, and returns tokens with the client secret", async () => {
		const http = new FakeHttp()
			.once("POST", G.deviceUrl, res(200, GOOGLE_CODE))
			.once("POST", G.tokenUrl, res(428, { error: "authorization_pending" }))
			.once("POST", G.tokenUrl, res(428, { error: "authorization_pending" }))
			.once("POST", G.tokenUrl, res(200, TOKENS));
		const clock = new FakeClock();
		const u = ui();
		const start = clock.now();
		const auth = await runDeviceFlow(http, { provider: "gdrive", clientId: "cid.apps.googleusercontent.com", clientSecret: "sec" }, u, clock);
		expect(u.shown).toEqual([{ userCode: "ABCD-EFGH", verificationUrl: "https://www.google.com/device", expiresAt: start + 1_800_000 }]);
		expect(u.phases).toEqual(["requesting", "waiting", "finishing"]);
		expect(clock.slept).toEqual([5000, 5000, 5000]);
		expect(form(http.calls[0]!)).toEqual({ client_id: "cid.apps.googleusercontent.com", scope: "https://www.googleapis.com/auth/drive.file" });
		expect(form(http.calls[1]!)).toEqual({ client_id: "cid.apps.googleusercontent.com", client_secret: "sec", device_code: "dev-1", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
		expect(auth).toEqual({ provider: "gdrive", clientId: "cid.apps.googleusercontent.com", clientSecret: "sec", refreshToken: "rt-1", accessToken: "at-1", expiresAt: clock.now() + 3_599_000 });
	});

	it("Microsoft: verification_uri, no client secret, offline_access scope", async () => {
		const http = new FakeHttp().once("POST", M.deviceUrl, res(200, MS_CODE)).once("POST", M.tokenUrl, res(200, TOKENS));
		const auth = await runDeviceFlow(http, { provider: "onedrive", clientId: "11111111-2222" }, ui(), new FakeClock());
		expect(form(http.calls[0]!).scope).toBe("Files.ReadWrite.AppFolder offline_access User.Read");
		expect(form(http.calls[1]!).client_secret).toBeUndefined();
		expect(auth.provider).toBe("onedrive");
		expect(auth.clientSecret).toBeUndefined();
	});

	it("slow_down adds five seconds to the interval each time (RFC 8628 §3.5)", async () => {
		const http = new FakeHttp()
			.once("POST", G.tokenUrl, res(403, { error: "slow_down" }))
			.once("POST", G.tokenUrl, res(403, { error: "slow_down" }))
			.once("POST", G.tokenUrl, res(428, { error: "authorization_pending" }))
			.once("POST", G.tokenUrl, res(200, TOKENS));
		const clock = new FakeClock();
		const u = ui();
		await pollForToken(http, { provider: "gdrive", clientId: "c", clientSecret: "s" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 5 }, clock, u);
		expect(clock.slept).toEqual([5000, 10000, 15000, 15000]);
		expect(u.phases).toContain("slowDown");
	});

	it("maps denied, expired and client errors", async () => {
		const code = (clock: FakeClock) => ({ deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 5 });
		const c1 = new FakeClock();
		expect((await failure(pollForToken(new FakeHttp().on("POST", G.tokenUrl, res(403, { error: "access_denied" })), { provider: "gdrive", clientId: "c", clientSecret: "s" }, code(c1), c1, {}))).reason).toBe("denied");
		const c2 = new FakeClock();
		expect((await failure(pollForToken(new FakeHttp().on("POST", M.tokenUrl, res(400, { error: "authorization_declined" })), { provider: "onedrive", clientId: "c" }, code(c2), c2, {}))).reason).toBe("denied");
		const c3 = new FakeClock();
		expect((await failure(pollForToken(new FakeHttp().on("POST", M.tokenUrl, res(400, { error: "expired_token" })), { provider: "onedrive", clientId: "c" }, code(c3), c3, {}))).reason).toBe("expired");
		const c4 = new FakeClock();
		expect((await failure(pollForToken(new FakeHttp().on("POST", G.tokenUrl, res(401, { error: "invalid_client" })), { provider: "gdrive", clientId: "c", clientSecret: "s" }, code(c4), c4, {}))).reason).toBe("client");
	});

	it("stops when the code's lifetime is over, without a provider error", async () => {
		const clock = new FakeClock();
		const http = new FakeHttp().on("POST", G.tokenUrl, res(428, { error: "authorization_pending" }));
		const e = await failure(pollForToken(http, { provider: "gdrive", clientId: "c", clientSecret: "s" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 12_000, interval: 5 }, clock, {}));
		expect(e.reason).toBe("expired");
		expect(http.calls.length).toBe(2);
	});

	it("keeps polling through a few network failures and 5xx, then gives up", async () => {
		const clock = new FakeClock();
		const ok = new FakeHttp().once("POST", G.tokenUrl, new Error("offline")).once("POST", G.tokenUrl, res(503, "")).once("POST", G.tokenUrl, res(200, TOKENS));
		await expect(pollForToken(ok, { provider: "gdrive", clientId: "c", clientSecret: "s" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 5 }, clock, {})).resolves.toMatchObject({ refreshToken: "rt-1" });
		const down = new FakeHttp().on("POST", G.tokenUrl, new Error("offline"));
		expect((await failure(pollForToken(down, { provider: "gdrive", clientId: "c", clientSecret: "s" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 5 }, clock, {}))).reason).toBe("network");
	});

	it("cancel aborts the wait and reports cancelled", async () => {
		const ac = new AbortController();
		const clock = new FakeClock();
		const http = new FakeHttp().on("POST", G.tokenUrl, () => {
			ac.abort();
			return res(428, { error: "authorization_pending" });
		});
		const e = await failure(pollForToken(http, { provider: "gdrive", clientId: "c", clientSecret: "s" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 5 }, clock, { signal: ac.signal }));
		expect(e.reason).toBe("cancelled");
		expect(http.calls.length).toBe(1);
	});

	it("refuses a device code answer without a https verification address, and maps a refused client", async () => {
		const clock = new FakeClock();
		expect((await failure(requestDeviceCode(new FakeHttp().on("POST", G.deviceUrl, res(200, { ...GOOGLE_CODE, verification_url: "http://evil" })), { provider: "gdrive", clientId: "c" }, clock))).reason).toBe("other");
		expect((await failure(requestDeviceCode(new FakeHttp().on("POST", G.deviceUrl, res(401, { error: "invalid_client" })), { provider: "gdrive", clientId: "c" }, clock))).reason).toBe("client");
		expect((await failure(requestDeviceCode(new FakeHttp().on("POST", G.deviceUrl, new Error("dns")), { provider: "gdrive", clientId: "c" }, clock))).reason).toBe("network");
	});

	it("a token answer without a refresh token is a failure (offline access missing)", async () => {
		const clock = new FakeClock();
		const http = new FakeHttp().on("POST", M.tokenUrl, res(200, { access_token: "a", expires_in: 3600 }));
		expect((await failure(pollForToken(http, { provider: "onedrive", clientId: "c" }, { deviceCode: "d", userCode: "u", verificationUrl: "https://x", expiresAt: clock.now() + 600_000, interval: 1 }, clock, {}))).reason).toBe("other");
	});
});

describe("connect an account", () => {
	it("Google: device flow, then finds or creates the sync folder, then the account", async () => {
		const http = new FakeHttp()
			.once("POST", G.deviceUrl, res(200, GOOGLE_CODE))
			.once("POST", G.tokenUrl, res(200, TOKENS))
			.once("GET", "https://www.googleapis.com/drive/v3/files?q=", res(200, { files: [] }))
			.once("GET", "https://www.googleapis.com/drive/v3/files/generateIds?", res(200, { ids: ["root-1"] }))
			.once("POST", "https://www.googleapis.com/drive/v3/files?fields=id", res(200, { id: "root-1" }))
			.once("GET", "https://www.googleapis.com/drive/v3/about", res(200, { user: { emailAddress: "me@example.com" } }));
		const done = await connectAccount(http, new FakeClock(), "gdrive", "  cid  ", ui(), { clientSecret: "sec" });
		expect(done.account).toBe("me@example.com");
		expect(done.auth).toMatchObject({ provider: "gdrive", clientId: "cid", clientSecret: "sec", rootId: "root-1", rootLabel: "My Drive/Notebook sync" });
		const created = bodyJson(http.find("POST", "https://www.googleapis.com/drive/v3/files?fields=id")[0]!);
		// Review W22 S4: the folder id is reserved first, so a retried create cannot make a second folder.
		expect(created).toMatchObject({ id: "root-1", name: "Notebook sync", mimeType: "application/vnd.google-apps.folder", parents: ["root"] });
		expect(http.find("GET", "https://www.googleapis.com/drive/v3/files?q=")[0]!.headers?.Authorization).toBe("Bearer at-1");
	});

	it("OneDrive: the sync folder is the app folder (special/approot), never a path in the whole drive", async () => {
		const http = new FakeHttp()
			.once("POST", M.deviceUrl, res(200, MS_CODE))
			.once("POST", M.tokenUrl, res(200, TOKENS))
			.once("GET", "https://graph.microsoft.com/v1.0/me/drive/special/approot?", res(200, { id: "F1", name: "Notebook", folder: {} }))
			.once("GET", "https://graph.microsoft.com/v1.0/me?", res(200, { userPrincipalName: "me@outlook.com" }));
		const done = await connectAccount(http, new FakeClock(), "onedrive", "11111111", ui());
		expect(done.auth).toMatchObject({ rootId: "F1", rootLabel: "OneDrive/Apps/Notebook" });
		expect(done.account).toBe("me@outlook.com");
		expect(http.calls.some((c) => c.url.includes("/root:/"))).toBe(false);
	});

	it("refuses an empty client id, and a Google sign-in without its secret, before any request", async () => {
		const http = new FakeHttp();
		expect((await failure(connectAccount(http, new FakeClock(), "onedrive", "   ", ui()))).reason).toBe("client");
		expect((await failure(connectAccount(http, new FakeClock(), "gdrive", "cid", ui()))).reason).toBe("client");
		expect(http.calls).toEqual([]);
		expect(cleanClientId(" a b ")).toBeNull();
	});
});
