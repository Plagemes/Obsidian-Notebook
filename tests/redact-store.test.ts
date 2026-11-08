import { describe, expect, it } from "vitest";
import { REDACT_KEY, REDACT_MAX_NOTEBOOKS, loadRedactState, normaliseRedactStore, saveRedactState } from "../src/ui/redact-store";
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

	it("reads corrupt storage as no boxes and replaces it at the next save", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, "garbage");
		expect(loadRedactState(app, "nb-1")).toEqual(EMPTY_REDACT_STATE);
		saveRedactState(app, "nb-1", { on: true, boxes: { p1: [good] } }, 100);
		expect(loadRedactState(app, "nb-1").boxes).toEqual({ p1: [good] });
		const broken = { loadLocalStorage: () => { throw new Error("no storage"); }, saveLocalStorage: () => { throw new Error("no storage"); } };
		expect(loadRedactState(broken, "nb-1")).toEqual(EMPTY_REDACT_STATE);
		expect(() => saveRedactState(broken, "nb-1", { on: true, boxes: { p1: [good] } })).not.toThrow();
	});

	it("is bounded: the least recently changed notebooks are forgotten", () => {
		const raw: Record<string, unknown> = {};
		for (let i = 0; i < REDACT_MAX_NOTEBOOKS + 10; i++) raw[`nb-${i}`] = { on: true, at: i, boxes: { p1: [good] } };
		const store = normaliseRedactStore(raw);
		expect(Object.keys(store)).toHaveLength(REDACT_MAX_NOTEBOOKS);
		expect(store["nb-0"]).toBeUndefined();
		expect(store[`nb-${REDACT_MAX_NOTEBOOKS + 9}`]).toBeDefined();
	});

	it("drops bad notebook ids, bad rows and unusable boxes, and ignores a missing id", () => {
		const store = normaliseRedactStore({ "bad id": { on: true, at: 1, boxes: { p1: [good] } }, ok: { on: "yes", at: "x", boxes: { p1: [good, { x: 1 }] } }, empty: { on: true, at: 1, boxes: {} }, num: 5 });
		expect(Object.keys(store)).toEqual(["ok"]);
		expect(store.ok).toEqual({ on: false, at: 0, boxes: { p1: [good] } });
		const { app } = memory();
		expect(loadRedactState(app, null)).toEqual(EMPTY_REDACT_STATE);
		expect(() => saveRedactState(app, undefined, { on: true, boxes: { p1: [good] } })).not.toThrow();
	});
});
