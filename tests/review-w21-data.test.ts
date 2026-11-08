import { describe, expect, it } from "vitest";
import { choosePicturePath, MAX_PICTURE_NAMES, numberedName, PICTURE_MARK, pictureCacheable, type PictureProbe } from "../src/model/companion-pictures";
import { crc32, markPictureBytes, PIXEL_SUM_KEYWORD, PIXEL_SUM_V2_KEYWORD, pictureIntact, pngDataSum, pngPixelSum, readPngText } from "../src/model/png-text";

function chunk(type: string, d: number[]): number[] {
	const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...d];
	const crc = crc32(Uint8Array.from(body));
	return [(d.length >>> 24) & 255, (d.length >>> 16) & 255, (d.length >>> 8) & 255, d.length & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
}

function png(data: number[], extra: Array<[string, number[]]> = []): Uint8Array {
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
		...extra.flatMap(([t, d]) => chunk(t, d)), ...chunk("IDAT", data), ...chunk("IEND", []),
	]);
}

describe("D7: a picture carries the 0.21 and the 0.20 checksum", () => {
	const plain = png([1, 2, 3, 4]);

	it("writes both keys and the mark, and both agree with the picture", () => {
		const written = markPictureBytes(plain, PICTURE_MARK, "ink-key");
		expect(readPngText(written, PICTURE_MARK)).toBe("ink-key");
		expect(readPngText(written, PIXEL_SUM_V2_KEYWORD)).toBe(pngPixelSum(plain));
		expect(readPngText(written, PIXEL_SUM_KEYWORD)).toBe(pngDataSum(plain));
		expect(pictureIntact(written)).toBe(true);
	});

	it("a 0.20 device (which reads only the old key against the image data) sees it as untouched", () => {
		const written = markPictureBytes(plain, PICTURE_MARK, "k");
		expect(readPngText(written, PIXEL_SUM_KEYWORD)).toBe(pngDataSum(written));
	});

	it("an editor change to the chunks after the write makes 0.21 see the picture as edited", () => {
		const written = markPictureBytes(plain, PICTURE_MARK, "k");
		const tampered = Uint8Array.from([...written.subarray(0, 33), ...chunk("gAMA", [0, 1, 134, 160]), ...written.subarray(33)]);
		expect(pictureIntact(tampered)).toBe(false);
	});

	it("something that is not a PNG is returned as it is", () => {
		const junk = Uint8Array.from([1, 2, 3]);
		expect(markPictureBytes(junk, PICTURE_MARK, "k")).toEqual(junk);
	});
});

describe("D9: the full case keeps the previous link", () => {
	const base = "Headings/p3-h1.png";
	const ours = (mark: string): PictureProbe => ({ kind: "file", mark, intact: false });
	const allTaken = (marks: (n: number) => string | null) => async (path: string): Promise<PictureProbe> => {
		for (let n = 1; n <= MAX_PICTURE_NAMES; n++) {
			if (numberedName(base, n) === path) {
				const m = marks(n);
				return m === null ? { kind: "file", mark: null } : ours(m);
			}
		}
		return { kind: "free" };
	};

	it("points at the picture the note linked before when it is one of ours", async () => {
		const plan = await choosePicturePath(base, "new", allTaken((n) => `old${n}`), numberedName(base, 7));
		expect(plan).toEqual({ path: numberedName(base, 7), action: "full" });
	});

	it("falls back to the newest of ours when the previous one is not ours or unknown", async () => {
		const marks = (n: number) => (n === 7 ? null : `old${n}`);
		expect(await choosePicturePath(base, "new", allTaken(marks), numberedName(base, 7))).toEqual({ path: numberedName(base, MAX_PICTURE_NAMES), action: "full" });
		expect(await choosePicturePath(base, "new", allTaken(marks))).toEqual({ path: numberedName(base, MAX_PICTURE_NAMES), action: "full" });
	});

	it("never writes over anything in the full case", async () => {
		const plan = await choosePicturePath(base, "new", allTaken((n) => `old${n}`), "Headings/other.png");
		expect(plan?.action).toBe("full");
	});
});

describe("N6: a stale picture of the full case is not remembered under the current ink", () => {
	it("caches create, keep and rewrite plans, never a full one", () => {
		expect(pictureCacheable({ path: "a.png", action: "create" })).toBe(true);
		expect(pictureCacheable({ path: "a.png", action: "keep" })).toBe(true);
		expect(pictureCacheable({ path: "a.png", action: "rewrite" })).toBe(true);
		expect(pictureCacheable({ path: "a.png", action: "full" })).toBe(false);
	});
});
