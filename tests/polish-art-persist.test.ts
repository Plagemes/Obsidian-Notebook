import { describe, expect, it } from "vitest";
import { sleep } from "./node-env";
import { PERSIST_MAX_ENTRIES, createIdbStore, dbNameFor } from "../src/ui/art/persist";

/** A tiny in-memory IndexedDB: enough of the API for put, count, delete and the ordered key cursor. */
function fakeFactory(rows: Map<string, { key: string; url: string; t: number }>, opened: string[]): IDBFactory {
	const req = <T,>(value: T): IDBRequest<T> => {
		const r = { result: value } as { result: T; onsuccess?: () => void };
		queueMicrotask(() => r.onsuccess?.());
		return r as unknown as IDBRequest<T>;
	};
	const store = {
		put: (row: { key: string; url: string; t: number }) => { rows.set(row.key, row); return req(row.key); },
		count: () => req(rows.size),
		delete: (key: string) => { rows.delete(key); return req(undefined); },
		get: (key: string) => req(rows.get(key)),
		clear: () => { rows.clear(); return req(undefined); },
		index: () => ({
			openKeyCursor: () => {
				const keys = [...rows.values()].sort((a, b) => a.t - b.t).map((r) => r.key);
				let i = 0;
				const r = { result: null } as { result: unknown; onsuccess?: () => void };
				const step = () => {
					r.result = i < keys.length ? { primaryKey: keys[i], continue: () => { i++; queueMicrotask(step); } } : null;
					r.onsuccess?.();
				};
				queueMicrotask(step);
				return r;
			},
		}),
	};
	const db = {
		transaction: () => {
			const tx = { objectStore: () => store, oncomplete: undefined as undefined | (() => void) };
			queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
			return tx;
		},
	};
	return {
		open: (name: string) => {
			opened.push(name);
			const r = { result: db } as { result: typeof db; onsuccess?: () => void };
			queueMicrotask(() => r.onsuccess?.());
			return r as unknown as IDBOpenDBRequest;
		},
	} as unknown as IDBFactory;
}

describe("art cache persistence (0.13 polish)", () => {
	it("names the database per vault", () => {
		expect(dbNameFor("Work")).not.toBe(dbNameFor("Home"));
		expect(dbNameFor("")).toBe(dbNameFor(undefined));
	});

	it("opens the database of its vault", async () => {
		const opened: string[] = [];
		const store = createIdbStore(fakeFactory(new Map(), opened), "Work")!;
		await store.get("k");
		expect(opened).toEqual([dbNameFor("Work")]);
	});

	it("applies the cap at the start of a session, not only after twenty writes", async () => {
		const rows = new Map<string, { key: string; url: string; t: number }>();
		for (let i = 0; i < PERSIST_MAX_ENTRIES + 40; i++) rows.set(`old${i}`, { key: `old${i}`, url: "u", t: i });
		const store = createIdbStore(fakeFactory(rows, []), "Work")!;
		await store.get("x");
		await sleep(50);
		expect(rows.size).toBeLessThanOrEqual(PERSIST_MAX_ENTRIES);
		expect(rows.has("old0")).toBe(false);
		expect(rows.has(`old${PERSIST_MAX_ENTRIES + 39}`)).toBe(true);
	});
});
