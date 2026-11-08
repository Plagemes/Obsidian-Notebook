/**
 * OneDrive provider (#126), Microsoft Graph v1.0 with `Files.ReadWrite`: the sync root is a folder at the top of the
 * user's OneDrive ("Notebook sync"). Sources and limits: docs/research.md, docs/architecture.md.
 *
 * - Listing and deltas: `delta` on the root folder (pages via `@odata.nextLink`, the cursor is the `@odata.deltaLink`).
 *   Delta items carry parent ids, not paths, so paths come from the id index (tree.ts). Incremental calls send
 *   `deltaExcludeParent` so a folder in the feed means the folder itself changed. `410 Gone` starts a full listing.
 *   OneDrive for Business supports delta only on the drive root: when the folder delta is refused, the provider lists the
 *   drive root's delta and keeps what is under the sync folder.
 * - Upload: a simple PUT up to `chunkThreshold` (4 MiB), an upload session in 320 KiB-multiple fragments above it
 *   (the fragments go to the pre-authorised upload URL without the bearer token, as Graph requires).
 * - Conditional writes: `If-Match` with the eTag (412 → conflict); create-only uses `conflictBehavior=fail` (409).
 * - Remove: DELETE, which moves the item to the OneDrive recycle bin; never `permanentDelete`.
 */
import { RemoteConflictError, TransientRemoteError, type CloudProvider, type RemoteChanges, type RemoteEntry } from "../provider-types";
import { json, JSON_TYPE, num, obj, str, type HttpResponse } from "../auth/http";
import { throwIfAborted } from "../auth/retry";
import { RemoteHttpError, type ApiClient } from "./api";
import type { ChunkOptions } from "./gdrive";
import { joinPath, RootMissingError, splitPath, TreeIndex, type TreeItem } from "./tree";

export const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,lastModifiedDateTime,eTag,file,folder,deleted,parentReference,root";
const CURSOR = "od1:";
const BYTES = "application/octet-stream";
/** Upload session fragments must be multiples of 320 KiB. */
export const ONEDRIVE_CHUNK_UNIT = 320 * 1024;

const enc = encodeURIComponent;

type Item = Record<string, unknown>;

function entryOf(it: Item): Omit<RemoteEntry, "path"> {
	const hashes = obj(obj(it.file).hashes);
	const quick = str(hashes.quickXorHash);
	const sha1 = str(hashes.sha1Hash);
	const hash = quick ? { hash: quick, hashAlg: "quickXor" } : sha1 ? { hash: sha1.toLowerCase(), hashAlg: "sha1" } : {};
	return { id: str(it.id) ?? "", size: num(it.size) ?? 0, mtime: Date.parse(str(it.lastModifiedDateTime) ?? "") || 0, rev: str(it.eTag) ?? "", ...hash };
}

/** True for a link the connector may follow with the user's token: Graph itself, over HTTPS. */
export function isGraphUrl(url: string): boolean {
	return url.startsWith(`${GRAPH}/`);
}

/** Finds or creates the sync root at the top of the user's OneDrive. */
export async function prepareOneDriveRoot(api: ApiClient, name: string, signal?: AbortSignal): Promise<{ rootId: string; rootLabel: string }> {
	const id = await childFolder(api, `${GRAPH}/me/drive/root`, name, signal);
	return { rootId: id, rootLabel: `OneDrive/${name}` };
}

/** The id of folder `name` under `parentUrl` (an item URL), creating it when missing. */
async function childFolder(api: ApiClient, parentUrl: string, name: string, signal?: AbortSignal): Promise<string> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const got = await api.send({ url: `${parentUrl}:/${enc(name)}?$select=id,name,folder`, method: "GET" }, signal);
		if (got.status === 200) {
			const it = obj(json(got));
			if (!it.folder) throw new RemoteConflictError(name);
			const id = str(it.id);
			if (id) return id;
		} else if (got.status !== 404) api.fail(got, "find folder");
		const made = await api.send({ url: `${parentUrl}/children`, method: "POST", contentType: JSON_TYPE, body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) }, signal);
		if (made.status === 201 || made.status === 200) {
			const id = str(obj(json(made)).id);
			if (id) return id;
		}
		// 409: another device made it meanwhile; read it again.
		if (made.status !== 409) api.fail(made, "create folder");
	}
	throw new TransientRemoteError(`Could not create the folder ${name}`);
}

export class OneDriveProvider implements CloudProvider {
	readonly id = "onedrive" as const;
	private readonly index: TreeIndex;
	private readonly folderIds = new Map<string, string>();
	private readonly threshold: number;
	private readonly chunk: number;
	/** True once the folder delta was refused (OneDrive for Business): list the drive root's delta instead. */
	private rootDelta = false;

	constructor(private readonly api: ApiClient, private readonly rootId: string, chunks: ChunkOptions = {}) {
		this.index = new TreeIndex(rootId);
		this.threshold = chunks.chunkThreshold ?? 4 * 1024 * 1024;
		this.chunk = Math.max(ONEDRIVE_CHUNK_UNIT, Math.floor((chunks.chunkSize ?? 16 * ONEDRIVE_CHUNK_UNIT) / ONEDRIVE_CHUNK_UNIT) * ONEDRIVE_CHUNK_UNIT);
	}

	async account(): Promise<string> {
		const res = await this.api.send({ url: `${GRAPH}/me?$select=userPrincipalName,mail,displayName`, method: "GET" });
		if (res.status !== 200) this.api.fail(res, "account");
		const me = obj(json(res));
		return str(me.mail) ?? str(me.userPrincipalName) ?? str(me.displayName) ?? "OneDrive";
	}

	async changes(cursor: string | undefined, signal?: AbortSignal): Promise<RemoteChanges> {
		const link = cursor?.startsWith(CURSOR) ? cursor.slice(CURSOR.length) : "";
		if (!link || !isGraphUrl(link)) return this.full(signal);
		const pages = await this.pages(link, true, signal);
		if (!pages) return this.full(signal);
		const items = pages.items.map((it) => this.itemOf(it)).filter((x): x is TreeItem => !!x);
		const d = await this.index.applyDelta(items, (id) => this.lookupFolder(id, signal));
		if (d.needFull) return this.full(signal);
		return { upserts: d.upserts, deletions: d.deletions, cursor: CURSOR + pages.deltaLink, full: false };
	}

	/** Follows `@odata.nextLink` to the `@odata.deltaLink`. Null on `410 Gone` (the token is no longer valid). */
	private async pages(start: string, excludeParent: boolean, signal?: AbortSignal): Promise<{ items: Item[]; deltaLink: string } | null> {
		const items: Item[] = [];
		let url = start;
		for (let guard = 0; guard < 100_000; guard++) {
			throwIfAborted(signal);
			const res = await this.api.send({ url, method: "GET", headers: excludeParent ? { deltaExcludeParent: "true" } : {} }, signal);
			if (res.status === 410) return null;
			if (res.status !== 200) this.api.fail(res, "delta");
			const body = obj(json(res));
			for (const it of Array.isArray(body.value) ? body.value : []) items.push(obj(it));
			const next = str(body["@odata.nextLink"]);
			const delta = str(body["@odata.deltaLink"]);
			if (next && isGraphUrl(next)) {
				url = next;
				continue;
			}
			if (delta && isGraphUrl(delta)) return { items, deltaLink: delta };
			throw new TransientRemoteError("OneDrive delta ended without a delta link");
		}
		throw new TransientRemoteError("OneDrive delta did not end");
	}

	private itemOf(it: Item): TreeItem | null {
		const id = str(it.id);
		if (!id) return null;
		const removed = it.deleted !== undefined && it.deleted !== null;
		const folder = !!it.folder || !!it.root || (removed && !it.file && (this.index.folders.has(id) || id === this.rootId));
		if (!folder && !it.file && !removed) return null; // packages (OneNote notebooks) and other non-files
		return { id, folder, removed, name: str(it.name), parent: str(obj(it.parentReference).id), entry: folder || removed ? undefined : entryOf(it) };
	}

	private async lookupFolder(id: string, signal?: AbortSignal): Promise<{ name: string; parent?: string } | null> {
		const res = await this.api.send({ url: `${GRAPH}/me/drive/items/${enc(id)}?$select=id,name,folder,deleted,root,parentReference`, method: "GET" }, signal);
		if (res.status === 404) return null;
		if (res.status !== 200) this.api.fail(res, "folder");
		const it = obj(json(res));
		if (it.deleted || !it.folder || it.root) return null;
		return { name: str(it.name) ?? "", parent: str(obj(it.parentReference).id) };
	}

	private async full(signal?: AbortSignal): Promise<RemoteChanges> {
		const root = await this.api.send({ url: `${GRAPH}/me/drive/items/${enc(this.rootId)}?$select=id,deleted,folder`, method: "GET" }, signal);
		if (root.status === 404 || (root.status === 200 && obj(json(root)).deleted)) throw new RootMissingError();
		if (root.status !== 200) this.api.fail(root, "sync folder");
		let pages: { items: Item[]; deltaLink: string } | null = null;
		if (!this.rootDelta) {
			try {
				pages = await this.pages(`${GRAPH}/me/drive/items/${enc(this.rootId)}/delta?$select=${SELECT}`, false, signal);
			} catch (e) {
				// OneDrive for Business: delta only on the drive root.
				if (!(e instanceof RemoteHttpError && [400, 403, 501].includes(e.status))) throw e;
				this.rootDelta = true;
			}
		}
		if (this.rootDelta) pages = await this.pages(`${GRAPH}/me/drive/root/delta?$select=${SELECT}`, false, signal);
		if (!pages) throw new TransientRemoteError("OneDrive refused a fresh delta listing");
		this.folderIds.clear();
		const items = pages.items.map((it) => this.itemOf(it)).filter((x): x is TreeItem => !!x);
		const upserts = this.index.buildFull(items);
		return { upserts, deletions: [], cursor: CURSOR + pages.deltaLink, full: true };
	}

	async download(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
		const meta = await this.api.send({ url: `${GRAPH}/me/drive/items/${enc(id)}?$select=id,@microsoft.graph.downloadUrl`, method: "GET" }, signal);
		if (meta.status === 404) throw new RemoteConflictError(this.index.files.get(id) ?? id);
		if (meta.status !== 200) this.api.fail(meta, "download");
		const url = str(obj(json(meta))["@microsoft.graph.downloadUrl"]);
		if (!url || !url.startsWith("https://")) throw new TransientRemoteError("OneDrive gave no download address");
		// A pre-authenticated, short-lived address: no bearer token.
		const res = await this.api.send({ url, method: "GET" }, signal, false);
		if (res.status === 404) throw new RemoteConflictError(this.index.files.get(id) ?? id);
		if (res.status !== 200) this.api.fail(res, "download");
		return res.arrayBuffer;
	}

	async upload(path: string, data: ArrayBuffer, ifRev: string | null | undefined, signal?: AbortSignal): Promise<RemoteEntry> {
		const parts = splitPath(path);
		const name = parts.pop() as string;
		const parent = await this.ensureFolder(parts, signal);
		const target = `${GRAPH}/me/drive/items/${enc(parent)}:/${enc(name)}`;
		if (typeof ifRev === "string") {
			// If-Match does the check on the server; this read only turns "no such file" into a conflict.
			const got = await this.api.send({ url: `${target}?$select=id,eTag,file`, method: "GET" }, signal);
			if (got.status === 404) throw new RemoteConflictError(path);
			if (got.status !== 200) this.api.fail(got, "upload");
			const current = str(obj(json(got)).eTag);
			if (current !== ifRev) throw new RemoteConflictError(path, current);
		}
		const behaviour = ifRev === null ? "fail" : "replace";
		const ifMatch: Record<string, string> = typeof ifRev === "string" ? { "If-Match": ifRev } : {};
		const item = data.byteLength > this.threshold
			? await this.session(target, behaviour, ifMatch, data, path, signal)
			: await this.simple(target, behaviour, ifMatch, data, path, signal);
		if (!item.file) throw new RemoteConflictError(path);
		const entry = { ...entryOf(item), path };
		this.index.noteFile(entry.id, path);
		return entry;
	}

	private async simple(target: string, behaviour: string, ifMatch: Record<string, string>, data: ArrayBuffer, path: string, signal?: AbortSignal): Promise<Item> {
		const res = await this.api.send({ url: `${target}:/content?@microsoft.graph.conflictBehavior=${behaviour}`, method: "PUT", contentType: BYTES, headers: ifMatch, body: data }, signal);
		if (res.status === 200 || res.status === 201) return obj(json(res));
		throw this.conflictOr(res, path, "upload");
	}

	private conflictOr(res: HttpResponse, path: string, what: string): Error {
		if (res.status === 409 || res.status === 412) return new RemoteConflictError(path);
		this.api.fail(res, what);
	}

	/** An upload session: fragments of a 320 KiB multiple sent in order to the upload URL. */
	private async session(target: string, behaviour: string, ifMatch: Record<string, string>, data: ArrayBuffer, path: string, signal?: AbortSignal): Promise<Item> {
		const created = await this.api.send({ url: `${target}:/createUploadSession`, method: "POST", contentType: JSON_TYPE, headers: ifMatch, body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": behaviour } }) }, signal);
		if (created.status !== 200) throw this.conflictOr(created, path, "upload session");
		const uploadUrl = str(obj(json(created)).uploadUrl);
		if (!uploadUrl || !uploadUrl.startsWith("https://")) throw new TransientRemoteError("OneDrive gave no upload address");
		const total = data.byteLength;
		let offset = 0;
		let done = false;
		try {
			for (let guard = 0; guard < 100_000; guard++) {
				throwIfAborted(signal);
				const end = Math.min(offset + this.chunk, total);
				const res = await this.api.send({ url: uploadUrl, method: "PUT", contentType: BYTES, headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` }, body: data.slice(offset, end) }, signal, false);
				if (res.status === 200 || res.status === 201) {
					done = true;
					return obj(json(res));
				}
				if (res.status === 202 || res.status === 416) {
					const next = res.status === 202 ? nextExpected(res) : await this.sessionStatus(uploadUrl, signal);
					offset = next ?? end;
					continue;
				}
				if (res.status === 404) {
					done = true;
					throw new TransientRemoteError("OneDrive upload session expired");
				}
				throw this.conflictOr(res, path, "upload fragment");
			}
			throw new TransientRemoteError("OneDrive upload did not finish");
		} finally {
			// A session left behind holds the bytes until it expires: cancel it (best effort, never fails the caller).
			if (!done) await this.api.send({ url: uploadUrl, method: "DELETE" }, undefined, false).catch(() => undefined);
		}
	}

	private async sessionStatus(uploadUrl: string, signal?: AbortSignal): Promise<number | undefined> {
		const res = await this.api.send({ url: uploadUrl, method: "GET" }, signal, false);
		return res.status === 200 ? nextExpected(res) : undefined;
	}

	async remove(id: string, ifRev?: string, signal?: AbortSignal): Promise<void> {
		const res = await this.api.send({ url: `${GRAPH}/me/drive/items/${enc(id)}`, method: "DELETE", headers: ifRev !== undefined ? { "If-Match": ifRev } : {} }, signal);
		if (res.status === 204 || res.status === 200 || res.status === 404) {
			this.index.noteFile(id, undefined);
			return;
		}
		if (res.status === 412) throw new RemoteConflictError(this.index.files.get(id) ?? id);
		this.api.fail(res, "remove");
	}

	private async ensureFolder(parts: string[], signal?: AbortSignal): Promise<string> {
		let parent = this.rootId;
		let path = "";
		for (const seg of parts) {
			path = joinPath(path, seg);
			const cached = this.folderIds.get(path);
			if (cached) {
				parent = cached;
				continue;
			}
			const id = await childFolder(this.api, `${GRAPH}/me/drive/items/${enc(parent)}`, seg, signal);
			this.index.noteFolder(id, seg, parent);
			this.folderIds.set(path, id);
			parent = id;
		}
		return parent;
	}
}

/** The first byte of `nextExpectedRanges` in an upload session answer. */
export function nextExpected(res: HttpResponse): number | undefined {
	const ranges = obj(json(res)).nextExpectedRanges;
	const first = Array.isArray(ranges) ? str(ranges[0]) : undefined;
	const m = first ? /^(\d+)-/.exec(first) : null;
	return m ? Number(m[1]) : undefined;
}

