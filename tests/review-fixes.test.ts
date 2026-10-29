import { describe, expect, it, vi } from "vitest";
import { createDocument } from "../src/model/document";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import { checkRestoreTarget } from "../src/storage/history";

vi.mock("obsidian", () => {
	class TFile {
		path = "";
		extension = "";
	}
	return {
		TFile,
		Platform: { isMobile: false },
		loadPdfJs: async () => ({}),
		normalizePath: (p: string) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	};
});

const { storeAsset } = await import("../src/view/media");
const { TFile } = await import("obsidian");
const { sha256Hex, assetIdFromHash } = await import("../src/pdf/hash");

/** A tiny in-memory vault: just what storeAsset touches. */
function fakeVault(initial: Record<string, Uint8Array> = {}) {
	const files = new Map<string, Uint8Array>(Object.entries(initial));
	const objects = new Map<string, InstanceType<typeof TFile>>();
	const fileFor = (path: string) => {
		let f = objects.get(path);
		if (!f) {
			f = new TFile();
			f.path = path;
			objects.set(path, f);
		}
		return f;
	};
	const log: string[] = [];
	const app = {
		vault: {
			getFileByPath: (p: string) => (files.has(p) ? fileFor(p) : null),
			getAbstractFileByPath: (p: string) => (files.has(p) ? fileFor(p) : null),
			getFolderByPath: () => ({}),
			createFolder: async () => undefined,
			createBinary: async (p: string, data: ArrayBuffer) => {
				log.push(`create ${p}`);
				files.set(p, new Uint8Array(data.slice(0)));
			},
			modifyBinary: async (f: { path: string }, data: ArrayBuffer) => {
				log.push(`modify ${f.path}`);
				files.set(f.path, new Uint8Array(data.slice(0)));
			},
			readBinary: async (f: { path: string }) => {
				const b = files.get(f.path)!;
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
		},
	};
	return { app: app as never, files, log };
}

const bytesOf = (...n: number[]) => new Uint8Array(n).buffer;

describe("storeAsset", () => {
	it("creates the asset, and reuses an identical file without writing", async () => {
		const { app, log } = fakeVault();
		const data = bytesOf(1, 2, 3, 4, 5);
		const a = await storeAsset(app, "Notebooks", data, "scan.jpg", "image");
		expect(log).toEqual([`create ${a.path}`]);
		await storeAsset(app, "Notebooks", data, "scan.jpg", "image");
		expect(log).toEqual([`create ${a.path}`]);
	});

	it("rewrites an existing file that does not hold the bytes (truncated or edited)", async () => {
		const data = bytesOf(1, 2, 3, 4, 5);
		const id = assetIdFromHash(await sha256Hex(data));
		const path = `Notebooks/_assets/${id}.jpg`;
		const { app, files, log } = fakeVault({ [path]: new Uint8Array([1, 2]) }); // truncated by a failed sync
		const a = await storeAsset(app, "Notebooks", data, "scan.jpg", "image");
		expect(a.path).toBe(path);
		expect(log).toEqual([`modify ${path}`]);
		expect([...files.get(path)!]).toEqual([1, 2, 3, 4, 5]);
	});

	it("rewrites a file of the right size but a different hash", async () => {
		const data = bytesOf(1, 2, 3, 4, 5);
		const id = assetIdFromHash(await sha256Hex(data));
		const path = `Notebooks/_assets/${id}.jpg`;
		const { app, files, log } = fakeVault({ [path]: new Uint8Array([9, 9, 9, 9, 9]) });
		await storeAsset(app, "Notebooks", data, "scan.jpg", "image");
		expect(log).toEqual([`modify ${path}`]);
		expect([...files.get(path)!]).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("duplicate page ids", () => {
	function twoPages() {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		doc.pages.push({ ...doc.pages[0]!, id: "second-page", strokes: [] });
		return doc;
	}

	it("parse rejects a file with two pages of the same id", () => {
		const doc = twoPages();
		doc.pages[1]!.id = doc.pages[0]!.id;
		const r = parse(serialize(doc));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/duplicate id/);
	});

	it("serializeChecked refuses to write such a document", () => {
		const doc = twoPages();
		doc.pages[1]!.id = doc.pages[0]!.id;
		const r = serializeChecked(doc);
		expect(r.ok).toBe(false);
		// ... also on the incremental path used for big documents
		expect(serializeChecked(doc, false).ok).toBe(false);
	});

	it("distinct page ids are fine", () => {
		expect(serializeChecked(twoPages()).ok).toBe(true);
	});
});

describe("history restore target", () => {
	const a = serialize(createDocument(new Date("2026-10-29T10:00:00.000Z")));
	const b = serialize(createDocument(new Date("2026-10-29T10:00:00.000Z")));

	it("accepts the same notebook, refuses another one", () => {
		expect(checkRestoreTarget(a, a)).toBe("ok");
		expect(checkRestoreTarget(b, a)).toBe("other-notebook");
	});

	it("asks for confirmation when the file cannot be identified", () => {
		expect(checkRestoreTarget("", a)).toBe("unreadable");
		expect(checkRestoreTarget("\u0000garbage", a)).toBe("unreadable");
	});

	it("still identifies a damaged file by its header id", () => {
		expect(checkRestoreTarget(a.slice(0, 200), a)).toBe("ok");
		expect(checkRestoreTarget(b.slice(0, 200), a)).toBe("other-notebook");
	});
});
