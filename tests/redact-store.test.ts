import { describe, expect, it } from "vitest";
import {
	QUARANTINE_MAX_CHARS, REDACT_KEY, REDACT_MAX_NOTEBOOKS, REDACT_PRESENT_KEY, REDACT_QUARANTINE_KEY, loadRedactState, normaliseRedactStore, redactKey,
	resetRedactStorage, saveRedactState, takeRedactStoreNotice,
} from "../src/ui/redact-store";
import { EMPTY_REDACT_STATE } from "../src/model/redact";

const good = { x: 10, y: 10, width: 40, height: 40 };

function memory(): { app: { loadLocalStorage(k: string): unknown; saveLocalStorage(k: string, v: unknown): void }; data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		app: {
			loadLocalStorage: (k) => data.get(k) ?? null,
			saveLocalStorage: (k, v) => { if (v === null) data.delete(k); else data.set(k, JSON.parse(JSON.stringify(v))); },
		},
	};
}

describe("the redaction boxes kept on this device", () => {
	it("remembers the boxes and the switch of a notebook, and nothing for another", () => {
		const { app } = memory();
		saveRedactState(app, "nb-1", { on: true, boxes: { p1: [good] } }, 100);
		expect(loadRedactState(app, "nb-1")).toEqual({ on: true, boxes: { p1: [good] } });
		expect(loadRedactState(app, "nb-2")).toEqual(EMPTY_REDACT_STATE);
		saveRedactState(app, "nb-1", { on: false, boxes: { p1: [good] } }, 200);
		expect(loadRedactState(app, "nb-1").on).toBe(false);
	});

	it("forgets a notebook whose boxes were all cleared", () => {
		const { app, data } = memory();
		saveRedactState(app, "nb-1", { on: true, boxes: { p1: [good] } }, 100);
		saveRedactState(app, "nb-1", { on: true, boxes: {} }, 200);
		expect(loadRedactState(app, "nb-1")).toEqual(EMPTY_REDACT_STATE);
		expect(data.get(REDACT_KEY)).toEqual({});
	});

	it("review fix P4: reads corrupt storage as UNREADABLE (never as no boxes) until the notebook is set again", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, "garbage");
		expect(loadRedactState(app, "nb-1")).toEqual({ ...EMPTY_REDACT_STATE, unreadable: true });
		expect(saveRedactState(app, "nb-1", { on: true, boxes: { p1: [good] } }, 100).stored).toBe(true);
		expect(loadRedactState(app, "nb-1")).toEqual({ on: true, boxes: { p1: [good] } });
		// R3: the value that could not be read is kept aside, and the other notebooks stay unreadable.
		expect(data.get(REDACT_QUARANTINE_KEY)).toMatchObject({ raw: "garbage" });
		expect(loadRedactState(app, "nb-2").unreadable).toBe(true);
		// A broken entry of one notebook makes that one unreadable, and a save of another keeps it so.
		const { app: other, data: d2 } = memory();
		d2.set(REDACT_KEY, { "nb-1": { on: true, at: 1, boxes: "torn" }, "nb-2": { on: true, at: 1, boxes: { p1: [good] } } });
		expect(loadRedactState(other, "nb-1").unreadable).toBe(true);
		expect(loadRedactState(other, "nb-2")).toEqual({ on: true, boxes: { p1: [good] } });
		saveRedactState(other, "nb-3", { on: true, boxes: { p1: [good] } }, 5);
		const later = { loadLocalStorage: (k: string) => d2.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { d2.set(k, v); } }; // a new session, same device
		expect(loadRedactState(later, "nb-1").unreadable).toBe(true);
		// Storage that throws: unreadable, and a save never throws but says it was not stored.
		const broken = { loadLocalStorage: () => { throw new Error("no storage"); }, saveLocalStorage: () => { throw new Error("no storage"); } };
		expect(loadRedactState(broken, "nb-1")).toEqual({ ...EMPTY_REDACT_STATE, unreadable: true });
		let result: ReturnType<typeof saveRedactState> | null = null;
		expect(() => { result = saveRedactState(broken, "nb-1", { on: true, boxes: { p1: [good] } }); }).not.toThrow();
		expect(result!.stored).toBe(false);
		// ...and the boxes are held for this session: they still cover the exports.
		expect(loadRedactState(broken, "nb-1")).toEqual({ on: true, boxes: { p1: [good] } });
	});

	it("review fix P4: a save that does not read back the same is reported, and the session copy wins", () => {
		const data = new Map<string, unknown>();
		const lossy = { loadLocalStorage: (k: string) => data.get(k) ?? null, saveLocalStorage: () => undefined }; // a full quota: silently dropped
		const result = saveRedactState(lossy, "nb-1", { on: true, boxes: { p1: [good] } }, 1);
		expect(result.stored).toBe(false);
		expect(loadRedactState(lossy, "nb-1")).toEqual({ on: true, boxes: { p1: [good] } });
		// Control: a store that keeps what it is given reports it stored.
		const { app } = memory();
		expect(saveRedactState(app, "nb-1", { on: true, boxes: { p1: [good] } }, 1)).toEqual({ stored: true, full: false, evicted: 0 });
	});

	it("review fix P4: never forgets a notebook whose switch is on; switched-off ones go first, and a full store says so", () => {
		const { app, data } = memory();
		for (let i = 0; i < REDACT_MAX_NOTEBOOKS; i++) saveRedactState(app, `on-${i}`, { on: true, boxes: { p1: [good] } }, i);
		// Every remembered notebook is on: a new one is held in memory only, and nothing is dropped.
		const full = saveRedactState(app, "new", { on: true, boxes: { p1: [good] } }, 100);
		expect(full).toEqual({ stored: false, full: true, evicted: 0 });
		expect(Object.keys(data.get(REDACT_KEY) as object)).toHaveLength(REDACT_MAX_NOTEBOOKS);
		expect(loadRedactState(app, "new").on).toBe(true);
		expect(loadRedactState(app, "on-0").on).toBe(true);
		// One of them switched off: it is the one that makes room, and the caller is told.
		saveRedactState(app, "on-0", { on: false, boxes: { p1: [good] } }, 101);
		const room = saveRedactState(app, "new", { on: true, boxes: { p1: [good] } }, 102);
		expect(room).toEqual({ stored: true, full: false, evicted: 1 });
		const stored = data.get(REDACT_KEY) as Record<string, unknown>;
		expect(stored["on-0"]).toBeUndefined();
		expect(stored.new).toBeDefined();
		for (let i = 1; i < REDACT_MAX_NOTEBOOKS; i++) expect(stored[`on-${i}`]).toBeDefined();
	});

	it("reads back everything that was stored (nothing switched on is cut at the limit)", () => {
		const raw: Record<string, unknown> = {};
		for (let i = 0; i < REDACT_MAX_NOTEBOOKS + 10; i++) raw[`nb-${i}`] = { on: true, at: i, boxes: { p1: [good] } };
		const store = normaliseRedactStore(raw);
		expect(Object.keys(store)).toHaveLength(REDACT_MAX_NOTEBOOKS + 10);
		expect(store["nb-0"]).toBeDefined();
	});

	it("review fix P4: keeps a notebook whose id is not a usable key under a hash of it", () => {
		const { app, data } = memory();
		const odd = "Notebook with spaces and ü / slashes";
		expect(redactKey(odd)).toMatch(/^x-[0-9a-f]{14}$/);
		expect(redactKey("nb-1")).toBe("nb-1");
		expect(saveRedactState(app, odd, { on: true, boxes: { p1: [good] } }, 1).stored).toBe(true);
		const later = { loadLocalStorage: (k: string) => data.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { data.set(k, v); } };
		expect(loadRedactState(later, odd)).toEqual({ on: true, boxes: { p1: [good] } });
		expect(loadRedactState(later, "another odd id ü")).toEqual(EMPTY_REDACT_STATE);
	});

	it("drops bad rows and unusable boxes, reads a value of another shape as nothing usable, and ignores a missing id", () => {
		const store = normaliseRedactStore({ ok: { on: "yes", at: "x", boxes: { p1: [good, { x: 1 }] } }, empty: { on: true, at: 1, boxes: {} } });
		expect(Object.keys(store)).toEqual(["ok"]);
		expect(store.ok).toEqual({ on: false, at: 0, boxes: { p1: [good] } });
		// A key or a value this store never writes: the whole value is another format (the R3 tests: it reads as unreadable).
		expect(normaliseRedactStore({ "bad id": { on: true, at: 1, boxes: { p1: [good] } }, ok: { on: true, at: 1, boxes: { p1: [good] } } })).toEqual({});
		expect(normaliseRedactStore({ ok: { on: true, at: 1, boxes: { p1: [good] } }, num: 5 })).toEqual({});
		const { app } = memory();
		expect(loadRedactState(app, null)).toEqual(EMPTY_REDACT_STATE);
		expect(() => saveRedactState(app, undefined, { on: true, boxes: { p1: [good] } })).not.toThrow();
	});
});

/** The same device in a new session (the session copies are per app object). */
const later = (data: Map<string, unknown>) => ({
	loadLocalStorage: (k: string) => data.get(k) ?? null,
	saveLocalStorage: (k: string, v: unknown) => { if (v === null) data.delete(k); else data.set(k, JSON.parse(JSON.stringify(v))); },
});

describe("review fix R3: a store this version cannot read fails closed, with a way back", () => {
	it("a corrupt value: every notebook is unreadable, a copy is kept aside, the value is not overwritten by a read, one notice is due", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, "garbage");
		expect(loadRedactState(app, "nb-a").unreadable).toBe(true);
		expect(loadRedactState(app, "nb-b").unreadable).toBe(true);
		expect(data.get(REDACT_KEY)).toBe("garbage");
		expect(data.get(REDACT_QUARANTINE_KEY)).toMatchObject({ raw: "garbage" });
		expect(takeRedactStoreNotice(app)).toBe(true);
		expect(takeRedactStoreNotice(app)).toBe(false);
		// Done in the dialog of A: A is set again (also in a new session); B stays refused.
		expect(saveRedactState(app, "nb-a", { on: true, boxes: { p1: [good] } }, 10).stored).toBe(true);
		const next = later(data);
		expect(loadRedactState(next, "nb-a")).toEqual({ on: true, boxes: { p1: [good] } });
		expect(loadRedactState(next, "nb-b").unreadable).toBe(true);
	});

	it("a value of a future version (another shape) is unreadable for every notebook, never 'no boxes'", () => {
		const future = { version: 2, notebooks: { "nb-a": { on: true, boxes: { p1: [good] } } } };
		const { app, data } = memory();
		data.set(REDACT_KEY, future);
		expect(loadRedactState(app, "nb-a").unreadable).toBe(true);
		expect(loadRedactState(app, "nb-z").unreadable).toBe(true);
		expect(JSON.parse((data.get(REDACT_QUARANTINE_KEY) as { raw: string }).raw)).toEqual(future);
		// An object entry with none of the fields this store writes is another format too.
		const { app: other, data: d2 } = memory();
		d2.set(REDACT_KEY, { notebooks: { "nb-a": {} } });
		expect(loadRedactState(other, "nb-a").unreadable).toBe(true);
	});

	it("a value the platform dropped (missing although the sentinel says it was written) is unreadable", () => {
		const { app, data } = memory();
		saveRedactState(app, "nb-a", { on: true, boxes: { p1: [good] } }, 1);
		expect(data.get(REDACT_PRESENT_KEY)).toBe(1);
		data.delete(REDACT_KEY); // what a platform that cannot parse the stored text returns
		expect(loadRedactState(later(data), "nb-a").unreadable).toBe(true);
		// Control: with nothing ever written there is nothing to refuse.
		expect(loadRedactState(memory().app, "nb-a")).toEqual(EMPTY_REDACT_STATE);
	});

	it("Done with no boxes while the store is quarantined keeps an explicit 'none' for that notebook only", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, 42);
		saveRedactState(app, "nb-a", { on: false, boxes: {} }, 5);
		const next = later(data);
		expect(loadRedactState(next, "nb-a")).toEqual(EMPTY_REDACT_STATE);
		expect(loadRedactState(next, "nb-b").unreadable).toBe(true);
	});

	it("nothing is written over the value when its copy cannot be kept aside", () => {
		const data = new Map<string, unknown>([[REDACT_KEY, "garbage"]]);
		const app = {
			loadLocalStorage: (k: string) => data.get(k) ?? null,
			saveLocalStorage: (k: string, v: unknown) => { if (k === REDACT_QUARANTINE_KEY) throw new Error("full"); data.set(k, v); },
		};
		expect(saveRedactState(app, "nb-a", { on: true, boxes: { p1: [good] } }, 1).stored).toBe(false);
		expect(data.get(REDACT_KEY)).toBe("garbage");
		// The boxes still cover this session's exports.
		expect(loadRedactState(app, "nb-a")).toEqual({ on: true, boxes: { p1: [good] } });
		expect(loadRedactState(app, "nb-b").unreadable).toBe(true);
	});

	it("the copy kept aside is bounded and never replaced by a later unreadable value", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, "x".repeat(QUARANTINE_MAX_CHARS + 50));
		loadRedactState(app, "nb-a");
		const kept = data.get(REDACT_QUARANTINE_KEY) as { raw: string; truncated?: true };
		expect(kept.raw).toHaveLength(QUARANTINE_MAX_CHARS);
		expect(kept.truncated).toBe(true);
		data.set(REDACT_KEY, "other");
		loadRedactState(later(data), "nb-a");
		expect((data.get(REDACT_QUARANTINE_KEY) as { raw: string }).raw).toHaveLength(QUARANTINE_MAX_CHARS);
	});

	it("Reset redaction storage forgets everything: no notebook is refused or has boxes afterwards", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, "garbage");
		saveRedactState(app, "nb-a", { on: true, boxes: { p1: [good] } }, 1);
		expect(resetRedactStorage(app)).toBe(true);
		for (const k of [REDACT_KEY, REDACT_PRESENT_KEY, REDACT_QUARANTINE_KEY]) expect(data.has(k)).toBe(false);
		expect(loadRedactState(app, "nb-a")).toEqual(EMPTY_REDACT_STATE);
		expect(loadRedactState(app, "nb-b")).toEqual(EMPTY_REDACT_STATE);
	});

	it("control: a readable store never makes a copy aside and never refuses", () => {
		const { app, data } = memory();
		saveRedactState(app, "nb-a", { on: true, boxes: { p1: [good] } }, 1);
		saveRedactState(app, "nb-a", { on: true, boxes: {} }, 2);
		expect(data.has(REDACT_QUARANTINE_KEY)).toBe(false);
		expect(data.has(REDACT_PRESENT_KEY)).toBe(false);
		expect(loadRedactState(later(data), "nb-b")).toEqual(EMPTY_REDACT_STATE);
		expect(takeRedactStoreNotice(app)).toBe(false);
	});
});
