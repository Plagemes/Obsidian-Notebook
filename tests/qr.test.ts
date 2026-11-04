import { describe, expect, it } from "vitest";
import {
	QR_MASKS, buildDataCodewords, dataPositions, encodeQr, formatBits, functionMap, qrBlockSizes, qrCapacity, qrDataCodewords, qrEcPerBlock, qrSize, qrSvgPath, qrVersionFor,
	reedSolomon, utf8Bytes, versionBits,
} from "../src/model/qr";

/** A decoder written apart from the encoder's drawing: reads the format bits, unmasks, reads the codewords, checks the error correction and returns the text. */
function decode(modules: boolean[][], version: number): string {
	const n = qrSize(version);
	// Format information, first copy.
	let fmt = 0;
	const at = (r: number, c: number) => (modules[r]![c] ? 1 : 0);
	const coords: Array<[number, number]> = [];
	for (let i = 0; i <= 5; i++) coords.push([i, 8]);
	coords.push([7, 8], [8, 8], [8, 7]);
	for (let i = 9; i < 15; i++) coords.push([8, 14 - i]);
	coords.forEach(([r, c], i) => {
		fmt |= at(r, c) << i;
	});
	const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits(m) === fmt);
	expect(mask).toBeDefined();
	// Second copy agrees.
	let fmt2 = 0;
	for (let i = 0; i < 8; i++) fmt2 |= at(8, n - 1 - i) << i;
	for (let i = 8; i < 15; i++) fmt2 |= at(n - 15 + i, 8) << i;
	expect(fmt2).toBe(fmt);
	const bits = dataPositions(version).map(([r, c]) => (modules[r]![c]! !== QR_MASKS[mask!]!(r, c) ? 1 : 0));
	const total = Math.floor(bits.length / 8);
	const words: number[] = [];
	for (let i = 0; i < total; i++) {
		let v = 0;
		for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!;
		words.push(v);
	}
	// De-interleave.
	const sizes = qrBlockSizes(version);
	const ecLen = qrEcPerBlock(version);
	const blocks = sizes.map(() => [] as number[]);
	let p = 0;
	for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((s, b) => { if (i < s) blocks[b]!.push(words[p++]!); });
	const ecs = sizes.map(() => [] as number[]);
	for (let i = 0; i < ecLen; i++) ecs.forEach((e) => e.push(words[p++]!));
	blocks.forEach((b, i) => expect(reedSolomon(b, ecLen)).toEqual(ecs[i]));
	const data = blocks.flat();
	let bitPos = 0;
	const read = (count: number) => {
		let v = 0;
		for (let i = 0; i < count; i++) {
			v = (v << 1) | ((data[bitPos >> 3]! >>> (7 - (bitPos & 7))) & 1);
			bitPos++;
		}
		return v;
	};
	expect(read(4)).toBe(0b0100);
	const len = read(version >= 10 ? 16 : 8);
	const out: number[] = [];
	for (let i = 0; i < len; i++) out.push(read(8));
	return new TextDecoder().decode(new Uint8Array(out));
}

describe("QR encoder", () => {
	it("computes the Reed-Solomon codewords of the classic 1-M example", () => {
		const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
		expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
	});

	it("has the published format and version information bits", () => {
		expect(formatBits(0)).toBe(0b101010000010010);
		expect(formatBits(1)).toBe(0b101000100100101);
		expect(formatBits(5)).toBe(0b100000011001110);
		expect(formatBits(7)).toBe(0b100101010100000);
		expect(versionBits(7)).toBe(0x07c94);
		expect(versionBits(8)).toBe(0x085bc);
		expect(versionBits(10)).toBe(0x0a4d3);
	});

	it("lays out the function patterns and data positions with the right counts", () => {
		// Total modules minus function modules = codeword bits + remainder bits (0 for v1, 7 for v2-6... 0 for v7-13).
		for (let v = 1; v <= 10; v++) {
			const codewords = qrDataCodewords(v) + qrBlockSizes(v).length * qrEcPerBlock(v);
			const remainder = v === 1 ? 0 : v <= 6 ? 7 : 0;
			expect(dataPositions(v).length).toBe(codewords * 8 + remainder);
		}
		expect(functionMap(1)[6]![10]).toBe(true);
	});

	it("pads and terminates the data like the standard", () => {
		const words = buildDataCodewords(utf8Bytes("A"), 1);
		expect(words.length).toBe(16);
		expect(words.slice(0, 3)).toEqual([0x40, 0x14, 0x10]);
		expect(words.slice(3, 6)).toEqual([0xec, 0x11, 0xec]);
	});

	it("picks the smallest version and refuses what does not fit", () => {
		expect(qrCapacity(1)).toBe(14);
		expect(qrCapacity(2)).toBe(26);
		expect(qrCapacity(10)).toBe(213);
		expect(qrVersionFor(14)).toBe(1);
		expect(qrVersionFor(15)).toBe(2);
		expect(qrVersionFor(213)).toBe(10);
		expect(qrVersionFor(214)).toBeNull();
		expect(encodeQr("x".repeat(300))).toBeNull();
	});

	it("round-trips text through its own matrix at every version, in UTF-8", () => {
		for (let v = 1; v <= 10; v++) {
			let text = ("obsidian://notebook?path=Notes/é-ü ✓&page=3 ").repeat(10).slice(0, qrCapacity(v) - 1);
			while (utf8Bytes(text).length > qrCapacity(v)) text = text.slice(0, -1);
			const m = encodeQr(text)!;
			expect(m.size).toBe(qrSize(m.version));
			expect(m.version).toBeLessThanOrEqual(v);
			expect(decode(m.modules, m.version)).toBe(text);
		}
	});

	it("is deterministic, has the finder and timing patterns and the dark module", () => {
		const a = encodeQr("obsidian://notebook?path=a.notebook&page=1")!;
		const b = encodeQr("obsidian://notebook?path=a.notebook&page=1")!;
		expect(a.modules).toEqual(b.modules);
		const n = a.size;
		expect(a.modules[0]!.slice(0, 7)).toEqual(new Array(7).fill(true));
		expect(a.modules[3]![3]).toBe(true);
		expect(a.modules[1]![1]).toBe(false);
		expect(a.modules[0]![n - 7]).toBe(true);
		expect(a.modules[n - 1]![0]).toBe(true);
		expect(a.modules[n - 8]![8]).toBe(true);
		for (let i = 8; i < n - 8; i++) expect(a.modules[6]![i]).toBe(i % 2 === 0);
	});

	it("draws the version information for version 7 and up", () => {
		const m = encodeQr("y".repeat(120))!;
		expect(m.version).toBeGreaterThanOrEqual(7);
		let bits = 0;
		for (let i = 0; i < 18; i++) bits |= (m.modules[Math.floor(i / 3)]![(i % 3) + m.size - 11] ? 1 : 0) << i;
		expect(bits).toBe(versionBits(m.version));
	});

	it("makes an SVG path with one rectangle per run of dark modules", () => {
		const m = encodeQr("hi")!;
		const path = qrSvgPath(m, 4);
		expect(path.startsWith("M4 4h7")).toBe(true);
		let dark = 0;
		for (const row of m.modules) for (const v of row) if (v) dark++;
		const area = [...path.matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0);
		expect(area).toBe(dark);
	});
});
