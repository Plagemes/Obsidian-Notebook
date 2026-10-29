import { describe, expect, it } from "vitest";
import { downscaleSteps, isHeic, mimeFromName, photoMime, readJpegSize, safeSize, sniffImage } from "../src/scan";

function ftyp(major: string, compat: string[] = []): Uint8Array {
	const size = 16 + compat.length * 4;
	const b = new Uint8Array(size);
	b[3] = size;
	b.set([...("ftyp" + major).split("").map((c) => c.charCodeAt(0))], 4);
	compat.forEach((c, i) => b.set(c.split("").map((x) => x.charCodeAt(0)), 16 + i * 4));
	return b;
}

describe("sniffImage / isHeic", () => {
	it.each(["heic", "heix", "hevc", "mif1", "msf1"])("detects HEIF brand %s", (brand) => {
		expect(isHeic(ftyp(brand))).toBe(true);
		expect(isHeic(ftyp(brand).buffer as ArrayBuffer)).toBe(true);
	});
	it("does not mistake AVIF for HEIC", () => {
		expect(sniffImage(ftyp("avif"))).toBe("avif");
		expect(sniffImage(ftyp("mif1", ["avif"]))).toBe("avif");
		expect(sniffImage(ftyp("mif1", ["heic"]))).toBe("heic");
	});
	it("recognises common formats and ignores junk", () => {
		expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
		expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
		expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
		expect(sniffImage(ftyp("isom"))).toBe("unknown");
		expect(sniffImage(new Uint8Array(0))).toBe("unknown");
		expect(isHeic(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
	});
});

describe("mime", () => {
	it("derives the type from the file name", () => {
		expect(mimeFromName("IMG_1.JPG")).toBe("image/jpeg");
		expect(mimeFromName("a.b.png")).toBe("image/png");
		expect(mimeFromName("photo.heif")).toBe("image/heif");
		expect(mimeFromName("noext")).toBe("");
		expect(mimeFromName("x.pdf")).toBe("");
	});
	it("prefers content, then declared type, then name, then JPEG", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
		const none = new Uint8Array([1, 2, 3, 4]);
		expect(photoMime(png, "x.jpg", "image/jpeg")).toBe("image/png");
		expect(photoMime(none, "x.png", "image/webp")).toBe("image/webp");
		expect(photoMime(none, "x.png", "")).toBe("image/png");
		expect(photoMime(none, "content", "")).toBe("image/jpeg");
	});
});

describe("readJpegSize", () => {
	it("reads the SOF dimensions", () => {
		// SOI, APP0 (len 4), SOF0: len 11, precision 8, height 3000, width 4000.
		const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0x0b, 0xb8, 0x0f, 0xa0, 1, 0, 0, 0]);
		expect(readJpegSize(b)).toEqual({ width: 4000, height: 3000 });
		expect(readJpegSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
	});
});

describe("safeSize", () => {
	it("leaves small sizes alone", () => {
		expect(safeSize(1200, 800)).toEqual({ width: 1200, height: 800 });
	});
	it("caps the side at 4096", () => {
		expect(safeSize(8000, 2000)).toEqual({ width: 4096, height: 1024 });
	});
	it("caps the area at about 16.7 MP", () => {
		const s = safeSize(4000, 4000, 4096);
		expect(s.width * s.height).toBeLessThanOrEqual(16_700_000);
		expect(s.width / s.height).toBeCloseTo(1, 2);
	});
	it("honours a smaller explicit side and never returns zero", () => {
		expect(safeSize(8000, 6000, 2400)).toEqual({ width: 2400, height: 1800 });
		expect(safeSize(0, 0)).toEqual({ width: 1, height: 1 });
	});
});

describe("downscaleSteps", () => {
	it("halves at most per step and ends at the target", () => {
		const steps = downscaleSteps({ width: 4000, height: 3000 }, { width: 1000, height: 750 });
		expect(steps).toEqual([{ width: 2000, height: 1500 }, { width: 1000, height: 750 }]);
	});
	it("skips intermediates above the safe limits (50 MP photo)", () => {
		const steps = downscaleSteps({ width: 8160, height: 6120 }, { width: 2400, height: 1800 });
		for (const s of steps) {
			expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(4096);
			expect(s.width * s.height).toBeLessThanOrEqual(16_700_000);
		}
		expect(steps[steps.length - 1]).toEqual({ width: 2400, height: 1800 });
	});
	it("is a single step when no shrinking is needed", () => {
		expect(downscaleSteps({ width: 800, height: 600 }, { width: 800, height: 600 })).toEqual([{ width: 800, height: 600 }]);
	});
});

describe("photoSize", () => {
	it("rejects HEIF/HEIC with the actionable reason before decoding", async () => {
		const { photoSize, PhotoDecodeError } = await import("../src/scan/decode");
		const err = await photoSize(ftyp("heic").buffer as ArrayBuffer, "IMG_0001.heic").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PhotoDecodeError);
		expect((err as InstanceType<typeof PhotoDecodeError>).reason).toBe("heic");
	});
	it("rejects an empty file as unreadable", async () => {
		const { photoSize, PhotoDecodeError } = await import("../src/scan/decode");
		const err = await photoSize(new ArrayBuffer(0), "x.jpg").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PhotoDecodeError);
		expect((err as InstanceType<typeof PhotoDecodeError>).reason).toBe("unreadable");
	});
});
