/**
 * 0.22 (#126): an in-memory cloud provider and an in-memory vault for the sync engine tests. The provider keeps a change log
 * (cursor = sequence number), honours `ifRev` like the real ones, moves removed files to a trash and can be told to fail.
 */
import { LocalChangedError, type LocalFile, type LocalPort, type LocalStat, type StatePort, type SyncPorts } from "../src/sync/engine";
import { sha256Hex } from "../src/sync/hash";
import { RemoteConflictError, type CloudProvider, type ProviderId, type RemoteChanges, type RemoteEntry } from "../src/sync/provider-types";

const enc = new TextEncoder();
const dec = new TextDecoder();


interface RemoteFile {
	id: string;
	data: Uint8Array;
	rev: string;
	mtime: number;
}

export class FakeProvider implements CloudProvider {
	readonly id: ProviderId = "gdrive";
	readonly files = new Map<string, RemoteFile>();
	readonly trash: { path: string; data: string }[] = [];
	readonly calls: string[] = [];
	/** Errors thrown by the next calls (any method), in order. */
	readonly failures: Error[] = [];
	/** When set, `changes` with a cursor returns a full listing (a provider that lost the cursor). */
	alwaysFull = false;
	private seq = 0;
	private nextId = 1;
	private nextRev = 1;
	private readonly changeLog: { seq: number; path: string }[] = [];
	/** Called once before an upload is applied (to simulate another device writing at that moment). */
	beforeUpload: ((path: string) => void) | null = null;

	private fail(): void {
		const e = this.failures.shift();
		if (e) throw e;
	}

	private touch(path: string): void {
		this.changeLog.push({ seq: ++this.seq, path });
	}

	/** Another device writes `path`. */
	put(path: string, content: string): RemoteFile {
		const old = this.files.get(path);
		const f: RemoteFile = { id: old?.id ?? `id${this.nextId++}`, data: enc.encode(content), rev: `r${this.nextRev++}`, mtime: 1000 + this.seq };
		this.files.set(path, f);
		this.touch(path);
		return f;
	}

	/** Another device deletes `path`. */
	del(path: string): void {
		const f = this.files.get(path);
		if (!f) return;
		this.files.delete(path);
		this.trash.push({ path, data: dec.decode(f.data) });
		this.touch(path);
	}

	read(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? dec.decode(f.data) : undefined;
	}

	private entry(path: string, f: RemoteFile): RemoteEntry {
		return { id: f.id, path, size: f.data.byteLength, mtime: f.mtime, rev: f.rev, hash: "x", hashAlg: "md5" };
	}

	account(): Promise<string> {
		return Promise.resolve("test@example.com");
	}

	changes(cursor: string | undefined): Promise<RemoteChanges> {
		this.calls.push(`changes ${cursor ?? "-"}`);
		this.fail();
		const since = cursor && !this.alwaysFull ? Number(cursor.slice(1)) : NaN;
		if (!Number.isFinite(since)) {
			return Promise.resolve({ upserts: [...this.files].map(([p, f]) => this.entry(p, f)), deletions: [], cursor: `c${this.seq}`, full: true });
		}
		const paths = new Set(this.changeLog.filter((c) => c.seq > since).map((c) => c.path));
		const upserts: RemoteEntry[] = [];
		const deletions: string[] = [];
		for (const p of paths) {
			const f = this.files.get(p);
			if (f) upserts.push(this.entry(p, f));
			else deletions.push(p);
		}
		return Promise.resolve({ upserts, deletions, cursor: `c${this.seq}`, full: false });
	}

	download(id: string): Promise<ArrayBuffer> {
		this.calls.push(`download ${id}`);
		this.fail();
		for (const f of this.files.values()) if (f.id === id) return Promise.resolve(f.data.slice().buffer);
		return Promise.reject(new Error(`no file ${id}`));
	}

	upload(path: string, data: ArrayBuffer, ifRev: string | null | undefined): Promise<RemoteEntry> {
		this.calls.push(`upload ${path} ${ifRev === undefined ? "any" : ifRev ?? "new"}`);
		this.fail();
		const hook = this.beforeUpload;
		this.beforeUpload = null;
		hook?.(path);
		const cur = this.files.get(path);
		if (ifRev === null && cur) return Promise.reject(new RemoteConflictError(path, cur.rev));
		if (typeof ifRev === "string" && cur?.rev !== ifRev) return Promise.reject(new RemoteConflictError(path, cur?.rev));
		const f: RemoteFile = { id: cur?.id ?? `id${this.nextId++}`, data: new Uint8Array(data.slice(0)), rev: `r${this.nextRev++}`, mtime: 5000 + this.seq };
		this.files.set(path, f);
		this.touch(path);
		return Promise.resolve(this.entry(path, f));
	}

	remove(id: string, ifRev?: string): Promise<void> {
		this.calls.push(`remove ${id} ${ifRev ?? "any"}`);
		this.fail();
		for (const [p, f] of this.files) {
			if (f.id !== id) continue;
			if (ifRev !== undefined && f.rev !== ifRev) return Promise.reject(new RemoteConflictError(p, f.rev));
			this.del(p);
			return Promise.resolve();
		}
		return Promise.resolve();
	}
}

interface LocalEntry {
	data: Uint8Array;
	mtime: number;
}

export class FakeLocal implements LocalPort {
	readonly files = new Map<string, LocalEntry>();
	readonly trashed: { path: string; data: string }[] = [];
	/** Open notebooks: path -> whether unsaved changes remain after a flush. */
	readonly open = new Map<string, { unsaved: boolean; flushes: number }>();
	clock = 100;

	put(path: string, content: string): void {
		this.files.set(path, { data: enc.encode(content), mtime: ++this.clock });
	}

	/** Changes the time only (a touch: same content). */
	touch(path: string): void {
		const f = this.files.get(path);
		if (f) f.mtime = ++this.clock;
	}

	get(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? dec.decode(f.data) : undefined;
	}

	list(): LocalFile[] {
		return [...this.files].map(([path, f]) => ({ path, size: f.data.byteLength, mtime: f.mtime }));
	}

	stat(path: string): Promise<LocalStat | null> {
		const f = this.files.get(path);
		return Promise.resolve(f ? { size: f.data.byteLength, mtime: f.mtime } : null);
	}

	read(path: string): Promise<ArrayBuffer> {
		const f = this.files.get(path);
		return f ? Promise.resolve(f.data.slice().buffer) : Promise.reject(new Error(`no file ${path}`));
	}

	private check(path: string, expect: LocalStat | null): LocalChangedError | null {
		const f = this.files.get(path);
		const cur = f ? { size: f.data.byteLength, mtime: f.mtime } : null;
		const same = cur === null || expect === null ? cur === expect : cur.size === expect.size && cur.mtime === expect.mtime;
		return same ? null : new LocalChangedError(path);
	}

	write(path: string, data: ArrayBuffer, expect: LocalStat | null): Promise<LocalStat> {
		const changed = this.check(path, expect);
		if (changed) return Promise.reject(changed);
		const f = { data: new Uint8Array(data.slice(0)), mtime: ++this.clock };
		this.files.set(path, f);
		return Promise.resolve({ size: f.data.byteLength, mtime: f.mtime });
	}

	trash(path: string, expect: LocalStat): Promise<void> {
		const changed = this.check(path, expect);
		if (changed) return Promise.reject(changed);
		this.trashed.push({ path, data: this.get(path) ?? "" });
		this.files.delete(path);
		return Promise.resolve();
	}

	settle(path: string): Promise<boolean> {
		const o = this.open.get(path);
		if (!o) return Promise.resolve(true);
		o.flushes++;
		return Promise.resolve(!o.unsaved);
	}
}

export class MemoryState implements StatePort {
	data: unknown = null;
	saves = 0;
	load(): Promise<unknown> {
		return Promise.resolve(this.data === null ? null : JSON.parse(JSON.stringify(this.data)));
	}
	save(data: Record<string, unknown>): Promise<void> {
		this.saves++;
		this.data = JSON.parse(JSON.stringify(data));
		return Promise.resolve();
	}
}

export function ports(local: FakeLocal, remote: FakeProvider, state: MemoryState, sleeps: number[] = []): SyncPorts {
	return {
		local,
		remote,
		state,
		hash: sha256Hex,
		now: () => new Date(2026, 10, 8, 14, 5).getTime(),
		sleep: (ms) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
	};
}
