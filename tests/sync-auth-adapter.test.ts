// #126 integration: the SyncAuthUI adapter over the providers' sign-in, with a fake local storage, fake sign-in and fake factory.
import { describe, expect, it } from "vitest";
import { createSyncAuthUI, type AuthAdapterDeps } from "../src/sync/auth-adapter";
import { CLOUD_ACCOUNT_KEY, cloudSecretKey } from "../src/sync/auth-ui";
import type { Connected } from "../src/sync/auth/connect";
import type { Http } from "../src/sync/auth/http";
import type { ProviderAuth } from "../src/sync/auth/oauth-config";
import { AUTH_KEY, clearAuth, loadAuth, type LocalStore } from "../src/sync/auth/token-store";
import type { ConnectedProvider, ProviderOptions } from "../src/sync/providers";
import { AuthRequiredError, type ProviderId } from "../src/sync/provider-types";

class FakeStore implements LocalStore {
	readonly map = new Map<string, unknown>();
	readonly writes: { key: string; value: unknown }[] = [];
	failWrites = false;
	loadLocalStorage(key: string): unknown {
		return this.map.get(key) ?? null;
	}
	saveLocalStorage(key: string, value: unknown): void {
		if (this.failWrites) throw new Error("quota");
		this.writes.push({ key, value });
		if (value === null) this.map.delete(key);
		else this.map.set(key, value);
	}
}

const HTTP = {} as Http;

const googleAuth = (extra: Partial<ProviderAuth> = {}): ProviderAuth => ({
	provider: "gdrive", clientId: "cid.apps.googleusercontent.com", clientSecret: "GOCSPX-secret", refreshToken: "refresh-1", accessToken: "access-1", expiresAt: 9e12,
	rootId: "ROOT", rootLabel: "My Drive/Notebook sync", ...extra,
});
const msAuth = (extra: Partial<ProviderAuth> = {}): ProviderAuth => ({ provider: "onedrive", clientId: "ms-app-id", refreshToken: "ms-refresh-1", rootId: "MSROOT", rootLabel: "Notebook sync", ...extra });

interface Harness {
	store: FakeStore;
	signInCalls: { provider: ProviderId; clientId: string; clientSecret?: string }[];
	created: { auth: ProviderAuth; opts: ProviderOptions }[];
	disconnects: ProviderAuth[];
	next: { result: Connected | null | Error };
	logs: string[];
	ui: ReturnType<typeof createSyncAuthUI>;
	deps: AuthAdapterDeps;
}

function harness(over: Partial<AuthAdapterDeps> = {}): Harness {
	const store = new FakeStore();
	const h: Harness = { store, signInCalls: [], created: [], disconnects: [], next: { result: null }, logs: [], ui: null as never, deps: null as never };
	const deps: AuthAdapterDeps = {
		store,
		http: () => HTTP,
		openSignIn: (o) => {
			h.signInCalls.push(o);
			const r = h.next.result;
			return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
		},
		disconnect: (s, auth) => {
			h.disconnects.push(auth);
			clearAuth(s);
			return Promise.resolve({ revoked: auth.provider === "gdrive", manageUrl: "https://manage.example" });
		},
		createProvider: (auth, _http, opts) => {
			h.created.push({ auth, opts });
			return { id: auth.provider } as unknown as ConnectedProvider;
		},
		rootText: (p, label) => (p === "gdrive" ? `${label} (made by the app)` : label),
		log: (m) => h.logs.push(m),
		...over,
	};
	h.deps = deps;
	h.ui = createSyncAuthUI(deps);
	return h;
}

/** Every value anything wrote to storage, as one searchable text (to prove what never lands where). */
const stored = (s: FakeStore): string => JSON.stringify([...s.map.entries()]);

describe("sync auth adapter: sign-in", () => {
	it("both providers are available; signed out until a sign-in is stored", () => {
		const h = harness();
		expect(h.ui.available("gdrive")).toBe(true);
		expect(h.ui.available("onedrive")).toBe(true);
		expect(h.ui.isSignedIn("gdrive")).toBe(false);
		expect(h.ui.accountLabel("gdrive")).toBeNull();
		expect(h.ui.rootLabel("gdrive")).toBeNull();
		expect(h.ui.rootId("gdrive")).toBeNull();
	});

	it("passes the user's client to the sign-in, stores the state and the account, and reports signed in", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "student@example.com" };
		expect(await h.ui.signIn("gdrive", { clientId: "cid.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" })).toBe(true);
		expect(h.signInCalls).toEqual([{ provider: "gdrive", clientId: "cid.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" }]);
		expect(h.ui.isSignedIn("gdrive")).toBe(true);
		expect(h.ui.isSignedIn("onedrive")).toBe(false);
		expect(h.ui.accountLabel("gdrive")).toBe("student@example.com");
		expect(h.ui.accountLabel("onedrive")).toBeNull();
		expect(h.ui.rootId("gdrive")).toBe("ROOT");
	});

	it("shows Google's root as the folder the app created, and OneDrive's as it is", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "s" });
		expect(h.ui.rootLabel("gdrive")).toBe("My Drive/Notebook sync (made by the app)");
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		expect(h.ui.rootLabel("onedrive")).toBe("Notebook sync");
		expect(h.signInCalls[1]).toEqual({ provider: "onedrive", clientId: "ms-app-id" });
	});

	it("a cancelled or failed sign-in stores nothing and returns false without throwing", async () => {
		const h = harness();
		h.next.result = null;
		expect(await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "s" })).toBe(false);
		h.next.result = new Error("network down");
		expect(await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "s" })).toBe(false);
		expect(h.store.writes).toEqual([]);
		expect(h.ui.isSignedIn("gdrive")).toBe(false);
		expect(h.logs.length).toBe(1);
	});

	it("a refused storage write is not reported as signed in", async () => {
		const h = harness();
		h.store.failWrites = true;
		h.next.result = { auth: msAuth(), account: "b" };
		expect(await h.ui.signIn("onedrive", { clientId: "ms-app-id" })).toBe(false);
		expect(h.ui.isSignedIn("onedrive")).toBe(false);
	});
});

describe("sync auth adapter: where secrets and tokens live", () => {
	it("keeps Google's client secret under its one key and out of the token blob", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		expect(h.store.map.get(cloudSecretKey("gdrive"))).toBe("GOCSPX-secret");
		const blob = String(h.store.map.get(AUTH_KEY));
		expect(blob).not.toContain("GOCSPX-secret");
		expect(blob).not.toContain("clientSecret");
		expect(blob).toContain("refresh-1");
		// The blob alone reads back without the secret; the adapter merges it in when it builds the provider.
		expect(loadAuth(h.store)?.clientSecret).toBeUndefined();
	});

	it("writes only the device-local keys of the cloud sync (nothing else is touched)", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		await h.ui.connect("gdrive");
		await h.ui.signOut("gdrive");
		const keys = new Set(h.store.writes.map((w) => w.key));
		expect([...keys].sort()).toEqual([AUTH_KEY, CLOUD_ACCOUNT_KEY, cloudSecretKey("gdrive")].sort());
	});

	it("the provider is built with the secret from its key, the stored tokens and the stored root", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		h.store.map.set(cloudSecretKey("gdrive"), "GOCSPX-edited"); // the user fixed the field in the settings
		const p = await h.ui.connect("gdrive");
		expect(p?.id).toBe("gdrive");
		expect(h.created).toHaveLength(1);
		expect(h.created[0]?.auth).toMatchObject({ provider: "gdrive", clientSecret: "GOCSPX-edited", refreshToken: "refresh-1", rootId: "ROOT" });
	});

	it("connect gives null when signed out, signed in to the other service, or without a cloud folder", async () => {
		const h = harness();
		expect(await h.ui.connect("gdrive")).toBeNull();
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		expect(await h.ui.connect("gdrive")).toBeNull();
		h.store.map.set(AUTH_KEY, JSON.stringify({ provider: "onedrive", clientId: "ms-app-id", refreshToken: "r" }));
		expect(await h.ui.connect("onedrive")).toBeNull();
		expect(h.created).toHaveLength(0);
	});

	it("a rotated refresh token is stored (and the secret still stays out of the blob)", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		await h.ui.connect("gdrive");
		h.created[0]!.opts.onAuthChange?.(googleAuth({ refreshToken: "refresh-2", accessToken: "access-2" }));
		const blob = String(h.store.map.get(AUTH_KEY));
		expect(blob).toContain("refresh-2");
		expect(blob).not.toContain("GOCSPX-secret");
	});

	it("a refresh that ends after Disconnect does not bring the sign-in back", async () => {
		const h = harness();
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		await h.ui.connect("onedrive");
		await h.ui.signOut("onedrive");
		h.created[0]!.opts.onAuthChange?.(msAuth({ refreshToken: "late" }));
		expect(h.ui.isSignedIn("onedrive")).toBe(false);
		expect(h.store.map.has(AUTH_KEY)).toBe(false);
	});

	it("no token, secret or account ever goes anywhere but local storage: the adapter has no other output", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "student@example.com" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		// The only channels are the injected store, the factory and the log; the log never carries a value.
		expect(h.logs.join(" ")).not.toMatch(/GOCSPX|refresh|access-1/);
		expect(stored(h.store)).toContain("refresh-1");
	});
});

describe("sync auth adapter: sign-out", () => {
	it("forgets the tokens and the account, tells whether the access was revoked, and keeps the typed secret for the next sign-in", async () => {
		const h = harness();
		h.next.result = { auth: googleAuth(), account: "a" };
		await h.ui.signIn("gdrive", { clientId: "c", clientSecret: "GOCSPX-secret" });
		const out = await h.ui.signOut("gdrive");
		expect(out).toEqual({ revoked: true, manageUrl: "https://manage.example" });
		expect(h.disconnects[0]).toMatchObject({ provider: "gdrive", refreshToken: "refresh-1", clientSecret: "GOCSPX-secret" });
		expect(h.ui.isSignedIn("gdrive")).toBe(false);
		expect(h.ui.accountLabel("gdrive")).toBeNull();
		expect(h.store.map.has(AUTH_KEY)).toBe(false);
		expect(h.store.map.get(cloudSecretKey("gdrive"))).toBe("GOCSPX-secret");
	});

	it("tells where to remove the access by hand when the provider cannot revoke (Microsoft)", async () => {
		const h = harness();
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		expect(await h.ui.signOut("onedrive")).toEqual({ revoked: false, manageUrl: "https://manage.example" });
	});

	it("a failing disconnect still deletes the local sign-in", async () => {
		const h = harness({ disconnect: () => Promise.reject(new Error("offline")) });
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		const out = await h.ui.signOut("onedrive");
		expect(out).toMatchObject({ revoked: false });
		expect(typeof (out as { manageUrl: string }).manageUrl).toBe("string");
		expect(h.ui.isSignedIn("onedrive")).toBe(false);
	});

	it("signing out of a service this device is not signed in to does nothing to the other sign-in", async () => {
		const h = harness();
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		expect(await h.ui.signOut("gdrive")).toBeUndefined();
		expect(h.ui.isSignedIn("onedrive")).toBe(true);
		expect(h.disconnects).toHaveLength(0);
	});
});

describe("sync auth adapter: lenient reads", () => {
	it("unreadable stored values count as signed out, never throw", async () => {
		const h = harness();
		h.store.map.set(AUTH_KEY, "{not json");
		h.store.map.set(CLOUD_ACCOUNT_KEY, "{also not");
		expect(h.ui.isSignedIn("gdrive")).toBe(false);
		expect(h.ui.accountLabel("gdrive")).toBeNull();
		expect(await h.ui.connect("gdrive")).toBeNull();
		const throwing: LocalStore = { loadLocalStorage: () => { throw new Error("blocked"); }, saveLocalStorage: () => { throw new Error("blocked"); } };
		const ui = createSyncAuthUI({ ...h.deps, store: throwing });
		expect(ui.isSignedIn("onedrive")).toBe(false);
		expect(ui.accountLabel("onedrive")).toBeNull();
	});

	it("an AuthRequiredError thrown by a provider is the engine's business: connect itself does not swallow factory errors", async () => {
		const h = harness({ createProvider: () => { throw new AuthRequiredError("onedrive"); } });
		h.next.result = { auth: msAuth(), account: "b" };
		await h.ui.signIn("onedrive", { clientId: "ms-app-id" });
		await expect(h.ui.connect("onedrive")).rejects.toThrow(AuthRequiredError);
	});
});
