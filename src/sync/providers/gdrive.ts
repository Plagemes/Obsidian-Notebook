/**
 * Google Drive provider (#126), Drive API v3 with the `drive.file` scope (the only Drive scope the device flow allows
 * besides `drive.appdata`): the sync root is a folder the plugin created ("Notebook sync" in My Drive), and the plugin
 * sees only what it created there. Sources and limits: docs/research.md, docs/architecture.md.
 *
 * - Listing: a breadth-first walk of the root; deltas: the changes feed (`changes.list` from a start page token), with
 *   paths computed by walking parents inside the root (tree.ts).
 * - Upload: multipart up to `chunkThreshold` (4 MiB), resumable in 256 KiB-multiple chunks above it.
 * - Conditional writes: Drive v3 has no If-Match for files, so `ifRev` is checked by reading the file's metadata just
 *   before the write. Review W22 S3: a write by another device between that read and our write (a window as long as a
 *   resumable upload) is caught afterwards: the file's revision list must show `ifRev` right before our new head; any
 *   revision in between is downloaded and returned as `displaced`, and the engine keeps it as a conflicted copy.
 * - Creation is idempotent (review W22 S4): the id comes from `files.generateIds` first, so a retried POST whose first answer
 *   was lost gets 409 (the file is already there) instead of making a second file with the same name.
 * - Remove: `trashed: true` (the Drive trash, 30 days), never a permanent delete; a trash that raced with another device's
 *   write is undone and reported as a conflict.
 * - The bearer token goes only to www.googleapis.com (the resumable session address is checked, review W22 S15).
 */
import { RemoteConflictError, TransientRemoteError, type CloudProvider, type DisplacedRevision, type RemoteChanges, type RemoteEntry, type UploadedEntry } from "../provider-types";
import { header, json, JSON_TYPE, num, obj, str, type HttpResponse } from "../auth/http";
import { throwIfAborted } from "../auth/retry";
import type { ApiClient } from "./api";
import { joinPath, RootMissingError, splitPath, TreeIndex, type TreeItem } from "./tree";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,parents,size,modifiedTime,md5Checksum,headRevisionId,trashed";
const CURSOR = "gd1:";
const BYTES = "application/octet-stream";

export interface ChunkOptions {
	/** Files above this many bytes go up in chunks (default 4 MiB). */
	chunkThreshold?: number;
	/** Bytes per chunk; rounded down to the provider's multiple (default 8 MiB on Drive, 5 MiB on OneDrive). */
	chunkSize?: number;
}

/** Drive's resumable chunks must be multiples of 256 KiB. */
export const DRIVE_CHUNK_UNIT = 256 * 1024;

const enc = encodeURIComponent;

/** A Drive query string literal. */
function q(s: string): string {
	return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

type DriveFile = Record<string, unknown>;

function revOf(f: DriveFile): string {
	return str(f.headRevisionId) ?? str(f.md5Checksum) ?? str(f.modifiedTime) ?? "";
}

function entryOf(f: DriveFile): Omit<RemoteEntry, "path"> {
	const hash = str(f.md5Checksum);
	return { id: str(f.id) ?? "", size: num(f.size) ?? 0, mtime: Date.parse(str(f.modifiedTime) ?? "") || 0, rev: revOf(f), ...(hash ? { hash, hashAlg: "md5" } : {}) };
}

function isNative(f: DriveFile): boolean {
	const m = str(f.mimeType) ?? "";
	return m.startsWith("application/vnd.google-apps.") && m !== DRIVE_FOLDER;
}

/** A random multipart boundary. */
function boundary(): string {
	let s = "nb";
	for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
	return s;
}

/** A `multipart/related` body: the JSON metadata, then the bytes (Drive's multipart upload). */
export function multipartBody(meta: Record<string, unknown>, data: ArrayBuffer, b = boundary()): { body: ArrayBuffer; contentType: string } {
	const te = new TextEncoder();
	const head = te.encode(`--${b}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${BYTES}\r\n\r\n`);
	const tail = te.encode(`\r\n--${b}--`);
	const out = new Uint8Array(head.length + data.byteLength + tail.length);
	out.set(head, 0);
	out.set(new Uint8Array(data), head.length);
	out.set(tail, head.length + data.byteLength);
	return { body: out.buffer, contentType: `multipart/related; boundary=${b}` };
}

/** True for an address the bearer token may go to: Drive's own API host, over HTTPS (review W22 S15). */
export function isDriveUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && u.host === "www.googleapis.com";
	} catch {
		return false;
	}
}

/** A file id reserved with `files.generateIds` (review W22 S4: a retried create then gets 409 instead of a twin). */
async function generateId(api: ApiClient, signal?: AbortSignal): Promise<string> {
	const res = await api.send({ url: `${API}/files/generateIds?count=1&space=drive&type=files&fields=ids`, method: "GET" }, signal);
	if (res.status !== 200) api.fail(res, "generate id");
	const ids = obj(json(res)).ids;
	const id = Array.isArray(ids) ? str(ids[0]) : undefined;
	if (!id) throw new TransientRemoteError("Drive gave no file id");
	return id;
}

/**
 * Creates a folder with a reserved id; a 409 means an earlier attempt of this same request already made it (its answer was
 * lost), so the folder is there.
 */
async function createFolder(api: ApiClient, meta: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const id = await generateId(api, signal);
	const made = await api.send({ url: `${API}/files?fields=id`, method: "POST", contentType: JSON_TYPE, body: JSON.stringify({ ...meta, id, mimeType: DRIVE_FOLDER }) }, signal);
	if (made.status === 409) return id;
	const got = made.status === 200 ? str(obj(json(made)).id) : undefined;
	if (!got) api.fail(made, "create folder");
	return got;
}

/** Finds or creates the sync root in My Drive. */
export async function prepareDriveRoot(api: ApiClient, name: string, signal?: AbortSignal): Promise<{ rootId: string; rootLabel: string }> {
	const query = `name=${q(name)} and 'root' in parents and mimeType=${q(DRIVE_FOLDER)} and trashed=false`;
	const found = await api.send({ url: `${API}/files?q=${enc(query)}&orderBy=createdTime&pageSize=10&spaces=drive&fields=${enc("files(id,name)")}`, method: "GET" }, signal);
	if (found.status !== 200) api.fail(found, "find sync folder");
	const files = obj(json(found)).files;
	const first = Array.isArray(files) ? str(obj(files[0]).id) : undefined;
	if (first) return { rootId: first, rootLabel: `My Drive/${name}` };
	const id = await createFolder(api, { name, parents: ["root"], appProperties: { notebookSyncRoot: "1" } }, signal);
	return { rootId: id, rootLabel: `My Drive/${name}` };
}

export class GoogleDriveProvider implements CloudProvider {
	readonly id = "gdrive" as const;
	private readonly index: TreeIndex;
	/** Folder path → id, for uploads (cleared on every full listing). */
	private readonly folderIds = new Map<string, string>();
	private readonly threshold: number;
	private readonly chunk: number;

	constructor(private readonly api: ApiClient, private readonly rootId: string, chunks: ChunkOptions = {}) {
		this.index = new TreeIndex(rootId);
		this.threshold = chunks.chunkThreshold ?? 4 * 1024 * 1024;
		this.chunk = Math.max(DRIVE_CHUNK_UNIT, Math.floor((chunks.chunkSize ?? 8 * 1024 * 1024) / DRIVE_CHUNK_UNIT) * DRIVE_CHUNK_UNIT);
	}

	async account(): Promise<string> {
		const res = await this.api.send({ url: `${API}/about?fields=${enc("user(displayName,emailAddress)")}`, method: "GET" });
		if (res.status !== 200) this.api.fail(res, "account");
		const user = obj(obj(json(res)).user);
		return str(user.emailAddress) ?? str(user.displayName) ?? "Google Drive";
	}

	async changes(cursor: string | undefined, signal?: AbortSignal): Promise<RemoteChanges> {
		const token = cursor?.startsWith(CURSOR) ? cursor.slice(CURSOR.length) : "";
		if (!token) return this.full(signal);
		const items: TreeItem[] = [];
		let page = token;
		let next = "";
		const fields = `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FIELDS}))`;
		for (;;) {
			const res = await this.api.send({ url: `${API}/changes?pageToken=${enc(page)}&pageSize=1000&includeRemoved=true&restrictToMyDrive=true&spaces=drive&fields=${enc(fields)}`, method: "GET" }, signal);
			// An unknown or expired page token: start again from a full listing.
			if (res.status === 400 || res.status === 404 || res.status === 410) return this.full(signal);
			if (res.status !== 200) this.api.fail(res, "changes");
			const body = obj(json(res));
			for (const c of Array.isArray(body.changes) ? body.changes : []) {
				const ch = obj(c);
				if (str(ch.changeType) && str(ch.changeType) !== "file") continue;
				const item = this.itemOfChange(ch);
				if (item) items.push(item);
			}
			const more = str(body.nextPageToken);
			if (more) {
				page = more;
				continue;
			}
			next = str(body.newStartPageToken) ?? "";
			break;
		}
		if (!next) throw new TransientRemoteError("Drive changes feed ended without a new start token");
		const d = await this.index.applyDelta(items, (id) => this.lookupFolder(id, signal));
		if (d.needFull) return this.full(signal);
		return { upserts: d.upserts, deletions: d.deletions, cursor: CURSOR + next, full: false };
	}

	private itemOfChange(ch: Record<string, unknown>): TreeItem | null {
		const id = str(ch.fileId) ?? str(obj(ch.file).id);
		if (!id) return null;
		const f = ch.file === undefined ? null : obj(ch.file);
		if (ch.removed === true || !f) return { id, removed: true, folder: this.index.folders.has(id) || id === this.rootId };
		return this.itemOfFile(f);
	}

	private itemOfFile(f: DriveFile, parent?: string): TreeItem | null {
		const id = str(f.id);
		if (!id || isNative(f)) return null;
		const folder = str(f.mimeType) === DRIVE_FOLDER;
		const parents = Array.isArray(f.parents) ? f.parents.filter((p): p is string => typeof p === "string") : [];
		return { id, folder, removed: f.trashed === true, name: str(f.name), parent: parent ?? parents[0], entry: folder ? undefined : entryOf(f) };
	}

	private async lookupFolder(id: string, signal?: AbortSignal): Promise<{ name: string; parent?: string } | null> {
		const res = await this.api.send({ url: `${API}/files/${enc(id)}?fields=${enc("id,name,parents,trashed,mimeType")}`, method: "GET" }, signal);
		if (res.status === 404) return null;
		if (res.status !== 200) this.api.fail(res, "folder");
		const f = obj(json(res));
		if (f.trashed === true || str(f.mimeType) !== DRIVE_FOLDER) return null;
		const parents = Array.isArray(f.parents) ? f.parents : [];
		return { name: str(f.name) ?? "", parent: str(parents[0]) };
	}

	/** Every file under the root, breadth first; the start token is taken before the walk so nothing written meanwhile is missed. */
	private async full(signal?: AbortSignal): Promise<RemoteChanges> {
		const startRes = await this.api.send({ url: `${API}/changes/startPageToken?fields=startPageToken`, method: "GET" }, signal);
		if (startRes.status !== 200) this.api.fail(startRes, "start token");
		const start = str(obj(json(startRes)).startPageToken);
		if (!start) throw new TransientRemoteError("Drive gave no start page token");
		const root = await this.api.send({ url: `${API}/files/${enc(this.rootId)}?fields=${enc("id,trashed,mimeType")}`, method: "GET" }, signal);
		if (root.status === 404 || (root.status === 200 && obj(json(root)).trashed === true)) throw new RootMissingError();
		if (root.status !== 200) this.api.fail(root, "sync folder");
		const items: TreeItem[] = [];
		const queue = [this.rootId];
		while (queue.length) {
			const folder = queue.shift() as string;
			let page: string | undefined;
			do {
				throwIfAborted(signal);
				const query = `${q(folder)} in parents and trashed=false`;
				const res = await this.api.send({ url: `${API}/files?q=${enc(query)}&pageSize=1000&spaces=drive&fields=${enc(`nextPageToken,files(${FIELDS})`)}${page ? `&pageToken=${enc(page)}` : ""}`, method: "GET" }, signal);
				if (res.status !== 200) this.api.fail(res, "list");
				const body = obj(json(res));
				for (const f of Array.isArray(body.files) ? body.files : []) {
					const item = this.itemOfFile(obj(f), folder);
					if (!item) continue;
					items.push(item);
					if (item.folder && !item.removed) queue.push(item.id);
				}
				page = str(body.nextPageToken);
			} while (page);
		}
		this.folderIds.clear();
		const upserts = this.index.buildFull(items);
		return { upserts, deletions: [], cursor: CURSOR + start, full: true };
	}

	async download(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
		const res = await this.api.send({ url: `${API}/files/${enc(id)}?alt=media`, method: "GET" }, signal);
		if (res.status === 404) throw new RemoteConflictError(this.index.files.get(id) ?? id);
		if (res.status !== 200) this.api.fail(res, "download");
		return res.arrayBuffer;
	}

	async upload(path: string, data: ArrayBuffer, ifRev: string | null | undefined, signal?: AbortSignal): Promise<UploadedEntry> {
		const parts = splitPath(path);
		const name = parts.pop() as string;
		const parent = await this.ensureFolder(parts, signal);
		const existing = await this.findFile(parent, name, ifRev, signal);
		const current = existing ? revOf(existing) : undefined;
		if (ifRev === null && existing) throw new RemoteConflictError(path, current);
		if (typeof ifRev === "string" && current !== ifRev) throw new RemoteConflictError(path, current);
		const id = existing ? str(existing.id) : undefined;
		let file: DriveFile;
		if (id) {
			file = data.byteLength > this.threshold ? await this.resumable(id, false, {}, data, signal) : await this.multipart(id, false, {}, data, signal);
		} else {
			// Review W22 S4: the id is reserved first, so a retried create cannot make a second file with this name.
			const newId = await generateId(this.api, signal);
			const meta = { id: newId, name, parents: [parent] };
			file = data.byteLength > this.threshold ? await this.resumable(newId, true, meta, data, signal) : await this.multipart(newId, true, meta, data, signal);
		}
		const entry: UploadedEntry = { ...entryOf(file), path };
		this.index.noteFile(entry.id, path, entryOf(file));
		// Review W22 S3: did another device write between our check and our write? Only a binary file with a revision id can say.
		if (id && typeof ifRev === "string" && str(existing?.headRevisionId) === ifRev) {
			const displaced = await this.displaced(id, ifRev, str(file.headRevisionId), signal);
			if (displaced.length > 0) entry.displaced = displaced;
		}
		return entry;
	}

	/**
	 * Review W22 S3: the revisions written between `base` (the revision we checked) and `head` (the one our write made), oldest
	 * first, with their bytes. Drive lists revisions without a stated order, so they are sorted by time. When `base` is not
	 * listed, the revision right before ours counts as written in between (a conflicted copy too many, never one too few).
	 */
	private async displaced(id: string, base: string, head: string | undefined, signal?: AbortSignal): Promise<DisplacedRevision[]> {
		if (!head || head === base) return [];
		const revs: { id: string; at: number; n: number }[] = [];
		let page: string | undefined;
		do {
			const res = await this.api.send({ url: `${API}/files/${enc(id)}/revisions?pageSize=1000&fields=${enc("nextPageToken,revisions(id,modifiedTime)")}${page ? `&pageToken=${enc(page)}` : ""}`, method: "GET" }, signal);
			if (res.status !== 200) this.api.fail(res, "revisions");
			const body = obj(json(res));
			for (const r of Array.isArray(body.revisions) ? body.revisions : []) {
				const rid = str(obj(r).id);
				if (rid) revs.push({ id: rid, at: Date.parse(str(obj(r).modifiedTime) ?? "") || 0, n: revs.length });
			}
			page = str(body.nextPageToken);
		} while (page);
		revs.sort((a, b) => a.at - b.at || a.n - b.n);
		const h = revs.findIndex((r) => r.id === head);
		// Our revision is not listed (a later write already replaced it): the next listing shows that write as a change.
		if (h <= 0) return [];
		const b = revs.findIndex((r) => r.id === base);
		const between = b >= 0 && b < h ? revs.slice(b + 1, h) : b >= 0 ? [] : [revs[h - 1]!];
		const out: DisplacedRevision[] = [];
		for (const r of between) {
			const res = await this.api.send({ url: `${API}/files/${enc(id)}/revisions/${enc(r.id)}?alt=media`, method: "GET" }, signal);
			if (res.status !== 200) this.api.fail(res, "download revision");
			out.push({ rev: r.id, data: res.arrayBuffer });
		}
		return out;
	}

	/** The file as it is after a create that answered 409 (an earlier attempt with the same reserved id made it). */
	private async created(id: string, signal?: AbortSignal): Promise<DriveFile> {
		const res = await this.api.send({ url: `${API}/files/${enc(id)}?fields=${enc(FIELDS)}`, method: "GET" }, signal);
		if (res.status !== 200) this.api.fail(res, "upload");
		return obj(json(res));
	}

	private async multipart(id: string, create: boolean, meta: Record<string, unknown>, data: ArrayBuffer, signal?: AbortSignal): Promise<DriveFile> {
		const { body, contentType } = multipartBody(meta, data);
		const res = await this.api.send({ url: `${UPLOAD}/files${create ? "" : `/${enc(id)}`}?uploadType=multipart&fields=${enc(FIELDS)}`, method: create ? "POST" : "PATCH", contentType, body }, signal);
		if (create && res.status === 409) return this.created(id, signal);
		if (res.status !== 200 && res.status !== 201) this.api.fail(res, "upload");
		return obj(json(res));
	}

	/** Resumable upload: a session, then chunks of a 256 KiB multiple; `308` answers carry the bytes received so far. */
	private async resumable(id: string, create: boolean, meta: Record<string, unknown>, data: ArrayBuffer, signal?: AbortSignal): Promise<DriveFile> {
		const total = data.byteLength;
		const init = await this.api.send({
			url: `${UPLOAD}/files${create ? "" : `/${enc(id)}`}?uploadType=resumable&fields=${enc(FIELDS)}`,
			method: create ? "POST" : "PATCH",
			contentType: JSON_TYPE,
			headers: { "X-Upload-Content-Type": BYTES, "X-Upload-Content-Length": String(total) },
			body: JSON.stringify(meta),
		}, signal);
		if (create && init.status === 409) return this.created(id, signal);
		const session = init.status === 200 ? header(init, "location") : undefined;
		// Review W22 S15: the session address gets the bearer token, so it must be Drive's own host.
		if (!session || !isDriveUrl(session)) this.api.fail(init, "upload session");
		let offset = 0;
		for (let guard = 0; guard < 100_000; guard++) {
			throwIfAborted(signal);
			const end = Math.min(offset + this.chunk, total);
			const res = await this.api.send({ url: session, method: "PUT", contentType: BYTES, headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` }, body: data.slice(offset, end) }, signal);
			if (res.status === 200 || res.status === 201) return obj(json(res));
			if (create && res.status === 409) return this.created(id, signal);
			if (res.status === 308) {
				offset = receivedUpTo(res);
				continue;
			}
			if (res.status === 404 || res.status === 410) throw new TransientRemoteError("Drive upload session expired");
			this.api.fail(res, "upload chunk");
		}
		throw new TransientRemoteError("Drive upload did not finish");
	}

	async remove(id: string, ifRev?: string, signal?: AbortSignal): Promise<void> {
		const res = await this.api.send({ url: `${API}/files/${enc(id)}?fields=${enc(FIELDS)}`, method: "GET" }, signal);
		if (res.status === 404) {
			this.index.noteFile(id, undefined);
			return;
		}
		if (res.status !== 200) this.api.fail(res, "remove");
		const f = obj(json(res));
		if (f.trashed === true) return;
		const path = this.index.files.get(id) ?? str(f.name) ?? id;
		if (ifRev !== undefined && revOf(f) !== ifRev) throw new RemoteConflictError(path, revOf(f));
		const trash = await this.api.send({ url: `${API}/files/${enc(id)}?fields=${enc(FIELDS)}`, method: "PATCH", contentType: JSON_TYPE, body: JSON.stringify({ trashed: true }) }, signal);
		if (trash.status !== 200 && trash.status !== 404) this.api.fail(trash, "trash");
		// Another device wrote between the check and the trash: take it out of the trash again and let the engine plan anew.
		const after = trash.status === 200 ? obj(json(trash)) : {};
		if (ifRev !== undefined && trash.status === 200 && (str(after.headRevisionId) ?? str(after.md5Checksum)) !== undefined && revOf(after) !== ifRev) {
			const back = await this.api.send({ url: `${API}/files/${enc(id)}?fields=id`, method: "PATCH", contentType: JSON_TYPE, body: JSON.stringify({ trashed: false }) }, signal);
			if (back.status !== 200) this.api.fail(back, "untrash");
			throw new RemoteConflictError(path, revOf(after));
		}
		this.index.noteFile(id, undefined);
	}

	/** The id of the folder at `parts` under the root, creating the missing ones. */
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
			const query = `name=${q(seg)} and ${q(parent)} in parents and mimeType=${q(DRIVE_FOLDER)} and trashed=false`;
			const res = await this.api.send({ url: `${API}/files?q=${enc(query)}&orderBy=createdTime&pageSize=10&spaces=drive&fields=${enc("files(id)")}`, method: "GET" }, signal);
			if (res.status !== 200) this.api.fail(res, "find folder");
			const files = obj(json(res)).files;
			let id = Array.isArray(files) ? str(obj(files[0]).id) : undefined;
			if (!id) id = await createFolder(this.api, { name: seg, parents: [parent] }, signal);
			this.index.noteFolder(id, seg, parent);
			this.folderIds.set(path, id);
			parent = id;
		}
		return parent;
	}

	/**
	 * The file named `name` in folder `parent`, if any. With two files of that name (Drive allows it), the one on revision `ifRev`
	 * (the one the engine follows), else the newest.
	 */
	private async findFile(parent: string, name: string, ifRev: string | null | undefined, signal?: AbortSignal): Promise<DriveFile | undefined> {
		const query = `name=${q(name)} and ${q(parent)} in parents and mimeType!=${q(DRIVE_FOLDER)} and trashed=false`;
		const res = await this.api.send({ url: `${API}/files?q=${enc(query)}&pageSize=10&spaces=drive&fields=${enc(`files(${FIELDS})`)}`, method: "GET" }, signal);
		if (res.status !== 200) this.api.fail(res, "find file");
		const files = obj(json(res)).files;
		const list = (Array.isArray(files) ? files : []).map(obj).filter((f) => !isNative(f));
		const followed = typeof ifRev === "string" ? list.find((f) => revOf(f) === ifRev) : undefined;
		if (followed) return followed;
		list.sort((a, b) => (Date.parse(str(b.modifiedTime) ?? "") || 0) - (Date.parse(str(a.modifiedTime) ?? "") || 0));
		return list[0];
	}
}

/** The next byte to send after a `308`: one past the end of its `Range: bytes=0-N`, or 0 when nothing was received. */
export function receivedUpTo(res: HttpResponse): number {
	const m = /bytes=\d+-(\d+)/.exec(header(res, "range") ?? "");
	return m ? Number(m[1]) + 1 : 0;
}
