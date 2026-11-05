/**
 * Text chunks in a PNG (`tEXt`), pure bytes: no DOM, no 'obsidian'. The companion headings (src/integration/companion-headings.ts)
 * mark every picture they make with the ink it shows, so a later run can tell its own picture (rewrite it when the ink changed,
 * leave it when it did not) from a file the user made or edited (never touched), on any device, whatever PNG encoder drew it.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let table: Uint32Array | null = null;

/** CRC-32 (the one PNG uses) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
	if (!table) {
		table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function isPng(png: Uint8Array): boolean {
	return png.length >= 33 && SIGNATURE.every((b, i) => png[i] === b);
}

function u32(png: Uint8Array, at: number): number {
	return ((png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!) >>> 0;
}

/** `png` with a `tEXt` chunk `keyword`=`text` right after the header (Latin-1 only; other characters become `?`). Not a PNG: returned unchanged. */
export function addPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
	if (!isPng(png)) return png;
	const latin = (s: string) => Array.from(s, (c) => (c.charCodeAt(0) < 256 && c.charCodeAt(0) > 0 ? c.charCodeAt(0) : 0x3f));
	const body = [...latin(keyword), 0, ...latin(text)];
	const chunk = new Uint8Array(12 + body.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, body.length);
	chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
	chunk.set(body, 8);
	view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
	const headerEnd = 8 + 12 + u32(png, 8); // signature + the first chunk (IHDR)
	const out = new Uint8Array(png.length + chunk.length);
	out.set(png.subarray(0, headerEnd), 0);
	out.set(chunk, headerEnd);
	out.set(png.subarray(headerEnd), headerEnd + chunk.length);
	return out;
}

/** The text of the first `tEXt` chunk called `keyword`, or null (not a PNG, no such chunk, a damaged file). Stops at the image data. */
export function readPngText(png: Uint8Array, keyword: string): string | null {
	if (!isPng(png)) return null;
	let at = 8;
	while (at + 12 <= png.length) {
		const length = u32(png, at);
		const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
		if (type === "IDAT" || type === "IEND") return null;
		const start = at + 8;
		const end = start + length;
		if (end + 4 > png.length) return null;
		if (type === "tEXt") {
			const zero = png.indexOf(0, start);
			if (zero > start && zero < end) {
				const key = String.fromCharCode(...png.subarray(start, zero));
				if (key === keyword) return String.fromCharCode(...png.subarray(zero + 1, end));
			}
		}
		at = end + 4;
	}
	return null;
}
