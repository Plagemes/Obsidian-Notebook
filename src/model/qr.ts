/**
 * A small QR code encoder (0.18, roadmap #190): byte mode, error correction level M, versions 1 to 10. Written for this
 * plugin from ISO/IEC 18004 (no external code, so there is no licence to record). Pure: no DOM, no `obsidian`.
 *
 * `encodeQr(text)` returns the module matrix (true = dark) with no quiet zone; `qrSvgPath` turns it into one SVG path.
 */

/** Per version (index = version): error-correction codewords per block, then [block count, data codewords per block] groups. Level M. */
const EC_M: ReadonlyArray<{ ec: number; groups: ReadonlyArray<readonly [number, number]> } | null> = [
	null,
	{ ec: 10, groups: [[1, 16]] },
	{ ec: 16, groups: [[1, 28]] },
	{ ec: 26, groups: [[1, 44]] },
	{ ec: 18, groups: [[2, 32]] },
	{ ec: 24, groups: [[2, 43]] },
	{ ec: 16, groups: [[4, 27]] },
	{ ec: 18, groups: [[4, 31]] },
	{ ec: 22, groups: [[2, 38], [2, 39]] },
	{ ec: 22, groups: [[3, 36], [2, 37]] },
	{ ec: 26, groups: [[4, 43], [1, 44]] },
];

export const QR_MAX_VERSION = 10;

/** Centres of the alignment patterns, per version (index = version). */
const ALIGN: ReadonlyArray<readonly number[]> = [
	[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** The mask pattern number `m` (0-7): true when the module at (row, col) is flipped. */
export const QR_MASKS: ReadonlyArray<(r: number, c: number) => boolean> = [
	(r, c) => (r + c) % 2 === 0,
	(r) => r % 2 === 0,
	(_r, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
	(r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
	(r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
	(r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ------------------------------------------------------------------ Reed-Solomon over GF(256), polynomial 0x11d

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** The `degree` error-correction codewords of `data`. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
	// Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first.
	let gen: number[] = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(gen.length + 1).fill(0);
		for (let j = 0; j < gen.length; j++) {
			next[j] = next[j]! ^ gen[j]!;
			next[j + 1] = next[j + 1]! ^ gfMul(gen[j]!, EXP[i]!);
		}
		gen = next;
	}
	const rem = new Array<number>(degree).fill(0);
	for (const byte of data) {
		const factor = byte ^ rem[0]!;
		rem.shift();
		rem.push(0);
		for (let i = 0; i < degree; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
	}
	return rem;
}

// ------------------------------------------------------------------ capacity and codewords

/** Data codewords of a version at level M. */
export function qrDataCodewords(version: number): number {
	return EC_M[version]!.groups.reduce((n, [count, size]) => n + count * size, 0);
}

/** The most bytes a QR code of this version holds in byte mode at level M. */
export function qrCapacity(version: number): number {
	return qrDataCodewords(version) - (version >= 10 ? 3 : 2);
}

/** The smallest version that holds `length` bytes, or null when it does not fit in version 10. */
export function qrVersionFor(length: number): number | null {
	for (let v = 1; v <= QR_MAX_VERSION; v++) if (length <= qrCapacity(v)) return v;
	return null;
}

export function utf8Bytes(text: string): number[] {
	return Array.from(new TextEncoder().encode(text));
}

/** The data codewords (mode, length, bytes, terminator, padding) for `bytes`. */
export function buildDataCodewords(bytes: readonly number[], version: number): number[] {
	const bits: number[] = [];
	const put = (value: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	put(0b0100, 4);
	put(bytes.length, version >= 10 ? 16 : 8);
	for (const b of bytes) put(b, 8);
	const total = qrDataCodewords(version) * 8;
	put(0, Math.min(4, total - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let v = 0;
		for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
		out.push(v);
	}
	for (let pad = 0xec; out.length < qrDataCodewords(version); pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
	return out;
}

/** Block sizes (data codewords) of a version, in order. */
export function qrBlockSizes(version: number): number[] {
	const sizes: number[] = [];
	for (const [count, size] of EC_M[version]!.groups) for (let i = 0; i < count; i++) sizes.push(size);
	return sizes;
}

export function qrEcPerBlock(version: number): number {
	return EC_M[version]!.ec;
}

/** Splits the data into blocks, adds each block's error correction and interleaves everything. */
export function interleave(data: readonly number[], version: number): number[] {
	const ecLen = qrEcPerBlock(version);
	const blocks: number[][] = [];
	let at = 0;
	for (const size of qrBlockSizes(version)) {
		blocks.push(data.slice(at, at + size));
		at += size;
	}
	const ecs = blocks.map((b) => reedSolomon(b, ecLen));
	const out: number[] = [];
	const longest = Math.max(...blocks.map((b) => b.length));
	for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
	for (let i = 0; i < ecLen; i++) for (const ec of ecs) out.push(ec[i]!);
	return out;
}

// ------------------------------------------------------------------ format and version information

/** The 15 format bits (level M = 00, mask number), BCH-protected and XOR-masked. */
export function formatBits(mask: number): number {
	const data = mask; // level M is 00 in the two high bits
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up). */
export function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | (rem & 0xfff);
}

// ------------------------------------------------------------------ the matrix

export interface QrMatrix {
	version: number;
	size: number;
	/** Row-major, true = dark. */
	modules: boolean[][];
	mask: number;
}

export function qrSize(version: number): number {
	return 17 + 4 * version;
}

function isAlignmentOnFinder(centres: readonly number[], r: number, c: number): boolean {
	const last = centres[centres.length - 1];
	return (r === 6 && c === 6) || (r === 6 && c === last) || (c === 6 && r === last);
}

/** Which modules belong to the fixed patterns (finders, timing, alignment, format, version, dark module): data never goes there. */
export function functionMap(version: number): boolean[][] {
	const n = qrSize(version);
	const f = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
	const rect = (r0: number, c0: number, h: number, w: number) => {
		for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && r < n && c >= 0 && c < n) f[r]![c] = true;
	};
	rect(0, 0, 9, 9);
	rect(0, n - 8, 9, 8);
	rect(n - 8, 0, 8, 9);
	rect(6, 0, 1, n);
	rect(0, 6, n, 1);
	const centres = ALIGN[version]!;
	for (const r of centres) for (const c of centres) if (!isAlignmentOnFinder(centres, r, c)) rect(r - 2, c - 2, 5, 5);
	if (version >= 7) {
		rect(0, n - 11, 6, 3);
		rect(n - 11, 0, 3, 6);
	}
	return f;
}

function drawFunctionPatterns(m: boolean[][], version: number, mask: number): void {
	const n = qrSize(version);
	const set = (r: number, c: number, dark: boolean) => {
		if (r >= 0 && r < n && c >= 0 && c < n) m[r]![c] = dark;
	};
	for (let i = 8; i < n - 8; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
				const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
				set(r0 + dr, c0 + dc, inside && ring !== 2);
			}
		}
	}
	const centres = ALIGN[version]!;
	for (const r of centres) {
		for (const c of centres) {
			if (isAlignmentOnFinder(centres, r, c)) continue;
			for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
		}
	}
	// Format information (both copies) and the dark module.
	const fmt = formatBits(mask);
	const bit = (i: number) => ((fmt >>> i) & 1) === 1;
	for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
	set(7, 8, bit(6));
	set(8, 8, bit(7));
	set(8, 7, bit(8));
	for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
	for (let i = 0; i < 8; i++) set(8, n - 1 - i, bit(i));
	for (let i = 8; i < 15; i++) set(n - 15 + i, 8, bit(i));
	set(n - 8, 8, true);
	// Version information (both copies).
	if (version >= 7) {
		const vb = versionBits(version);
		for (let i = 0; i < 18; i++) {
			const dark = ((vb >>> i) & 1) === 1;
			const a = Math.floor(i / 3);
			const b = (i % 3) + n - 11;
			set(a, b, dark);
			set(b, a, dark);
		}
	}
}

/** The module positions that carry data, in the order the codewords fill them (zigzag, right to left, skipping the timing column). */
export function dataPositions(version: number): Array<[number, number]> {
	const n = qrSize(version);
	const f = functionMap(version);
	const out: Array<[number, number]> = [];
	let up = true;
	for (let right = n - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let k = 0; k < n; k++) {
			const r = up ? n - 1 - k : k;
			for (const c of [right, right - 1]) if (!f[r]![c]) out.push([r, c]);
		}
		up = !up;
	}
	return out;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

function penalty(m: boolean[][]): number {
	const n = m.length;
	let score = 0;
	// Rule 1: runs of five or more in a row or column.
	const runs = (get: (i: number, j: number) => boolean) => {
		for (let i = 0; i < n; i++) {
			let run = 1;
			for (let j = 1; j < n; j++) {
				if (get(i, j) === get(i, j - 1)) run++;
				else {
					if (run >= 5) score += run - 2;
					run = 1;
				}
			}
			if (run >= 5) score += run - 2;
		}
	};
	runs((i, j) => m[i]![j]!);
	runs((i, j) => m[j]![i]!);
	// Rule 2: 2x2 blocks of one colour.
	for (let r = 0; r < n - 1; r++) {
		for (let c = 0; c < n - 1; c++) if (m[r]![c] === m[r]![c + 1] && m[r]![c] === m[r + 1]![c] && m[r]![c] === m[r + 1]![c + 1]) score += 3;
	}
	// Rule 3: the pattern 1011101 with four light modules before or after it.
	const finderLike = (get: (k: number) => boolean): number => {
		let hits = 0;
		for (let k = 0; k + 7 <= n; k++) {
			if (!FINDER_LIKE.every((p, i) => get(k + i) === p)) continue;
			const before = k - 4 >= 0 && [1, 2, 3, 4].every((d) => !get(k - d));
			const after = k + 11 <= n && [0, 1, 2, 3].every((d) => !get(k + 7 + d));
			if (before || after) hits++;
		}
		return hits;
	};
	for (let i = 0; i < n; i++) {
		score += 40 * finderLike((k) => m[i]![k]!);
		score += 40 * finderLike((k) => m[k]![i]!);
	}
	// Rule 4: balance of dark and light.
	let dark = 0;
	for (const row of m) for (const v of row) if (v) dark++;
	score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
	return score;
}

/** Encodes `text` (UTF-8, byte mode, level M) into the smallest version that holds it; null when it does not fit in version 10. */
export function encodeQr(text: string): QrMatrix | null {
	const bytes = utf8Bytes(text);
	const version = qrVersionFor(bytes.length);
	if (version === null) return null;
	const codewords = interleave(buildDataCodewords(bytes, version), version);
	const n = qrSize(version);
	const positions = dataPositions(version);
	const base = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
	positions.forEach(([r, c], i) => {
		// Remainder bits (past the last codeword) stay light.
		base[r]![c] = i < codewords.length * 8 && ((codewords[i >> 3]! >>> (7 - (i & 7))) & 1) === 1;
	});
	let best: QrMatrix | null = null;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		const m = base.map((row) => row.slice());
		for (const [r, c] of positions) if (QR_MASKS[mask]!(r, c)) m[r]![c] = !m[r]![c];
		drawFunctionPatterns(m, version, mask);
		const score = penalty(m);
		if (score < bestScore) {
			bestScore = score;
			best = { version, size: n, modules: m, mask };
		}
	}
	return best;
}

/** One SVG path (a rectangle per run of dark modules in a row) for the matrix offset by `quiet` modules. */
export function qrSvgPath(matrix: QrMatrix, quiet = 4): string {
	const parts: string[] = [];
	for (let r = 0; r < matrix.size; r++) {
		let c = 0;
		while (c < matrix.size) {
			if (!matrix.modules[r]![c]) {
				c++;
				continue;
			}
			let end = c;
			while (end < matrix.size && matrix.modules[r]![end]) end++;
			parts.push(`M${c + quiet} ${r + quiet}h${end - c}v1h${c - end}z`);
			c = end;
		}
	}
	return parts.join("");
}
