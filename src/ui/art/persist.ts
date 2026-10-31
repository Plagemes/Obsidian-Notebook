// A persistent cache for the generated images, in IndexedDB. Works without it: every function resolves to "nothing"
// when IndexedDB is missing, blocked (private mode, a locked-down WebView) or fails. Does not import obsidian.

import { clearTimer, setTimer } from "./timers";

/** What the image functions need from a persistent store (an in-memory fake in tests). */
export interface ArtStore {
	get(key: string): Promise<string | undefined>;
	put(key: string, url: string): Promise<void>;
	/** The newest entries, newest first. */
	recent(limit: number): Promise<Array<[string, string]>>;
	clear(): Promise<void>;
}

/** Bumped whenever the drawing changes, so pictures stored by an older engine are never shown (it is part of every key). */
export const ART_ENGINE_VERSION = "13.1";

const DB_BASE = "notebook-art-cache";
/** The database of a vault: IndexedDB is shared by every vault on the device, so each vault gets its own (and its own cap). */
export function dbNameFor(scope?: string): string {
	const s = (scope ?? "").trim();
	return s ? `${DB_BASE}:${s}` : DB_BASE;
}
const STORE = "images";
/** At most this many pictures are kept; the oldest go first. */
export const PERSIST_MAX_ENTRIES = 160;
const PRUNE_EVERY = 20;
const OPEN_TIMEOUT_MS = 3000;

interface Row {
	key: string;
	url: string;
	t: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error ?? new Error("indexedDB request failed"));
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
	});
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = factory.open(name, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			const store = db.createObjectStore(STORE, { keyPath: "key" });
			store.createIndex("t", "t");
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
		req.onblocked = () => reject(new Error("indexedDB open blocked"));
	});
}

/**
 * The IndexedDB store, or null when IndexedDB does not exist here. Opening is lazy and happens once; if it fails or takes
 * longer than three seconds the store behaves as empty for the rest of the session.
 */
export function createIdbStore(factory?: IDBFactory, scope?: string): ArtStore | null {
	let idb: IDBFactory | undefined = factory;
	if (!idb) {
		try {
			idb = typeof indexedDB !== "undefined" ? indexedDB : undefined;
		} catch {
			idb = undefined;
		}
	}
	if (!idb) return null;
	const factoryUsed = idb;
	let dbPromise: Promise<IDBDatabase | null> | null = null;
	let puts = 0;
	const db = (): Promise<IDBDatabase | null> => {
		dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
			const timer = setTimer(() => resolve(null), OPEN_TIMEOUT_MS);
			openDb(factoryUsed, dbNameFor(scope)).then((d) => {
				clearTimer(timer);
				resolve(d);
				// The cap applies from the first moment of a session, not only after twenty writes.
				void prune(d).catch(() => undefined);
			}, () => {
				clearTimer(timer);
				resolve(null);
			});
		});
		return dbPromise;
	};
	const safe = async <T>(fallback: T, run: (d: IDBDatabase) => Promise<T>): Promise<T> => {
		try {
			const d = await db();
			return d ? await run(d) : fallback;
		} catch {
			return fallback;
		}
	};
	const prune = (d: IDBDatabase): Promise<void> => {
		const tx = d.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const finished = done(tx);
		void request(store.count()).then((count) => {
			let extra = count - PERSIST_MAX_ENTRIES;
			if (extra <= 0) return;
			const cursor = store.index("t").openKeyCursor();
			cursor.onsuccess = () => {
				const c = cursor.result;
				if (!c || extra <= 0) return;
				store.delete(c.primaryKey);
				extra--;
				c.continue();
			};
		});
		return finished;
	};
	return {
		get: (key) => safe<string | undefined>(undefined, async (d) => {
			const row = await request<Row | undefined>(d.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<Row | undefined>);
			return row && typeof row.url === "string" ? row.url : undefined;
		}),
		put: (key, url) => safe<void>(undefined, async (d) => {
			const tx = d.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put({ key, url, t: Date.now() } satisfies Row);
			await done(tx);
			if (++puts === 1 || puts % PRUNE_EVERY === 0) await prune(d);
		}),
		recent: (limit) => safe<Array<[string, string]>>([], (d) => new Promise((resolve) => {
			const out: Array<[string, string]> = [];
			const tx = d.transaction(STORE, "readonly");
			const cursor = tx.objectStore(STORE).index("t").openCursor(null, "prev");
			cursor.onsuccess = () => {
				const c = cursor.result;
				if (!c || out.length >= limit) {
					resolve(out);
					return;
				}
				const row = c.value as Row;
				if (typeof row.url === "string") out.push([row.key, row.url]);
				c.continue();
			};
			cursor.onerror = () => resolve(out);
		})),
		clear: () => safe<void>(undefined, async (d) => {
			const tx = d.transaction(STORE, "readwrite");
			tx.objectStore(STORE).clear();
			await done(tx);
		}),
	};
}
