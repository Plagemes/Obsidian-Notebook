// #126 cloud connector: the OneDrive provider against a scripted Microsoft Graph (no network).
import { describe, expect, it } from "vitest";
import { createProvider } from "../src/sync/providers";
import { GRAPH, isGraphUrl, ONEDRIVE_CHUNK_UNIT } from "../src/sync/providers/onedrive";
import { RootMissingError } from "../src/sync/providers/tree";
import { RemoteConflictError, TransientRemoteError } from "../src/sync/provider-types";
import { bodyJson, bytes, FakeClock, FakeHttp, res } from "./sync-fake-http";

const T0 = "2026-11-01T10:00:00Z";
const ITEMS = `${GRAPH}/me/drive/items`;
const D1 = `${ITEMS}/R/delta?token=D1`;
const D2 = `${ITEMS}/R/delta?token=D2`;

function provider(http: FakeHttp, chunks: { chunkThreshold?: number; chunkSize?: number } = {}) {
	const clock = new FakeClock();
	return createProvider({ provider: "onedrive", clientId: "c", refreshToken: "r", accessToken: "AT", expiresAt: clock.now() + 3_600_000, rootId: "R" }, http, { clock, tuning: { tries: 2 }, ...chunks });
}

function f(id: string, name: string, parent: string, extra: Record<string, unknown> = {}) {
	return { id, name, size: 10, eTag: `e-${id}`, lastModifiedDateTime: T0, file: { hashes: { quickXorHash: `qx-${id}` } }, parentReference: { id: parent }, ...extra };
}
function dir(id: string, name: string, parent: string) {
	return { id, name, folder: { childCount: 1 }, parentReference: { id: parent } };
}

/** The sync folder R holds x.notebook and folder A (FA) with z.png; a OneNote package is skipped. */
function fullListing(http: FakeHttp, link = D1): FakeHttp {
	return http
		.once("GET", `${ITEMS}/R?`, res(200, { id: "R", folder: {} }))
		.once("GET", `${ITEMS}/R/delta?$select=`, res(200, {
			value: [dir("R", "Notebook sync", "DRIVEROOT"), dir("FA", "A", "R"), f("x", "x.notebook", "R")],
			"@odata.nextLink": `${ITEMS}/R/delta?token=page2`,
		}))
		.once("GET", `${ITEMS}/R/delta?token=page2`, res(200, {
			value: [f("z", "z.png", "FA", { file: { hashes: { sha1Hash: "ABCDEF" } } }), { id: "pkg", name: "Notes", package: { type: "oneNote" }, parentReference: { id: "R" } }],
			"@odata.deltaLink": link,
		}));
}

describe("OneDrive: listing and delta", () => {
	it("a full listing follows nextLink to the deltaLink and builds paths from parent ids", async () => {
		const p = provider(fullListing(new FakeHttp()));
		const all = await p.changes(undefined);
		expect(all).toMatchObject({ full: true, deletions: [], cursor: `od1:${D1}` });
		expect(all.upserts.map((e) => e.path).sort()).toEqual(["A/z.png", "x.notebook"]);
		expect(all.upserts.find((e) => e.id === "x")).toEqual({ id: "x", path: "x.notebook", size: 10, mtime: Date.parse(T0), rev: "e-x", hash: "qx-x", hashAlg: "quickXor" });
		expect(all.upserts.find((e) => e.id === "z")).toMatchObject({ hash: "abcdef", hashAlg: "sha1" });
	});

	it("a delta: an update, a deletion, a new file, a move out of the root; parents excluded", async () => {
		const http = fullListing(new FakeHttp())
			.once("GET", D1, res(200, {
				value: [
					f("x", "x.notebook", "R", { eTag: "e-x2" }),
					{ id: "z", deleted: { state: "deleted" }, parentReference: { id: "FA" } },
					f("w", "w.md", "FA"),
					f("v", "v.md", "R"),
					f("v", "v.md", "OUT"),
				],
				"@odata.deltaLink": D2,
			}))
			.once("GET", `${ITEMS}/OUT?`, res(200, { id: "OUT", name: "Documents", folder: {}, parentReference: { id: "DRIVEROOT" } }))
			.once("GET", `${ITEMS}/DRIVEROOT?`, res(200, { id: "DRIVEROOT", name: "root", folder: {}, root: {} }));
		const p = provider(http);
		await p.changes(undefined);
		const d = await p.changes(`od1:${D1}`);
		expect(d.full).toBe(false);
		expect(d.cursor).toBe(`od1:${D2}`);
		expect(d.upserts.map((e) => [e.path, e.rev]).sort()).toEqual([["A/w.md", "e-w"], ["x.notebook", "e-x2"]]);
		expect(d.deletions).toEqual(["A/z.png"]);
		expect(http.find("GET", D1)[0]!.headers).toMatchObject({ deltaExcludeParent: "true" });
	});

	it("a file moved out of the root after it was listed is a deletion", async () => {
		const http = fullListing(new FakeHttp())
			.once("GET", D1, res(200, { value: [f("x", "x.notebook", "OUT")], "@odata.deltaLink": D2 }))
			.once("GET", `${ITEMS}/OUT?`, res(404, { error: { code: "itemNotFound" } }));
		const p = provider(http);
		await p.changes(undefined);
		expect(await p.changes(`od1:${D1}`)).toEqual({ upserts: [], deletions: ["x.notebook"], cursor: `od1:${D2}`, full: false });
	});

	it("410 Gone, a renamed folder, or a delta right after a restart start a full listing", async () => {
		const gone = fullListing(new FakeHttp()).once("GET", D1, res(410, { error: { code: "resyncRequired" } }));
		fullListing(gone, `${ITEMS}/R/delta?token=D9`);
		const p = provider(gone);
		await p.changes(undefined);
		expect(await p.changes(`od1:${D1}`)).toMatchObject({ full: true, cursor: `od1:${ITEMS}/R/delta?token=D9` });

		const renamed = fullListing(new FakeHttp()).once("GET", D1, res(200, { value: [dir("FA", "B", "R")], "@odata.deltaLink": D2 }));
		fullListing(renamed, `${ITEMS}/R/delta?token=D8`);
		const p2 = provider(renamed);
		await p2.changes(undefined);
		expect((await p2.changes(`od1:${D1}`)).full).toBe(true);

		const fresh = new FakeHttp().once("GET", D1, res(200, { value: [f("x", "x.notebook", "R")], "@odata.deltaLink": D2 }));
		fullListing(fresh);
		expect((await provider(fresh).changes(`od1:${D1}`)).full).toBe(true);
	});

	it("never follows a cursor or a next link off Graph with the token", async () => {
		const http = fullListing(new FakeHttp());
		await provider(http).changes("od1:https://evil.example/delta");
		expect(http.calls.some((c) => c.url.includes("evil"))).toBe(false);
		expect(isGraphUrl("https://graph.microsoft.com/v1.0.evil.example/x")).toBe(false);
	});

	it("OneDrive for Business: when the folder delta is refused, lists the drive root's delta and keeps the sync folder", async () => {
		const rootLink = `${GRAPH}/me/drive/root/delta?token=B1`;
		const http = new FakeHttp()
			.once("GET", `${ITEMS}/R?`, res(200, { id: "R", folder: {} }))
			.once("GET", `${ITEMS}/R/delta?$select=`, res(400, { error: { code: "invalidRequest", message: "Delta is only supported on the root" } }))
			.once("GET", `${GRAPH}/me/drive/root/delta?$select=`, res(200, {
				value: [{ id: "DRIVEROOT", name: "root", folder: {}, root: {} }, f("o", "o.txt", "DRIVEROOT"), dir("R", "Notebook sync", "DRIVEROOT"), dir("OTHER", "Other", "DRIVEROOT"), f("x", "x.notebook", "R"), f("q", "q.md", "OTHER")],
				"@odata.deltaLink": rootLink,
			}));
		const all = await provider(http).changes(undefined);
		expect(all.upserts.map((e) => e.path)).toEqual(["x.notebook"]);
		expect(all.cursor).toBe(`od1:${rootLink}`);
	});

	it("a deleted sync folder stops the listing", async () => {
		await expect(provider(new FakeHttp().once("GET", `${ITEMS}/R?`, res(404, ""))).changes(undefined)).rejects.toBeInstanceOf(RootMissingError);
		const http = fullListing(new FakeHttp()).once("GET", D1, res(200, { value: [{ id: "R", deleted: {}, folder: {} }], "@odata.deltaLink": D2 }));
		const p = provider(http);
		await p.changes(undefined);
		await expect(p.changes(`od1:${D1}`)).rejects.toBeInstanceOf(RootMissingError);
	});
});

describe("OneDrive: upload, download, remove", () => {
	it("creates missing folders, then a new file with conflictBehavior=fail; 409 is a conflict", async () => {
		const http = new FakeHttp()
			.once("GET", `${ITEMS}/R:/A?`, res(404, { error: { code: "itemNotFound" } }))
			.once("POST", `${ITEMS}/R/children`, res(201, { id: "FA", name: "A", folder: {} }))
			.once("PUT", `${ITEMS}/FA:/z%20one.md:/content?@microsoft.graph.conflictBehavior=fail`, res(201, f("n1", "z one.md", "FA")));
		const p = provider(http);
		expect(await p.upload("A/z one.md", bytes(3), null)).toMatchObject({ id: "n1", path: "A/z one.md", rev: "e-n1", hashAlg: "quickXor" });
		expect(bodyJson(http.find("POST", `${ITEMS}/R/children`)[0]!)).toEqual({ name: "A", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
		expect(http.find("PUT", ITEMS)[0]!.headers?.["If-Match"]).toBeUndefined();

		const h2 = new FakeHttp().once("PUT", `${ITEMS}/R:/x.notebook:/content?@microsoft.graph.conflictBehavior=fail`, res(409, { error: { code: "nameAlreadyExists" } }));
		await expect(provider(h2).upload("x.notebook", bytes(3), null)).rejects.toBeInstanceOf(RemoteConflictError);
	});

	it("replace with ifRev sends If-Match; 412 or a changed eTag is a conflict", async () => {
		const h1 = new FakeHttp()
			.once("GET", `${ITEMS}/R:/x.notebook?`, res(200, { id: "x", eTag: "e-x", file: {} }))
			.once("PUT", `${ITEMS}/R:/x.notebook:/content?@microsoft.graph.conflictBehavior=replace`, res(412, { error: { code: "preconditionFailed" } }));
		await expect(provider(h1).upload("x.notebook", bytes(3), "e-x")).rejects.toBeInstanceOf(RemoteConflictError);
		expect(h1.find("PUT", ITEMS)[0]!.headers).toMatchObject({ "If-Match": "e-x" });

		const h2 = new FakeHttp().once("GET", `${ITEMS}/R:/x.notebook?`, res(200, { id: "x", eTag: "e-new", file: {} }));
		await expect(provider(h2).upload("x.notebook", bytes(3), "e-x")).rejects.toMatchObject({ name: "RemoteConflictError", currentRev: "e-new" });
		expect(h2.find("PUT", ITEMS)).toEqual([]);

		const h3 = new FakeHttp().once("GET", `${ITEMS}/R:/x.notebook?`, res(404, ""));
		await expect(provider(h3).upload("x.notebook", bytes(3), "e-x")).rejects.toBeInstanceOf(RemoteConflictError);

		const h4 = new FakeHttp().once("PUT", `${ITEMS}/R:/x.notebook:/content?@microsoft.graph.conflictBehavior=replace`, res(200, f("x", "x.notebook", "R", { eTag: "e-x3" })));
		expect((await provider(h4).upload("x.notebook", bytes(3), undefined)).rev).toBe("e-x3");
	});

	it("large files use an upload session: 320 KiB-multiple fragments, no bearer token on the fragments", async () => {
		const total = 700 * 1024;
		const up = "https://my.microsoftpersonalcontent.com/up/S1";
		const http = new FakeHttp()
			.once("POST", `${ITEMS}/R:/big.pdf:/createUploadSession`, res(200, { uploadUrl: up, expirationDateTime: T0 }))
			.once("PUT", up, res(202, { nextExpectedRanges: ["327680-"] }))
			.once("PUT", up, res(202, { nextExpectedRanges: ["655360-716799"] }))
			.once("PUT", up, res(201, f("B", "big.pdf", "R", { size: total })));
		const e = await provider(http, { chunkThreshold: 1024, chunkSize: 400 * 1024 }).upload("big.pdf", bytes(total), null);
		expect(e.size).toBe(total);
		const create = http.find("POST", ITEMS)[0]!;
		expect(create.headers?.Authorization).toBe("Bearer AT");
		expect(bodyJson(create)).toEqual({ item: { "@microsoft.graph.conflictBehavior": "fail" } });
		const puts = http.find("PUT", up);
		expect(puts.every((p) => p.headers?.Authorization === undefined)).toBe(true);
		expect(puts.map((p) => p.headers?.["Content-Range"])).toEqual([`bytes 0-327679/${total}`, `bytes 327680-655359/${total}`, `bytes 655360-${total - 1}/${total}`]);
		expect(puts.slice(0, -1).every((p) => (p.body as ArrayBuffer).byteLength % ONEDRIVE_CHUNK_UNIT === 0)).toBe(true);
		expect(http.find("DELETE", up)).toEqual([]);
	});

	it("a conflict at the last fragment cancels the session; an expired session is transient", async () => {
		const up = "https://my.microsoftpersonalcontent.com/up/S2";
		const http = new FakeHttp()
			.once("POST", `${ITEMS}/R:/big.pdf:/createUploadSession`, res(200, { uploadUrl: up }))
			.once("PUT", up, res(409, { error: { code: "nameAlreadyExists" } }))
			.once("DELETE", up, res(204, ""));
		await expect(provider(http, { chunkThreshold: 10 }).upload("big.pdf", bytes(100), null)).rejects.toBeInstanceOf(RemoteConflictError);
		expect(http.find("DELETE", up).length).toBe(1);

		const h2 = new FakeHttp().once("POST", `${ITEMS}/R:/big.pdf:/createUploadSession`, res(200, { uploadUrl: up })).once("PUT", up, res(404, ""));
		await expect(provider(h2, { chunkThreshold: 10 }).upload("big.pdf", bytes(100), undefined)).rejects.toBeInstanceOf(TransientRemoteError);

		const h3 = new FakeHttp().once("POST", `${ITEMS}/R:/big.pdf:/createUploadSession`, res(412, ""));
		await expect(provider(h3, { chunkThreshold: 10 }).upload("big.pdf", bytes(100), undefined)).rejects.toBeInstanceOf(RemoteConflictError);
	});

	it("remove is a DELETE (the recycle bin) with If-Match; 412 is a conflict, 404 is done", async () => {
		const http = new FakeHttp().once("DELETE", `${ITEMS}/x`, res(204, "")).once("DELETE", `${ITEMS}/y`, res(412, "")).once("DELETE", `${ITEMS}/gone`, res(404, ""));
		const p = provider(http);
		await p.remove("x", "e-x");
		expect(http.calls[0]!.headers).toMatchObject({ "If-Match": "e-x" });
		await expect(p.remove("y", "e-y")).rejects.toBeInstanceOf(RemoteConflictError);
		await p.remove("gone");
		expect(http.calls.some((c) => c.url.includes("permanentDelete"))).toBe(false);
	});

	it("download reads the pre-authenticated address without the bearer token", async () => {
		const http = new FakeHttp()
			.once("GET", `${ITEMS}/x?`, res(200, { id: "x", "@microsoft.graph.downloadUrl": "https://public.dm.files.1drv.com/x" }))
			.once("GET", "https://public.dm.files.1drv.com/x", res(200, bytes(2, 5)))
			.once("GET", `${ITEMS}/y?`, res(404, ""));
		const p = provider(http);
		expect(new Uint8Array(await p.download("x"))).toEqual(new Uint8Array([5, 5]));
		expect(http.calls[1]!.headers?.Authorization).toBeUndefined();
		await expect(p.download("y")).rejects.toBeInstanceOf(RemoteConflictError);
	});

	it("account shows the e-mail; a provider without a root refuses file calls", async () => {
		const http = new FakeHttp().once("GET", `${GRAPH}/me?`, res(200, { displayName: "Ada", mail: "ada@example.com" }));
		const clock = new FakeClock();
		const p = createProvider({ provider: "onedrive", clientId: "c", refreshToken: "r", accessToken: "AT", expiresAt: clock.now() + 3_600_000 }, http, { clock });
		expect(await p.account()).toBe("ada@example.com");
		await expect(p.changes(undefined)).rejects.toMatchObject({ name: "NoRootError" });
	});
});
