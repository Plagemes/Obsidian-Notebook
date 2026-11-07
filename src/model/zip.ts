/**
 * A small ZIP writer and reader (0.21, roadmap #127: scheduled backups). Pure bytes: no DOM, no 'obsidian', no Node.
 *
 * Own code, written from the public PKWARE APPNOTE 6.3.x layout (local file header, central directory, end-of-central-directory
 * record); nothing is copied from another project, so there is no third-party licence to record. The CRC-32 is the one
 * `png-text.ts` already has (the same polynomial).
 *
 * What it does, on purpose and nothing more:
 *  - **STORE only** (no compression). A notebook is JSON text and its assets are PDFs and pictures that are already compressed;
 *    a backup must be cheap on a tablet and must open in any unzip tool.
 *  - UTF-8 names (general-purpose flag bit 11), DOS date and time (2-second resolution, local time, never before 1980).
 *  - No ZIP64: at most 65 534 entries and 4 GiB minus one byte in total. Past that `add` / `finish` throw, so a backup is never
 *    written that some tools would read wrongly.
 *  - Entry names are vault paths: relative, `/` separators, no `..`, no empty parts, no backslash. Anything else is refused by
 *    `safeEntryName` (the caller then skips and reports the file).
 *
 * The reader is strict, because it is also what checks a backup before it is kept: every offset and size must lie inside the
 * archive, the local header must agree with the central directory, and `verifyZipEntry` recomputes the CRC.
 */
import { crc32 } from "./png-text";

export { crc32 };

/** Most entries a plain (non-ZIP64) archive can hold: 0xFFFF is the "look in ZIP64" marker. */
export const ZIP_MAX_ENTRIES = 0xfffe;
/** Largest size or offset a plain archive can hold. */
export const ZIP_MAX_BYTES = 0xfffffffe;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const END_FIXED = 22;
/** Bit 11 of the general-purpose flags: names (and comments) are UTF-8. */
const UTF8_FLAG = 0x0800;

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** `path` as a zip entry name, or null when it is not a plain relative vault path (see the header). */
export function safeEntryName(path: string): string | null {
	if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0")) return null;
	for (const part of path.split("/")) if (part === "" || part === "." || part === "..") return null;
	return encoder.encode(path).length > 0xffff ? null : path;
}

/** DOS date and time of `ms` (local time). Dates before 1980 become 1980-01-01 00:00:00, after 2107 the last representable day. */
export function dosDateTime(ms: number): { date: number; time: number } {
	const d = new Date(Number.isFinite(ms) ? ms : 0);
	let year = d.getFullYear();
	if (Number.isNaN(year) || year < 1980) return { date: (1 << 5) | 1, time: 0 };
	if (year > 2107) year = 2107;
	const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	return { date, time };
}

/** The local time a DOS date and time stand for, epoch ms (NaN when they are not a real date). */
export function fromDosDateTime(date: number, time: number): number {
	const year = 1980 + ((date >> 9) & 0x7f);
	const month = (date >> 5) & 0x0f;
	const day = date & 0x1f;
	const hour = (time >> 11) & 0x1f;
	const minute = (time >> 5) & 0x3f;
	const second = (time & 0x1f) * 2;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
	const d = new Date(year, month - 1, day, hour, minute, second);
	return d.getMonth() === month - 1 ? d.getTime() : NaN;
}

interface Central {
	nameBytes: Uint8Array;
	crc: number;
	size: number;
	offset: number;
	date: number;
	time: number;
}

/**
 * Builds an archive in memory. The data passed to `add` is kept by reference until `finish` (it is not copied), so do not
 * change it meanwhile.
 */
export class ZipWriter {
	private readonly parts: Uint8Array[] = [];
	private readonly central: Central[] = [];
	private readonly names = new Set<string>();
	private bytes = 0;
	private done = false;

	/** Bytes written so far (the archive will be this plus the central directory). */
	get size(): number {
		return this.bytes;
	}

	get count(): number {
		return this.central.length;
	}

	/** Adds a file. Throws a ZipError for an unusable name, a repeated name, or when the archive would not fit a plain zip. */
	add(name: string, data: Uint8Array, mtime = 0): void {
		if (this.done) throw new ZipError("the archive is already finished");
		if (safeEntryName(name) === null) throw new ZipError(`unusable entry name "${name}"`);
		if (this.names.has(name)) throw new ZipError(`repeated entry name "${name}"`);
		if (this.central.length >= ZIP_MAX_ENTRIES) throw new ZipError("too many files for one zip");
		const nameBytes = encoder.encode(name);
		const total = LOCAL_FIXED + nameBytes.length + data.length;
		if (data.length > ZIP_MAX_BYTES || this.bytes + total > ZIP_MAX_BYTES) throw new ZipError("too much data for one zip");
		const { date, time } = dosDateTime(mtime);
		const crc = crc32(data);
		const header = new Uint8Array(LOCAL_FIXED + nameBytes.length);
		const v = new DataView(header.buffer);
		v.setUint32(0, LOCAL_SIG, true);
		v.setUint16(4, 20, true); // version needed
		v.setUint16(6, UTF8_FLAG, true);
		v.setUint16(8, 0, true); // STORE
		v.setUint16(10, time, true);
		v.setUint16(12, date, true);
		v.setUint32(14, crc, true);
		v.setUint32(18, data.length, true); // compressed size
		v.setUint32(22, data.length, true); // uncompressed size
		v.setUint16(26, nameBytes.length, true);
		v.setUint16(28, 0, true); // no extra field
		header.set(nameBytes, LOCAL_FIXED);
		this.central.push({ nameBytes, crc, size: data.length, offset: this.bytes, date, time });
		this.names.add(name);
		this.parts.push(header, data);
		this.bytes += total;
	}

	/** The finished archive as one array. The writer cannot be used afterwards. */
	finish(comment = ""): Uint8Array {
		if (this.done) throw new ZipError("the archive is already finished");
		const commentBytes = encoder.encode(comment);
		if (commentBytes.length > 0xffff) throw new ZipError("the zip comment is too long");
		let cdSize = 0;
		for (const c of this.central) cdSize += CENTRAL_FIXED + c.nameBytes.length;
		const total = this.bytes + cdSize + END_FIXED + commentBytes.length;
		if (total > ZIP_MAX_BYTES) throw new ZipError("too much data for one zip");
		const out = new Uint8Array(total);
		let at = 0;
		// Free the parts as they are copied, so the peak is the data plus the archive and not more.
		for (let i = 0; i < this.parts.length; i++) {
			const part = this.parts[i]!;
			out.set(part, at);
			at += part.length;
			this.parts[i] = EMPTY;
		}
		this.parts.length = 0;
		const cdOffset = at;
		const v = new DataView(out.buffer);
		for (const c of this.central) {
			v.setUint32(at, CENTRAL_SIG, true);
			v.setUint16(at + 4, 20, true); // version made by (MS-DOS / FAT, 2.0)
			v.setUint16(at + 6, 20, true);
			v.setUint16(at + 8, UTF8_FLAG, true);
			v.setUint16(at + 10, 0, true);
			v.setUint16(at + 12, c.time, true);
			v.setUint16(at + 14, c.date, true);
			v.setUint32(at + 16, c.crc, true);
			v.setUint32(at + 20, c.size, true);
			v.setUint32(at + 24, c.size, true);
			v.setUint16(at + 28, c.nameBytes.length, true);
			// extra, comment, disk number, internal and external attributes: zero
			v.setUint32(at + 42, c.offset, true);
			out.set(c.nameBytes, at + CENTRAL_FIXED);
			at += CENTRAL_FIXED + c.nameBytes.length;
		}
		v.setUint32(at, END_SIG, true);
		v.setUint16(at + 8, this.central.length, true);
		v.setUint16(at + 10, this.central.length, true);
		v.setUint32(at + 12, cdSize, true);
		v.setUint32(at + 16, cdOffset, true);
		v.setUint16(at + 20, commentBytes.length, true);
		out.set(commentBytes, at + END_FIXED);
		this.done = true;
		this.central.length = 0;
		this.names.clear();
		return out;
	}
}

// ------------------------------------------------------------------------------------------------------------ reader

export interface ZipEntry {
	name: string;
	/** Stored size (the same as the real size: only STORE is read). */
	size: number;
	/** CRC-32 recorded in the central directory. */
	crc: number;
	/** Where the file's bytes start in the archive. */
	dataOffset: number;
	/** Modification time, epoch ms (local time), NaN when the recorded date is not real. */
	mtime: number;
}

export interface ZipListing {
	entries: ZipEntry[];
	comment: string;
}

/** Index of the end-of-central-directory record, searching back from the end (the comment is at most 64 KiB). */
function findEnd(b: Uint8Array): number {
	if (b.length < END_FIXED) throw new ZipError("not a zip: too short");
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const lowest = Math.max(0, b.length - END_FIXED - 0xffff);
	for (let i = b.length - END_FIXED; i >= lowest; i--) {
		if (v.getUint32(i, true) === END_SIG && i + END_FIXED + v.getUint16(i + 20, true) === b.length) return i;
	}
	throw new ZipError("not a zip: no end record");
}

/**
 * The files of an archive made by `ZipWriter` (or any plain STORE zip). Throws a ZipError when the structure is wrong: an offset
 * or size outside the archive, a local header that does not match the directory, a method other than STORE, an encrypted entry,
 * a repeated name, an entry count that does not match. The CRC is NOT checked here (see `verifyZipEntry`).
 */
export function readZip(b: Uint8Array): ZipListing {
	const end = findEnd(b);
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const disk = v.getUint16(end + 4, true);
	const cdDisk = v.getUint16(end + 6, true);
	const onDisk = v.getUint16(end + 8, true);
	const count = v.getUint16(end + 10, true);
	const cdSize = v.getUint32(end + 12, true);
	const cdOffset = v.getUint32(end + 16, true);
	if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw new ZipError("multi-disk zips are not supported");
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
	if (cdOffset + cdSize > end) throw new ZipError("the central directory is outside the archive");
	const entries: ZipEntry[] = [];
	const seen = new Set<string>();
	let at = cdOffset;
	for (let i = 0; i < count; i++) {
		if (at + CENTRAL_FIXED > cdOffset + cdSize || v.getUint32(at, true) !== CENTRAL_SIG) throw new ZipError(`bad directory entry ${i}`);
		const flags = v.getUint16(at + 8, true);
		const method = v.getUint16(at + 10, true);
		const time = v.getUint16(at + 12, true);
		const date = v.getUint16(at + 14, true);
		const crc = v.getUint32(at + 16, true);
		const csize = v.getUint32(at + 20, true);
		const usize = v.getUint32(at + 24, true);
		const nameLen = v.getUint16(at + 28, true);
		const extraLen = v.getUint16(at + 30, true);
		const commentLen = v.getUint16(at + 32, true);
		const local = v.getUint32(at + 42, true);
		const next = at + CENTRAL_FIXED + nameLen + extraLen + commentLen;
		if (next > cdOffset + cdSize) throw new ZipError(`bad directory entry ${i}`);
		if (flags & 1) throw new ZipError("encrypted entries are not supported");
		if (method !== 0) throw new ZipError("only stored (uncompressed) entries are supported");
		if (csize !== usize) throw new ZipError(`entry ${i}: sizes differ`);
		const nameBytes = b.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLen);
		const name = decoder.decode(nameBytes);
		if (seen.has(name)) throw new ZipError(`repeated name "${name}"`);
		seen.add(name);
		// The local header must say the same, and the data must lie inside the file area (before the directory).
		if (local + LOCAL_FIXED > cdOffset || v.getUint32(local, true) !== LOCAL_SIG) throw new ZipError(`"${name}": bad local header`);
		const lName = v.getUint16(local + 26, true);
		const lExtra = v.getUint16(local + 28, true);
		const dataOffset = local + LOCAL_FIXED + lName + lExtra;
		if (lName !== nameLen || decoder.decode(b.subarray(local + LOCAL_FIXED, local + LOCAL_FIXED + lName)) !== name) throw new ZipError(`"${name}": local header names another file`);
		if (v.getUint32(local + 14, true) !== crc || v.getUint32(local + 22, true) !== usize) throw new ZipError(`"${name}": local header disagrees with the directory`);
		if (dataOffset + csize > cdOffset) throw new ZipError(`"${name}": data outside the archive`);
		entries.push({ name, size: usize, crc, dataOffset, mtime: fromDosDateTime(date, time) });
		at = next;
	}
	if (at !== cdOffset + cdSize) throw new ZipError("the central directory has unexpected extra bytes");
	return { entries, comment: decoder.decode(b.subarray(end + END_FIXED)) };
}

/** The bytes of an entry (a view into the archive, not a copy). */
export function zipEntryData(b: Uint8Array, entry: ZipEntry): Uint8Array {
	return b.subarray(entry.dataOffset, entry.dataOffset + entry.size);
}

/** Whether the entry's bytes match the CRC-32 recorded for them. */
export function verifyZipEntry(b: Uint8Array, entry: ZipEntry): boolean {
	return crc32(zipEntryData(b, entry)) === entry.crc;
}
