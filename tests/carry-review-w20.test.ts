import { describe, expect, it, vi } from "vitest";
import {
	changedSince, choosePicturePath, MAX_PICTURE_NAMES, numberedName, rewriteIfUnchanged, type FileStamp, type PicturePlan, type PictureProbe,
} from "../src/model/companion-pictures";
import {
	addPngText, crc32, PIXEL_SUM_KEYWORD, PIXEL_SUM_V2_KEYWORD, pictureIntact, pngDataSum, pngPixelSum,
} from "../src/model/png-text";
import { executeThenSettle } from "../src/view/edit-context";
import { keepIndex } from "../src/view/ref-window-logic";

// ------------------------------------------------------------------------------------------------------------ helpers

function chunk(type: string, d: number[]): number[] {
	const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...d];
	const crc = crc32(Uint8Array.from(body));
	return [(d.length >>> 24) & 255, (d.length >>> 16) & 255, (d.length >>> 8) & 255, d.length & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
}

/** signature, IHDR, `extra` chunks (gAMA, tRNS...), IDAT(data), IEND. */
function png(data: number[], extra: Array<[string, number[]]> = []): Uint8Array {
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
		...extra.flatMap(([t, d]) => chunk(t, d)), ...chunk("IDAT", data), ...chunk("IEND", []),
	]);
}

// ------------------------------------------------------------------------------------------------------------------ R1

describe("R1: a step after the recorded change never makes execute fail", () => {
	it("returns the result of the record when a post step throws, and runs the other steps", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const ran: string[] = [];
		const done = executeThenSettle(() => true, [
			() => {
				throw new Error("layout failed");
			},
			(d) => ran.push(`scroll:${d}`),
		]);
		expect(done).toBe(true);
		expect(ran).toEqual(["scroll:true"]);
		expect(err).toHaveBeenCalledOnce();
		err.mockRestore();
	});

	it("passes a refusal on and still runs the steps (a refused change refreshes the view)", () => {
		const seen: boolean[] = [];
		expect(executeThenSettle(() => false, [(d) => seen.push(d)])).toBe(false);
		expect(seen).toEqual([false]);
	});

	it("lets a failure of the record itself through: nothing was recorded", () => {
		const steps = vi.fn();
		expect(() => executeThenSettle(() => {
			throw new Error("history");
		}, [steps])).toThrow("history");
		expect(steps).not.toHaveBeenCalled();
	});
});

// ------------------------------------------------------------------------------------------------------------------ R2

describe("R2: the checksum covers every chunk but the text and time ones", () => {
	const plain = png([1, 2, 3, 4]);

	it("ignores text chunks and the time", () => {
		const sum = pngPixelSum(plain);
		expect(sum).toMatch(/^[0-9a-f]{8}$/);
		expect(pngPixelSum(addPngText(plain, "x", "y"))).toBe(sum);
		expect(pngPixelSum(png([1, 2, 3, 4], [["tIME", [7, 234, 11, 5, 1, 2, 3]]]))).toBe(sum);
	});

	it("changes with a gamma, profile, transparency or palette edit that keeps the image data", () => {
		const sum = pngPixelSum(plain);
		for (const edit of [["gAMA", [0, 1, 134, 160]], ["tRNS", [0, 0, 0, 0, 0, 0]], ["iCCP", [112, 0, 0, 1]], ["sRGB", [0]], ["PLTE", [1, 2, 3]]] as Array<[string, number[]]>) {
			const edited = png([1, 2, 3, 4], [edit]);
			expect(pngDataSum(edited), edit[0]).toBe(pngDataSum(plain)); // the old sum could not see it
			expect(pngPixelSum(edited), edit[0]).not.toBe(sum);
		}
	});

	it("is null for something that is not a PNG or is cut short", () => {
		expect(pngPixelSum(Uint8Array.from([1, 2, 3]))).toBeNull();
		expect(pngPixelSum(plain.subarray(0, plain.length - 12))).toBeNull(); // no IEND
	});

	const mark = (bytes: Uint8Array, keyword: string, sum: string | null) => addPngText(addPngText(bytes, "notebook-heading", "k"), keyword, sum ?? "");

	it("recognises a picture the plugin wrote now as intact, and a gamma edit of it as the user's", () => {
		const written = mark(plain, PIXEL_SUM_V2_KEYWORD, pngPixelSum(plain));
		expect(pictureIntact(written)).toBe(true);
		const edited = mark(png([1, 2, 3, 4], [["gAMA", [0, 1, 134, 160]]]), PIXEL_SUM_V2_KEYWORD, pngPixelSum(plain));
		expect(pictureIntact(edited)).toBe(false);
	});

	it("still recognises a picture written by 0.20 (image data only, the old key)", () => {
		const old = mark(plain, PIXEL_SUM_KEYWORD, pngDataSum(plain));
		expect(pictureIntact(old)).toBe(true);
		const reencoded = mark(png([9, 9, 9, 9]), PIXEL_SUM_KEYWORD, pngDataSum(plain));
		expect(pictureIntact(reencoded)).toBe(false);
	});

	it("treats a picture with no checksum at all as not intact, and prefers the new key when both are there", () => {
		expect(pictureIntact(plain)).toBe(false);
		const both = addPngText(mark(plain, PIXEL_SUM_KEYWORD, pngDataSum(plain)), PIXEL_SUM_V2_KEYWORD, "00000000");
		expect(pictureIntact(both)).toBe(false);
	});
});

// ------------------------------------------------------------------------------------------------------------------ R3

describe("R3: when every name is taken, the previous picture stays linked", () => {
	const probes = (files: Record<string, { mark: string | null; intact?: boolean }>) => (path: string): Promise<PictureProbe> =>
		Promise.resolve(path in files ? { kind: "file", ...files[path]! } : { kind: "free" });

	it("tries a bounded but larger number of names", () => {
		expect(MAX_PICTURE_NAMES).toBeGreaterThan(9);
	});

	it("points at the newest picture of ours instead of giving up", async () => {
		const files: Record<string, { mark: string | null; intact?: boolean }> = {};
		for (let n = 1; n <= MAX_PICTURE_NAMES; n++) files[numberedName("p1-h1.png", n)] = { mark: "old", intact: false };
		const plan = await choosePicturePath("p1-h1.png", "new", probes(files));
		expect(plan).toEqual({ path: numberedName("p1-h1.png", MAX_PICTURE_NAMES), action: "full" });
	});

	it("is still null when none of the names is ours", async () => {
		const files: Record<string, { mark: string | null }> = {};
		for (let n = 1; n <= MAX_PICTURE_NAMES; n++) files[numberedName("p1-h1.png", n)] = { mark: null };
		expect(await choosePicturePath("p1-h1.png", "new", probes(files))).toBeNull();
	});

	it("takes a free name past the old limit of nine", async () => {
		const files: Record<string, { mark: string | null; intact?: boolean }> = {};
		for (let n = 1; n <= 12; n++) files[numberedName("p1-h1.png", n)] = { mark: "old", intact: false };
		expect(await choosePicturePath("p1-h1.png", "new", probes(files))).toEqual({ path: "p1-h1 13.png", action: "create" });
	});
});

// ------------------------------------------------------------------------------------------------------------------ R5

describe("R5: a picture is rewritten only if its file is as it was probed", () => {
	class Fake {
		files = new Map<string, { path: string; stat: FileStamp; data: string }>();
		writes: string[] = [];
		put(path: string, mtime: number, size: number): void {
			this.files.set(path, { path, stat: { mtime, size }, data: "" });
		}
		getFileByPath = (p: string) => this.files.get(p) ?? null;
		modifyBinary = (f: { stat: FileStamp }, data: ArrayBuffer): Promise<void> => {
			this.writes.push(`${(f as { path?: string }).path}:${data.byteLength}`);
			return Promise.resolve();
		};
	}
	const plan = (stamp?: FileStamp): PicturePlan => ({ path: "p1-h1.png", action: "rewrite", ...(stamp ? { stamp } : {}) });

	it("writes when the stamp is the same", async () => {
		const v = new Fake();
		v.put("p1-h1.png", 5, 100);
		const out = await rewriteIfUnchanged(v, plan({ mtime: 5, size: 100 }), new ArrayBuffer(8));
		expect(out.changed).toBe(false);
		expect(v.writes).toEqual(["p1-h1.png:8"]);
	});

	it("does not write when the file was replaced after the probe (time or size)", async () => {
		for (const [mtime, size] of [[6, 100], [5, 101]]) {
			const v = new Fake();
			v.put("p1-h1.png", mtime!, size!);
			const out = await rewriteIfUnchanged(v, plan({ mtime: 5, size: 100 }), new ArrayBuffer(8));
			expect(out).toEqual({ file: null, changed: true });
			expect(v.writes).toEqual([]);
		}
	});

	it("does not write when the file vanished", async () => {
		const v = new Fake();
		expect((await rewriteIfUnchanged(v, plan({ mtime: 5, size: 100 }), new ArrayBuffer(8))).changed).toBe(true);
		expect(v.writes).toEqual([]);
	});

	it("a replanning after the change goes to a new name, not over the new file", async () => {
		const v = new Fake();
		v.put("p1-h1.png", 5, 100);
		const probe = (path: string): Promise<PictureProbe> => {
			const f = v.getFileByPath(path);
			// The user's replacement has no mark of ours.
			return Promise.resolve(f ? { kind: "file", mark: f.stat.mtime === 5 ? "old" : null, intact: true, stamp: { ...f.stat } } : { kind: "free" });
		};
		const first = await choosePicturePath("p1-h1.png", "new", probe);
		expect(first?.action).toBe("rewrite");
		v.put("p1-h1.png", 9, 77); // a sync replaces it after the probe
		const out = await rewriteIfUnchanged(v, first!, new ArrayBuffer(8));
		expect(out.changed).toBe(true);
		expect(await choosePicturePath("p1-h1.png", "new", probe)).toEqual({ path: "p1-h1 2.png", action: "create" });
		expect(v.writes).toEqual([]);
	});

	it("compares stamps: nothing recorded means nothing to compare, a missing file is a change", () => {
		expect(changedSince(undefined, { mtime: 1, size: 1 })).toBe(false);
		expect(changedSince({ mtime: 1, size: 1 }, null)).toBe(true);
	});
});

// ------------------------------------------------------------------------------------------------------------------ R4

describe("R4: the reference window keeps its page while it reads the file again", () => {
	it("keeps the index when the page count is not known (0) yet", () => {
		expect(keepIndex(5, 0)).toBe(5);
	});

	it("keeps a valid index and clamps one past the end", () => {
		expect(keepIndex(5, 12)).toBe(5);
		expect(keepIndex(20, 12)).toBe(11);
		expect(keepIndex(-3, 12)).toBe(0);
	});
});
