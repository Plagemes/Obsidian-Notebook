import { describe, expect, it } from "vitest";
import { isOpenInSafeMode, markSafeOpen, MAX_ENTRIES, SafeModeTracker, unmarkSafeOpen, type LocalSlot } from "../src/storage/safe-mode";

/** Device local storage that survives a "crash" (a new tracker over the same slot). */
class Slot implements LocalSlot {
	data: unknown = null;
	saves = 0;
	failSave = false;
	load(): unknown {
		return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
	}
	save(data: unknown): void {
		if (this.failSave) throw new Error("quota");
		this.saves++;
		this.data = JSON.parse(JSON.stringify(data));
	}
}

const P = "Notebooks/Big.notebook";

describe("safe mode (#346)", () => {
	it("a notebook that opened fine opens normally", () => {
		const slot = new Slot();
		const t = new SafeModeTracker(slot);
		expect(t.begin(P)).toEqual({ safe: false, failures: 0, suggestRepair: false, skipMedia: false, forcedNormal: false });
		t.succeeded(P);
		expect(new SafeModeTracker(slot).begin(P).safe).toBe(false);
	});

	it("the marker is written before the load, so a crash during the open is seen by the next one", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		// The app dies here: nothing else runs. The marker is already in local storage.
		expect(slot.saves).toBeGreaterThan(0);
		const next = new SafeModeTracker(slot).begin(P);
		expect(next).toMatchObject({ safe: true, failures: 1, suggestRepair: false, skipMedia: false });
	});

	it("two consecutive failures suggest a repair", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		new SafeModeTracker(slot).begin(P); // safe open, dies too
		expect(new SafeModeTracker(slot).begin(P)).toMatchObject({ safe: true, failures: 2, suggestRepair: true });
	});

	it("stays in safe mode after a successful safe open, until Open normally is chosen", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		let t = new SafeModeTracker(slot);
		expect(t.begin(P).safe).toBe(true);
		t.succeeded(P);
		t = new SafeModeTracker(slot);
		expect(t.begin(P).safe).toBe(true);
		t.succeeded(P);
		t.requestNormal(P);
		const normal = t.begin(P);
		expect(normal).toMatchObject({ safe: false, forcedNormal: true, failures: 1 });
		t.succeeded(P);
		// The normal open worked: back to normal for good.
		expect(t.failures(P)).toBe(0);
		expect(new SafeModeTracker(slot).begin(P).safe).toBe(false);
	});

	it("a forced normal open that crashes again counts as the second failure", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		const t = new SafeModeTracker(slot);
		t.begin(P);
		t.succeeded(P);
		t.requestNormal(P);
		expect(t.begin(P).safe).toBe(false);
		// dies
		expect(new SafeModeTracker(slot).begin(P)).toMatchObject({ safe: true, failures: 2, suggestRepair: true });
	});

	it("a safe open that died while loading backgrounds skips them next time; a safe open that loads them clears that", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		let t = new SafeModeTracker(slot);
		expect(t.begin(P).skipMedia).toBe(false);
		t.stage(P, "media");
		// dies while PDF pages are being rendered
		t = new SafeModeTracker(slot);
		const d = t.begin(P);
		expect(d).toMatchObject({ safe: true, skipMedia: true, failures: 2 });
		t.succeeded(P); // painted without media
		t = new SafeModeTracker(slot);
		expect(t.begin(P).skipMedia).toBe(true);
		t.stage(P, "media"); // the user chose to show the backgrounds, and it worked
		t.succeeded(P);
		expect(new SafeModeTracker(slot).begin(P).skipMedia).toBe(false);
	});

	it("a normal open that dies while loading backgrounds does not skip them (only safe mode is progressive)", () => {
		const slot = new Slot();
		const t = new SafeModeTracker(slot);
		t.begin(P);
		t.stage(P, "media");
		expect(new SafeModeTracker(slot).begin(P)).toMatchObject({ safe: true, skipMedia: false });
	});

	it("closing or hiding the view before the open settled is not a failure", () => {
		const slot = new Slot();
		const t = new SafeModeTracker(slot);
		t.begin(P);
		t.abandoned(P);
		expect(new SafeModeTracker(slot).begin(P).safe).toBe(false);
		// ...and neither resets nor adds to an earlier failure.
		const slot2 = new Slot();
		new SafeModeTracker(slot2).begin(P); // dies
		const u = new SafeModeTracker(slot2);
		expect(u.begin(P).failures).toBe(1);
		u.abandoned(P);
		expect(new SafeModeTracker(slot2).begin(P)).toMatchObject({ safe: true, failures: 1 });
	});

	it("is per path, follows renames and forgets deleted notebooks", () => {
		const slot = new Slot();
		new SafeModeTracker(slot).begin(P);
		const t = new SafeModeTracker(slot);
		t.rename(P, "Notebooks/Renamed.notebook");
		expect(t.begin("Notebooks/Other.notebook").safe).toBe(false);
		expect(t.begin("Notebooks/Renamed.notebook").safe).toBe(true);
		t.forget("Notebooks/Renamed.notebook");
		expect(t.begin("Notebooks/Renamed.notebook").safe).toBe(false);
	});

	it("unreadable or foreign stored data is ignored, and a failing store never throws", () => {
		for (const data of [42, "x", { v: 99, files: {} }, { v: 1, files: { [P]: { pending: "no", failures: 1 } } }, { v: 1, files: null }]) {
			const slot = new Slot();
			slot.data = data;
			expect(new SafeModeTracker(slot).begin(P).safe).toBe(false);
		}
		const broken: LocalSlot = { load: () => { throw new Error("no storage"); }, save: () => { throw new Error("quota"); } };
		const t = new SafeModeTracker(broken);
		expect(() => t.begin(P)).not.toThrow();
		expect(() => t.succeeded(P)).not.toThrow();
	});

	it("keeps at most MAX_ENTRIES notebooks, dropping the least recently used", () => {
		let now = 0;
		const slot = new Slot();
		const t = new SafeModeTracker(slot, () => ++now);
		for (let i = 0; i < MAX_ENTRIES + 10; i++) t.begin(`n${i}.notebook`);
		const files = (slot.data as { files: Record<string, unknown> }).files;
		expect(Object.keys(files)).toHaveLength(MAX_ENTRIES);
		expect(files["n0.notebook"]).toBeUndefined();
		expect(files[`n${MAX_ENTRIES + 9}.notebook`]).toBeDefined();
	});

	it("registry of notebooks shown in safe mode counts views", () => {
		markSafeOpen(P);
		markSafeOpen(P);
		unmarkSafeOpen(P);
		expect(isOpenInSafeMode(P)).toBe(true);
		unmarkSafeOpen(P);
		expect(isOpenInSafeMode(P)).toBe(false);
		unmarkSafeOpen(P);
		expect(isOpenInSafeMode(P)).toBe(false);
	});
});
