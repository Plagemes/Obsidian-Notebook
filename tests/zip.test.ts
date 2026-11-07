import { describe, expect, it } from "vitest";
import { crc32, dosDateTime, fromDosDateTime, readZip, safeEntryName, verifyZipEntry, zipEntryData, ZipError, ZipWriter, ZIP_MAX_ENTRIES } from "../src/model/zip";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("crc32", () => {
	it("matches the published check values", () => {
		expect(crc32(enc("123456789"))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
		expect(crc32(enc("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
	});
});

describe("zip writer and reader", () => {
	const mtime = new Date(2026, 10, 5, 10, 15, 30).getTime();

	it("round-trips names, bytes, sizes, CRCs, times and the comment", () => {
		const zip = new ZipWriter();
		const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 0xff);
		zip.add("Notebooks/Maths.notebook", enc('{"version":18}'), mtime);
		zip.add("Notebooks/_assets/0123456789abcdef01234567.png", png, mtime);
		zip.add("Notebooks/_meta/folders-ab12cd34.json", enc("{}"), mtime);
		zip.add("Empty.notebook", new Uint8Array(0), mtime);
		const bytes = zip.finish("notebook-plugin-backup 1");
		const listing = readZip(bytes);
		expect(listing.comment).toBe("notebook-plugin-backup 1");
		expect(listing.entries.map((e) => e.name)).toEqual(["Notebooks/Maths.notebook", "Notebooks/_assets/0123456789abcdef01234567.png", "Notebooks/_meta/folders-ab12cd34.json", "Empty.notebook"]);
		const [a, b, , d] = listing.entries;
		expect(dec(zipEntryData(bytes, a!))).toBe('{"version":18}');
		expect(Array.from(zipEntryData(bytes, b!))).toEqual(Array.from(png));
		expect(b!.crc).toBe(crc32(png));
		expect(d!.size).toBe(0);
		// DOS time has a 2-second resolution: 30 s is even, so it is exact.
		expect(a!.mtime).toBe(mtime);
		for (const e of listing.entries) expect(verifyZipEntry(bytes, e)).toBe(true);
	});

	it("keeps non-ASCII names", () => {
		const zip = new ZipWriter();
		zip.add("Quaderni/Analisi è più facile 数学.notebook", enc("x"));
		const entries = readZip(zip.finish()).entries;
		expect(entries[0]!.name).toBe("Quaderni/Analisi è più facile 数学.notebook");
	});

	it("detects a flipped data byte through the CRC", () => {
		const zip = new ZipWriter();
		zip.add("a.notebook", enc("hello world"));
		const bytes = zip.finish();
		const entry = readZip(bytes).entries[0]!;
		bytes[entry.dataOffset + 3] = bytes[entry.dataOffset + 3]! ^ 0x01;
		expect(verifyZipEntry(bytes, entry)).toBe(false);
	});

	it("reads an archive that is a view into a larger buffer", () => {
		const zip = new ZipWriter();
		zip.add("a.notebook", enc("abc"), mtime);
		const inner = zip.finish();
		const outer = new Uint8Array(inner.length + 20);
		outer.set(inner, 7);
		const view = outer.subarray(7, 7 + inner.length);
		const entry = readZip(view).entries[0]!;
		expect(dec(zipEntryData(view, entry))).toBe("abc");
		expect(verifyZipEntry(view, entry)).toBe(true);
	});

	it("rejects truncated, empty and foreign data", () => {
		const zip = new ZipWriter();
		zip.add("a.notebook", enc("abcdef"));
		const bytes = zip.finish();
		expect(() => readZip(new Uint8Array(0))).toThrow(ZipError);
		expect(() => readZip(enc("this is not a zip file at all, just text"))).toThrow(ZipError);
		expect(() => readZip(bytes.subarray(0, bytes.length - 5))).toThrow(ZipError);
		expect(() => readZip(bytes.subarray(10))).toThrow(ZipError);
	});

	it("rejects a directory that points outside the archive or a local header that names another file", () => {
		const zip = new ZipWriter();
		zip.add("one.notebook", enc("1111"));
		zip.add("two.notebook", enc("2222"));
		const good = zip.finish();
		const bad = good.slice();
		// the central directory offset lives 16 bytes into the end record (22 bytes, no comment)
		new DataView(bad.buffer).setUint32(bad.length - 22 + 16, 0x7fffffff, true);
		expect(() => readZip(bad)).toThrow(ZipError);
		const renamed = good.slice();
		renamed[30] = renamed[30]! ^ 0x20; // first letter of the first local name
		expect(() => readZip(renamed)).toThrow(ZipError);
	});

	it("refuses unusable and repeated names", () => {
		for (const name of ["", "/abs.notebook", "a//b.notebook", "../x.notebook", "a/../b.notebook", "dir/", "back\\slash.notebook", "nul\0.notebook"]) {
			expect(safeEntryName(name), JSON.stringify(name)).toBeNull();
			expect(() => new ZipWriter().add(name, enc("x"))).toThrow(ZipError);
		}
		expect(safeEntryName("A folder/a b.notebook")).toBe("A folder/a b.notebook");
		const zip = new ZipWriter();
		zip.add("a.notebook", enc("x"));
		expect(() => zip.add("a.notebook", enc("y"))).toThrow(ZipError);
	});

	it("is finished once", () => {
		const zip = new ZipWriter();
		zip.add("a.notebook", enc("x"));
		zip.finish();
		expect(() => zip.finish()).toThrow(ZipError);
		expect(() => zip.add("b.notebook", enc("y"))).toThrow(ZipError);
	});

	it("handles an empty archive", () => {
		const bytes = new ZipWriter().finish();
		expect(bytes.length).toBe(22);
		expect(readZip(bytes).entries).toEqual([]);
	});

	it("stops at the entry limit of a plain zip", () => {
		const zip = new ZipWriter();
		const none = new Uint8Array(0);
		for (let i = 0; i < ZIP_MAX_ENTRIES; i++) zip.add(`f${i}`, none);
		expect(() => zip.add("one-too-many", none)).toThrow(/too many/);
	});

	it("converts DOS dates both ways and clamps the extremes", () => {
		const t = new Date(2026, 0, 31, 23, 59, 58).getTime();
		const { date, time } = dosDateTime(t);
		expect(fromDosDateTime(date, time)).toBe(t);
		expect(fromDosDateTime(dosDateTime(0).date, dosDateTime(0).time)).toBe(new Date(1980, 0, 1, 0, 0, 0).getTime());
		expect(Number.isNaN(fromDosDateTime(0, 0))).toBe(true);
		expect(dosDateTime(Number.NaN).date).toBe(dosDateTime(0).date);
	});
});
