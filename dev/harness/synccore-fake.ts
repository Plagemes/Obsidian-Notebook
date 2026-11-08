/**
 * 0.22 synccore (#126), dev only: an in-memory cloud and its sign-in for the harness, so the cloud sync settings and a real run
 * can be shown before the Google Drive / OneDrive providers are integrated. Never part of the plugin bundle.
 */
import type { SyncAuthUI } from "../../src/sync/auth-ui";
import { RemoteConflictError, type CloudProvider, type ProviderId, type RemoteChanges, type RemoteEntry } from "../../src/sync/provider-types";

interface Stored {
	id: string;
	data: Uint8Array;
	rev: string;
	mtime: number;
}

export class HarnessCloud implements CloudProvider {
	readonly id: ProviderId = "gdrive";
	readonly files = new Map<string, Stored>();
	readonly trash: string[] = [];
	private seq = 0;
	private n = 1;
	private readonly changeLog: { seq: number; path: string }[] = [];

	private entry(path: string, f: Stored): RemoteEntry {
		return { id: f.id, path, size: f.data.byteLength, mtime: f.mtime, rev: f.rev };
	}

	/** Another device writes a file. */
	put(path: string, text: string): void {
		const old = this.files.get(path);
		this.files.set(path, { id: old?.id ?? `f${this.n++}`, data: new TextEncoder().encode(text), rev: `r${this.n++}`, mtime: Date.now() });
		this.changeLog.push({ seq: ++this.seq, path });
	}

	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? new TextDecoder().decode(f.data) : undefined;
	}

	account(): Promise<string> {
		return Promise.resolve("student@example.com");
	}

	changes(cursor: string | undefined): Promise<RemoteChanges> {
		const since = cursor ? Number(cursor) : NaN;
		if (!Number.isFinite(since)) return Promise.resolve({ upserts: [...this.files].map(([p, f]) => this.entry(p, f)), deletions: [], cursor: String(this.seq), full: true });
		const paths = new Set(this.changeLog.filter((c) => c.seq > since).map((c) => c.path));
		const upserts: RemoteEntry[] = [];
		const deletions: string[] = [];
		for (const p of paths) {
			const f = this.files.get(p);
			if (f) upserts.push(this.entry(p, f));
			else deletions.push(p);
		}
		return Promise.resolve({ upserts, deletions, cursor: String(this.seq), full: false });
	}

	download(id: string): Promise<ArrayBuffer> {
		for (const f of this.files.values()) if (f.id === id) return Promise.resolve(f.data.slice().buffer);
		return Promise.reject(new Error(`no file ${id}`));
	}

	upload(path: string, data: ArrayBuffer, ifRev: string | null | undefined): Promise<RemoteEntry> {
		const cur = this.files.get(path);
		if ((ifRev === null && cur) || (typeof ifRev === "string" && cur?.rev !== ifRev)) return Promise.reject(new RemoteConflictError(path, cur?.rev));
		const f: Stored = { id: cur?.id ?? `f${this.n++}`, data: new Uint8Array(data.slice(0)), rev: `r${this.n++}`, mtime: Date.now() };
		this.files.set(path, f);
		this.changeLog.push({ seq: ++this.seq, path });
		return Promise.resolve(this.entry(path, f));
	}

	remove(id: string, ifRev?: string): Promise<void> {
		for (const [p, f] of this.files) {
			if (f.id !== id) continue;
			if (ifRev !== undefined && f.rev !== ifRev) return Promise.reject(new RemoteConflictError(p, f.rev));
			this.files.delete(p);
			this.trash.push(p);
			this.changeLog.push({ seq: ++this.seq, path: p });
		}
		return Promise.resolve();
	}
}

/** A sign-in that always works, bound to `cloud`. */
export function harnessAuth(cloud: HarnessCloud): SyncAuthUI & { signedIn: boolean } {
	const auth = {
		signedIn: false,
		available: () => true,
		isSignedIn: () => auth.signedIn,
		signIn: () => {
			auth.signedIn = true;
			return Promise.resolve(true);
		},
		signOut: () => {
			auth.signedIn = false;
			return Promise.resolve();
		},
		accountLabel: () => "student@example.com",
		rootLabel: () => "/Apps/Notebook vault",
		rootId: () => "root-1",
		connect: () => Promise.resolve(auth.signedIn ? cloud : null),
	};
	return auth;
}
