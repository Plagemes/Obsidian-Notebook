import { describe, expect, it } from "vitest";
import { SerialQueue, mayTrashCoverAsset } from "../src/library/cover-assets";

// Review fix (D10): two "Use this cover" with the same picture never meet, and a failed one trashes only what is its own.
describe("cover applies", () => {
	it("run one at a time in order, and a failure does not stop the next", async () => {
		const q = new SerialQueue();
		const log: string[] = [];
		const gate = (name: string, ms: number, fail = false) => () =>
			new Promise<string>((resolve, reject) => {
				log.push(`${name}:start`);
				setTimeout(() => {
					log.push(`${name}:end`);
					if (fail) reject(new Error(name));
					else resolve(name);
				}, ms);
			});
		const a = q.run(gate("a", 30, true));
		const b = q.run(gate("b", 1));
		await expect(a).rejects.toThrow("a");
		await expect(b).resolves.toBe("b");
		expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("trashes the picture only when this call created it and nothing else uses it", () => {
		expect(mayTrashCoverAsset(true, false)).toBe(true);
		expect(mayTrashCoverAsset(true, true)).toBe(false);
		expect(mayTrashCoverAsset(false, false)).toBe(false);
	});
});
