// #126 cloud connector: the Google Drive provider against a scripted Drive API (no network).
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../src/sync/auth/http";
import { createProvider } from "../src/sync/providers";
import { DRIVE_CHUNK_UNIT, multipartBody } from "../src/sync/providers/gdrive";
import { RootMissingError } from "../src/sync/providers/tree";
import { RemoteConflictError, TransientRemoteError } from "../src/sync/provider-types";
import { bodyJson, bytes, FakeClock, FakeHttp, res } from "./sync-fake-http";

const API = "https://www.googleapis.com/drive/v3";
const UP = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T10:05:00.000Z";
const T2 = "2026-11-01T10:10:00.000Z";
/** `files.generateIds` (review W22 S4). */
const GEN = `${API}/files/generateIds?`;

function provider(http: FakeHttp, chunks: { chunkThreshold?: number; chunkSize?: number } = {}) {
	const clock = new FakeClock();
	return createProvider({ provider: "gdrive", clientId: "c", clientSecret: "s", refreshToken: "r", accessToken: "AT", expiresAt: clock.now() + 3_600_000, rootId: "ROOT" }, http, { clock, tuning: { tries: 2 }, ...chunks });
}

const q = (req: HttpRequest): string => new URL(req.url).searchParams.get("q") ?? "";
const param = (req: HttpRequest, k: string): string | null => new URL(req.url).searchParams.get(k);
const listOf = (folder: string, page?: string) => (req: HttpRequest) => req.url.startsWith(`${API}/files?`) && q(req) === `'${folder}' in parents and trashed=false` && param(req, "pageToken") === (page ?? null);

function file(id: string, name: string, parent: string, extra: Record<string, unknown> = {}) {
	return { id, name, mimeType: "application/octet-stream", parents: [parent], size: "10", modifiedTime: T0, md5Checksum: `md5-${id}`, headRevisionId: `rev-${id}`, ...extra };
}
function folder(id: string, name: string, parent: string) {
	return { id, name, mimeType: FOLDER, parents: [parent] };
}

/** Drive with root ROOT holding x.notebook, y.md and folder A (FA) with z.png. */
function fullListing(http: FakeHttp, token = "100"): FakeHttp {
	return http
		.once("GET", `${API}/changes/startPageToken`, res(200, { startPageToken: token }))
		.once("GET", `${API}/files/ROOT?`, res(200, { id: "ROOT", mimeType: FOLDER, trashed: false }))
		.once("GET", listOf("ROOT"), res(200, { files: [folder("FA", "A", "ROOT"), file("x", "x.notebook", "ROOT")], nextPageToken: "p2" }))
		.once("GET", listOf("ROOT", "p2"), res(200, { files: [file("y", "y.md", "ROOT"), { id: "doc", name: "Doc", mimeType: "application/vnd.google-apps.document", parents: ["ROOT"] }] }))
		.once("GET", listOf("FA"), res(200, { files: [file("z", "z.png", "FA")] }));
}

describe("Google Drive: listing and changes", () => {
	it("a full listing walks the root breadth first with pagination, skipping Google Docs", async () => {
		const p = provider(fullListing(new FakeHttp()));
		const all = await p.changes(undefined);
		expect(all.full).toBe(true);
		expect(all.cursor).toBe("gd1:100");
		expect(all.deletions).toEqual([]);
		expect(all.upserts.map((e) => e.path).sort()).toEqual(["A/z.png", "x.notebook", "y.md"]);
		expect(all.upserts.find((e) => e.path === "x.notebook")).toEqual({ id: "x", path: "x.notebook", size: 10, mtime: Date.parse(T0), rev: "rev-x", hash: "md5-x", hashAlg: "md5" });
	});

	it("a delta: updates, deletions, a move out of the root, a new file in a subfolder, across pages", async () => {
		const http = fullListing(new FakeHttp())
			.once("GET", (r) => r.url.startsWith(`${API}/changes?`) && param(r, "pageToken") === "100", res(200, {
				nextPageToken: "101",
				changes: [
					{ changeType: "file", fileId: "x", file: file("x", "x.notebook", "ROOT", { headRevisionId: "rev-x2", modifiedTime: "2026-11-02T10:00:00.000Z" }) },
					{ changeType: "file", fileId: "y", removed: true },
					{ changeType: "file", fileId: "z", file: file("z", "z.png", "OUT") },
				],
			}))
			.once("GET", (r) => r.url.startsWith(`${API}/changes?`) && param(r, "pageToken") === "101", res(200, {
				newStartPageToken: "102",
				changes: [{ changeType: "file", fileId: "w", file: file("w", "w.md", "FA") }, { changeType: "drive", driveId: "shared" }],
			}))
			.once("GET", `${API}/files/OUT?`, res(200, { id: "OUT", name: "Elsewhere", mimeType: FOLDER, parents: ["MYDRIVE"] }))
			.once("GET", `${API}/files/MYDRIVE?`, res(200, { id: "MYDRIVE", name: "My Drive", mimeType: FOLDER }));
		const p = provider(http);
		await p.changes(undefined);
		const d = await p.changes("gd1:100");
		expect(d.full).toBe(false);
		expect(d.cursor).toBe("gd1:102");
		expect(d.upserts.map((e) => [e.path, e.rev]).sort()).toEqual([["A/w.md", "rev-w"], ["x.notebook", "rev-x2"]]);
		expect(d.deletions.sort()).toEqual(["A/z.png", "y.md"]);
		expect(param(http.find("GET", `${API}/changes?`)[0]!, "includeRemoved")).toBe("true");
	});

	it("a move inside the root is a deletion of the old path and an upsert of the new one; a trashed file is a deletion", async () => {
		const http = fullListing(new FakeHttp()).once("GET", `${API}/changes?`, res(200, {
			newStartPageToken: "101",
			changes: [
				{ fileId: "x", file: file("x", "x.notebook", "FA") },
				{ fileId: "z", file: file("z", "z.png", "FA", { trashed: true }) },
			],
		}));
		const p = provider(http);
		await p.changes(undefined);
		const d = await p.changes("gd1:100");
		expect(d.upserts.map((e) => e.path)).toEqual(["A/x.notebook"]);
		expect(d.deletions.sort()).toEqual(["A/z.png", "x.notebook"]);
	});

	it("a renamed folder inside the root, or the first delta after a restart, falls back to a full listing", async () => {
		const http = fullListing(new FakeHttp())
			.once("GET", `${API}/changes?`, res(200, { newStartPageToken: "101", changes: [{ fileId: "FA", file: folder("FA", "B", "ROOT") }] }));
		fullListing(http, "200");
		const p = provider(http);
		await p.changes(undefined);
		const d = await p.changes("gd1:100");
		expect(d.full).toBe(true);
		expect(d.cursor).toBe("gd1:200");

		const fresh = new FakeHttp().once("GET", `${API}/changes?`, res(200, { newStartPageToken: "101", changes: [{ fileId: "x", file: file("x", "x.notebook", "ROOT") }] }));
		fullListing(fresh, "300");
		const d2 = await provider(fresh).changes("gd1:100");
		expect(d2.full).toBe(true);
		expect(d2.cursor).toBe("gd1:300");
	});

	it("a delta with no changes needs no listing, even right after a restart", async () => {
		const http = new FakeHttp().once("GET", `${API}/changes?`, res(200, { newStartPageToken: "100", changes: [] }));
		expect(await provider(http).changes("gd1:100")).toEqual({ upserts: [], deletions: [], cursor: "gd1:100", full: false });
	});

	it("an unknown page token starts again from a full listing; a foreign cursor too", async () => {
		const http = new FakeHttp().once("GET", `${API}/changes?`, res(404, { error: { errors: [{ reason: "notFound" }] } }));
		fullListing(http, "500");
		expect((await provider(http).changes("gd1:old")).cursor).toBe("gd1:500");
		expect((await provider(fullListing(new FakeHttp(), "600")).changes("od1:https://graph.microsoft.com/v1.0/x")).cursor).toBe("gd1:600");
	});

	it("a trashed or deleted sync folder stops the listing (nothing is reported deleted)", async () => {
		const http = new FakeHttp()
			.once("GET", `${API}/changes/startPageToken`, res(200, { startPageToken: "1" }))
			.once("GET", `${API}/files/ROOT?`, res(200, { id: "ROOT", trashed: true }));
		await expect(provider(http).changes(undefined)).rejects.toBeInstanceOf(RootMissingError);
		const http2 = fullListing(new FakeHttp()).once("GET", `${API}/changes?`, res(200, { newStartPageToken: "2", changes: [{ fileId: "ROOT", removed: true }] }));
		const p = provider(http2);
		await p.changes(undefined);
		const e = await p.changes("gd1:100").catch((x: unknown) => x);
		expect(e).toBeInstanceOf(RootMissingError);
		expect(e).toBeInstanceOf(TransientRemoteError);
	});
});

describe("Google Drive: upload, download, remove", () => {
	const findFolder = (name: string, parent: string) => (r: HttpRequest) => r.url.startsWith(`${API}/files?`) && q(r) === `name='${name}' and '${parent}' in parents and mimeType='${FOLDER}' and trashed=false`;
	const findFile = (name: string, parent: string) => (r: HttpRequest) => r.url.startsWith(`${API}/files?`) && q(r).startsWith(`name='${name}' and '${parent}' in parents and mimeType!=`);

	it("creates missing folders and a new file (multipart, metadata first)", async () => {
		const http = new FakeHttp()
			.once("GET", findFolder("A", "ROOT"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["FA"] }))
			.once("POST", `${API}/files?fields=id`, res(200, { id: "FA" }))
			.once("GET", findFile("it\\'s.md", "FA"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["n1"] }))
			.once("POST", `${UP}/files?uploadType=multipart`, res(200, file("n1", "it's.md", "FA", { size: "3" })));
		const e = await provider(http).upload("A/it's.md", bytes(3, 65), null);
		expect(e).toMatchObject({ id: "n1", path: "A/it's.md", size: 3, rev: "rev-n1", hash: "md5-n1", hashAlg: "md5" });
		expect(q(http.calls[3]!)).toContain("name='it\\'s.md'");
		const up = http.find("POST", `${UP}/files?uploadType=multipart`)[0]!;
		expect(up.contentType).toMatch(/^multipart\/related; boundary=/);
		const text = new TextDecoder().decode(up.body as ArrayBuffer);
		expect(text).toContain(JSON.stringify({ id: "n1", name: "it's.md", parents: ["FA"] }));
		expect(text).toContain("AAA");
		expect(text.indexOf("parents")).toBeLessThan(text.indexOf("AAA"));
		expect(bodyJson(http.find("POST", `${API}/files?fields=id`)[0]!)).toMatchObject({ id: "FA", name: "A", mimeType: FOLDER, parents: ["ROOT"] });
		expect(param(http.find("GET", GEN)[0]!, "space")).toBe("drive");
	});

	it("create-only refuses an existing file; replace checks the revision first", async () => {
		const existing = res(200, { files: [file("x", "x.notebook", "ROOT")] });
		const h1 = new FakeHttp().on("GET", findFile("x.notebook", "ROOT"), existing);
		await expect(provider(h1).upload("x.notebook", bytes(1), null)).rejects.toMatchObject({ name: "RemoteConflictError", currentRev: "rev-x" });
		expect(h1.calls.some((c) => c.url.startsWith(UP))).toBe(false);

		const h2 = new FakeHttp().on("GET", findFile("x.notebook", "ROOT"), existing);
		await expect(provider(h2).upload("x.notebook", bytes(1), "rev-old")).rejects.toBeInstanceOf(RemoteConflictError);

		const h3 = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), existing)
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-x2" })))
			.once("GET", `${API}/files/x/revisions?`, res(200, { revisions: [{ id: "rev-x", modifiedTime: T0 }, { id: "rev-x2", modifiedTime: T1 }] }));
		const replaced = await provider(h3).upload("x.notebook", bytes(1), "rev-x");
		expect(replaced.rev).toBe("rev-x2");
		expect(replaced.displaced).toBeUndefined();
		const text = new TextDecoder().decode(h3.find("PATCH", UP)[0]!.body as ArrayBuffer);
		expect(text).toContain("\r\n{}\r\n");

		const h4 = new FakeHttp().on("GET", findFile("gone.md", "ROOT"), res(200, { files: [] }));
		await expect(provider(h4).upload("gone.md", bytes(1), "rev-1")).rejects.toBeInstanceOf(RemoteConflictError);
	});

	it("files above the threshold go up in resumable chunks of 256 KiB multiples, following 308 ranges", async () => {
		const total = 600 * 1024;
		const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=S1";
		const http = new FakeHttp()
			.once("GET", findFile("big.pdf", "ROOT"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["B"] }))
			.once("POST", `${UP}/files?uploadType=resumable`, res(200, "", { Location: session }))
			.once("PUT", session, res(308, "", { Range: "bytes=0-262143" }))
			.once("PUT", session, res(308, "", { range: "bytes=0-524287" }))
			.once("PUT", session, res(200, file("B", "big.pdf", "ROOT", { size: String(total) })));
		const e = await provider(http, { chunkThreshold: 1024, chunkSize: 300 * 1024 }).upload("big.pdf", bytes(total), undefined);
		expect(e.size).toBe(total);
		const init = http.find("POST", `${UP}/files?uploadType=resumable`)[0]!;
		expect(init.headers).toMatchObject({ "X-Upload-Content-Length": String(total) });
		expect(bodyJson(init)).toEqual({ id: "B", name: "big.pdf", parents: ["ROOT"] });
		const puts = http.find("PUT", session);
		expect(puts.map((p) => p.headers?.["Content-Range"])).toEqual([`bytes 0-262143/${total}`, `bytes 262144-524287/${total}`, `bytes 524288-${total - 1}/${total}`]);
		expect(puts.slice(0, -1).every((p) => (p.body as ArrayBuffer).byteLength % DRIVE_CHUNK_UNIT === 0)).toBe(true);
	});

	it("an expired upload session is transient", async () => {
		const session = "https://www.googleapis.com/upload/drive/v3/files?upload_id=S2";
		const http = new FakeHttp()
			.once("GET", findFile("big.pdf", "ROOT"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["B"] }))
			.once("POST", `${UP}/files?uploadType=resumable`, res(200, "", { location: session }))
			.once("PUT", session, res(404, ""));
		await expect(provider(http, { chunkThreshold: 10 }).upload("big.pdf", bytes(100), undefined)).rejects.toBeInstanceOf(TransientRemoteError);
	});

	it("remove moves to the trash (never DELETE), checks the revision, and is quiet when already gone", async () => {
		const http = new FakeHttp()
			.once("GET", `${API}/files/x?`, res(200, file("x", "x.notebook", "ROOT")))
			.once("PATCH", `${API}/files/x?`, res(200, { id: "x" }));
		await provider(http).remove("x", "rev-x");
		expect(bodyJson(http.find("PATCH", `${API}/files/x?`)[0]!)).toEqual({ trashed: true });

		const h2 = new FakeHttp().once("GET", `${API}/files/x?`, res(200, file("x", "x.notebook", "ROOT")));
		await expect(provider(h2).remove("x", "rev-old")).rejects.toBeInstanceOf(RemoteConflictError);
		expect(h2.find("PATCH", API)).toEqual([]);

		const h3 = new FakeHttp().once("GET", `${API}/files/x?`, res(404, ""));
		await provider(h3).remove("x");
		expect([...http.calls, ...h2.calls, ...h3.calls].some((c) => c.method === "DELETE")).toBe(false);
	});

	it("download returns the bytes; a vanished file is a conflict", async () => {
		const http = new FakeHttp().once("GET", `${API}/files/x?alt=media`, res(200, bytes(4, 9))).once("GET", `${API}/files/y?alt=media`, res(404, ""));
		const p = provider(http);
		expect(new Uint8Array(await p.download("x"))).toEqual(new Uint8Array([9, 9, 9, 9]));
		await expect(p.download("y")).rejects.toBeInstanceOf(RemoteConflictError);
	});

	it("the multipart body is metadata then bytes, closed by the boundary", () => {
		const { body, contentType } = multipartBody({ name: "a" }, bytes(2, 66), "BOUND");
		expect(contentType).toBe("multipart/related; boundary=BOUND");
		expect(new TextDecoder().decode(body)).toBe('--BOUND\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a"}\r\n--BOUND\r\nContent-Type: application/octet-stream\r\n\r\nBB\r\n--BOUND--');
	});

	it("an invalid path is refused before any request", async () => {
		const http = new FakeHttp();
		await expect(provider(http).upload("../x", bytes(1), undefined)).rejects.toThrow(/Invalid sync path/);
		await expect(provider(http).upload("/x", bytes(1), undefined)).rejects.toThrow(/Invalid sync path/);
		expect(http.calls).toEqual([]);
	});
});

describe("Google Drive: review W22 fixes", () => {
	const findFile = (name: string, parent: string) => (r: HttpRequest) => r.url.startsWith(`${API}/files?`) && q(r).startsWith(`name='${name}' and '${parent}' in parents and mimeType!=`);

	it("S4: a create retried after a lost answer gets 409 and returns the file the first attempt made (no twin)", async () => {
		const http = new FakeHttp()
			.once("GET", findFile("n.md", "ROOT"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["N1"] }))
			.once("POST", `${UP}/files?uploadType=multipart`, res(409, { error: { code: 409 } }))
			.once("GET", `${API}/files/N1?fields=`, res(200, file("N1", "n.md", "ROOT")));
		const e = await provider(http).upload("n.md", bytes(2), null);
		expect(e).toMatchObject({ id: "N1", path: "n.md", rev: "rev-N1" });
		expect(http.find("POST", UP)).toHaveLength(1);
	});

	it("S4: a folder create that answers 409 uses the reserved id", async () => {
		const http = new FakeHttp()
			.once("GET", (r) => r.url.startsWith(`${API}/files?`) && q(r).startsWith("name='A'"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["FA"] }))
			.once("POST", `${API}/files?fields=id`, res(409, {}))
			.once("GET", findFile("z.md", "FA"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["Z"] }))
			.once("POST", `${UP}/files?uploadType=multipart`, res(200, file("Z", "z.md", "FA")));
		expect((await provider(http).upload("A/z.md", bytes(1), null)).id).toBe("Z");
	});

	it("S4: with two files of one name, a replace picks the one with the expected revision", async () => {
		const twins = res(200, { files: [file("x2", "x.notebook", "ROOT"), file("x", "x.notebook", "ROOT")] });
		const http = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), twins)
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-x2" })))
			.once("GET", `${API}/files/x/revisions?`, res(200, { revisions: [{ id: "rev-x", modifiedTime: T0 }, { id: "rev-x2", modifiedTime: T1 }] }));
		expect((await provider(http).upload("x.notebook", bytes(1), "rev-x")).id).toBe("x");
		expect(http.find("PATCH", `${UP}/files/x2`)).toEqual([]);
	});

	it("S3: a write that landed on top of another device's write returns the displaced revision's bytes", async () => {
		const http = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), res(200, { files: [file("x", "x.notebook", "ROOT")] }))
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-mine" })))
			// Listed out of order on two pages: sorted by time, "rev-other" sits between the checked revision and ours.
			.once("GET", (r) => r.url.startsWith(`${API}/files/x/revisions?`) && param(r, "pageToken") === null, res(200, { revisions: [{ id: "rev-mine", modifiedTime: T2 }, { id: "rev-x", modifiedTime: T0 }], nextPageToken: "p2" }))
			.once("GET", (r) => r.url.startsWith(`${API}/files/x/revisions?`) && param(r, "pageToken") === "p2", res(200, { revisions: [{ id: "rev-other", modifiedTime: T1 }] }))
			.once("GET", `${API}/files/x/revisions/rev-other?alt=media`, res(200, bytes(3, 7)));
		const e = await provider(http).upload("x.notebook", bytes(1), "rev-x");
		expect(e.rev).toBe("rev-mine");
		expect(e.displaced?.map((d) => d.rev)).toEqual(["rev-other"]);
		expect(new Uint8Array(e.displaced![0]!.data!)).toEqual(new Uint8Array([7, 7, 7]));
	});

	it("S3: when the checked revision is no longer listed, the one right before ours counts as displaced", async () => {
		const http = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), res(200, { files: [file("x", "x.notebook", "ROOT")] }))
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-mine" })))
			.once("GET", `${API}/files/x/revisions?`, res(200, { revisions: [{ id: "rev-other", modifiedTime: T1 }, { id: "rev-mine", modifiedTime: T2 }] }))
			.once("GET", `${API}/files/x/revisions/rev-other?alt=media`, res(200, bytes(1)));
		expect((await provider(http).upload("x.notebook", bytes(1), "rev-x")).displaced?.map((d) => d.rev)).toEqual(["rev-other"]);
	});

	it("S3: a trash that raced with another device's write is undone and reported as a conflict", async () => {
		const http = new FakeHttp()
			.once("GET", `${API}/files/x?`, res(200, file("x", "x.notebook", "ROOT")))
			.once("PATCH", `${API}/files/x?`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-new", trashed: true })))
			.once("PATCH", `${API}/files/x?`, res(200, { id: "x" }));
		await expect(provider(http).remove("x", "rev-x")).rejects.toMatchObject({ name: "RemoteConflictError", currentRev: "rev-new" });
		expect(http.find("PATCH", `${API}/files/x?`).map((c) => bodyJson(c))).toEqual([{ trashed: true }, { trashed: false }]);
	});

	it("R2-6: with two folders of one name, a replace finds the listed file by id in the other folder", async () => {
		const http = new FakeHttp()
			.once("GET", `${API}/changes/startPageToken`, res(200, { startPageToken: "100" }))
			.once("GET", `${API}/files/ROOT?`, res(200, { id: "ROOT", mimeType: FOLDER, trashed: false }))
			.once("GET", listOf("ROOT"), res(200, { files: [folder("FA1", "A", "ROOT"), folder("FA2", "A", "ROOT")] }))
			.once("GET", listOf("FA1"), res(200, { files: [] }))
			.once("GET", listOf("FA2"), res(200, { files: [file("x", "x.md", "FA2")] }))
			.on("GET", (r) => r.url.startsWith(`${API}/files?`) && q(r).startsWith("name='A'"), res(200, { files: [{ id: "FA1" }, { id: "FA2" }] }))
			.on("GET", findFile("x.md", "FA1"), res(200, { files: [] }))
			.once("GET", `${API}/files/x?fields=`, res(200, file("x", "x.md", "FA2")))
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.md", "FA2", { headRevisionId: "rev-x2" })))
			.once("GET", `${API}/files/x/revisions?`, res(200, { revisions: [{ id: "rev-x", modifiedTime: T0 }, { id: "rev-x2", modifiedTime: T1 }] }));
		const p = provider(http);
		expect((await p.changes(undefined)).upserts.map((e) => e.path)).toEqual(["A/x.md"]);
		const e = await p.upload("A/x.md", bytes(2), "rev-x");
		expect(e).toMatchObject({ id: "x", rev: "rev-x2" });
		expect(http.find("POST", UP)).toEqual([]);
	});

	it("R2-3: when the versions check after a write fails, the write still counts and the result says it could not be checked", async () => {
		const http = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), res(200, { files: [file("x", "x.notebook", "ROOT")] }))
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-mine" })))
			.on("GET", `${API}/files/x/revisions?`, res(403, { error: { code: 403 } }));
		const e = await provider(http).upload("x.notebook", bytes(1), "rev-x");
		expect(e).toMatchObject({ rev: "rev-mine", displacedUnknown: true });
		expect(e.displaced).toBeUndefined();
		expect(http.find("PATCH", UP)).toHaveLength(1);
	});

	it("R2-7: a displaced revision above the caller's cap is not downloaded (it stays in the version history)", async () => {
		const http = new FakeHttp()
			.on("GET", findFile("x.notebook", "ROOT"), res(200, { files: [file("x", "x.notebook", "ROOT")] }))
			.once("PATCH", `${UP}/files/x?uploadType=multipart`, res(200, file("x", "x.notebook", "ROOT", { headRevisionId: "rev-mine" })))
			.once("GET", `${API}/files/x/revisions?`, res(200, { revisions: [{ id: "rev-x", modifiedTime: T0, size: "5" }, { id: "rev-big", modifiedTime: T1, size: "900" }, { id: "rev-mine", modifiedTime: T2, size: "1" }] }));
		const e = await provider(http).upload("x.notebook", bytes(1), "rev-x", undefined, { maxBytes: 100 });
		expect(e.displaced).toEqual([{ rev: "rev-big", size: 900 }]);
		expect(http.find("GET", `${API}/files/x/revisions/`)).toEqual([]);
	});

	it("S15: an upload session on another host is refused before the bytes (and the token) are sent there", async () => {
		const http = new FakeHttp()
			.once("GET", findFile("big.pdf", "ROOT"), res(200, { files: [] }))
			.once("GET", GEN, res(200, { ids: ["B"] }))
			.on("POST", `${UP}/files?uploadType=resumable`, res(200, "", { Location: "https://evil.example.com/upload?id=1" }));
		await expect(provider(http, { chunkThreshold: 10 }).upload("big.pdf", bytes(100), undefined)).rejects.toThrow();
		expect(http.calls.some((c) => c.url.startsWith("https://evil.example.com"))).toBe(false);
	});
});
